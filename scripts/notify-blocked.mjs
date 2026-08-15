#!/usr/bin/env node
// scripts/notify-blocked.mjs —— 前置解除提醒（issue #526）
//
// 触发：.github/workflows/blocked-notify.yml，on: issues: types: [closed]。
// 关掉一张 issue 后，找出所有 open issue 正文里写着 `Blocked-by: #<刚关的号>` 的，
// 给每一张发一条评论提醒。也可以在本地直接跑同一条命令补测（构造样本用）。
//
// 拍板（#526）：
//   - 写法只认一种：`Blocked-by: #N`，一行一张；其他写法（「前置」「等 #N」
//     「阻塞」「占用中」）一律不算，要靠收敛而不是兼容。
//   - 提醒措辞必须含「请先确认这单还成不成立」，禁止写「可以开工了」——
//     输出是提醒不是自动开工，默认动作是重估不是继续（反例：#518 落错分支的
//     commit、#501 缺陷一：前置解除后基础假设已被推翻）。
//
// 口径（#532，本单是第一个用上的点）：
//   「搜到 0 条」是成功结果，「搜索失败」是没查成，两者必须分开——
//   搜索失败要在日志里报出来并以非 0 退出，绝不静默当成「没人等」。
//
// 用法：node scripts/notify-blocked.mjs <closedIssueNumber>

import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 只认 `Blocked-by: #N` 一种写法（#526 拍板）。词边界保证 #497 不会误吞 #4970；
// 大小写敏感，小写 blocked-by / 全角冒号都不算数，逼写法收敛成唯一形态。
export function markerPattern(closedNumber) {
  return new RegExp(`\\bBlocked-by\\s*:\\s*#${closedNumber}\\b`);
}

// 从 gh issue list --json 的返回里挑出真写了该标记的 open issue（正文精确匹配，
// 不信任搜索 API 的命中即精确——#4970 之类会被搜索召回但要在此滤掉）。
export function findWaiters(issues, closedNumber) {
  const re = markerPattern(closedNumber);
  return (Array.isArray(issues) ? issues : [])
    .filter(i => i && Number.isInteger(i.number) && typeof i.body === 'string' && re.test(i.body))
    .sort((a, b) => a.number - b.number);
}

// 评论措辞：必须含「请先确认这单还成不成立」，不得出现「可以开工了」。
// #526 核心判断没变：默认动作是重估不是继续。
export function buildComment(closedNumber, waiter) {
  const title = waiter && waiter.title ? `「${waiter.title}」` : '';
  return [
    '### 前置解除提醒（#526 自动机制）',
    '',
    `被依赖的 #${closedNumber} 已关闭。${title ? `${title} ` : ''}**请先确认这单还成不成立**——前置解除 ≠ 自动开工：它可能已经并进别处、已经做完、或接受重估后根本不用做了。`,
    '',
    '确认后按结论走：还做 → 更新本单继续；不做 → 关闭本单并写明理由。',
  ].join('\n');
}

// 跑一轮提醒。返回 { ok, waiters, reason?, detail?, failures? }，绝不静默吞失败。
export function runNotify(closedNumber, opts = {}) {
  const gh = opts.gh || 'gh';
  const ghArgs = opts.ghArgs || [];
  const searchOut = spawnSync(gh, [...ghArgs, 'issue', 'list', '--state', 'open',
    '--search', `Blocked-by: #${closedNumber}`,
    '--json', 'number,title,body', '--limit', '100'],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

  if (searchOut.error || searchOut.status !== 0) {
    const detail = String(searchOut.stderr || (searchOut.error && searchOut.error.message) || 'gh 调用异常').trim().slice(0, 400);
    // ::error:: 是 GitHub Actions 日志注记，本地跑时同样直接可见；
    // 搜索失败 = 没查成，按 #532 口径不得当「没人等」。
    process.stderr.write(`::error::前置提醒搜索失败（gh issue list --search "Blocked-by: #${closedNumber}"）——本次没查成，不是搜到 0 条。\n${detail}\n`);
    return { ok: false, reason: 'search_failed', detail, waiters: [] };
  }

  let issues;
  try {
    issues = JSON.parse(searchOut.stdout);
  } catch (e) {
    process.stderr.write(`::error::前置提醒搜索返回不是 JSON（gh issue list）——本次没查成，不是搜到 0 条。\n${searchOut.stdout.slice(0, 400)}\n`);
    return { ok: false, reason: 'search_failed', detail: String(e.message || e).slice(0, 200), waiters: [] };
  }

  const waiters = findWaiters(issues, closedNumber);
  if (waiters.length === 0) {
    // 0 条是成功结果：搜索本身成功了（gh 退出码 0、JSON 可解析），只是没人等。
    console.log(`前置提醒：open issue 里写 \`Blocked-by: #${closedNumber}\` 的 0 张（搜索本身成功——0 条是结果，不是失败）。`);
    return { ok: true, waiters: [] };
  }

  const failures = [];
  for (const w of waiters) {
    const body = buildComment(closedNumber, w);
    const tmpFile = join(tmpdir(), `notify-blocked-${w.number}-${process.pid}.md`);
    writeFileSync(tmpFile, body, 'utf8');
    const r = spawnSync(gh, [...ghArgs, 'issue', 'comment', String(w.number), '--body-file', tmpFile], { encoding: 'utf8' });
    unlinkSync(tmpFile);
    if (r.error || r.status !== 0) {
      failures.push({ number: w.number, detail: String(r.stderr || (r.error && r.error.message) || 'gh issue comment 失败').trim().slice(0, 300) });
    } else {
      console.log(`前置提醒已发：#${w.number}（等 #${closedNumber}）`);
    }
  }
  if (failures.length > 0) {
    for (const f of failures) {
      process.stderr.write(`::error::给 #${f.number} 发提醒失败：${f.detail}\n`);
    }
    return { ok: false, reason: 'comment_failed', waiters, failures };
  }
  return { ok: true, waiters };
}

function usageAndExit(msg) {
  process.stderr.write(`${msg}\n`);
  process.stderr.write('用法: node scripts/notify-blocked.mjs <closedIssueNumber>\n');
  process.exit(2);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const n = Number(process.argv[2]);
  if (!Number.isInteger(n) || n <= 0) usageAndExit(`要一个合法的 issue 号，实际：${process.argv[2] || '(空)'}`);
  const res = runNotify(n);
  process.exit(res.ok ? 0 : 1);
}