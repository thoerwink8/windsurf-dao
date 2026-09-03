// 派前探接线：工人（launch）/ 审官（reviewer）红换下一位、全红报帅、--no-preflight 记账（#842）
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LAUNCH = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'dispatch', 'launch.mjs').replace(/\\/g, '/');
const REVIEWER = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'dispatch', 'reviewer.mjs').replace(/\\/g, '/');
const PREFLIGHT = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'preflight.mjs').replace(/\\/g, '/');

const POLICY = { enabled: true, timeoutMs: 1000, maxCandidates: 4, useHealthTable: false };

// slate 三位：A B C，各带落地
const SLATE = [
  { id: 'A', pipes: [{ provider: 'gw', cli_model: 'gw-dspool/A' }] },
  { id: 'B', pipes: [{ provider: 'gw', cli_model: 'gw-gptpool/B' }] },
  { id: 'C', pipes: [{ provider: 'gpt', cli_model: 'gpt-5.6-sol' }] },
];

// 造一个按 id 给状态的探针 + 记账收集器
function fakeProbe(byId) {
  return async (landing) => {
    const id = String(landing.cli_model || '').split('/').pop();
    const key = byId[id] || byId[landing.provider] || 'green';
    return { state: key, code: key === 'red' ? 403 : (key === 'green' ? 200 : null), ms: 1, why: key, target: `t:${id}` };
  };
}

describe('preflightWorkerSlate（工人）', () => {
  it('第一位红 → 自动换到下一位（绿）', async () => {
    const { preflightWorkerSlate } = await import(LAUNCH);
    const audits = [];
    const r = await preflightWorkerSlate({
      slate: SLATE, startIndex: 0, policy: POLICY, probe: fakeProbe({ A: 'red', B: 'green', C: 'green' }),
      // 注入 audit：用 runPreflight 的 audit 通道需从 preflight.mjs 走，这里用真 append 会写盘；
      // 改为断言 probed 序列即可（launch 包装不暴露 audit 注入，改由 runPreflight 直测记账）
    });
    assert.equal(r.stop, false);
    assert.equal(r.chosen, 'B');
    assert.equal(r.startIndex, 1);
    assert.ok(r.probed.find(p => p.model === 'A' && p.state === 'red'));
  });

  it('全红 → stop 报帅停手，chosen 为空，report 列出探了谁', async () => {
    const { preflightWorkerSlate } = await import(LAUNCH);
    const r = await preflightWorkerSlate({
      slate: SLATE, startIndex: 0, policy: POLICY,
      probe: async () => ({ state: 'red', code: 403, ms: 1, why: '假 token', target: 't' }),
    });
    assert.equal(r.stop, true);
    assert.equal(r.chosen, null);
    assert.match(r.report, /停手报帅|一个 agent 都不起/);
    assert.equal(r.probed.length, 3);
  });

  it('未启用 → 透传第一位，不探', async () => {
    const { preflightWorkerSlate } = await import(LAUNCH);
    let probed = false;
    const r = await preflightWorkerSlate({
      slate: SLATE, startIndex: 0, policy: { ...POLICY, enabled: false }, probe: async () => { probed = true; return { state: 'green' }; },
    });
    assert.equal(r.skipped, true);
    assert.equal(r.chosen, 'A');
    assert.equal(probed, false);
  });
});

describe('runPreflight 记账（--no-preflight / 逐位）', () => {
  it('--no-preflight → 选第一位 + 记一条 skipped', async () => {
    const { runPreflight } = await import(PREFLIGHT);
    const audits = [];
    const r = await runPreflight({
      candidates: SLATE, policy: POLICY, noPreflight: true, role: '工人', dispatchId: 'd1',
      audit: (rec) => audits.push(rec), probe: fakeProbe({}),
    });
    assert.equal(r.skipped, true);
    assert.equal(r.chosen, 'A');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].state, 'skipped');
    assert.equal(audits[0].dispatchId, 'd1');
  });

  it('逐位探每次记一条账（红/绿都记）', async () => {
    const { runPreflight } = await import(PREFLIGHT);
    const audits = [];
    const r = await runPreflight({
      candidates: SLATE, policy: POLICY, role: '工人', dispatchId: 'd2',
      audit: (rec) => audits.push(rec), probe: fakeProbe({ A: 'red', B: 'green' }),
    });
    assert.equal(r.chosen, 'B');
    assert.equal(audits.length, 2); // A red + B green
    assert.deepEqual(audits.map(a => a.state), ['red', 'green']);
  });

  it('熔断 open 直接拦，不计入探针', async () => {
    const { runPreflight } = await import(PREFLIGHT);
    const audits = [];
    const availabilityResult = { availability: { A: 'cooldown(until X)' }, hardBlocked: { A: 'cooldown(until X)' }, deprioritize: new Set(), reasons: {}, notes: [] };
    const r = await runPreflight({
      candidates: SLATE, policy: POLICY, role: '工人', availabilityResult,
      audit: (rec) => audits.push(rec), probe: fakeProbe({ B: 'green' }),
    });
    assert.ok(r.hardBlocked.find(h => h.id === 'A'));
    assert.equal(r.chosen, 'B');
    assert.ok(!audits.find(a => a.model === 'A')); // A 没被探
  });
});

describe('preflightReviewer（审官）', () => {
  const MODELS = [
    { id: 'gpt-5.6-sol', provider: 'gpt', cli_model: 'gpt-5.6-sol' },
    { id: 'grok-4.6', provider: 'grok', cli_model: 'grok-4.6' },
    { id: 'kimi-k3', provider: 'cursor', cli_model: 'kimi-k3-high' },
  ];
  const ORDER = ['gpt-5.6-sol', 'kimi-k3', 'grok-4.6'];

  it('审官第一位红 → 换下一位；同厂闸剔除工人那一厂', async () => {
    const { preflightReviewer } = await import(REVIEWER);
    // 工人是 cursor 厂（kimi），同厂 kimi 应被剔除；gpt 红 → 换 grok
    const r = await preflightReviewer({
      order: ORDER, models: MODELS, workerId: 'kimi-k3', policy: POLICY,
      probe: async (l) => ({ state: l.provider === 'gpt' ? 'red' : 'green', code: l.provider === 'gpt' ? 503 : 200, ms: 1, why: 'x', target: 't' }),
    });
    assert.equal(r.stop, false);
    assert.equal(r.chosen, 'grok-4.6');
    assert.equal(r.switched, true);
    // kimi 同厂被剔，不应出现在探测里
    assert.ok(!r.probed.find(p => p.model === 'kimi-k3'));
  });

  it('审官全红 → stop 报帅', async () => {
    const { preflightReviewer } = await import(REVIEWER);
    const r = await preflightReviewer({
      order: ORDER, models: MODELS, workerId: 'devin-x', policy: POLICY,
      probe: async () => ({ state: 'red', code: 502, ms: 1, why: 'x', target: 't' }),
    });
    assert.equal(r.stop, true);
    assert.equal(r.chosen, null);
    assert.match(r.report, /停手报帅|一个 agent 都不起/);
  });
});
