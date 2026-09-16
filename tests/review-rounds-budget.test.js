// #1227：budget.per_issue.review_rounds_max 接到热路。
//
// 验收钉三件事：
//   1. 上限从 JSON 现算，库里不许手抄那个数
//   2. 故意超限样本当场被拦（指挥官 / 交卷）
//   3. 没读到上限 ≠ 当成 0，更不等于无限——三态分开
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

  it('dao.mjs 交卷 / 起审官都过闸', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'dao.mjs'), 'utf8');
    assert.match(src, /reviewRoundsBudget:\s*reviewRoundsBudgetOf/);
    assert.match(src, /judgeNextReviewRound/);
    assert.match(src, /REVIEW_ROUNDS_HALT/);
    assert.match(src, /reviewRoundsExceededError/);
  });

  it('scripts/ 里 review_rounds_max 出现在读 JSON 的库，不是再抄一份', () => {
    const lib = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'review-rounds-budget.mjs'), 'utf8');
    assert.match(lib, /budget\?\.per_issue\?\.review_rounds_max/);
  });
});
