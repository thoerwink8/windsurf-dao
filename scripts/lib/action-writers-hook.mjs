#!/usr/bin/env node
// scripts/lib/action-writers-hook.mjs —— 动作触发写口的 hook 入口（#891 W5）
//
// 改这个文件前必须知道的六条：
//
// 1. **只增不阻，永远 exit 0**。这是 PostToolUse / PreToolUse 上的硬约束：exit 2 会把 stderr
//    当反馈塞回模型、把用户的会话搅乱。写账失败、schema 缺类型、脱敏模块不在——一律优雅降级，
//    绝不阻断（对照：dispatch-gate 那条闸是 fail-closed exit 2，因为它的职责是**拦**；本文件
//    的职责是**记**，记不上不该拦人干活）。
// 2. 挂载落点 = 随仓 `.claude/settings.json` 的 PreToolUse / PostToolUse。
//    **不用 skills/<name>/hooks/hooks.json**：那个落点 2026-09-04 已实证不被 Claude Code 加载
//    （见 host/skills/admit-push/hooks/callout-detect.mjs 头注「加载落点」段——装在那里的闸
//    一直是死的）。随仓 settings.json 是活的（#553 派工闸从 plugin 换过来的同一个面，
//    dao-check ⑬ 每次都在核它）。
//    覆盖面：随仓挂载只在本仓当项目根时触发。要覆盖全机所有项目，需帅位把同一条挂进
//    `~/.claude/settings.json`（command 用本文件绝对路径）——本文件为此**不读
//    CLAUDE_PROJECT_DIR**，仓根一律从自身位置推，从任何 cwd 被调用都能找到 schema。
//    本 PR 不自动改用户配置（照 #565「symlink 归帅建」同一条纪律）。
// 3. **脱敏是写入的前置条件，不是可选项**。取 redact 的顺序：W2 的 `./redact.mjs`（契约
//    `{ redact }`）→ 仓内既有 canonical `./redact.js` 的 `redactText`（真相源，见其头注）
//    → 两个都没有就**拒绝写**。绝不在这里另写一套正则（两份安全过滤器必然漂移）。
// 4. 事件类型闭集的唯一权威是 schema。想写的类型不在闭集里（例如 W1 尚未把
//    decision.pending / decision.resolved / session.milestone 落进 schema）⇒ 跳过并说明，
//    不改 schema、不另抄清单。schema 路径可用 DAO_EVENTS_SCHEMA 覆盖（排障/验收用）。
// 5. 幂等：写前扫账本，同 decision_id（pending）/ 同 target_decision_id+chosen（resolved）/
//    同 milestone_key（里程碑）已在账里就跳过。账本自身还会拒同内容（event-writer 三铁律），
//    那条错误在这里被收成 skipped，不当失败。
// 6. 默认**不产出任何 stdout**（PostToolUse 的 stdout 会进记录，是噪音）。要看它判了什么：
//    ACTION_WRITERS_DEBUG=1 走 stderr，或 --dry-run 只判不写、结果打到 stdout。

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDecisionPending, buildDecisionResolved, buildMilestone,
  isAskTool, parseHookEvent, toolOutputOf,
} from './action-writers.mjs';
import { schemaMeta, writeEvent, nextSeq } from './event-writer.mjs';
import { loadLedgerContext, isDuplicateWriteError, beijingIsoFrom } from './ledger-job.mjs';
import { readLedgerEvents } from './ledger-query.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// 仓根从自身位置推，不读 CLAUDE_PROJECT_DIR（头注第 2 条：全机挂载时 cwd 不是本仓）
export const ROOT = resolve(SCRIPT_DIR, '..', '..');

/** 取脱敏函数（头注第 3 条）。→ { redact, source } 或 { error }。 */
export async function resolveRedact({ dir = SCRIPT_DIR } = {}) {
  try {
    const m = await import(`file://${resolve(dir, 'redact.mjs').replace(/\\/g, '/')}`);
    const fn = m.redact || (m.default && m.default.redact);
    if (typeof fn === 'function') return { redact: fn, source: 'redact.mjs（W2）' };
  } catch { /* W2 尚未合并：落到既有 canonical */ }
  try {
    const m = await import(`file://${resolve(dir, 'redact.js').replace(/\\/g, '/')}`);
    const mod = m.default || m;
    if (mod && typeof mod.redactText === 'function') {
      return { redact: mod.redactText, source: 'redact.js redactText（仓内 canonical）' };
    }
  } catch { /* 两个都没有 */ }
  return { error: '脱敏模块取不到（redact.mjs 与 redact.js 都不可用）——拒绝裸写事件' };
}

/** git 探头：只取分支/短 sha/单行标题；任一步失败整体记 error，不留半真。 */
export function gitProbeAt({ cwd } = {}) {
  const at = cwd ? String(cwd) : null;
  if (!at) return { error: 'hook 入参没给 cwd' };
  const run = args => spawnSync('git', ['-C', at, ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const head = run(['log', '-1', '--pretty=%h%x1f%s']);
  if (head.error || head.status !== 0) {
    return { error: String(head.error?.message || head.stderr || `git exit ${head.status}`).trim().slice(0, 120) };
  }
  const [commit, subject] = String(head.stdout || '').trim().split('\x1f');
  const br = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = !br.error && br.status === 0 ? String(br.stdout || '').trim() : null;
  return { commit: commit || null, subject: subject || null, branch: branch || null };
}

/** 事件已在账里？predicate 只看 payload 字段，不看 ts/seq（同一动作重触发 ts 必不同）。 */
function alreadyLogged(events, type, predicate) {
  return (events || []).some(e => e && e.type === type && predicate(e));
}

function dupPredicate(type, w) {
  if (type === 'decision.pending') return e => e.decision_id === w.payload.decision_id;
  if (type === 'decision.resolved') {
    const chosen = JSON.stringify(w.payload.chosen);
    return e => e.target_decision_id === w.payload.target_decision_id && JSON.stringify(e.chosen) === chosen;
  }
  return e => e.milestone_key === w.payload.milestone_key;
}

/**
 * 判 + 写。纯判官全在 action-writers.mjs，这里只负责取脱敏/取 schema/查重/落盘。
 * → { exit: 0, notes: string[], written: [{ type, path }] }。任何异常都收成 notes。
 */
export async function runHook({ stdinText = '', env = process.env, dryRun = false, root = ROOT } = {}) {
  const notes = [];
  const written = [];
  try {
    const parsed = parseHookEvent(stdinText);
    if (!parsed.ok) return { exit: 0, notes: [parsed.reason], written };
    const event = parsed.event;
    const toolName = String(event.tool_name || event.toolName || '');
    const phase = String(event.hook_event_name || event.hookEventName || '')
      || (toolOutputOf(event) !== undefined ? 'PostToolUse' : 'PreToolUse');

    // 先判「这个动作要不要写」，再去取脱敏/schema —— 绝大多数工具调用在这里就走掉，零开销
    const wants = phase === 'PreToolUse'
      ? (isAskTool(toolName) ? 'pending' : null)
      : (isAskTool(toolName) ? 'resolved' : (toolName === 'Bash' ? 'milestone' : null));
    if (!wants) return { exit: 0, notes: [`${phase} / ${toolName || '(无工具名)'}：不在写口匹配面，跳过`], written };

    const got = await resolveRedact();
    if (got.error) return { exit: 0, notes: [got.error], written };
    notes.push(`脱敏来源：${got.source}`);

    const ts = beijingIsoFrom(new Date());
    let built;
    if (wants === 'pending') built = buildDecisionPending({ event, ts, redact: got.redact });
    else if (wants === 'resolved') built = buildDecisionResolved({ event, ts, redact: got.redact });
    else built = buildMilestone({ event, ts, redact: got.redact, gitProbe: gitProbeAt });
    if (built.reason) notes.push(built.reason);
    if (!built.ok || built.writes.length === 0) return { exit: 0, notes, written };

    const ctx = loadLedgerContext({
      root,
      schemaPath: env && env.DAO_EVENTS_SCHEMA ? env.DAO_EVENTS_SCHEMA : undefined,
      env,
    });
    const closedSet = schemaMeta(ctx.schema).closedSet;
    const ledger = readLedgerEvents(ctx.dir);
    if (ledger.unscanned) notes.push(`账本查重没查成（${ledger.error}）——照写，重复由账本自身拒`);

    for (const w of built.writes) {
      if (!closedSet.includes(w.type)) {
        notes.push(`事件类型 ${w.type} 不在 schema 闭集里（schema 是唯一权威，本 hook 不改它）——跳过`);
        continue;
      }
      if (!ledger.unscanned && alreadyLogged(ledger.events, w.type, dupPredicate(w.type, w))) {
        notes.push(`${w.type} 已在账里（幂等跳过）`);
        continue;
      }
      if (dryRun) {
        notes.push(`[dry-run] 会写 ${w.type}`);
        written.push({ type: w.type, path: null, payload: w.payload });
        continue;
      }
      try {
        const r = writeEvent({
          dir: ctx.dir,
          type: w.type,
          ts,
          machine: ctx.machine,
          seq: nextSeq(ctx.dir, ctx.machine),
          payload: w.payload,
          schema: ctx.schema,
        });
        written.push({ type: w.type, path: r.path, event_id: r.event.event_id });
      } catch (e) {
        if (isDuplicateWriteError(e)) notes.push(`${w.type} 账本判重复（幂等跳过）：${String(e.message || e).slice(0, 120)}`);
        else notes.push(`${w.type} 没写上：${String(e.message || e).slice(0, 200)}`);
      }
    }
    return { exit: 0, notes, written };
  } catch (e) {
    // 头注第 1 条：任何异常都不许阻断会话
    return { exit: 0, notes: [`写口崩了（已降级，不阻断）：${String(e && e.message ? e.message : e).slice(0, 200)}`], written };
  }
}

function readStdinSync() {
  try {
    if (process.stdin.isTTY) return '';
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const invoked = process.argv[1] && /action-writers-hook\.mjs$/.test(String(process.argv[1]).replace(/\\/g, '/'));
if (invoked) {
  const dryRun = process.argv.includes('--dry-run');
  const r = await runHook({ stdinText: readStdinSync(), env: process.env, dryRun });
  const debug = dryRun || process.env.ACTION_WRITERS_DEBUG === '1';
  if (debug) {
    const line = JSON.stringify({ notes: r.notes, written: r.written }, null, 2);
    if (dryRun) process.stdout.write(`${line}\n`);
    else process.stderr.write(`[action-writers] ${line}\n`);
  }
  process.exit(0);
}
