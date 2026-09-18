// 测试沙盒不许用固定名（#1358）。
//
// 病：六套测试各自把沙盒钉在 _tmp/<固定名>，模块加载时 rmSync 再 mkdirSync。单跑没事；
// 两份 dao-check 并发（审官审 PR 重跑一份、land 跑一份、dao-land.timer 每小时再一份）时，
// 同一套测试的两个副本互删对方正在用的目录——红的是 ENOENT 一类断言，看起来像测试自己坏了。
// 2026-09-17 服务器实测：串行跑 6 轮 loadavg 到 17.96 全绿；3 个 dao-check 并发 loadavg 13.79 三份全红。
// 后果不是「偶尔红」：land 判红不推 → 主树领先远端 → dao-sync 静默拒绝快进，整台机器停部署。
//
// 闸：扫 tests/*.test.js，凡 path.join(<任意根>, '_tmp', '<字面量>') 这种固定名且不在 mkdtemp 里的，红。
// 判据是纯函数，直接喂文本；故意违规样本在这里被拦住才算闸生效（CLAUDE.md「自动检查」节）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = __dirname;

/** 一段源码里的固定名 _tmp 沙盒。返回 [{line, text}]；空数组 = 这段没有。 */
function findFixedSandboxes(source) {
  const hits = [];
  const lines = String(source).split(/\r?\n/);
  // 形如 path.join(REPO, "_tmp", "mode-sandbox")：_tmp 后面紧跟一个字面量、然后闭括号。
  // 字面量以 - 结尾且整行在 mkdtempSync 里的是前缀不是固定名，放行。
  const fixed = /['"]_tmp['"]\s*,\s*['"]([^'"]+)['"]\s*\)/;
  lines.forEach((text, i) => {
    if (/^\s*\/\//.test(text)) return;                 // 注释里举例不算
    const m = fixed.exec(text);
    if (!m) return;
    if (/mkdtempSync\s*\(/.test(text)) return;          // mkdtemp 的前缀，每进程独占
    hits.push({ line: i + 1, text: text.trim(), name: m[1] });
  });
  return hits;
}

test('判别力：固定名沙盒被拦，mkdtemp 前缀放行，注释里的例子不算', () => {
  const bad = findFixedSandboxes([
    'const SANDBOX = path.join(REPO, "_tmp", "mode-sandbox");',
    "const S = path.join(ROOT, '_tmp', 'x');",
  ].join('\n'));
  assert.equal(bad.length, 2, JSON.stringify(bad));
  assert.equal(bad[0].name, 'mode-sandbox');
  assert.equal(bad[1].line, 2);

  const good = findFixedSandboxes([
    'const SANDBOX = fs.mkdtempSync(path.join(REPO, "_tmp", "mode-sandbox-"));',
    'fs.mkdirSync(path.join(REPO, "_tmp"), { recursive: true });',
    '// 以前写成 path.join(REPO, "_tmp", "mode-sandbox") 会互删',
  ].join('\n'));
  assert.deepEqual(good, []);
});

test('tests/ 里没有固定名 _tmp 沙盒（且确实扫到了样本，不是空扫）', () => {
  const files = fs.readdirSync(TESTS_DIR).filter((f) => /\.test\.(js|mjs|cjs)$/.test(f) && f !== path.basename(__filename));
  assert.ok(files.length > 10, `只扫到 ${files.length} 个测试文件——发现规则或目录变了，本次等于没查`);
  const offenders = [];
  for (const f of files) {
    const hits = findFixedSandboxes(fs.readFileSync(path.join(TESTS_DIR, f), 'utf8'));
    for (const h of hits) offenders.push(`${f}:${h.line}  ${h.text}`);
  }
  assert.deepEqual(offenders, [], '固定名沙盒会在两份 dao-check 并发时互删，改成 fs.mkdtempSync(path.join(REPO, "_tmp", "<名>-"))：\n' + offenders.join('\n'));
});

module.exports = { findFixedSandboxes };
