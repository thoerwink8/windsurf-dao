const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mod = import('../scripts/acp-session-runner.mjs');

test('file permission scope verifies every path and follows symlinks before approval', async t => {
  const { acpPermissionScope } = await mod;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'managed'); fs.mkdirSync(cwd);
  const allowed = path.join(cwd, 'proof.txt'); fs.writeFileSync(allowed, 'proof');
  const outside = path.join(dir, 'outside'); fs.mkdirSync(outside);
  if (process.platform !== 'win32') fs.symlinkSync(outside, path.join(cwd, 'escape'));
  const rule = { toolKinds: ['read'], workdir: cwd, paths: [allowed] };
  const request = rawInput => ({ toolCall: { kind: 'read', rawInput } });
  assert.deepEqual(acpPermissionScope(rule, request({ path: 'proof.txt' }), { cwd }).paths, [allowed]);
  assert.equal(acpPermissionScope(rule, request({ path: '../outside/secret' }), { cwd }), null);
  assert.equal(acpPermissionScope(rule, { toolCall: { kind: 'read', rawInput: { path: allowed }, locations: [{ path: path.join(outside, 'secret') }] } }, { cwd }), null);
  assert.equal(acpPermissionScope(rule, request({}), { cwd }), null);
  assert.equal(acpPermissionScope(rule, request({ path: allowed, cwd: outside }), { cwd }), null);
  assert.equal(acpPermissionScope({ ...rule, toolKinds: ['edit'] }, request({ path: allowed }), { cwd }), null);
  if (process.platform !== 'win32') {
    const newFile = path.join(cwd, 'escape', 'new.txt');
    assert.equal(acpPermissionScope({ ...rule, paths: [path.join(cwd, 'new.txt')] }, request({ path: newFile }), { cwd }), null);
  }
});

test('command prefixes require exact argv words and a verified execution cwd', async t => {
  const { acpPermissionScope } = await mod;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-command-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const rule = { toolKinds: ['execute'], workdir: cwd, commandPrefixes: [['node', '--test'], ['git', 'status']] };
  const request = command => ({ toolCall: { kind: 'execute', rawInput: { command, cwd } } });
  assert.deepEqual(acpPermissionScope(rule, request('node --test "test file.js"'), { cwd }).command, ['node', '--test', 'test file.js']);
  assert.ok(acpPermissionScope(rule, request(['git', 'status', '--short']), { cwd }));
  for (const command of ['node --test; echo unsafe', 'node --test | cat', 'node --test > proof', 'node --test $(echo x)', 'node --test `echo x`', 'node --test\necho unsafe', 'node --testing', 'node --test "unterminated', 'node --test"joined"']) {
    assert.equal(acpPermissionScope(rule, request(command), { cwd }), null, command);
  }
  assert.equal(acpPermissionScope(rule, { toolCall: { kind: 'execute', rawInput: { command: 'node --test' } } }, { cwd }), null);
  assert.equal(acpPermissionScope({ ...rule, workdir: '.' }, request('node --test'), { cwd }), null);
  assert.equal(acpPermissionScope({ ...rule, commandPrefixes: ['node --test'] }, request('node --test'), { cwd }), null);
});

test('injected question-tool permission is exact, one-shot, and disabled with the MCP server', async () => {
  const { injectedQuestionPermission } = await mod;
  const config = { interactionMcp: true, agent: 'cursor' };
  const params = { toolCall: { kind: 'other', title: 'dao-interactions-dao_ask_user_question: dao_ask_user_question' },
    options: [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }] };
  assert.equal(injectedQuestionPermission(config, 'session/request_permission', params).answer.outcome.optionId, 'once');
  assert.equal(injectedQuestionPermission({ ...config, interactionMcp: false }, 'session/request_permission', params), null);
  assert.equal(injectedQuestionPermission(config, 'session/request_permission', { ...params, toolCall: { ...params.toolCall, title: 'foreign-server: dao_ask_user_question' } }), null);
  assert.equal(injectedQuestionPermission(config, 'session/request_permission', { ...params, options: [{ optionId: 'always', kind: 'allow_always' }] }), null);
});
