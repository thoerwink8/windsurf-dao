import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createActivities, parseFindings, parsePlan, parseSingle, commitPrefixFor } from '../src/activities.mjs';
import { readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const task = { id: 'dao/owner/repo/issue/17/g1', repository: 'owner/repo', issue: 17, generation: 1,
  contract: { requiredChecks: ['check'], deploymentRequired: false, targetBranch: 'master' },
  limits: { reviewRounds: 2, stepTimeoutSeconds: 60 },
  roles: {
    lead: { profile: 'lead-profile', family: 'openai', accountPool: 'a' },
    executor: { profile: 'exec-profile', family: 'xai', accountPool: 'b' },
    reviewer: { profile: 'review-profile', family: 'anthropic', accountPool: 'c' },
  } };
const text = (value) => ({ text: value, snapshot: { model: 'review-model' } });
const FAMILIES = { 'lead-profile': 'openai', 'exec-profile': 'xai', 'review-profile': 'anthropic' };

function harness(overrides = {}) {
  const calls = [];
  const sessions = new Map();
  let nextKey = 0;
  const runtime = {
    ensureWorkspace: async (repo, branch) => { calls.push(['ensureWorkspace', repo, branch]); return { path: `/trees/${branch}` }; },
    startSession: async (spec) => { const key = `session-${++nextKey}`; sessions.set(key, spec); calls.push(['startSession', spec.profileId, spec.workdir]); return { sessionKey: key }; },
    waitForCompletion: async (key) => ({ status: sessions.get(key).settle || 'done' }),
    readSession: async (key) => sessions.get(key).view ?? text('{}'),
    listSessions: async () => { calls.push(['listSessions']); return { ok: true, sessions: [...sessions].map(([key, spec]) => ({ sessionKey: key, cwd: spec.workdir })) }; },
    stopSession: async (key) => { calls.push(['stopSession', key]); return { ok: true }; },
    ...overrides.runtime,
  };
  const gh = async (args, { role } = {}) => { calls.push(['gh', ...args, role]); return overrides.gh ? overrides.gh(args) : { ok: true, out: '{}' }; };
  const git = async (args, { cwd } = {}) => { calls.push(['git', ...args, cwd]); return overrides.git ? overrides.git(args, cwd) : { status: 0, out: H }; };
  const activities = createActivities({
    runtime, gh, git,
    projects: { 'owner/repo': '/repos/repo' },
    profileOf: id => (FAMILIES[id] ? { agent: id === 'review-profile' ? 'codex' : 'grok', family: FAMILIES[id] } : null),
    unknownWaitMs: 1, unknownWaitRounds: 1,
    leadPrompt: () => 'lead prompt', executorPrompt: () => 'exec prompt', reviewerPrompt: () => 'review prompt',
    ...overrides.deps,
  });
  return { activities, calls, sessions, runtime };
}

describe('review output parsing is fail-closed', () => {
  it('takes the single findings document and refuses ambiguity', () => {
    assert.deepEqual(parseFindings('```json\n{"findings":[]}\n```').findings, []);
    assert.equal(parseFindings('{"findings":[{"id":"a","severity":"P1","detail":"x"}]}').findings.length, 1, '不带围栏时整段就是候选');
    const ambiguous = '```json\n{"findings":[{"id":"a","severity":"P1","detail":"x"}]}\n```\n再看一遍模板：\n```json\n{"findings":[]}\n```';
    assert.equal(parseFindings(ambiguous), null, '两份结论不同必须 unscanned，不许最后一块赢');
    const same = '{"findings":[]}\n```json\n{"findings":[]}\n```';
    assert.deepEqual(parseFindings(same).findings, []);
    assert.equal(parseFindings('no json at all'), null);
  });
  it('does not let a fenced empty template beat a bare real conclusion', () => {
    const review = '{"findings":[{"id":"a","severity":"P1","detail":"x"}]}\n\n再看一遍模板：\n```json\n{"findings":[]}\n```\n';
    assert.equal(parseFindings(review), null, '裸结论与围栏模板同时出现必须 unscanned');
    const single = '结论如下：\n```json\n{"findings":[{"id":"a","severity":"P1","detail":"x"}]}\n```\n';
    assert.equal(parseFindings(single).findings[0].id, 'a');
    const nested = '```json\n{"findings":[{"id":"a","severity":"P1","detail":"x"}]}\n```';
    assert.equal(parseFindings(nested).findings.length, 1, '嵌套对象不得被当成第二份结论');
  });
  it('parses plans the same way', () => {
    assert.equal(parsePlan('```json\n{"plan":"do it"}\n```').plan, 'do it');
    assert.equal(parsePlan('```json\n{"plan":"a"}\n```\n```json\n{"plan":"b"}\n```'), null);
    assert.equal(parseSingle('{"plan":""}', value => typeof value.plan === 'string' && value.plan.length > 0), null);
  });
});

describe('activities bind the workflow to real systems', () => {
  it('prepare maps the repository to its checkout and creates the deterministic branch', async () => {
    const { activities, calls } = harness();
    const prepared = await activities.prepare(task);
    assert.equal(prepared.repository, 'owner/repo');
    assert.equal(prepared.head, H);
    assert.equal(prepared.branch, 'dao/issue-17-g1');
    // 公约「开工前先 pull」的机械版：起树前必须先 fetch（否则从过期的 origin/master 起树）。
    assert.deepEqual(calls[0], ['git', 'fetch', 'origin', '--prune', '/repos/repo']);
    assert.deepEqual(calls.find(([kind]) => kind === 'ensureWorkspace'), ['ensureWorkspace', '/repos/repo', 'dao/issue-17-g1']);
  });
  it('prepare：fetch 失败 → 可重试失败，不拿过期基线开工', async () => {
    const { activities } = harness({ git: async (args) => (args[0] === 'fetch' ? { status: 1, err: 'could not resolve host' } : { status: 0, out: H }) });
    await assert.rejects(activities.prepare(task), /prepare fetch failed/);
  });
  it('refuses repositories without a mapped checkout instead of guessing a path', async () => {
    const { activities } = harness();
    await assert.rejects(activities.prepare({ ...task, repository: 'other/repo' }), /no local checkout/);
  });
  it('execute pushes the branch and reuses the existing PR instead of opening a second one', async () => {
    const { activities, calls } = harness({ gh: async (args) => (args[0] === 'pr' && args[1] === 'list' ? { ok: true, out: '[{"number":19,"baseRefName":"master"}]' } : { ok: true, out: '{}' }) });
    const artifact = await activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'dao/issue-17-g1', head: B }, round: 0 });
    assert.equal(artifact.pr, 19);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'git' && rest[0] === 'push'), true);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'gh' && rest[0] === 'pr' && rest[1] === 'create'), false);
  });
  it('refuses to reuse an open PR that targets a branch other than the contract target', async () => {
    const { activities, calls } = harness({ gh: async (args) => (args[1] === 'list' ? { ok: true, out: '[{"number":19,"baseRefName":"develop"}]' } : { ok: true, out: '{}' }) });
    await assert.rejects(activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'b', head: B }, round: 0 }), /targets develop/);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'gh' && rest[1] === 'create'), false);
  });
  it('T39：escalate 把裁决载荷写进收件箱（派生数据落 ~/.dao），候补腿由活动补齐', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-esc-'));
    process.env.DAO_FLEET_ESCALATION_DIR = dir;
    try {
      const { activities } = harness({ deps: { alternatesOf: async () => ['exec-alt'] } });
      const r = await activities.escalate(task, { taskId: task.id, options: ['retry', 'swap-leg'] });
      assert.equal(r.written, true);
      const doc = JSON.parse(readFileSync(r.path, 'utf8'));
      assert.deepEqual(doc.candidates, ['exec-alt']);
      assert.deepEqual(doc.options, ['retry', 'swap-leg']);
      assert.ok(doc.writtenAt, '要留写入时间');
    } finally {
      delete process.env.DAO_FLEET_ESCALATION_DIR;
    }
  });
  it('T39：上游容量墙 → 同 family 换腿重起，树/checkpoint 不动', async () => {
    let n = 0;
    const started = [];
    const { activities } = harness({
      gh: async (args) => (args[0] === 'pr' && args[1] === 'list' ? { ok: true, out: '[{"number":19,"baseRefName":"master"}]' } : { ok: true, out: '{}' }),
      runtime: {
        startSession: async (spec) => { const key = `s${++n}`; started.push(spec.profileId); return { sessionKey: key }; },
        waitForCompletion: async () => ({ status: 'done' }),
        readSession: async (key) => (key === 's1' ? { text: '{}', error: '503 capacity exceeded' } : text('{}')),
        resumeSession: async () => ({ sessionKey: null }),
      },
      deps: { alternatesOf: async () => ['exec-alt'] },
    });
    const artifact = await activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'dao/issue-17-g1', head: B }, round: 0 });
    assert.equal(artifact.legSwappedTo, 'exec-alt');
    assert.deepEqual(started, ['exec-profile', 'exec-alt']);
  });
  it('T39：换腿候选取不到 → 不挡主腿（仍走主腿）', async () => {
    const { activities, calls } = harness({
      gh: async (args) => (args[0] === 'pr' && args[1] === 'list' ? { ok: true, out: '[{"number":19,"baseRefName":"master"}]' } : { ok: true, out: '{}' }),
      deps: { alternatesOf: async () => { throw new Error('leg table unavailable'); } },
    });
    const artifact = await activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'dao/issue-17-g1', head: B }, round: 0 });
    assert.equal(artifact.legSwappedTo, null);
    assert.equal(calls.filter(([kind]) => kind === 'startSession').length, 1);
  });
  it('T33：selfReview 产出与 review 同形，但不参与判定（解析不了只当没捞到）', async () => {
    const ok = harness({ runtime: { readSession: async () => text('{"findings":[{"id":"naming","severity":"P2","type":"maintainability","effort":"small","detail":"d"}]}') } });
    const r = await ok.activities.selfReview(task, { checkpoint: '/trees/b', branch: 'b', head: H }, { checks: [], plan: { plan: 'p' } });
    assert.equal(r.scanned, true);
    assert.equal(r.findings.length, 1);
    const bad = harness({ runtime: { readSession: async () => text('no json here') } });
    const r2 = await bad.activities.selfReview(task, { checkpoint: '/trees/b', branch: 'b', head: H }, { checks: [], plan: { plan: 'p' } });
    assert.equal(r2.scanned, false);
    assert.deepEqual(r2.findings, []);
  });
  it('T7：返工带 sessionKey → 续跑同一会话，不重开', async () => {
    const resumed = [];
    const { activities, calls } = harness({
      gh: async (args) => (args[0] === 'pr' && args[1] === 'list' ? { ok: true, out: '[{"number":19,"baseRefName":"master"}]' } : { ok: true, out: '{}' }),
      runtime: {
        resumeSession: async (key) => { resumed.push(key); return { sessionKey: key }; },
        waitForCompletion: async () => ({ status: 'done' }),
        readSession: async () => text('done'),
      },
    });
    const artifact = await activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'dao/issue-17-g1', head: B }, round: 1, feedback: { head: B, sessionKey: 'session-7' } });
    assert.equal(artifact.resumed, true);
    assert.deepEqual(resumed, ['session-7']);
    assert.equal(calls.some(([kind]) => kind === 'startSession'), false, '返工不许重开会话');
  });
  it('T7：续不上（后端不支持）→ 回落新会话，不硬来', async () => {
    const { activities, calls } = harness({
      gh: async (args) => (args[0] === 'pr' && args[1] === 'list' ? { ok: true, out: '[{"number":19,"baseRefName":"master"}]' } : { ok: true, out: '{}' }),
      runtime: { resumeSession: async () => { throw new Error('resume unsupported'); } },
    });
    const artifact = await activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'dao/issue-17-g1', head: B }, round: 1, feedback: { head: B, sessionKey: 'session-7' } });
    assert.equal(artifact.resumed, false);
    assert.equal(calls.some(([kind]) => kind === 'startSession'), true, '续不上要回落新会话');
  });
  it('execute opens a draft PR only when none exists, and fails loudly when the number is unresolvable', async () => {
    const created = harness({ gh: async (args) => (args[1] === 'list' ? { ok: true, out: '[]' } : args[1] === 'create' ? { ok: true, out: 'https://github.com/owner/repo/pull/23' } : { ok: true, out: '{}' }) });
    const artifact = await created.activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'dao/issue-17-g1', head: B }, round: 0 });
    assert.equal(artifact.pr, 23);
    const broken = harness({ gh: async (args) => (args[1] === 'list' ? { ok: true, out: '[]' } : { ok: true, out: 'no url here' }) });
    await assert.rejects(broken.activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'dao/issue-17-g1', head: B }, round: 0 }), /pr number unresolved/);
  });
  it('execute refuses to push when no new commit was produced', async () => {
    const { activities, calls } = harness({ git: async (args) => (args[0] === 'rev-parse' ? { status: 0, out: B } : { status: 0, out: '' }) });
    await assert.rejects(activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'dao/issue-17-g1', head: B }, round: 0 }), /no new commit/);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'git' && rest[0] === 'push'), false);
  });
  it('unknown 宽限里会话自己完成 → 不提前杀，按终态释放一次', async () => {
    let waits = 0;
    const { activities, calls } = harness({
      runtime: {
        waitForCompletion: async () => ({ status: (waits += 1) === 1 ? 'unknown' : 'done' }),
        readSession: async () => text('```json\n{"plan":"Implement."}\n```'),
      },
      deps: { unknownWaitRounds: 3 },
    });
    const plan = await activities.lead(task, { prepared: { checkpoint: '/trees/b' }, round: 0 });
    assert.equal(plan.plan, 'Implement.');
    assert.equal(calls.filter(([kind]) => kind === 'stopSession').length, 1, '只在终态释放一次，宽限里不杀');
  });
  it('宽限里变成等人 → 立刻报 WAITING_USER，不折成可重试', async () => {
    let waits = 0;
    const { activities } = harness({
      runtime: {
        waitForCompletion: async () => ({ status: (waits += 1) === 1 ? 'unknown' : 'waiting_user' }),
        readSession: async () => ({ phase: 'running', text: '' }),
      },
      deps: { unknownWaitRounds: 3 },
    });
    await assert.rejects(activities.lead(task, { prepared: { checkpoint: '/trees/b' }, round: 0 }), error => error?.type === 'WAITING_USER');
  });
  it('宽限用尽仍未知 → 停掉会话让树，报可重试（不能既不起新的也杀不掉）', async () => {
    const { activities, calls } = harness({
      runtime: {
        waitForCompletion: async () => ({ status: 'unknown' }),
        readSession: async () => ({ phase: 'running', text: '' }),
      },
    });
    await assert.rejects(activities.lead(task, { prepared: { checkpoint: '/trees/b' }, round: 0 }), /unknown after grace/);
    assert.equal(calls.some(([kind]) => kind === 'stopSession'), true, '宽限用尽要停掉会话让树');
  });
  it('宽限轮不再叠 sleep：每轮只等一次 waitForCompletion（复核实咬 P1）', async () => {
    const sleeps = [];
    const { activities } = harness({
      runtime: {
        waitForCompletion: async () => ({ status: 'unknown' }),
        readSession: async () => ({ phase: 'running', text: '' }),
      },
      deps: { sleepFn: async ms => { sleeps.push(ms); }, unknownWaitRounds: 3 },
    });
    await assert.rejects(activities.lead(task, { prepared: { checkpoint: '/trees/b' }, round: 0 }), /unknown after grace/);
    assert.deepEqual(sleeps, [], '宽限里不许再 sleep——waitForCompletion 自己会等到点，叠了就是 2× 墙钟');
  });
  it('上游瞬时中断先续跑同一会话，不重开（用户拍板：Mirasim 支持 continue）', async () => {
    const resumes = [];
    const { activities, calls } = harness({
      runtime: {
        waitForCompletion: async () => ({ status: 'done' }),
        readSession: async () => (resumes.length
          ? text('```json\n{"plan":"Resumed."}\n```')
          : { phase: 'done', text: '', error: 'unexpected status 503 Service Unavailable: 容量已满' }),
        resumeSession: async (key, prompt) => { resumes.push({ key, prompt }); return { sessionKey: key }; },
      },
    });
    const plan = await activities.lead(task, { prepared: { checkpoint: '/trees/b' }, round: 0 });
    assert.equal(plan.plan, 'Resumed.');
    assert.equal(resumes.length, 1, '续跑一次即可');
    assert.equal(resumes[0].key, 'session-1', '续的是同一条会话 key');
    assert.equal(calls.filter(([kind]) => kind === 'startSession').length, 1, '不许重开会话');
  });
  it('非瞬时错误不续跑（续跑只治上游中断）', async () => {
    const resumes = [];
    const { activities } = harness({
      runtime: {
        waitForCompletion: async () => ({ status: 'done' }),
        readSession: async () => ({ phase: 'done', text: '', error: 'lead output not parseable' }),
        resumeSession: async key => { resumes.push(key); return { sessionKey: key }; },
      },
    });
    await assert.rejects(activities.lead(task, { prepared: { checkpoint: '/trees/b' }, round: 0 }), /not parseable/);
    assert.deepEqual(resumes, []);
  });
  it('执行体的瞬时 busy 要带类型过界（可重试），不能落成 unscanned', async () => {
    const { activities } = harness({
      runtime: { startSession: async () => { throw Object.assign(new Error('session is waiting for user'), { code: 'busy', reason: 'lease-held' }); } },
    });
    await assert.rejects(activities.lead(task, { prepared: { checkpoint: '/trees/b' }, round: 0 }), error => error?.type === 'busy');
  });
  it('非瞬时错误原样抛，不伪装成可重试', async () => {
    const { activities } = harness({ runtime: { startSession: async () => { throw new Error('boom'); } } });
    await assert.rejects(activities.lead(task, { prepared: { checkpoint: '/trees/b' }, round: 0 }), error => error?.type !== 'busy');
  });
  it('提交前缀由系统按执行档对齐：模型写错也改成 [grok]（单一真相源=执行档）', async () => {
    const { activities, calls } = harness({
      git: async (args) => (args[0] === 'log'
        ? { status: 0, out: '[codex] docs: x\n\n正文保留\n' }
        : args[0] === 'rev-parse' ? { status: 0, out: H } : { status: 0, out: '' }),
      gh: async (args) => (args[1] === 'list' ? { ok: true, out: '[{"number":19,"baseRefName":"master"}]' } : { ok: true, out: '{}' }),
    });
    const artifact = await activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'b', head: B }, round: 0 });
    assert.equal(artifact.commitPrefix.expected, '[grok]');
    assert.equal(artifact.commitPrefix.changed, true);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'git' && rest[0] === 'commit' && rest[1] === '--amend'), true, '前缀不对要 amend');
  });
  it('前缀集合与执行目录的 agent 集合同源（防漂移）', () => {
    const doc = JSON.parse(readFileSync(new URL('../../../docs/execution-profiles.json', import.meta.url), 'utf8'));
    const agents = [...new Set((doc.profiles || []).filter(p => p.enabled).map(p => p.agent))].sort();
    assert.ok(agents.length > 0, '执行目录一个执行体都没扫到 = 没查成');
    for (const agent of agents) assert.equal(commitPrefixFor(agent), `[${agent}]`, `执行体 ${agent} 必须自动有前缀`);
    assert.equal(commitPrefixFor('bad agent'), null, '不合形状的 agent 不给前缀（不猜）');
  });
  it('integrate 的每个 gh 调用都带角色（没角色的会被网关拒，g4 实咬）', async () => {
    const { activities, calls } = harness({ gh: async (args) => {
      if (args[1] === 'view') return { ok: true, out: JSON.stringify({ state: 'OPEN', number: 19, headRefOid: H, baseRefName: 'master' }) };
      return { ok: true, out: '' };
    } });
    await activities.integrate(task, { pr: 19, head: H, checkpoint: '/trees/b' }).catch(() => {});
    const ghCalls = calls.filter(([kind]) => kind === 'gh');
    assert.ok(ghCalls.length > 0, '一次 gh 调用都没记到 = 没查成');
    assert.equal(ghCalls.every(call => typeof call[call.length - 1] === 'string' && call[call.length - 1].length > 0), true, 'gh 调用必须带 role');
  });
  it('起会话前按租约收树：等待中的占用者被显式停掉（不靠会抖的名单）', async () => {
    const stopped = [];
    const { activities } = harness({
      runtime: {
        leaseOf: () => ({ ok: true, lease: { sessionKey: 'session-stuck', state: 'waiting_user' } }),
        stopSession: async key => { stopped.push(key); return { ok: true }; },
        readSession: async () => text('```json\n{"plan":"P"}\n```'),
      },
    });
    await activities.lead(task, { prepared: { checkpoint: '/trees/b' }, round: 0 });
    assert.equal(stopped.includes('session-stuck'), true, '租约上的占用者必须被停掉');
  });
  it('租约读不到 → 不放行（没查成 ≠ 树是干净的）', async () => {
    const { activities } = harness({ runtime: { leaseOf: () => ({ ok: false, why: 'EACCES' }) } });
    await assert.rejects(activities.lead(task, { prepared: { checkpoint: '/trees/b' }, round: 0 }), error => error?.type === 'SERVICE_UNAVAILABLE');
  });
  it('审查树撞「未注册占位」→ 有界复位（派生物，允许拆掉重建）', async () => {
    let ensured = 0;
    const { activities, calls } = harness({
      runtime: {
        ensureWorkspace: async () => { ensured += 1; if (ensured === 1) throw new Error('unregistered worktree path already exists: /trees/stale'); return { path: '/trees/review' }; },
        readSession: async () => text('```json\n{"findings":[]}\n```'),
      },
      git: async args => (args[0] === 'worktree' ? { status: 0, out: '' } : { status: 0, out: H }),
    });
    const result = await activities.review(task, { head: H, checkpoint: '/trees/b', pr: 19 }, { checks: {} });
    assert.equal(ensured, 2, '复位后要重建一次');
    assert.equal(result.completed, true);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'git' && rest[0] === 'worktree' && rest[1] === 'remove'), true, '要拆掉残留树');
  });
  it('任务树撞占位但树上有提交 → 停手报人（不删产出）', async () => {
    const { activities, calls } = harness({
      runtime: { ensureWorkspace: async () => { throw new Error('unregistered worktree path already exists: /trees/stale'); } },
      git: async args => (args[0] === 'log' ? { status: 0, out: 'abc123 feat: x\n' } : { status: 0, out: H }),
    });
    await assert.rejects(activities.prepare(task), /workspace reset refused/);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'git' && rest[0] === 'worktree' && rest[1] === 'remove'), false, '有产出就不许拆');
  });
  it('接手时停不掉会话 → 不接手，报释放未核实', async () => {
    const { activities, calls } = harness({
      git: async (args) => (args[0] === 'rev-parse' ? { status: 0, out: H } : { status: 0, out: '' }),
      runtime: {
        waitForCompletion: async () => ({ status: 'waiting_user' }),
        readSession: async () => ({ phase: 'waiting_user', text: '' }),
        stopSession: async () => ({ ok: false, why: 'vendor alive' }),
      },
    });
    await assert.rejects(activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'b', head: B }, round: 0 }), /handoff session release unverified/);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'git' && rest[0] === 'push'), false, '树没释放就不许 push');
  });
  it('does not reap a session that is still running', async () => {
    const stopped = [];
    const fresh = createActivities({
      runtime: {
        listSessions: async () => ({ ok: true, sessions: [{ sessionKey: 's1', cwd: '/trees/b', state: 'streaming' }] }),
        stopSession: async key => { stopped.push(key); return { ok: true }; },
        startSession: async () => { throw Object.assign(new Error('boom'), { code: 'MirasimUnavailableError' }); },
        readSession: async () => ({ phase: 'running', text: '' }),
        waitForCompletion: async () => ({ status: 'unknown' }),
      },
      gh: async () => ({ ok: true, out: '{}' }),
      git: async () => ({ status: 0, out: H }),
      projects: { 'owner/repo': '/repos/repo' },
      profileOf: () => ({ agent: 'grok', family: 'xai' }),
      leadPrompt: () => 'p', executorPrompt: () => 'p', reviewerPrompt: () => 'p',
      unknownWaitMs: 1, unknownWaitRounds: 1,
    });
    await assert.rejects(fresh.lead(task, { prepared: { checkpoint: '/trees/b' }, round: 0 }), /boom/);
    assert.deepEqual(stopped, [], 'streaming 的会话不许被收树杀掉');
  });
  it('releases the tree lease when a round ends, so the next round can start', async () => {
    const { activities, calls } = harness({ runtime: { readSession: async () => text('```json\n{"plan":"Implement."}\n```') } });
    const plan = await activities.lead(task, { prepared: { checkpoint: '/trees/b' }, round: 0 });
    assert.equal(plan.plan, 'Implement.');
    assert.equal(calls.some(([kind, ...rest]) => kind === 'stopSession'), true, '一轮结束必须释放租约');
    const blocked = harness({ runtime: { readSession: async () => text('```json\n{"plan":"Implement."}\n```'), stopSession: async () => ({ ok: false }) } });
    await assert.rejects(blocked.activities.lead(task, { prepared: { checkpoint: '/trees/b' }, round: 0 }), /release unverified/);
  });
  it('reaps the tree before starting, so a retry is never blocked by a stale session', async () => {
    const { activities, calls } = harness({ runtime: { readSession: async () => text('```json\n{"plan":"Implement."}\n```') } });
    await activities.lead(task, { prepared: { checkpoint: '/trees/b' }, round: 0 });
    const startIdx = calls.findIndex(([kind]) => kind === 'startSession');
    const reapIdx = calls.findIndex(([kind]) => kind === 'listSessions');
    assert.equal(reapIdx >= 0 && reapIdx < startIdx, true, '起会话前必须先收本树（否则重试撞租约闸）');
  });
  it('a worker still asking for permission but already committed is treated as delivered', async () => {
    const { activities, calls } = harness({
      git: async (args) => (args[0] === 'rev-parse' ? { status: 0, out: H } : { status: 0, out: '' }),
      gh: async (args) => (args[1] === 'list' ? { ok: true, out: '[{"number":19,"baseRefName":"master"}]' } : { ok: true, out: '{}' }),
      runtime: { waitForCompletion: async () => ({ status: 'waiting_user' }), readSession: async () => ({ phase: 'waiting_user', text: '' }) },
    });
    const artifact = await activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'b', head: B }, round: 0 });
    assert.equal(artifact.head, H, '有提交就按交卷接手');
    assert.equal(calls.some(([k]) => k === 'stopSession'), true, '接手前要释放租约');
  });
  it('a session that does not finish is a failure, never an empty result', async () => {
    const { activities } = harness({ runtime: { waitForCompletion: async () => ({ status: 'unknown' }) } });
    await assert.rejects(activities.execute(task, { plan: { plan: 'x' }, prepared: { checkpoint: '/trees/b', branch: 'b' }, round: 0 }), /executor session unknown/);
  });
  it('verify reports unscanned when the rollup is unavailable instead of an empty passing set', async () => {
    const { activities } = harness({ gh: async () => ({ ok: true, out: '{"headRefOid":"' + H + '"}' }) });
    const evidence = await activities.verify(task, { pr: 19, checkpoint: '/trees/b' }, { waitMs: 0 });
    assert.equal(evidence.scanned, false);
    assert.deepEqual(evidence.checks, []);
  });
  it('review checks out the exact artifact head and refuses unparseable findings', async () => {
    const { activities, calls } = harness({ runtime: { readSession: async () => text('no json here') } });
    const result = await activities.review(task, { head: H, checkpoint: '/trees/b', pr: 19 }, { checks: {} });
    assert.equal(result.completed, false);
    assert.equal(result.identityVerified, false);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'git' && rest[0] === 'checkout' && rest[1] === '--detach' && rest[2] === H), true);
  });
  it('review derives families from the execution catalog, not from the contract claim', async () => {
    const { activities } = harness({ runtime: { readSession: async () => text('```json\n{"findings":[]}\n```') } });
    const result = await activities.review(task, { head: H, checkpoint: '/trees/b', pr: 19 }, { checks: {} });
    assert.equal(result.completed, true);
    assert.equal(result.identityVerified, true);
    assert.equal(result.reviewerFamily, 'anthropic');
    assert.equal(result.executorFamily, 'xai');
    const lying = harness({ runtime: { readSession: async () => text('```json\n{"findings":[]}\n```') }, deps: { profileOf: id => (FAMILIES[id] ? { agent: 'codex', family: id === 'review-profile' ? 'xai' : FAMILIES[id] } : null) } });
    const forged = await lying.activities.review(task, { head: H, checkpoint: '/trees/b', pr: 19 }, { checks: {} });
    assert.equal(forged.reviewerFamily, 'xai');
    assert.equal(forged.executorFamily, 'xai');
  });
  it('integrate verifies head and target before merging, and reads the result back', async () => {
    let views = 0;
    const { activities, calls } = harness({ gh: async (args) => {
      if (args[1] === 'view') {
        views += 1;
        return { ok: true, out: JSON.stringify(views === 1
          ? { state: 'OPEN', number: 19, headRefOid: H, baseRefName: 'master' }
          : { state: 'MERGED', number: 19, headRefOid: H, baseRefName: 'master', mergeCommit: { oid: 'c'.repeat(40) } }) };
      }
      if (args[1] === 'merge') return { ok: true, out: '' };
      return { ok: true, out: '{}' };
    } });
    const delivery = await activities.integrate(task, { pr: 19, head: H, checkpoint: '/trees/b' });
    assert.equal(delivery.merged, true);
    assert.equal(delivery.baseRefName, 'master');
    assert.equal(delivery.mergeCommit, 'c'.repeat(40));
    const mergeCallIndex = calls.findIndex(([kind, ...rest]) => kind === 'gh' && rest[1] === 'merge');
    const viewBeforeIndex = calls.findIndex(([kind, ...rest]) => kind === 'gh' && rest[1] === 'view');
    assert.equal(viewBeforeIndex < mergeCallIndex, true, '合并前必须先读回 PR 的 head 与目标枝');
  });
  it('integrate refuses when the PR head moved since review', async () => {
    const { activities, calls } = harness({ gh: async (args) => (args[1] === 'view' ? { ok: true, out: JSON.stringify({ state: 'OPEN', headRefOid: B, baseRefName: 'master' }) } : { ok: true, out: '{}' }) });
    await assert.rejects(activities.integrate(task, { pr: 19, head: H, checkpoint: '/trees/b' }), /head moved/);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'gh' && rest[1] === 'merge'), false);
  });
  it('integrate refuses when the PR targets another branch', async () => {
    const { activities, calls } = harness({ gh: async (args) => (args[1] === 'view' ? { ok: true, out: JSON.stringify({ state: 'OPEN', headRefOid: H, baseRefName: 'develop' }) } : { ok: true, out: '{}' }) });
    await assert.rejects(activities.integrate(task, { pr: 19, head: H, checkpoint: '/trees/b' }), /target branch mismatch/);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'gh' && rest[1] === 'merge'), false);
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

describe('T37 ④ pre-flight：子仓不符合约定脊柱就拒派', () => {
  const CHILD = 'thoerwink8/ai-gateway-stack';
  const childTask = { ...task, repository: CHILD };
  const deps = { projects: { 'owner/repo': '/repos/repo', [CHILD]: '/repos/ags' } };
  const OK_DOC = '# 子仓\n\n<!-- dao-conventions: v1 sha256:abcdef12 -->\n';
  const OK_PIN = JSON.stringify({ version: 1, sha256: 'abcdef12' });
  const ghMap = (map) => async (args) => {
    const path = args[args.length - 1];
    if (!(path in map)) return { ok: false, error: 'gh: Not Found (HTTP 404)' };
    return { ok: true, out: map[path] };
  };

  it('子仓接好了 → 正常起树', async () => {
    const { activities } = harness({
      deps,
      gh: ghMap({
        [`repos/${CHILD}/contents/AGENTS.md`]: OK_DOC,
        [`repos/${CHILD}/contents/.dao/conventions.json`]: OK_PIN,
      }),
    });
    const prepared = await activities.prepare(childTask);
    assert.equal(prepared.repository, CHILD);
  });

  it('子仓没接（两个 doc 都 404）→ 拒派，且不 fetch、不起树', async () => {
    const { activities, calls } = harness({ deps, gh: ghMap({}) });
    await assert.rejects(activities.prepare(childTask), /子仓不符合约定脊柱/);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'git' && rest[0] === 'fetch'), false);
  });

  it('子仓的块被改旧（戳与 pin 不符）→ 拒派', async () => {
    const { activities } = harness({
      deps,
      gh: ghMap({
        [`repos/${CHILD}/contents/AGENTS.md`]: '# 子仓\n\n<!-- dao-conventions: v1 sha256:00000000 -->\n',
        [`repos/${CHILD}/contents/.dao/conventions.json`]: OK_PIN,
      }),
    });
    await assert.rejects(activities.prepare(childTask), /stale-stamp/);
  });

  it('没声明的仓 → 本项不适用，一个 api 调用都不发', async () => {
    const { activities, calls } = harness({ deps });
    await activities.prepare(task);
    assert.equal(calls.some(([kind, ...rest]) => kind === 'gh' && rest[0] === 'api'), false);
  });
});
