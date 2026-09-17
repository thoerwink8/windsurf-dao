const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const POLICY = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'acp-interaction-policy.mjs').replace(/\\/g, '/'));
const RUNNER = import('file://' + path.join(__dirname, '..', 'scripts', 'acp-session-runner.mjs').replace(/\\/g, '/'));

test('default policy is worktree grant-once; unknown MCP questions are not guessed', async () => {
  const { defaultWorktreeInteractionPolicy, WORKTREE_EXECUTE_PREFIXES, WORKTREE_TOOL_KINDS } = await POLICY;
  const workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dao-t8b-pol-')));
  try {
    const pol = defaultWorktreeInteractionPolicy(workdir);
    assert.equal(pol.rules.length, 1);
    const rule = pol.rules[0];
    assert.equal(rule.method, 'session/request_permission');
    assert.equal(rule.worktreeScope, true);
    assert.equal(rule.workdir, workdir);
    assert.equal(rule.answer.grant, 'once');
    assert.deepEqual(rule.toolKinds, [...WORKTREE_TOOL_KINDS]);
    assert.deepEqual(rule.commandPrefixes, WORKTREE_EXECUTE_PREFIXES.map((p) => [...p]));
    assert.equal(rule.commandPrefixes.some((p) => p[0] === 'rm'), false);
    assert.equal(rule.commandPrefixes.some((p) => p[1] === 'push'), false);
    assert.equal(pol.rules.some((r) => r.method === 'mcp/dao_ask_user_question'), false,
      '默认策略不许替人答选择题');
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('resolveStartInteractionPolicy: ACP 缺省用默认，显式（含空规则）不合并', async () => {
  const { resolveStartInteractionPolicy, defaultWorktreeInteractionPolicy } = await POLICY;
  const workdir = '/tmp/dao-t8b-abs';
  assert.deepEqual(
    resolveStartInteractionPolicy({ backend: 'acp', workdir }),
    defaultWorktreeInteractionPolicy(workdir),
  );
  const custom = { rules: [{ method: 'mcp/dao_ask_user_question', answer: { answers: [] } }] };
  assert.equal(resolveStartInteractionPolicy({ backend: 'acp', workdir, interactionPolicy: custom }), custom);
  assert.deepEqual(resolveStartInteractionPolicy({ backend: 'acp', workdir, interactionPolicy: { rules: [] } }), { rules: [] });
  assert.equal(resolveStartInteractionPolicy({ backend: 'mirasim', workdir }), undefined);
  assert.equal(resolveStartInteractionPolicy({ backend: 'mirasim', workdir, interactionPolicy: custom }), custom);
});

test('default worktree rule grants git add inside the tree and refuses rm', async t => {
  const { defaultWorktreeInteractionPolicy } = await POLICY;
  const { acpPermissionScope } = await RUNNER;
  const workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dao-t8b-scope-')));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  const rule = defaultWorktreeInteractionPolicy(workdir).rules[0];
  const ok = acpPermissionScope(rule, { toolCall: { kind: 'execute', title: '`git add notes.txt`' } }, { cwd: workdir });
  assert.equal(ok.permission, 'worktree_scoped');
  assert.equal(acpPermissionScope(rule, { toolCall: { kind: 'execute', title: '`rm -rf .`' } }, { cwd: workdir }), null);
  assert.ok(acpPermissionScope(rule, { toolCall: { kind: 'edit', rawInput: { path: path.join(workdir, 'a.txt') } } }, { cwd: workdir }));
});

test('default policy requires an absolute workdir', async () => {
  const { defaultWorktreeInteractionPolicy } = await POLICY;
  assert.throws(() => defaultWorktreeInteractionPolicy('relative'), /absolute workdir/);
});
