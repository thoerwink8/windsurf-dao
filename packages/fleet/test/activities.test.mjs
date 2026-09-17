import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createActivities } from '../src/activities.mjs';

const H = 'a'.repeat(40);
const task = { id: 'dao/owner/repo/issue/17/g1', repository: 'owner/repo', issue: 17, generation: 1,
  contract: { requiredChecks: ['check'], deploymentRequired: false },
  limits: { reviewRounds: 2, stepTimeoutSeconds: 60 },
  roles: {
    lead: { profile: 'lead-profile', family: 'openai', accountPool: 'a' },
    executor: { profile: 'exec-profile', family: 'xai', accountPool: 'b' },
    reviewer: { profile: 'review-profile', family: 'anthropic', accountPool: 'c' },
  } };
const text = (value) => ({ text: value, snapshot: { model: 'review-model' } });

function harness(overrides = {}) {
  const calls = [];
  const sessions = new Map();
  let nextKey = 0;
  const runtime = {
    ensureWorkspace: async (repo, branch) => { calls.push(['ensureWorkspace', repo, branch]); return { path: `/trees/${branch}` }; },
    startSession: async (spec) => { const key = `session-${++nextKey}`; sessions.set(key, spec); calls.push(['startSession', spec.profileId, spec.workdir]); return { sessionKey: key }; },
    waitForCompletion: async (key) => ({ status: sessions.get(key).settle || 'done' }),
    readSession: async (key) => sessions.get(key).view ?? text('{}'),
    listSessions: async () => ({ ok: true, sessions: [...sessions].map(([key, spec]) => ({ sessionKey: key, cwd: spec.workdir })) }),
    stopSession: async (key) => { calls.push(['stopSession', key]); return { ok: true }; },
    ...overrides.runtime,
  };
  const gh = async (args) => { calls.push(['gh', ...args]); return overrides.gh ? overrides.gh(args) : { ok: true, out: '{}' }; };
  const git = async (args, { cwd } = {}) => { calls.push(['git', ...args, cwd]); return overrides.git ? overrides.git(args, cwd) : { status: 0, out: H }; };
  const activities = createActivities({
    runtime, gh, git,
    projects: { 'owner/repo': '/repos/repo' },
    leadPrompt: () => 'lead prompt', executorPrompt: () => 'exec prompt', reviewerPrompt: () => 'review prompt',
    ...overrides.deps,
  });
  return { activities, calls, sessions, runtime };
}

describe('activities bind the workflow to real systems', () => {
  it('prepare maps the repository to its checkout and creates the deterministic branch', async () => {
    const { activities, calls } = harness();
    const prepared = await activities.prepare(task);
    assert.equal(prepared.repository, 'owner/repo');
    assert.equal(prepared.head, H);
    assert.equal(prepared.checkpoint, '/trees/dao/issue-17-g1');
    assert.equal(prepared.branch, 'dao/issue-17-g1');
    assert.deepEqual(calls[0], ['ensureWorkspace', '/repos/repo', 'dao/issue-17-g1']);
  });
  it('refuses repositories without a mapped checkout instead of guessing a path', async () => {
    const { activities } = harness();
    await assert.rejects(activities.prepare({ ...task, repository: 'other/repo' }), /no local checkout/);
  });
  it('execute pushes the branch and reuses the existing PR instead of opening a second one', async () => {
    const { activities, calls } = harness({ gh: async (args) => (args[0] === 'pr' && args[1] === 'list' ? { ok: true, out: '[{"number":19}]' } : { ok: true, out: '{}' }) });
    const artifact = await activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'dao/issue-17-g1' }, round: 0 });
    assert.equal(artifact.pr, 19);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'git' && rest[0] === 'push'), true);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'gh' && rest[0] === 'pr' && rest[1] === 'create'), false);
  });
  it('execute opens a draft PR only when none exists, and fails loudly when the number is unresolvable', async () => {
    const created = harness({ gh: async (args) => (args[1] === 'list' ? { ok: true, out: '[]' } : args[1] === 'create' ? { ok: true, out: 'https://github.com/owner/repo/pull/23' } : { ok: true, out: '{}' }) });
    const artifact = await created.activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'dao/issue-17-g1' }, round: 0 });
    assert.equal(artifact.pr, 23);
    const broken = harness({ gh: async (args) => (args[1] === 'list' ? { ok: true, out: '[]' } : { ok: true, out: 'no url here' }) });
    await assert.rejects(broken.activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'dao/issue-17-g1' }, round: 0 }), /pr number unresolved/);
  });
  it('a session that does not finish is a failure, never an empty result', async () => {
    const { activities } = harness({ runtime: { waitForCompletion: async () => ({ status: 'unknown' }) } });
    await assert.rejects(activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'b' }, round: 0 }), /executor session unknown/);
  });
  it('verify reports unscanned when the rollup is unavailable instead of an empty passing set', async () => {
    const { activities } = harness({ gh: async () => ({ ok: true, out: '{"headRefOid":"' + H + '"}' }) });
    const evidence = await activities.verify(task, { pr: 19, checkpoint: '/trees/b' });
    assert.equal(evidence.scanned, false);
    assert.deepEqual(evidence.checks, []);
  });
  it('review checks out the exact artifact head and refuses unparseable findings', async () => {
    const { activities, calls } = harness({ runtime: { readSession: async () => text('no json here') } });
    const result = await activities.review(task, { head: H, checkpoint: '/trees/b', pr: 19 }, { checks: {} });
    assert.equal(result.completed, false);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'git' && rest[0] === 'checkout' && rest[1] === '--detach' && rest[2] === H), true);
  });
  it('review returns parsed findings with the reviewer identity from the task contract', async () => {
    const { activities } = harness({ runtime: { readSession: async () => text('```json\n{"findings":[{"id":"lost-write","severity":"P1","detail":"lost write"}]}\n```') } });
    const result = await activities.review(task, { head: H, checkpoint: '/trees/b', pr: 19 }, { checks: {} });
    assert.equal(result.completed, true);
    assert.equal(result.family, 'anthropic');
    assert.deepEqual(result.findings, [{ id: 'lost-write', severity: 'P1', detail: 'lost write' }]);
  });
  it('integrate reads the merge result back instead of trusting the merge command exit code', async () => {
    const { activities } = harness({ gh: async (args) => (args[1] === 'merge' ? { ok: true, out: '' } : args[1] === 'view' ? { ok: true, out: JSON.stringify({ state: 'MERGED', number: 19, headRefOid: H, mergeCommit: { oid: 'c'.repeat(40) } }) } : { ok: true, out: '{}' }) });
    const delivery = await activities.integrate(task, { pr: 19, head: H, checkpoint: '/trees/b' });
    assert.equal(delivery.merged, true);
    assert.equal(delivery.mergeCommit, 'c'.repeat(40));
  });
  it('cleanup verifies both sessions and the workspace before claiming success', async () => {
    const ok = harness();
    const good = await ok.activities.cleanup(task, { checkpoint: '/trees/b' });
    assert.equal(good.verified, true);
    const bad = harness({ runtime: { stopSession: async () => ({ ok: false }) } });
    await bad.runtime.startSession({ profileId: 'x', workdir: '/trees/b' });
    const worse = await bad.activities.cleanup(task, { checkpoint: '/trees/b' });
    assert.equal(worse.verified, false);
  });
});
