// 孤儿测试闸（dao-check ㉖）：test 引用的仓内目标不存在 = 机制删了测试没同删。
// 纯函数注入 fs 测；夹具红/绿/空判别力由 dao-check ㉖ 样本闸直接跑。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'orphan-test-check.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

describe('orphan-test-check', () => {
  it('extractTestRefs：字面 import/require + join(__dirname,...) 都抽得出', async (t) => {
    const S = await LIB_LOAD;
    // 样本放夹具文件不内联：本测试文件自身也在 live 扫描面内，内联样本会被闸当真引用抓
    const fs = require('fs');
    const sample = fs.readFileSync(path.join(__dirname, 'fixtures', 'orphan-test', 'extract-sample.txt'), 'utf8');
    const { refs } = S.extractTestRefs(sample);
    await t.test('四类引用全收', () => {
      const joined = refs.join('|');
      assert.ok(joined.includes('../scripts/lib/x.mjs') && joined.includes('./local-helper.js')
        && joined.includes("../scripts/lib/y.mjs") && joined.includes('fixtures/z'),
        '四类引用  →  ' + joined);
    });
  });

  it('inspectOrphanTests：孤儿抓得出，健在的不误伤，0 测试 = 没查成', async (t) => {
    const S = await LIB_LOAD;
    // 样本同样放夹具（本文件在 live 扫描面内，内联假引用会被闸当真）
    const fs2 = require('fs');
    const unitDir = path.join(__dirname, 'fixtures', 'orphan-test', 'unit');
    const files = ['tests/a.test.js', 'tests/b.test.js'];
    const content = {
      'tests/a.test.js': fs2.readFileSync(path.join(unitDir, 'a.test.js'), 'utf8'),
      'tests/b.test.js': fs2.readFileSync(path.join(unitDir, 'b.test.js'), 'utf8'),
    };
    const r = S.inspectOrphanTests({
      files,
      readFile: (f) => content[f],
      exists: (rel) => rel === 'scripts/lib/here.mjs',
    });
    await t.test('孤儿只有 a.test.js 一处', () => {
      assert.ok(r.ok === false && r.orphans.length === 1 && r.orphans[0].test === 'tests/a.test.js'
        && r.orphans[0].resolved === 'scripts/lib/gone.mjs',
        '孤儿  →  ' + JSON.stringify(r.orphans));
    });
    await t.test('扫描计数显形', () => {
      assert.ok(r.scanned === 2 && r.scannedRefs === 2, '计数  →  ' + JSON.stringify({ scanned: r.scanned, scannedRefs: r.scannedRefs }));
    });

    const zero = S.inspectOrphanTests({ files: ['README.md'], readFile: () => '', exists: () => true });
    await t.test('0 个测试文件 = 没查成，不是没有孤儿', () => {
      assert.ok(zero.unscanned === true && /没查成/.test(zero.error), '零样本  →  ' + zero.error);
    });

    const outside = S.inspectOrphanTests({
      files: ['tests/c.test.js'],
      readFile: () => "const os = require('os'); const p = require('../../outside/x.mjs');",
      exists: () => false,
    });
    await t.test('指出仓外的引用不归本闸', () => {
      assert.ok(outside.ok === true && outside.orphans.length === 0, '仓外  →  ' + JSON.stringify(outside.orphans));
    });
  });

  it('无扩展名的 require 要按 Node 的解析补候选（2026-09-06 实咬）', async (t) => {
    const S = await LIB_LOAD;
    await t.test('写了扩展名就只认它自己', () => {
      assert.deepStrictEqual(S.resolveCandidates('tests/helpers/x.mjs'), ['tests/helpers/x.mjs']);
    });
    await t.test('没写扩展名给出 .js/.mjs/.cjs 与 index 候选', () => {
      const c = S.resolveCandidates('tests/helpers/dao-harness');
      assert.ok(c.includes('tests/helpers/dao-harness.js'));
      assert.ok(c.includes('tests/helpers/dao-harness.mjs'));
      assert.ok(c.includes('tests/helpers/dao-harness/index.js'));
    });
    await t.test('只有 .js 在盘上时不判孤儿', () => {
      const r = S.inspectOrphanTests({
        files: ['tests/a.test.js'],
        readFile: () => `require('${"./helpers/" + "dao-harness"}');`,  // 拼起来：本文件在闸的扫描面内，写死会被当真引用
        exists: (p) => p === 'tests/helpers/dao-harness.js',
      });
      assert.equal(r.orphans.length, 0);
    });
    await t.test('判别力：一个候选都不在，照样判孤儿', () => {
      const r = S.inspectOrphanTests({
        files: ['tests/a.test.js'],
        readFile: () => `require('${"./helpers/" + "gone"}');`,        // 同上——2026-09-06 实咬：写死这行让闸把本套判成孤儿
        exists: () => false,
      });
      assert.equal(r.orphans.length, 1);
    });
  });

  it('夹具判别力：red 抓孤儿 / ok 绿 / empty 没查成', async (t) => {
    const S = await LIB_LOAD;
    const r = S.inspectOrphanTestFixtures(path.join(__dirname, 'fixtures', 'orphan-test'));
    await t.test('三类样本全过', () => {
      assert.ok(r.ok === true, '夹具  →  ' + JSON.stringify(r));
    });
    await t.test('red/ok/empty 各 1', () => {
      assert.ok(r.kinds.red === 1 && r.kinds.ok === 1 && r.kinds.empty === 1, 'kinds  →  ' + JSON.stringify(r.kinds));
    });
  });
});
