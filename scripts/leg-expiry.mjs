#!/usr/bin/env node
// scripts/leg-expiry.mjs —— 腿的生命周期探针（#1460 T24）。
//
//   node scripts/leg-expiry.mjs                # 探「在役腿 + 池已声明过期但腿没探过的」
//   node scripts/leg-expiry.mjs --only <腿id>  # 只探一条
//   node scripts/leg-expiry.mjs --dry-run      # 只列要探什么，不起会话
//
// 用户 2026-09-19 拍板的结构（两维度 × 两态）：
//   · **模型维度**（每条腿）：这里真起一个最小会话问一句「只回一行 OK」——
//     答上来 = 这条模型今天还在；答不上 = 记下失败，并把 `observedUntil` **冻结在上一次成功**的时刻
//     （「它还能用到什么时候」的答案就是那一刻，不是发现失败的那一刻）。
//   · **订阅/账户维度**（池）：**从它的腿推导**（池可用 ⇔ 至少一条腿答得上）。
//     不另造一种「订阅探针」——凭据/计费探法各家不同，硬猜只会造出假绿；推导是可解释的。
//
// 落点（本仓老规矩：派生数据不进 git）：
//   声明在 docs/execution-profiles.json（池与腿的 lifecycle）；观测落 ~/.dao/leg-expiry.json（可丢可重算）。
//
// 三态：ok（答上来了）/ failed（答不上）/ unscanned（探针本身没跑成：起不了会话、读不到目录）。
// **没探过 ≠ 可用**：没有观测数据时只有声明算数，声明也没有就不淘汰但标 unverified（不猜）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.DAO_LEG_EXPIRY_HOME || homedir();
const STATE_FILE = join(HOME, '.dao', 'leg-expiry.json');
const DRY = process.argv.includes('--dry-run');
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

const PROMPT = '只回一行：OK。不要解释，不要用工具，不要读文件。';

function readCatalog() {
  const doc = JSON.parse(readFileSync(join(ROOT, 'docs', 'execution-profiles.json'), 'utf8'));
  return { doc, profiles: doc.profiles || [], pools: doc.accountPools || [] };
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { schemaVersion: 1, legs: {} }; }
}

function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

/** 要探哪些腿：在役的 + 池已声明过期但腿还没探过的（有界，不烧 40 条腿的额度）。 */
export function targets(profiles, pools, state) {
  const declaredPools = new Set(pools.filter(p => p.lifecycle?.declaredUntil).map(p => p.id));
  const picked = profiles.filter(p => {
    if (ONLY) return p.id === ONLY;
    if (p.enabled === true) return true;
    return declaredPools.has(p.accountPoolId) && !state.legs?.[p.id]?.probedAt;
  });
  return picked.map(p => ({ id: p.id, pool: p.accountPoolId || null, agent: p.agent, model: p.model }));
}

/** 起一个最小会话问一句；答上来算 ok。任何异常都算 unscanned（探针没跑成，不是「模型不行」）。 */
async function probeLeg(runtime, leg) {
  let key = null;
  try {
    const started = await runtime.startSession({
      profileId: leg.id, agent: leg.agent, model: leg.model, workdir: HOME, prompt: PROMPT,
      taskId: `leg-expiry/${leg.id}`, title: `leg-expiry probe ${leg.id}`,
    });
    key = started?.sessionKey;
    if (!key) return { state: 'unscanned', why: '起会话没拿到 sessionKey' };
    const settled = await runtime.waitForCompletion(key, { timeoutMs: 180000 });
    const view = await runtime.readSession(key);
    if (view?.error) return { state: 'failed', why: String(view.error).slice(0, 160) };
    const text = String(view?.text || '');
    if (/\bOK\b/i.test(text)) return { state: 'ok', why: '答上来了' };
    return { state: 'failed', why: `答上来了但内容不符（${text.trim().slice(0, 60) || '空'}）` };
  } catch (error) {
    const why = String(error?.message || error).slice(0, 160);
    // 起会话/读会话失败：分不清「模型不行」还是「这台机器今天连不上」——算没查成，别写进过期账。
    return { state: 'unscanned', why };
  } finally {
    if (key) await runtime.stopSession(key).catch(() => {});
  }
}

async function main() {
  const { profiles, pools } = readCatalog();
  const state = readState();
  const legs = targets(profiles, pools, state);
  if (!legs.length) {
    process.stdout.write('没有要探的腿（--only 没匹配，或没有在役腿、也没有已声明过期的池）\n');
    return 0;
  }
  if (DRY) {
    process.stdout.write(`要探 ${legs.length} 条腿（dry-run）：\n`);
    for (const l of legs) process.stdout.write(`  · ${l.id}（池 ${l.pool || '-'}）\n`);
    return 0;
  }

  const { createExecutionRuntime } = await import('./lib/execution-runtime.mjs');
  const runtime = createExecutionRuntime();
  const now = new Date().toISOString();
  const results = [];
  for (const leg of legs) {
    const verdict = await probeLeg(runtime, leg);
    const prior = state.legs[leg.id] || {};
    const next = { ...prior, probedAt: now, lastState: verdict.state, lastWhy: verdict.why, probes: (prior.probes || 0) + 1 };
    if (verdict.state === 'ok') {
      // 成功：lastOkAt 刷新，observedUntil 清掉（自愈）
      next.lastOkAt = now;
      next.observedUntil = null;
    } else if (verdict.state === 'failed') {
      // 失败：observedUntil **冻结在上一次成功**——那才是「它还能用到什么时候」
      next.observedUntil = prior.lastOkAt || null;
      next.neverWorked = !prior.lastOkAt;
    }
    state.legs[leg.id] = next;
    results.push({ leg: leg.id, pool: leg.pool, ...verdict, observedUntil: next.observedUntil ?? null });
    process.stdout.write(`${verdict.state === 'ok' ? '✓' : verdict.state === 'failed' ? '✗' : '?'} ${leg.id} — ${verdict.why}${next.observedUntil ? `（最后可用 ${next.observedUntil}）` : ''}\n`);
  }
  writeState(state);

  // 池维度从腿推导：池可用 ⇔ 至少一条腿 ok
  const poolLines = [];
  for (const pool of pools) {
    if (!pool.lifecycle?.declaredUntil) continue;
    const own = Object.entries(state.legs).filter(([id]) => profiles.find(p => p.id === id)?.accountPoolId === pool.id);
    const ok = own.filter(([, v]) => v.lastState === 'ok').length;
    const lastOk = own.map(([, v]) => v.lastOkAt).filter(Boolean).sort().pop() || null;
    poolLines.push(`${ok > 0 ? '✓' : own.length ? '✗' : '?'} 池 ${pool.id}（声明 ${pool.lifecycle.declaredUntil}）：${own.length} 条腿探过，${ok} 条可用${lastOk ? `；最后可用 ${lastOk}` : ''}`);
  }
  if (poolLines.length) process.stdout.write(`\n订阅维度（从腿推导）：\n${poolLines.map(l => `  ${l}`).join('\n')}\n`);
  process.stdout.write(`\n观测落：${STATE_FILE}\n`);
  return results.some(r => r.state === 'failed') ? 1 : 0;
}

process.exit(await main());
