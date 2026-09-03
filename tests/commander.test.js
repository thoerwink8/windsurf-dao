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
      prReviews: { scanned: true, byPr: { 910: { bodies: ['判定：绿，可合并'] } } },
    }));
    assert.equal(byKind(r, 'merge').length, 1);
    assert.equal(byKind(r, 'land').length, 1, '合并后调 land（幂等）');
    assert.ok(byKind(r, 'notify-hub').some((a) => a.moment === 'merged'));
  });

  it('判绿但 CI 红 → 不 merge，报帅 + 卡壳回流', async () => {
    const { decide } = await CORE;
    const pr = {
      number: 911, isDraft: false, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }], body: '',
    };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 911: { bodies: ['判定：绿，可合并'] } } },
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
  it('审官两轮仍红 → escalate（不 merge、不 wake-brain）（判据②）', async () => {
    const { decide } = await CORE;
    const pr = { number: 930, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 930: { bodies: ['判定：红 3 项', '复核结论：红 2 项'] } } },
    }));
    assert.equal(byKind(r, 'merge').length, 0, '两轮红绝不合');
    assert.equal(byKind(r, 'wake-brain').length, 0, '两轮红不再唤大脑，直接报帅');
    const e = byKind(r, 'escalate');
    assert.ok(e.some((a) => a.reason === 'two-red'), '要有 two-red 报帅');
  });

  it('COMMENT 近义变体不算判别态，不 escalate malformed', async () => {
    const { decide } = await CORE;
    const pr = { number: 931, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 931: { bodies: ['审官判定：绿'] } } },
    }));
    assert.equal(byKind(r, 'merge').length, 0);
    assert.ok(!byKind(r, 'escalate').some((a) => a.reason === 'malformed-judgment'));
  });

  it('同单已唤大脑 WAKE_LIMIT 次仍没闭环 → 转报帅，不再唤', async () => {
    const { decide, WAKE_LIMIT } = await CORE;
    const pr = { number: 932, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 932: { bodies: ['判定：红 1 项'] } } },
      wakeCounts: { 'pr:932': WAKE_LIMIT },
    }));
    assert.equal(byKind(r, 'wake-brain').length, 0);
    assert.ok(byKind(r, 'escalate').some((a) => a.reason === 'wake-exhausted'));
  });
});

describe('decide：唤大脑（要判断）', () => {
  it('审官判红一轮 → wake-brain（有 target）（判据③）', async () => {
    const { decide } = await CORE;
    const pr = { number: 940, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 940: { bodies: ['判定：红 2 项'] } } },
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
    const pr = { number: 2, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', body: '' };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [], prs: [pr] },
      prReviews: { scanned: true, byPr: { 2: { bodies: ['判定：红 1 项'] } } },
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

describe('decide：自动路径边界（审官建议）', () => {
  it('任何输出的 kind 都在 ACTION_KINDS 内，绝不出现清树/写指纹/改 dao.mjs 类破坏动作', async () => {
    const { decide, ACTION_KINDS, FORBIDDEN_AUTO_KINDS } = await CORE;
    const allowed = new Set(ACTION_KINDS);
    // 一份「样样都有」的态势：dispatch + merge + manual待拍板 + 一轮红wake + 两轮红报帅 + stall wake + review-pending
    const situ = baseSituation({
      github: { scanned: true,
        issues: [{ number: 10, title: 'A', labels: [{ name: '已消歧' }, { name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }] }],
        prs: [
          { number: 20, isDraft: false, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], body: '' },
          { number: 21, isDraft: true, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', body: '' },
          { number: 22, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', body: '' },
          { number: 23, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', body: '' },
        ] },
      prReviews: { scanned: true, byPr: {
        20: { bodies: ['判定：绿，可合并'] },
        22: { bodies: ['判定：红 1 项'] },
        23: { bodies: ['判定：红 3 项', '复核结论：红 2 项'] },
      } },
      reviewPending: { scanned: true, items: [{ pr: 30, reviewer: 'gpt-5.6-sol', worker: 'wt' }] },
      stall: { scanned: true, strikes: { term_z: { strikes: 2 } } },
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
