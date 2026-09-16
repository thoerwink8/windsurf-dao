const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = import('../scripts/lib/approved-merge.mjs');
const head = 'a'.repeat(40);
function data() {
  return { pr: { number: 1191, state: 'OPEN', title: '修复', body: '署名 issue #1182', isDraft: true,
    headRefOid: head, mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    reviews: [{ state: 'APPROVED', commit: { oid: head } }] },
  issue: { number: 1182, state: 'OPEN', labels: [{ name: '已拍板' }, { name: '已消歧' }] },
  greenAtHead: true, expectedHead: head };
}

test('non-draft manual 不要求 isDraft，但仍要批准单 + 当前 HEAD + CI', async () => {
  const { canReleaseApprovedManual, canReleaseApprovedDraft } = await load;
  const x = data();
  x.pr.isDraft = false;
  assert.equal(canReleaseApprovedDraft(x), false, 'draft 路仍要求 isDraft');
  assert.equal(canReleaseApprovedManual(x), true, 'manual 路吃非 draft');
  x.pr.headRefOid = 'b'.repeat(40);
  assert.equal(canReleaseApprovedManual(x), false, 'HEAD 变了不合');
});

test('only explicitly approved execution with current review and complete CI can release draft', async () => {
  const { canReleaseApprovedDraft } = await load;
  assert.equal(canReleaseApprovedDraft(data()), true);
  const variants = [x => { x.issue.labels = [{ name: '已拍板' }]; },
    x => { x.pr.title = '#1182'; x.pr.body = '署名 issue #819'; },
    x => { x.pr.body = '署名 issue #1182\n署名 issue #819'; },
    x => { x.issue.number = 819; }, x => { x.greenAtHead = false; },
    x => { x.pr.headRefOid = 'b'.repeat(40); }, x => { x.pr.mergeable = 'UNKNOWN'; },
    x => { x.pr.statusCheckRollup = []; }, x => { x.pr.statusCheckRollup[0].status = 'IN_PROGRESS'; }];
  for (const change of variants) { const x = data(); change(x); assert.equal(canReleaseApprovedDraft(x), false); }
});

test('commander emits approval-bound merge rather than another user question', async () => {
  const { decide } = await import('../scripts/lib/commander-core.mjs');
  const { scanPrReviews } = await import('../scripts/commander.mjs');
  const x = data();
  let reads = 0;
  const scanned = scanPrReviews([x.pr], { issues: [x.issue], read: () => {
    reads++; return { ok: true, out: JSON.stringify([{ state: 'APPROVED', commit_id: head }]) };
  } });
  assert.equal(reads, 1);
  const r = decide({ github: { scanned: true, issues: [x.issue], prs: [x.pr] },
    trees: { scanned: true, worktrees: [] }, reviewPending: { scanned: true, items: [] },
    prReviews: scanned,
    stall: { scanned: true, strikes: {} }, commanderPolicy: { requireModelInRouting: false } });
  const merge = r.actions.find(a => a.kind === 'merge');
  assert.equal(merge?.approvalIssue, 1182);
  assert.equal(merge?.head, head);
});

test('非 draft manual 执行层复核证据、锁 HEAD，不走要求 isDraft 的 draft 路', async () => {
  const { execMerge } = await import('../scripts/commander.mjs');
  const x = data();
  x.pr.isDraft = false;
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args[4] === 'pr' && args[5] === 'view') return { ok: true, out: JSON.stringify(x.pr) };
    if (args[4] === 'issue' && args[5] === 'view') return { ok: true, out: JSON.stringify(x.issue) };
    return { ok: true, out: '' };
  };
  const r = execMerge(
    { pr: 1191, approvalIssue: 1182, head, evidenceMode: 'manual' },
    { say() {}, run, judge: () => ({ state: 'ok' }) },
  );
  assert.equal(r.ok, true);
  const merge = calls.find(a => a[5] === 'merge');
  assert.equal(merge.at(-2), '--match-head-commit');
  assert.equal(merge.at(-1), head);
  assert.equal(calls.some(a => a[5] === 'ready'), false, '非 draft 不许先 pr ready');
});

test('非 draft manual 丢了批准单或 HEAD → 拒绝裸合', async () => {
  const { execMerge } = await import('../scripts/commander.mjs');
  const r = execMerge(
    { pr: 1225, evidenceMode: 'manual' },
    { say() {}, run: () => { throw new Error('不该打 gh'); }, judge: () => ({ state: 'ok' }) },
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, 'manual-merge-unbound');
});

test('executor rechecks evidence, pins head and restores draft if merge fails', async () => {
  const { execMerge } = await import('../scripts/commander.mjs');
  for (const scenario of ['success', 'head-changed', 'merge-failed', 'review-stale', 'approval-removed']) {
    const x = data(), calls = [];
    if (scenario === 'head-changed') x.pr.headRefOid = 'b'.repeat(40);
    if (scenario === 'review-stale') x.pr.reviews[0].commit.oid = 'b'.repeat(40);
    if (scenario === 'approval-removed') x.issue.labels = [];
    const run = args => {
      calls.push(args);
      if (args[4] === 'pr' && args[5] === 'view') return { ok: true, out: JSON.stringify(x.pr) };
      if (args[4] === 'issue' && args[5] === 'view') return { ok: true, out: JSON.stringify(x.issue) };
      if (args[5] === 'merge' && scenario === 'merge-failed') return { ok: false, error: 'head moved' };
      return { ok: true, out: '' };
    };
    execMerge({ pr: 1191, approvalIssue: 1182, head }, { say() {}, run, judge: () => ({ state: 'ok' }) });
    const merge = calls.find(a => a[5] === 'merge');
    if (['head-changed', 'review-stale', 'approval-removed'].includes(scenario)) {
      assert.equal(merge, undefined);
      assert.equal(calls.some(a => a[5] === 'ready'), false);
    } else {
      assert.equal(merge.at(-2), '--match-head-commit');
      assert.equal(merge.at(-1), head);
      assert.equal(calls.some(a => a.includes('--undo')), scenario === 'merge-failed');
    }
  }
});

test('auto merge without approvalIssue still pins --match-head-commit and refuses a moved HEAD', async () => {
  const { execMerge } = await import('../scripts/commander.mjs');
  const head = 'a'.repeat(40);
  const pr = {
    number: 77, state: 'OPEN', headRefOid: head, isDraft: false, mergeable: 'MERGEABLE',
    statusCheckRollup: [], reviews: [],
  };
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args[4] === 'pr' && args[5] === 'view') return { ok: true, out: JSON.stringify(pr) };
    return { ok: true, out: '' };
  };
  const ok = execMerge({ pr: 77, head }, { say() {}, run, judge: () => ({ state: 'ok' }) });
  assert.equal(ok.ok, true);
  const merge = calls.find(a => a[5] === 'merge');
  assert.equal(merge.at(-2), '--match-head-commit');
  assert.equal(merge.at(-1), head);

  const moved = { ...pr, headRefOid: 'b'.repeat(40) };
  const calls2 = [];
  const run2 = args => {
    calls2.push(args);
    if (args[4] === 'pr' && args[5] === 'view') return { ok: true, out: JSON.stringify(moved) };
    return { ok: true, out: '' };
  };
  const skipped = execMerge({ pr: 77, head }, { say() {}, run: run2, judge: () => ({ state: 'ok' }) });
  assert.equal(skipped.skipped, 'head-changed');
  assert.equal(calls2.some(a => a[5] === 'merge'), false);
});

// ── 2026-09-14 断链：draft 被 scanPrReviews 跳过，下游把它读成「没抓到」，静默永不送审 ──
//
// 实咬：#1265/#1266 自己开的单，挂了 4 小时没有任何东西叫审官。
// 根因不是 draft（draft 是合法起点），是**跳过没留痕**：
//   scanPrReviews 跳过 draft → 不进 byPr → prReviewInput(undefined) → analyzeReviewsAtHead
//   判 reviews-missing（= 没抓到）→ commander 那格按既有契约**静默 continue**。
// 「一条 review 都没有、该叫审官了」与「reviews 没抓到」处置相反，原来却是同一格。
test('scanPrReviews 跳过 draft 要留痕：skipped 里点名，不许让它长得像「没抓到」', async () => {
  const { scanPrReviews } = await import('../scripts/commander.mjs');
  const draft = { number: 901, isDraft: true, headRefOid: 'a'.repeat(40), labels: [] };
  const ready = { number: 902, isDraft: false, headRefOid: 'b'.repeat(40), labels: [] };
  const read = (args) => {
    // 只有非 draft 那张才该被查
    assert.equal(String(args[2]).endsWith('/901/reviews'), false, 'draft 不该去查 reviews（省额度那条要保住）');
    return { ok: true, out: '[]' };
  };
  const s = scanPrReviews([draft, ready], { issues: [], read });
  assert.equal(s.scanned, true);
  assert.deepEqual(s.skipped, [901], '跳过的 PR 必须留痕');
  assert.equal(s.byPr[902] !== undefined, true, '非 draft 照常进 byPr（哪怕 0 条）');
  assert.equal(s.byPr[901], undefined, 'draft 不进 byPr——这条契约不变');
});

test('draft 零判定要进复审队列：不再静默 continue，且 head 落在 PR 自己的 headRefOid 上', async () => {
  const { decide, rereviewKey } = await import('../scripts/lib/commander-core.mjs');
  const { scanPrReviews } = await import('../scripts/commander.mjs');
  const head = 'c'.repeat(40);
  const draft = { number: 903, isDraft: true, headRefOid: head, labels: [{ name: 'reviewer/grok-4.6' }] };
  const scanned = scanPrReviews([draft], { issues: [], read: () => { throw new Error('不该查 draft'); } });
  const r = decide({
    github: { scanned: true, issues: [], prs: [draft] },
    trees: { scanned: true, worktrees: [] },
    reviewPending: { scanned: true, items: [] },
    prReviews: scanned,
    stall: { scanned: true, strikes: {} },
    admission: { ok: true, slots: 10, cores: 6 },
    commanderPolicy: { requireModelInRouting: false },
  });
  const rr = r.actions.find(a => a.kind === 'rereview' && Number(a.pr) === 903);
  assert.ok(rr, 'draft 零判定必须产 rereview：' + JSON.stringify(r.actions.map(a => a.kind)));
  assert.equal(rr.head, head, 'head 要落回 PR 自己的 headRefOid（a.head 在没 scanned 时是 undefined）');
  assert.equal(rr.stateKey, rereviewKey(903, head), 'stateKey 必须用 headForAction，不许 @undefined');
  assert.equal(rr.scanSkipped, true, '票上要写清这一票是因为 scan 跳过，不是"没抓到"');
  assert.match(rr.why, /一条判定都没有/, '零判定的措辞不许说成「N 条判定都打在旧 commit 上」');
  assert.equal(/undefined/.test(rr.why), false, '不许把 undefined 写进给人看的话里');
  assert.equal(/undefined/.test(String(rr.stateKey)), false, '账键不许带 undefined');
});

test('draft 跳过 + 非 draft 请求失败：没有任何 reviews 请求成功 → scanned:false，skipped 遮不住', async () => {
  const { scanPrReviews } = await import('../scripts/commander.mjs');
  const { decide } = await import('../scripts/lib/commander-core.mjs');
  const draft = { number: 9901, isDraft: true, headRefOid: 'a'.repeat(40), labels: [{ name: 'reviewer/grok-4.6' }] };
  const ready = { number: 9902, isDraft: false, headRefOid: 'b'.repeat(40), labels: [{ name: 'reviewer/grok-4.6' }] };
  const read = (args) => {
    assert.equal(String(args[2]).endsWith('/9901/reviews'), false, 'draft 不该去查 reviews（省额度那条要保住）');
    return { ok: false, error: 'simulated reviews API failure' };
  };
  const s = scanPrReviews([draft, ready], { issues: [], read });
  assert.equal(s.scanned, false, '没有任何 reviews 请求成功时必须 scanned:false');
  assert.match(String(s.error), /simulated reviews API failure/);
  assert.equal(s.partialError, undefined, '整节没查成走 error，不许用 partialError 伪装 scanned');
  assert.deepEqual(s.byPr || {}, {}, '一条 reviews 都没抓到');
  const r = decide({
    github: { scanned: true, issues: [], prs: [draft, ready] },
    trees: { scanned: true, worktrees: [] },
    reviewPending: { scanned: true, items: [] },
    prReviews: s,
    stall: { scanned: true, strikes: {} },
    admission: { ok: true, slots: 10, cores: 6 },
    commanderPolicy: { requireModelInRouting: false },
  });
  const rereviewFailed = r.actions.filter(a => a.kind === 'rereview' && Number(a.pr) === 9902);
  assert.deepEqual(rereviewFailed, [], '失败的非 draft 不许被 skipped draft 带成零判定');
  const failVisible = r.actions.find(a => a.kind === 'escalate');
  assert.equal(failVisible && failVisible.reason, 'unscanned');
  assert.equal((failVisible.missing || []).includes('prReviews'), true);
});

test('负控：reviews 真没抓到（不是跳过）仍按旧契约静默跳过，不产动作', async () => {
  const { decide } = await import('../scripts/lib/commander-core.mjs');
  const pr = { number: 904, isDraft: false, headRefOid: 'd'.repeat(40), labels: [{ name: 'reviewer/grok-4.6' }] };
  const r = decide({
    github: { scanned: true, issues: [], prs: [pr] },
    trees: { scanned: true, worktrees: [] },
    reviewPending: { scanned: true, items: [] },
    // 没抓到：byPr 空、skipped 空 —— 与「跳过」长得像，处置必须相反
    prReviews: { scanned: true, byPr: {}, skipped: [] },
    stall: { scanned: true, strikes: {} },
    admission: { ok: true, slots: 10, cores: 6 },
    commanderPolicy: { requireModelInRouting: false },
  });
  assert.equal(r.actions.some(a => a.kind === 'rereview' && Number(a.pr) === 904), false,
    '没抓到 ≠ 零判定：臆测会派出一堆重复审官');
});
