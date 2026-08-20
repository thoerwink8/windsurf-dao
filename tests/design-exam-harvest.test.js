// #675 盲考收卷纪律：dao-check 指针有判别力
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'design-exam-harvest-check.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

describe('design-exam-harvest-check', () => {
  it('样本红绿空有判别力', async (t) => {
    const S = await LIB_LOAD;
    const fx = S.inspectDesignExamHarvestFixtures(path.join(REPO, 'tests', 'fixtures', 'design-exam-harvest'));
    await t.test('夹具齐且绿', () => {
      assert.ok(fx.ok === true && fx.kinds.red >= 1 && fx.kinds.ok >= 1 && fx.kinds.empty >= 1, '夹具齐且绿  →  ' + JSON.stringify(fx));
    });
    const missing = S.inspectDesignExamHarvestFixtures(path.join(REPO, 'tests', 'fixtures', 'no-such-dir'));
    await t.test('目录不在 → unscanned', () => {
      assert.ok(missing.ok === false && missing.unscanned === true, '目录不在 → unscanned');
    });
  });

  it('扫描器：收卷切片，故意违规要红', async (t) => {
    const S = await LIB_LOAD;
    const live = fs.readFileSync(path.join(REPO, 'host', 'skills', 'design-exam', 'SKILL.md'), 'utf8');
    const ok = S.inspectDesignExamHarvestLive({ skillSrc: live });
    await t.test('live SKILL 绿', () => {
      assert.ok(ok.ok === true && ok.unscanned === false, 'live SKILL 绿  →  ' + JSON.stringify(ok));
    });
    const red = S.inspectDesignExamHarvestLive({ skillSrc: '## 收卷\n各臂做 diff。\n' });
    await t.test('故意删收卷纪律 → 红', () => {
      assert.ok(red.ok === false && !red.unscanned && red.problems.length >= 1, '故意删收卷纪律 → 红  →  ' + JSON.stringify(red));
    });
    const noSection = S.inspectDesignExamHarvestLive({ skillSrc: '## 起灶\n开跑。\n' });
    await t.test('收卷节被删 → 指针失效红', () => {
      assert.ok(noSection.ok === false && /收卷/.test((noSection.problems || []).join(' ')), '收卷节被删 → 指针失效红  →  ' + JSON.stringify(noSection));
    });
    const empty = S.inspectDesignExamHarvestLive({});
    await t.test('没给正文 → unscanned', () => {
      assert.ok(empty.ok === false && empty.unscanned === true, '没给正文 → unscanned');
    });
    await t.test('起灶节里的字不算收卷纪律', () => {
      const bait = S.inspectDesignExamHarvestLive({
        skillSrc: '## 起灶\n起灶的这一轮盯 answer.md。禁止起完等人问。不把帅对话框当监视器。\n## 收卷\n各臂 diff。\n',
      });
      assert.ok(bait.ok === false, '起灶节里的字不算收卷纪律  →  ' + JSON.stringify(bait));
    });
  });
});
