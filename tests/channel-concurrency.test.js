// tests/channel-concurrency.test.js —— 渠道并发三件套（#1145）纯函数夹具，不出网/不 spawn/不读真 /proc。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const toUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const CC = import(toUrl(path.join(REPO, 'scripts', 'lib', 'channel-concurrency.mjs')));

const L = (provider, cli_model) => ({ provider, cli_model });
const GROK = L('gw', 'gw/grok-4.6');           // 渠道 gw:grok
const DEEPSEEK = L('gw', 'gw-dspool/deepseek-v4-flash'); // 渠道 gw:dspool
const GLM = L('gw', 'gw-windsurf/glm-5-2');    // 渠道 gw:windsurf
const CODEX = L('gpt');                          // 渠道 direct:codex@pqapi

// 顺位候选表：模型 id → 落地。
const LANDINGS = {
  'grok-4.6': GROK,
  'deepseek-v4-flash': DEEPSEEK,
  'glm-5.2': GLM,
  'gpt-5.6-sol': CODEX,
};
const landingOf = (id) => LANDINGS[id] || null;

describe('channelKeyOf / legChannelKey —— 渠道键取自 target 池级前缀', () => {
  it('gw 各池按组短名分渠道', async () => {
    const { channelKeyOf } = await CC;
    assert.equal(channelKeyOf(GROK), 'gw:grok');
    assert.equal(channelKeyOf(DEEPSEEK), 'gw:dspool');
    assert.equal(channelKeyOf(GLM), 'gw:windsurf');
  });
  it('codex 直连归 pqapi 渠道', async () => {
    const { channelKeyOf } = await CC;
    assert.equal(channelKeyOf(CODEX), 'direct:codex@pqapi');
  });
  it('claude 族归 mirasim 中继渠道', async () => {
    const { channelKeyOf } = await CC;
    assert.equal(channelKeyOf(L('claude', 'opus')), 'mirasim');
  });
  it('认不出的落地返回 null（fail-close 由调用方处理）', async () => {
    const { channelKeyOf } = await CC;
    assert.equal(channelKeyOf(L('cursor', 'x')), null);
    assert.equal(channelKeyOf(null), null);
  });
  it('mirasim 载体腿按供应商/执行侧判', async () => {
    const { legChannelKey } = await CC;
    assert.equal(legChannelKey({ 供应商: 'mirasim', 执行侧: 'mirasim', 落地: L('claude', 'opus') }), 'mirasim');
    assert.equal(legChannelKey({ 供应商: 'gw', 落地: GROK }), 'gw:grok');
  });
});

describe('resolveLegCap —— 不限 / 待填 / 有限三态分得开', () => {
  it('正整数 = 有限上限', async () => {
    const { resolveLegCap } = await CC;
    assert.deepEqual(resolveLegCap(5), { cap: 5, state: 'capped' });
    assert.deepEqual(resolveLegCap(2), { cap: 2, state: 'capped' });
  });
  it('不限 = Infinity/unlimited（与待填区分：一个已验证放开）', async () => {
    const { resolveLegCap, CAP_UNLIMITED } = await CC;
    assert.deepEqual(resolveLegCap(CAP_UNLIMITED), { cap: Infinity, state: 'unlimited' });
    assert.deepEqual(resolveLegCap(Infinity), { cap: Infinity, state: 'unlimited' });
  });
  it('null / 缺字段 = 待填（可空=待填，不是红）', async () => {
    const { resolveLegCap } = await CC;
    assert.deepEqual(resolveLegCap(null), { cap: Infinity, state: 'pending' });
    assert.deepEqual(resolveLegCap(undefined), { cap: Infinity, state: 'pending' });
  });
  it('脏值（0/负/杂串）当待填并标 bad', async () => {
    const { resolveLegCap } = await CC;
    assert.equal(resolveLegCap(0).bad, true);
    assert.equal(resolveLegCap(-3).bad, true);
    assert.equal(resolveLegCap('abc').bad, true);
  });
});

describe('buildChannelCaps —— 从腿表建渠道容量表', () => {
  const legs = [
    { id: 'grok-4.6@gw/orca', 状态: '在役', 供应商: 'gw', 落地: GROK, 并发上限: '不限' },
    { id: 'gpt-5.6-sol@pqapi/orca', 状态: '在役', 供应商: 'pqapi', 落地: CODEX, 并发上限: 2 },
    { id: 'claude-opus-5@mirasim/mirasim', 状态: '在役', 供应商: 'mirasim', 执行侧: 'mirasim', 落地: L('claude', 'opus'), 并发上限: 5 },
    { id: 'kimi-k3@gw/orca', 状态: '在役', 供应商: 'gw', 落地: L('gw', 'gw-sub/kimi-k3-high') }, // 待填
    { id: 'dead@x', 状态: '停用', 供应商: 'gw', 落地: DEEPSEEK, 并发上限: 1 }, // 停用不占
  ];
  it('有限上限进 caps，pqapi=2 / mirasim=5', async () => {
    const { buildChannelCaps } = await CC;
    const r = buildChannelCaps(legs);
    assert.equal(r.ok, true);
    assert.equal(r.caps['direct:codex@pqapi'], 2);
    assert.equal(r.caps['mirasim'], 5);
  });
  it('不限渠道 cap=Infinity、state=unlimited', async () => {
    const { buildChannelCaps } = await CC;
    const r = buildChannelCaps(legs);
    assert.equal(r.caps['gw:grok'], Infinity);
    assert.equal(r.states['gw:grok'], 'unlimited');
  });
  it('待填渠道进 pending 列表（可空=待填，不红）', async () => {
    const { buildChannelCaps } = await CC;
    const r = buildChannelCaps(legs);
    assert.deepEqual(r.pending, ['gw:sub']);
  });
  it('停用腿不进容量表', async () => {
    const { buildChannelCaps } = await CC;
    const r = buildChannelCaps(legs);
    // 停用的 dead@x 是 gw:dspool，上限 1，但停用不占——dspool 不该出现
    assert.equal(r.caps['gw:dspool'], undefined);
  });
  it('腿节不是数组 = 没查成（fail-close）', async () => {
    const { buildChannelCaps } = await CC;
    const r = buildChannelCaps(null);
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
  });
});

describe('countInFlightByChannel —— 在途按渠道计数（与租约闸同源）', () => {
  it('多棵树按渠道归并计数', async () => {
    const { countInFlightByChannel } = await CC;
    const trees = ['/w/dao-1', '/w/dao-2', '/w/dao-3'];
    const map = { '/w/dao-1': 'gw:grok', '/w/dao-2': 'gw:grok', '/w/dao-3': 'direct:codex@pqapi' };
    const r = countInFlightByChannel(trees, (t) => map[t] || null);
    assert.equal(r.ok, true);
    assert.deepEqual(r.counts, { 'gw:grok': 2, 'direct:codex@pqapi': 1 });
    assert.deepEqual(r.unattributed, []);
  });
  it('解不出渠道的树进 unattributed，不硬塞', async () => {
    const { countInFlightByChannel } = await CC;
    const r = countInFlightByChannel(['/w/a', '/w/b'], (t) => (t === '/w/a' ? 'gw:grok' : null));
    assert.deepEqual(r.counts, { 'gw:grok': 1 });
    assert.deepEqual(r.unattributed, ['/w/b']);
  });
  it('在途树不是数组 = 没查成', async () => {
    const { countInFlightByChannel } = await CC;
    assert.equal(countInFlightByChannel(null, () => null).unscanned, true);
  });
});

describe('pickLeg —— 上限 + 顺位分流（第一层 + 第二层）', () => {
  it('渠道未满 → 选顺位第一条', async () => {
    const { pickLeg } = await CC;
    const r = pickLeg({
      order: ['grok-4.6', 'deepseek-v4-flash'],
      landingOf,
      caps: { 'gw:grok': 5 },
      inFlight: { 'gw:grok': 0 },
    });
    assert.equal(r.ok, true);
    assert.equal(r.picked.model, 'grok-4.6');
    assert.equal(r.picked.channel, 'gw:grok');
  });

  it('顺位第一条满员 → 分流到顺位下一条（第 N+1 个同腿被拒）', async () => {
    const { pickLeg } = await CC;
    const r = pickLeg({
      order: ['grok-4.6', 'deepseek-v4-flash'],
      landingOf,
      caps: { 'gw:grok': 1, 'gw:dspool': 3 },
      inFlight: { 'gw:grok': 1 }, // grok 已满
    });
    assert.equal(r.ok, true);
    assert.equal(r.picked.model, 'deepseek-v4-flash');   // 分流到下一腿
    assert.equal(r.picked.channel, 'gw:dspool');
    assert.equal(r.spilledFrom.length, 1);
    assert.equal(r.spilledFrom[0].reason, 'at-cap');
  });

  it('都满 → 票留队列等下轮（不硬挤）', async () => {
    const { pickLeg } = await CC;
    const r = pickLeg({
      order: ['grok-4.6', 'deepseek-v4-flash'],
      landingOf,
      caps: { 'gw:grok': 1, 'gw:dspool': 1 },
      inFlight: { 'gw:grok': 1, 'gw:dspool': 1 },
    });
    assert.equal(r.ok, false);
    assert.equal(r.queued, true);
    assert.equal(r.tried.length, 2);
  });
});

describe('故意违规样本：某腿上限设 1、连派 2 张（本仓硬要求）', () => {
  it('第二张必须分流或排队，不许直起同腿', async () => {
    const { pickLeg, takeChannelSlot } = await CC;
    const caps = { 'gw:grok': 1, 'gw:dspool': 2 };
    let inFlight = { 'gw:grok': 0 };
    const order = ['grok-4.6', 'deepseek-v4-flash'];

    // 第 1 张：起在 grok
    const first = pickLeg({ order, landingOf, caps, inFlight });
    assert.equal(first.picked.channel, 'gw:grok');
    inFlight = takeChannelSlot(inFlight, first.picked.channel); // 领名额

    // 第 2 张：grok 已满（1/1）——绝不能又落 grok
    const second = pickLeg({ order, landingOf, caps, inFlight });
    assert.notEqual(second.picked && second.picked.channel, 'gw:grok');
    assert.equal(second.picked.channel, 'gw:dspool'); // 分流
  });

  it('顺位里只有那一条满员的腿 → 第二张排队，绝不直起', async () => {
    const { pickLeg, takeChannelSlot } = await CC;
    const caps = { 'gw:grok': 1 };
    let inFlight = { 'gw:grok': 0 };
    const order = ['grok-4.6']; // 顺位里只有 grok

    const first = pickLeg({ order, landingOf, caps, inFlight });
    assert.equal(first.ok, true);
    inFlight = takeChannelSlot(inFlight, first.picked.channel);

    const second = pickLeg({ order, landingOf, caps, inFlight });
    assert.equal(second.ok, false);      // 不直起
    assert.equal(second.queued, true);   // 排队等下轮
  });
});

describe('熔断退避（第三层）：429/at-capacity 死后同腿本轮不再被选中', () => {
  const NOW = Date.parse('2026-09-08T12:00:00Z');

  it('breaker open 的渠道等同满员，分流到下一腿', async () => {
    const { pickLeg } = await CC;
    // grok 对应 target gw:grok/grok-4.6 处于 open 且冷却未到。
    const breaker = {
      targets: {
        'gw:grok/grok-4.6': {
          state: 'open',
          cooldownUntil: '2026-09-08T20:00:00Z',
          trippedAt: '2026-09-08T12:00:00Z',
          failures: [],
        },
      },
    };
    const r = pickLeg({
      order: ['grok-4.6', 'deepseek-v4-flash'],
      landingOf,
      caps: { 'gw:grok': 5, 'gw:dspool': 5 },
      inFlight: {},
      breaker,
      now: NOW,
    });
    assert.equal(r.ok, true);
    assert.equal(r.picked.model, 'deepseek-v4-flash');
    assert.equal(r.spilledFrom[0].reason, 'breaker-open');
  });

  it('本轮 429 排除集：同渠道当轮不再被选中', async () => {
    const { pickLeg } = await CC;
    const r = pickLeg({
      order: ['grok-4.6', 'deepseek-v4-flash'],
      landingOf,
      caps: { 'gw:grok': 5, 'gw:dspool': 5 },
      inFlight: {},
      excluded: new Set(['gw:grok']), // grok 本轮 429 过
    });
    assert.equal(r.picked.model, 'deepseek-v4-flash');
    assert.equal(r.spilledFrom[0].reason, 'excluded-429');
  });

  it('planBackoff：首次 2 轮，逐次翻倍封顶 8 轮', async () => {
    const { planBackoff } = await CC;
    const roundMs = 20 * 60 * 1000;
    assert.equal(planBackoff(null, { roundMs }).rounds, 2);            // 首次
    // 上次冷却 2 轮 → 这次 4
    const t2 = { trippedAt: '2026-09-08T00:00:00Z', cooldownUntil: new Date(Date.parse('2026-09-08T00:00:00Z') + 2 * roundMs).toISOString() };
    assert.equal(planBackoff(t2, { roundMs }).rounds, 4);
    // 上次 4 轮 → 8
    const t4 = { trippedAt: '2026-09-08T00:00:00Z', cooldownUntil: new Date(Date.parse('2026-09-08T00:00:00Z') + 4 * roundMs).toISOString() };
    assert.equal(planBackoff(t4, { roundMs }).rounds, 8);
    // 上次 8 轮 → 封顶仍 8
    const t8 = { trippedAt: '2026-09-08T00:00:00Z', cooldownUntil: new Date(Date.parse('2026-09-08T00:00:00Z') + 8 * roundMs).toISOString() };
    assert.equal(planBackoff(t8, { roundMs }).rounds, 8);
  });
});

describe('legAvailability —— fail-close 边界', () => {
  it('认不出渠道 = 不可用（fail-close）', async () => {
    const { legAvailability } = await CC;
    const r = legAvailability(L('cursor', 'x'), {});
    assert.equal(r.available, false);
    assert.equal(r.reason, 'no-channel');
  });
  it('待填渠道可用但带 pending 标记', async () => {
    const { legAvailability } = await CC;
    const r = legAvailability(GLM, { caps: { 'gw:windsurf': Infinity }, states: { 'gw:windsurf': 'pending' } });
    assert.equal(r.available, true);
    assert.equal(r.pending, true);
  });
});
