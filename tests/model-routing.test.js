// 规则「选型只认统一执行目录」（2026-09-12 拍板，原「非GPT只走pi-gw」退役）：
// 启用中的职责树条目必须能由目录判出一条真路 —— 在树里就是「不许再出现 provider=gw 的启用条目」。
// 检查器自己走职责树，不 import model-routing-json.mjs（自己查自己查不出错）。
// 三态分开：扫完 0 条违规 / 扫到违规 / 没扫到任何启用槽。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIVE = path.join(REPO, 'docs', 'model-routing.json');
const FIX = path.join(REPO, 'tests', 'fixtures', 'model-routing');

const DUTIES = ['帅', '工人', '审官'];

// 已退役的派工通道（网关组 id）。newapi 网关从派工选型退役后，启用的树条目里不许再有它。
// 只记「已退役的选型通道」，不重复 reviewer-vendor-gate 的「真实厂商」判据（那是另一个概念）。
const RETIRED_LANDING_PROVIDERS = new Set(['gw']);
function isGwGroup(id) {
  const s = String(id || '');
  return s === 'gw' || s.startsWith('gw-');
}

/** 每个启用模型的单值落地（provider + cli_model）。 */
function scanEnabled(doc) {
  const slots = [];
  const vendors = [];
  if (!doc || typeof doc !== 'object') return { slots, vendors };
  for (const duty of DUTIES) {
    const workTypes = doc[duty];
    if (!workTypes || typeof workTypes !== 'object') continue;
    for (const [workType, cfg] of Object.entries(workTypes)) {
      const list = Array.isArray(cfg?.模型) ? cfg.模型 : [];
      for (const m of list) {
        if (!m?.id || m.禁用 === true) continue;
        if (m.provider == null || String(m.provider).trim() === '') continue;
        const vendor = String(m.provider).trim();
        const cli = m.cli_model == null ? null : String(m.cli_model);
        slots.push({
          duty,
          workType,
          model: String(m.id),
          rank: m.顺位,
          vendor,
          cli_model: cli,
        });
        vendors.push({
          duty,
          workType,
          model: String(m.id),
          vendor,
          cli_model: cli,
        });
      }
    }
  }
  return { slots, vendors };
}

function audit(doc) {
  const { slots, vendors } = scanEnabled(doc);
  if (slots.length === 0) {
    return { scanned: 0, problems: ['没扫到任何启用中的顺位1厂商（本次等于没查）'] };
  }
  const problems = [];
  for (const s of slots) {
    // 规则「选型只认统一执行目录」：启用条目必须落在真路口上，网关组 id 一律不许。
    if (RETIRED_LANDING_PROVIDERS.has(String(s.vendor).toLowerCase()) || isGwGroup(s.vendor)) {
      problems.push(`${s.duty}.${s.workType} ${s.model} 启用条目落在已退役的网关组 ${s.vendor}（规则「选型只认统一执行目录」）`);
    }
    if (s.vendor == null || String(s.vendor).trim() === '') {
      problems.push(`${s.duty}.${s.workType} ${s.model} 启用条目没写 provider（判不出真路）`);
    }
  }
  for (const v of vendors) {
    if (RETIRED_LANDING_PROVIDERS.has(String(v.vendor).toLowerCase())) {
      problems.push(`${v.duty}.${v.workType} ${v.model} 启用厂商=${v.vendor}，已随网关退役`);
    }
  }
  const reviewerRank1 = slots
    .filter((s) => s.duty === '审官' && s.workType === '审查')
    .sort((a, b) => {
      const ra = a.rank == null ? Infinity : Number(a.rank);
      const rb = b.rank == null ? Infinity : Number(b.rank);
      return ra - rb;
    })[0];
  if (!reviewerRank1) {
    problems.push('审官.审查 没有启用模型');
  } else {
    // 持久不变量：审官顺位1 必须是 GPT 家族。**落地不再钉死**——2026-09-12 网关退役后
    // 「主路 Codex / 过渡期 luna 走网关」这条区分没了意义，GPT 腿统一落 mirasim-relay。
    // 判据 = 模型 id 是 gpt-5.6 家族，且落地不是退役通道（上面已逐条查过）。
    if (!/^gpt-/.test(reviewerRank1.model)) {
      problems.push(`审官顺位1 是 ${reviewerRank1.model}/${reviewerRank1.vendor}，应是 gpt-5.6 家族（审官主路 Codex）`);
    }
  }
  return { scanned: slots.length, problems, slots, vendors };
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('规则「选型只认统一执行目录」：启用条目不许落在已退役通道', () => {
  it('夹具三态：绿 / 红 / 空=没扫到', () => {
    const ok = audit(loadJson(path.join(FIX, 'ok', 'routing.json')));
    assert.equal(ok.scanned > 0, true, '绿夹具应扫到启用槽  →  ' + JSON.stringify(ok));
    assert.deepEqual(ok.problems, [], '绿夹具应扫完 0 条');

    const red = audit(loadJson(path.join(FIX, 'red', 'routing.json')));
    assert.equal(red.scanned > 0, true, '红夹具应扫到启用槽');
    assert.equal(red.problems.some((p) => /gw/.test(p)), true,
      '红夹具必须红（故意把启用条目落回网关组 gw）  →  ' + JSON.stringify(red.problems));

    const empty = audit(loadJson(path.join(FIX, 'empty', 'routing.json')));
    assert.equal(empty.scanned, 0, '空夹具 = 没扫到');
    assert.equal(empty.problems.some((p) => /没扫到/.test(p)), true,
      '空夹具必须说「没扫到」，不是「0 条违规」  →  ' + JSON.stringify(empty.problems));
  });

  it('现行 docs/model-routing.json 过闸', () => {
    const live = audit(loadJson(LIVE));
    assert.equal(live.scanned > 0, true, '现行 JSON 必须扫到启用槽，不许把没查成当成齐');
    assert.deepEqual(live.problems, [], '现行 JSON 违规  →  ' + live.problems.join(' | '));

    // 启用条目的落地全部是真路口（网关组一个都不剩）——判据现推，不逐条钉死字面。
    const offGw = live.slots.filter((s) => isGwGroup(s.vendor));
    assert.deepEqual(offGw, [], '启用槽里还有网关组  →  ' + JSON.stringify(offGw));

    const grok = live.slots.find((s) => s.duty === '工人' && s.workType === '写码' && s.model === 'grok-4.6');
    assert.equal(grok && grok.vendor, 'xai-native', '写码 grok 落地  →  ' + JSON.stringify(grok));
    assert.equal(grok && grok.cli_model, grok && grok.model, 'grok 的 cli_model 应与模型 id 同源');

    const planGpt = live.slots.find((s) => s.duty === '工人' && s.workType === '方案' && s.model === 'gpt-5.6-sol');
    assert.equal(planGpt && planGpt.vendor, 'mirasim-relay', '方案 GPT 落地  →  ' + JSON.stringify(planGpt));
  });

  it('禁用条目可以留旧通道，不算选型', () => {
    const live = loadJson(LIVE);
    const devin = live.工人.写码.模型.find((m) => m.id === 'devin-deepseek-v4-flash-max');
    assert.equal(devin && devin.禁用, true, 'devin 必须禁用');
    const ox = live.帅.判断.模型.find((m) => m.id === 'ox-alpha-free');
    assert.equal(ox && ox.禁用, true, 'ox-alpha-free 必须禁用');
    const scanned = audit(live);
    assert.equal(!scanned.slots.some((s) => s.model === 'devin-deepseek-v4-flash-max'), true,
      '禁用 devin 不得进启用槽');
  });
});

// #1233：审官顺位 × 执行目录可用性。
// 2026-09-13 实咬：顺位表和执行目录是两条真相源，谁也不问谁。审官序第 2 位
// gpt-5.6-sol 在执行目录里 unverified，起审官必被 resolveExecutionProfile 拒 →
// 每张按顺位选了它的复审票 drain 必失败、试满 3 次打「自动化认输」。
describe('#1233 审官顺位按执行目录可用性过滤', () => {
  const M = () => import('file://' + path.join(REPO, 'scripts', 'lib', 'model-routing-json.mjs').replace(/\\/g, '/'));
  const PROFILES = [
    { id: 'm-ok', enabled: true, availability: { status: 'available' } },
    { id: 'm-unverified', enabled: true, availability: { status: 'unverified' } },
    { id: 'm-off', enabled: false, availability: { status: 'available' } },
    { id: 'm-ok-by-default', enabled: true, availability: 'available', defaultForModels: ['alias-model'] },
  ];

  it('起不来的剔除，并点名为什么', async () => {
    const { usableReviewerOrder } = await M();
    const r = usableReviewerOrder(['m-ok', 'm-unverified', 'm-off', 'alias-model', 'm-nowhere'], { profiles: PROFILES });
    assert.deepEqual(r.usable, ['m-ok', 'alias-model'], '可用的留下  →  ' + JSON.stringify(r));
    assert.deepEqual(r.skipped.map((s) => s.id), ['m-unverified', 'm-off', 'm-nowhere'], '被剔的每个都要点名');
    assert.ok(r.skipped[0].why.includes('unverified'), '理由要带 availability  →  ' + r.skipped[0].why);
    assert.ok(r.skipped[1].why.includes('未启用'), '理由要带未启用  →  ' + r.skipped[1].why);
    assert.ok(r.skipped[2].why.includes('没有这个模型'), '理由要带目录里没有  →  ' + r.skipped[2].why);
  });

  it('#1342 熔断/健康判红的顺位也剔，理由点名；没传判红名单 ⇒ 不据此剔', async () => {
    const { usableReviewerOrder } = await M();
    const order = ['m-ok', 'alias-model'];
    const r = usableReviewerOrder(order, { profiles: PROFILES, redIds: ['m-ok'] });
    assert.deepEqual(r.usable, ['alias-model'], '目录里 available 但熔断 open 的腿不许再当审官  →  ' + JSON.stringify(r));
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].id, 'm-ok');
    assert.match(r.skipped[0].why, /熔断|健康/);
    const none = usableReviewerOrder(order, { profiles: PROFILES });
    assert.deepEqual(none.usable, order, '没有判红名单 = 没依据，不剔');
    const set = usableReviewerOrder(order, { profiles: PROFILES, redIds: new Set(['alias-model']) });
    assert.deepEqual(set.usable, ['m-ok'], 'Set 与数组都收');
  });

  it('#1342 全红即旁路：判红名单把顺位剔空时不剔、照派，并把旁路说出来', async () => {
    const { usableReviewerOrder } = await M();
    const order = ['m-ok', 'alias-model'];
    // 2026-09-17 实测：relay 78%、grok 原生 76% 同时判红——剔空 = 盘面又冻，今天花一天解的病。
    const r = usableReviewerOrder(order, { profiles: PROFILES, redIds: ['m-ok', 'alias-model'] });
    assert.deepEqual(r.usable, order, '一条 25% 的腿比「没有审官」强，重试预算已经在兜底');
    assert.deepEqual(r.skipped, [], '旁路时不算剔');
    assert.match(String(r.breakerBypassed), /全红即旁路/, '旁路必须说出来，不许静默  →  ' + JSON.stringify(r));
    assert.equal(r.allDead, false);
    // 目录本身起不来的仍然剔（旁路只管判红那一层）
    const mixed = usableReviewerOrder(['m-ok', 'm-off'], { profiles: PROFILES, redIds: ['m-ok'] });
    assert.deepEqual(mixed.usable, ['m-ok'], 'm-off 是目录停用不是判红，照剔；只剩 m-ok 一个判红的 ⇒ 全红旁路留它');
    assert.ok(mixed.breakerBypassed);
    // 剔到只剩一个不算全红
    const one = usableReviewerOrder(order, { profiles: PROFILES, redIds: ['m-ok'] });
    assert.deepEqual(one.usable, ['alias-model']);
    assert.equal(one.breakerBypassed, undefined);
  });

  it('顺位全起不来 ⇒ allDead，不许退回到「就用第一个」', async () => {
    const { usableReviewerOrder } = await M();
    const r = usableReviewerOrder(['m-unverified', 'm-off'], { profiles: PROFILES });
    assert.deepEqual(r.usable, []);
    assert.equal(r.allDead, true, '全灭必须报出来（这正是 2026-09-13 那场实咬的形状）');
  });

  it('执行目录没读到 ⇒ 不剔任何顺位，但明说没查成', async () => {
    const { usableReviewerOrder } = await M();
    const order = ['m-ok', 'm-unverified'];
    const r = usableReviewerOrder(order, {});
    assert.deepEqual(r.usable, order, '没读到目录时不许凭空剔人（没有依据）');
    assert.deepEqual(r.skipped, []);
    assert.ok(r.unscanned, '「没读到」必须与「读到了、全都可用」分得开  →  ' + JSON.stringify(r));
  });

  it('空顺位 ⇒ 不是 allDead（扫完就没有，跟「有但全废」是两件事）', async () => {
    const { usableReviewerOrder } = await M();
    const r = usableReviewerOrder([], { profiles: PROFILES });
    assert.deepEqual(r.usable, []);
    assert.equal(r.allDead, false);
    assert.equal(r.unscanned, undefined);
  });

  it('现行审官序过一遍：真正能起的顺位一条都不能少，被剔的必须说得出理由', async () => {
    const { usableReviewerOrder, reviewerSelectOrder, loadRoutingJsonRaw } = await M();
    const { loadExecutionProfiles } = await import('file://' + path.join(REPO, 'scripts', 'lib', 'execution-runtime.mjs').replace(/\\/g, '/'));
    const order = reviewerSelectOrder(loadRoutingJsonRaw());
    assert.ok(order.length > 0, '审官序必须非空（空 = 没扫到，不算通过）');
    const r = usableReviewerOrder(order, { profiles: loadExecutionProfiles() });
    assert.equal(r.unscanned, undefined, '执行目录必须读得到（读不到 = 这一层根本没生效）');
    assert.ok(r.usable.length > 0, '至少要有 1 个能起的审官，否则整条复审链全瘫  →  ' + JSON.stringify(r));
    const blank = r.skipped.filter((s) => !s.why || s.why.length <= 4);
    assert.deepEqual(blank, [], '剔除理由不许是空话  →  ' + JSON.stringify(r.skipped));
    // 正向控制：过滤后的序必须是原序的子序列（不许换顺序、不许凭空多出人）
    let i = 0;
    for (const id of order) if (i < r.usable.length && id === r.usable[i]) i += 1;
    assert.equal(i, r.usable.length, '可用序必须是原顺位的子序列  →  ' + JSON.stringify(r.usable));
  });
});
