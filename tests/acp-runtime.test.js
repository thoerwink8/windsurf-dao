const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures/acp/fake-agent.mjs');
const mod = import('../scripts/lib/acp-runtime.mjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) { value = await fn(); if (check(value)) return value; await delay(20); }
  assert.fail(`Condition not met: ${JSON.stringify(value)}`);
}
async function setup(t, scenario = 'complete', overrides = {}) {
  const { createAcpRuntime } = await mod;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-test-'));
  const workdir = path.join(dir, 'workspace');
  fs.mkdirSync(workdir);
  const options = { homeDir: dir, stateDir: path.join(dir, 'state'), pollMs: 15, startupTimeoutMs: 15000,
    handshakeTimeoutMs: 5000, killGraceMs: 60, controlTimeoutMs: 6000,
    acpProfiles: Object.fromEntries(['cursor', 'devin', 'grok'].map(agent => [agent, { command: process.execPath, args: [fixture, scenario] }])), ...overrides };
  const runtime = createAcpRuntime(options);
  t.after(async () => {
    const list = await runtime.listSessions();
    for (const session of list.sessions || []) await runtime.stopSession(session.key);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const start = extra => runtime.startSession({ agent: 'cursor', workdir, prompt: 'Fixture task', ...extra });
  const disk = key => path.join(options.stateDir, 'sessions', key.slice(4));
  return { runtime, dir, workdir, options, start, disk };
}

test('ACP durable runtime (isolated fake executables only)', { skip: process.platform !== 'linux' }, async t => {
  await t.test('completes a prompt, preserves usage/context, and never marks the GitHub task complete', async t => {
    const { runtime, start, disk } = await setup(t, 'complete', { env: { ACP_FIXTURE_SECRET: 'test-secret-never-publish' }, profiles: [{ id: 'native-cursor', agent: 'cursor', model: 'catalog-only' }] });
    const allocated = `acp:${randomUUID()}`;
    const created = await start({ sessionKey: allocated, model: 'test-model-b[effort=high]', effort: 'high', taskId: 'task-one', profileId: 'native-cursor', provider: 'cursor-native', accountPoolId: 'pool-one', issue: 123, pr: 456 });
    assert.equal(created.sessionKey, allocated);
    assert.match(created.sessionKey, /^acp:[0-9a-f-]{36}$/);
    assert.equal(created.taskId, 'task-one');
    const view = await until(() => runtime.readSession(created.sessionKey), view => view.phase === 'done');
    assert.equal(view.via, 'acp');
    assert.equal(view.text, 'finished:complete');
    assert.equal(view.snapshot.taskCompleted, false);
    assert.equal(view.snapshot.model, 'test-model-b[effort=high]');
    assert.equal(view.snapshot.cleanup.verified, true);
    assert.ok(view.snapshot.runner.pid > 1);
    assert.match(view.snapshot.runner.startTicks, /^\d+$/);
    const context = JSON.parse(fs.readFileSync(path.join(disk(created.sessionKey), 'context.json')));
    assert.equal(context.accountPoolId, 'pool-one');
    assert.equal(context.issue, 123);
    const usage = fs.readFileSync(path.join(disk(created.sessionKey), 'usage.ndjson'), 'utf8');
    assert.doesNotMatch(usage, /test-secret-never-publish|opaque-secret|opaque-access|private-account/);
    assert.equal(JSON.parse(usage.split('\n')[0]).raw.params.update.usage.inputTokens, 12);
    assert.equal(fs.statSync(path.join(disk(created.sessionKey), 'status.json')).mode & 0o777, 0o600);
    assert.equal((await runtime.listSessions()).sessions[0].agent, 'cursor');
  });

  await t.test('survives the initiating dao process exiting', async t => {
    const { runtime, options, workdir } = await setup(t, 'delayed');
    const code = `import {createAcpRuntime} from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/lib/acp-runtime.mjs')).href)};const rt=createAcpRuntime(${JSON.stringify(options)});console.log(JSON.stringify(await rt.startSession(${JSON.stringify({ agent: 'cursor', workdir, prompt: 'detached' })})));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 18000 });
    assert.equal(child.status, 0, child.stderr);
    const created = JSON.parse(child.stdout);
    const view = await until(() => runtime.readSession(created.sessionKey), view => view.phase === 'done');
    assert.equal(view.text, 'finished:complete');
  });

  await t.test('concurrent admission reserves one canonical workdir and releases after cancel', async t => {
    const { runtime, start, workdir, dir } = await setup(t, 'hold');
    const alias = path.join(dir, 'alias'); fs.symlinkSync(workdir, alias);
    const results = await Promise.allSettled([start(), start({ workdir: alias }), start()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'workdir_locked');
    const key = results.find(result => result.status === 'fulfilled').value.sessionKey;
    assert.equal((await runtime.stopSession(key)).verified, true);
    const next = await start();
    assert.notEqual(next.sessionKey, key);
  });

  await t.test('a persisted native question waits, rejects invalid answers, and accepts exactly one concurrent answer', async t => {
    const { runtime, start, options } = await setup(t, 'question');
    const { sessionKey } = await start();
    const view = await until(() => runtime.readSession(sessionKey), view => view.phase === 'waiting_user');
    const { promptId, questions } = view.interactions[0];
    assert.equal(questions[0].id, 'choice');
    assert.equal(view.interactions[0].source, 'native');
    const again = (await mod).createAcpRuntime(options);
    const invalid = await again.interact(sessionKey, { promptId, answers: [{ questionId: 'choice', selectedOptionIds: ['unknown'] }] });
    assert.equal(invalid.error, 'invalid_answer');
    assert.equal((await runtime.readSession(sessionKey)).phase, 'waiting_user');
    const answer = choice => ({ promptId, answers: [{ questionId: 'choice', selectedOptionIds: [choice] }] });
    const replies = await Promise.all([runtime.interact(sessionKey, answer('alpha')), again.interact(sessionKey, answer('beta'))]);
    assert.equal(replies.filter(reply => reply.ok).length, 1);
    assert.equal(replies.filter(reply => reply.error === 'already_answered').length, 1);
    const ended = await until(() => runtime.readSession(sessionKey), view => view.phase === 'done');
    assert.equal(ended.interactions[0].answered, true);
  });

  await t.test('the MCP tool really blocks and resumes through the same durable answer inbox', async t => {
    const { runtime, start, workdir } = await setup(t, 'mcp');
    const { sessionKey } = await start();
    const view = await until(() => runtime.readSession(sessionKey), view => view.phase === 'waiting_user');
    assert.equal(view.interactions[0].source, 'mcp');
    assert.equal(view.interactions[0].method, 'mcp/dao_ask_user_question');
    assert.equal(fs.existsSync(path.join(workdir, 'after-answer.txt')), false);
    const response = await runtime.interact(sessionKey, { promptId: view.interactions[0].promptId, answers: [{ questionId: 'choice', selectedOptionIds: ['beta'] }] });
    assert.equal(response.ok, true);
    const ended = await until(() => runtime.readSession(sessionKey), view => view.phase === 'done');
    assert.equal(fs.readFileSync(path.join(workdir, 'after-answer.txt'), 'utf8'), 'beta');
    assert.equal(ended.toolCalls[0].status, 'completed');
  });

  for (const [scenario, method, answer] of [
    ['permission', 'session/request_permission', { optionId: 'no' }],
    ['plan', 'cursor/create_plan', { outcome: 'accepted' }],
    ['mcp', 'mcp/dao_ask_user_question', { answers: [{ questionId: 'choice', selectedOptionIds: ['alpha'] }] }],
  ]) await t.test(`${scenario} uses only an explicit deterministic policy answer`, async t => {
    const { runtime, start } = await setup(t, scenario);
    const { sessionKey } = await start({ interactionPolicy: { rules: [{ method, answer }] } });
    const view = await until(() => runtime.readSession(sessionKey), view => view.phase === 'done');
    assert.equal(view.interactions[0].answerSource, 'interactionPolicy');
    assert.equal(view.interactions[0].answered, true);
    if (scenario === 'permission') assert.equal(view.interactions[0].answer.outcome.optionId, 'no');
    if (scenario === 'mcp') assert.equal(view.interactions[0].source, 'mcp');
  });

  await t.test('missing or ambiguous policies never choose an option, and cancel resolves the wait', async t => {
    const { runtime, start } = await setup(t, 'permission');
    const rule = { method: 'session/request_permission', answer: { optionId: 'yes' } };
    const { sessionKey } = await start({ interactionPolicy: { rules: [rule, rule] } });
    const waiting = await until(() => runtime.readSession(sessionKey), view => view.phase === 'waiting_user');
    assert.equal(waiting.interactions[0].answer, undefined);
    assert.equal((await runtime.stopSession(sessionKey)).verified, true);
    const ended = await runtime.readSession(sessionKey);
    assert.equal(ended.phase, 'cancelled');
    assert.equal(ended.interactions[0].status, 'cancelled');
  });

  await t.test('unknown blocking Devin extensions are classified and receive a method error', async t => {
    const { runtime, start, workdir } = await setup(t, 'unknown');
    const { sessionKey } = await start({ agent: 'devin' });
    const view = await until(() => runtime.readSession(sessionKey), view => view.phase === 'unsupported_interaction');
    assert.equal(view.error.code, 'unsupported_interaction');
    assert.equal(view.error.classification, 'unsupported_devin_extension');
    assert.equal(view.interactions[0].status, 'unsupported');
    assert.match(fs.readFileSync(path.join(workdir, 'fake-events.ndjson'), 'utf8'), /"rejectedCode":-32601/);
    assert.equal(view.snapshot.cleanup.verified, true);
  });

  await t.test('cancel reaps a TERM-resistant child and an escaped grandchild', async t => {
    const { runtime, start, workdir } = await setup(t, 'subtree');
    const { acpProcessIdentity, acpProcessAlive } = await mod;
    const { sessionKey } = await start();
    const pids = await until(() => {
      try { return JSON.parse(fs.readFileSync(path.join(workdir, 'subtree.json'))); } catch { return null; }
    }, Boolean);
    const identities = Object.values(pids).map(acpProcessIdentity);
    await until(() => runtime.readSession(sessionKey), view => identities.every(identity => view.snapshot.descendants.some(row => row.pid === identity.pid)));
    const stopped = await runtime.stopSession(sessionKey);
    assert.equal(stopped.verified, true);
    assert.ok(identities.every(identity => !acpProcessAlive(identity)));
    assert.equal((await runtime.readSession(sessionKey)).phase, 'cancelled');
  });

  await t.test('dead runner recovery does not steal its lease before verified reconciliation', async t => {
    const { runtime, start } = await setup(t, 'hold');
    const { sessionKey } = await start();
    const view = await runtime.readSession(sessionKey);
    process.kill(view.snapshot.runner.pid, 'SIGKILL');
    await until(() => runtime.readSession(sessionKey), view => view.phase === 'interrupted');
    await assert.rejects(start(), error => error.code === 'workdir_locked');
    assert.equal((await runtime.stopSession(sessionKey)).verified, true);
    await start();
  });

  await t.test('PID reuse or a changed boot identity never signals an unrelated process', async t => {
    const { runtime, start, disk } = await setup(t, 'complete');
    const { acpAtomicJson, acpProcessIdentity, acpProcessAlive } = await mod;
    const { sessionKey } = await start();
    const ended = await until(() => runtime.readSession(sessionKey), view => view.phase === 'done');
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await new Promise(resolve => sentinel.once('spawn', resolve));
    t.after(() => sentinel.kill('SIGKILL'));
    const real = acpProcessIdentity(sentinel.pid);
    const falseIdentity = { ...real, startTicks: String(BigInt(real.startTicks) + 1n) };
    acpAtomicJson(path.join(disk(sessionKey), 'status.json'), { ...ended.snapshot, phase: 'running', cleanup: null,
      runner: falseIdentity, agentProcess: { ...real, bootId: 'another-boot' }, descendants: [falseIdentity] });
    assert.equal((await runtime.stopSession(sessionKey)).verified, true);
    assert.equal(acpProcessAlive(real), true);
  });

  for (const [scenario, code] of [['alias', 'model_unverified'], ['mismatch', 'model_mismatch'], ['legacy-model', 'model_mismatch'], ['auth', 'auth_required']]) {
    await t.test(`${scenario} fails startup before any prompt is sent`, async t => {
      const { runtime, start, workdir } = await setup(t, scenario);
      const allocated = `acp:${randomUUID()}`;
      await assert.rejects(start({ sessionKey: allocated, ...(scenario === 'mismatch' || scenario === 'legacy-model' ? { model: 'test-model-b[effort=high]' } : {}) }), error => {
        assert.equal(error.code, code);
        assert.deepEqual(error.detail, { sessionKey: allocated, launchUncertain: false });
        return true;
      });
      const failed = await runtime.readSession(allocated);
      assert.equal(failed.snapshot.cleanup.verified, true);
      assert.equal((await mod).acpProcessAlive(failed.snapshot.runner), false);
      assert.doesNotMatch(fs.readFileSync(path.join(workdir, 'fake-events.ndjson'), 'utf8'), /"method":"session\/prompt"/);
    });
  }

  await t.test('runtime model changes and incomplete prompt stops are never done', async t => {
    const { runtime, start } = await setup(t, 'switch');
    const { sessionKey } = await start();
    const ended = await until(() => runtime.readSession(sessionKey), view => view.phase === 'error');
    assert.equal(ended.error.code, 'model_mismatch');
    const other = await setup(t, 'incomplete');
    const next = await other.start();
    const incomplete = await until(() => other.runtime.readSession(next.sessionKey), view => view.phase === 'error');
    assert.equal(incomplete.error.code, 'prompt_incomplete');
  });

  await t.test('rejects untrusted defaults, pool aliases, cloud routes and callback policies before spawn', async t => {
    const { runtime, start, workdir } = await setup(t);
    await assert.rejects(start({ workdir: '.' }), error => error.code === 'managed_workdir_required');
    await assert.rejects(start({ model: 'auto' }), error => error.code === 'invalid_model');
    await assert.rejects(start({ route: 'cloud' }), error => error.code === 'unsupported_route');
    await assert.rejects(start({ interactionPolicy: () => true }), error => error.code === 'invalid_config');
    assert.equal(fs.existsSync(path.join(workdir, 'fake-events.ndjson')), false);
    assert.equal((await runtime.listSessions()).sessions.length, 0);
  });

  await t.test('the model catalog cannot shadow default native binary discovery', async t => {
    const { dir, workdir, options } = await setup(t);
    const binary = path.join(dir, '.local/share/cursor-agent/versions/2099.01.01-fixture/cursor-agent');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(fixture).href)});\n`, { mode: 0o700 });
    const runtime = (await mod).createAcpRuntime({ ...options, acpProfiles: undefined,
      env: { PATH: '' }, profiles: [{ id: 'cursor-native', agent: 'cursor', command: '/must-not-be-used' }] });
    const { sessionKey } = await runtime.startSession({ agent: 'cursor', workdir, prompt: 'native discovery fixture' });
    const view = await until(() => runtime.readSession(sessionKey), view => view.phase === 'done');
    assert.equal(view.text, 'finished:complete');
    const request = JSON.parse(fs.readFileSync(path.join(options.stateDir, 'sessions', sessionKey.slice(4), 'request.json')));
    assert.equal(request.profile.command, binary);
    assert.deepEqual(request.profile.args, ['--trust', 'acp']);
  });

  await t.test('independent dao processes cannot both acquire the same workdir', async t => {
    const { options, workdir } = await setup(t, 'hold');
    const code = `import {createAcpRuntime} from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/lib/acp-runtime.mjs')).href)};try {const rt=createAcpRuntime(${JSON.stringify(options)});console.log(JSON.stringify({ok:true,...await rt.startSession(${JSON.stringify({ agent: 'cursor', workdir, prompt: 'race' })})}));}catch(error){console.log(JSON.stringify({ok:false,code:error.code}));}`;
    const launch = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('exit', () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
    });
    const results = await Promise.all([launch(), launch(), launch()]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => result.code === 'workdir_locked').length, 2);
  });

  await t.test('allow permission policy requires an exact scope, while scoped read resumes', async t => {
    const denied = await setup(t, 'permission');
    const rule = { method: 'session/request_permission', answer: { optionId: 'yes' } };
    const pending = await denied.start({ interactionPolicy: { rules: [rule] } });
    const waiting = await until(() => denied.runtime.readSession(pending.sessionKey), view => view.phase === 'waiting_user');
    assert.equal(waiting.interactions[0].answer, undefined);
    await denied.runtime.stopSession(pending.sessionKey);
    const allowed = await setup(t, 'permission');
    const created = await allowed.start({ interactionPolicy: { rules: [{ ...rule, toolKinds: ['read'], workdir: allowed.workdir, paths: ['proof.txt'] }] } });
    const done = await until(() => allowed.runtime.readSession(created.sessionKey), view => view.phase === 'done');
    assert.equal(done.interactions[0].answer.outcome.optionId, 'yes');
    assert.deepEqual(done.interactions[0].policyScope.paths, [path.join(allowed.workdir, 'proof.txt')]);
  });

  await t.test('bootstrap loss and a dead cleanup owner can both be reconciled', async t => {
    const { runtime, start, disk } = await setup(t, 'complete');
    const { acpAtomicJson, acpProcessIdentity, acpProcessAlive } = await mod;
    const { sessionKey } = await start();
    const done = await until(() => runtime.readSession(sessionKey), view => view.phase === 'done');
    await until(() => acpProcessAlive(done.snapshot.runner), alive => !alive);
    const status = { ...done.snapshot, phase: 'starting', runner: null, cleanup: null, creator: acpProcessIdentity(process.pid) };
    acpAtomicJson(path.join(disk(sessionKey), 'status.json'), status);
    // No wall-clock guess: first prove the prior writer exited, then exercise both
    // bootstrap states immediately using a definitively mismatched start identity.
    fs.unlinkSync(path.join(disk(sessionKey), 'launch.json'));
    assert.equal((await runtime.readSession(sessionKey)).phase, 'starting');
    const self = acpProcessIdentity(process.pid);
    const dead = { ...self, startTicks: String(BigInt(self.startTicks) + 1n) };
    acpAtomicJson(path.join(disk(sessionKey), 'launch.json'), { runner: dead });
    const guard = path.join(disk(sessionKey), 'cleanup.guard'); fs.mkdirSync(guard);
    acpAtomicJson(path.join(guard, 'dead-beef.json'), { creator: dead });
    assert.equal((await runtime.readSession(sessionKey)).phase, 'interrupted');
    assert.equal((await runtime.stopSession(sessionKey)).verified, true);
  });

  await t.test('injected MCP permission plus the predetermined answer finish without user input', async t => {
    const { runtime, start, workdir } = await setup(t, 'mcp-permission');
    const interactionPolicy = { rules: [{ method: 'mcp/dao_ask_user_question', questionIds: ['choice'], answer: { answers: [{ questionId: 'choice', selectedOptionIds: ['alpha'] }] } }] };
    const { sessionKey } = await start({ interactionPolicy });
    const done = await until(() => runtime.readSession(sessionKey), view => view.phase === 'done');
    assert.equal(fs.readFileSync(path.join(workdir, 'after-answer.txt'), 'utf8'), 'alpha');
    assert.equal(done.interactions.length, 2);
    assert.equal(done.interactions[0].answerSource, 'injected_question_tool');
    assert.equal(done.interactions[0].answer.outcome.optionId, 'allow-once');
    assert.equal(done.interactions[1].source, 'mcp');
    assert.ok(done.interactions.every(interaction => interaction.status === 'answered'));
    const foreign = await setup(t, 'foreign-mcp');
    const other = await foreign.start({ interactionPolicy });
    const waiting = await until(() => foreign.runtime.readSession(other.sessionKey), view => view.phase === 'waiting_user');
    assert.equal(waiting.interactions[0].answer, undefined);
    assert.equal(fs.existsSync(path.join(foreign.workdir, 'after-answer.txt')), false);
  });

  await t.test('cross-process resume loads the persisted backend after verified cancellation without replaying the initial prompt', async t => {
    const { runtime, start, options, workdir, disk, dir } = await setup(t, 'resume', { env: { ACP_RESUME_MARKER: 'original-environment' } });
    const original = await start({ prompt: 'initial-only', model: 'test-model-b[effort=high]', taskId: 'same-task', profileId: 'same-profile', provider: 'same-provider', accountPoolId: 'same-pool', issue: 31, pr: 32 });
    await until(() => JSON.parse(fs.readFileSync(path.join(workdir, 'fake-backend-session.json'))), history => history.prompts.length === 1);
    await assert.rejects(runtime.resumeSession(original.sessionKey, 'too-early'), error => error.code === 'session_active');
    assert.equal((await runtime.stopSession(original.sessionKey)).verified, true);
    const changed = { ...options, homeDir: path.join(dir, 'different-home'), env: { ACP_RESUME_MARKER: 'must-not-replace-account' },
      acpProfiles: { cursor: { command: '/must-not-replace-profile', args: [] } } };
    const allocated = `acp:${randomUUID()}`;
    const code = `import {createAcpRuntime} from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/lib/acp-runtime.mjs')).href)};console.log(JSON.stringify(await createAcpRuntime(${JSON.stringify(changed)}).resumeSession(${JSON.stringify(original.sessionKey)},'continue-only',${JSON.stringify({ sessionKey: allocated })})));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, 0, child.stderr);
    const resumed = JSON.parse(child.stdout);
    assert.equal(resumed.sessionKey, allocated);
    assert.notEqual(resumed.sessionKey, original.sessionKey);
    assert.equal(resumed.taskId, original.taskId);
    assert.equal(resumed.resumeFrom, original.sessionKey);
    const done = await until(() => runtime.readSession(resumed.sessionKey), view => view.phase === 'done');
    assert.equal(done.snapshot.model, 'test-model-b[effort=high]');
    assert.equal(done.snapshot.accountPoolId, 'same-pool');
    assert.equal(done.snapshot.provider, 'same-provider');
    assert.equal(done.snapshot.profileId, 'same-profile');
    assert.equal(done.snapshot.issue, 31);
    assert.equal(done.snapshot.pr, 32);
    assert.equal(done.snapshot.backendSessionId, 'fixture-session');
    assert.equal(done.text, 'resumed:initial-only|continue-only');
    assert.equal(done.snapshot.replayedUpdates, 2);
    const frames = fs.readFileSync(path.join(workdir, 'fake-events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(frames.filter(frame => frame.method === 'session/new').length, 1);
    assert.equal(frames.filter(frame => frame.method === 'session/load').length, 1);
    assert.deepEqual(frames.filter(frame => frame.method === 'session/prompt').map(frame => frame.params.prompt[0].text), ['initial-only', 'continue-only']);
    assert.equal(frames.find(frame => frame.restoredEnvironment).restoredEnvironment, 'original-environment');
    assert.equal(frames.find(frame => frame.restoredHome).restoredHome, dir);
    const config = JSON.parse(fs.readFileSync(path.join(disk(resumed.sessionKey), 'request.json')));
    assert.equal(config.prompt, 'continue-only');
    assert.equal(config.resumeFrom, original.sessionKey);
    const usage = fs.readFileSync(path.join(disk(resumed.sessionKey), 'usage.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(usage[0].replayed, true);
  });

  await t.test('resume reconciles an interrupted source before starting the next attempt', async t => {
    const { runtime, start, workdir } = await setup(t, 'resume');
    const { acpProcessAlive } = await mod;
    const original = await start({ prompt: 'before-crash' });
    await until(() => JSON.parse(fs.readFileSync(path.join(workdir, 'fake-backend-session.json'))), history => history.prompts.length === 1);
    const before = await runtime.readSession(original.sessionKey);
    process.kill(before.snapshot.runner.pid, 'SIGKILL');
    await until(() => runtime.readSession(original.sessionKey), view => view.phase === 'interrupted');
    const resumed = await runtime.resumeSession(original.sessionKey, 'after-crash');
    const done = await until(() => runtime.readSession(resumed.sessionKey), view => view.phase === 'done');
    assert.equal(done.text, 'resumed:before-crash|after-crash');
    assert.equal(acpProcessAlive(before.snapshot.runner), false);
    assert.equal((await runtime.readSession(original.sessionKey)).snapshot.cleanup.verified, true);
  });

  await t.test('resume refuses unadvertised load and rechecks capabilities in the new ACP process', async t => {
    const absent = await setup(t, 'no-load');
    const first = await absent.start();
    await until(() => absent.runtime.readSession(first.sessionKey), view => view.phase === 'done');
    await assert.rejects(absent.runtime.resumeSession(first.sessionKey, 'continue'), error => error.code === 'resume_unsupported');
    assert.equal((await absent.runtime.listSessions()).sessions.length, 1);
    const changed = await setup(t, 'complete');
    const second = await changed.start();
    await until(() => changed.runtime.readSession(second.sessionKey), view => view.phase === 'done');
    fs.writeFileSync(path.join(changed.workdir, 'disable-load'), 'fixture capability change');
    await assert.rejects(changed.runtime.resumeSession(second.sessionKey, 'must-not-run'), error => error.code === 'resume_unsupported');
    const frames = fs.readFileSync(path.join(changed.workdir, 'fake-events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(frames.filter(frame => frame.method === 'initialize').length, 2);
    assert.equal(frames.filter(frame => frame.method === 'session/new').length, 1);
    assert.equal(frames.filter(frame => frame.method === 'session/load').length, 0);
    assert.equal(frames.filter(frame => frame.method === 'session/prompt').length, 1);
  });

  await t.test('preallocated keys validate strictly and cannot replace an existing session directory', async t => {
    const { runtime, start, disk, workdir, dir } = await setup(t, 'hold');
    for (const key of ['', null, `grok:${randomUUID()}`, 'acp:../../escape']) {
      await assert.rejects(start({ sessionKey: key }), error => error.code === 'invalid_session_key' && error.detail.launchUncertain === false);
    }
    assert.equal((await runtime.listSessions()).sessions.length, 0);
    const allocated = `acp:${randomUUID()}`;
    await start({ sessionKey: allocated });
    const contextFile = path.join(disk(allocated), 'context.json');
    const original = fs.readFileSync(contextFile, 'utf8');
    const other = path.join(dir, 'other-workspace'); fs.mkdirSync(other);
    await assert.rejects(start({ sessionKey: allocated, workdir: other, prompt: 'must-not-overwrite' }), error =>
      error.code === 'session_exists' && error.detail.sessionKey === allocated && error.detail.launchUncertain === true);
    await assert.rejects(runtime.resumeSession(allocated, 'must-not-reuse-source-key', { sessionKey: allocated }), error =>
      error.code === 'session_exists' && error.detail.sessionKey === allocated && error.detail.launchUncertain === true);
    assert.equal(fs.readFileSync(contextFile, 'utf8'), original);
    assert.equal((await runtime.readSession(allocated)).snapshot.cwd, workdir);
    assert.equal(fs.existsSync(path.join(other, 'fake-events.ndjson')), false);
    await assert.rejects(start(), error => error.code === 'workdir_locked' && error.detail.ownerSessionKey === allocated && error.detail.launchUncertain === false);
  });

  await t.test('a caller lost before the start acknowledgement can reconcile its preallocated key without another launch', async t => {
    const { runtime, start, options, workdir } = await setup(t, 'slow-initialize');
    const allocated = `acp:${randomUUID()}`;
    const ack = path.join(workdir, 'caller-ack.txt');
    const code = `import fs from 'node:fs';import {createAcpRuntime} from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/lib/acp-runtime.mjs')).href)};await createAcpRuntime(${JSON.stringify(options)}).startSession(${JSON.stringify({ sessionKey: allocated, agent: 'cursor', workdir, prompt: 'lost acknowledgement' })});fs.writeFileSync(${JSON.stringify(ack)},'ack');`;
    const caller = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
    t.after(() => caller.kill('SIGKILL'));
    await until(() => runtime.readSession(allocated), view => view.snapshot?.runnerAlive && !view.snapshot.acceptedAt);
    const exited = new Promise(resolve => caller.once('exit', resolve));
    caller.kill('SIGKILL'); await exited;
    assert.equal(fs.existsSync(ack), false);
    await assert.rejects(start({ sessionKey: allocated }), error => error.code === 'session_exists' && error.detail.launchUncertain === true);
    const running = await until(() => runtime.readSession(allocated), view => view.phase === 'running');
    assert.equal(running.snapshot.sessionKey, allocated);
    const frames = fs.readFileSync(path.join(workdir, 'fake-events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(frames.filter(frame => frame.method === 'session/new').length, 1);
  });

  await t.test('a startup observation failure exposes the key as uncertain until evidence is readable again', async t => {
    const { runtime, start, disk } = await setup(t, 'hold');
    const allocated = `acp:${randomUUID()}`;
    const statusFile = path.join(disk(allocated), 'status.json');
    const originalRead = fs.readFileSync.bind(fs);
    const injected = t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === statusFile) throw Object.assign(new Error('Injected status read failure'), { code: 'EIO' });
      return originalRead(file, ...args);
    });
    try {
      await assert.rejects(start({ sessionKey: allocated }), error => error.code === 'EIO' && error.detail.sessionKey === allocated && error.detail.launchUncertain === true);
    } finally { injected.mock.restore(); }
    await until(() => runtime.readSession(allocated), view => view.phase === 'running');
    assert.equal((await runtime.stopSession(allocated)).verified, true);
  });
});
