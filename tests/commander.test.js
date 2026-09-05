// 服务器指挥官决策层（#800）。判别力铁律：#800 每条判据都有故意夹具钉死；
// 「没查成 ≠ 空态势」有专门红样本——把 scanned:false 当空处理会当场被抓。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const CORE = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'commander-core.mjs').replace(/\\/g, '/'));

// 一份「全查成、全空」的基线态势：decide 应只回 noop。各用例覆盖其中某节。
function baseSituation(over = {}) {
  return {
    github: { scanned: true, issues: [], prs: [] },
    orca: { scanned: true, worktrees: [] },
    reviewPending: { scanned: true, items: [] },
    prReviews: { scanned: true, byPr: {} },
    stall: { scanned: true, strikes: {} },
    wakeCounts: {},
    // 旧夹具不测模型闸：默认关 requireModelInRouting，#849 新测显式打开。
    commanderPolicy: { maxDispatchPerRound: 20, requireModelInRouting: false },
    routingModels: ['grok-4.6', 'deepseek-v4-flash', 'gpt-5.6-sol'],
    healthRedModels: [],
    ...over,
  };
}
const kinds = (r) => r.actions.map((a) => a.kind);
const byKind = (r, k) => r.actions.filter((a) => a.kind === k);

describe('decide：自己做（确定性）', () => {
  it('已消歧 + 无在途 + model|reviewer 标签齐 → dispatch（判据①）', async () => {
    const { decide } = await CORE;
    const issue = { number: 900, title: '补 X', labels: [
      { name: '已消歧' }, { name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }, { name: 'type/写码' },
    ] };
    const r = decide(baseSituation({ github: { scanned: true, issues: [issue], prs: [] } }));
    const d = byKind(r, 'dispatch');
    assert.equal(d.length, 1, '应派一单');
    assert.equal(d[0].issue, 900);
    assert.equal(d[0].model, 'grok-4.6');
    assert.equal(d[0].reviewer, 'gpt-5.6-sol');
    assert.ok(kinds(r).includes('notify-hub'), '派单要回流总控群');
    assert.ok(!kinds(r).includes('noop'), '有动作就不是 noop');
  });

  it('已消歧但缺 model/reviewer 标签 → escalate 不猜（不产 dispatch）', async () => {
    const { decide } = await CORE;
    const issue = { number: 901, title: 'Y', labels: [{ name: '已消歧' }] };
    const r = decide(baseSituation({ github: { scanned: true, issues: [issue], prs: [] } }));
    assert.equal(byKind(r, 'dispatch').length, 0, '缺标签绝不派');
    const e = byKind(r, 'escalate');
    assert.equal(e.length, 1);
    assert.equal(e[0].reason, 'missing-labels');
  });

  it('审官判绿 + 非 draft + MERGEABLE + CI 绿 + 判定行绿 → merge + land + 回流', async () => {
    const { decide } = await CORE;
    const pr = {
      number: 910, title: 'Z', isDraft: false, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], body: '',
    };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 910: { reviews: [{ state: 'APPROVED', body: '看过 diff，可合并' }] } } },
    }));
    assert.equal(byKind(r, 'merge').length, 1);
    assert.equal(byKind(r, 'land').length, 1, '合并后调 land（幂等）');
    assert.ok(byKind(r, 'notify-hub').some((a) => a.moment === 'merged'));
  });

  it('真 APPROVED + 白话正文（无判定行）→ merge，不误报 approved-without-review（#857 红 1 判别）', async () => {
    const { decide } = await CORE;
    const pr = {
      number: 912, title: 'Y', isDraft: false, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], body: '',
    };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      // reviewer-book #807 起不写「判定：」行——只看 bodies 会把这条判成 COMMENTED
      prReviews: { scanned: true, byPr: { 912: { reviews: [{ state: 'APPROVED', body: '看过 diff，逻辑对，可合并' }], bodies: ['看过 diff，逻辑对，可合并'] } } },
    }));
    assert.equal(byKind(r, 'merge').length, 1, '真 approve 白话正文必须走 merge');
    assert.ok(!byKind(r, 'escalate').some((a) => a.reason === 'approved-without-review'), '不许误报 approved-without-review');
  });

  it('两条 CHANGES_REQUESTED + 白话正文（无判定行）→ 唤大脑给方案送达，不是 noop 也不直接报帅（#857 红 1 判别 + 2026-09-04 拍板）', async () => {
    const { decide } = await CORE;
    const pr = { number: 913, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: 'h913', body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 913: { reviews: [{ state: 'CHANGES_REQUESTED', body: '这里不对', commit_id: 'h913' }, { state: 'CHANGES_REQUESTED', body: '还是不对', commit_id: 'h913' }], bodies: ['这里不对', '还是不对'] } } },
    }));
    assert.equal(byKind(r, 'merge').length, 0);
    const w = byKind(r, 'wake-brain');
    assert.equal(w.length, 1, '两轮红先唤大脑给方案，不许晾着');
    assert.match(w[0].why, /送达/, '指针必须带「送达」职责');
    assert.ok(!byKind(r, 'escalate').some((a) => a.reason === 'two-red'), '唤醒预算没用完前不报帅');
  });

  it('判绿但 CI 红 → 不 merge，报帅 + 卡壳回流', async () => {
    const { decide } = await CORE;
    const pr = {
      number: 911, isDraft: false, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }], body: '',
    };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 911: { reviews: [{ state: 'APPROVED', body: '看过 diff，可合并' }] } } },
    }));
    assert.equal(byKind(r, 'merge').length, 0, 'CI 红绝不合');
    assert.ok(byKind(r, 'escalate').some((a) => a.reason === 'approved-but-ci-red'));
  });

  it('判绿但 draft（manual 合门）→ 需拍板回流，不自动合', async () => {
    const { decide } = await CORE;
    const pr = { number: 912, isDraft: true, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', body: '' };
    const r = decide(baseSituation({ github: { scanned: true, issues: [], prs: [pr] } }));
    assert.equal(byKind(r, 'merge').length, 0);
    assert.ok(byKind(r, 'notify-hub').some((a) => a.moment === 'decide'));
  });

  it('review-pending 队列有条目 → attach-reviewer', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      reviewPending: { scanned: true, items: [{ pr: 920, reviewer: 'gpt-5.6-sol', worker: 'wt-x', head: 'abc' }] },
    }));
    const a = byKind(r, 'attach-reviewer');
    assert.equal(a.length, 1);
    assert.equal(a[0].pr, 920);
  });
});

describe('decide：报帅停手（永不自动）', () => {
  it('审官两轮仍红且唤醒预算用完 → escalate two-red（不 merge、不再唤）（判据②）', async () => {
    const { decide, WAKE_LIMIT } = await CORE;
    const pr = { number: 930, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: 'h930', body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 930: { reviews: [{ state: 'CHANGES_REQUESTED', body: '三处要改', commit_id: 'h930' }, { state: 'CHANGES_REQUESTED', body: '还有两处', commit_id: 'h930' }] } } },
      wakeCounts: { 'pr:930@h930': WAKE_LIMIT },
    }));
    assert.equal(byKind(r, 'merge').length, 0, '两轮红绝不合');
    assert.equal(byKind(r, 'wake-brain').length, 0, '唤醒预算用完不再唤');
    const e = byKind(r, 'escalate');
    assert.ok(e.some((a) => a.reason === 'two-red'), '预算用完要有 two-red 报帅换人');
  });

  it('COMMENT 近义变体不算判别态，不 escalate malformed', async () => {
    const { decide } = await CORE;
    const pr = { number: 931, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: 'h931', body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 931: { reviews: [{ state: 'COMMENTED', body: '看着还行' }] } } },
    }));
    assert.equal(byKind(r, 'merge').length, 0);
    assert.ok(!byKind(r, 'escalate').some((a) => a.reason === 'malformed-judgment'));
  });

  it('同单已唤大脑 WAKE_LIMIT 次仍没闭环 → 转报帅，不再唤', async () => {
    const { decide, WAKE_LIMIT } = await CORE;
    const pr = { number: 932, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: 'h932', body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 932: { reviews: [{ state: 'CHANGES_REQUESTED', body: '一处要改', commit_id: 'h932' }] } } },
      wakeCounts: { 'pr:932@h932': WAKE_LIMIT },
    }));
    assert.equal(byKind(r, 'wake-brain').length, 0);
    assert.ok(byKind(r, 'escalate').some((a) => a.reason === 'wake-exhausted'));
  });
});

describe('decide：唤大脑（要判断）', () => {
  it('审官判红一轮 → wake-brain（有 target）（判据③）', async () => {
    const { decide } = await CORE;
    const pr = { number: 940, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: 'h940', body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 940: { reviews: [{ state: 'CHANGES_REQUESTED', body: '两处要改', commit_id: 'h940' }] } } },
    }));
    const w = byKind(r, 'wake-brain');
    assert.equal(w.length, 1, '一轮红要唤大脑');
    assert.equal(w[0].target, 'pr:940');
    assert.equal(byKind(r, 'escalate').length, 0, '一轮红不报帅');
  });

  it('撞死指纹 strikes≥2（#833 没接住）→ wake-brain', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      stall: { scanned: true, strikes: { term_abc: { strikes: 2, sig: '/exceeded retry limit/i' } } },
    }));
    const w = byKind(r, 'wake-brain');
    assert.equal(w.length, 1);
    assert.equal(w[0].target, 'stall:term_abc');
  });
});

describe('decide：没查成 ≠ 空态势（红样本 + 入口总闸 fail-closed）', () => {
  it('某节 unscanned → escalate(unscanned, missing)，绝不产该节正向动作、绝不 noop', async () => {
    const { decide } = await CORE;
    // GitHub 没查成，其余全查成且空。若把 scanned:false 当空处理会回 noop——这里必须抓住。
    const r = decide(baseSituation({ github: { scanned: false, error: 'gh 挂了' } }));
    assert.ok(!kinds(r).includes('noop'), '没查成不能静默成 noop（这就是红样本要拦的）');
    assert.equal(byKind(r, 'dispatch').length, 0, '没查成不产 dispatch');
    assert.equal(byKind(r, 'merge').length, 0, '没查成不产 merge');
    const e = byKind(r, 'escalate');
    assert.ok(e.some((a) => a.reason === 'unscanned' && (a.missing || []).includes('github')));
  });

  it('reviewPending / stall 各自 unscanned 都进合并 escalate 的 missing', async () => {
    const { decide } = await CORE;
    const r1 = decide(baseSituation({ reviewPending: { scanned: false, error: '目录读不了' } }));
    assert.ok(byKind(r1, 'escalate').some((a) => (a.missing || []).includes('reviewPending')));
    const r2 = decide(baseSituation({ stall: { scanned: false, error: '文件不在' } }));
    assert.ok(byKind(r2, 'escalate').some((a) => (a.missing || []).includes('stall')));
  });

  it('判绿待合并但该 PR reviews 没查成 → escalate，不合', async () => {
    const { decide } = await CORE;
    const pr = {
      number: 950, isDraft: false, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], body: '',
    };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: {} }, // section 查成但该 PR 的 fetch 缺
    }));
    assert.equal(byKind(r, 'merge').length, 0, '判定行没查成绝不合');
    assert.ok(byKind(r, 'escalate').some((a) => a.reason === 'unscanned'));
  });

  // 审官 #840 红①：三条交叉组合原样加成红样本——散落 if 会被它们绕过，入口总闸必须挡住。
  it('红①绕过a：github.scanned=false + reviewPending 有条目 → 不产 attach-reviewer', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: false, error: 'gh 挂' },
      reviewPending: { scanned: true, items: [{ pr: 1 }] },
    }));
    assert.equal(byKind(r, 'attach-reviewer').length, 0, 'github 没查成时 attach-reviewer 一律不产');
    assert.ok(byKind(r, 'escalate').some((a) => a.reason === 'unscanned' && (a.missing || []).includes('github')));
  });

  it('红①绕过b：stall.scanned=false + 一轮红 PR → 不产 wake-brain', async () => {
    const { decide } = await CORE;
    const pr = { number: 2, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: 'h2', body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 2: { reviews: [{ state: 'CHANGES_REQUESTED', body: '一处要改', commit_id: 'h2' }] } } },
      stall: { scanned: false, error: '撞死指纹读不到' },
    }));
    assert.equal(byKind(r, 'wake-brain').length, 0, 'stall 没查成时 wake-brain 一律不产');
    assert.ok(byKind(r, 'escalate').some((a) => a.reason === 'unscanned' && (a.missing || []).includes('stall')));
  });

  it('红①绕过c：prReviews.scanned=false + 已消歧 issue → 不产 dispatch/notify-hub', async () => {
    const { decide } = await CORE;
    const issue = { number: 3, title: 'X', labels: [
      { name: '已消歧' }, { name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' },
    ] };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [issue], prs: [] },
      prReviews: { scanned: false, error: 'reviews API 挂' },
    }));
    assert.equal(byKind(r, 'dispatch').length, 0, 'prReviews 没查成时 dispatch 一律不产');
    assert.equal(byKind(r, 'notify-hub').length, 0, '随附 notify-hub 也一并不产');
    assert.ok(byKind(r, 'escalate').some((a) => a.reason === 'unscanned' && (a.missing || []).includes('prReviews')));
  });

  it('全部节 unscanned → 只有一条 escalate、零正向动作', async () => {
    const { decide, ACTION_KINDS } = await CORE;
    const r = decide({
      github: { scanned: false }, orca: { scanned: false }, reviewPending: { scanned: false },
      prReviews: { scanned: false }, stall: { scanned: false }, wakeCounts: {},
    });
    assert.equal(r.actions.length, 1, '全 unscanned 只该有一条动作');
    assert.equal(r.actions[0].kind, 'escalate');
    assert.equal(r.actions[0].reason, 'unscanned');
    assert.equal((r.actions[0].missing || []).length, 5, 'missing 列全五节');
    const positive = r.actions.filter((a) => !['escalate', 'noop'].includes(a.kind));
    assert.equal(positive.length, 0, '零正向动作');
    void ACTION_KINDS;
  });
});

describe('decide：红只对它当时那个 commit 有效（#911–#918 八张重复报帅单）', () => {
  // 实咬：#899/#894/#893/#890 四张一轮红，工人已返工推了新 head、帅位已重挂审官，
  // 指挥官仍按历史累计红轮 + 累计唤醒次数判「N 轮仍红、推了 3 次没闭环」，一夜开出 #911–#918。
  const OLD = 'oldhead000000000000000000000000000000aaa';
  const NEW = 'newhead000000000000000000000000000000bbb';

  it('①红打在旧 head、PR 已推新 head → 不报帅、不唤大脑（回到等审官）', async () => {
    const { decide, WAKE_LIMIT } = await CORE;
    const pr = { number: 899, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: NEW, body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 899: { reviews: [
        { state: 'CHANGES_REQUESTED', body: '三处要改', commit_id: OLD },
        { state: 'CHANGES_REQUESTED', body: '还有两处', commit_id: OLD },
      ] } } },
      wakeCounts: { 'pr:899': WAKE_LIMIT, [`pr:899@${OLD}`]: WAKE_LIMIT }, // 旧账（含旧 key 形态）一律不算在新 head 头上
    }));
    assert.equal(byKind(r, 'escalate').length, 0, '旧 head 的红不许再报帅（#911 就是这么来的）');
    assert.equal(byKind(r, 'wake-brain').length, 0, '旧 head 的红不许再唤大脑');
    assert.deepEqual(kinds(r), ['noop'], '推了新 head = 回到等审官，本轮无事可做');
  });

  it('②红就打在当前 head 且唤满 → 照常报帅 two-red（判别力反证：别把报帅一刀切废掉）', async () => {
    const { decide, WAKE_LIMIT } = await CORE;
    const pr = { number: 899, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: NEW, body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 899: { reviews: [
        { state: 'CHANGES_REQUESTED', body: '三处要改', commit_id: NEW },
        { state: 'CHANGES_REQUESTED', body: '还有两处', commit_id: NEW },
      ] } } },
      wakeCounts: { [`pr:899@${NEW}`]: WAKE_LIMIT },
    }));
    const e = byKind(r, 'escalate');
    assert.ok(e.some((a) => a.reason === 'two-red' && a.head === NEW), '当前 head 上两轮红 + 唤满，照样报帅换人');
  });

  it('②b 一轮红打在当前 head、预算没用完 → wake-brain，target 不变、wakeKey 带 head（act 按 head 记账）', async () => {
    const { decide } = await CORE;
    const pr = { number: 894, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: NEW, body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 894: { reviews: [{ state: 'CHANGES_REQUESTED', body: '一处要改', commit_id: NEW }] } } },
      wakeCounts: { 'pr:894': 99 }, // 旧 key 的天量累计不该影响新 head
    }));
    const w = byKind(r, 'wake-brain');
    assert.equal(w.length, 1, '当前 head 上的红照常唤大脑');
    assert.equal(w[0].target, 'pr:894', 'target 仍是人读得懂的 PR 号');
    assert.equal(w[0].wakeKey, `pr:894@${NEW}`, '记账 key 按 head 分桶');
    assert.equal(byKind(r, 'escalate').length, 0, '新 head 的账从 0 起算，不报帅');
  });

  it('③判别态 review 缺 commit_id → 判「没查成」：不清零也不报帅', async () => {
    const { decide, WAKE_LIMIT } = await CORE;
    const pr = { number: 893, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: NEW, body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 893: { reviews: [
        { state: 'CHANGES_REQUESTED', body: '三处要改' }, // 没 commit_id：不知道打在哪个 commit 上
        { state: 'CHANGES_REQUESTED', body: '还有两处' },
      ] } } },
      wakeCounts: { [`pr:893@${NEW}`]: WAKE_LIMIT },
    }));
    assert.equal(byKind(r, 'wake-brain').length, 0, '没查成不许当「仍红」去唤');
    const e = byKind(r, 'escalate');
    assert.ok(!e.some((a) => ['two-red', 'wake-exhausted'].includes(a.reason)), '没查成不许报帅');
    assert.ok(e.some((a) => a.reason === 'unscanned' && a.detail === 'commit-id-unscanned'), '没查成要 fail-visible');
    assert.ok(!kinds(r).includes('noop'), '没查成不能静默成 noop');
  });

  it('④PR headRefOid 没查成 → 判「没查成」：不清零也不报帅', async () => {
    const { decide, WAKE_LIMIT } = await CORE;
    const pr = { number: 890, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: null, body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 890: { reviews: [
        { state: 'CHANGES_REQUESTED', body: '三处要改', commit_id: OLD },
        { state: 'CHANGES_REQUESTED', body: '还有两处', commit_id: OLD },
      ] } } },
      wakeCounts: { 'pr:890': WAKE_LIMIT },
    }));
    assert.equal(byKind(r, 'wake-brain').length, 0);
    const e = byKind(r, 'escalate');
    assert.ok(!e.some((a) => ['two-red', 'wake-exhausted'].includes(a.reason)), 'head 没查成不许报帅');
    assert.ok(e.some((a) => a.reason === 'unscanned' && a.detail === 'head-unscanned' && (a.missing || []).includes('github')));
    assert.ok(!kinds(r).includes('noop'), '没查成不能静默成 noop');
  });

  it('analyzeReviewsAtHead：三种没查成各自可辨，且只数当前 head 的红', async () => {
    const { analyzeReviewsAtHead } = await CORE;
    assert.equal(analyzeReviewsAtHead(null, NEW).reason, 'reviews-missing');
    assert.equal(analyzeReviewsAtHead([], null).reason, 'head-unscanned');
    assert.equal(analyzeReviewsAtHead([{ state: 'CHANGES_REQUESTED' }], NEW).reason, 'commit-id-unscanned');
    // COMMENTED 不是判别态，缺 commit_id 也不算没查成
    const only = analyzeReviewsAtHead([{ state: 'COMMENTED', body: '随口一句' }], NEW);
    assert.equal(only.scanned, true);
    assert.equal(only.redRounds, 0);
    const mixed = analyzeReviewsAtHead([
      { state: 'CHANGES_REQUESTED', commit_id: OLD },
      { state: 'CHANGES_REQUESTED', commit_id: NEW },
    ], NEW);
    assert.equal(mixed.redRounds, 1, '只数当前 head 上的红');
    assert.equal(mixed.judgedTotal, 2);
    assert.equal(mixed.atHead, 1);
  });
});

describe('decide：自动路径边界（审官建议）', () => {
  it('任何输出的 kind 都在 ACTION_KINDS 内，绝不出现清树/写指纹/改 dao.mjs 类破坏动作', async () => {
    const { decide, ACTION_KINDS, FORBIDDEN_AUTO_KINDS, WAKE_LIMIT } = await CORE;
    const allowed = new Set(ACTION_KINDS);
    // 一份「样样都有」的态势：dispatch + merge + manual待拍板 + 一轮红wake + 两轮红唤满报帅 + stall wake + review-pending
    const situ = baseSituation({
      github: { scanned: true,
        issues: [{ number: 10, title: 'A', labels: [{ name: '已消歧' }, { name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }] }],
        prs: [
          { number: 20, isDraft: false, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], body: '' },
          { number: 21, isDraft: true, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', body: '' },
          { number: 22, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: 'h22', body: '' },
          { number: 23, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: 'h23', body: '' },
        ] },
      prReviews: { scanned: true, byPr: {
        20: { reviews: [{ state: 'APPROVED', body: '可以合' }] },
        22: { reviews: [{ state: 'CHANGES_REQUESTED', body: '一处要改', commit_id: 'h22' }] },
        23: { reviews: [{ state: 'CHANGES_REQUESTED', body: '三处', commit_id: 'h23' }, { state: 'CHANGES_REQUESTED', body: '两处', commit_id: 'h23' }] },
      } },
      reviewPending: { scanned: true, items: [{ pr: 30, reviewer: 'gpt-5.6-sol', worker: 'wt' }] },
      stall: { scanned: true, strikes: { term_z: { strikes: 2 } } },
      wakeCounts: { 'pr:23@h23': WAKE_LIMIT }, // 两轮红那张唤满，保住 escalate 分支的覆盖
    });
    const r = decide(situ);
    for (const a of r.actions) {
      assert.ok(allowed.has(a.kind), `未知 kind ${a.kind} 不在 ACTION_KINDS`);
      assert.ok(!FORBIDDEN_AUTO_KINDS.has(a.kind), `禁用自动动作 ${a.kind} 冒出来了`);
    }
    // 确认这份富态势确实覆盖了几类主动作（否则边界测试是空跑）
    assert.ok(kinds(r).includes('dispatch') && kinds(r).includes('merge') && kinds(r).includes('wake-brain') && kinds(r).includes('escalate'));
  });
});

describe('decide：空态势静默', () => {
  it('全查成、无待办 → 只 noop', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation());
    assert.deepEqual(kinds(r), ['noop']);
  });
});

function readyIssue(n, model = 'grok-4.6') {
  return {
    number: n, title: `单 ${n}`, labels: [
      { name: '已消歧' }, { name: `model/${model}` }, { name: 'reviewer/gpt-5.6-sol' }, { name: 'type/写码' },
    ],
  };
}

describe('decide：单轮派单上限（#849）', () => {
  it('15 张可派 → 一轮只派 maxDispatchPerRound 张，其余排队不 escalate', async () => {
    const { decide } = await CORE;
    const issues = Array.from({ length: 15 }, (_, i) => readyIssue(1000 + i));
    const r = decide(baseSituation({
      github: { scanned: true, issues, prs: [] },
      commanderPolicy: { maxDispatchPerRound: 2, requireModelInRouting: false },
    }));
    const d = byKind(r, 'dispatch');
    assert.equal(d.length, 2, `应只派 2 张，实际 ${d.length}`);
    assert.deepEqual(d.map((a) => a.issue), [1000, 1001]);
    assert.equal(byKind(r, 'escalate').filter((a) => a.reason !== 'unscanned').length, 0, '超上限不 escalate');
  });

  it('上限默认 2：不传 commanderPolicy 也截断', async () => {
    const { decide } = await CORE;
    const issues = Array.from({ length: 5 }, (_, i) => readyIssue(1100 + i));
    const r = decide(baseSituation({
      github: { scanned: true, issues, prs: [] },
      commanderPolicy: { requireModelInRouting: false },
    }));
    assert.equal(byKind(r, 'dispatch').length, 2);
  });
});

describe('decide：派前模型校验（#849）', () => {
  it('model 标签不在当前选型 → escalate 不派', async () => {
    const { decide } = await CORE;
    const issue = readyIssue(1200, 'devin-deepseek-v4-flash-max');
    const r = decide(baseSituation({
      github: { scanned: true, issues: [issue], prs: [] },
      commanderPolicy: { maxDispatchPerRound: 4, requireModelInRouting: true },
      routingModels: ['grok-4.6', 'deepseek-v4-flash'],
    }));
    assert.equal(byKind(r, 'dispatch').length, 0, '退役模型绝不派');
    const e = byKind(r, 'escalate');
    assert.ok(e.some((a) => a.reason === 'model-not-in-routing' && a.issue === 1200));
  });

  it('健康表 red → escalate 不派', async () => {
    const { decide } = await CORE;
    const issue = readyIssue(1201, 'deepseek-v4-flash');
    const r = decide(baseSituation({
      github: { scanned: true, issues: [issue], prs: [] },
      commanderPolicy: { maxDispatchPerRound: 4, requireModelInRouting: true },
      routingModels: ['grok-4.6', 'deepseek-v4-flash'],
      healthRedModels: ['deepseek-v4-flash'],
    }));
    assert.equal(byKind(r, 'dispatch').length, 0, '健康表红绝不派');
    assert.ok(byKind(r, 'escalate').some((a) => a.reason === 'model-health-red' && a.issue === 1201));
  });

  it('选型没查成（routingModels 不是数组）→ fail-closed 不派', async () => {
    const { decide } = await CORE;
    const issue = readyIssue(1202);
    const r = decide(baseSituation({
      github: { scanned: true, issues: [issue], prs: [] },
      commanderPolicy: { maxDispatchPerRound: 4, requireModelInRouting: true },
      routingModels: null,
    }));
    assert.equal(byKind(r, 'dispatch').length, 0);
    assert.ok(byKind(r, 'escalate').some((a) => a.reason === 'model-routing-unscanned'));
  });

  it('在选型且非红 → 照常派', async () => {
    const { decide } = await CORE;
    const issue = readyIssue(1203);
    const r = decide(baseSituation({
      github: { scanned: true, issues: [issue], prs: [] },
      commanderPolicy: { maxDispatchPerRound: 4, requireModelInRouting: true },
      routingModels: ['grok-4.6'],
      healthRedModels: [],
    }));
    assert.equal(byKind(r, 'dispatch').length, 1);
    assert.equal(byKind(r, 'dispatch')[0].issue, 1203);
  });
});

describe('心跳（假时钟）', () => {
  it('静默 ≥ 7 天 → due；不足 → 不 due；无锚点 → 不 due', async () => {
    const { heartbeatDue } = await CORE;
    const now = Date.parse('2026-09-10T00:00:00Z');
    const days = (n) => new Date(now - n * 86400000).toISOString();
    assert.equal(heartbeatDue({ state: { lastActivityAt: days(8) }, now }).due, true, '8 天静默要心跳');
    assert.equal(heartbeatDue({ state: { lastActivityAt: days(6) }, now }).due, false, '6 天不发');
    assert.equal(heartbeatDue({ state: {}, now }).due, false, '无锚点首轮不发');
    // 上次心跳也算动静：刚发过就不再发
    assert.equal(heartbeatDue({ state: { lastActivityAt: days(30), lastHeartbeatAt: days(1) }, now }).due, false, '刚心跳过不重发');
  });
});

describe('辅助纯函数', () => {
  it('hasLiveAction：noop 与纯 unscanned-escalate 不算动静；dispatch 算', async () => {
    const { hasLiveAction } = await CORE;
    assert.equal(hasLiveAction([{ kind: 'noop' }]), false);
    assert.equal(hasLiveAction([{ kind: 'escalate', reason: 'unscanned' }]), false);
    assert.equal(hasLiveAction([{ kind: 'dispatch', issue: 1 }]), true);
    assert.equal(hasLiveAction([{ kind: 'escalate', reason: 'two-red' }]), true, '报帅算动静');
  });

  it('actionsDigest：同一批动作稳定同键、顺序无关；noop 不入键', async () => {
    const { actionsDigest } = await CORE;
    const a = [{ kind: 'dispatch', issue: 1 }, { kind: 'merge', pr: 2 }];
    const b = [{ kind: 'merge', pr: 2 }, { kind: 'dispatch', issue: 1 }, { kind: 'noop' }];
    assert.equal(actionsDigest(a), actionsDigest(b));
  });

  it('analyzeReviews：数组外 → 没查成；两红两轮；绿；歪了', async () => {
    const { analyzeReviews } = await CORE;
    assert.equal(analyzeReviews(null).scanned, false);
    assert.equal(analyzeReviews(['判定：红 3 项', '复核结论：红 1 项']).redRounds, 2);
    assert.equal(analyzeReviews(['判定：绿，可合并']).green, true);
    assert.equal(analyzeReviews(['审官判定：绿']).green, false, '近义变体不算绿');
  });
});

describe('异步派工的真结果（2026-09-04 实咬：#787 派工失败，指挥官报「跑完」+群里发「已自动派单」）', () => {
  it('resultPathOf：从「已受理」输出里取结果文件路径；取不到回 null', async () => {
    const M = await import('file://' + path.join(__dirname, '..', 'scripts', 'commander.mjs').replace(/\\/g, '/'));
    assert.equal(M.resultPathOf('{"ok":true,"queued":true,"resultPath":"/tmp/x.out.json"}'), '/tmp/x.out.json');
    assert.equal(M.resultPathOf('前面有诊断行\n{"resultPath":"/tmp/y.json"}'), '/tmp/y.json');
    assert.equal(M.resultPathOf('不是 JSON'), null);
    assert.equal(M.resultPathOf('{"ok":true}'), null, '没有 resultPath 字段 = 拿不到');
  });

  it('classifyDispatchResult：成/败/没落盘三态分得开，受理不当成功', async () => {
    const M = await import('file://' + path.join(__dirname, '..', 'scripts', 'commander.mjs').replace(/\\/g, '/'));
    const good = M.classifyDispatchResult({ present: true, doc: { ok: true, workerCard: 'ISSUE-#815 工人' }, waitedMs: 5000 });
    assert.equal(good.ok, true);
    assert.match(good.card, /ISSUE-#815/);

    // 实咬那条：工人 TUI 等就绪失败
    const bad = M.classifyDispatchResult({ present: true, doc: { ok: false, error: '工人 TUI 等就绪失败：exit null' }, waitedMs: 60000 });
    assert.equal(bad.ok, false);
    assert.equal(bad.unscanned, false, '执行体明说失败 = 真失败，不是没查成');
    assert.match(bad.error, /TUI 等就绪失败/);

    const pending = M.classifyDispatchResult({ present: false, doc: null, waitedMs: 240000 });
    assert.equal(pending.ok, false);
    assert.equal(pending.unscanned, true, '还没落盘 = 没查成，既不算成也不算败');
    assert.match(pending.error, /没查成/);

    const garbage = M.classifyDispatchResult({ present: true, doc: null, waitedMs: 1000 });
    assert.equal(garbage.unscanned, true, '结果文件坏了也是没查成');
  });
});

describe('派工失败不许发喜报（2026-09-04 实咬：#787 派工失败，群里照样收到「已自动派单 #787」）', () => {
  const MOD = () => import('file://' + path.join(__dirname, '..', 'scripts', 'commander.mjs').replace(/\\/g, '/'));

  it('两单一成一败：败的那单不发 hub、多一条报帅；成的那单一切照旧（不许殃及池鱼）', async () => {
    const { runActions } = await MOD();
    // decide() 真实产出的顺序：dispatch(787) → notify-hub(787) → dispatch(815) → notify-hub(815)
    const actions = [
      { kind: 'dispatch', issue: 787, title: 'a' },
      { kind: 'notify-hub', issue: 787, moment: 'dispatched', subject: '已自动派单 #787' },
      { kind: 'dispatch', issue: 815, title: 'b' },
      { kind: 'notify-hub', issue: 815, moment: 'dispatched', subject: '已自动派单 #815' },
    ];
    const seen = [];
    const exec = (a) => {
      seen.push(a);
      if (a.kind === 'dispatch' && a.issue === 787) return { ok: false, unscanned: false, error: '工人 TUI 等就绪失败：exit null' };
      if (a.kind === 'dispatch') return { ok: true, card: 'ISSUE-#815 工人' };
      return { ok: true };
    };
    const out = runActions(actions, { exec });

    const hub787 = seen.filter(a => a.kind === 'notify-hub' && a.issue === 787);
    assert.equal(hub787.length, 0, '派工失败的单不许发「已自动派单」');
    const hub815 = seen.filter(a => a.kind === 'notify-hub' && a.issue === 815);
    assert.equal(hub815.length, 1, '成功的那单照发，不许殃及池鱼');
    const esc = seen.filter(a => a.kind === 'escalate');
    assert.equal(esc.length, 1);
    assert.equal(esc[0].reason, 'dispatch-failed');
    assert.equal(esc[0].issue, 787);
    assert.match(esc[0].why, /TUI 等就绪失败/);
    assert.deepEqual(out.failedIssues, ['787']);
  });

  it('没查成（结果没落盘）也拦喜报，但报帅理由分得开', async () => {
    const { runActions } = await MOD();
    const actions = [{ kind: 'dispatch', issue: 900 }, { kind: 'notify-hub', issue: 900, moment: 'dispatched' }];
    const seen = [];
    const exec = (a) => { seen.push(a); return a.kind === 'dispatch' ? { ok: false, unscanned: true, error: '派工结果还没落盘' } : { ok: true }; };
    runActions(actions, { exec });
    assert.equal(seen.filter(a => a.kind === 'notify-hub').length, 0);
    const esc = seen.find(a => a.kind === 'escalate');
    assert.equal(esc.reason, 'dispatch-unscanned', '没查成 ≠ 失败，报帅理由要分得开');
    assert.match(esc.why, /没查成/);
  });

  it('全成功时：不产生任何报帅，喜报照发（反证——不是把 hub 一律掐了）', async () => {
    const { runActions } = await MOD();
    const actions = [{ kind: 'dispatch', issue: 1 }, { kind: 'notify-hub', issue: 1 }, { kind: 'land' }];
    const seen = [];
    runActions(actions, { exec: (a) => { seen.push(a); return { ok: true }; } });
    assert.equal(seen.filter(a => a.kind === 'notify-hub').length, 1);
    assert.equal(seen.filter(a => a.kind === 'escalate').length, 0);
    assert.equal(seen.filter(a => a.kind === 'land').length, 1, '别的动作不受影响');
  });

  it('exec 返回 undefined 也算失败（防「什么都没返回」被当成功）', async () => {
    const { runActions } = await MOD();
    const seen = [];
    runActions([{ kind: 'dispatch', issue: 7 }, { kind: 'notify-hub', issue: 7 }], { exec: (a) => { seen.push(a); return undefined; } });
    assert.equal(seen.filter(a => a.kind === 'notify-hub').length, 0);
    assert.equal(seen.filter(a => a.kind === 'escalate').length, 1);
  });
});
