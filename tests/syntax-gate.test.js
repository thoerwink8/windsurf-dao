// T41：零依赖语法闸。纯函数喂样本 + 真起 `node --check` 咬一个故意坏掉的样本。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MOD = import('file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'syntax-gate.mjs').replace(/\\/g, '/'));

test('syntaxTargets：只认 .js/.mjs/.cjs，跳过 node_modules', async () => {
  const { syntaxTargets } = await MOD;
  assert.deepEqual(
    syntaxTargets(['a.mjs', 'b/c.js', 'd.cjs', 'README.md', 'node_modules/x/y.js', 'p/node_modules/z.mjs']),
    ['a.mjs', 'b/c.js', 'd.cjs'],
  );
  assert.deepEqual(syntaxTargets([]), []);
  assert.equal(syntaxTargets(null), null);
});

test('判结果：全过绿；有坏红并点名；空结果绿且说明「没东西要查」', async () => {
  const { judgeSyntaxResults } = await MOD;
  assert.equal(judgeSyntaxResults([{ file: 'a.mjs', ok: true }]).state, 'green');
  const red = judgeSyntaxResults([{ file: 'a.mjs', ok: true }, { file: 'bad.mjs', ok: false, error: 'x' }]);
  assert.equal(red.state, 'red');
  assert.match(red.why, /bad\.mjs/);
  const empty = judgeSyntaxResults([]);
  assert.equal(empty.state, 'green');
  assert.match(empty.why, /没有/);
});

test('故意样本：语法坏的文件被 `node --check` 当场拦下', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syntax-gate-'));
  const bad = path.join(dir, 'bad.mjs');
  // 模板串里多一对反引号 —— 正是 2026-09-19 咬到 cli.mjs 的那个形状。
  fs.writeFileSync(bad, 'const s = `a`b`;\nexport default s;\n', 'utf8');
  const r = spawnSync(process.execPath, ['--check', bad], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, '语法坏的样本必须被拦下');
  assert.match(String(r.stderr || ''), /SyntaxError|Invalid|Unexpected/);

  const good = path.join(dir, 'good.mjs');
  fs.writeFileSync(good, 'export const s = `a`;\n', 'utf8');
  assert.equal(spawnSync(process.execPath, ['--check', good], { encoding: 'utf8' }).status, 0);
});
