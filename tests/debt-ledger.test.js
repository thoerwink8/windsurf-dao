// T32：债册子纯判据。喂样本，不联网、不起进程。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = import('file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'debt-ledger.mjs').replace(/\\/g, '/'));

const NOW = '2026-09-19T00:00:00Z';
const SLA = {
  immediate: ['security(可达) P1/P2', 'data P1/P2', 'correctness P1', 'maintainability P1'],
  withinOneWeek: ['security(可达) P3', 'security(不可达) P2', 'correctness P2/P3'],
  withinTwoWeeks: ['perf P2'],
  debtBatch: ['maintainability P2/P3', 'ui P2/P3', 'perf P3'],
};

test('指纹：同处同类型稳定；有位置用位置，没位置用 id 兜底', async () => {
  const { debtFingerprint } = await MOD;
  const a = debtFingerprint({ file: 'scripts/x.mjs', line: 12, type: 'perf' });
  assert.equal(a, debtFingerprint({ file: 'scripts/x.mjs', line: 12, type: 'perf' }));
  assert.notEqual(a, debtFingerprint({ file: 'scripts/x.mjs', line: 13, type: 'perf' }));
  assert.notEqual(a, debtFingerprint({ file: 'scripts/x.mjs', line: 12, type: 'ui' }));
  const byId = debtFingerprint({ id: 'ci-fail-is-rework' });
  assert.equal(byId, debtFingerprint({ id: 'ci-fail-is-rework' }));
  assert.notEqual(byId, a);
});

test('SLA 矩阵：按类型×严重度（×可达）落桶', async () => {
  const { slaBucket } = await MOD;
  assert.equal(slaBucket({ type: 'security', severity: 'P1', reachable: true }, SLA).bucket, 'immediate');
  assert.equal(slaBucket({ type: 'security', severity: 'P1', reachable: false }, SLA).bucket, 'unknown');
  assert.equal(slaBucket({ type: 'security', severity: 'P2', reachable: false }, SLA).bucket, 'withinOneWeek');
  assert.equal(slaBucket({ type: 'perf', severity: 'P2' }, SLA).bucket, 'withinTwoWeeks');
  assert.equal(slaBucket({ type: 'maintainability', severity: 'P2' }, SLA).bucket, 'debtBatch');
  assert.equal(slaBucket({ type: 'ui', severity: 'P3' }, SLA).bucket, 'debtBatch');
  assert.equal(slaBucket({ type: 'ui', severity: 'P1' }, SLA).bucket, 'unknown');
});

test('折叠：新发现入账；同指纹只累加计数不重复开条', async () => {
  const { foldFindings } = await MOD;
  const first = foldFindings({
    items: [], now: NOW, sla: SLA,
    findings: [{ id: 'a', severity: 'P2', type: 'perf', file: 'x.mjs', line: 3, detail: 'd' }],
  });
  assert.equal(first.added, 1);
  assert.equal(first.items[0].count, 1);
  assert.equal(first.items[0].sla, 'withinTwoWeeks');
  assert.equal(first.items[0].dueAt, '2026-10-03T00:00:00.000Z');

  const second = foldFindings({
    items: first.items, now: '2026-09-20T00:00:00Z', sla: SLA,
    findings: [{ id: 'a', severity: 'P2', type: 'perf', file: 'x.mjs', line: 3, detail: 'd2' }],
  });
  assert.equal(second.added, 0);
  assert.equal(second.bumped, 1);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].count, 2);
  assert.equal(second.items[0].lastSeen, '2026-09-20T00:00:00Z');
});

test('折叠：P1 不进册子（仍阻塞返工）；没 type 按 maintainability 兜底，不丢', async () => {
  const { foldFindings } = await MOD;
  const r = foldFindings({
    items: [], now: NOW, sla: SLA,
    findings: [
      { id: 'block', severity: 'P1', type: 'perf', detail: 'd' },
      { id: 'no-type', severity: 'P2', detail: 'd' },
      { id: 'bad-type', severity: 'P2', type: 'nonsense', detail: 'd' },
    ],
  });
  assert.equal(r.added, 1);
  assert.equal(r.skipped, 2);
  assert.equal(r.items[0].type, 'maintainability');
});

test('判账本：超期红 / 条数超阈红 / 空绿 / 没读成 unscanned', async () => {
  const { judgeDebt } = await MOD;
  const overdue = judgeDebt({
    items: [{ file: 'x.mjs', line: 1, type: 'perf', severity: 'P2', dueAt: '2026-09-01T00:00:00Z' }],
    now: Date.parse(NOW),
  });
  assert.equal(overdue.state, 'red');
  assert.match(overdue.why, /超期/);

  const tooMany = judgeDebt({ items: Array.from({ length: 3 }, () => ({ dueAt: null })), now: Date.parse(NOW), maxItems: 2 });
  assert.equal(tooMany.state, 'red');
  assert.match(tooMany.why, /阈值/);

  assert.equal(judgeDebt({ items: [], now: Date.parse(NOW) }).state, 'green');
  assert.equal(judgeDebt({ items: null, now: Date.parse(NOW) }).state, 'unscanned');
  assert.equal(judgeDebt({ items: [] }).state, 'unscanned');
});
