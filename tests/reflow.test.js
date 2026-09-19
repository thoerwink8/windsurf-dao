// T37 ②：回流收件箱的纯判据。喂样本，不联网、不起进程。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = import('file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'reflow.mjs').replace(/\\/g, '/'));

const NOW = Date.parse('2026-09-19T00:00:00Z');
const DAY = 86400000;
const doc = (over) => ({ name: 'inbox/a.md', box: 'inbox', title: 'x', from: 'ags', at: NOW, handled: false, missingReason: false, ...over });

test('解析：frontmatter 三行 + 「处置：」行也算已处置（容得下最省事的写法）', async () => {
  const { parseReflowDoc } = await MOD;
  const d = parseReflowDoc('---\n来源仓: ags-orgswitch\n产物: 探活脚本\n为什么通用: 两条\n落点: scripts/lib/x.mjs\n---\n\n# 标题\n', { name: 'inbox/1.md', mtimeMs: NOW, box: 'inbox' });
  assert.equal(d.from, 'ags-orgswitch');
  assert.equal(d.title, '标题');
  assert.equal(d.handled, false);

  const handled = parseReflowDoc('# 标题\n\n处置：accepted → scripts/lib/x.mjs（devin）\n', { name: 'inbox/2.md', box: 'inbox' });
  assert.equal(handled.handled, true);
});

test('解析：rejected 里没有理由 = 没接住（C2）；accepted/inbox 不适用这条', async () => {
  const { parseReflowDoc } = await MOD;
  assert.equal(parseReflowDoc('# t\n', { name: 'rejected/a.md', box: 'rejected' }).missingReason, true);
  assert.equal(parseReflowDoc('# t\n\n理由：本仓已经有同功能实现\n', { name: 'rejected/a.md', box: 'rejected' }).missingReason, false);
  assert.equal(parseReflowDoc('# t\n', { name: 'accepted/a.md', box: 'accepted' }).missingReason, false);
  assert.equal(parseReflowDoc('# t\n', { name: 'accepted/a.md', box: 'accepted' }).handled, true);
});

test('扫一轮：空 → quiet；有未处置但没超时 → notice；超时 → block', async () => {
  const { assessReflow, judgeReflow } = await MOD;
  assert.equal(assessReflow({ docs: [], now: NOW }).mode, 'quiet');
  assert.equal(assessReflow({ docs: [doc({ at: NOW - DAY })], now: NOW }).mode, 'notice');
  assert.equal(assessReflow({ docs: [doc({ at: NOW - 8 * DAY })], now: NOW }).mode, 'block');
  assert.equal(judgeReflow(assessReflow({ docs: [doc({ at: NOW - 8 * DAY })], now: NOW })).state, 'red');
  assert.equal(judgeReflow(assessReflow({ docs: [doc({ at: NOW - DAY })], now: NOW })).state, 'green');
});

test('扫一轮：堆积到上限、rejected 缺理由、未提交 —— 都 block（三条牙）', async () => {
  const { assessReflow } = await MOD;
  const five = Array.from({ length: 5 }, (_, i) => doc({ name: `inbox/${i}.md`, at: NOW }));
  assert.equal(assessReflow({ docs: five, now: NOW }).mode, 'block');
  assert.equal(assessReflow({ docs: [doc({ box: 'rejected', handled: true, missingReason: true })], now: NOW }).mode, 'block');
  assert.equal(assessReflow({ docs: [], untracked: ['host/reflow/inbox/a.md'], now: NOW }).mode, 'block');
});

test('没查成与「收件箱是空的」分得开', async () => {
  const { assessReflow, judgeReflow } = await MOD;
  const un = assessReflow({ unscanned: '读不了 host/reflow/inbox（ENOENT）' });
  assert.equal(un.unscanned, true);
  assert.equal(judgeReflow(un).state, 'unscanned');
  assert.equal(judgeReflow(assessReflow({ docs: null, now: NOW })).state, 'unscanned');
  assert.equal(judgeReflow(assessReflow({ docs: [], now: NOW })).state, 'green');
});

test('注入文本：quiet 不出字；block 给的是硬性指令', async () => {
  const { assessReflow, renderReflow } = await MOD;
  assert.equal(renderReflow(assessReflow({ docs: [], now: NOW })), '');
  const block = renderReflow(assessReflow({ docs: [doc({ at: NOW - 9 * DAY })], now: NOW }));
  assert.match(block, /硬闸/);
  assert.match(block, /rejected/);
});
