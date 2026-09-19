// leg-expiry：探针的选择逻辑（确定性部分）。真探会话依赖机器，不在单测里跑。
// 判据：在役腿必探；池已声明过期但没探过的腿要探（否则到期没人发现）；探过的就不重复烧额度。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = import('file://' + path.resolve(__dirname, '..', 'scripts', 'leg-expiry.mjs').replace(/\\/g, '/'));

const profiles = [
  { id: 'enabled-leg', enabled: true, accountPoolId: 'pool-a', agent: 'pi', model: 'm' },
  { id: 'disabled-declared-unprobed', enabled: false, accountPoolId: 'pool-expiring', agent: 'pi', model: 'm' },
  { id: 'disabled-declared-probed', enabled: false, accountPoolId: 'pool-expiring', agent: 'pi', model: 'm' },
  { id: 'disabled-quiet', enabled: false, accountPoolId: 'pool-quiet', agent: 'pi', model: 'm' },
];
const pools = [
  { id: 'pool-expiring', lifecycle: { declaredUntil: '2026-09-20' } },
  { id: 'pool-quiet' },
];

test('在役腿必探；已声明过期的池里没探过的腿要探；探过的不重复烧额度', async () => {
  const { targets } = await MOD;
  const state = { legs: { 'disabled-declared-probed': { probedAt: '2026-09-19T00:00:00Z', lastState: 'failed' } } };
  const picked = targets(profiles, pools, state).map(t => t.id);
  assert.deepEqual(picked.includes('enabled-leg'), true, '在役腿要探');
  assert.deepEqual(picked.includes('disabled-declared-unprobed'), true, '声明过期的池里没探过的腿要探');
  assert.deepEqual(picked.includes('disabled-declared-probed'), false, '探过的不重复探');
  assert.deepEqual(picked.includes('disabled-quiet'), false, '既不在役、池也没声明过期的腿不探（省额度）');
});

test('探针目标带池与 agent/model（起会话要用）', async () => {
  const { targets } = await MOD;
  const first = targets(profiles, pools, { legs: {} })[0];
  assert.equal(first.id, 'enabled-leg');
  assert.equal(first.pool, 'pool-a');
  assert.equal(first.agent, 'pi');
});
