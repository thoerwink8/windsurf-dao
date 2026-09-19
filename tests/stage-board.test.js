// T44：版本视图 / 伞单索引的生成与一致性判据。纯函数，喂样本，不联网。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = import('file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'stage-board.mjs').replace(/\\/g, '/'));

const issue = (over = {}) => ({
  number: over.number || 1,
  title: over.title || 't',
  state: over.state || 'OPEN',
  labels: over.labels || [],
  milestone: over.milestone === undefined ? { title: 'v2.11 期：指挥官+Fusion 落地' } : over.milestone,
});

test('priorityOf：认 priority/Pn 标签，别的标签不算', async () => {
  const { priorityOf } = await MOD;
  assert.equal(priorityOf(issue({ labels: [{ name: 'priority/P1' }, { name: 'type/体系' }] })), 'priority/P1');
  assert.equal(priorityOf(issue({ labels: ['priority/P0'] })), 'priority/P0');
  assert.equal(priorityOf(issue({ labels: [{ name: 'type/体系' }] })), null);
  assert.equal(priorityOf(null), null);
});

test('版本视图：三档按 priority 标签分，未标优先级单独成段且报数', async () => {
  const { renderStageView } = await MOD;
  const md = renderStageView({
    stage: 'v2.11', milestone: 'v2.11 期：指挥官+Fusion 落地', stageIssue: 1460,
    issues: [
      issue({ number: 11, title: '机制项', labels: [{ name: 'priority/P0' }] }),
      issue({ number: 22, title: '真问题', labels: [{ name: 'priority/P1' }] }),
      issue({ number: 33, title: '靠后的', labels: [{ name: 'priority/P2' }] }),
      issue({ number: 44, title: '没标' }),
      issue({ number: 55, title: '已关的', state: 'CLOSED' }),
    ],
  });
  assert.match(md, /<!-- dao-stage-priority: v2\.11 -->/);
  assert.match(md, /## 现在做（`priority\/P0`）[\s\S]*#11 机制项/);
  assert.match(md, /## 紧接着（`priority\/P1`）[\s\S]*#22 真问题/);
  assert.match(md, /## 靠后（`priority\/P2`）[\s\S]*#33 靠后的/);
  assert.match(md, /## 未标优先级（1 张[\s\S]*#44 没标/);
  assert.match(md, /## 已完成（[\s\S]*#55 已关的/);
});

test('版本视图：正文不带时间戳（带就会天天红）', async () => {
  const { renderStageView } = await MOD;
  const md = renderStageView({ stage: 'v2.11', milestone: 'm', stageIssue: 1, issues: [] });
  assert.doesNotMatch(md, /生成于/);
});

test('伞单索引：当前版本标「在做」，其余标「顺延池」；只装里程碑与指针', async () => {
  const { renderUmbrellaIndex } = await MOD;
  const md = renderUmbrellaIndex({
    stage: 'v2.11', stageIssue: 1460, stageMilestoneNumber: 3,
    milestones: [
      { number: 3, title: 'v2.11 期：指挥官+Fusion 落地', state: 'open' },
      { number: 2, title: '将来某版', state: 'open' },
      { number: 1, title: '历史版', state: 'closed' },
    ],
  });
  assert.match(md, /<!-- dao-umbrella-index -->/);
  assert.match(md, /\*\*v2\.11 期：指挥官\+Fusion 落地\*\*（#3） \| \*\*在做\*\*/);
  assert.match(md, /\*\*将来某版\*\*（#2） \| 顺延池/);
  assert.doesNotMatch(md, /历史版/, '已关的里程碑不进当前索引');
});

test('一致性：正文一致 → 绿；网关补的幂等标记不算差异', async () => {
  const { judgePostedConsistency } = await MOD;
  const expected = '<!-- dao-stage-priority: v2.11 -->\n正文\n';
  const posted = [{ id: 9, body: '<!-- dao-stage-priority: v2.11 -->\n正文\n\n<!-- dao-idempotency:stage-view-v2.11 -->\n' }];
  const r = judgePostedConsistency({ marker: 'dao-stage-priority: v2.11', expected, posted });
  assert.equal(r.state, 'green', r.why);
});

test('一致性：正文不同 → 红（指出要重新发布）', async () => {
  const { judgePostedConsistency } = await MOD;
  const r = judgePostedConsistency({
    marker: 'dao-stage-priority: v2.11', expected: 'A',
    posted: [{ id: 9, body: '<!-- dao-stage-priority: v2.11 -->\nB' }],
  });
  assert.equal(r.state, 'red');
  assert.match(r.why, /不一致/);
});

test('一致性：还没发布 / 清单取不到 → 没查成（不是绿也不是红）', async () => {
  const { judgePostedConsistency } = await MOD;
  const none = judgePostedConsistency({ marker: 'dao-stage-priority: v2.11', expected: 'A', posted: [{ id: 1, body: '别的' }] });
  assert.equal(none.state, 'unscanned');
  assert.match(none.why, /还没发布/);
  assert.equal(judgePostedConsistency({ marker: 'x', expected: 'A', posted: null }).state, 'unscanned');
});
