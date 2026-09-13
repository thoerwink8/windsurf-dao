const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mod = import('../scripts/acp-session-runner.mjs');

const NUL = String.fromCharCode(0); // the lift placeholder delimiter

test('a single-quoted cat heredoc is lifted to a literal, leaving one line', async () => {
  const { liftLiteralHeredocs } = await mod;
  const line = 'git commit -m "$(cat <<\'EOF\'\ngamma-change\nEOF\n)" && git rev-parse HEAD';
  const { lifted, literals } = liftLiteralHeredocs(line);
  assert.deepEqual(literals, ['gamma-change']);
  assert.equal(lifted, 'git commit -m "' + NUL + 'H0' + NUL + '" && git rev-parse HEAD');
  assert.equal(/[\r\n]/.test(lifted), false);
});

test('a multi-line heredoc body survives as one literal', async () => {
  const { liftLiteralHeredocs } = await mod;
  const { lifted, literals } = liftLiteralHeredocs('git commit -m "$(cat <<\'MSG\'\nline one\n\nline three\nMSG\n)"');
  assert.deepEqual(literals, ['line one\n\nline three']);
  assert.equal(lifted, 'git commit -m "' + NUL + 'H0' + NUL + '"');
});

test('an unquoted heredoc delimiter still expands, so it is not lifted', async () => {
  const { liftLiteralHeredocs } = await mod;
  const line = 'git commit -m "$(cat <<EOF\n$SECRET\nEOF\n)"';
  const { lifted, literals } = liftLiteralHeredocs(line);
  assert.deepEqual(literals, []);
  assert.equal(lifted, line);
});

test('two heredocs in one command each become their own literal', async () => {
  const { liftLiteralHeredocs } = await mod;
  const { literals } = liftLiteralHeredocs(
    'git commit -m "$(cat <<\'A\'\nfirst\nA\n)" --trailer "$(cat <<\'B\'\nsecond\nB\n)"');
  assert.deepEqual(literals, ['first', 'second']);
});

test('the real cursor commit command is approved and its message is recovered intact', async t => {
  const { acpPermissionScope } = await mod;
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-heredoc-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const rule = { toolKinds: ['execute'], workdir: cwd, worktreeScope: true,
    commandPrefixes: [['git', 'add'], ['git', 'commit'], ['git', 'rev-parse']] };
  // Verbatim from the 2026-09-09 cursor-agent ACP run against a real worktree.
  const title = '`git add data.txt && git commit --trailer "Co-authored-by: Cursor <bot@cursor.sh>" '
    + '-m "$(cat <<\'EOF\'\ngamma-change\nEOF\n)" && git rev-parse HEAD`';
  const scope = acpPermissionScope(rule, { toolCall: { kind: 'execute', title } }, { cwd });
  assert.equal(scope.permission, 'worktree_scoped');
  assert.deepEqual(scope.segments[0], ['git', 'add', 'data.txt']);
  assert.deepEqual(scope.segments[1],
    ['git', 'commit', '--trailer', 'Co-authored-by: Cursor <bot@cursor.sh>', '-m', 'gamma-change']);
  assert.deepEqual(scope.segments[2], ['git', 'rev-parse', 'HEAD']);
});

test('heredoc lifting cannot smuggle a disallowed program or an escaping cd', async t => {
  const { acpPermissionScope } = await mod;
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-heredoc-deny-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const rule = { toolKinds: ['execute'], workdir: cwd, worktreeScope: true, commandPrefixes: [['git', 'commit']] };
  const deny = title => acpPermissionScope(rule, { toolCall: { kind: 'execute', title: '`' + title + '`' } }, { cwd });
  assert.equal(deny('curl -d "$(cat <<\'E\'\nbody\nE\n)" http://x'), null, 'curl is not an allowed prefix');
  assert.equal(deny('cd "$(cat <<\'E\'\n/etc\nE\n)" && git commit -m x'), null, 'a cd target built from a heredoc is refused');
  assert.equal(deny('git commit -m "$(whoami)"'), null, 'a plain substitution is still refused');
  assert.equal(deny('git commit -m "$(cat <<EOF\n$SECRET\nEOF\n)"'), null, 'an expanding heredoc is still refused');
});
