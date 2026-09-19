import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runFusionTask } from '../src/runner.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const M = 'c'.repeat(40);
const task = () => ({ repository: 'owner/repo', issue: 17, generation: 1,
  contract: { requiredChecks: ['check'], deploymentRequired: false, targetBranch: 'master' },
  limits: { reviewRounds: 2, stepTimeoutSeconds: 60 },
  roles: {
    lead: { profile: 'lead', family: 'openai', accountPool: 'a' },
    executor: { profile: 'executor', family: 'xai', accountPool: 'b' },
    reviewer: { profile: 'reviewer', family: 'anthropic', accountPool: 'c' },
  },
});
const pass = () => ({ completed: true, head: A, findings: [], identityVerified: true, executorFamily: 'xai', reviewerFamily: 'anthropic' });
function fixture(overrides = {}) {
  const calls = [];
  const methods = {
    prepare: async () => ({ repository: 'owner/repo', head: B, checkpoint: 'base' }),
    lead: async () => ({ plan: 'Implement the bounded task.' }),
    execute: async () => ({ repository: 'owner/repo', head: A, checkpoint: 'artifact' }),
    verify: async (_task, artifact) => ({ scanned: true, head: artifact.head, checks: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }] }),
    selfReview: async (_task, artifact) => ({ scanned: true, head: artifact.head, findings: [] }),
    changedFiles: async () => ({ scanned: true, files: ['scripts/lib/x.mjs'] }),
    review: async (_task, artifact) => ({ ...pass(), head: artifact.head }),
    integrate: async (_task, artifact) => ({ repository: 'owner/repo', issue: 17, pr: 19, merged: true, sourceHead: artifact.head, mergeCommit: M, baseRefName: 'master' }),
    deploy: async () => ({ checked: true, healthy: true, commit: M }),
    closeIssue: async () => ({ repository: 'owner/repo', issue: 17, closed: true }),
    ...overrides,
  };
  const io = Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, async (...args) => { calls.push(name); return fn(...args); }]));
  return { calls, io };
}

describe('one durable task owns execution, review, rework and closure', () => {
  it('closes only after verification, independent review and confirmed merge', async () => {
    const f = fixture();
    const result = await runFusionTask(task(), f.io);
    assert.equal(result.state, 'completed');
    assert.equal(result.acceptedHead, A);
    assert.deepEqual(f.calls, ['prepare', 'lead', 'execute', 'verify', 'changedFiles', 'selfReview', 'review', 'integrate', 'closeIssue']);
  });
  it('T32：P2/P3（advisory）随 delivery 走到 closeIssue，不被丢掉', async () => {
    let seen = null;
    const f = fixture({
      review: async (_task, artifact) => ({ ...pass(), head: artifact.head, findings: [{ id: 'minor', severity: 'P2', type: 'perf', effort: 'small', detail: 'Minor.' }] }),
      closeIssue: async (_task, delivery) => { seen = delivery; return { repository: 'owner/repo', issue: 17, closed: true }; },
    });
    const result = await runFusionTask(task(), f.io);
    assert.equal(result.state, 'completed');
    assert.deepEqual(seen.advisory, [{ id: 'minor', severity: 'P2', type: 'perf', effort: 'small', detail: 'Minor.' }]);
  });
  it('T7：返工反馈里带上一轮执行会话的 key（续跑用）', async () => {
    let seen = null;
    let reviews = 0;
    let execs = 0;
    const f = fixture({
      execute: async (_task, { feedback }) => { if (feedback) seen = feedback; return { repository: 'owner/repo', head: execs++ ? B : A, checkpoint: 'artifact', sessionKey: execs === 1 ? 's1' : 's2' }; },
      review: async (_task, artifact) => ({ ...pass(), head: artifact.head, findings: reviews++ ? [] : [{ id: 'x', severity: 'P1', detail: 'd' }] }),
    });
    const result = await runFusionTask(task(), f.io);
    assert.equal(result.state, 'completed');
    assert.equal(seen.sessionKey, 's1');
  });
  it('T33：返工只带「P1 + 急的 + 便宜且上下文热的」，大改不进返工', async () => {
    let seen = null;
    let reviews = 0;
    const f = fixture({
      execute: async () => ({ repository: 'owner/repo', head: reviews ? B : A, checkpoint: 'artifact', sessionKey: 's1' }),
      review: async (_task, artifact) => ({ ...pass(), head: artifact.head, findings: reviews++ ? [] : [
        { id: 'p1', severity: 'P1', detail: 'd' },
        { id: 'small', severity: 'P2', type: 'perf', effort: 'small', detail: 'd' },
        { id: 'big', severity: 'P2', type: 'perf', effort: 'large', detail: 'd' },
      ] }),
      lead: async (_task, { feedback }) => { if (feedback) seen = feedback; return { plan: 'p' }; },
    });
    const result = await runFusionTask(task(), f.io);
    assert.equal(result.state, 'completed');
    assert.deepEqual(seen.blocking.map((x) => x.id), ['p1', 'small']);
  });
  it('T33：lead 自审捞到便宜的问题 → 当场返工，不烧异厂审查', async () => {
    let selfReviews = 0;
    let seen = null;
    const f = fixture({
      execute: async () => ({ repository: 'owner/repo', head: selfReviews ? B : A, checkpoint: 'artifact', sessionKey: 's1' }),
      selfReview: async (_task, artifact) => {
        selfReviews += 1;
        return { scanned: true, head: artifact.head, findings: selfReviews === 1 ? [{ id: 'naming', severity: 'P2', type: 'maintainability', effort: 'small', detail: 'd' }] : [] };
      },
      lead: async (_task, { feedback }) => { if (feedback) seen = feedback; return { plan: 'p' }; },
    });
    const result = await runFusionTask(task(), f.io);
    assert.equal(result.state, 'completed');
    assert.equal(result.round, 2);
    assert.deepEqual(seen.blocking.map((x) => x.id), ['naming']);
    assert.equal(f.calls.filter((n) => n === 'selfReview').length, 2);
    assert.equal(f.calls.filter((n) => n === 'review').length, 1, '异厂审查只在自审干净后才跑');
  });
  it('T34：纯文档改动（T0）→ CI 绿即过，不派自审也不派异厂审查', async () => {
    const f = fixture({ changedFiles: async () => ({ scanned: true, files: ['docs/x.md', 'README.md'] }) });
    const result = await runFusionTask(task(), f.io);
    assert.equal(result.state, 'completed');
    assert.equal(result.riskTier, 'T0');
    assert.equal(f.calls.includes('selfReview'), false);
    assert.equal(f.calls.includes('review'), false);
  });
  it('T34：孤立代码（T1）→ 只走一条异厂审查，不派自审', async () => {
    const f = fixture({ changedFiles: async () => ({ scanned: true, files: ['src/thing.js'] }) });
    const result = await runFusionTask(task(), f.io);
    assert.equal(result.state, 'completed');
    assert.equal(result.riskTier, 'T1');
    assert.equal(f.calls.includes('selfReview'), false);
    assert.equal(f.calls.includes('review'), true);
  });
  it('T34：没查成（文件清单空）→ 保守按 T2 走全流程', async () => {
    const f = fixture({ changedFiles: async () => ({ scanned: false, files: [] }) });
    const result = await runFusionTask(task(), f.io);
    assert.equal(result.state, 'completed');
    assert.equal(result.riskTier, 'T2');
    assert.equal(f.calls.includes('selfReview'), true);
    assert.equal(f.calls.includes('review'), true);
  });
  it('keeps rework inside the same task and does not integrate an earlier rejected head', async () => {
    let reviews = 0;
    const f = fixture({
      execute: async () => ({ repository: 'owner/repo', head: reviews ? B : A, checkpoint: 'artifact' }),
      review: async (_task, artifact) => ({ ...pass(), head: artifact.head, findings: reviews++ ? [] : [{ id: 'broken-edge', severity: 'P1', detail: 'Fix edge.' }] }),
    });
    const result = await runFusionTask(task(), f.io);
    assert.equal(result.state, 'completed');
    assert.equal(result.round, 2);
    assert.equal(result.acceptedHead, B);
    assert.equal(f.calls.filter(name => name === 'integrate').length, 1);
    assert.equal(f.calls.filter(name => name === 'closeIssue').length, 1);
  });
  it('turns a failed check into rework without spending a review round', async () => {
    let verifies = 0;
    const f = fixture({
      execute: async () => ({ repository: 'owner/repo', head: verifies ? B : A, checkpoint: 'artifact' }),
      verify: async (_task, artifact) => (verifies++ ? { scanned: true, head: artifact.head, checks: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }] } : { scanned: true, head: artifact.head, checks: [{ name: 'check', status: 'COMPLETED', conclusion: 'FAILURE' }] }),
    });
    const result = await runFusionTask(task(), f.io);
    assert.equal(result.state, 'completed');
    assert.equal(f.calls.filter(name => name === 'review').length, 1, '检查失败那一轮不该进审查');
    assert.equal(f.calls.filter(name => name === 'verify').length, 2);
  });
  it('halts at the review budget without closing or manufacturing a new issue', async () => {
    const f = fixture({ review: async () => ({ ...pass(), head: A, findings: [{ id: 'broken', severity: 'P1', detail: 'Still broken.' }] }) });
    const result = await runFusionTask(task(), f.io);
    assert.equal(result.state, 'blocked');
    assert.equal(result.reason, 'review-budget-exhausted');
    assert.equal(result.round, 2);
    assert.equal(f.calls.includes('integrate'), false);
    assert.equal(f.calls.includes('closeIssue'), false);
  });
  it('never merges when the review is incomplete, stale, unauthenticated or identity-unverified', async () => {
    for (const review of [
      async () => null,
      async () => ({ ...pass(), head: B }),
      async () => ({ ...pass(), head: A, identityVerified: false }),
      async () => ({ ...pass(), head: A, executorFamily: 'anthropic' }),
      async () => { throw Object.assign(new Error('login required'), { code: 'AUTH_REQUIRED' }); },
    ]) {
      const f = fixture({ review });
      const result = await runFusionTask(task(), f.io);
      assert.equal(result.state, 'blocked');
      assert.equal(f.calls.includes('integrate'), false);
      assert.equal(f.calls.includes('closeIssue'), false);
    }
  });
  it('keeps a transport failure separate from a completed review round', async () => {
    const f = fixture({ execute: async () => { throw Object.assign(new Error('connection lost'), { code: 'TRANSPORT_CLOSED' }); } });
    const result = await runFusionTask(task(), f.io);
    assert.equal(result.state, 'blocked');
    assert.equal(result.failureClass, 'retryable');
    assert.equal(result.round, 0);
    assert.equal(f.calls.includes('closeIssue'), false);
  });
  it('resumes closure after an unconfirmed close without rerunning agents or merging again', async () => {
    const first = fixture({ closeIssue: async () => { throw Object.assign(new Error('unknown response'), { code: 'TRANSPORT_CLOSED' }); } });
    const saved = await runFusionTask(task(), first.io);
    assert.equal(saved.state, 'blocked');
    assert.equal(saved.phase, 'closing');
    const next = fixture();
    const result = await runFusionTask(task(), next.io, { previous: saved });
    assert.equal(result.state, 'completed');
    assert.deepEqual(next.calls, ['closeIssue']);
  });
  it('rechecks invalid workspace evidence instead of caching it as prepared', async () => {
    const first = fixture({ prepare: async () => ({ repository: 'wrong/repo', head: B, checkpoint: 'bad' }) });
    const saved = await runFusionTask(task(), first.io);
    assert.equal(saved.state, 'blocked');
    const next = fixture();
    const result = await runFusionTask(task(), next.io, { previous: saved });
    assert.equal(result.state, 'completed');
    assert.equal(next.calls[0], 'prepare');
  });
  it('does not reuse another task checkpoint', async () => {
    const f = fixture();
    await assert.rejects(runFusionTask(task(), f.io, { previous: { taskId: 'wrong' } }), /checkpoint identity/);
    assert.deepEqual(f.calls, []);
  });
  it('does not close before deployment when the project requires it', async () => {
    const spec = task();
    spec.contract.deploymentRequired = true;
    const f = fixture({ deploy: async () => ({ checked: true, healthy: false, commit: M }) });
    const result = await runFusionTask(spec, f.io);
    assert.equal(result.state, 'blocked');
    assert.equal(result.reason, 'deployment-unhealthy');
    assert.equal(f.calls.includes('closeIssue'), false);
  });
  it('does not execute more work after a cancellation request', async () => {
    const f = fixture();
    const result = await runFusionTask(task(), f.io, { cancelled: () => true });
    assert.equal(result.state, 'cancelled');
    assert.deepEqual(f.calls, []);
  });
});
