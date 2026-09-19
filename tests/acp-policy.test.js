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

test('worktree scope approves any path inside the managed workdir and nothing outside', async t => {
  const { acpPermissionScope } = await mod;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-worktree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'managed'));
  const cwd = fs.realpathSync(path.join(dir, 'managed'));
  const outside = fs.realpathSync(dir);
  fs.mkdirSync(path.join(cwd, 'nested'));
  const rule = { toolKinds: ['read', 'edit'], workdir: cwd, worktreeScope: true, commandPrefixes: [['git', 'add']] };
  const call = (kind, rawInput) => ({ toolCall: { kind, rawInput } });

  // A file that does not exist yet is the normal case for a new source file.
  const created = acpPermissionScope(rule, call('edit', { path: path.join(cwd, 'nested', 'new.mjs') }), { cwd });
  assert.deepEqual(created.paths, [path.join(cwd, 'nested', 'new.mjs')]);
  assert.equal(created.permission, 'worktree_scoped');
  assert.equal(acpPermissionScope(rule, call('read', { path: 'relative.txt' }), { cwd }).paths[0], path.join(cwd, 'relative.txt'));
  assert.equal(acpPermissionScope(rule, call('edit', { path: path.join(outside, 'escape.txt') }), { cwd }), null);
  assert.equal(acpPermissionScope(rule, call('edit', { path: '../escape.txt' }), { cwd }), null);
  assert.equal(acpPermissionScope(rule, call('edit', {}), { cwd }), null);
  assert.equal(acpPermissionScope(rule, call('delete', { path: path.join(cwd, 'x') }), { cwd }), null, 'delete is not in toolKinds');
});

test('worktree scope refuses a symlink that leaves the managed workdir', async t => {
  const { acpPermissionScope } = await mod;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-worktree-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'managed'));
  const cwd = fs.realpathSync(path.join(dir, 'managed'));
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(cwd, 'escape'));
  const rule = { toolKinds: ['edit'], workdir: cwd, worktreeScope: true };
  const params = { toolCall: { kind: 'edit', rawInput: { path: path.join(cwd, 'escape', 'secret.txt') } } };
  assert.equal(acpPermissionScope(rule, params, { cwd }), null);
});

test('worktree execute approves a cd-bounded command chain of allowed prefixes only', async t => {
  const { acpPermissionScope } = await mod;
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-wt-exec-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const rule = { toolKinds: ['execute'], workdir: cwd, worktreeScope: true,
    commandPrefixes: [['git', 'add'], ['git', 'commit'], ['git', 'status'], ['node', '--test']] };
  // This is the exact title shape cursor-agent sent in the 2026-09-09 discovery run.
  const title = '`cd ' + cwd + ' && git add data.txt && git commit --trailer "Co-authored-by: Cursor <bot@cursor.sh>" -m "gamma-change"`';
  const scope = acpPermissionScope(rule, { toolCall: { kind: 'execute', title } }, { cwd });
  assert.equal(scope.permission, 'worktree_scoped');
  assert.deepEqual(scope.segments[0], ['cd', cwd]);
  assert.deepEqual(scope.segments[1], ['git', 'add', 'data.txt']);
  assert.deepEqual(scope.segments[2], ['git', 'commit', '--trailer', 'Co-authored-by: Cursor <bot@cursor.sh>', '-m', 'gamma-change']);
});

test('worktree execute refuses unbounded, relocated and operator-smuggled commands', async t => {
  const { acpPermissionScope } = await mod;
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-wt-deny-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const rule = { toolKinds: ['execute'], workdir: cwd, worktreeScope: true, commandPrefixes: [['git', 'add'], ['git', 'status']] };
  const deny = title => acpPermissionScope(rule, { toolCall: { kind: 'execute', title: '`' + title + '`' } }, { cwd });
  assert.equal(deny('cd /etc && git status'), null, 'cd elsewhere escapes the worktree');
  assert.equal(deny('cd ' + cwd + ' && cd /etc && git status'), null, 'a later cd out still escapes');
  assert.equal(deny('cd ' + cwd + ' && rm -rf .'), null, 'rm is not an allowed prefix');
  assert.equal(deny('cd ' + cwd + ' && git status | tee /etc/x'), null, 'pipe is refused');
  assert.equal(deny('cd ' + cwd + ' && git status > /etc/x'), null, 'redirect is refused');
  assert.equal(deny('cd ' + cwd + ' && git status & sleep 9'), null, 'backgrounding is refused');
  assert.equal(deny('cd ' + cwd + ' && git status; rm -rf /'), null, 'semicolon chain is refused');
  assert.equal(deny('cd ' + cwd + ' && git add "$(whoami)"'), null, 'command substitution is refused');
  assert.equal(deny('cd ' + cwd + ' ' + cwd + ' && git status'), null, 'cd must take exactly one argument');
});

test('worktree execute approves a command with no cd, because the session cwd is the worktree', async t => {
  const { acpPermissionScope } = await mod;
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-wt-nocd-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const rule = { toolKinds: ['execute'], workdir: cwd, worktreeScope: true, commandPrefixes: [['git', 'status'], ['git', 'log']] };
  // The exact title cursor-agent sent in the 2026-09-09 end-to-end run.
  const scope = acpPermissionScope(rule, { toolCall: { kind: 'execute', title: '`git status && git log -3 --oneline`' } }, { cwd });
  assert.equal(scope.permission, 'worktree_scoped');
  assert.deepEqual(scope.segments, [['git', 'status'], ['git', 'log', '-3', '--oneline']]);
});

test('worktree execute scopes literal path arguments to the tree', async t => {
  const { acpPermissionScope } = await mod;
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-wt-paths-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-wt-out-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'nested'));
  const rule = { toolKinds: ['execute'], workdir: cwd, worktreeScope: true, commandPrefixes: [['cat'], ['grep'], ['test'], ['git', 'status'], ['git', 'commit']] };
  const scope = title => acpPermissionScope(rule, { toolCall: { kind: 'execute', title: '`' + title + '`' } }, { cwd });
  // 树内的只读巡检照常放行。
  assert.ok(scope('cat README.md'), 'bare filename resolves inside the tree');
  assert.ok(scope('cat nested/file.txt'), 'relative path inside the tree');
  assert.ok(scope('test -f packages/fleet/README.md'), 'test -f is the common pre-commit self-check');
  assert.equal(scope('grep -n dao nested/file.txt && git status').permission, 'worktree_scoped', 'paths inside a chain stay allowed');
  // 树外的字面路径必须拒绝：前缀命中不等于读凭据放行。
  assert.equal(scope('cat /etc/passwd'), null, 'absolute path outside the tree is refused');
  assert.equal(scope('cat ' + path.join(outside, 'secret')), null, 'absolute outside path is refused');
  assert.equal(scope('cat ../outside/secret'), null, 'dot-dot escape is refused');
  assert.equal(scope('grep --file=/etc/passwd x'), null, 'flag=value paths are checked too');
  assert.equal(scope('grep -f/etc/passwd x'), null, 'short option with attached absolute path is refused');
  assert.equal(scope('grep -nf/etc/passwd x'), null, 'clustered short option with attached path is refused');
  assert.equal(scope('grep -ivnf/etc/passwd x'), null, '多字母簇附着路径也拒（复核实咬：扫描窗只有 3 字符时漏）');
  assert.equal(scope('grep -abcdef/etc/passwd x'), null, '长字母簇附着路径也拒');
  assert.equal(scope('sed -f../../outside/secret x'), null, 'attached dot-dot escape is refused');
  assert.equal(scope('git commit -m"fix a /b bug"')?.permission, 'worktree_scoped', '引号内的斜杠是内容不是路径');
  if (process.platform !== 'win32') {
    // 树内符号链接指向树外：bare 名也要跟 symlink（复核实咬：只查带 `/` 的词会漏）。
    fs.symlinkSync(outside, path.join(cwd, 'leak'));
    assert.equal(scope('cat leak'), null, '树内 symlink 指向树外要拒');
    assert.equal(scope('cat leak/secret'), null, 'symlink 下的路径也要拒');
  }
  assert.equal(scope('cat /etc/passwd && git status'), null, 'one out-of-tree segment refuses the whole chain');
  // 值在树内的紧贴写法照常放行。
  assert.equal(scope('grep -f nested/pattern.txt x')?.permission, 'worktree_scoped', 'attached in-tree value stays allowed');
  // 不存在的树内新文件（ENOENT 走后缀拼接）也按树内处理。
  assert.equal(scope('test -f nested/not-created-yet.txt')?.permission, 'worktree_scoped', 'a not-yet-created path inside the tree stays allowed');
});

test('worktree permission grant selects the server allow_once option without a preset optionId', async t => {
  const { acpPermissionScope } = await mod;
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dao-acp-wt-grant-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const rule = { toolKinds: ['read'], workdir: cwd, worktreeScope: true };
  const scope = acpPermissionScope(rule, { toolCall: { kind: 'read', rawInput: { path: path.join(cwd, 'a.txt') } } }, { cwd });
  assert.equal(scope.permission, 'worktree_scoped');
});
