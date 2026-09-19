// T39 ④ 指挥官侧：收件箱机械裁决 + 躺太久判红。纯函数喂样本。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = import('file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'escalation-inbox.mjs').replace(/\\/g, '/'));

const NOW = Date.parse('2026-09-19T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const payload = (over = {}) => ({
  taskId: 'dao/owner/repo/issue/17/g1', failureClass: 'stall', blockedReason: 'step-stalled:executing',
  attempts: { round: 1, reviewRounds: 3 }, candidates: [], writtenAt: hoursAgo(1), ...over,
});
const item = (over = {}) => ({ name: 'x.json', payload: payload(over) });

test('容量满 → retry（工作流自己走长退避，收件箱里不重复等）', async () => {
  const { judgeEscalation } = await MOD;
  assert.equal(judgeEscalation({ payload: payload({ failureClass: 'capacity', blockedReason: 'step-failed:SERVICE_UNAVAILABLE：429 capacity' }) }).decision, 'retry');
});

test('停滞且还有轮次：有同 family 候补 → swap-leg；没候补 → retry', async () => {
  const { judgeEscalation } = await MOD;
  const withAlt = judgeEscalation({ payload: payload({ candidates: ['exec-alt'] }) });
  assert.equal(withAlt.decision, 'swap-leg');
  assert.match(withAlt.why, /exec-alt/);
  assert.equal(judgeEscalation({ payload: payload({ candidates: [] }) }).decision, 'retry');
});

test('停滞且轮次用尽 → ask-human（机器不该自己加轮次）', async () => {
  const { judgeEscalation } = await MOD;
  const r = judgeEscalation({ payload: payload({ attempts: { round: 3, reviewRounds: 3 } }) });
  assert.equal(r.decision, 'ask-human');
  assert.match(r.why, /轮次已用尽/);
});

test('认不出的失败类 → ask-human，不硬拍', async () => {
  const { judgeEscalation } = await MOD;
  assert.equal(judgeEscalation({ payload: payload({ failureClass: 'unscanned' }) }).decision, 'ask-human');
  assert.equal(judgeEscalation({}).decision, 'ask-human');
});

test('收件箱：空 → 绿；都新鲜 → 绿并给决定计数', async () => {
  const { judgeEscalationInbox } = await MOD;
  assert.equal(judgeEscalationInbox({ items: [], now: NOW }).state, 'green');
  const fresh = judgeEscalationInbox({ items: [item(), item({ candidates: ['a'] })], now: NOW });
  assert.equal(fresh.state, 'green');
  assert.equal(fresh.counts.retry, 1);
  assert.equal(fresh.counts['swap-leg'], 1);
});

test('收件箱：有单子躺超 24h → 红（上报了没人看就是新的静默）', async () => {
  const { judgeEscalationInbox } = await MOD;
  const r = judgeEscalationInbox({ items: [item({ writtenAt: hoursAgo(30) })], now: NOW });
  assert.equal(r.state, 'red');
  assert.match(r.why, /没人看/);
  assert.equal(r.stale[0].ageHours, 30);
});

test('收件箱：取不到 / 没 writtenAt → 没查成（不是绿）', async () => {
  const { judgeEscalationInbox } = await MOD;
  assert.equal(judgeEscalationInbox({ items: null, now: NOW }).state, 'unscanned');
  assert.equal(judgeEscalationInbox({ items: [], now: undefined }).state, 'unscanned');
  assert.equal(judgeEscalationInbox({ items: [{ payload: { taskId: 't' } }], now: NOW }).state, 'unscanned');
});
