import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runFusionTask } from '../src/runner.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const M = 'c'.repeat(40);
const task = () => ({ repository: 'owner/repo', issue: 17, generation: 1,
  contract: { requiredChecks: ['check'], deploymentRequired: false },
  limits: { reviewRounds: 2, stepTimeoutSeconds: 60 },
  roles: {
    lead: { profile: 'lead', family: 'openai', accountPool: 'a' },
    executor: { profile: 'executor', family: 'xai', accountPool: 'b' },
    reviewer: { profile: 'reviewer', family: 'anthropic', accountPool: 'c' },
  },
});
function fixture(overrides = {}) {
  const calls = [];
  const methods = {
    prepare: async () => ({ repository: 'owner/repo', head: B, checkpoint: 'base' }),
    lead: async () => ({ plan: 'Implement the bounded task.' }),
    execute: async () => ({ repository: 'owner/repo', head: A, checkpoint: 'artifact' }),
    verify: async (_task, artifact) => ({ scanned: true, head: artifact.head, checks: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }] }),
    review: async (_task, artifact) => ({ completed: true, head: artifact.head, findings: [], profile: 'reviewer', family: 'anthropic' }),
    integrate: async (_task, artifact) => ({ repository: 'owner/repo', issue: 17, pr: 19, merged: true, sourceHead: artifact.head, mergeCommit: M }),
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
    assert.deepEqual(f.calls, ['prepare', 'lead', 'execute', 'verify', 'review', 'integrate', 'closeIssue']);
  });
  it('keeps rework inside the same task and does not integrate an earlier rejected head', async () => {
    let reviews = 0;
    const f = fixture({
      execute: async () => ({ repository: 'owner/repo', head: reviews ? B : A, checkpoint: 'artifact' }),
      review: async (_task, artifact) => ({ completed: true, head: artifact.head, profile: 'reviewer', family: 'anthropic', findings: reviews++ ? [] : [{ id: 'broken-edge', severity: 'P1', detail: 'Fix edge.' }] }),
    });
    const result = await runFusionTask(task(), f.io);
    assert.equal(result.state, 'completed');
    assert.equal(result.round, 2);
    assert.equal(result.acceptedHead, B);
    assert.equal(f.calls.filter(name => name === 'integrate').length, 1);
    assert.equal(f.calls.filter(name => name === 'closeIssue').length, 1);
  });
  it('halts at the review budget without closing or manufacturing a new issue', async () => {
    const f = fixture({ review: async () => ({ completed: true, head: A, profile: 'reviewer', family: 'anthropic', findings: [{ id: 'broken', severity: 'P1', detail: 'Still broken.' }] }) });
    const result = await runFusionTask(task(), f.io);
    assert.equal(result.state, 'blocked');
    assert.equal(result.reason, 'review-budget-exhausted');
    assert.equal(result.round, 2);
    assert.equal(f.calls.includes('integrate'), false);
    assert.equal(f.calls.includes('closeIssue'), false);
  });
  it('never merges when the review is incomplete, stale or unauthenticated', async () => {
    for (const review of [async () => null, async () => ({ completed: true, head: B, findings: [] }), async () => { throw Object.assign(new Error('login required'), { code: 'AUTH_REQUIRED' }); }]) {
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
