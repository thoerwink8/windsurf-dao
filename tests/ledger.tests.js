// #581 账本接线 / 校准换源 / 断流差集 / 审读 A 位锁 GPT
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const {
  writeJobDispatch, writeJobClosed, workerJobId, reviewerJobId,
  loadLedgerContext, beijingIsoFrom, verdictStatsFromReviews,
  resolveMainWorktreeRoot,
} = require('../scripts/lib/ledger-job.mjs');
const { inspectLedgerGap, LEDGER_GAP_BASELINE_PR } = require('../scripts/lib/ledger-gap-check.mjs');
const { pinReviewerSlotA } = require('../scripts/lib/dianjiangtai-reviewer-slot.mjs');
const { samplesFromEvents, reworkFromClosed, describeNoEvents } = require('../scripts/calibrate.mjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas/events.schema.json'), 'utf8'));
const ts = '2026-08-17T12:00:00+08:00';

// ── 写入走 event-writer，幂等 skip ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-581-'));
const ctx = { dir, schema, machine: 'TEST-581' };
const d1 = writeJobDispatch({
  ...ctx, ts, jobId: workerJobId(999), model: 'grok-4.6', identity: '工人',
  workType: '写码', terminal: 'test', prNumber: 999,
});
check('job.dispatch 工人写入成功', d1.ok && !d1.skipped && fs.existsSync(d1.path), d1.error);
const d1b = writeJobDispatch({
  ...ctx, ts, jobId: workerJobId(999), model: 'grok-4.6', identity: '工人',
  workType: '写码', terminal: 'test', prNumber: 999,
});
check('同 job 再写 dispatch 幂等 skip', d1b.ok && d1b.skipped, JSON.stringify(d1b));
const r1 = writeJobDispatch({
  ...ctx, ts, jobId: reviewerJobId(999), model: 'gpt-5.6-sol', identity: '审官',
  workType: '审查', terminal: 'test', prNumber: 999,
});
check('审官 dispatch 用独立 job_id 可写', r1.ok && !r1.skipped, r1.error);
const c1 = writeJobClosed({
  ...ctx, ts, jobId: reviewerJobId(999), success: true, rework: true,
  mergedBy: 'reviewer', prNumber: 999, redFlags: 2, verdictRounds: 3,
  workerRework: 1, marshalRounds: 1, triggeredBy: '混合',
});
check('job.closed 写入含红项/轮次/帅追加', c1.ok && !c1.skipped && c1.event.red_flags === 2 && c1.event.marshal_rounds === 1, c1.error);
const c1b = writeJobClosed({
  ...ctx, ts, jobId: reviewerJobId(999), success: true, rework: false,
  mergedBy: 'reviewer', prNumber: 999,
});
check('同 job 再写 closed 幂等 skip', c1b.ok && c1b.skipped, JSON.stringify(c1b));
fs.rmSync(dir, { recursive: true, force: true });

check('beijingIsoFrom(Date) 带 +08:00', /[+]08:00$/.test(beijingIsoFrom(new Date('2026-08-17T04:00:00Z'))));
check('loadLedgerContext 默认指向仓内 schema', loadLedgerContext({ root: REPO, machine: 'X' }).schema.version === 1 || Array.isArray(loadLedgerContext({ root: REPO, machine: 'X' }).schema.oneOf));

// ── #595 ② 工人树里写，事件必须进主树 ──
{
  const worker = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-595-w-'));
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-595-m-'));
  fs.mkdirSync(path.join(worker, 'schemas'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'schemas', 'events.schema.json'), path.join(worker, 'schemas', 'events.schema.json'));
  const git = (args) => {
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
      return { ok: true, out: path.join(main, '.git') };
    }
    return { ok: false, error: `unexpected git ${args.join(' ')}` };
  };
  const ctx = loadLedgerContext({ root: worker, machine: 'T595', git });
  check('落点是主树 ledger/events', path.resolve(ctx.dir) === path.resolve(path.join(main, 'ledger', 'events')), ctx.dir);
  const w = writeJobDispatch({
    ...ctx, ts, jobId: workerJobId(595), model: 'grok-4.6', identity: '工人',
    workType: '写码', terminal: 'test', prNumber: 595,
  });
  check('写入成功', w.ok && w.path && fs.existsSync(w.path), w.error);
  check('文件在主树', w.path && w.path.startsWith(path.resolve(main)), w.path);
  const workerEvents = path.join(worker, 'ledger', 'events');
  const orphan = fs.existsSync(workerEvents) && fs.readdirSync(workerEvents).filter(f => f.endsWith('.json'));
  check('工人树没有孤本', !orphan || orphan.length === 0, JSON.stringify(orphan));

  let threw = null;
  try {
    loadLedgerContext({
      root: worker,
      machine: 'T595',
      git: () => ({ ok: false, error: 'not a git repository' }),
    });
  } catch (e) { threw = e; }
  check('落点查不成不许退回工人树', threw && /没查成/.test(threw.message), threw && threw.message);

  const override = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-595-e-'));
  const prev = process.env.LEDGER_EVENTS_DIR;
  process.env.LEDGER_EVENTS_DIR = override;
  try {
    const over = loadLedgerContext({
      root: worker,
      machine: 'T595',
      git: () => ({ ok: false, error: 'should not call git' }),
    });
    check('LEDGER_EVENTS_DIR 仍可覆盖', path.resolve(over.dir) === path.resolve(override), over.dir);
  } finally {
    if (prev == null) delete process.env.LEDGER_EVENTS_DIR;
    else process.env.LEDGER_EVENTS_DIR = prev;
    fs.rmSync(override, { recursive: true, force: true });
  }
  fs.rmSync(worker, { recursive: true, force: true });
  fs.rmSync(main, { recursive: true, force: true });
}
check('resolveMainWorktreeRoot 认出本仓主树', (() => {
  const r = resolveMainWorktreeRoot({ from: REPO });
  return r.ok && /windsurf-dao$/i.test(r.root.replace(/\\/g, '/'));
})(), JSON.stringify(resolveMainWorktreeRoot({ from: REPO })));

// ── 绿之后再来的判定 = 帅追加，不记工人返工 ──
const stats0 = verdictStatsFromReviews([{ body: '判定：绿，可合并' }]);
check('只绿：workerRework=0，triggeredBy=审官', stats0.workerRework === 0 && stats0.triggeredBy === '审官', JSON.stringify(stats0));
const stats579 = verdictStatsFromReviews([
  { body: '判定：红 2 项' },
  { body: '复核结论：绿，可合并' },
  { body: '判定：红 1 项' },
]);
check('#579 形：绿后再红 → marshalRounds=1，工人返工仍 1', stats579.workerRework === 1 && stats579.marshalRounds === 1 && stats579.triggeredBy === '混合', JSON.stringify(stats579));
const statsNone = verdictStatsFromReviews([{ body: '普通评论' }]);
check('无判定行：redFlags=null（不是 0）', statsNone.redFlags === null && statsNone.workerRework === null);

// ── 校准读账本：没有事件 ≠ 0 红 ──
check('describeNoEvents 说没查成不是 0 红', describeNoEvents(999).includes('没有事件') && describeNoEvents(999).includes('不是 0 红'));
const zeroRed = samplesFromEvents([
  { type: 'job.dispatch', job_id: 'gh-pr-1', model: 'grok-4.6', identity: '工人', work_type: '写码' },
  { type: 'job.closed', job_id: 'gh-pr-1', pr_number: 1, red_flags: 0, worker_rework: 0, ts: ts },
]);
check('有事件 0 红 → redFlags=0', zeroRed.length === 1 && zeroRed[0].redFlags === 0 && zeroRed[0].rework === 0);
const noRedField = samplesFromEvents([
  { type: 'job.dispatch', job_id: 'gh-pr-2', model: 'grok-4.6', identity: '工人', work_type: '写码' },
  { type: 'job.closed', job_id: 'gh-pr-2', pr_number: 2, rework: false, ts: ts },
]);
check('closed 没记 red_flags → null（无审读）', noRedField[0].redFlags === null);
const reviewSample = samplesFromEvents([
  { type: 'job.dispatch', job_id: 'gh-pr-3-review', model: 'gpt-5.6-sol', identity: '审官', work_type: '审查' },
  { type: 'job.closed', job_id: 'gh-pr-3-review', pr_number: 3, red_flags: 2, worker_rework: 1, ts: ts },
]);
check('审官×审查 进样本', reviewSample[0].identity === '审官' && reviewSample[0].taskType === '审查' && reviewSample[0].model === 'gpt-5.6-sol');
check('reworkFromClosed 优先 worker_rework', reworkFromClosed({ worker_rework: 1, verdict_rounds: 9, rework: true }) === 1);
check('reworkFromClosed 扣 marshal_rounds', reworkFromClosed({ verdict_rounds: 3, marshal_rounds: 1 }) === 1);

// ── 差集：两个反例都要过；禁 Date.now ──
const src = fs.readFileSync(path.join(REPO, 'scripts/lib/ledger-gap-check.mjs'), 'utf8');
check('差集检查不含 Date.now() 调用', !/Date\.now\s*\(/.test(src));
check('基准 PR 写死为本单 #584', LEDGER_GAP_BASELINE_PR === 584);
const gapA = inspectLedgerGap({
  githubPrs: [{ number: 999, labels: ['model/x', 'type/写码'] }],
  closedNumbers: new Set(),
  baselinePr: 0,
  newestBuffer: 0,
});
check('样本A：有差集 → kind=gap 且点名 999', gapA.kind === 'gap' && gapA.missing.includes(999), JSON.stringify(gapA));
const gapB = inspectLedgerGap({
  githubPrs: [{ number: 999, labels: ['model/x', 'type/写码'] }],
  closedNumbers: new Set([999]),
  baselinePr: 0,
  newestBuffer: 0,
});
check('样本B：无差集 → kind=ok', gapB.kind === 'ok' && gapB.missing.length === 0, JSON.stringify(gapB));
const buffered = inspectLedgerGap({
  githubPrs: [
    { number: 600, labels: ['model/x', 'type/写码'] },
    { number: 601, labels: ['model/x', 'type/写码'] },
  ],
  closedNumbers: new Set(),
  baselinePr: 500,
  newestBuffer: 1,
});
check('序数缓冲：只对照除最新 1 个之外', buffered.kind === 'gap' && buffered.checked.includes(600) && !buffered.checked.includes(601), JSON.stringify(buffered));
const beforeBase = inspectLedgerGap({
  githubPrs: [{ number: 400, labels: ['model/x', 'type/写码'] }],
  closedNumbers: new Set(),
  baselinePr: 584,
  newestBuffer: 1,
});
check('基准之前的单不对照 → empty-github', beforeBase.kind === 'empty-github', JSON.stringify(beforeBase));

// ── 审读 A 位锁 GPT，撞 UI ban 顺延 Opus ──
const models = [
  { id: 'gpt-5.6-sol', provider: 'gpt' },
  { id: 'claude-opus', provider: 'claude' },
  { id: 'grok-4.6', provider: 'grok' },
];
const pinGpt = pinReviewerSlotA({ models, passerIds: ['grok-4.6', 'claude-opus', 'gpt-5.6-sol'] });
check('审读 A 位锁 GPT（即使评分第一是别人）', pinGpt.model === 'gpt-5.6-sol' && pinGpt.reason === 'reviewer_default_gpt', JSON.stringify(pinGpt));
const pinUi = pinReviewerSlotA({ models, passerIds: ['grok-4.6', 'claude-opus'] });
check('GPT 不在门闩集合（UI ban）→ 选型序 Opus', pinUi.model === 'claude-opus' && pinUi.reason === 'reviewer_order', JSON.stringify(pinUi));
const pinNone = pinReviewerSlotA({ models, passerIds: [] });
check('无人可派 → no_candidate', pinNone.model === null && pinNone.reason === 'no_candidate');

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
