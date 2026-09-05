#!/usr/bin/env node
// scripts/notify-blocked.mjs —— 前置解除提醒（issue #526）
//
// 触发：.github/workflows/blocked-notify.yml（issues: closed + pull_request: closed
// + workflow_dispatch）。关闭一张 issue / 合并一张 PR 后，找出所有 open issue 和
// open PR 里写着 `Blocked-by: #<刚关的号>` 的，给每一张发一条评论提醒。
// 也可以在本地直接跑同一条命令补测（构造样本用）。
//
// 拍板（#526）：
//   - 写法只认一种：`Blocked-by: #N`，一行一张；其他写法（「前置」「等 #N」
//     「阻塞」「占用中」）一律不算，要靠收敛而不是兼容。
//   - 提醒措辞必须含「请先确认这单还成不成立」，禁止写「可以开工了」——
//     输出是提醒不是自动开工，默认动作是重估不是继续（反例：#518 落错分支的
//     commit、#501 缺陷一：前置解除后基础假设已被推翻）。
//
// 口径（#532）：
//   「搜到 0 条」是成功结果，「搜索失败」是没查成，两者必须分开——
//   搜索失败要在日志里报出来并以非 0 退出，绝不静默当成「没人等」。
//
// #544（本单）：
//   - 前置常常是 PR（#539 等 #519、#489/#481/#480/#478/#475 等 #463），而合并 PR
//     不触发 issues 事件——所以触发面要认 PR 号，等待者搜索也同时认 issue 与 PR：
//     gh issue list 只回 issue、gh pr list 只回 PR，两次都要搜、合并去重；
//     任何一次失败都会 ::error:: 报红并非 0 退出，不会退化成「0 条」。
//
// 用法：node scripts/notify-blocked.mjs <closedIssueOrPrNumber>

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

// 搜等待者候选：open issue 与 open PR 两个面都搜（#544：等待者可以是 PR，gh issue
// list 只回 issue、gh pr list 只回 PR，缺一个面就会漏提醒）。返回
// { ok: true, items }（合并去重后的原始召回，交给 findWaiters 精确过滤）或
// { ok: false, detail }（哪一面失败都在日志 ::error:: 报红——#532 口径：
// 搜索失败 = 没查成，绝不是「没人等」）。
export function searchWaiters(closedNumber, opts = {}) {
  const gh = opts.gh || 'gh';
  const ghArgs = opts.ghArgs || [];
  const query = `Blocked-by: #${closedNumber}`;
  const faces = [
    ['issue', ['issue', 'list', '--state', 'open', '--search', query, '--json', 'number,title,body', '--limit', '100']],
    ['pr', ['pr', 'list', '--state', 'open', '--search', query, '--json', 'number,title,body', '--limit', '100']],
  ];
  const items = [];
  for (const [face, args] of faces) {
    const out = spawnSync(gh, [...ghArgs, ...args], { windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (out.error || out.status !== 0) {
      const detail = String(out.stderr || (out.error && out.error.message) || `gh ${face} 调用异常`).trim().slice(0, 400);
      process.stderr.write(`::error::前置提醒搜索失败（gh ${face} list --search "${query}"）——本次没查成，不是搜到 0 条。\n${detail}\n`);
      return { ok: false, detail, raw: items };
    }
    let parsed;
    try {
      parsed = JSON.parse(out.stdout);
    } catch (e) {
      process.stderr.write(`::error::前置提醒搜索返回不是 JSON（gh ${face} list）——本次没查成，不是搜到 0 条。\n${out.stdout.slice(0, 400)}\n`);
      return { ok: false, detail: String(e.message || e).slice(0, 200), raw: items };
    }
    items.push(...(Array.isArray(parsed) ? parsed : []));
  }
  // 两个面按号去重（issue 与 PR 共用号段、正常不会撞，防御一次召回两遍导致双评论）。
  const seen = new Set();
  const merged = [];
  for (const item of items) {
    if (Number.isInteger(item && item.number) && !seen.has(item.number)) {
      seen.add(item.number);
      merged.push(item);
    }
  }
  return { ok: true, items: merged };
}

// 跑一轮提醒。返回 { ok, waiters, reason?, detail?, failures? }，绝不静默吞失败。
export function runNotify(closedNumber, opts = {}) {
  const gh = opts.gh || 'gh';
  const ghArgs = opts.ghArgs || [];
  const searchRes = searchWaiters(closedNumber, opts);
  if (!searchRes.ok) {
    return { ok: false, reason: 'search_failed', detail: searchRes.detail, waiters: [] };
  }

  const waiters = findWaiters(searchRes.items, closedNumber);
  if (waiters.length === 0) {
    // 0 条是成功结果：搜索本身成功了（两个面 gh 退出码都 0、JSON 都可解析），只是没人等。
    console.log(`前置提醒：open issue/PR 里写 \`Blocked-by: #${closedNumber}\` 的 0 张（搜索本身成功——0 条是结果，不是失败）。`);
    return { ok: true, waiters: [] };
  }

  const failures = [];
  for (const w of waiters) {
    const body = buildComment(closedNumber, w);
    const tmpFile = join(tmpdir(), `notify-blocked-${w.number}-${process.pid}.md`);
    writeFileSync(tmpFile, body, 'utf8');
    const r = spawnSync(gh, [...ghArgs, 'issue', 'comment', String(w.number), '--body-file', tmpFile], { windowsHide: true, encoding: 'utf8' });
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
  process.stderr.write('用法: node scripts/notify-blocked.mjs <closedIssueOrPrNumber>\n');
  process.exit(2);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const n = Number(process.argv[2]);
  if (!Number.isInteger(n) || n <= 0) usageAndExit(`要一个合法的 issue 或 PR 号（已关闭/已合并的），实际：${process.argv[2] || '(空)'}`);
  const res = runNotify(n);
  process.exit(res.ok ? 0 : 1);
}