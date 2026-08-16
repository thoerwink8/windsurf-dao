#!/usr/bin/env node
// scripts/notify-blocked-smoke.mjs —— 前置解除提醒：线上冒烟（显式跑，不进默认回归）
//
// #554 审官返工：默认回归测试不得直查线上 GitHub（#539 一旦关闭/正文变化/搜索索引
// 波动，硬断言就红；未登录环境又 SKIP，语义不稳）。线上验证从这里显式跑：
//   node scripts/notify-blocked-smoke.mjs [closedNumber=519] [expectedWaiter=539]
//
// 断言对象：#544 实证盲区样本——已合并 PR #519 的等待者 open issue #539
// （正文 `Blocked-by: #519`，真实损失案例，当初合并后从未被提醒）。
//
// 语义（对齐 #532）：gh 起不来/搜索失败 = 没查成，::error:: 报红并非 0 退出，
// 绝不静默当成「0 条」；期望等待者没被召回 = 显式失败（样本可能已过时，需换样本），
// 同样非 0 退出。只搜不评论。
//
// 退出码：0 = 期望命中；1 = 没查成或没命中；2 = 用法错。

import { searchWaiters, findWaiters } from './notify-blocked.mjs';

const closedNumber = Number(process.argv[2] || 519);
const expected = Number(process.argv[3] || 539);
if (!Number.isInteger(closedNumber) || closedNumber <= 0 || !Number.isInteger(expected) || expected <= 0) {
  process.stderr.write(`要合法的号：closedNumber=${process.argv[2] || 519} expectedWaiter=${process.argv[3] || 539}\n`);
  process.stderr.write('用法: node scripts/notify-blocked-smoke.mjs [closedNumber=519] [expectedWaiter=539]\n');
  process.exit(2);
}

const res = searchWaiters(closedNumber, {});
if (!res.ok) {
  process.stderr.write(`::error::线上冒烟没查成（gh issue/pr list --search "Blocked-by: #${closedNumber}"）——不是搜到 0 条。\n${res.detail}\n`);
  process.exit(1);
}

const waiters = findWaiters(res.items, closedNumber);
const hit = waiters.some(w => w.number === expected);
console.log(`线上冒烟：closed=#${closedNumber} → 精确命中 ${waiters.map(w => '#' + w.number).join(', ') || '(无)'}${hit ? `（含期望 #${expected}）` : ''}`);
if (!hit) {
  process.stderr.write(`::error::线上冒烟失败：期望等待者 #${expected} 没被召回（样本可能已过时——#539 关闭/改正文/索引波动都会这样，换当前真实样本后重跑）。\n`);
  process.exit(1);
}
process.exit(0);
