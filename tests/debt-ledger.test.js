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

test('锚点：取指纹前 8 位，稳定且带 DAO-DEBT 前缀', async () => {
  const { debtFingerprint, debtMarker } = await MOD;
  const fp = debtFingerprint({ file: 'scripts/x.mjs', line: 12, type: 'perf' });
  assert.equal(debtMarker(fp), `DAO-DEBT:${fp.slice(0, 8)}`);
  assert.equal(debtMarker(fp), debtMarker(fp));
  assert.equal(debtMarker('').length, 'DAO-DEBT:'.length);
});

test('重查即重算：标记在=复现；标记没了但文件也没了=可关；其余一律判不了', async () => {
  const { debtFingerprint, debtMarker, judgeRecheck } = await MOD;
  const mk = (file, id) => ({ fingerprint: debtFingerprint({ file, line: 1, type: 'perf', id }), file });
  const [still, gone, unmarked] = [mk('a.mjs'), mk('b.mjs'), mk('c.mjs')];
  const r = judgeRecheck({
    items: [still, gone, unmarked],
    markers: new Set([debtMarker(still.fingerprint)]),
    files: new Set(['a.mjs', 'c.mjs']),
  });
  assert.deepEqual(r.open.map((i) => i.file), ['a.mjs']);
  assert.deepEqual(r.resolved.map((i) => i.file), ['b.mjs']);
  assert.deepEqual(r.resolved.map((i) => i.evidence), ['file-gone']);
  assert.deepEqual(r.unscanned.map((i) => i.file), ['c.mjs']);
  assert.deepEqual(r.unscanned.map((i) => i.evidence), ['marker-missing']);
  assert.equal(r.state, 'unscanned');
});

test('重查：判不了的条目不许当已修——「扫不到」与「扫完没有」分得开', async () => {
  const { debtFingerprint, judgeRecheck } = await MOD;
  const items = [{ fingerprint: debtFingerprint({ id: 'x' }), file: 'a.mjs' }];
  assert.equal(judgeRecheck({ items, markers: new Set(), files: new Set(['a.mjs']) }).state, 'unscanned');
  assert.equal(judgeRecheck({ items, markers: [], files: new Set(['a.mjs']) }).state, 'unscanned');
  assert.equal(judgeRecheck({ items, markers: new Set(), files: ['a.mjs'] }).state, 'unscanned');
  assert.equal(judgeRecheck({ items: null, markers: new Set(), files: new Set() }).state, 'unscanned');
  assert.equal(judgeRecheck({ items: [], markers: new Set(), files: new Set() }).state, 'green');
});

test('重查：没位置的条目（只有 id）判不了，不会因为「文件不在」被误关', async () => {
  const { debtFingerprint, judgeRecheck } = await MOD;
  const r = judgeRecheck({
    items: [{ fingerprint: debtFingerprint({ id: 'no-loc' }), file: '' }],
    markers: new Set(), files: new Set(),
  });
  assert.equal(r.resolved.length, 0);
  assert.deepEqual(r.unscanned.map((i) => i.evidence), ['marker-missing']);
});

test('应用重查：只关判「可关」的，带证据进 closed，其余原地不动', async () => {
  const { applyRecheck } = await MOD;
  const r = applyRecheck({
    items: [
      { fingerprint: 'aaaa', file: 'a.mjs', line: 1, type: 'perf', severity: 'P2', count: 2 },
      { fingerprint: 'bbbb', file: 'b.mjs', line: 3, type: 'ui', severity: 'P3', count: 1 },
    ],
    closed: [{ fingerprint: 'old' }],
    resolved: [{ fingerprint: 'aaaa', evidence: 'file-gone' }],
    now: NOW,
  });
  assert.equal(r.closedCount, 1);
  assert.deepEqual(r.items.map((i) => i.fingerprint), ['bbbb']);
  assert.equal(r.closed.length, 2);
  assert.equal(r.closed[1].evidence, 'file-gone');
  assert.equal(r.closed[1].closedAt, NOW);
  assert.equal(r.closed[0].fingerprint, 'old');
});

test('出口前清算：还开着的债没清算 → 红；关掉或显式接受之后 → 绿', async () => {
  const { judgeDebtExit } = await MOD;
  const open = [{ fingerprint: 'aaaa', file: 'a.mjs', line: 1, type: 'perf', severity: 'P2' }];
  const red = judgeDebtExit({ items: open, accepted: [], closed: [] });
  assert.equal(red.state, 'red');
  assert.match(red.why, /没清算/);
  assert.equal(judgeDebtExit({ items: [], accepted: [{ fingerprint: 'aaaa' }], closed: [] }).state, 'green');
  assert.equal(judgeDebtExit({ items: [], accepted: [], closed: [{ fingerprint: 'aaaa' }] }).state, 'green');
  assert.equal(judgeDebtExit({ items: null, accepted: [], closed: [] }).state, 'unscanned');
  assert.equal(judgeDebtExit({ items: [], accepted: null, closed: [] }).state, 'unscanned');
});

test('显式接受：必须带理由（C2）；指纹找不到不许瞎改', async () => {
  const { acceptDebt } = await MOD;
  const items = [{ fingerprint: 'd71db24b13a913b2', file: 'a.mjs', line: 1, type: 'perf', severity: 'P2' }];
  assert.equal(acceptDebt({ items, accepted: [], fingerprint: 'd71db24b', reason: '' }).ok, false);
  assert.match(acceptDebt({ items, accepted: [], fingerprint: 'd71db24b', reason: '' }).error, /必须写理由/);
  assert.equal(acceptDebt({ items, accepted: [], fingerprint: '', reason: 'x' }).ok, false);
  assert.equal(acceptDebt({ items, accepted: [], fingerprint: 'deadbeef', reason: '本仓不适用' }).ok, false);

  const ok = acceptDebt({ items, accepted: [], fingerprint: 'd71db24b', reason: '这条是误报，已人工核过', now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.items.length, 0);
  assert.equal(ok.accepted.length, 1);
  assert.equal(ok.accepted[0].acceptedReason, '这条是误报，已人工核过');
  assert.equal(ok.accepted[0].acceptedAt, NOW);
  // 接受不改指纹与位置——判例要能追溯
  assert.equal(ok.accepted[0].fingerprint, 'd71db24b13a913b2');
});
