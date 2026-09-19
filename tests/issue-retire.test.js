// #1503：落后单的机械清退。纯函数喂样本；「没查成」必须与绿/红分得开。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = import('file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'issue-retire.mjs').replace(/\\/g, '/'));

const NOW = Date.parse('2026-09-19T00:00:00Z');
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const issue = (over = {}) => ({
  number: over.number || 1,
  title: over.title || 't',
  updatedAt: over.updatedAt || ago(1),
  labels: over.labels || [],
  milestone: over.milestone === undefined ? { title: 'v2.11 期：指挥官+Fusion 落地' } : over.milestone,
});

test('该清退：已带「待清退」且闲置超阈 → 红', async () => {
  const { judgeIssueStaleness } = await MOD;
  const r = judgeIssueStaleness({
    issues: [issue({ number: 11, updatedAt: ago(40), labels: [{ name: '待清退' }] })],
    prs: [], now: NOW,
  });
  assert.equal(r.state, 'red');
  assert.deepEqual(r.retire.map((x) => x.number), [11]);
  assert.match(r.why, /#11/);
});

test('进名单：闲置超 warn 但没标「待清退」→ 不红，只进观察名单', async () => {
  const { judgeIssueStaleness } = await MOD;
  const r = judgeIssueStaleness({ issues: [issue({ number: 12, updatedAt: ago(20) })], prs: [], now: NOW });
  assert.equal(r.state, 'green');
  assert.deepEqual(r.warn.map((x) => x.number), [12]);
  assert.deepEqual(r.retire, []);
});

test('刚动过的单不进名单（闲置 < warn）', async () => {
  const { judgeIssueStaleness } = await MOD;
  const r = judgeIssueStaleness({ issues: [issue({ number: 13, updatedAt: ago(2) })], prs: [], now: NOW });
  assert.equal(r.state, 'green');
  assert.deepEqual(r.warn, []);
});

test('豁免：挂「将来某版」/ P0 / 有在途 PR 认领 / 容器单，再旧也不动', async () => {
  const { judgeIssueStaleness } = await MOD;
  const r = judgeIssueStaleness({
    issues: [
      issue({ number: 21, updatedAt: ago(99), milestone: { title: '将来某版' } }),
      issue({ number: 22, updatedAt: ago(99), labels: [{ name: 'priority/P0' }] }),
      issue({ number: 23, updatedAt: ago(99) }),
      issue({ number: 1460, updatedAt: ago(99) }),
    ],
    prs: [{ number: 9, title: 'fix', body: '署名 issue #23' }],
    now: NOW,
  });
  assert.equal(r.state, 'green');
  assert.deepEqual(r.warn, []);
  assert.deepEqual(r.retire, []);
  assert.deepEqual(r.exempt.map((x) => x.number).sort((a, b) => a - b), [21, 22, 23, 1460]);
});

test('阈值可配置：warn=1 / retire=2 时，闲置 3 天且带标的单该清退', async () => {
  const { judgeIssueStaleness } = await MOD;
  const r = judgeIssueStaleness({
    issues: [issue({ number: 31, updatedAt: ago(3), labels: [{ name: '待清退' }] })],
    prs: [], now: NOW,
    config: { warnIdleDays: 1, retireIdleDays: 2 },
  });
  assert.equal(r.state, 'red');
  assert.deepEqual(r.retire.map((x) => x.number), [31]);
});

test('没查成：issue / PR 面 / now 任一缺失或读不清 → unscanned（不是绿）', async () => {
  const { judgeIssueStaleness } = await MOD;
  assert.equal(judgeIssueStaleness({ prs: [], now: NOW }).state, 'unscanned');
  assert.equal(judgeIssueStaleness({ issues: [], now: NOW }).state, 'unscanned');
  assert.equal(judgeIssueStaleness({ issues: [], prs: [] }).state, 'unscanned');
  assert.equal(judgeIssueStaleness({ issues: [{ number: 1 }], prs: [], now: NOW }).state, 'unscanned');
  assert.equal(judgeIssueStaleness({ issues: [{ title: 'no number' }], prs: [], now: NOW }).state, 'unscanned');
});

test('认领解析：署名 issue #N 与关闭关键词都算在途', async () => {
  const { claimedIssueNumbers } = await MOD;
  assert.deepEqual(claimedIssueNumbers({ title: 'x', body: '署名 issue #77' }), [77]);
  assert.deepEqual(claimedIssueNumbers({ title: 'fix #88', body: '' }), [88]);
  assert.deepEqual(claimedIssueNumbers({ title: 'nothing', body: 'closes #99 and fixes #100' }), [99, 100]);
});
