// tests/reviewer-channel.test.js —— 审官侧渠道并发剔除接进 preflightReviewer（#1145）。
// 运行时级：钉顺位第一腿满员→剔除→选下一腿；缺快照→行为与改动前完全一致（inert）；全满→排队非报帅。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REVIEWER = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'dispatch', 'reviewer.mjs').replace(/\\/g, '/');
const POLICY = { enabled: true, timeoutMs: 1000, maxCandidates: 4, useHealthTable: false };

// 顺位两腿，不同渠道：luna(gw:windsurf) → sol(pqapi)。workerId=null 关同厂闸，隔离测渠道层。
const MODELS = [
  { id: 'gpt-5.6-luna', provider: 'gw', cli_model: 'gw-windsurf/gpt-5.6-luna' }, // gw:windsurf
  { id: 'gpt-5.6-sol', provider: 'gpt', cli_model: 'gpt-5.6-sol' },              // direct:codex@pqapi
];
const ORDER = ['gpt-5.6-luna', 'gpt-5.6-sol'];
const allGreen = async () => ({ state: 'green', code: 200, ms: 1, why: 'x', target: 't' });

describe('preflightReviewer：渠道满员剔除（#1145 审官侧运行时闭环）', () => {
  it('顺位第一腿在途满员 → 剔除它 → 选中顺位下一腿', async () => {
    const { preflightReviewer } = await import(REVIEWER);
    const r = await preflightReviewer({
      order: ORDER, models: MODELS, workerId: null, policy: POLICY, probe: allGreen,
      channelCaps: { caps: { 'gw:windsurf': 1, 'direct:codex@pqapi': 2 }, states: { 'gw:windsurf': 'capped', 'direct:codex@pqapi': 'capped' } },
      channelInFlight: { counts: { 'gw:windsurf': 1 } }, // luna 渠道已满
    });
    assert.equal(r.stop, false);
    assert.equal(r.chosen, 'gpt-5.6-sol');   // 分流到下一腿
    assert.ok(r.notes.some(n => /渠道满员，剔除 gpt-5\.6-luna/.test(n)), '应有剔除记录进 notes');
    // 满员的 luna 不该进探测
    assert.ok(!r.probed.find(p => p.model === 'gpt-5.6-luna'));
  });

  it('缺快照 → inert：行为与改动前完全一致（选顺位第一腿）', async () => {
    const { preflightReviewer } = await import(REVIEWER);
    const r = await preflightReviewer({
      order: ORDER, models: MODELS, workerId: null, policy: POLICY, probe: allGreen,
      // 不传 channelCaps / channelInFlight
    });
    assert.equal(r.stop, false);
    assert.equal(r.chosen, 'gpt-5.6-luna'); // 顺位第一腿，未被剔
    assert.ok(!r.notes.some(n => /渠道满员/.test(n)));
  });

  it('顺位内所有腿渠道都满 → 排队等下轮（queued），不报帅停手', async () => {
    const { preflightReviewer } = await import(REVIEWER);
    const r = await preflightReviewer({
      order: ORDER, models: MODELS, workerId: null, policy: POLICY, probe: allGreen,
      channelCaps: { caps: { 'gw:windsurf': 1, 'direct:codex@pqapi': 1 }, states: { 'gw:windsurf': 'capped', 'direct:codex@pqapi': 'capped' } },
      channelInFlight: { counts: { 'gw:windsurf': 1, 'direct:codex@pqapi': 1 } },
    });
    assert.equal(r.queued, true);
    assert.equal(r.stop, false);   // 关键：渠道都满 ≠ 同厂全剔，不报帅
    assert.equal(r.chosen, null);
    assert.match(r.report, /排队等下轮/);
  });

  it('本轮 429 排除集：同渠道当轮被剔，分流到下一腿', async () => {
    const { preflightReviewer } = await import(REVIEWER);
    const r = await preflightReviewer({
      order: ORDER, models: MODELS, workerId: null, policy: POLICY, probe: allGreen,
      channelCaps: { caps: { 'gw:windsurf': 5, 'direct:codex@pqapi': 5 }, states: {} },
      channelInFlight: { counts: {} },
      channelExcluded: new Set(['gw:windsurf']),
    });
    assert.equal(r.chosen, 'gpt-5.6-sol');
  });

  it('同厂全剔仍是真无候选（stop 报帅），不被渠道层改判', async () => {
    const { preflightReviewer } = await import(REVIEWER);
    // workerId 与两腿同厂（都判 same_vendor）→ vendorFiltered 空 → stop:true，先于渠道层返回
    const r = await preflightReviewer({
      order: ORDER, models: MODELS, workerId: 'gpt-5.6-sol', policy: POLICY, probe: allGreen,
      channelCaps: { caps: { 'gw:windsurf': 1 }, states: {} },
      channelInFlight: { counts: { 'gw:windsurf': 1 } },
    });
    assert.equal(r.stop, true);
    assert.equal(r.queued, undefined); // 不是渠道排队
  });
});
