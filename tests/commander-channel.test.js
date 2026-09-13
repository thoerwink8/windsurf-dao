// tests/commander-channel.test.js —— 渠道并发闸接进指挥官决策层（#1145）。
// 钉：工人渠道满员/熔断 → 本轮排队不派；审官顺位分流到下一腿。纯夹具，不出网。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CORE = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'commander-core.mjs').replace(/\\/g, '/'));

// 落地齐全的 routing 模型记录（decide 靠它把 model → 渠道）。
const MODEL_RECORDS = [
  { id: 'grok-4.6', provider: 'gw', cli_model: 'gw/grok-4.6' },            // 渠道 gw:grok
  { id: 'deepseek-v4-flash', provider: 'gw', cli_model: 'gw-dspool/deepseek-v4-flash' }, // gw:dspool
  { id: 'gpt-5.6-luna', provider: 'gw', cli_model: 'gw-windsurf/gpt-5.6-luna' },        // gw:windsurf
  { id: 'gpt-5.6-sol', provider: 'gpt' },                                   // direct:codex@pqapi
];

function readyIssue(n, model) {
  return {
    number: n, title: `单 ${n}`, body: '',
    labels: [{ name: '已消歧' }, { name: `model/${model}` }, { name: 'reviewer/gpt-5.6-sol' }, { name: 'type/写码' }],
  };
}

function situation(over = {}) {
  return {
    at: '2026-09-08T12:00:00Z',
    github: { scanned: true, issues: [], prs: [] },
    orca: { scanned: true, worktrees: [] },
    trees: { scanned: true, worktrees: [] },
    reviewPending: { scanned: true, items: [] },
    prReviews: { scanned: true, byPr: {} },
    stall: { scanned: true, strikes: {} },
    wakeCounts: {},
    reworkDispatched: {},
    commanderPolicy: { requireModelInRouting: false },
    routingModels: ['grok-4.6', 'deepseek-v4-flash', 'gpt-5.6-luna', 'gpt-5.6-sol'],
    routingModelRecords: MODEL_RECORDS,
    reviewerOrder: ['gpt-5.6-luna', 'gpt-5.6-sol'],
    workerOrder: ['grok-4.6', 'deepseek-v4-flash'],
    healthRedModels: [],
    ...over,
  };
}
const dispatches = (r) => r.actions.filter((a) => a.kind === 'dispatch');

describe('指挥官：工人渠道上限（第一层）', () => {
  it('渠道未满 → 两张不同渠道的单都派得出', async () => {
    const { decide } = await CORE;
    const r = decide(situation({
      github: { scanned: true, issues: [readyIssue(901, 'grok-4.6'), readyIssue(902, 'deepseek-v4-flash')], prs: [] },
      channelCaps: { ok: true, caps: { 'gw:grok': 1, 'gw:dspool': 1 }, states: { 'gw:grok': 'capped', 'gw:dspool': 'capped' } },
      channelInFlight: { ok: true, counts: {} },
    }));
    assert.equal(dispatches(r).length, 2);
  });

  it('故意违规样本：某腿上限 1、连两张同渠道单 → 第二张排队不直起', async () => {
    const { decide } = await CORE;
    const r = decide(situation({
      github: { scanned: true, issues: [readyIssue(901, 'grok-4.6'), readyIssue(902, 'grok-4.6')], prs: [] },
      channelCaps: { ok: true, caps: { 'gw:grok': 1 }, states: { 'gw:grok': 'capped' } },
      channelInFlight: { ok: true, counts: {} },
    }));
    const ds = dispatches(r);
    assert.equal(ds.length, 1);                 // 只派了第一张
    assert.equal(ds[0].issue, 901);
    // 第二张进了渠道排队回流，不是 dispatch
    const queued = r.actions.find((a) => a.kind === 'notify-hub' && /渠道 gw:grok 已满员/.test(a.subject || ''));
    assert.ok(queued, '第二张应触发「渠道已满员，票留队列」回流');
  });

  it('渠道在途已达上限（快照就满）→ 该渠道单一张都不派', async () => {
    const { decide } = await CORE;
    const r = decide(situation({
      github: { scanned: true, issues: [readyIssue(901, 'grok-4.6')], prs: [] },
      channelCaps: { ok: true, caps: { 'gw:grok': 2 }, states: { 'gw:grok': 'capped' } },
      channelInFlight: { ok: true, counts: { 'gw:grok': 2 } }, // 已满
    }));
    assert.equal(dispatches(r).length, 0);
  });
});

describe('指挥官：熔断退避接进工人派单（第三层）', () => {
  it('渠道熔断 open 冷却中 → 该渠道单排队不派（冷却等同满员）', async () => {
    const { decide } = await CORE;
    const r = decide(situation({
      github: { scanned: true, issues: [readyIssue(901, 'grok-4.6')], prs: [] },
      channelCaps: { ok: true, caps: { 'gw:grok': 5 }, states: { 'gw:grok': 'capped' } },
      channelInFlight: { ok: true, counts: {} },
      breaker: {
        targets: {
          'gw:grok/grok-4.6': { state: 'open', cooldownUntil: '2026-09-08T20:00:00Z', trippedAt: '2026-09-08T12:00:00Z', failures: [] },
        },
      },
    }));
    assert.equal(dispatches(r).length, 0);
    const queued = r.actions.find((a) => a.kind === 'notify-hub' && /熔断冷却中/.test(a.subject || ''));
    assert.ok(queued, '熔断渠道应回流「冷却中，票留队列」');
  });
});

describe('指挥官：审官顺位分流（第二层）', () => {
  it('第 N+1 个同腿会话被拒 → 分流到顺位下一腿', async () => {
    const { chooseReviewerLeg } = await CORE;
    // 顺位 1 = luna（gw:windsurf，上限 1，已满）；顺位 2 = sol（pqapi，空）。
    const s = situation({
      channelCaps: { ok: true, caps: { 'gw:windsurf': 1, 'direct:codex@pqapi': 2 }, states: { 'gw:windsurf': 'capped', 'direct:codex@pqapi': 'capped' } },
      channelInFlight: { ok: true, counts: { 'gw:windsurf': 1 } },
    });
    const r = chooseReviewerLeg(s);
    assert.equal(r.ok, true);
    assert.equal(r.picked.model, 'gpt-5.6-sol');       // 分流到下一腿
    assert.equal(r.picked.channel, 'direct:codex@pqapi');
    assert.equal(r.spilledFrom[0].reason, 'at-cap');
  });

  it('顺位内全满 → 排队等下轮（不硬挤）', async () => {
    const { chooseReviewerLeg } = await CORE;
    const s = situation({
      channelCaps: { ok: true, caps: { 'gw:windsurf': 1, 'direct:codex@pqapi': 1 }, states: { 'gw:windsurf': 'capped', 'direct:codex@pqapi': 'capped' } },
      channelInFlight: { ok: true, counts: { 'gw:windsurf': 1, 'direct:codex@pqapi': 1 } },
    });
    const r = chooseReviewerLeg(s);
    assert.equal(r.ok, false);
    assert.equal(r.queued, true);
  });
});

describe('缺渠道快照 = 老夹具：闸 inert，不改既有派工路', () => {
  it('没有 channelCaps → 照常派，不受渠道限制', async () => {
    const { decide } = await CORE;
    const r = decide(situation({
      github: { scanned: true, issues: [readyIssue(901, 'grok-4.6'), readyIssue(902, 'grok-4.6')], prs: [] },
      // 不给 channelCaps / channelInFlight / breaker
    }));
    assert.equal(dispatches(r).length, 2); // 两张都派（无渠道闸）
  });
});
