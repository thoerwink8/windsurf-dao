// 常驻面「一行桥」闸：@导入写在代码块里必须红；桥断链必须红；一行桥指到真相源必须绿。
// 样本全在内存里——仓内不留叫 CLAUDE.md/AGENTS.md 的夹具（宿主会把任意层的同名文件当常驻面注入）。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'resident-bridge.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

describe('resident-bridge', () => {
  it('三个坑各有一份红样本，绿与没查成分得开', async (t) => {
    const S = await LIB_LOAD;

    const ok = S.inspectBridges({ root: '', rels: ['CLAUDE.md'], files: { 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': '# 真相源\n' } });
    await t.test('一行桥指到真相源 → 绿', () => {
      assert.equal(ok.kind, 'ok');
      assert.deepEqual(ok.bridged, ['CLAUDE.md']);
    });

    const codeblock = S.inspectBridges({ root: '', rels: ['CLAUDE.md'], files: { 'CLAUDE.md': '# 说明\n\n```\n@AGENTS.md\n```\n', 'AGENTS.md': '# 真相源\n' } });
    await t.test('@导入写在代码块里 → 红（坑①）', () => {
      assert.equal(codeblock.kind, 'red');
      assert.ok(/代码块|不展开/.test(codeblock.problems.join(' ')), '红证据点出坑①  →  ' + codeblock.problems.join(' | '));
    });

    const dangling = S.inspectBridges({ root: '', rels: ['CLAUDE.md'], files: { 'CLAUDE.md': '@MISSING.md\n' } });
    await t.test('桥断链 → 红', () => {
      assert.equal(dangling.kind, 'red');
      assert.ok(/断了/.test(dangling.problems.join(' ')), '红证据点出断链  →  ' + dangling.problems.join(' | '));
    });

    const mixed = S.inspectBridges({ root: '', rels: ['CLAUDE.md'], files: { 'CLAUDE.md': '@AGENTS.md\n\n再加一句\n', 'AGENTS.md': '# 真相源\n' } });
    await t.test('混了正文与导入 → 红', () => {
      assert.equal(mixed.kind, 'red');
    });

    const none = S.inspectBridges({ root: '', rels: ['CLAUDE.md'], files: {} });
    await t.test('一个常驻面都没有 → 没查成，不是绿', () => {
      assert.equal(none.kind, 'unscanned');
    });
  });

  it('抽导入时不认代码里的 @（坑①的判据本身）', async (t) => {
    const S = await LIB_LOAD;
    await t.test('行内代码与围栏里的 @ 都不算导入', () => {
      assert.deepEqual(S.extractImports('@AGENTS.md\n'), ['AGENTS.md']);
      assert.deepEqual(S.extractImports('看 `@AGENTS.md` 这份\n'), []);
      assert.deepEqual(S.extractImports('```\n@AGENTS.md\n```\n'), []);
    });
  });
});
