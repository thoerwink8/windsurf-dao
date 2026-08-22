#!/usr/bin/env node
// scripts/lib/guard-session-hook.mjs —— SessionStart hook：帥位触发守卫（#693）
//
// 改这个文件前必须知道的三条：
//   1. 只报不拦：永远 exit 0。SessionStart hook 崩了/非零，在宿主眼里可能弄坏会话启动。
//   2. 拉起闸是 guardLaunchGate（guard-seat.mjs）：主树在本仓就幂等拉起守卫——分支是不是
//      master 只管「谁是帅位」展示，不管「要不要拉起」（2026-08-22 拍板：主树不在 master
//      全灭过一次，15 小时无人知）。工人树（非主树）静默退出。判不出来不猜、不静默跳过——
//      往上下文注入醒目提示，请帅用 AskUserQuestion 问用户要不要拉起。
//   3. 输出区分「查过」和「没查成」：主树上跑完 --once 必有一行结果（在位/已拉起）；
//      没查成是另一形（≠ 查过没事）。
//
// 拉起动作本身在 scripts/guard-keepalive.mjs --once（幂等：已在不拉，缺了才拉）。

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { judgeSeat, guardLaunchGate } from './guard-seat.mjs';
import { onceResultBits } from './guard-keepalive.mjs';

// 必须小于 .claude/settings.json 里 SessionStart 的 timeout(60s)：宁可 hook 自己先报
// 「没查成」，也不让宿主把超时当放行。
const ONCE_TIMEOUT_MS = 50000;

function tailOf(r) {
  const tail = String(r?.stderr || '').trim() || String(r?.stdout || '').trim();
  return tail ? `（${tail.slice(-160)}）` : '';
}

/** --once stdout 末行 JSON → 一行结果。doc 不成 JSON 返回 null。 */
export function onceLine(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.results)) return null;
  const bits = onceResultBits(doc);
  if (bits.failed.length) {
    return `[卫] 守卫拉起没成：${bits.all.join(' ')}（≠ 查过没事；只报不拦）`;
  }
  if (bits.started.length) {
    return `[卫] 守卫已拉起：${bits.all.join(' ')}`;
  }
  return `[卫] 守卫在位：${bits.all.join(' ') || '无结果行'}`;
}

/**
 * hook 主体（judge / runOnce 可注入，测试不碰真机）。
 * @returns string[] 要写进会话上下文的行；空数组 = 静默（非帥位）。
 */
export function sessionHookLines({ projectDir, judge = judgeSeat, runOnce } = {}) {
  const seat = judge({ projectDir });
  const gate = guardLaunchGate(seat);
  if (gate.unknown) {
    return [
      `[卫] 帥位判定没查成：${gate.error}——不知道本会话是不是主树，没敢动守卫。`
      + '若要拉起 watchdog/flow，请用 AskUserQuestion 问用户，用户点头后跑：node scripts/guard-keepalive.mjs --once',
    ];
  }
  if (!gate.launch) return [];
  const r = runOnce(projectDir);
  if (r.error || (r.status !== 0 && r.status != null)) {
    return [`[卫] 守卫 ensure 没查成：${r.error?.message || `exit ${r.status}`}${tailOf(r)}（≠ 查过没事；只报不拦）`];
  }
  const lines = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  let doc = null;
  try { doc = JSON.parse(lines.pop() || '{}'); } catch { doc = null; }
  const line = onceLine(doc);
  const result = line || `[卫] 守卫 ensure 输出没查成：--once 末行不是结果 JSON${tailOf(r)}（≠ 查过没事）`;
  // 主树非 master：守卫照拉，但把「这不是帅位展示口径的 master」显形，防盘面误读。
  return gate.shuai ? [result] : [`${result}（主树在 ${gate.branch}，非 master——守卫照拉，帅位展示仍认 master）`];
}

function main() {
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const lines = sessionHookLines({
      projectDir,
      runOnce: (dir) => spawnSync(process.execPath, [join(dir, 'scripts', 'guard-keepalive.mjs'), '--once'], {
        encoding: 'utf8',
        cwd: dir, // --once 用 cwd 的 git worktree list 定主树（心跳/状态文件落主树 _flow），必须钉在判定的项目上
        timeout: ONCE_TIMEOUT_MS,
        windowsHide: true,
      }),
    });
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
  } catch (e) {
    process.stdout.write(`[卫] 守卫 hook 没查成：${String(e?.message || e).slice(0, 200)}（≠ 查过没事；只报不拦）\n`);
  }
  process.exit(0);
}

// 只被命令行直跑（hook 面）时开工；被测试 import 时只导出纯函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
