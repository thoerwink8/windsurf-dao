// provider-health：消费健康表 + 熔断表（#842 F15 / #843 熔断）
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LIB = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'provider-health.mjs').replace(/\\/g, '/');

// 三个模型：deepseek 走 gw-dspool（target gw:dspool/deepseek-v4-flash）、gpt 走 codex、grok 走 grok（unscanned target=null）
const MODELS = [
  { id: 'deepseek-v4-flash', provider: 'gw', cli_model: 'gw-dspool/deepseek-v4-flash' },
  { id: 'gpt-5.6-sol', provider: 'gpt', cli_model: 'gpt-5.6-sol' },
  { id: 'grok-4.6', provider: 'grok', cli_model: 'grok-4.6' },
];
const NOW = Date.parse('2026-09-03T12:00:00Z');

function healthTable(state, ageMin = 5, intervalMin = 30) {
  return {
    ok: true, present: true, unknown: false, intervalMin, path: '/x',
    table: { 'gw:dspool/deepseek-v4-flash': { state, code: state === 'red' ? 403 : 200 } },
  };
}

describe('availabilityFor 健康表', () => {
  it('缺失/过期 → unknown：不拦 + note「健康表没查成」', async () => {
    const { availabilityFor } = await import(LIB);
    const health = { ok: true, present: false, unknown: true, table: null, reason: '健康表文件不在', path: '/x' };
    const r = availabilityFor(MODELS, { health, breaker: { present: false, targets: {} }, now: NOW });
    assert.equal(r.unknown, true);
    assert.ok(r.notes.some(n => /健康表没查成/.test(n)), JSON.stringify(r.notes));
    // 不拦：没有 hardBlocked
    assert.equal(Object.keys(r.hardBlocked).length, 0);
    assert.equal(r.availability['deepseek-v4-flash'], '空闲');
  });
  it('某 provider 红 → 后置（deprioritize）+ reasons 含 availability:red，但不 hardBlock', async () => {
    const { availabilityFor } = await import(LIB);
    const r = availabilityFor(MODELS, { health: healthTable('red'), breaker: { present: false, targets: {} }, now: NOW });
    assert.equal(r.availability['deepseek-v4-flash'], 'red');
    assert.ok(r.deprioritize.has('deepseek-v4-flash'));
    assert.ok((r.reasons['deepseek-v4-flash'] || []).some(x => x === 'availability:red'));
    assert.equal(r.hardBlocked['deepseek-v4-flash'], undefined); // 不直接拦
  });
  it('绿 → 空闲', async () => {
    const { availabilityFor } = await import(LIB);
    const r = availabilityFor(MODELS, { health: healthTable('green'), breaker: { present: false, targets: {} }, now: NOW });
    assert.equal(r.availability['deepseek-v4-flash'], '空闲');
    assert.ok(!r.deprioritize.has('deepseek-v4-flash'));
  });
});

describe('availabilityFor 熔断表（#843）', () => {
  it('open 且冷却未到 → cooldown 直接拦（hardBlocked）', async () => {
    const { availabilityFor } = await import(LIB);
    const breaker = { present: true, targets: { 'gw:dspool/deepseek-v4-flash': { state: 'open', cooldownUntil: '2026-09-03T12:30:00Z', why: '连续 5 次 403' } } };
    const r = availabilityFor(MODELS, { health: healthTable('green'), breaker, now: NOW });
    assert.ok(r.hardBlocked['deepseek-v4-flash'], JSON.stringify(r.hardBlocked));
    assert.match(r.availability['deepseek-v4-flash'], /^cooldown\(until /);
    assert.ok((r.reasons['deepseek-v4-flash'] || []).some(x => /availability:cooldown/.test(x)));
  });
  it('缺失（present:false）→ 无熔断，不拦、不出 note', async () => {
    const { availabilityFor } = await import(LIB);
    const before = availabilityFor(MODELS, { health: healthTable('green'), breaker: { present: false, targets: {} }, now: NOW });
    assert.equal(Object.keys(before.hardBlocked).length, 0);
    assert.ok(!before.notes.some(n => /熔断/.test(n)));
  });
  it('half-open → 后置探一针（deprioritize，不 hardBlock）', async () => {
    const { availabilityFor } = await import(LIB);
    const breaker = { present: true, targets: { 'gw:dspool/deepseek-v4-flash': { state: 'half-open' } } };
    const r = availabilityFor(MODELS, { health: healthTable('green'), breaker, now: NOW });
    assert.ok(r.deprioritize.has('deepseek-v4-flash'));
    assert.equal(r.hardBlocked['deepseek-v4-flash'], undefined);
  });
  it('open 但冷却已过 → 不直接拦，降级为后置', async () => {
    const { availabilityFor } = await import(LIB);
    const breaker = { present: true, targets: { 'gw:dspool/deepseek-v4-flash': { state: 'open', cooldownUntil: '2026-09-03T11:00:00Z' } } };
    const r = availabilityFor(MODELS, { health: healthTable('green'), breaker, now: NOW });
    assert.equal(r.hardBlocked['deepseek-v4-flash'], undefined);
    assert.ok(r.deprioritize.has('deepseek-v4-flash'));
  });
});

describe('loadHealthTable 过期判定', () => {
  it('age > 2×interval → unknown', async () => {
    const { loadHealthTable } = await import(LIB);
    const read = () => JSON.stringify({ updatedAt: '2026-09-03T10:00:00Z', intervalMin: 30, targets: {} });
    const exists = () => true;
    const r = loadHealthTable({ read, exists, now: NOW }); // 120min > 60min
    assert.equal(r.unknown, true);
    assert.match(r.reason, /过期/);
  });
  it('age < 2×interval → 可用', async () => {
    const { loadHealthTable } = await import(LIB);
    const read = () => JSON.stringify({ updatedAt: '2026-09-03T11:45:00Z', intervalMin: 30, targets: { a: { state: 'green' } } });
    const exists = () => true;
    const r = loadHealthTable({ read, exists, now: NOW }); // 15min < 60min
    assert.equal(r.unknown, false);
    assert.ok(r.table.a);
  });
});
