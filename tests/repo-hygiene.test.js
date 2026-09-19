// repo-hygiene：仓库卫生判据的判别样本。每条只测一个行为；「没查成」必须与红/绿分得开。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = import('file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'repo-hygiene.mjs').replace(/\\/g, '/'));

test('机器漂移：未推 / 未拉 / 都干净', async () => {
  const { judgeRepoDrift } = await MOD;
  assert.equal(judgeRepoDrift({ ahead: 2, behind: 0 }).state, 'red');
  assert.match(judgeRepoDrift({ ahead: 2, behind: 0 }).why, /未推/);
  assert.equal(judgeRepoDrift({ ahead: 0, behind: 6 }).state, 'red');
  assert.match(judgeRepoDrift({ ahead: 0, behind: 6 }).why, /未拉/);
  assert.equal(judgeRepoDrift({ ahead: 0, behind: 0 }).state, 'green');
});

test('部署树必须干净：有未提交改动就是红；非部署树只作说明', async () => {
  const { judgeRepoDrift } = await MOD;
  assert.equal(judgeRepoDrift({ ahead: 0, behind: 0, dirty: 3, mustBeClean: true }).state, 'red');
  const loose = judgeRepoDrift({ ahead: 0, behind: 0, dirty: 3 });
  assert.equal(loose.state, 'green');
  assert.match(loose.why, /未提交/);
});

test('计数读不到 = 没查成（不是绿，也不是红）', async () => {
  const { judgeRepoDrift } = await MOD;
  assert.equal(judgeRepoDrift({}).state, 'unscanned');
  assert.equal(judgeRepoDrift({ ahead: 0 }).state, 'unscanned');
  assert.equal(judgeRepoDrift(null).state, 'unscanned');
});

test('PR 积压：冲突优先于数量与年龄', async () => {
  const { judgePrBacklog } = await MOD;
  const conflicting = judgePrBacklog({ open: [{ number: 1, ageDays: 0.1, mergeable: 'CONFLICTING' }] });
  assert.equal(conflicting.state, 'red');
  assert.match(conflicting.why, /#1/);
});

test('PR 积压：数量超阈值与最老超阈值各判红', async () => {
  const { judgePrBacklog } = await MOD;
  const many = judgePrBacklog({ open: Array.from({ length: 7 }, (_, i) => ({ number: i + 1, ageDays: 0.2, mergeable: 'MERGEABLE' })) });
  assert.equal(many.state, 'red');
  assert.match(many.why, /阈值/);
  const old = judgePrBacklog({ open: [{ number: 9, ageDays: 3, mergeable: 'MERGEABLE' }] });
  assert.equal(old.state, 'red');
  assert.match(old.why, /最老/);
});

test('PR 积压：都在阈值内为绿；清单读不到为没查成', async () => {
  const { judgePrBacklog } = await MOD;
  assert.equal(judgePrBacklog({ open: [{ number: 1, ageDays: 0.5, mergeable: 'MERGEABLE' }] }).state, 'green');
  assert.equal(judgePrBacklog({ open: null }).state, 'unscanned');
  assert.equal(judgePrBacklog({}).state, 'unscanned');
});

test('汇总：红优先；没有红但有没查成 → 没查成（不许当绿）', async () => {
  const { summarizeHygiene } = await MOD;
  assert.equal(summarizeHygiene([{ state: 'green' }, { state: 'red' }, { state: 'unscanned' }]).state, 'red');
  assert.equal(summarizeHygiene([{ state: 'green' }, { state: 'unscanned' }]).state, 'unscanned');
  assert.equal(summarizeHygiene([{ state: 'green' }]).state, 'green');
  assert.deepEqual(summarizeHygiene([{ state: 'green' }, { state: 'unscanned' }]).counts, { green: 1, red: 0, unscanned: 1 });
});
