// #1227：budget.per_issue.review_rounds_max 接到热路。
//
// 验收钉三件事：
//   1. 上限从 JSON 现算，库里不许手抄那个数
//   2. 故意超限样本当场被拦（指挥官 / 交卷）
//   3. 没读到上限 ≠ 当成 0，更不等于无限——三态分开
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const LIVE = path.join(REPO, 'docs', 'release-policy.json');
const LIB = import('file://' + path.join(REPO, 'scripts', 'lib', 'review-rounds-budget.mjs').replace(/\\/g, '/'));
const CORE = import('file://' + path.join(REPO, 'scripts', 'lib', 'commander-core.mjs').replace(/\\/g, '/'));
const WD = import('file://' + path.join(REPO, 'scripts', 'lib', 'dispatch', 'worker-done.mjs').replace(/\\/g, '/'));

function policyText(max) {
  return JSON.stringify({
    budget: { per_issue: { review_rounds_max: max, on_exceed: '停手，发总控群卡片上报' } },
  });
}

function red(commit, i) {
  return { state: 'CHANGES_REQUESTED', body: `红项 ${i}`, commit_id: commit };
}

function nReds(n, commit) {
  return Array.from({ length: n }, (_, i) => red(commit, i + 1));
}

function labeledIssue(n) {
  return {
    number: n, title: `单 ${n}`, body: '',
    labels: [
      { name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }, { name: 'type/写码' },
    ],
  };
}

function redPr(n, head, issue) {
  return {
    number: n, isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE',
    headRefOid: head, body: `署名 issue #${issue}`,
    labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }, { name: 'type/写码' }],
  };
}

function baseSituation(over = {}) {
  return {
    github: { scanned: true, issues: [], prs: [] },
    orca: { scanned: true, worktrees: [] },
    trees: { scanned: true, worktrees: [] },
    reviewPending: { scanned: true, items: [] },
    prReviews: { scanned: true, byPr: {} },
    stall: { scanned: true, strikes: {} },
    wakeCounts: {},
    reworkDispatched: {},
    commanderPolicy: { requireModelInRouting: false },
    routingModels: ['grok-4.6', 'gpt-5.6-sol'],
    healthRedModels: [],
    repo: 'thoerwink8/windsurf-dao',
    ...over,
  };
}

function kinds(r) {
  return r.actions.map((a) => a.kind);
}

function byKind(r, k) {
  return r.actions.filter((a) => a.kind === k);
}

function fakeGh({ title, labels, reviews = [], headRefName = 'dao-1', body = '署名 issue #1227' } = {}) {
  return (args) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      const want = String(args[args.indexOf('--json') + 1] || '');
      if (want === 'reviews') return { ok: true, out: JSON.stringify({ reviews }) };
      return {
        ok: true,
        out: JSON.stringify({
          title,
          body,
          labels: (labels || []).map((name) => ({ name })),
          headRefName,
          reviews,
        }),
      };
    }
    throw new Error('未预期的 gh 调用：' + args.join(' '));
  };
}

describe('parseReviewRoundsBudget：从 JSON 现算，不手抄', () => {
  it('仓内 docs/release-policy.json 读出的 max 等于文件里的键', async () => {
    const { parseReviewRoundsBudget } = await LIB;
    const live = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
    const parsed = parseReviewRoundsBudget(fs.readFileSync(LIVE, 'utf8'));
    assert.equal(parsed.unscanned, false);
    assert.equal(parsed.max, live.budget.per_issue.review_rounds_max);
    assert.equal(Number.isInteger(parsed.max), true);
    assert.ok(parsed.max >= 1);
  });

  it('夹具 max=2 读成 2，不是仓内那个数', async () => {
    const { parseReviewRoundsBudget } = await LIB;
    const parsed = parseReviewRoundsBudget(policyText(2));
    assert.equal(parsed.max, 2);
    const live = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
    assert.notEqual(parsed.max, live.budget.per_issue.review_rounds_max);
  });

  it('缺键 / 非正整数 / 坏 JSON → unscanned，不是 0 也不是无限', async () => {
    const { parseReviewRoundsBudget } = await LIB;
    assert.equal(parseReviewRoundsBudget('{}').unscanned, true);
    assert.equal(parseReviewRoundsBudget(policyText(0)).unscanned, true);
    assert.equal(parseReviewRoundsBudget('{').unscanned, true);
    assert.equal(parseReviewRoundsBudget(null).unscanned, true);
  });

  it('库源码不手抄上限数字', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'review-rounds-budget.mjs'), 'utf8');
    assert.equal(/review_rounds_max/.test(src), true, '必须读 JSON 键名');
    assert.equal(/\bmax\s*=\s*6\b/.test(src), false, '不许写 max = 6');
    assert.equal(/review_rounds_max["']?\s*:\s*6/.test(src), false, '不许在库里再抄一份 6');
  });
});

describe('judgeNextReviewRound：故意超限当场 exceeded', () => {
  it('max=2、2 条 CHANGES_REQUESTED → exceeded', async () => {
    const { judgeNextReviewRound } = await LIB;
    const got = judgeNextReviewRound({
      reviews: nReds(2, 'h'),
      budget: { max: 2 },
    });
    assert.equal(got.state, 'exceeded');
    assert.equal(got.rounds, 2);
    assert.equal(got.max, 2);
  });

  it('max=2、1 条 → ok，下一轮还允许', async () => {
    const { judgeNextReviewRound } = await LIB;
    const got = judgeNextReviewRound({
      reviews: nReds(1, 'h'),
      budget: { max: 2 },
    });
    assert.equal(got.state, 'ok');
    assert.equal(got.rounds, 1);
  });

  it('COMMENTED 不算一轮', async () => {
    const { judgeNextReviewRound } = await LIB;
    const got = judgeNextReviewRound({
      reviews: [{ state: 'COMMENTED', body: '闲聊' }, ...nReds(1, 'h')],
      budget: { max: 2 },
    });
    assert.equal(got.state, 'ok');
    assert.equal(got.rounds, 1);
  });

  it('没给 budget → skip；reviews 不是数组 → unscanned', async () => {
    const { judgeNextReviewRound } = await LIB;
    assert.equal(judgeNextReviewRound({ reviews: nReds(9, 'h') }).state, 'skip');
    assert.equal(judgeNextReviewRound({ reviews: null, budget: { max: 2 } }).state, 'unscanned');
  });
});

describe('decide：超限停手，不派返工/复审', () => {
  const HEAD = 'head111111111111111111111111111111111111';
  const OLD = 'old2222222222222222222222222222222222222';

  it('当前 head 上 2 轮红、max=2 → 打等用户标，不 rework', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(1227)], prs: [redPr(885, HEAD, 1227)] },
      prReviews: { scanned: true, byPr: { 885: { reviews: nReds(2, HEAD) } } },
      reviewRoundsBudget: { max: 2 },
    }));
    assert.equal(byKind(r, 'rework').length, 0, '超限不许再派返工');
    assert.equal(byKind(r, 'rereview').length, 0, '超限不许再叫审官');
    const stop = byKind(r, 'mark-exhausted');
    assert.equal(stop.length, 1);
    assert.equal(stop[0].verb, 'review-rounds');
    assert.equal(stop[0].label, '卡死/等用户');
    assert.equal(stop[0].tries, 2);
    assert.equal(stop[0].maxTries, 2);
    assert.equal(stop[0].hubAsk.number, 1227);
    assert.match(stop[0].comment, /审查轮次 2\/2/);
  });

  it('旧 head 上已经满了、新 head 零判定、max=2 → 不 rereview', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(1227)], prs: [redPr(885, HEAD, 1227)] },
      prReviews: { scanned: true, byPr: { 885: { reviews: nReds(2, OLD) } } },
      reviewRoundsBudget: { max: 2 },
    }));
    assert.equal(byKind(r, 'rereview').length, 0, '磨盘正是这条路：新 head 再叫一轮');
    assert.equal(byKind(r, 'rework').length, 0);
    assert.equal(byKind(r, 'mark-exhausted')[0].verb, 'review-rounds');
  });

  it('max=2、只红了 1 轮 → 仍派返工（闸没误伤）', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(700)], prs: [redPr(701, HEAD, 700)] },
      prReviews: {
        scanned: true,
        byPr: { 701: { reviews: [{ state: 'CHANGES_REQUESTED', body: '一处要改\n\n文件:行号', commit_id: HEAD }] } },
      },
      reviewRoundsBudget: { max: 2 },
    }));
    assert.equal(byKind(r, 'rework').length, 1);
    assert.equal(byKind(r, 'mark-exhausted').length, 0);
  });

  it('第 max 轮是绿 → 照合，不停手', async () => {
    const { decide } = await CORE;
    const pr = {
      number: 900, isDraft: false, mergeable: 'MERGEABLE', headRefOid: HEAD,
      body: '署名 issue #800',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      labels: [{ name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }],
    };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(800)], prs: [pr] },
      prReviews: {
        scanned: true,
        byPr: {
          900: {
            reviews: [
              ...nReds(1, HEAD),
              { state: 'APPROVED', body: '可以合', commit_id: HEAD },
            ],
          },
        },
      },
      reviewRoundsBudget: { max: 2 },
    }));
    assert.equal(byKind(r, 'merge').length, 1, '满额但最后一轮绿，照合');
    assert.equal(byKind(r, 'mark-exhausted').length, 0);
  });

  it('budget.unscanned + 当前 head 两条红 → escalate/unscanned，不 rework', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(1227)], prs: [redPr(885, HEAD, 1227)] },
      prReviews: { scanned: true, byPr: { 885: { reviews: nReds(2, HEAD) } } },
      reviewRoundsBudget: { unscanned: true, error: '故意没读到上限' },
    }));
    assert.equal(byKind(r, 'rework').length, 0, '策略没读到不许当无限预算去派返工');
    assert.equal(byKind(r, 'rereview').length, 0);
    assert.equal(byKind(r, 'attach-reviewer').length, 0);
    const un = byKind(r, 'escalate').filter((a) => a.detail === 'review-rounds-unscanned');
    assert.equal(un.length, 1);
    assert.equal(un[0].reason, 'unscanned');
    assert.match(un[0].why, /上限没查成/);
  });

  it('CONFLICTING + rounds>=max → 不派解冲突返工，打等用户标', async () => {
    const { decide } = await CORE;
    const pr = {
      ...redPr(885, HEAD, 1227),
      mergeable: 'CONFLICTING',
    };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(1227)], prs: [pr] },
      prReviews: { scanned: true, byPr: { 885: { reviews: nReds(2, HEAD) } } },
      reviewRoundsBudget: { max: 2 },
    }));
    assert.equal(byKind(r, 'rework').length, 0, '超限冲突不许再消耗一轮返工');
    const stop = byKind(r, 'mark-exhausted');
    assert.equal(stop.length, 1);
    assert.equal(stop[0].verb, 'review-rounds');
  });

  it('CONFLICTING + 策略可读但还没审过 → 仍派解冲突（缺 reviews 不是上限没查成）', async () => {
    const { decide } = await CORE;
    const pr = {
      ...redPr(885, HEAD, 1227),
      mergeable: 'CONFLICTING',
    };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(1227)], prs: [pr] },
      prReviews: { scanned: true, byPr: {} },
      reviewRoundsBudget: { max: 2 },
    }));
    assert.equal(byKind(r, 'rework').length, 1);
    assert.equal(byKind(r, 'rework')[0].conflict, true);
    assert.equal(byKind(r, 'escalate').filter((a) => a.detail === 'review-rounds-unscanned').length, 0);
  });

  it('已有「卡死/自动化认输」+ rounds=max → 仍打等用户标并发卡，不是 noop', async () => {
    const { decide } = await CORE;
    const pr = {
      ...redPr(885, HEAD, 1227),
      labels: [
        { name: '卡死/自动化认输' },
        { name: 'model/grok-4.6' },
        { name: 'reviewer/gpt-5.6-sol' },
        { name: 'type/写码' },
      ],
    };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(1227)], prs: [pr] },
      prReviews: { scanned: true, byPr: { 885: { reviews: nReds(2, HEAD) } } },
      reviewRoundsBudget: { max: 2 },
    }));
    assert.notEqual(kinds(r).join(','), 'noop', JSON.stringify(r.actions));
    assert.equal(byKind(r, 'rework').length, 0, '超限不许再派返工');
    assert.equal(byKind(r, 'rereview').length, 0);
    const stop = byKind(r, 'mark-exhausted');
    assert.equal(stop.length, 1, JSON.stringify(r.actions));
    assert.equal(stop[0].verb, 'review-rounds');
    assert.equal(stop[0].label, '卡死/等用户');
    assert.equal(stop[0].hubAsk.number, 1227);
    assert.match(stop[0].comment, /审查轮次 2\/2/);
  });

  it('已有「卡死/等用户」+ rounds=max → 仍产停手动作（执行侧幂等发卡），不是 noop', async () => {
    const { decide } = await CORE;
    const pr = {
      ...redPr(885, HEAD, 1227),
      labels: [
        { name: '卡死/等用户' },
        { name: 'model/grok-4.6' },
        { name: 'reviewer/gpt-5.6-sol' },
        { name: 'type/写码' },
      ],
    };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(1227)], prs: [pr] },
      prReviews: { scanned: true, byPr: { 885: { reviews: nReds(2, HEAD) } } },
      reviewRoundsBudget: { max: 2 },
    }));
    assert.notEqual(kinds(r).join(','), 'noop', JSON.stringify(r.actions));
    const stop = byKind(r, 'mark-exhausted');
    assert.equal(stop.length, 1);
    assert.equal(stop[0].label, '卡死/等用户');
    assert.ok(stop[0].hubAsk);
  });

  it('待审票 + 自动化认输标 + 已满轮次 → 不 attach-reviewer，仍停手上报', async () => {
    const { decide } = await CORE;
    const pr = {
      ...redPr(885, HEAD, 1227),
      labels: [
        { name: '卡死/自动化认输' },
        { name: 'model/grok-4.6' },
        { name: 'reviewer/gpt-5.6-sol' },
        { name: 'type/写码' },
      ],
    };
    const r = decide(baseSituation({
      github: {
        scanned: true, issues: [labeledIssue(1227)],
        prs: [pr],
      },
      prReviews: { scanned: true, byPr: { 885: { reviews: nReds(2, HEAD) } } },
      reviewPending: {
        scanned: true,
        items: [{ pr: 885, reviewer: 'gpt-5.6-sol', worker: 'wt-x', head: HEAD, source: 'worker-done-handoff' }],
      },
      reviewRoundsBudget: { max: 2 },
    }));
    assert.equal(byKind(r, 'attach-reviewer').length, 0);
    assert.equal(byKind(r, 'retry-drain').length, 0);
    const stop = byKind(r, 'mark-exhausted');
    assert.equal(stop.length, 1);
    assert.equal(stop[0].verb, 'review-rounds');
    assert.equal(stop[0].label, '卡死/等用户');
  });

  it('待审票 + 已满轮次 → 不 attach-reviewer', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: {
        scanned: true, issues: [labeledIssue(1227)],
        prs: [redPr(885, HEAD, 1227)],
      },
      prReviews: { scanned: true, byPr: { 885: { reviews: nReds(2, HEAD) } } },
      reviewPending: {
        scanned: true,
        items: [{ pr: 885, reviewer: 'gpt-5.6-sol', worker: 'wt-x', head: HEAD, source: 'worker-done-handoff' }],
      },
      reviewRoundsBudget: { max: 2 },
    }));
    assert.equal(byKind(r, 'attach-reviewer').length, 0);
    assert.equal(byKind(r, 'mark-exhausted').length, 1);
  });

  it('没注入 budget → 行为与接线前相同（1 轮红仍返工）', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(700)], prs: [redPr(701, HEAD, 700)] },
      prReviews: {
        scanned: true,
        byPr: { 701: { reviews: [{ state: 'CHANGES_REQUESTED', body: '一处要改\n\n文件:行号', commit_id: HEAD }] } },
      },
    }));
    assert.equal(byKind(r, 'rework').length, 1);
    assert.equal(kinds(r).includes('mark-exhausted'), false);
  });
});

describe('planWorkerDone：超限 halt，不起下一轮', () => {
  const labels = ['model/grok-4.6', 'reviewer/gpt-5.6-luna', 'type/写码'];

  it('已有 2 条判别态、max=2 → halt，仍算返工交卷', async () => {
    const { planWorkerDone } = await WD;
    const got = planWorkerDone({
      pr: '885',
      body: '返工完成：已改',
      reviewRoundsBudget: { max: 2 },
      runGh: fakeGh({
        title: '[cc] fix',
        labels,
        reviews: nReds(2, 'h'),
      }),
    });
    assert.equal(got.ok, true);
    assert.equal(got.round, 'rework');
    assert.equal(got.halt, 'review-rounds-exceeded');
    assert.equal(got.reviewRounds.rounds, 2);
  });

  it('budget.unscanned → halt，仍算交卷、不起下一轮', async () => {
    const { planWorkerDone } = await WD;
    const got = planWorkerDone({
      pr: '885',
      body: '返工完成：已改',
      reviewRoundsBudget: { unscanned: true, error: '故意没读到上限' },
      runGh: fakeGh({
        title: '[cc] fix',
        labels,
        reviews: nReds(2, 'h'),
      }),
    });
    assert.equal(got.ok, true);
    assert.equal(got.round, 'rework');
    assert.equal(got.halt, 'review-rounds-unscanned');
    assert.equal(got.reviewRounds.state, 'unscanned');
  });

  it('0 条 review、max=2 → 首审，不 halt', async () => {
    const { planWorkerDone } = await WD;
    const got = planWorkerDone({
      pr: '885',
      body: '完工：首审',
      reviewRoundsBudget: { max: 2 },
      runGh: fakeGh({ title: '[cc] fix', labels, reviews: [] }),
    });
    assert.equal(got.ok, true);
    assert.equal(got.round, 'first');
    assert.equal(got.halt, null);
  });
});

describe('热路真的读了这个模块', () => {
  it('commander.mjs scan 注入 reviewRoundsBudget', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'commander.mjs'), 'utf8');
    assert.match(src, /reviewRoundsBudget:\s*loadReviewRoundsBudgetFile/);
    assert.match(src, /askReviewRoundsCard/);
  });

  it('worker-done 超限/unscanned 非 dry-run 早退都停当前会话', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'dao.mjs'), 'utf8');
    const start = src.indexOf('async function cmdWorkerDoneMirasim');
    const end = src.indexOf('async function cmdStartMirasim', start);
    assert.ok(start > 0, 'cmdWorkerDoneMirasim 没了');
    assert.ok(end > start, 'cmdWorkerDoneMirasim 切不到 cmdStartMirasim');
    const fn = src.slice(start, end);
    const haltIf = fn.indexOf('if (plan.halt === REVIEW_ROUNDS_HALT || plan.halt === REVIEW_ROUNDS_UNSCANNED)');
    assert.ok(haltIf > 0, '超限早退分支丢了');
    const haltBlock = fn.slice(haltIf, fn.indexOf("if (plan.round === 'first')", haltIf));
    assert.match(haltBlock, /REVIEW_ROUNDS_HALT/);
    assert.match(haltBlock, /REVIEW_ROUNDS_UNSCANNED/);
    assert.match(haltBlock, /stopSessionsAtCwd/);
    assert.match(haltBlock, /\bstopped\b/);
    assert.match(haltBlock, /交卷后停会话/);
    assert.match(haltBlock, /stopped\.ok !== true|stopped\.ok === false/);
    assert.doesNotMatch(haltBlock, /dryRun/);
  });

  it('execMarkExhausted 已有自动化认输时升级为等用户，不是整段旁路', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'commander.mjs'), 'utf8');
    const i = src.indexOf('function execMarkExhausted');
    const j = src.indexOf('\nfunction execOpenIssue', i);
    assert.ok(i > 0, 'execMarkExhausted 没了');
    assert.ok(j > i, 'execMarkExhausted 切不到 execOpenIssue');
    const body = src.slice(i, j);
    assert.match(body, /upgradeFromExhausted/);
    assert.match(body, /--remove-label',\s*EXHAUSTED_LABEL/);
    assert.match(body, /WAITING_USER_LABEL/);
    assert.match(body, /askReviewRoundsCard/);
    assert.match(body, /hasExhausted && !useWaiting/);
  });

  it('dao.mjs 交卷 / 起审官都过闸，读目标仓策略，unscanned 也拦', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'dao.mjs'), 'utf8');
    assert.equal(
      (src.match(/reviewRoundsBudgetOf\(targetRepo\.localPath\)/g) || []).length,
      2,
      'reviewer-create / worker-done 都要按目标仓路径读策略',
    );
    assert.doesNotMatch(src, /reviewRoundsBudgetOf\(\)/);
    assert.match(src, /judgeNextReviewRound/);
    assert.match(src, /REVIEW_ROUNDS_HALT/);
    assert.match(src, /REVIEW_ROUNDS_UNSCANNED/);
    assert.match(src, /reviewRoundsExceededError/);
    assert.match(src, /reviewRoundsUnscannedError/);
    assert.match(src, /nextReviewRoundBlocked/);
  });

  it('scripts/ 里 review_rounds_max 出现在读 JSON 的库，不是再抄一份', () => {
    const lib = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'review-rounds-budget.mjs'), 'utf8');
    assert.match(lib, /budget\?\.per_issue\?\.review_rounds_max/);
  });
});

function lastJson(r) {
  try { return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); }
  catch { return { raw: r.stdout, err: r.stderr }; }
}

function writePolicyRepo(max) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-1227-budget-'));
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  const live = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
  if (max == null) return dir;
  live.budget.per_issue.review_rounds_max = max;
  fs.writeFileSync(path.join(dir, 'docs', 'release-policy.json'), JSON.stringify(live));
  return dir;
}

function cliBudget(verb, repoPath) {
  return spawnSync(process.execPath, [
    path.join(REPO, 'scripts', 'dao.mjs'),
    verb, '--pr', '50', '--executor', 'mirasim', '--dry-run',
    '--repo', repoPath,
  ], {
    encoding: 'utf8',
    cwd: REPO,
    env: {
      ...process.env,
      DAO_GH_FAKE: path.join(REPO, 'tests', 'fixtures', 'fake-gh.mjs'),
    },
  });
}

describe('热路：跨仓读目标仓策略，unscanned 当场拦', () => {
  it('目标仓改 review_rounds_max 后 reviewer-create / worker-done 跟着变', () => {
    const tight = writePolicyRepo(1);
    const loose = writePolicyRepo(6);
    try {
      const createTight = cliBudget('reviewer-create', tight);
      const pCreateTight = lastJson(createTight);
      assert.notEqual(createTight.status, 0, JSON.stringify(pCreateTight));
      assert.match(String(pCreateTight.error || ''), /review-rounds-exceeded/);

      const createLoose = cliBudget('reviewer-create', loose);
      const pCreateLoose = lastJson(createLoose);
      assert.equal(createLoose.status, 0, JSON.stringify({ payload: pCreateLoose, stderr: createLoose.stderr }));
      assert.equal(pCreateLoose.ok, true);
      assert.notEqual(pCreateLoose.reviewRounds && pCreateLoose.reviewRounds.state, 'exceeded');

      const doneTight = cliBudget('worker-done', tight);
      const pDoneTight = lastJson(doneTight);
      assert.equal(doneTight.status, 0, JSON.stringify(pDoneTight));
      assert.equal(pDoneTight.halt, 'review-rounds-exceeded');
      assert.equal(pDoneTight.action, 'review-rounds-exceeded');

      const doneLoose = cliBudget('worker-done', loose);
      const pDoneLoose = lastJson(doneLoose);
      assert.equal(doneLoose.status, 0, JSON.stringify(pDoneLoose));
      assert.equal(pDoneLoose.halt, null);
      assert.notEqual(pDoneLoose.action, 'review-rounds-exceeded');
    } finally {
      fs.rmSync(tight, { recursive: true, force: true });
      fs.rmSync(loose, { recursive: true, force: true });
    }
  });

  it('目标仓缺策略文件 → reviewer-create 拒；worker-done 交卷但不入下一轮', () => {
    const missing = writePolicyRepo(null);
    try {
      const create = cliBudget('reviewer-create', missing);
      const pCreate = lastJson(create);
      assert.notEqual(create.status, 0, JSON.stringify(pCreate));
      assert.match(String(pCreate.error || ''), /review-rounds-unscanned/);

      const done = cliBudget('worker-done', missing);
      const pDone = lastJson(done);
      assert.equal(done.status, 0, JSON.stringify(pDone));
      assert.equal(pDone.halt, 'review-rounds-unscanned');
      assert.equal(pDone.action, 'review-rounds-unscanned');
      assert.notEqual(pDone.action, 'queued-for-review');
    } finally {
      fs.rmSync(missing, { recursive: true, force: true });
    }
  });
});
