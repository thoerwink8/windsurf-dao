// leg-choice：腿表选择的判别样本。判据顺序与淘汰可见性都是用户拍板的口径（#816），
// 每条样本只测一个行为；淘汰的候选必须留在列表里并带原因——静默消失就是回归。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MOD = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'leg-choice.mjs').replace(/\\/g, '/'));
const ROOT = path.join(__dirname, '..');

const profile = (over = {}) => ({
  id: 'leg-a', backend: 'acp', agent: 'agent-a', model: 'model-a', provider: 'prov-a', modelFamily: 'fam-a',
  accountPoolId: 'pool-a', roles: ['implementation'], enabled: true,
  availability: { status: 'available' },
  capabilities: { read: { status: 'verified' }, write: { status: 'verified' }, execute: { status: 'verified' } },
  pricing: { status: 'unknown' },
  ...over,
});

test('跨厂约束在候选生成阶段淘汰，淘汰项留在列表里带原因', async () => {
  const { chooseLeg } = await MOD;
  const result = chooseLeg({
    role: 'reviewer',
    excludeFamilies: ['fam-a'],
    profiles: [
      profile({ id: 'leg-a', roles: ['review'], modelFamily: 'fam-a' }),
      profile({ id: 'leg-b', roles: ['review'], modelFamily: 'fam-b' }),
    ],
  });
  assert.equal(result.recommended, 'leg-b');
  const eliminated = result.candidates.find(item => item.id === 'leg-a');
  assert.equal(eliminated.eliminated.code, 'family-excluded');
  assert.equal(eliminated.rank, null);
  assert.equal(result.candidates.length, 2, '淘汰的候选不许静默消失');
});

test('熔断 open 且冷却未到直接拦；half-open 只后置不淘汰', async () => {
  const { chooseLeg } = await MOD;
  const now = Date.parse('2026-09-18T00:00:00Z');
  const probeKeyOf = p => `native:${p.provider}`;
  const breaker = { targets: { 'native:prov-a': { state: 'open', cooldownUntil: '2026-09-18T01:00:00Z' } } };
  const result = chooseLeg({
    role: 'executor', now, breaker, probeKeyOf,
    profiles: [profile({ id: 'leg-open', provider: 'prov-a' }), profile({ id: 'leg-clean', provider: 'prov-b' })],
  });
  assert.equal(result.recommended, 'leg-clean');
  assert.equal(result.candidates.find(item => item.id === 'leg-open').eliminated.code, 'breaker-open');
  const halfOpen = chooseLeg({
    role: 'executor', now, probeKeyOf,
    breaker: { targets: { 'native:prov-a': { state: 'half-open' } } },
    profiles: [profile({ id: 'leg-half', provider: 'prov-a' }), profile({ id: 'leg-clean', provider: 'prov-b' })],
  });
  assert.equal(halfOpen.recommended, 'leg-clean', 'half-open 要排到 closed 后面');
  assert.equal(halfOpen.candidates.find(item => item.id === 'leg-half').eliminated, null, 'half-open 不是淘汰');
});

test('冷却已到期的 open 不再拦（时钟可比时按未到判）', async () => {
  const { chooseLeg } = await MOD;
  const now = Date.parse('2026-09-18T02:00:00Z');
  const result = chooseLeg({
    role: 'executor', now,
    breaker: { targets: { 'native:prov-a': { state: 'open', cooldownUntil: '2026-09-18T01:00:00Z' } } },
    profiles: [profile({ id: 'leg-a' })],
  });
  assert.equal(result.recommended, 'leg-a');
});

test('并发满员只后置不淘汰（背压是瞬时的，票留队列）', async () => {
  const { chooseLeg } = await MOD;
  const result = chooseLeg({
    role: 'executor',
    headroom: { 'leg-full': { inFlight: 2, cap: 2 }, 'leg-free': { inFlight: 0, cap: 2 } },
    profiles: [profile({ id: 'leg-full' }), profile({ id: 'leg-free' })],
  });
  assert.equal(result.recommended, 'leg-free');
  const full = result.candidates.find(item => item.id === 'leg-full');
  assert.equal(full.eliminated, null);
  assert.equal(full.rank, 2);
});

test('能力不足：角色不符与能力缺失分开报，且不入选', async () => {
  const { chooseLeg } = await MOD;
  const result = chooseLeg({
    role: 'reviewer',
    profiles: [
      profile({ id: 'leg-no-role', roles: ['implementation'], modelFamily: 'fam-a' }),
      profile({ id: 'leg-no-cap', roles: ['review'], modelFamily: 'fam-b', capabilities: { read: { status: 'unverified' } } }),
      profile({ id: 'leg-ok', roles: ['review-low-risk'], modelFamily: 'fam-c' }),
    ],
  });
  assert.equal(result.recommended, 'leg-ok');
  assert.equal(result.candidates.find(item => item.id === 'leg-no-role').eliminated.code, 'role-missing');
  assert.equal(result.candidates.find(item => item.id === 'leg-no-cap').eliminated.code, 'capability-missing');
});

test('目录角色强弱参与排序：review 优先于 review-low-risk', async () => {
  const { chooseLeg } = await MOD;
  const result = chooseLeg({
    role: 'reviewer',
    profiles: [profile({ id: 'leg-low', roles: ['review-low-risk'] }), profile({ id: 'leg-full', roles: ['review'] })],
  });
  assert.equal(result.recommended, 'leg-full');
});

test('能力验证强度参与排序：verified 优先于 declared', async () => {
  const { chooseLeg } = await MOD;
  const result = chooseLeg({
    role: 'executor',
    profiles: [
      profile({ id: 'leg-declared', capabilities: { read: { status: 'verified' }, write: { status: 'declared' }, execute: { status: 'declared' } } }),
      profile({ id: 'leg-verified' }),
    ],
  });
  assert.equal(result.recommended, 'leg-verified');
});

test('成本排序：订阅优先于按量、按量优先于未知', async () => {
  const { chooseLeg } = await MOD;
  const result = chooseLeg({
    role: 'executor',
    profiles: [
      profile({ id: 'leg-unknown', accountPoolId: 'mirasim-relay' }),
      profile({ id: 'leg-metered', accountPoolId: 'relay-pool', pricing: { status: 'known' } }),
      profile({ id: 'leg-sub', accountPoolId: 'cursor-subscription' }),
    ],
  });
  assert.deepEqual(result.candidates.filter(item => !item.eliminated).map(item => item.id), ['leg-sub', 'leg-metered', 'leg-unknown']);
});

test('历史成功率参与排序：高成功率优先，样本不足排已知之后', async () => {
  const { chooseLeg } = await MOD;
  const result = chooseLeg({
    role: 'executor',
    history: { 'leg-good': { done: 3, failed: 1 }, 'leg-bad': { done: 1, failed: 3 } },
    profiles: [profile({ id: 'leg-good' }), profile({ id: 'leg-bad' }), profile({ id: 'leg-nodata' })],
  });
  assert.deepEqual(result.candidates.filter(item => !item.eliminated).map(item => item.id), ['leg-good', 'leg-bad', 'leg-nodata']);
});

test('全部淘汰时 recommended 为 null，列表仍完整带原因', async () => {
  const { chooseLeg } = await MOD;
  const result = chooseLeg({
    role: 'executor',
    profiles: [profile({ id: 'leg-off', enabled: false }), profile({ id: 'leg-noav', availability: { status: 'unverified' } })],
  });
  assert.equal(result.recommended, null);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates.find(item => item.id === 'leg-off').eliminated.code, 'disabled');
  assert.equal(result.candidates.find(item => item.id === 'leg-noav').eliminated.code, 'availability-unverified');
});

test('未注入数据源时给出 note，不冒充查过', async () => {
  const { chooseLeg } = await MOD;
  const result = chooseLeg({ role: 'executor', profiles: [profile()] });
  assert.equal(result.notes.length, 4);
  assert.match(result.notes.join('\n'), /健康表没查成/);
  assert.match(result.notes.join('\n'), /熔断表缺失/);
});

test('renderLegTable 同时出现推荐与淘汰原因', async () => {
  const { chooseLeg, renderLegTable } = await MOD;
  const result = chooseLeg({
    role: 'reviewer',
    excludeFamilies: ['fam-a'],
    profiles: [profile({ id: 'leg-a', roles: ['review'], modelFamily: 'fam-a' }), profile({ id: 'leg-b', roles: ['review'], modelFamily: 'fam-b' })],
  });
  const text = renderLegTable(result);
  assert.match(text, /推荐：leg-b/);
  assert.match(text, /leg-a.*淘汰：同厂排除/);
});

test('loadLegChoiceData：执行记录算历史与在途，健康表缺失只出 note', async t => {
  const { loadLegChoiceData } = await MOD;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-leg-choice-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.dao', 'execution', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, record) => fs.writeFileSync(path.join(dir, name), JSON.stringify(record));
  write('a.json', { profileId: 'leg-a', state: 'stopped', observedState: 'done' });
  write('b.json', { profileId: 'leg-a', state: 'stopped', observedState: 'done' });
  write('c.json', { profileId: 'leg-a', state: 'rejected' });
  write('d.json', { profileId: 'leg-b', state: 'running' });
  const data = loadLegChoiceData({ home, root: ROOT });
  assert.ok(data.profiles.length >= 30, '执行目录要能读出来');
  assert.deepEqual(data.history['leg-a'], { done: 2, failed: 1 });
  assert.deepEqual(data.headroom['leg-b'], { inFlight: 1, cap: null });
  assert.equal(data.health, null);
  assert.match(data.notes.join('\n'), /健康表/);
});
