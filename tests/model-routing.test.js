// #822：非 GPT 启用厂商必须是 gw；GPT 必须是 gpt/codex。
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
const REMOVED_CLIS = new Set(['grok', 'cursor', 'devin', 'claude', 'opencode-go', 'deepseek']);

function isGwVendor(id) {
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
    if (s.model === 'gpt-5.6-sol') {
      if (s.vendor !== 'gpt') {
        problems.push(`${s.duty}.${s.workType} gpt-5.6-sol 必须走 Codex（厂商 gpt），实际=${s.vendor}`);
      }
    } else if (s.model === 'gpt-5.6-luna') {
      if (!isGwVendor(s.vendor)) {
        problems.push(`${s.duty}.${s.workType} gpt-5.6-luna 降级腿必须 gw，实际=${s.vendor}`);
      }
    } else if (!isGwVendor(s.vendor)) {
      problems.push(`${s.duty}.${s.workType} ${s.model} 顺位1厂商=${s.vendor}，非 Codex 必须 gw`);
    }
  }
  for (const v of vendors) {
    if (REMOVED_CLIS.has(v.vendor)) {
      problems.push(`${v.duty}.${v.workType} ${v.model} 启用厂商=${v.vendor}，#822 已从选型移除`);
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
    // 持久不变量：审官顺位1 必须是 GPT 家族且落地正确——常态 sol/gpt（Codex 主路），
    // #843 过渡期 luna/gw（pqapi 故障，codex 每单必死，临时切；恢复后切回）。二者皆合法。
    const okSol = reviewerRank1.model === 'gpt-5.6-sol' && reviewerRank1.vendor === 'gpt';
    const okLuna = reviewerRank1.model === 'gpt-5.6-luna' && isGwVendor(reviewerRank1.vendor);
    if (!okSol && !okLuna) {
      problems.push(`审官顺位1 是 ${reviewerRank1.model}/${reviewerRank1.vendor}，应是 gpt-5.6-sol/gpt 或 gpt-5.6-luna/gw（#843 过渡）`);
    }
  }
  return { scanned: slots.length, problems, slots, vendors };
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('#822 model-routing 非GPT顺位1必须gw', () => {
  it('夹具三态：绿 / 红 / 空=没扫到', () => {
    const ok = audit(loadJson(path.join(FIX, 'ok', 'routing.json')));
    assert.ok(ok.scanned > 0 && ok.problems.length === 0,
      '绿夹具应扫完 0 条  →  ' + JSON.stringify(ok));

    const red = audit(loadJson(path.join(FIX, 'red', 'routing.json')));
    assert.ok(red.scanned > 0 && red.problems.length > 0 && red.problems.some((p) => /grok/.test(p)),
      '红夹具必须红（故意 Grok Build CLI）  →  ' + JSON.stringify(red));

    const empty = audit(loadJson(path.join(FIX, 'empty', 'routing.json')));
    assert.ok(empty.scanned === 0 && empty.problems.some((p) => /没扫到/.test(p)),
      '空夹具是没扫到，不是 0 条违规  →  ' + JSON.stringify(empty));
    assert.ok(ok.problems.length === 0 && red.problems.length > 0 && empty.scanned === 0,
      '三态必须分得开');
  });

  it('现行 docs/model-routing.json 过闸', () => {
    const live = audit(loadJson(LIVE));
    assert.ok(live.scanned > 0, '现行 JSON 必须扫到启用槽，不许把没查成当成齐');
    assert.equal(live.problems.length, 0, '现行 JSON 违规  →  ' + live.problems.join(' | '));

    const grok = live.slots.find((s) => s.duty === '工人' && s.workType === '写码' && s.model === 'grok-4.6');
    assert.ok(grok && grok.vendor === 'gw' && grok.cli_model === 'gw/grok-4.6',
      '写码 grok cli_model  →  ' + JSON.stringify(grok));

    const flash = live.slots.find((s) => s.duty === '工人' && s.workType === '写码' && s.model === 'deepseek-v4-flash');
    assert.ok(flash && flash.vendor === 'gw' && flash.cli_model === 'gw-dspool/deepseek-v4-flash',
      '写码 flash cli_model  →  ' + JSON.stringify(flash));

    const glm = live.slots.find((s) => s.model === 'glm-5.2' && s.duty === '工人' && s.workType === '方案');
    assert.ok(glm && glm.vendor === 'gw' && glm.cli_model === 'gw-windsurf/glm-5-2',
      '方案 glm cli_model  →  ' + JSON.stringify(glm));

    const planGpt = live.slots.find((s) => s.duty === '工人' && s.workType === '方案' && s.model === 'gpt-5.6-sol');
    assert.ok(planGpt && planGpt.vendor === 'gpt',
      '方案 GPT 仍 Codex  →  ' + JSON.stringify(planGpt));
  });

  it('禁用条目可以留旧 CLI，不算选型', () => {
    const live = loadJson(LIVE);
    const devin = live.工人.写码.模型.find((m) => m.id === 'devin-deepseek-v4-flash-max');
    assert.ok(devin && devin.禁用 === true, 'devin 必须禁用');
    const ox = live.帅.判断.模型.find((m) => m.id === 'ox-alpha-free');
    assert.ok(ox && ox.禁用 === true, 'ox-alpha-free 必须禁用');
    const scanned = audit(live);
    assert.ok(!scanned.slots.some((s) => s.model === 'devin-deepseek-v4-flash-max'),
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
