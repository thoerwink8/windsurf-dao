#!/usr/bin/env node
// scripts/cli-versions.mjs —— 读各载体（agent CLI）的真实版本，跟上次记的比，变了就报
//
// 用户 2026-09-13 拍板：「只做版本变了要说，不钉死」。判据正文与来由见
// scripts/lib/cli-version.mjs（含「为什么不钉版本」的调研结论）。
//
// 它**不进任何拦截路径**：读不到版本、版本变了，都不影响派工。产出只有两样：
//   ① ~/.dao/cli-versions.json —— 每个载体现在什么版本、什么时候变的（派生数据，不进 git）
//   ② stdout 一行漂移摘要（没变就什么都不说）
//
// 用法：
//   node scripts/cli-versions.mjs            # 读一轮、落表、变了打印一行
//   node scripts/cli-versions.mjs --json     # 同上，输出 JSON（给 commander 这类消费方）
//   node scripts/cli-versions.mjs --quiet    # 只落表不打印（周期面用）
//
// 退出码恒为 0：这是**眼睛**不是闸。读不成不等于坏了，让退出码非 0 会把它变成拦截点。

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';
import {
  VERSION_PROBES, parseVersionLine, classifyVersionDrift, mergeVersionState, resolveProbeBinary,
  renderDrift, loadVersionState, saveVersionState, statePath, effectivePath,
} from './lib/cli-version.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const quiet = argv.includes('--quiet') || asJson;

/** 读一个载体的版本。超时/起不来都算「没读成」，**不抛**——一个载体读不到不该影响其余的。
 *  超时值按实测定：五个载体里最慢的是 cmdc（3090ms，node 启动 + 加载），给 4 倍余量。
 *
 *  **解析用的 PATH 必须和子进程实际拿到的那条是同一条**（2026-09-13 审官在 PR #1213 上抓的红 3）。
 *  原实现先 `resolveProbeBinary()` 按 `process.env.PATH` 判一次死活，**之后**才往子进程的 env 里
 *  补 `~/.local/bin`。于是 `PATH=/usr/bin:/bin node scripts/cli-versions.mjs` 时 devin 判「本机解析不到」，
 *  而它明明就在随后那条有效 PATH 里——正是本模块自己要修的那类「shell PATH 与部署 PATH 不一致」。
 *  实测形状：
 *      PATH=/usr/bin:/bin node scripts/cli-versions.mjs --json   → devin.version = null（理由「解析不到」）
 *  改法：先把有效 PATH 算出来，解析与 spawn 共用它。 */

function readVersion(bin, { home = os.homedir(), timeoutMs = 15000, pathValue = null } = {}) {
  const probe = VERSION_PROBES[bin];
  if (!probe) return { version: null, error: '没有配读法' };
  const PATH = pathValue || effectivePath({ home });
  // 走 launch-binary 的解析：cursor-agent 不在 PATH，拿裸名 spawn 会 ENOENT。
  // pathValue 必须传——不然它退回 process.env.PATH，又变成「按另一条 PATH 判死活」。
  const target = resolveProbeBinary(bin, { homeDir: home, pathValue: PATH });
  if (!target.command) return { version: null, error: '本机解析不到这个可执行文件' };
  const env = { ...process.env, PATH };
  const r = spawnSync(target.command, probe.args, { encoding: 'utf8', timeout: timeoutMs, env, windowsHide: true });
  if (r.error) return { version: null, error: r.error.code === 'ETIMEDOUT' ? '超时' : (r.error.code || '起不来') };
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const version = parseVersionLine(out);
  if (!version) return { version: null, error: r.status === 0 ? '输出里认不出版本' : `退出码 ${r.status}` };
  return { version };
}

function main() {
  const home = os.homedir();
  const previous = loadVersionState({ home });
  // 有效 PATH 只算一次，解析与 spawn 共用——两处各算一次就是这次红 3 的根因形状。
  const pathValue = effectivePath({ home });
  const current = {};
  for (const bin of Object.keys(VERSION_PROBES)) {
    const got = readVersion(bin, { home, pathValue });
    current[bin] = { ...got, readAt: new Date().toISOString() };
  }
  const drift = classifyVersionDrift({ current, previous: previous.versions });
  const merged = mergeVersionState({ current, previous: previous.versions });
  const path = saveVersionState({ versions: merged, home });
  const summary = renderDrift(drift);

  if (asJson) {
    process.stdout.write(JSON.stringify({
      ok: true, path, statePresent: previous.present, corrupt: !!previous.corrupt,
      current, drift, summary, changed: drift.changed.length > 0,
    }, null, 1) + '\n');
  } else if (!quiet && summary) {
    process.stdout.write(`[载体版本] ${summary}\n`);
  }
  return 0;
}

process.exit(main());
