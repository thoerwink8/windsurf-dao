// 模型准入名单（#1174 值守实咬）：判据在 lib/model-admission.mjs。
//
// 这套测试存在的理由：这份名单是**唯一**进 assessDispatchModel 的 redIds 来源，
// 判错一次就是全盘派不出单——2026-09-10 真发生：28 个模型里 25 个被判红，
// 11 张单的差集重派全被挡成 escalate，机器空转几小时而日志只有一行「健康表红」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { healthRedIds } from '../scripts/lib/model-admission.mjs';

const routed = (id, over = {}) => ({ id, provider: 'gw', cli_model: `gw/grokpool/${id}`, ...over });
const profileOnly = (id) => ({ id, provider: '', cli_model: undefined });
const prof = (id, over = {}) => ({ id, enabled: true, availability: { status: 'available' }, defaultForModels: [], ...over });

test('有落地的模型：profile 未验不再连带冻掉它（2026-09-10 的 11 张单就是这个形态）', () => {
  const models = [routed('grok-4.6')];
  const profiles = [prof('grok-mirasim-native', { availability: { status: 'unverified' }, defaultForModels: ['grok-4.6'] })];
  const red = healthRedIds({ models, profiles, breaker: { ok: true, targets: {} } });
  assert.deepEqual(red, [], '选型落地在役，不该被另一个未验 profile 判红');
});

test('没有落地的 profile id：enabled 且 available 才放行', () => {
  const models = [profileOnly('some-native-x')];
  const ok = healthRedIds({ models, profiles: [prof('some-native-x', { defaultForModels: ['some-native-x'] })], breaker: { ok: true, targets: {} } });
  assert.deepEqual(ok, []);
  const unverified = healthRedIds({ models, profiles: [prof('some-native-x', { availability: { status: 'unverified' }, defaultForModels: ['some-native-x'] })], breaker: { ok: true, targets: {} } });
  assert.deepEqual(unverified, ['some-native-x'], '没验过的 profile 不许派');
  const disabled = healthRedIds({ models, profiles: [prof('some-native-x', { enabled: false, defaultForModels: ['some-native-x'] })], breaker: { ok: true, targets: {} } });
  assert.deepEqual(disabled, ['some-native-x'], '停用的 profile 不许派');
});

test('熔断 open 未到冷却 → 红；冷却已过 → 放行（半开要给机会）', () => {
  const models = [{ id: 'gpt-5.6-sol', provider: 'gpt' }]; // probeTargetForModel → direct:codex@pqapi/responses
  const targets = { 'direct:codex@pqapi/responses': { state: 'open', cooldownUntil: '2026-09-10T17:39:20.055Z' } };
  const now = Date.parse('2026-09-10T13:00:00Z');
  assert.deepEqual(healthRedIds({ models, profiles: [], breaker: { ok: true, targets }, now }), ['gpt-5.6-sol']);
  const later = Date.parse('2026-09-10T18:00:00Z');
  assert.deepEqual(healthRedIds({ models, profiles: [], breaker: { ok: true, targets }, now: later }), [], '冷却到点必须放行，否则熔断成了永久封禁');
});

test('熔断 closed 不算红（健康表清白的夹具，只验熔断这一层）', () => {
  const models = [{ id: 'gpt-5.6-sol', provider: 'gpt' }];
  const targets = { 'direct:codex@pqapi/responses': { state: 'closed' } };
  const clean = () => ({ availability: { 'gpt-5.6-sol': '空闲' } });
  assert.deepEqual(healthRedIds({ models, profiles: [], breaker: { ok: true, targets }, availabilityForFn: clean }), []);
});

test('探针 key 认不出来的模型不因熔断判红（不猜）', () => {
  const models = [{ id: 'mystery', provider: 'unknown-provider', cli_model: 'x/y' }];
  const targets = { 'gw:anything/whatever': { state: 'open', cooldownUntil: '2099-01-01T00:00:00Z' } };
  assert.deepEqual(healthRedIds({ models, profiles: [], breaker: { ok: true, targets } }), []);
});

test('健康表红（没落地的条目按探针判）→ 红', () => {
  const models = [profileOnly('probe-target')];
  const availabilityForFn = () => ({ availability: { 'probe-target': 'red' } });
  assert.deepEqual(healthRedIds({ models, profiles: [], breaker: null, availabilityForFn }), ['probe-target']);
});

test('健康表没查成（抛错）→ 不拦，绝不因判据自身故障冻结全盘', () => {
  const models = [profileOnly('probe-target')];
  const availabilityForFn = () => { throw new Error('健康表坏了'); };
  assert.deepEqual(healthRedIds({ models, profiles: [], breaker: null, availabilityForFn }), []);
});

test('空输入/坏输入不抛', () => {
  assert.deepEqual(healthRedIds({}), []);
  assert.deepEqual(healthRedIds({ models: [] }), []);
  assert.deepEqual(healthRedIds({ models: [routed('a')], profiles: null, breaker: null }), []);
});
