// tests/model-reconcile.test.js —— #944 选型表与实际跑的模型对账
//
// ① 故意违规：腿表标「停用」的腿实际在跑 → 必须红，且点名那条腿。
// ② 故意违规：实际跑的腿腿表里压根没有 → 必须红。
// ③ 全对上 → 绿。
// ④ 「没扫到样本」与「扫完 0 条」分得开：前者 unknown，后者 ok。
// ⑤ 判别力（变异自证）：把探针流量的过滤器拿掉，① 之外会多出假红——
//    证明 leg/status 两道滤网真的在起作用，不是摆设。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUsageNdjson,
  usageToLeg,
  billableRecords,
  classifyReconcile,
} from '../scripts/lib/model-reconcile.mjs';

// 真实形状的夹具：字段名与 ~/.mirasim/insights/usage-2026-09.ndjson 实测一致
const rec = (o) => ({
  leg: 'relay',
  status: 200,
  upstreamHost: 'relay.mirasim.ai',
  sessionId: 's1',
  ...o,
});

const LEGS = [
  { id: 'claude-opus-5@mirasim/mirasim', 模型: 'claude-opus-5', 族: 'claude', 供应商: 'mirasim', 执行侧: 'mirasim', 状态: '停用' },
  { id: 'gpt-5.6-sol@mirasim/mirasim', 模型: 'gpt-5.6-sol', 族: 'codex', 供应商: 'mirasim', 执行侧: 'mirasim', 状态: '在役' },
  { id: 'grok-4.6@gw/orca', 模型: 'grok-4.6', 族: 'pi', 供应商: 'gw', 执行侧: 'orca', 状态: '在役' },
];

test('① 腿表标停用却在跑 → 红且点名', () => {
  const r = classifyReconcile({
    legs: LEGS,
    records: [rec({ agent: 'claude', model: 'claude-opus-5' }), rec({ agent: 'claude', model: 'claude-opus-5', sessionId: 's2' })],
  });
  assert.equal(r.state, 'red');
  assert.match(r.detail, /claude-opus-5@mirasim\/mirasim/);
  assert.match(r.detail, /停用/);
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.mismatches[0].n, 2);
  assert.equal(r.mismatches[0].sessions, 2);
});

test('② 实跑的腿腿表里没有 → 红', () => {
  const r = classifyReconcile({ legs: LEGS, records: [rec({ agent: 'codex', model: 'gpt-6-astra' })] });
  assert.equal(r.state, 'red');
  assert.match(r.detail, /gpt-6-astra@mirasim\/mirasim/);
  assert.match(r.detail, /未登记腿/);
});

test('③ 全对上 → 绿', () => {
  const r = classifyReconcile({ legs: LEGS, records: [rec({ agent: 'codex', model: 'gpt-5.6-sol' })] });
  assert.equal(r.state, 'ok');
  assert.equal(r.count, 1);
});

test('④ 没扫到样本 ≠ 扫完 0 条', () => {
  const noSample = classifyReconcile({ legs: LEGS, records: [] });
  assert.equal(noSample.state, 'unknown', '一条记录都没有必须是没查成');

  // 有记录但全被滤掉（全是非 200 的探针）= 扫完了，确实没有可对账的调用
  const allFiltered = classifyReconcile({
    legs: LEGS,
    records: [rec({ agent: 'claude', model: 'claude-does-not-exist-9', status: 422 })],
  });
  assert.equal(allFiltered.state, 'ok');
  assert.equal(allFiltered.count, 0);

  assert.equal(classifyReconcile({ legs: null, records: [] }).state, 'unknown');
  assert.equal(classifyReconcile({ legs: LEGS, records: null }).state, 'unknown');
});

test('⑤ 判别力：两道滤网真的在滤，不是摆设', () => {
  // 探针流量：打不存在的型号换 422（量额度用）+ 没打上游的 local 腿
  const probes = [
    rec({ agent: 'claude', model: 'claude-does-not-exist-9', status: 422 }),
    rec({ agent: 'claude', model: 'claude-opus-5[1m]', status: 400 }),
    rec({ agent: 'claude', model: 'claude-opus-5', leg: 'local', upstreamHost: '' }),
  ];
  const good = [rec({ agent: 'codex', model: 'gpt-5.6-sol' })];

  // 有滤网：探针不算数，只剩一条对得上的腿 → 绿
  const withNet = classifyReconcile({ legs: LEGS, records: [...probes, ...good] });
  assert.equal(withNet.state, 'ok', '探针流量不该被判成违规');

  // 拿掉滤网（模拟判据失效）：三条探针会各自变成一条「未登记腿」的假红
  const unfiltered = [...probes, ...good].map((r) => ({ ...r, leg: 'relay', status: 200 }));
  const withoutNet = classifyReconcile({ legs: LEGS, records: unfiltered });
  assert.equal(withoutNet.state, 'red', '拿掉滤网必须出现假红——否则说明滤网从来没起作用');
  assert.ok(withoutNet.mismatches.length >= 2, `拿掉滤网应多出假红，实际 ${withoutNet.mismatches.length} 条`);
});

test('解析与映射：坏行单独计数，供应商不猜', () => {
  const { records, badLines } = parseUsageNdjson('{"a":1}\n\n不是json\n{"b":2}\n');
  assert.equal(records.length, 2);
  assert.equal(badLines, 1);

  assert.deepEqual(usageToLeg({ model: 'm', agent: 'claude', upstreamHost: 'relay.mirasim.ai' }), {
    模型: 'm', 族: 'claude', 供应商: 'mirasim', 执行侧: 'mirasim',
  });
  // 不认识的 host 原样带出去，不静默归到某条腿上
  assert.equal(usageToLeg({ model: 'm', agent: 'claude', upstreamHost: 'somewhere.else' }).供应商, 'somewhere.else');

  assert.equal(billableRecords([rec({}), rec({ status: 500 }), rec({ leg: 'local' })]).length, 1);
});
