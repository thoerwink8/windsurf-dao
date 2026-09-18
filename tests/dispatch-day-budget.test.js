// #1227：budget.per_day.dispatch_max 接到热路。
//
// 验收钉三件事：
//   1. 上限从 JSON 现算，库里不许手抄 20
//   2. 故意超限样本当场被拦（指挥官 / 起会话）
//   3. 没读到上限 ≠ 当成 0，更不等于无限——三态分开
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIVE = path.join(REPO, 'docs', 'release-policy.json');
const toUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const LIB = import(toUrl(path.join(REPO, 'scripts', 'lib', 'dispatch-day-budget.mjs')));
const CORE = import(toUrl(path.join(REPO, 'scripts', 'lib', 'commander-core.mjs')));
const BOARD = import(toUrl(path.join(REPO, 'scripts', 'lib', 'board-v0.mjs')));
const COLLECT = import(toUrl(path.join(REPO, 'scripts', 'lib', 'board-collect.mjs')));

const DAY = '2026-09-09T12:00:00+08:00';
const OTHER = '2026-09-08T12:00:00+08:00';

function policyText(max) {
  return JSON.stringify({
    budget: { per_day: { dispatch_max: max, on_exceed: '排队到次日' } },
  });
}

function workerEv(ts, extra = {}) {
  return {
    type: 'job.dispatch',
    identity: '工人',
    source: 'dao-dispatch-mirasim',
    ts,
    ...extra,
  };
}

function nWorkers(n, ts = DAY) {
  return Array.from({ length: n }, (_, i) => workerEv(ts, { job_id: `j${i}` }));
}

function labeledReady(n) {
  return {
    number: n, title: `单 ${n}`, body: '',
    labels: [
      { name: '已消歧' }, { name: 'model/grok-4.6' },
      { name: 'reviewer/gpt-5.6-sol' }, { name: 'type/写码' },
    ],
  };
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
    at: DAY,
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
    ...over,
  };
}

function kinds(r) {
  return r.actions.map((a) => a.kind);
}

function byKind(r, k) {
  return r.actions.filter((a) => a.kind === k);
}

describe('parseDispatchDayBudget：从 JSON 现算，不手抄', () => {
  it('仓内 docs/release-policy.json 读出的 max 等于文件里的键', async () => {
    const { parseDispatchDayBudget } = await LIB;
    const live = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
    const parsed = parseDispatchDayBudget(fs.readFileSync(LIVE, 'utf8'));
    assert.equal(parsed.unscanned, false);
    assert.equal(parsed.max, live.budget.per_day.dispatch_max);
    assert.equal(Number.isInteger(parsed.max), true);
    assert.ok(parsed.max >= 1);
  });

  it('夹具 max=2 读成 2，不是仓内那个数', async () => {
    const { parseDispatchDayBudget } = await LIB;
    const parsed = parseDispatchDayBudget(policyText(2));
    assert.equal(parsed.unscanned, false);
    assert.equal(parsed.max, 2);
    const live = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
    assert.notEqual(parsed.max, live.budget.per_day.dispatch_max);
  });

  it('缺键 / 坏 JSON → unscanned，不是 0', async () => {
    const { parseDispatchDayBudget } = await LIB;
    assert.equal(parseDispatchDayBudget('{"budget":{}}').unscanned, true);
    assert.equal(parseDispatchDayBudget('{').unscanned, true);
    assert.equal(parseDispatchDayBudget(null).unscanned, true);
  });

  it('库源码不手抄上限数字', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'dispatch-day-budget.mjs'), 'utf8');
    assert.equal(/dispatch_max/.test(src), true, '必须读 JSON 键名');
    assert.equal(/\bmax\s*=\s*20\b/.test(src), false, '不许写 max = 20');
    assert.equal(/dispatch_max["']?\s*:\s*20/.test(src), false, '不许在库里再抄一份 20');
  });

  it('指挥官与 dao 热路注入/过闸', () => {
    const commander = fs.readFileSync(path.join(REPO, 'scripts', 'commander.mjs'), 'utf8');
    const dao = fs.readFileSync(path.join(REPO, 'scripts', 'dao.mjs'), 'utf8');
    assert.match(commander, /dispatchDayBudget:\s*loadDispatchDayBudgetFile/);
    assert.match(dao, /judgeLiveDispatchDay/);
    assert.match(dao, /nextDispatchDayBlocked/);
  });
});

describe('isCountedDispatch / countDayDispatches：09-09 那 288 次的口径', () => {
  it('工人 dao-dispatch-mirasim 计入；审官、回填、开 PR 不计入', async () => {
    const { isCountedDispatch, countDayDispatches } = await LIB;
    assert.equal(isCountedDispatch(workerEv(DAY)), true);
    assert.equal(isCountedDispatch({ ...workerEv(DAY), source: 'dao-dispatch' }), true);
    assert.equal(isCountedDispatch({ ...workerEv(DAY), identity: '审官', source: 'reviewer-create' }), false);
    assert.equal(isCountedDispatch({ ...workerEv(DAY), source: 'github-backfill' }), false);
    assert.equal(isCountedDispatch({ ...workerEv(DAY), source: 'dao-pr-open' }), false);
    const events = [
      ...nWorkers(2, DAY),
      { type: 'job.dispatch', identity: '审官', source: 'reviewer-create', ts: DAY },
      { type: 'job.dispatch', identity: '工人', source: 'github-backfill', ts: DAY },
      { type: 'job.dispatch', identity: '工人', source: 'dao-pr-open', ts: DAY },
      workerEv(OTHER),
    ];
    assert.equal(countDayDispatches(events, '2026-09-09'), 2);
  });
});

describe('judgeDispatchDay：三态', () => {
  it('count>=max → exceeded；少一次 → ok；账没给 → unscanned', async () => {
    const { parseDispatchDayBudget, judgeDispatchDay } = await LIB;
    const budget = parseDispatchDayBudget(policyText(2));
    assert.equal(judgeDispatchDay({ events: nWorkers(2), budget, now: DAY }).state, 'exceeded');
    assert.equal(judgeDispatchDay({ events: nWorkers(1), budget, now: DAY }).state, 'ok');
    assert.equal(judgeDispatchDay({ events: nWorkers(0), budget, now: DAY }).count, 0);
    assert.equal(judgeDispatchDay({ events: null, budget, now: DAY }).state, 'unscanned');
    assert.equal(judgeDispatchDay({ events: nWorkers(9), budget: null, now: DAY }).state, 'skip');
    assert.equal(judgeDispatchDay({ events: nWorkers(2), budget: { unscanned: true, error: 'x' }, now: DAY }).state, 'unscanned');
  });
});

describe('decide：超限不派工人，审官路仍可走', () => {
  it('已消歧标齐 + 今日已满 → 不 dispatch，通知排队到次日', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledReady(900)], prs: [] },
      dispatchDayBudget: { max: 2 },
      dispatchLedger: { scanned: true, events: nWorkers(2) },
    }));
    assert.equal(byKind(r, 'dispatch').length, 0, JSON.stringify(kinds(r)));
    const hubs = byKind(r, 'notify-hub').filter((a) => /排队到次日/.test(a.subject || ''));
    assert.equal(hubs.length, 1, JSON.stringify(r.actions));
    assert.equal(hubs[0].count, 2);
    assert.equal(hubs[0].max, 2);
  });

  it('今日 1 次、max=2 → 仍派', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledReady(900)], prs: [] },
      dispatchDayBudget: { max: 2 },
      dispatchLedger: { scanned: true, events: nWorkers(1) },
    }));
    assert.equal(byKind(r, 'dispatch').length, 1);
  });

  it('预算没查成 → 不派，escalate/unscanned', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledReady(900)], prs: [] },
      dispatchDayBudget: { unscanned: true, error: '故意没读到上限' },
      dispatchLedger: { scanned: true, events: [] },
    }));
    assert.equal(byKind(r, 'dispatch').length, 0);
    const un = byKind(r, 'escalate').filter((a) => a.detail === 'dispatch-day-unscanned');
    assert.equal(un.length, 1);
    assert.equal(un[0].reason, 'unscanned');
  });

  it('账本没查成 + 预算已注入 → 不派（没查成不许当 0 次）', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledReady(900)], prs: [] },
      dispatchDayBudget: { max: 2 },
      dispatchLedger: { scanned: false, error: '账本挂了', events: [] },
    }));
    assert.equal(byKind(r, 'dispatch').length, 0);
    const un = byKind(r, 'escalate').filter((a) => a.detail === 'dispatch-day-unscanned');
    assert.equal(un.length, 1);
  });

  it('没注入 budget → 行为与接线前相同（标齐仍派）', async () => {
    const { decide } = await CORE;
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledReady(900)], prs: [] },
    }));
    assert.equal(byKind(r, 'dispatch').length, 1);
  });

  it('当前 head 红 + 今日已满 → 不返工', async () => {
    const { decide } = await CORE;
    const HEAD = 'abc123def';
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledIssue(700)], prs: [redPr(701, HEAD, 700)] },
      prReviews: {
        scanned: true,
        byPr: { 701: { reviews: [{ state: 'CHANGES_REQUESTED', body: '一处要改\n\n文件:行号', commit_id: HEAD }] } },
      },
      dispatchDayBudget: { max: 2 },
      dispatchLedger: { scanned: true, events: nWorkers(2) },
    }));
    assert.equal(byKind(r, 'rework').length, 0, JSON.stringify(kinds(r)));
    const hubs = byKind(r, 'notify-hub').filter((a) => /排队到次日/.test(a.subject || ''));
    assert.equal(hubs.length, 1);
  });

  it('审官 / 回填事件不占工人配额', async () => {
    const { decide } = await CORE;
    const events = [
      { type: 'job.dispatch', identity: '审官', source: 'reviewer-create', ts: DAY },
      { type: 'job.dispatch', identity: '工人', source: 'github-backfill', ts: DAY },
      { type: 'job.dispatch', identity: '工人', source: 'dao-pr-open', ts: DAY },
    ];
    const r = decide(baseSituation({
      github: { scanned: true, issues: [labeledReady(900)], prs: [] },
      dispatchDayBudget: { max: 2 },
      dispatchLedger: { scanned: true, events },
    }));
    assert.equal(byKind(r, 'dispatch').length, 1);
  });
});

describe('worker_wall_hours_max：看板读 release-policy，不手抄', () => {
  it('仓内 JSON 的键等于 loadBoardPolicy 的阈值', async () => {
    const { loadBoardPolicy } = await COLLECT;
    const live = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
    const policy = loadBoardPolicy(REPO);
    assert.equal(policy.thresholdHours, live.budget.per_issue.worker_wall_hours_max);
  });

  it('夹具 hours=2，阈值是 2 不是仓内那个数', async () => {
    const { parseWorkerWallHours } = await BOARD;
    const { loadBoardPolicy } = await COLLECT;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-hours-'));
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs', 'release-policy.json'), JSON.stringify({
      budget: { per_issue: { worker_wall_hours_max: 2 } },
    }));
    fs.writeFileSync(path.join(dir, 'docs', 'dispatch-policy.json'), JSON.stringify({
      preflight: { enabled: true, timeoutMs: 5000, maxCandidates: 4, useHealthTable: true },
      breaker: { windowHours: 24, failuresToTrip: 3, cooldownHours: 24, halfOpenProbes: 1 },
      hubChat: { enabled: true, allowedActions: ['situation'], upstream: { redThreshold: 2, decisions: true, digest: false } },
      board: { workerWallHoursMax: 4, alertBatchMax: 3 },
    }));
    const parsed = parseWorkerWallHours(fs.readFileSync(path.join(dir, 'docs', 'release-policy.json'), 'utf8'));
    assert.equal(parsed.unscanned, false);
    assert.equal(parsed.hours, 2);
    const policy = loadBoardPolicy(dir);
    assert.equal(policy.thresholdHours, 2, '看板必须跟 release-policy 走，不能跟 dispatch-policy 那份镜像');
    const live = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
    assert.notEqual(policy.thresholdHours, live.budget.per_issue.worker_wall_hours_max);
  });
});
