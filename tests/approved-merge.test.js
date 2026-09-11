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

test('only explicitly approved execution with current review and complete CI can release draft', async () => {
  const { canReleaseApprovedDraft } = await load;
  assert.equal(canReleaseApprovedDraft(data()), true);
  const variants = [x => { x.issue.labels = [{ name: '已拍板' }]; },
    x => { x.issue.number = 819; }, x => { x.greenAtHead = false; },
    x => { x.pr.headRefOid = 'b'.repeat(40); }, x => { x.pr.mergeable = 'UNKNOWN'; },
    x => { x.pr.statusCheckRollup = []; }, x => { x.pr.statusCheckRollup[0].status = 'IN_PROGRESS'; }];
  for (const change of variants) { const x = data(); change(x); assert.equal(canReleaseApprovedDraft(x), false); }
});

test('commander emits approval-bound merge rather than another user question', async () => {
  const { decide } = await import('../scripts/lib/commander-core.mjs');
  const x = data();
  const r = decide({ github: { scanned: true, issues: [x.issue], prs: [x.pr] },
    trees: { scanned: true, worktrees: [] }, reviewPending: { scanned: true, items: [] },
    prReviews: { scanned: true, byPr: { 1191: { reviews: [{ state: 'APPROVED', commit_id: head }] } } },
    stall: { scanned: true, strikes: {} }, commanderPolicy: { requireModelInRouting: false } });
  const merge = r.actions.find(a => a.kind === 'merge');
  assert.equal(merge?.approvalIssue, 1182);
  assert.equal(merge?.head, head);
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
