// tests/channel-concurrency.test.js —— 渠道并发三件套（#1145）纯函数夹具，不出网/不 spawn/不读真 /proc。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

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
  it('null / 缺字段 = 待填 ⇒ 保守上限收紧，**不是** Infinity 放行', async () => {
    const { resolveLegCap, CONSERVATIVE_CAP } = await CC;
    // 故意违规样本的另一面：待填若按 Infinity 放行，闸对 429 真正出事的那几条渠道等于不设防。
    assert.deepEqual(resolveLegCap(null), { cap: CONSERVATIVE_CAP, state: 'pending' });
    assert.deepEqual(resolveLegCap(undefined), { cap: CONSERVATIVE_CAP, state: 'pending' });
    assert.notEqual(resolveLegCap(null).cap, Infinity);
    assert.equal(Number.isFinite(resolveLegCap(null).cap), true);
  });
  it('保守上限取 3（issue 实测「Codex 容量 3-4」的下界）', async () => {
    const { CONSERVATIVE_CAP } = await CC;
    assert.equal(CONSERVATIVE_CAP, 3);
  });
  it('脏值（0/负/杂串）当待填并标 bad', async () => {
    const { resolveLegCap, CONSERVATIVE_CAP } = await CC;
    assert.equal(resolveLegCap(0).bad, true);
    assert.equal(resolveLegCap(-3).bad, true);
    assert.equal(resolveLegCap('abc').bad, true);
    assert.equal(resolveLegCap(0).cap, CONSERVATIVE_CAP); // 脏值也收紧，不放行
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
  it('待填渠道进 pending 列表（可空=待填，不红），且 cap 是保守值不是 Infinity', async () => {
    const { buildChannelCaps, CONSERVATIVE_CAP } = await CC;
    const r = buildChannelCaps(legs);
    assert.deepEqual(r.pending, ['gw:sub']);
    assert.equal(r.caps['gw:sub'], CONSERVATIVE_CAP);
    assert.equal(r.states['gw:sub'], 'pending');
  });
  it('同渠道「显式不限」压过「待填」——用缺失覆盖已验证结论是错的', async () => {
    const { buildChannelCaps } = await CC;
    const r = buildChannelCaps([
      { id: 'a', 状态: '在役', 供应商: 'gw', 落地: GROK, 并发上限: '不限' },
      { id: 'b', 状态: '在役', 供应商: 'gw', 落地: GROK },  // 同渠道 gw:grok，待填
    ]);
    assert.equal(r.caps['gw:grok'], Infinity);
    assert.equal(r.states['gw:grok'], 'unlimited');
  });
  it('同渠道多条显式有限值取最严（min）', async () => {
    const { buildChannelCaps } = await CC;
    const r = buildChannelCaps([
      { id: 'a', 状态: '在役', 供应商: 'gw', 落地: GROK, 并发上限: 7 },
      { id: 'b', 状态: '在役', 供应商: 'gw', 落地: GROK, 并发上限: 2 },
    ]);
    assert.equal(r.caps['gw:grok'], 2);
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

// 2026-09-14 断链：渠道在途数的分子取不到，闸永远判不出满。
//
// 实咬：在途树 `dao-review-pr-1232` 在 861 条未结 job.dispatch 里一条都对不上
// （modelOfTree 是从**分支名**抠号再回账本查，而这棵树的号不在未结账里），
// 于是 channelInFlight.counts 恒为 {}，`n >= cap` 永远不成立——一道判不出满的闸等于没有闸。
// 会话登记本来就有 cwd+model（323/323 条都有），只是那份名单没往外带。
const LEGS = [
  { id: 'grok@x', 状态: '在役', 模型: 'grok-4.6', 供应商: 'gw', 落地: GROK, 并发上限: '不限' },
  { id: 'glm@x', 状态: '在役', 模型: 'glm-5.2', 供应商: 'gw', 落地: GLM, 并发上限: 6 },
];
const sess = (cwd, model, at, extra = {}) => ({ cwd, model, lastActivityAt: at, state: 'running', ...extra });

describe('modelOfTreeFromSessions —— 树→模型走会话名单（精确 join，不猜分支名）', () => {
  it('cwd 对上就取该条的 model', async () => {
    const { modelOfTreeFromSessions } = await CC;
    assert.equal(modelOfTreeFromSessions('/w/a', [sess('/w/a', 'grok-4.6', 1)]), 'grok-4.6');
  });

  it('尾斜杠不算差别（两边都归一化）', async () => {
    const { modelOfTreeFromSessions } = await CC;
    assert.equal(modelOfTreeFromSessions('/w/a/', [sess('/w/a', 'grok-4.6', 1)]), 'grok-4.6');
    assert.equal(modelOfTreeFromSessions('/w/a', [sess('/w/a//', 'grok-4.6', 1)]), 'grok-4.6');
  });

  it('同一棵树多条仍占树的记录 → 取 lastActivityAt 最新的', async () => {
    const { modelOfTreeFromSessions } = await CC;
    const list = [sess('/w/a', 'grok-4.6', 100), sess('/w/a', 'glm-5.2', 900), sess('/w/a', 'gpt-5.6-sol', 500)];
    assert.equal(modelOfTreeFromSessions('/w/a', list), 'glm-5.2');
  });

  it('终态记录时间更新也不能盖住当前 running（审官复现）', async () => {
    const { modelOfTreeFromSessions } = await CC;
    const list = [
      sess('/w/a', 'grok-4.6', 200, { state: 'done' }),
      sess('/w/a', 'glm-5.2', 100, { state: 'running' }),
    ];
    assert.equal(modelOfTreeFromSessions('/w/a', list), 'glm-5.2');
  });

  it('只有终态历史记录 → null，不猜此刻在跑什么', async () => {
    const { modelOfTreeFromSessions } = await CC;
    const list = [
      sess('/w/a', 'grok-4.6', 200, { state: 'done' }),
      sess('/w/a', 'glm-5.2', 100, { state: 'stopped', cleanupVerified: true }),
    ];
    assert.equal(modelOfTreeFromSessions('/w/a', list), null);
  });

  it('读不出状态 / 收尾已核过 → 不算占树', async () => {
    const { modelOfTreeFromSessions } = await CC;
    assert.equal(modelOfTreeFromSessions('/w/a', [{ cwd: '/w/a', model: 'grok-4.6', lastActivityAt: 9 }]), null,
      '没有 state 不是可证明的当前记录');
    assert.equal(modelOfTreeFromSessions('/w/a', [
      sess('/w/a', 'grok-4.6', 9, { state: 'running', cleanupVerified: true }),
    ]), null, 'cleanupVerified 已核过 = 树已释放');
    assert.equal(modelOfTreeFromSessions('/w/a', [
      sess('/w/a', 'glm-5.2', 1, { state: 'stopping' }),
    ]), 'glm-5.2', '预留态仍可能占树');
  });

  it('模型 id 上的执行修饰要剥掉——不剥就查不到腿（实测见过 composer-2.5[fast=true]）', async () => {
    const { modelOfTreeFromSessions } = await CC;
    assert.equal(modelOfTreeFromSessions('/w/a', [sess('/w/a', 'composer-2.5[fast=true]', 1)]), 'composer-2.5');
  });

  it('查不到 → null（不许硬塞进某个渠道，塞错会误拦）', async () => {
    const { modelOfTreeFromSessions } = await CC;
    assert.equal(modelOfTreeFromSessions('/w/zzz', [sess('/w/a', 'grok-4.6', 1)]), null);
    assert.equal(modelOfTreeFromSessions('/w/a', [sess('/w/a', '', 1)]), null, '空 model 不算查到');
    assert.equal(modelOfTreeFromSessions('/w/a', null), null, '名单没给');
    assert.equal(modelOfTreeFromSessions('', [sess('/w/a', 'grok-4.6', 1)]), null, '树路径是空');
  });
});

describe('treeChannelResolver —— 会话名单优先，派工账本兜底', () => {
  it('会话名单能归因时用它（本轮修的正是这一格）', async () => {
    const { treeChannelResolver } = await CC;
    // 账本里这棵树一条都对不上（jobs 空）——旧路在这里返回 null
    const old = treeChannelResolver({ jobs: [], legs: LEGS, models: [] });
    assert.equal(old('/w/dao-review-pr-1232'), null, '负控：光靠账本确实归不掉');
    const now = treeChannelResolver({ jobs: [], legs: LEGS, models: [], sessions: [sess('/w/dao-review-pr-1232', 'glm-5.2', 1)] });
    assert.equal(now('/w/dao-review-pr-1232'), 'gw:windsurf');
  });

  it('会话名单归不掉时回落派工账本（兜底没被删）', async () => {
    const { treeChannelResolver } = await CC;
    const jobs = [{ job_id: 'j1', issue: 77, model: 'grok-4.6' }];
    const r = treeChannelResolver({ jobs, legs: LEGS, models: [], sessions: [sess('/w/别的树', 'glm-5.2', 1)] });
    assert.equal(r('/w/dao-77'), 'gw:grok');
  });

  it('两条路都归不掉 → null', async () => {
    const { treeChannelResolver } = await CC;
    const r = treeChannelResolver({ jobs: [], legs: LEGS, models: [], sessions: [] });
    assert.equal(r('/w/dao-999'), null);
  });

  it('两条路给出不同答案时以会话名单为准——它是「此刻在跑什么」，账本是「当初打算派什么」', async () => {
    const { treeChannelResolver } = await CC;
    const jobs = [{ job_id: 'j1', issue: 77, model: 'grok-4.6' }];   // 账本说 grok
    const sessions = [sess('/w/dao-77', 'glm-5.2', 1)];              // 现场在跑 glm
    const r = treeChannelResolver({ jobs, legs: LEGS, models: [], sessions });
    assert.equal(r('/w/dao-77'), 'gw:windsurf', '分支名复用（#1256）时账本会指向旧派工，不能听它的');
  });

  it('接上去之后在途数真的数得出来（分子不再恒为 0）', async () => {
    const { treeChannelResolver, countInFlightByChannel } = await CC;
    const trees = ['/w/t1', '/w/t2', '/w/t3'];
    const sessions = [sess('/w/t1', 'glm-5.2', 1), sess('/w/t2', 'glm-5.2', 1), sess('/w/t3', 'grok-4.6', 1)];
    const out = countInFlightByChannel(trees, treeChannelResolver({ jobs: [], legs: LEGS, models: [], sessions }));
    assert.deepEqual(out.counts, { 'gw:windsurf': 2, 'gw:grok': 1 });
    assert.deepEqual(out.unattributed, []);
  });
});

// 审官 PR #1266 第二轮红项：解析器接了名单，门内 readChannelFacts 没接。
// 生产入口 checkChannelCapacity / admitAndReserveChannel 仍只用账本兜底，
// 账本归不掉的在途树进 unattributed，procCounts={}，cap=1 继续当 0 放行。
describe('门内路径：会话名单接入 checkChannelCapacity / admitAndReserveChannel', () => {
  const TREE = '/w/dao-review-pr-1232';
  const GATE_LEGS = [{
    id: 'grok@gw/orca', 状态: '在役', 模型: 'grok-4.6', 供应商: 'gw',
    落地: { provider: 'gw', cli_model: 'gw/grok-4.6' }, 并发上限: 1,
  }];
  const ioBase = {
    loadRouting: () => ({ 腿: GATE_LEGS }),
    loadModels: () => [],
    checkInFlight: () => ({ ok: true, trees: [TREE], count: 1 }),
    loadJobs: () => [],
    loadBreaker: () => null,
  };

  it('负控：账本空、也没会话名单 → 在途进 unattributed，cap=1 仍判 free（审官复现的断链）', async () => {
    const { readChannelFacts, checkChannelCapacity } = await CC;
    const facts = readChannelFacts({ io: ioBase });
    assert.equal(facts.ok, true);
    assert.deepEqual(facts.procCounts, {});
    assert.deepEqual(facts.unattributed, [TREE]);
    const v = checkChannelCapacity({ model: 'grok-4.6', io: ioBase });
    assert.equal(v.verdict, 'free');
    assert.equal(v.inFlight, 0);
  });

  it('账本归不掉、会话名单能归因 → checkChannelCapacity 对 cap=1 判满', async () => {
    const { readChannelFacts, checkChannelCapacity } = await CC;
    const io = { ...ioBase, loadSessions: () => [sess(TREE, 'grok-4.6', 1)] };
    const facts = readChannelFacts({ io });
    assert.deepEqual(facts.procCounts, { 'gw:grok': 1 });
    assert.deepEqual(facts.unattributed, []);
    const v = checkChannelCapacity({ model: 'grok-4.6', io });
    assert.equal(v.ok, true);
    assert.equal(v.verdict, 'full');
    assert.equal(v.reason, 'at-cap');
    assert.equal(v.channel, 'gw:grok');
    assert.equal(v.inFlight, 1);
    assert.equal(v.cap, 1);
  });

  it('同一条穿过 admitAndReserveChannel：cap=1 背压，不占槽', async () => {
    const { admitAndReserveChannel } = await CC;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-1266-admit-'));
    const io = { ...ioBase, loadSessions: () => [sess(TREE, 'grok-4.6', 1)] };
    const r = admitAndReserveChannel({ model: 'grok-4.6', io, home, now: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.verdict, 'full');
    assert.equal(r.reason, 'at-cap');
    assert.equal(r.inFlight, 1);
    assert.equal(r.cap, 1);
    // 满员那条不写预占；release 是 noop，调了也不该留下 .res
    const left = [];
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (n.endsWith('.res')) left.push(p);
      }
    };
    walk(path.join(home, '.dao'));
    assert.deepEqual(left, []);
  });

  it('登记文件（可持久化源）读出来就能喂给门：cap=1 判满', async () => {
    const { loadSessionAttribution, checkChannelCapacity } = await CC;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-1266-reg-'));
    fs.writeFileSync(path.join(dir, 'grok%3Aabc.json'), JSON.stringify({
      workdir: TREE, model: 'grok-4.6', updatedAt: 9, state: 'running', cleanupVerified: false,
    }));
    fs.writeFileSync(path.join(dir, 'junk.json'), 'not json');
    fs.writeFileSync(path.join(dir, 'nomodel.json'), JSON.stringify({ workdir: '/w/other' }));
    const sessions = loadSessionAttribution({ dir });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].cwd, TREE);
    assert.equal(sessions[0].model, 'grok-4.6');
    assert.equal(sessions[0].state, 'running');
    assert.equal(sessions[0].cleanupVerified, false);
    const io = { ...ioBase, loadSessions: () => sessions };
    const v = checkChannelCapacity({ model: 'grok-4.6', io });
    assert.equal(v.verdict, 'full');
    assert.equal(v.reason, 'at-cap');
  });

  it('登记目录不在 → []（查成了的空，不是没查成）', async () => {
    const { loadSessionAttribution } = await CC;
    const sessions = loadSessionAttribution({ dir: path.join(os.tmpdir(), 'dao-1266-no-such-' + Date.now()) });
    assert.deepEqual(sessions, []);
  });

  it('登记文件同一 workdir：终态新记录不覆盖旧 running', async () => {
    const { loadSessionAttribution, modelOfTreeFromSessions } = await CC;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-1266-mix-'));
    fs.writeFileSync(path.join(dir, 'done.json'), JSON.stringify({
      workdir: '/w/a', model: 'grok-4.6', updatedAt: 200, state: 'done', cleanupVerified: true,
    }));
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
      workdir: '/w/a', model: 'glm-5.2', updatedAt: 100, state: 'running', cleanupVerified: false,
    }));
    const sessions = loadSessionAttribution({ dir });
    assert.equal(sessions.length, 2);
    const byModel = Object.fromEntries(sessions.map((s) => [s.model, s]));
    assert.equal(byModel['grok-4.6'].state, 'done');
    assert.equal(byModel['grok-4.6'].cleanupVerified, true);
    assert.equal(byModel['glm-5.2'].state, 'running');
    assert.equal(byModel['glm-5.2'].cleanupVerified, false);
    assert.equal(modelOfTreeFromSessions('/w/a', sessions), 'glm-5.2');
  });

  it('审官复现：终态时间更新盖不住当前 running，glm cap=1 必须判满', async () => {
    const { readChannelFacts, checkChannelCapacity } = await CC;
    const MIX_LEGS = [
      { id: 'grok@x', 状态: '在役', 模型: 'grok-4.6', 供应商: 'gw', 落地: GROK, 并发上限: 1 },
      { id: 'glm@x', 状态: '在役', 模型: 'glm-5.2', 供应商: 'gw', 落地: GLM, 并发上限: 1 },
    ];
    const tree = '/w/a';
    const io = {
      loadRouting: () => ({ 腿: MIX_LEGS }),
      loadModels: () => [],
      checkInFlight: () => ({ ok: true, trees: [tree], count: 1 }),
      loadJobs: () => [],
      loadBreaker: () => null,
      loadSessions: () => [
        sess(tree, 'grok-4.6', 200, { state: 'done' }),
        sess(tree, 'glm-5.2', 100, { state: 'running' }),
      ],
    };
    const facts = readChannelFacts({ io });
    assert.deepEqual(facts.procCounts, { 'gw:windsurf': 1 });
    assert.deepEqual(facts.unattributed, []);
    const glm = checkChannelCapacity({ model: 'glm-5.2', io });
    assert.equal(glm.verdict, 'full');
    assert.equal(glm.reason, 'at-cap');
    assert.equal(glm.channel, 'gw:windsurf');
    assert.equal(glm.inFlight, 1);
    assert.equal(glm.cap, 1);
    const grok = checkChannelCapacity({ model: 'grok-4.6', io });
    assert.equal(grok.verdict, 'free', '已结束的 grok 不许把树记到自己头上');
    assert.equal(grok.inFlight, 0);
  });

  it('只有终态历史记录 → 不计入在途渠道，回落账本仍归不掉则 unattributed', async () => {
    const { loadSessionAttribution, readChannelFacts, checkChannelCapacity } = await CC;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-1266-done-'));
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({
      workdir: TREE, model: 'grok-4.6', updatedAt: 900, state: 'done', cleanupVerified: true,
    }));
    const sessions = loadSessionAttribution({ dir });
    assert.equal(sessions[0].state, 'done');
    assert.equal(sessions[0].cleanupVerified, true);
    const io = { ...ioBase, loadSessions: () => sessions };
    const facts = readChannelFacts({ io });
    assert.deepEqual(facts.procCounts, {});
    assert.deepEqual(facts.unattributed, [TREE]);
    const v = checkChannelCapacity({ model: 'grok-4.6', io });
    assert.equal(v.verdict, 'free');
    assert.equal(v.inFlight, 0);
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

describe('validateLegCaps —— dao-check 的判据（故意违规样本必须被拦下）', () => {
  it('腿节不是数组 = 红（没查成，与「扫完是 0」分得开）', async () => {
    const { validateLegCaps } = await CC;
    const r = validateLegCaps(null);
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
  });

  it('故意违规样本：上限写 0 / -1 / 杂串 → 全部当场点名（bad）', async () => {
    const { validateLegCaps } = await CC;
    const r = validateLegCaps([
      { id: 'zero@x', 状态: '在役', 供应商: 'gw', 落地: GROK, 并发上限: 0 },
      { id: 'neg@x', 状态: '在役', 供应商: 'gw', 落地: DEEPSEEK, 并发上限: -1 },
      { id: 'junk@x', 状态: '在役', 供应商: 'gw', 落地: GLM, 并发上限: '很多' },
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.bad.map((b) => b.id), ['zero@x', 'neg@x', 'junk@x']);
  });

  it('待填不算红（故意未配置），但必须列出来催填', async () => {
    const { validateLegCaps, CONSERVATIVE_CAP } = await CC;
    const r = validateLegCaps([
      { id: 'pend@x', 状态: '在役', 供应商: 'gw', 落地: GLM },
      { id: 'ok@x', 状态: '在役', 供应商: 'gw', 落地: GROK, 并发上限: 5 },
    ]);
    assert.deepEqual(r.bad, []);
    assert.deepEqual(r.pending.map((p) => p.id), ['pend@x']);
    assert.equal(r.conservativeCap, CONSERVATIVE_CAP);
  });

  it('停用腿不参与校验（不要求填字段）', async () => {
    const { validateLegCaps } = await CC;
    const r = validateLegCaps([{ id: 'dead@x', 状态: '停用', 供应商: 'gw', 落地: GROK }]);
    assert.deepEqual(r.pending, []);
    assert.equal(r.inService, 0);
  });

  it('真表：在役腿全有字段、无脏值（本单验收标准）', async () => {
    const { validateLegCaps } = await CC;
    const fs = require('node:fs');
    const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'model-routing.json'), 'utf8'));
    const r = validateLegCaps(doc.腿);
    assert.equal(r.ok, true);
    assert.deepEqual(r.bad, []);
    assert.ok(r.inService > 0, '一条在役腿都没扫到 ⇒ 本次等于没查');
  });
});
