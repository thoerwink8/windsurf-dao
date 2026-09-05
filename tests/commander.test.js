// 服务器指挥官决策层（#800）。判别力铁律：#800 每条判据都有故意夹具钉死；
// 「没查成 ≠ 空态势」有专门红样本——把 scanned:false 当空处理会当场被抓。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('node:fs');

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
    reworkDispatched: {},
    // 旧夹具不测模型闸：默认关 requireModelInRouting，#849 新测显式打开。
    commanderPolicy: { maxDispatchPerRound: 20, requireModelInRouting: false },
    routingModels: ['grok-4.6', 'deepseek-v4-flash', 'gpt-5.6-sol'],
    healthRedModels: [],
    ...over,
  };
}
const kinds = (r) => r.actions.map((a) => a.kind);
const byKind = (r, k) => r.actions.filter((a) => a.kind === k);

// #931 返工夹具：判红的 PR 必须能回溯到署名 issue（返工工人的 model/reviewer 从那儿取）。
function labeledIssue(n, over = {}) {
  return { number: n, title: `单 ${n}`, labels: [
    { name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }, { name: 'type/写码' },
  ], ...over };
}
function redPr(n, head, issue) {
  return { number: n, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: head, body: `署名 issue #${issue}` };
}
function redReview(body, commit) { return { state: 'CHANGES_REQUESTED', body, commit_id: commit }; }

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

  // 2026-09-05 改夹具（断言一条没动）：原来用的是「只带 已消歧、两个派工标都没有」的单，
  // 而那正是坏行为的样子——它断言这种单必须炸单，于是每开一张记账单，指挥官下一轮就为它
  // 生一张 missing-labels 待拍板单（实测 #953 开单 6 分钟后 #954 就出来了，一天生了 8 张）。
  // **洞是带着绿测试出厂的，这条测试就是钉住它的那颗钉子。**
  // 真信号是**半标态**：有人打了一半停下。两个都没有 = 从没瞄准过派工车道，不是漏标。
  it('已消歧且派工标只打了一半（有 model 没 reviewer） → escalate 不猜（不产 dispatch）', async () => {
    const { decide } = await CORE;
    const issue = { number: 901, title: 'Y', labels: [{ name: '已消歧' }, { name: 'model/grok-4.6' }] };
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

  it('两条 CHANGES_REQUESTED + 白话正文（无判定行）→ 派返工工人，不是 noop 也不报帅（#857 红 1 判别 + #931）', async () => {
    const { decide } = await CORE;
    const pr = redPr(913, 'h913', 901);
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(901)], prs: [pr] },
      prReviews: { scanned: true, byPr: { 913: { reviews: [redReview('这里不对', 'h913'), redReview('还是不对', 'h913')], bodies: ['这里不对', '还是不对'] } } },
    }));
    assert.equal(byKind(r, 'merge').length, 0);
    const w = byKind(r, 'rework');
    assert.equal(w.length, 1, '判红就派返工工人，不许晾着');
    assert.equal(w[0].brief, '还是不对', '任务书带最后一条红项的全文');
    assert.equal(byKind(r, 'escalate').length, 0, '判红不再报帅（层 1 的唤醒预算整层删掉）');
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
  it('审官两轮仍红（都在当前 head）→ 派返工工人，不 merge、不报帅（#931 换掉 two-red 停手）', async () => {
    const { decide } = await CORE;
    const pr = redPr(930, 'h930', 902);
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(902)], prs: [pr] },
      prReviews: { scanned: true, byPr: { 930: { reviews: [redReview('三处要改', 'h930'), redReview('还有两处', 'h930')] } } },
    }));
    assert.equal(byKind(r, 'merge').length, 0, '红着绝不合');
    assert.equal(byKind(r, 'wake-brain').length, 0, '判红路径上的唤大脑整层已删');
    assert.equal(byKind(r, 'rework').length, 1, '两轮红照样派返工工人');
    assert.ok(!byKind(r, 'escalate').some((a) => ['two-red', 'wake-exhausted'].includes(a.reason)), 'two-red/wake-exhausted 两个报帅理由已随层 1 删掉');
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

  it('撞死指纹同 term 已唤 WAKE_LIMIT 次仍没闭环 → 转报帅，不再唤（唤醒预算只剩这条路，#931）', async () => {
    const { decide, WAKE_LIMIT } = await CORE;
    const r = decide(baseSituation({
      stall: { scanned: true, strikes: { term_q: { strikes: 2, sig: '/retry/i' } } },
      wakeCounts: { 'stall:term_q': WAKE_LIMIT },
    }));
    assert.equal(byKind(r, 'wake-brain').length, 0);
    assert.ok(byKind(r, 'escalate').some((a) => a.reason === 'wake-exhausted' && a.term === 'term_q'));
  });
});

describe('decide：唤大脑（要判断）', () => {

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

  it('红①绕过b：stall.scanned=false 但 strikes 有货（态势自相矛盾）→ 不产 wake-brain', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      stall: { scanned: false, error: '撞死指纹读不到', strikes: { term_b: { strikes: 3 } } },
    }));
    assert.equal(byKind(r, 'wake-brain').length, 0, 'stall 没查成时 wake-brain 一律不产');
    assert.ok(byKind(r, 'escalate').some((a) => a.reason === 'unscanned' && (a.missing || []).includes('stall')));
  });

  it('红①绕过d：orca.scanned=false + 当前 head 判红 → 不产 rework（返工也要建树，#931）', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(903)], prs: [redPr(4, 'h4', 903)] },
      prReviews: { scanned: true, byPr: { 4: { reviews: [redReview('一处要改', 'h4')] } } },
      orca: { scanned: false, error: 'worktree ps 没查成' },
    }));
    assert.equal(byKind(r, 'rework').length, 0, 'orca 没查成时 rework 一律不产');
    assert.equal(byKind(r, 'notify-hub').length, 0, '随附回流也一并不产');
    assert.ok(byKind(r, 'escalate').some((a) => a.reason === 'unscanned' && (a.missing || []).includes('orca')));
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

  it('①红打在旧 head、PR 已推新 head → 不报帅、不派返工（回到等审官）', async () => {
    const { decide, WAKE_LIMIT } = await CORE;
    const pr = redPr(899, NEW, 801);
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(801)], prs: [pr] },
      prReviews: { scanned: true, byPr: { 899: { reviews: [
        redReview('三处要改', OLD), redReview('还有两处', OLD),
      ] } } },
      wakeCounts: { 'pr:899': WAKE_LIMIT, [`pr:899@${OLD}`]: WAKE_LIMIT }, // 旧账一律不算在新 head 头上
    }));
    assert.equal(byKind(r, 'escalate').length, 0, '旧 head 的红不许再报帅（#911 就是这么来的）');
    assert.equal(byKind(r, 'rework').length, 0, '旧 head 的红不许派返工工人（否则每轮刷一个）');
    // 2026-09-05 改：'等审官'这个假设是错的——没有任何东西会去叫审官，PR 就此挂着（实咬 #890/#893/#896/#905 挂 10 小时）。
    // 新意图：仍不返工、不报帅，但要产一条 rereview 去叫审官看新 head。
    assert.deepEqual(kinds(r), ['rereview'], '推了新 head = 叫审官复审，不是干等');
  });

  it('②红就打在当前 head → 照常派返工工人（判别力反证：别把整条路一刀切废掉）', async () => {
    const { decide } = await CORE;
    const pr = redPr(899, NEW, 801);
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(801)], prs: [pr] },
      prReviews: { scanned: true, byPr: { 899: { reviews: [
        redReview('三处要改', NEW), redReview('还有两处', NEW),
      ] } } },
    }));
    const w = byKind(r, 'rework');
    assert.equal(w.length, 1, '当前 head 上的红照常派返工工人');
    assert.equal(w[0].head, NEW);
    assert.equal(w[0].redRounds, 2);
  });

  it('③判别态 review 缺 commit_id → 判「没查成」：不清零、不派返工', async () => {
    const { decide } = await CORE;
    const pr = redPr(893, NEW, 801);
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(801)], prs: [pr] },
      prReviews: { scanned: true, byPr: { 893: { reviews: [
        { state: 'CHANGES_REQUESTED', body: '三处要改' }, // 没 commit_id：不知道打在哪个 commit 上
        { state: 'CHANGES_REQUESTED', body: '还有两处' },
      ] } } },
    }));
    assert.equal(byKind(r, 'rework').length, 0, '没查成不许当「仍红」去派工');
    const e = byKind(r, 'escalate');
    assert.ok(e.some((a) => a.reason === 'unscanned' && a.detail === 'commit-id-unscanned'), '没查成要 fail-visible');
    assert.ok(!kinds(r).includes('noop'), '没查成不能静默成 noop');
  });

  it('④PR headRefOid 没查成 → 判「没查成」：不清零、不派返工', async () => {
    const { decide } = await CORE;
    const pr = { number: 890, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: null, body: '署名 issue #801' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(801)], prs: [pr] },
      prReviews: { scanned: true, byPr: { 890: { reviews: [
        redReview('三处要改', OLD), redReview('还有两处', OLD),
      ] } } },
    }));
    assert.equal(byKind(r, 'rework').length, 0);
    const e = byKind(r, 'escalate');
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
    assert.equal(mixed.judged.length, 1, 'judged 只带当前 head 上那几条原件（返工任务书要取红项全文）');
    assert.equal(mixed.judged[0].commit_id, NEW);
  });
});

describe('decide：判红 → 直接派返工工人（#931，删掉「唤大脑」整层）', () => {
  // 补丁链 rework-closure 第 0 层。断点：判红之后工人早已下班，
  // 大脑给的方案没有接收者（层 1 的 wake-brain / WAKE_LIMIT 整层已删）。
  const HEAD = 'headaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
  const OLDH = 'oldbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';
  const RED_FULL = [
    '## 判定：红 2 项',
    '',
    '1. `scripts/x.mjs:42` 拿历史累计当当前状态——期望改成按 head 过滤后再数。',
    '2. `tests/x.test.js` 缺判别力反证——期望补一条「去掉判据必翻红」的夹具。',
  ].join('\n');

  it('①当前 head 判红 → 产 rework，任务书带审官红项全文（不摘要）', async () => {
    const { decide, reworkKey } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(700)], prs: [redPr(701, HEAD, 700)] },
      prReviews: { scanned: true, byPr: { 701: { reviews: [redReview(RED_FULL, HEAD)] } } },
    }));
    const w = byKind(r, 'rework');
    assert.equal(w.length, 1, '当前 head 判红要派返工工人');
    assert.equal(w[0].pr, 701);
    assert.equal(w[0].head, HEAD);
    assert.equal(w[0].issue, 700, '署名 issue 从 PR 正文取，返工工人的选型跟它走');
    assert.equal(w[0].model, 'grok-4.6');
    assert.equal(w[0].reviewer, 'gpt-5.6-sol');
    assert.equal(w[0].brief, RED_FULL, '红项**全文**原样进任务书——一个字都不许摘要/改写');
    assert.equal(w[0].reworkKey, reworkKey(701, HEAD));
    assert.ok(byKind(r, 'notify-hub').some((a) => a.moment === 'dispatched' && a.pr === 701), '派了要回流');
    assert.equal(byKind(r, 'escalate').length, 0, '判红不报帅（层 0 的「报帅停手」也一起换掉了）');
    assert.equal(byKind(r, 'wake-brain').length, 0, '判红路径上不许再出现唤大脑');
  });

  it('②同一 PR 同一 head 第二轮 → 不重复派（去重键 rework:<pr>@<oid>）', async () => {
    const { decide, reworkKey } = await CORE;
    const situ = {
      github: { scanned: true, issues: [labeledIssue(700)], prs: [redPr(701, HEAD, 700)] },
      prReviews: { scanned: true, byPr: { 701: { reviews: [redReview(RED_FULL, HEAD)] } } },
    };
    const first = decide(baseSituation(situ));
    assert.equal(byKind(first, 'rework').length, 1);
    // act 侧派完记账，下一轮态势带着它进来
    const second = decide(baseSituation({
      ...situ,
      reworkDispatched: { [reworkKey(701, HEAD)]: { at: '2026-09-05T10:00:00Z', ok: true } },
    }));
    assert.equal(byKind(second, 'rework').length, 0, '同一 head 只派一次，否则每 20 分钟刷一个工人');
    assert.equal(byKind(second, 'notify-hub').length, 0, '随附回流也不许再发');
    assert.deepEqual(kinds(second), ['noop'], '返工工人在干活，本轮无事可做');
  });

  it('②b 工人推了新 head、审官又判红 → 新 head 是新账，照常再派一次', async () => {
    const { decide, reworkKey } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(700)], prs: [redPr(701, HEAD, 700)] },
      prReviews: { scanned: true, byPr: { 701: { reviews: [redReview('旧红', OLDH), redReview(RED_FULL, HEAD)] } } },
      reworkDispatched: { [reworkKey(701, OLDH)]: { at: '2026-09-05T08:00:00Z', ok: true } }, // 旧 head 那笔账
    }));
    assert.equal(byKind(r, 'rework').length, 1, '旧 head 派过不挡新 head');
    assert.equal(byKind(r, 'rework')[0].redRounds, 1, '只数当前 head 上的红');
  });

  it('③红打在旧 head（工人已推新 head）→ 不派返工（判别力核心：去掉这条判据每轮都会刷工人）', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(700)], prs: [redPr(701, HEAD, 700)] },
      prReviews: { scanned: true, byPr: { 701: { reviews: [redReview(RED_FULL, OLDH), redReview('还有两处', OLDH)] } } },
    }));
    assert.equal(byKind(r, 'rework').length, 0, '旧 head 的红不作数，不派返工');
    // 2026-09-05 改：原来这里钉的是 ['noop']——「回到等审官」。实咬证明没人会来叫审官，
    // #890/#893/#896/#905 就这样挂了 10 小时。改成产 rereview。
    assert.deepEqual(kinds(r), ['rereview'], '改叫审官复审——干等没人来');
  });

  it('④红项全文取不到（判了红没留正文）→ 按没查成走：不派、不报成功、不静默', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(700)], prs: [redPr(701, HEAD, 700)] },
      prReviews: { scanned: true, byPr: { 701: { reviews: [{ state: 'CHANGES_REQUESTED', body: '   ', commit_id: HEAD }] } } },
    }));
    assert.equal(byKind(r, 'rework').length, 0, '没红项全文不许派工');
    assert.equal(byKind(r, 'notify-hub').length, 0, '更不许发「已派返工工人」');
    const e = byKind(r, 'escalate');
    assert.ok(e.some((a) => a.reason === 'unscanned' && a.detail === 'rework-brief-unscanned'), '没查成要 fail-visible');
    assert.ok(!kinds(r).includes('noop'), '没查成不能静默成 noop');
  });

  it('④b PR 没有署名 issue / 署名 issue 没扫到 / 缺标签 / 模型不在选型 —— 四种都不派，理由各自可辨', async () => {
    const { decide } = await CORE;
    const reviews = { scanned: true, byPr: { 701: { reviews: [redReview(RED_FULL, HEAD)] } } };
    const noIssue = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [{ number: 701, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: HEAD, body: '正文里没有署名单号' }] },
      prReviews: reviews,
    }));
    assert.equal(byKind(noIssue, 'rework').length, 0);
    assert.ok(byKind(noIssue, 'escalate').some((a) => a.reason === 'rework-no-issue'));

    const issueGone = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [redPr(701, HEAD, 700)] },
      prReviews: reviews,
    }));
    assert.equal(byKind(issueGone, 'rework').length, 0);
    assert.ok(byKind(issueGone, 'escalate').some((a) => a.reason === 'unscanned' && a.detail === 'rework-issue-unscanned'));

    const noLabels = decide(baseSituation({
      github: { scanned: true, issues: [{ number: 700, title: '单 700', labels: [] }], prs: [redPr(701, HEAD, 700)] },
      prReviews: reviews,
    }));
    assert.equal(byKind(noLabels, 'rework').length, 0);
    assert.ok(byKind(noLabels, 'escalate').some((a) => a.reason === 'missing-labels' && a.pr === 701));

    const retired = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(700, { labels: [{ name: 'model/退役-4.0' }, { name: 'reviewer/gpt-5.6-sol' }] })], prs: [redPr(701, HEAD, 700)] },
      prReviews: reviews,
      commanderPolicy: { maxDispatchPerRound: 20, requireModelInRouting: true },
    }));
    assert.equal(byKind(retired, 'rework').length, 0, '模型不在选型不许派（#849 闸没被返工绕开）');
    assert.ok(byKind(retired, 'escalate').some((a) => a.reason === 'model-not-in-routing'));
  });

  it('⑤单轮返工上限沿用 maxDispatchPerRound：超出的排队下轮，不丢也不 escalate', async () => {
    const { decide } = await CORE;
    const issues = [];
    const prs = [];
    const byPr = {};
    for (let i = 0; i < 5; i += 1) {
      issues.push(labeledIssue(710 + i));
      prs.push(redPr(760 + i, `head${i}`, 710 + i));
      byPr[760 + i] = { reviews: [redReview(`第 ${i} 张的红项全文`, `head${i}`)] };
    }
    const r = decide(baseSituation({
      github: { scanned: true, issues, prs },
      prReviews: { scanned: true, byPr },
      commanderPolicy: { maxDispatchPerRound: 2, requireModelInRouting: false },
    }));
    const w = byKind(r, 'rework');
    assert.equal(w.length, 2, `一轮最多派 maxDispatchPerRound 个返工工人，实际 ${w.length}`);
    assert.deepEqual(w.map((a) => a.pr), [760, 761]);
    assert.equal(byKind(r, 'escalate').length, 0, '超上限是排队下轮，不是报帅');
    assert.equal(byKind(r, 'notify-hub').length, 2, '回流只跟着真派出去的那两个');
  });

  it('⑥判绿的 PR 不派返工（反证：别把 rework 变成「见 PR 就派」）', async () => {
    const { decide } = await CORE;
    const pr = { number: 702, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: HEAD, body: '署名 issue #700' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(700)], prs: [pr] },
      // 当前 head 上先红后绿：最后一条判别态是绿 → 等合并路，不返工
      prReviews: { scanned: true, byPr: { 702: { reviews: [redReview(RED_FULL, HEAD), { state: 'APPROVED', body: '改好了', commit_id: HEAD }] } } },
    }));
    assert.equal(byKind(r, 'rework').length, 0, '最后一条是绿就不返工');
  });

  it('latestRedBody：取当前 head 上最后一条红的全文；空正文/没有红 = 拿不到（null）', async () => {
    const { latestRedBody } = await CORE;
    assert.equal(latestRedBody([redReview('第一条', 'h'), redReview('第二条', 'h')]), '第二条');
    assert.equal(latestRedBody([redReview('真红', 'h'), { state: 'APPROVED', body: '绿', commit_id: 'h' }]), '真红');
    assert.equal(latestRedBody([{ state: 'CHANGES_REQUESTED', body: '', commit_id: 'h' }]), null);
    assert.equal(latestRedBody([{ state: 'APPROVED', body: '绿', commit_id: 'h' }]), null);
    assert.equal(latestRedBody(null), null);
  });
});

describe('act：返工的手（#931）', () => {
  const MOD = () => import('file://' + path.join(__dirname, '..', 'scripts', 'commander.mjs').replace(/\\/g, '/'));
  const os = require('os');
  const fs = require('fs');
  const action = {
    kind: 'rework', pr: 931, head: 'abcdef1234567890', issue: 873, redRounds: 1,
    model: 'grok-4.6', reviewer: 'gpt-5.6-sol', brief: '## 判定：红 1 项\n1. `a.mjs:1` 改这里。',
  };

  it('红项全文写完读回自证：读回对不上 → 没查成，不派工', async () => {
    const M = await MOD();
    const good = M.writeReworkBrief(action, {
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'rework-')),
      io: { mkdir: () => {}, write: () => {}, read: () => M.reworkBriefText(action) },
    });
    assert.equal(good.ok, true, '写完读回一致 = 查成了');
    const bad = M.writeReworkBrief(action, {
      dir: os.tmpdir(),
      io: { mkdir: () => {}, write: () => {}, read: () => '半截内容' },
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.unscanned, true, '读回对不上是「没查成」，不是「失败」也不是成功');
    const unreadable = M.writeReworkBrief(action, {
      dir: os.tmpdir(),
      io: { mkdir: () => {}, write: () => {}, read: () => { throw new Error('EACCES'); } },
    });
    assert.equal(unreadable.ok, false);
    assert.equal(unreadable.unscanned, true);
  });

  it('红项全文原样转录，不摘要不改写', async () => {
    const M = await MOD();
    const text = M.reworkBriefText(action);
    assert.ok(text.includes(action.brief), '全文必须一字不差地在里面');
    assert.ok(text.includes('abcdef1234567890'), '写清红项打在哪个 head 上');
  });

  it('返工注入指针过得了 500 字节硬闸（长红项不进注入，只进文件）', async () => {
    const M = await MOD();
    const tpl = await import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'template.mjs').replace(/\\/g, '/'));
    const spec = M.reworkSpec(action, '/home/orca/.dao/commander/rework/pr-931-abcdef12.md');
    const inject = tpl.buildSoldierInject({ spec, issue: action.issue });
    assert.ok(Buffer.byteLength(inject, 'utf8') <= tpl.INJECT_MAX_BYTES, `注入 ${Buffer.byteLength(inject, 'utf8')} 字节超闸`);
    assert.ok(spec.includes('gh pr checkout 931'), '要告诉工人怎么切到被审那条分支（树里没有被审代码它会编）');
    assert.ok(!spec.includes(action.brief), '红项正文不进注入');
  });

  it('返工派工没成 → 不发「已派返工工人」，改报帅（与 dispatch 同一条纪律，#787）', async () => {
    const { runActions } = await MOD();
    const actions = [
      { kind: 'rework', pr: 931, issue: 873 },
      { kind: 'notify-hub', pr: 931, moment: 'dispatched', subject: '已派返工工人' },
      { kind: 'rework', pr: 932, issue: 874 },
      { kind: 'notify-hub', pr: 932, moment: 'dispatched', subject: '已派返工工人' },
    ];
    const seen = [];
    const out = runActions(actions, { exec: (a) => {
      seen.push(a);
      if (a.kind === 'rework' && a.pr === 931) return { ok: false, error: '工人 TUI 起不来' };
      return { ok: true };
    } });
    const hubs = seen.filter((a) => a.kind === 'notify-hub').map((a) => a.pr);
    assert.deepEqual(hubs, [932], '失败那张的喜报必须被掐掉，成功那张照发');
    assert.ok(seen.some((a) => a.kind === 'escalate' && a.reason === 'rework-failed' && a.pr === 931));
    assert.deepEqual(out.failedPrs, ['931']);
  });

  it('返工结果「没查成」与「失败」分得开，且都不当成功', async () => {
    const { runActions } = await MOD();
    const seen = [];
    runActions([{ kind: 'rework', pr: 933, issue: 875 }], { exec: (a) => {
      seen.push(a);
      if (a.kind === 'rework') return { ok: false, unscanned: true, error: '派工结果还没落盘' };
      return { ok: true };
    } });
    const e = seen.find((a) => a.kind === 'escalate');
    assert.equal(e.reason, 'rework-unscanned', '没查成有自己的理由，不混进 rework-failed');
    assert.match(e.why, /不自动重派/, '同 head 不自动重派要写在报帅正文里');
  });
});

describe('decide：自动路径边界（审官建议）', () => {
  it('任何输出的 kind 都在 ACTION_KINDS 内，绝不出现清树/写指纹/改 dao.mjs 类破坏动作', async () => {
    const { decide, ACTION_KINDS, FORBIDDEN_AUTO_KINDS, WAKE_LIMIT } = await CORE;
    const allowed = new Set(ACTION_KINDS);
    // 一份「样样都有」的态势：dispatch + merge + manual待拍板 + 一轮红wake + 两轮红唤满报帅 + stall wake + review-pending
    const situ = baseSituation({
      github: { scanned: true,
        issues: [
          { number: 10, title: 'A', labels: [{ name: '已消歧' }, { name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }] },
          labeledIssue(11),
        ],
        prs: [
          { number: 20, isDraft: false, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], body: '' },
          { number: 21, isDraft: true, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', body: '' },
          redPr(22, 'h22', 11),
          { number: 23, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', headRefOid: 'h23', body: '正文里没有署名单号' },
        ] },
      prReviews: { scanned: true, byPr: {
        20: { reviews: [{ state: 'APPROVED', body: '可以合' }] },
        22: { reviews: [redReview('一处要改', 'h22')] },
        23: { reviews: [redReview('三处', 'h23'), redReview('两处', 'h23')] },
      } },
      reviewPending: { scanned: true, items: [{ pr: 30, reviewer: 'gpt-5.6-sol', worker: 'wt' }] },
      stall: { scanned: true, strikes: { term_z: { strikes: 2 } } },
      wakeCounts: {},
    });
    void WAKE_LIMIT;
    const r = decide(situ);
    for (const a of r.actions) {
      assert.ok(allowed.has(a.kind), `未知 kind ${a.kind} 不在 ACTION_KINDS`);
      assert.ok(!FORBIDDEN_AUTO_KINDS.has(a.kind), `禁用自动动作 ${a.kind} 冒出来了`);
    }
    // 确认这份富态势确实覆盖了几类主动作（否则边界测试是空跑）
    assert.ok(kinds(r).includes('dispatch') && kinds(r).includes('merge') && kinds(r).includes('rework')
      && kinds(r).includes('wake-brain') && kinds(r).includes('escalate'));
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

// 顶班（2026-09-05 实咬 #894/#896/#899）：快马单标着 model/claude-opus-5，服务器腿表里没有可派的腿，
// 返工被 escalate 掉，红项在 GitHub 上躺了 10 小时没人接。这三条钉死「派不出就顶班」而非「派不出就报帅」。
describe('decide：返工模型顶班（#894 实咬）', () => {
  function opusRework(over = {}) {
    const issue = labeledIssue(950, { labels: [
      { name: 'model/claude-opus-5' }, { name: 'reviewer/gpt-5.6-sol' }, { name: 'type/写码' },
    ] });
    const pr = redPr(951, 'h951', 950);
    return baseSituation({
      github: { scanned: true, issues: [issue], prs: [pr] },
      prReviews: { scanned: true, byPr: { 951: { reviews: [redReview('这里不对', 'h951')] } } },
      commanderPolicy: { maxDispatchPerRound: 20, requireModelInRouting: true },
      routingModels: ['grok-4.6', 'deepseek-v4-flash'],
      defaultWorkerModel: 'grok-4.6',
      ...over,
    });
  }

  it('原模型不在选型 → 顶班写码首选，不报帅', async () => {
    const { decide } = await CORE;
    const r = decide(opusRework());
    const w = byKind(r, 'rework');
    assert.equal(w.length, 1, '应当派返工而不是 escalate');
    assert.equal(w[0].model, 'grok-4.6');
    assert.equal(w[0].substitutedModel.from, 'claude-opus-5');
    assert.match(w[0].why, /顶班 grok-4.6/);
    assert.ok(!byKind(r, 'escalate').some((a) => a.reason === 'model-not-in-routing'));
  });

  it('没有顶班人选 → 仍报帅（不许自己猜一个模型）', async () => {
    const { decide } = await CORE;
    const r = decide(opusRework({ defaultWorkerModel: null }));
    assert.equal(byKind(r, 'rework').length, 0);
    assert.ok(byKind(r, 'escalate').some((a) => a.reason === 'model-not-in-routing'));
  });

  it('选型没查成 → 不顶班（顶班人选本身也验不了，fail-closed）', async () => {
    const { decide } = await CORE;
    const r = decide(opusRework({ routingModels: null }));
    assert.equal(byKind(r, 'rework').length, 0);
    assert.ok(byKind(r, 'escalate').some((a) => a.reason === 'model-routing-unscanned'));
  });
});

// 2026-09-05 实咬：同轮返工 #894 与 #899 共用署名 issue #891，第二张被 issue 级去重挡掉，红没人接。
// 返工的真去重在 state.reworkDispatched（PR+head，尝试即记），所以返工命令必须显式 --allow-dup。
describe('返工命令：显式放行 issue 级去重', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'commander.mjs'), 'utf8');
  it('dispatchRework 的命令带 --allow-dup', () => {
    const i = src.indexOf('function dispatchRework');
    assert.ok(i > -1, '找不到 dispatchRework——本闸判据失效，不是通过');
    const body = src.slice(i, i + 2600);
    assert.match(body, /'--allow-dup'/, '返工命令必须带 --allow-dup，否则同 issue 的第二张返工永远派不出去');
    assert.match(body, /reworkDispatched/, '放行的前提是返工自己有 PR\+head 去重，这行没了就不该放行');
  });
});

// 2026-09-05 实咬：自动合并的唯一入口是 pr.reviewDecision==='APPROVED'，而这个字段由 GitHub 按分支保护规则算，
// 本仓没开分支保护 ⇒ 恒为 null。审官判绿了，指挥官这一格永远进不去，PR 一直挂着等人——
// 「全流程无人工干预」从来没通过电就是死在这里。判绿改成按当前 head 看真 review。
describe('decide：判绿按真 review 而非 reviewDecision（实咬）', () => {
  function greenSit(over = {}) {
    const pr = {
      number: 960, title: 'Z', isDraft: false, reviewDecision: null, mergeable: 'MERGEABLE',
      headRefOid: 'h960', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], body: '',
      ...(over.pr || {}),
    };
    return baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 960: { reviews: over.reviews !== undefined ? over.reviews
        : [{ state: 'APPROVED', body: '看过了，可以合', commit_id: 'h960' }] } } },
    });
  }
  it('reviewDecision 为 null 但当前 head 上是 APPROVED → 照样 merge', async () => {
    const { decide } = await CORE;
    const r = decide(greenSit());
    assert.equal(byKind(r, 'merge').length, 1, 'reviewDecision 恒 null 的仓也必须能自动合');
    assert.equal(byKind(r, 'land').length, 1);
  });
  it('绿打在旧 head 上 → 不合（判绿只对它当时看的那个 commit 有效）', async () => {
    const { decide } = await CORE;
    const r = decide(greenSit({ reviews: [{ state: 'APPROVED', body: '旧的', commit_id: 'old' }] }));
    assert.equal(byKind(r, 'merge').length, 0);
  });
  it('当前 head 上是 CHANGES_REQUESTED → 不合，走返工', async () => {
    const { decide } = await CORE;
    const r = decide(greenSit({ reviews: [{ state: 'CHANGES_REQUESTED', body: '不行', commit_id: 'h960' }] }));
    assert.equal(byKind(r, 'merge').length, 0);
  });
});


// 跨仓感知（2026-09-05）：用户把 bot 授权从 1 个仓扩到 6 个之前，帅位对别的仓完全无感——
// ai-gateway-stack 挂着 3 条 open issue，而它正是本仓派工链的上游。
describe('跨仓感知只感知不派工', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'commander.mjs'), 'utf8');

  it('buildSituation 里真的采了这一面', () => {
    assert.match(src, /const otherRepos = scanOtherRepos\(\);/, '没采就等于没接');
    assert.match(src, /github, orca, reviewPending, prReviews, stall, otherRepos,/, '采了要放进态势');
  });

  it('不维护管辖清单——授权范围就是清单', () => {
    const i = src.indexOf('function scanOtherRepos');
    const fn = src.slice(i, src.indexOf('\n}', src.indexOf('byRepo.values()')) + 2);
    assert.match(fn, /--owner/, '用 owner 跨仓搜，授权能看见几个就是几个');
    assert.ok(!/\[\s*'[a-z-]+\/[a-z-]+'\s*,/.test(fn), '不许出现手写的仓清单——清单会过期');
  });

  it('跨仓没查成不许拦住本轮：它不在 health 的必查清单里', () => {
    const i = src.indexOf("const sections = ['github'");
    const line = src.slice(i, i + 200);
    assert.ok(!/otherRepos/.test(line),
      '跨仓查不到是别人家的事，不该让本仓这一轮判成没查成');
  });

  it('没查成要显形，不许静默成「别的仓都没事」', () => {
    assert.match(src, /otherRepos: situation\.otherRepos\?\.scanned[\s\S]{0,220}没查成/,
      '摘要里没查成必须写出来——「没查成」和「都没事」分不开就等于没查');
  });

  it('自己这个仓不算「别的仓」', () => {
    const i = src.indexOf('function scanOtherRepos');
    const fn = src.slice(i, src.indexOf('\n}', src.indexOf('byRepo.values()')) + 2);
    assert.match(fn, /full === mine/, '要把本仓排除掉，否则本仓的活会被当成跨仓提醒重报一遍');
  });
});

// ── 复审记账：记「派了」不记「成了」= 一次失败就永久卡死（2026-09-05 实咬第二次）──
//
// 第一次是 agent-stall-watch 的换人账本（10 个审官换人全失败，账本记成已处置，再不重试）。
// 第二次就在这里：#894/#899/#905 的复审票 04:22 写成功，审官起来就死（裸 pi 落错 provider 401），
// 7 小时后当前 head 判定仍是 0，而 `if (!reworkDispatched[rrKey])` 把这三张 PR 永久挡在门外。
//
// 判据的要害：**走到这个分支本身就是「上一次没落地」的证据**——判定真落了 atHead 就 > 0，进不来。
// 所以不需要 ok 字段，只要 tries + 宽限期。
describe('复审要能重试，因为「票写出去了」不等于「判定落了」', () => {
  const CORE = import('../scripts/lib/commander-core.mjs');
  const HEAD = 'f9adbffa1170c57559c64160081619acc328988f';
  const OLD = 'b5e672ea046ee7ce65055a31926bd164f3e1f84f';
  const NOW = '2026-09-05T12:00:00.000Z';
  const ago = (min) => new Date(Date.parse(NOW) - min * 60000).toISOString();
  const readyPr = (n, head, issue) => ({
    number: n, isDraft: false, mergeable: 'MERGEABLE', headRefOid: head, body: `署名 issue #${issue}`,
  });
  const sit = (over) => baseSituation({ at: NOW, ...over });

  it('①从没审过的 ready PR 也要叫审官——这一格原本整个空着（洞 A）', async () => {
    const { decide } = await CORE;
    const r = decide(sit({
      github: { scanned: true, issues: [labeledIssue(801)], prs: [readyPr(947, HEAD, 801)] },
      prReviews: { scanned: true, byPr: { 947: { reviews: [] } } },
    }));
    const rr = byKind(r, 'rereview');
    assert.equal(rr.length, 1, '交卷可合但一条判定都没有 = 要审官，不是无事可做');
    assert.equal(rr[0].pr, 947);
    assert.equal(rr[0].tries, 1);
    assert.match(rr[0].why, /一条判定都没有/, '首审和复审的理由要分得开');
  });

  it('②上一票超过宽限期而判定仍是 0 → 重发，tries 累加（洞 C）', async () => {
    const { decide } = await CORE;
    const r = decide(sit({
      github: { scanned: true, issues: [labeledIssue(801)], prs: [readyPr(899, HEAD, 801)] },
      prReviews: { scanned: true, byPr: { 899: { reviews: [redReview('两处要改', OLD)] } } },
      reworkDispatched: { [`rereview:899@${HEAD}`]: { at: ago(400), pr: 899, head: HEAD, kind: 'rereview', tries: 1 } },
    }));
    const rr = byKind(r, 'rereview');
    assert.equal(rr.length, 1, '票派过但判定没落 = 那次没成，必须再试');
    assert.equal(rr[0].tries, 2, 'tries 要累加，否则永远试不满也永远不报帅');
  });

  it('③宽限期内不重发——审官可能正在看，别每轮塞一张票', async () => {
    const { decide } = await CORE;
    const r = decide(sit({
      github: { scanned: true, issues: [labeledIssue(801)], prs: [readyPr(899, HEAD, 801)] },
      prReviews: { scanned: true, byPr: { 899: { reviews: [redReview('两处要改', OLD)] } } },
      reworkDispatched: { [`rereview:899@${HEAD}`]: { at: ago(10), pr: 899, head: HEAD, kind: 'rereview', tries: 1 } },
    }));
    assert.equal(byKind(r, 'rereview').length, 0, '10 分钟前刚派的票还在宽限期内');
    assert.equal(byKind(r, 'escalate').length, 0, '宽限期内也不报帅');
  });

  it('④试满仍无判定 → 停手报帅，不死循环', async () => {
    const { decide, MAX_REREVIEW_TRIES } = await CORE;
    const r = decide(sit({
      github: { scanned: true, issues: [labeledIssue(801)], prs: [readyPr(905, HEAD, 801)] },
      prReviews: { scanned: true, byPr: { 905: { reviews: [redReview('一处', OLD)] } } },
      reworkDispatched: { [`rereview:905@${HEAD}`]: { at: ago(400), pr: 905, head: HEAD, kind: 'rereview', tries: MAX_REREVIEW_TRIES } },
    }));
    assert.equal(byKind(r, 'rereview').length, 0, '试满就别再派了');
    const e = byKind(r, 'escalate');
    assert.equal(e.length, 1, '停手要出声——静默停手和「没事」分不开');
    assert.equal(e[0].reason, 'rereview-exhausted');
  });

  it('⑤判别力反证：判定已落在当前 head → 本分支一条都不产', async () => {
    const { decide } = await CORE;
    const r = decide(sit({
      github: { scanned: true, issues: [labeledIssue(801)], prs: [readyPr(886, HEAD, 801)] },
      prReviews: { scanned: true, byPr: { 886: { reviews: [redReview('要改', HEAD)] } } },
      reworkDispatched: {},
    }));
    assert.equal(byKind(r, 'rereview').length, 0, '当前 head 有判定了就不该再叫审官——否则这条规则没有判别力');
  });

  it('⑥态势没有 at 时不许把宽限期算成「早就过期」而狂发票', async () => {
    const { decide } = await CORE;
    const s = baseSituation({
      github: { scanned: true, issues: [labeledIssue(801)], prs: [readyPr(899, HEAD, 801)] },
      prReviews: { scanned: true, byPr: { 899: { reviews: [redReview('两处', OLD)] } } },
      reworkDispatched: { [`rereview:899@${HEAD}`]: { at: '2026-09-05T11:55:00.000Z', pr: 899, head: HEAD, kind: 'rereview', tries: 1 } },
    });
    delete s.at;
    const r = decide(s);
    // at 缺失 ⇒ nowMs=0 ⇒ ageMin 是大负数，Number.isFinite 为真且 < 宽限期 ⇒ 按「还在宽限期」处理，
    // 宁可这一轮不发，也不要因为时钟读不到就每 20 分钟塞一张票。
    assert.equal(byKind(r, 'rereview').length, 0, '时钟读不到时要保守，不许当成「早就该重发」');
  });
});
