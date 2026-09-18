import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTask, judgeReview, judgeChecks, judgeDelivery, classifyStepFailure, taskIdOf } from '../src/contract.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGED = 'c'.repeat(40);
const input = () => ({
  repository: 'owner/repo', issue: 17, generation: 1,
  contract: { requiredChecks: ['check'], deploymentRequired: false, targetBranch: 'master' },
  limits: { reviewRounds: 6, stepTimeoutSeconds: 1800 },
  roles: {
    lead: { profile: 'lead', family: 'openai', accountPool: 'a' },
    executor: { profile: 'executor', family: 'xai', accountPool: 'b' },
    reviewer: { profile: 'reviewer', family: 'anthropic', accountPool: 'c' },
  },
});
const review = () => ({ completed: true, head: HEAD, findings: [], identityVerified: true, executorFamily: 'xai', reviewerFamily: 'anthropic' });
const checks = () => ({ scanned: true, head: HEAD, checks: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
const delivery = () => ({ repository: 'owner/repo', issue: 17, pr: 19, sourceHead: HEAD, merged: true, mergeCommit: MERGED, baseRefName: 'master' });

describe('one task identity across events, nodes and internal agents', () => {
  it('normalizes repository identity without conflating issue generations or repositories', () => {
    assert.equal(normalizeTask({ ...input(), repository: 'Owner/Repo' }).id, normalizeTask(input()).id);
    assert.notEqual(normalizeTask({ ...input(), generation: 2 }).id, normalizeTask(input()).id);
    assert.notEqual(normalizeTask({ ...input(), repository: 'owner/other' }).id, normalizeTask(input()).id);
    assert.equal(taskIdOf({ repository: 'Owner/Repo', issue: 17 }), normalizeTask(input()).id);
  });
  it('refuses incomplete contracts, unknown budgets and unverified role identity', () => {
    for (const issue of [0, -1, '17', null]) assert.throws(() => normalizeTask({ ...input(), issue }), /issue/);
    assert.throws(() => normalizeTask({ ...input(), contract: { requiredChecks: [], deploymentRequired: false } }), /checks/);
    assert.throws(() => normalizeTask({ ...input(), limits: { reviewRounds: 0, stepTimeoutSeconds: 30 } }), /review/);
    const spec = input();
    delete spec.roles.reviewer.family;
    assert.throws(() => normalizeTask(spec), /family/);
  });
  it('requires independent reviewer family, not just a different profile or channel', () => {
    const spec = input();
    spec.roles.reviewer.family = 'xai';
    assert.throws(() => normalizeTask(spec), /independent/);
  });
  it('does not let caller-selected workflow ids merge unrelated tasks', () => {
    assert.throws(() => normalizeTask({ ...input(), id: 'some-other-task' }), /identity/);
  });
});

describe('review remains independent within the same task', () => {
  it('accepts a completed, correctly attributed review on exactly the tested head', () => {
    assert.deepEqual(judgeReview(normalizeTask(input()), HEAD, review()), { state: 'passed', blocking: [], advisory: [] });
  });
  it('does not interpret missing, interrupted or old-head reviews as zero findings', () => {
    for (const evidence of [null, {}, { ...review(), completed: false }, { ...review(), head: BASE }, { ...review(), findings: null }]) {
      assert.equal(judgeReview(normalizeTask(input()), HEAD, evidence).state, 'unscanned');
    }
  });
  it('does not trust the contract claim for identity: evidence must carry verified families', () => {
    for (const evidence of [
      { ...review(), identityVerified: false },
      { ...review(), identityVerified: undefined },
      { ...review(), executorFamily: undefined },
      { ...review(), reviewerFamily: undefined },
      { ...review(), executorFamily: 'anthropic' },
      { ...review(), reviewerFamily: 'xai' },
      { ...review(), reviewerFamily: 'google' },
    ]) assert.equal(judgeReview(normalizeTask(input()), HEAD, evidence).state, 'unscanned', JSON.stringify(evidence));
  });
  it('blocks P1, keeps P2/P3 advisory and preserves stable finding ids', () => {
    const p1 = { id: 'lost-write', severity: 'P1', detail: 'lost write' };
    const p2 = { id: 'naming', severity: 'P2', detail: 'naming' };
    const r = judgeReview(normalizeTask(input()), HEAD, { ...review(), findings: [p1, p2] });
    assert.equal(r.state, 'blocked');
    assert.deepEqual(r.blocking, [p1]);
    assert.deepEqual(r.advisory, [p2]);
    assert.equal(judgeReview(normalizeTask(input()), HEAD, { ...review(), findings: [p2] }).state, 'passed');
  });
  it('rejects duplicate findings and unsupported severities', () => {
    const f = { id: 'x', severity: 'P1', detail: 'x' };
    for (const value of [
      { ...review(), findings: [f, f] },
      { ...review(), findings: [{ ...f, severity: 'P0' }] },
    ]) assert.equal(judgeReview(normalizeTask(input()), HEAD, value).state, 'unscanned');
  });
});

describe('acceptance is evidence, not an agent saying done', () => {
  it('checks all required names on the exact head; skips and cancellations do not pass', () => {
    const task = normalizeTask(input());
    assert.equal(judgeChecks(task, HEAD, checks()).state, 'passed');
    for (const evidence of [null, { ...checks(), head: BASE }, { ...checks(), scanned: false }, { ...checks(), checks: [] }]) {
      assert.equal(judgeChecks(task, HEAD, evidence).state, 'unscanned');
    }
    for (const conclusion of ['SKIPPED', 'CANCELLED', 'FAILURE', null]) {
      assert.notEqual(judgeChecks(task, HEAD, { ...checks(), checks: [{ name: 'check', status: 'COMPLETED', conclusion }] }).state, 'passed');
    }
  });
  it('does not allow contradictory duplicates to hide a failed check', () => {
    const c = checks();
    c.checks.push({ name: 'check', status: 'COMPLETED', conclusion: 'FAILURE' });
    assert.notEqual(judgeChecks(normalizeTask(input()), HEAD, c).state, 'passed');
  });
  it('cannot close on a successful turn, an open PR or a different source head', () => {
    const task = normalizeTask(input());
    assert.equal(judgeDelivery(task, HEAD, delivery()).state, 'passed');
    for (const evidence of [null, { done: true }, { ...delivery(), merged: false }, { ...delivery(), sourceHead: BASE }, { ...delivery(), repository: 'owner/other' }, { ...delivery(), issue: 18 }]) {
      assert.notEqual(judgeDelivery(task, HEAD, evidence).state, 'passed');
    }
  });
  it('refuses a merge into any branch other than the contract target', () => {
    const task = normalizeTask(input());
    assert.equal(judgeDelivery(task, HEAD, { ...delivery(), baseRefName: 'develop' }).state, 'unscanned');
    assert.equal(judgeDelivery(task, HEAD, { ...delivery(), baseRefName: undefined }).state, 'unscanned');
  });
  it('requires production evidence at the merge commit when deployment is part of the contract', () => {
    const task = normalizeTask({ ...input(), contract: { requiredChecks: ['check'], deploymentRequired: true, targetBranch: 'master' } });
    assert.equal(judgeDelivery(task, HEAD, delivery()).state, 'unscanned');
    assert.equal(judgeDelivery(task, HEAD, { ...delivery(), deployment: { checked: true, healthy: true, commit: HEAD } }).state, 'unscanned');
    assert.equal(judgeDelivery(task, HEAD, { ...delivery(), deployment: { checked: true, healthy: true, commit: MERGED } }).state, 'passed');
  });
});

describe('retry classification does not create new task cards', () => {
  it('authentication needs repair, throttling waits, transport loss is not a code-review failure', () => {
    assert.equal(classifyStepFailure({ code: 'AUTH_REQUIRED' }), 'blocked');
    assert.equal(classifyStepFailure({ code: 'RATE_LIMITED' }), 'retryable');
    assert.equal(classifyStepFailure({ code: 'TRANSPORT_CLOSED' }), 'retryable');
    assert.equal(classifyStepFailure({ code: 'INVALID_CONTRACT' }), 'blocked');
    assert.equal(classifyStepFailure({ code: 'CANCELLED' }), 'cancelled');
    assert.equal(classifyStepFailure({ code: 'UNKNOWN' }), 'unscanned');
  });
});
