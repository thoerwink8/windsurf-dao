// #581 账本接线 / 校准换源 / 断流差集 / 审读 A 位锁 GPT
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const {
  writeJobDispatch, writeJobClosed, writeJobOverride,
  workerJobId, reviewerJobId,
  loadLedgerContext, beijingIsoFrom, verdictStatsFromReviews,
  resolveMainWorktreeRoot, scopeOverridesFor, describeAttribution,
  resolveAmendTarget, formatAmendComment, linkAliasesToSuccessor,
} = require('../scripts/lib/ledger-job.mjs');
const { unclosedJobIds, describeUnclosedJobs } = require('../scripts/lib/ledger-query.mjs');
const { redKindFromClosed, formatRedCell } = require('../scripts/calibrate.mjs');
const { inspectLedgerGap, LEDGER_GAP_BASELINE_PR, LEDGER_GAP_HISTORICAL_GAPS, historicalGapNote } = require('../scripts/lib/ledger-gap-check.mjs');
const { pinReviewerSlotA } = require('../scripts/lib/dianjiangtai-reviewer-slot.mjs');
const { samplesFromEvents, reworkFromClosed, describeNoEvents } = require('../scripts/calibrate.mjs');

const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas/events.schema.json'), 'utf8'));
const ts = '2026-08-17T12:00:00+08:00';
// #579 形（绿后再红）在归因三态节被复用时共享同一份判定结果
let stats579 = null;

function buildStats579() {
  return verdictStatsFromReviews([
    { body: '判定：红 2 项' },
    { body: '复核结论：绿，可合并' },
    { body: '判定：红 1 项' },
  ]);
}

describe('ledger', () => {
  it('写入走 event-writer，幂等 skip', async (t) => {
    // ── 写入走 event-writer，幂等 skip ──
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-581-'));
    const ctx = { dir, schema, machine: 'TEST-581' };
    const d1 = writeJobDispatch({
      ...ctx, ts, jobId: workerJobId(999), model: 'grok-4.6', identity: '工人',
      workType: '写码', terminal: 'test', prNumber: 999,
    });
    await t.test('job.dispatch 工人写入成功', () => {
      assert.ok(d1.ok && !d1.skipped && fs.existsSync(d1.path), 'job.dispatch 工人写入成功  →  ' + d1.error);
    });
    const d1b = writeJobDispatch({
      ...ctx, ts, jobId: workerJobId(999), model: 'grok-4.6', identity: '工人',
      workType: '写码', terminal: 'test', prNumber: 999,
    });
    await t.test('同 job 再写 dispatch 幂等 skip', () => {
      assert.ok(d1b.ok && d1b.skipped, '同 job 再写 dispatch 幂等 skip  →  ' + JSON.stringify(d1b));
    });
    const r1 = writeJobDispatch({
      ...ctx, ts, jobId: reviewerJobId(999), model: 'gpt-5.6-sol', identity: '审官',
      workType: '审查', terminal: 'test', prNumber: 999,
    });
    await t.test('审官 dispatch 用独立 job_id 可写', () => {
      assert.ok(r1.ok && !r1.skipped, '审官 dispatch 用独立 job_id 可写  →  ' + r1.error);
    });
    const c1 = writeJobClosed({
      ...ctx, ts, jobId: reviewerJobId(999), success: true, rework: true,
      mergedBy: 'reviewer', prNumber: 999, redFlags: 2, verdictRounds: 3,
      workerRework: 1, marshalRounds: 1, triggeredBy: '混合',
    });
    await t.test('job.closed 写入含红项/轮次/帅追加', () => {
      assert.ok(c1.ok && !c1.skipped && c1.event.red_flags === 2 && c1.event.marshal_rounds === 1, 'job.closed 写入含红项/轮次/帅追加  →  ' + c1.error);
    });
    const c1b = writeJobClosed({
      ...ctx, ts, jobId: reviewerJobId(999), success: true, rework: false,
      mergedBy: 'reviewer', prNumber: 999,
    });
    await t.test('同 job 再写 closed 幂等 skip', () => {
      assert.ok(c1b.ok && c1b.skipped, '同 job 再写 closed 幂等 skip  →  ' + JSON.stringify(c1b));
    });
    fs.rmSync(dir, { recursive: true, force: true });

    await t.test('beijingIsoFrom(Date) 带 +08:00', () => {
      assert.ok(/[+]08:00$/.test(beijingIsoFrom(new Date('2026-08-17T04:00:00Z'))), 'beijingIsoFrom(Date) 带 +08:00');
    });
    await t.test('loadLedgerContext 默认指向仓内 schema', () => {
      assert.ok(loadLedgerContext({ root: REPO, machine: 'X' }).schema.version === 1 || Array.isArray(loadLedgerContext({ root: REPO, machine: 'X' }).schema.oneOf), 'loadLedgerContext 默认指向仓内 schema');
    });
  });

  it('#595 ② 工人树里写，事件必须进主树', async (t) => {
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
    await t.test('落点是主树 ledger/events', () => {
      assert.ok(path.resolve(ctx.dir) === path.resolve(path.join(main, 'ledger', 'events')), '落点是主树 ledger/events  →  ' + ctx.dir);
    });
    const w = writeJobDispatch({
      ...ctx, ts, jobId: workerJobId(595), model: 'grok-4.6', identity: '工人',
      workType: '写码', terminal: 'test', prNumber: 595,
    });
    await t.test('写入成功', () => {
      assert.ok(w.ok && w.path && fs.existsSync(w.path), '写入成功  →  ' + w.error);
    });
    await t.test('文件在主树', () => {
      assert.ok(w.path && w.path.startsWith(path.resolve(main)), '文件在主树  →  ' + w.path);
    });
    const workerEvents = path.join(worker, 'ledger', 'events');
    const orphan = fs.existsSync(workerEvents) && fs.readdirSync(workerEvents).filter(f => f.endsWith('.json'));
    await t.test('工人树没有孤本', () => {
      assert.ok(!orphan || orphan.length === 0, '工人树没有孤本  →  ' + JSON.stringify(orphan));
    });

    let threw = null;
    try {
      loadLedgerContext({
        root: worker,
        machine: 'T595',
        git: () => ({ ok: false, error: 'not a git repository' }),
      });
    } catch (e) { threw = e; }
    await t.test('落点查不成不许退回工人树', () => {
      assert.ok(threw && /没查成/.test(threw.message), '落点查不成不许退回工人树  →  ' + (threw && threw.message));
    });

    const override = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-595-e-'));
    const prev = process.env.LEDGER_EVENTS_DIR;
    process.env.LEDGER_EVENTS_DIR = override;
    try {
      const over = loadLedgerContext({
        root: worker,
        machine: 'T595',
        git: () => ({ ok: false, error: 'should not call git' }),
      });
      await t.test('LEDGER_EVENTS_DIR 仍可覆盖', () => {
        assert.ok(path.resolve(over.dir) === path.resolve(override), 'LEDGER_EVENTS_DIR 仍可覆盖  →  ' + over.dir);
      });
    } finally {
      if (prev == null) delete process.env.LEDGER_EVENTS_DIR;
      else process.env.LEDGER_EVENTS_DIR = prev;
      fs.rmSync(override, { recursive: true, force: true });
    }
    fs.rmSync(worker, { recursive: true, force: true });
    fs.rmSync(main, { recursive: true, force: true });

    await t.test('resolveMainWorktreeRoot 认出本仓主树', () => {
      assert.ok((() => {
        const r = resolveMainWorktreeRoot({ from: REPO });
        return r.ok && /windsurf-dao$/i.test(r.root.replace(/\\/g, '/'));
      })(), 'resolveMainWorktreeRoot 认出本仓主树  →  ' + JSON.stringify(resolveMainWorktreeRoot({ from: REPO })));
    });
  });

  it('绿之后再来的判定 = 帅追加，不记工人返工', async (t) => {
    const stats0 = verdictStatsFromReviews([{ body: '判定：绿，可合并' }]);
    await t.test('只绿：workerRework=0，triggeredBy=审官', () => {
      assert.ok(stats0.workerRework === 0 && stats0.triggeredBy === '审官', '只绿：workerRework=0，triggeredBy=审官  →  ' + JSON.stringify(stats0));
    });
    stats579 = buildStats579();
    await t.test('#579 形：绿后再红 → marshalRounds=1，工人返工仍 1', () => {
      assert.ok(stats579.workerRework === 1 && stats579.marshalRounds === 1 && stats579.triggeredBy === '混合', '#579 形：绿后再红 → marshalRounds=1，工人返工仍 1  →  ' + JSON.stringify(stats579));
    });
    const statsNone = verdictStatsFromReviews([{ body: '普通评论' }]);
    await t.test('无判定行：redFlags=null（不是 0）', () => {
      assert.ok(statsNone.redFlags === null && statsNone.workerRework === null, '无判定行：redFlags=null（不是 0）');
    });
  });

  it('校准读账本：没有事件 ≠ 0 红', async (t) => {
    await t.test('describeNoEvents 说没查成不是 0 红', () => {
      assert.ok(describeNoEvents(999).includes('没有事件') && describeNoEvents(999).includes('不是 0 红'), 'describeNoEvents 说没查成不是 0 红');
    });
    const zeroRed = samplesFromEvents([
      { type: 'job.dispatch', job_id: 'gh-pr-1', model: 'grok-4.6', identity: '工人', work_type: '写码' },
      { type: 'job.closed', job_id: 'gh-pr-1', pr_number: 1, red_flags: 0, worker_rework: 0, ts: ts },
    ]);
    await t.test('有事件 0 红 → redFlags=0', () => {
      assert.ok(zeroRed.length === 1 && zeroRed[0].redFlags === 0 && zeroRed[0].rework === 0, '有事件 0 红 → redFlags=0');
    });
    const noRedField = samplesFromEvents([
      { type: 'job.dispatch', job_id: 'gh-pr-2', model: 'grok-4.6', identity: '工人', work_type: '写码' },
      { type: 'job.closed', job_id: 'gh-pr-2', pr_number: 2, rework: false, ts: ts },
    ]);
    await t.test('closed 没记 red_flags → null（无审读）', () => {
      assert.ok(noRedField[0].redFlags === null, 'closed 没记 red_flags → null（无审读）');
    });
    const reviewSample = samplesFromEvents([
      { type: 'job.dispatch', job_id: 'gh-pr-3-review', model: 'gpt-5.6-sol', identity: '审官', work_type: '审查' },
      { type: 'job.closed', job_id: 'gh-pr-3-review', pr_number: 3, red_flags: 2, worker_rework: 1, ts: ts },
    ]);
    await t.test('审官×审查 进样本', () => {
      assert.ok(reviewSample[0].identity === '审官' && reviewSample[0].taskType === '审查' && reviewSample[0].model === 'gpt-5.6-sol', '审官×审查 进样本');
    });
    await t.test('reworkFromClosed 优先 worker_rework', () => {
      assert.ok(reworkFromClosed({ worker_rework: 1, verdict_rounds: 9, rework: true }) === 1, 'reworkFromClosed 优先 worker_rework');
    });
    await t.test('reworkFromClosed 扣 marshal_rounds', () => {
      assert.ok(reworkFromClosed({ verdict_rounds: 3, marshal_rounds: 1 }) === 1, 'reworkFromClosed 扣 marshal_rounds');
    });
  });

  it('#591 归因三态 + 红之后追加', async (t) => {
    const ov582 = [{
      type: 'job.override', override_kind: 'scope', job_id: 'gh-pr-582',
      why: '补 503 指纹', triggered_by: '帅',
    }];
    const reviews582 = [
      { body: '判定：红 2 项' },
      { body: '复核结论：绿，可合并' },
    ];
    const inferred582 = verdictStatsFromReviews(reviews582);
    await t.test('#582 无 override：整轮记工人（反推低估）', () => {
      assert.ok(inferred582.workerRework === 1 && inferred582.marshalRounds === 0 && inferred582.attributionSource === 'inferred', '#582 无 override：整轮记工人（反推低估）  →  ' + JSON.stringify(inferred582));
    });
    await t.test('#582 反推话术点明可能低估', () => {
      assert.ok(/可能低估帅的轮次/.test(describeAttribution(inferred582)), '#582 反推话术点明可能低估  →  ' + inferred582.attributionNote);
    });
    const event582 = verdictStatsFromReviews(reviews582, { overrides: ov582 });
    await t.test('#582 有 override：那一轮归帅', () => {
      assert.ok(event582.marshalRounds === 1 && event582.workerRework === 0 && event582.attributionSource === 'event', '#582 有 override：那一轮归帅  →  ' + JSON.stringify(event582));
    });
    const redAfterRed = verdictStatsFromReviews([
      { body: '判定：红 2 项' },
      { body: '判定：红 1 项' },
      { body: '复核结论：绿，可合并' },
    ]);
    await t.test('红→红→绿 反推点名覆盖不到', () => {
      assert.ok(redAfterRed.inferredMayUnderestimate && /红之后追加/.test(redAfterRed.attributionNote), '红→红→绿 反推点名覆盖不到  →  ' + redAfterRed.attributionNote);
    });
    const unscanned = verdictStatsFromReviews([], { unscanned: true, unscannedError: 'reviews 没查成' });
    await t.test('归因三态：没查成', () => {
      assert.ok(unscanned.attributionSource === 'unscanned' && describeAttribution(unscanned).includes('没查成'), '归因三态：没查成');
    });
    await t.test('#579 形仍标 inferred 但不改数字', () => {
      assert.ok(stats579.attributionSource === 'inferred' && stats579.marshalRounds === 1 && stats579.workerRework === 1, '#579 形仍标 inferred 但不改数字');
    });

    const miss = { type: 'job.closed', job_id: 'gh-pr-582', pr_number: 582 };
    const withReview = [
      { type: 'job.dispatch', job_id: 'gh-pr-582-review', pr_number: 582, identity: '审官' },
    ];
    await t.test('有审官 job 但没记 red_flags → 未记录', () => {
      assert.ok(redKindFromClosed(miss, withReview) === 'unrecorded' && formatRedCell({ redKind: 'unrecorded' }) === '未记录', '有审官 job 但没记 red_flags → 未记录');
    });
    await t.test('red_flags=0 → 0', () => {
      assert.ok(redKindFromClosed({ red_flags: 0 }, []) === 'zero' && formatRedCell({ redKind: 'zero', redFlags: 0 }) === '0', 'red_flags=0 → 0');
    });
    await t.test('无审官 job 且没记 → 无审', () => {
      assert.ok(redKindFromClosed(miss, []) === 'none' && formatRedCell({ redKind: 'none' }) === '无审', '无审官 job 且没记 → 无审');
    });
    await t.test('三态话面不同', () => {
      assert.ok(formatRedCell({ redKind: 'unrecorded' }) !== '0' && formatRedCell({ redKind: 'unrecorded' }) !== '无审', '三态话面不同');
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-591-'));
    const ctx = { dir, schema, machine: 'TEST-591' };
    const d = writeJobDispatch({
      ...ctx, ts, jobId: 'dispatch-ctx_591', model: 'grok-4.6', identity: '工人',
      workType: '写码', terminal: 'test', extra: { issue_number: 591 },
    });
    await t.test('dispatch-* 写入', () => {
      assert.ok(d.ok && !d.skipped, 'dispatch-* 写入  →  ' + d.error);
    });
    const ov = writeJobOverride({
      ...ctx, ts, jobId: 'gh-pr-599', model: 'grok-4.6', identity: '帅',
      workType: '写码', triggeredBy: '帅', why: '补未结明细', prNumber: 599, issueNumber: 591,
    });
    await t.test('scope override 写入', () => {
      assert.ok(ov.ok && ov.event.override_kind === 'scope' && ov.event.why === '补未结明细', 'scope override 写入  →  ' + ov.error);
    });
    const ov2 = writeJobOverride({
      ...ctx, ts: '2026-08-17T13:00:00+08:00', jobId: 'gh-pr-599', model: 'grok-4.6', identity: '帅',
      workType: '写码', triggeredBy: '用户', why: '再改一次范围', prNumber: 599, issueNumber: 591,
    });
    await t.test('同一 job 第二条 scope override 可写', () => {
      assert.ok(ov2.ok && !ov2.skipped, '同一 job 第二条 scope override 可写  →  ' + ov2.error);
    });
    const found = scopeOverridesFor([ov.event, ov2.event], { prNumber: 599 });
    await t.test('scopeOverridesFor 按 pr 收集 2 条', () => {
      assert.ok(found.length === 2, 'scopeOverridesFor 按 pr 收集 2 条  →  ' + String(found.length));
    });

    writeJobDispatch({
      ...ctx, ts, jobId: workerJobId(599), model: 'grok-4.6', identity: '工人',
      workType: '写码', terminal: 'test', prNumber: 599, extra: { issue_number: 591 },
    });
    const listedBefore = [
      d.event,
      { type: 'job.dispatch', job_id: workerJobId(599), pr_number: 599, identity: '工人', issue_number: 591 },
    ];
    await t.test('接续前 dispatch-* 算未结', () => {
      assert.ok(unclosedJobIds(listedBefore).includes('dispatch-ctx_591'), '接续前 dispatch-* 算未结');
    });
    const links = linkAliasesToSuccessor({
      ctx, ts, events: listedBefore, successorJobId: workerJobId(599),
      issueNumber: 591, prNumber: 599, model: 'grok-4.6', identity: '工人',
    });
    await t.test('handoff 接续写成功', () => {
      assert.ok(links.length === 1 && links[0].ok, 'handoff 接续写成功  →  ' + JSON.stringify(links));
    });
    const after = [
      ...listedBefore,
      links[0].event,
      { type: 'job.closed', job_id: workerJobId(599), pr_number: 599 },
    ];
    await t.test('接续后 dispatch-* 不再算未结', () => {
      assert.ok(!unclosedJobIds(after).includes('dispatch-ctx_591'), '接续后 dispatch-* 不再算未结  →  ' + unclosedJobIds(after).join(','));
    });
    await t.test('接续后未结只剩已 closed 的不算', () => {
      assert.ok(unclosedJobIds(after).length === 0, '接续后未结只剩已 closed 的不算  →  ' + unclosedJobIds(after).join(','));
    });

    const stuck = describeUnclosedJobs([
      { type: 'job.dispatch', job_id: 'gh-pr-700', pr_number: 700, identity: '审官' },
    ]);
    await t.test('真卡住的单列得出 job_id 和缺失项', () => {
      assert.ok(stuck.length === 1 && stuck[0].job_id === 'gh-pr-700' && stuck[0].missing.includes('job.closed'), '真卡住的单列得出 job_id 和缺失项  →  ' + JSON.stringify(stuck));
    });
    const reviewOrphans = describeUnclosedJobs([
      { type: 'job.dispatch', job_id: 'gh-pr-596', pr_number: 596, identity: '工人' },
      { type: 'job.closed', job_id: 'gh-pr-596', pr_number: 596 },
      { type: 'job.dispatch', job_id: 'gh-pr-596-review', pr_number: 596, identity: '审官' },
      { type: 'job.dispatch', job_id: 'gh-pr-597', pr_number: 597, identity: '工人' },
      { type: 'job.closed', job_id: 'gh-pr-597', pr_number: 597 },
      { type: 'job.dispatch', job_id: 'gh-pr-597-review', pr_number: 597, identity: '审官' },
    ]);
    await t.test('#596/#597 审官缺 closed 报得出', () => {
      assert.ok(reviewOrphans.length === 2 && reviewOrphans.every(r => r.job_id.endsWith('-review') && r.identity === '审官' && r.missing.includes('job.closed')), '#596/#597 审官缺 closed 报得出  →  ' + JSON.stringify(reviewOrphans));
    });

    const tgt = resolveAmendTarget({
      events: [{ type: 'job.dispatch', job_id: 'dispatch-ctx_591', model: 'grok-4.6', work_type: '写码', issue_number: 591 }],
      issue: 591,
    });
    await t.test('amend 按 issue 找到 dispatch job', () => {
      assert.ok(tgt.ok && tgt.jobId === 'dispatch-ctx_591' && tgt.model === 'grok-4.6', 'amend 按 issue 找到 dispatch job  →  ' + JSON.stringify(tgt));
    });
    const comment = formatAmendComment({ triggeredBy: '帅', why: '补指纹', jobId: 'gh-pr-599', eventId: 'abc' });
    await t.test('amend 评论带机械标记', () => {
      assert.ok(comment.includes('账本已记 job.override') && comment.includes('<!-- dao-amend -->'), 'amend 评论带机械标记');
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('差集：两个反例都要过；禁 Date.now', async (t) => {
    const src = fs.readFileSync(path.join(REPO, 'scripts/lib/ledger-gap-check.mjs'), 'utf8');
    await t.test('差集检查不含 Date.now() 调用', () => {
      assert.ok(!/Date\.now\s*\(/.test(src), '差集检查不含 Date.now() 调用');
    });
    await t.test('基准 PR 写死为 #590（#591 追加③）', () => {
      assert.ok(LEDGER_GAP_BASELINE_PR === 590, '基准 PR 写死为 #590（#591 追加③）');
    });
    await t.test('存量缺口点名 585/587/590', () => {
      assert.ok(LEDGER_GAP_HISTORICAL_GAPS.join(',') === '585,587,590', '存量缺口点名 585/587/590');
    });
    await t.test('存量 note 不许静默', () => {
      assert.ok(/#585/.test(historicalGapNote()) && /#587/.test(historicalGapNote()) && /#590/.test(historicalGapNote()) && /不对照/.test(historicalGapNote()), '存量 note 不许静默');
    });
    const gapA = inspectLedgerGap({
      githubPrs: [{ number: 999, labels: ['model/x', 'type/写码'] }],
      closedNumbers: new Set(),
      baselinePr: 0,
      newestBuffer: 0,
    });
    await t.test('样本A：有差集 → kind=gap 且点名 999', () => {
      assert.ok(gapA.kind === 'gap' && gapA.missing.includes(999), '样本A：有差集 → kind=gap 且点名 999  →  ' + JSON.stringify(gapA));
    });
    const gapB = inspectLedgerGap({
      githubPrs: [{ number: 999, labels: ['model/x', 'type/写码'] }],
      closedNumbers: new Set([999]),
      baselinePr: 0,
      newestBuffer: 0,
    });
    await t.test('样本B：无差集 → kind=ok', () => {
      assert.ok(gapB.kind === 'ok' && gapB.missing.length === 0, '样本B：无差集 → kind=ok  →  ' + JSON.stringify(gapB));
    });
    const buffered = inspectLedgerGap({
      githubPrs: [
        { number: 600, labels: ['model/x', 'type/写码'] },
        { number: 601, labels: ['model/x', 'type/写码'] },
      ],
      closedNumbers: new Set(),
      baselinePr: 500,
      newestBuffer: 1,
    });
    await t.test('序数缓冲：只对照除最新 1 个之外', () => {
      assert.ok(buffered.kind === 'gap' && buffered.checked.includes(600) && !buffered.checked.includes(601), '序数缓冲：只对照除最新 1 个之外  →  ' + JSON.stringify(buffered));
    });
    const beforeBase = inspectLedgerGap({
      githubPrs: [{ number: 400, labels: ['model/x', 'type/写码'] }],
      closedNumbers: new Set(),
      baselinePr: 584,
      newestBuffer: 1,
    });
    await t.test('基准之前的单不对照 → empty-github', () => {
      assert.ok(beforeBase.kind === 'empty-github', '基准之前的单不对照 → empty-github  →  ' + JSON.stringify(beforeBase));
    });

    const labeled = n => ({ number: n, labels: ['model/x', 'type/写码'] });
    const currentShape = inspectLedgerGap({
      githubPrs: [585, 587, 590, 592, 594, 596, 597].map(labeled),
      closedNumbers: new Set([592, 594, 596, 597]),
      newestBuffer: 1,
    });
    await t.test('现状工人侧 closed → 对照转绿', () => {
      assert.ok(currentShape.kind === 'ok' && currentShape.checked.includes(592) && currentShape.checked.includes(596) && !currentShape.checked.includes(597), '现状工人侧 closed → 对照转绿  →  ' + JSON.stringify(currentShape));
    });
    await t.test('转绿仍带存量缺口 note', () => {
      assert.ok(/#585/.test(currentShape.historicalNote) && /#590/.test(currentShape.historicalNote), '转绿仍带存量缺口 note  →  ' + currentShape.historicalNote);
    });
    const guardStill = inspectLedgerGap({
      githubPrs: [592, 600].map(labeled),
      closedNumbers: new Set([592]),
      newestBuffer: 0,
    });
    await t.test('baseline 之后缺 closed → 仍红（守卫还活着）', () => {
      assert.ok(guardStill.kind === 'gap' && guardStill.missing.includes(600) && !guardStill.missing.includes(592), 'baseline 之后缺 closed → 仍红（守卫还活着）  →  ' + JSON.stringify(guardStill));
    });
    await t.test('#592 形：红后追加 + override 归帅', () => {
      assert.ok((() => {
        const s = verdictStatsFromReviews(
          [{ body: '判定：红 2 项' }, { body: '复核结论：绿，可合并' }],
          { overrides: [{ type: 'job.override', override_kind: 'scope', job_id: 'gh-pr-592', why: '帅追加' }] },
        );
        return s.attributionSource === 'event' && s.marshalRounds === 1 && s.workerRework === 0;
      })(), '#592 形：红后追加 + override 归帅');
    });
  });

  it('审读 A 位锁 GPT，撞 UI ban 顺延 Opus', async (t) => {
    const models = [
      { id: 'gpt-5.6-sol', provider: 'gpt' },
      { id: 'claude-opus', provider: 'claude' },
      { id: 'grok-4.6', provider: 'grok' },
    ];
    const pinGpt = pinReviewerSlotA({ models, passerIds: ['grok-4.6', 'claude-opus', 'gpt-5.6-sol'] });
    await t.test('审读 A 位锁 GPT（即使评分第一是别人）', () => {
      assert.ok(pinGpt.model === 'gpt-5.6-sol' && pinGpt.reason === 'reviewer_default_gpt', '审读 A 位锁 GPT（即使评分第一是别人）  →  ' + JSON.stringify(pinGpt));
    });
    const pinUi = pinReviewerSlotA({ models, passerIds: ['grok-4.6', 'claude-opus'] });
    await t.test('GPT 不在门闩集合（UI ban）→ 选型序 Opus', () => {
      assert.ok(pinUi.model === 'claude-opus' && pinUi.reason === 'reviewer_order', 'GPT 不在门闩集合（UI ban）→ 选型序 Opus  →  ' + JSON.stringify(pinUi));
    });
    const pinNone = pinReviewerSlotA({ models, passerIds: [] });
    await t.test('无人可派 → no_candidate', () => {
      assert.ok(pinNone.model === null && pinNone.reason === 'no_candidate', '无人可派 → no_candidate');
    });
  });
});