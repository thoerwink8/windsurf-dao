const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mod = import('../scripts/acp-session-runner.mjs');

// Devin's session/request_permission names only a toolCallId; the kind arrived
// earlier on the session/update that announced the same call. Shapes below are
// verbatim from the 2026-09-09 devin ACP run (session discovered-taxi).
const trackedExec = { id: 'functions.exec:2', toolCallId: 'functions.exec:2', kind: 'execute', title: 'Ran git' };
const devinOptions = [
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_session', name: 'Yes, allow `git` commands (this session)', kind: 'allow_always' },
  { optionId: 'allow_always', name: 'Yes, always allow `git` commands in `devin-tree`', kind: 'allow_always' },
  { optionId: 'switch_bypass', name: 'Yes, switch to bypass mode', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];

test('a permission request without a kind resolves it from the tracked tool call', async () => {
  const { acpPermissionKind } = await mod;
  const params = { toolCall: { toolCallId: 'functions.exec:2' } };
  assert.equal(acpPermissionKind(params, [trackedExec]), 'execute');
  assert.equal(acpPermissionKind(params, []), undefined, 'an untracked id must not be guessed');
  assert.equal(acpPermissionKind({ toolCall: {} }, [trackedExec]), undefined, 'no id means no kind');
  assert.equal(acpPermissionKind({}, [trackedExec]), undefined);
  // An explicit kind on the request always wins over the tracked record.
  assert.equal(acpPermissionKind({ toolCall: { toolCallId: 'functions.exec:2', kind: 'read' } }, [trackedExec]), 'read');
});

test('the real devin git command is approved from _meta with git -C pinned to the worktree', async t => {
  const { acpPermissionScope } = await mod;
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-devin-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const rule = { toolKinds: ['execute'], workdir: cwd, worktreeScope: true,
    commandPrefixes: [['git', 'add'], ['git', 'commit']] };
  const params = { sessionId: 'discovered-taxi', options: devinOptions, toolCall: {
    toolCallId: 'functions.exec:2',
    _meta: { 'cognition.ai/editableCommand': 'git -C "' + cwd + '" add notes.txt && git -C "' + cwd + '" commit -m "gamma-change"' },
  } };
  const scope = acpPermissionScope(rule, params, { cwd, toolCalls: [trackedExec] });
  assert.equal(scope.permission, 'worktree_scoped');
  assert.equal(scope.toolKind, 'execute');
  assert.deepEqual(scope.segments[0], ['git', '-C', cwd, 'add', 'notes.txt']);
  assert.deepEqual(scope.segments[1], ['git', '-C', cwd, 'commit', '-m', 'gamma-change']);
});

test('git -C pointing outside the worktree is refused even when the subcommand is allowed', async t => {
  const { acpPermissionScope } = await mod;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-devin-deny-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'managed'));
  fs.mkdirSync(path.join(dir, 'other'));
  const cwd = fs.realpathSync(path.join(dir, 'managed'));
  const elsewhere = fs.realpathSync(path.join(dir, 'other'));
  const rule = { toolKinds: ['execute'], workdir: cwd, worktreeScope: true, commandPrefixes: [['git', 'commit']] };
  const scope = command => acpPermissionScope(rule,
    { options: devinOptions, toolCall: { toolCallId: 'functions.exec:2', _meta: { 'cognition.ai/editableCommand': command } } },
    { cwd, toolCalls: [trackedExec] });
  assert.equal(scope('git -C "' + elsewhere + '" commit -m x'), null);
  assert.equal(scope('git -C "' + cwd + '" push origin main'), null, 'push is not an allowed prefix');
  assert.equal(scope('git -C "' + cwd + '"'), null, 'a bare -C with no subcommand is refused');
  assert.notEqual(scope('git -C "' + cwd + '" commit -m x'), null, 'the allowed form still passes');
});

test('a word built from adjacent quoted and unquoted parts stays one word', async t => {
  const { acpPermissionScope } = await mod;
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-concat-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const rule = { toolKinds: ['execute'], workdir: cwd, worktreeScope: true,
    commandPrefixes: [['git', 'add'], ['git', 'commit'], ['git', 'log']] };
  // Verbatim from the 2026-09-09 devin run: --format="%H %s" is one shell word.
  const command = 'cd ' + cwd + ' && git add notes.txt && git commit -m "gamma-change" --quiet'
    + ' && git log --oneline -n 1 --format="%H %s"';
  const scope = acpPermissionScope(rule,
    { toolCall: { toolCallId: 'functions.exec:3', _meta: { 'cognition.ai/editableCommand': command } } },
    { cwd, toolCalls: [{ id: 'functions.exec:3', kind: 'execute' }] });
  assert.equal(scope.permission, 'worktree_scoped');
  assert.deepEqual(scope.segments[3], ['git', 'log', '--oneline', '-n', '1', '--format=%H %s']);
});

test('an untracked tool call id leaves the request unmatched instead of approved', async t => {
  const { acpPermissionScope } = await mod;
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-devin-untracked-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const rule = { toolKinds: ['execute'], workdir: cwd, worktreeScope: true, commandPrefixes: [['git', 'commit']] };
  const params = { options: devinOptions, toolCall: { toolCallId: 'functions.exec:99',
    _meta: { 'cognition.ai/editableCommand': 'git -C "' + cwd + '" commit -m x' } } };
  assert.equal(acpPermissionScope(rule, params, { cwd, toolCalls: [trackedExec] }), null);
});
