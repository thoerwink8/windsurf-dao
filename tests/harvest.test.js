// #888 回流闸：段解析 / 受理证据 / 三行齐全 / 夹具三态。
// 判别点：孤儿段（有段没人接）必须红——那正是「好东西烂在单里」的形状。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LIB = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'harvest-check.mjs').replace(/\\/g, '/');
const FIX = path.join(__dirname, 'fixtures', 'harvest');
const readFix = n => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.json`), 'utf8'));

const full = [
  '## 回流',
  '- 产物：dropImpact 拆前算影响面',
  '- 为什么通用：①拆腿预演 ②删检查前扫消费方',
  '- 落点：上收 scripts/lib',
].join('\n');

describe('harvest 回流闸', () => {
  it('段解析：三行齐 / 缺行 / 无段', async (t) => {
    const { scanHarvestSection } = await import(LIB);
    await t.test('三行齐全 → missing 空', () => {
      const r = scanHarvestSection(full);
      assert.ok(r.has && r.missing.length === 0, JSON.stringify(r));
    });
    await t.test('缺「落点」被点名', () => {
      const r = scanHarvestSection('## 回流\n- 产物：x\n- 为什么通用：①a ②b\n');
      assert.deepEqual(r.missing, ['落点']);
    });
    await t.test('没段 → has:false（不写不算错）', () => {
      assert.equal(scanHarvestSection('普通 PR 正文').has, false);
    });
    await t.test('段落到下一个标题为止，不吃别人的行', () => {
      const r = scanHarvestSection(`${full}\n\n## 机制判定\n- 落点：这行不属于回流段\n`);
      assert.match(r.fields['落点'], /上收 scripts\/lib/);
    });
  });

  it('受理证据三种写法都认，缺则是孤儿', async (t) => {
    const { scanHarvestSection } = await import(LIB);
    for (const [label, line] of [
      ['回流单', '- 回流单：#888'],
      ['已回流 sha', '- 已回流：ea35cce'],
      ['不回流', '- 不回流：只在本仓用，写了指针+报警检查'],
    ]) {
      await t.test(`${label} 算接住`, () => {
        const r = scanHarvestSection(`${full}\n${line}`);
        assert.ok(r.accepted, JSON.stringify(r));
      });
    }
    await t.test('三种都没有 → 孤儿', () => {
      assert.equal(scanHarvestSection(full).accepted, false);
    });
  });

  it('判官：孤儿红 / 三行不全红 / 全接住绿', async (t) => {
    const { judgeHarvest } = await import(LIB);
    await t.test('孤儿段判红并点名 PR 号', () => {
      const v = judgeHarvest([{ number: 7, body: full }]);
      assert.ok(!v.ok && v.orphans[0].includes('#7'), JSON.stringify(v));
    });
    await t.test('接住了就绿', () => {
      const v = judgeHarvest([{ number: 7, body: `${full}\n- 回流单：#888` }]);
      assert.ok(v.ok && v.accepted.length === 1, JSON.stringify(v));
    });
    await t.test('没写段的 PR 不参与判定', () => {
      const v = judgeHarvest([{ number: 8, body: '普通 PR' }]);
      assert.ok(v.ok && v.orphans.length === 0, JSON.stringify(v));
    });
  });

  it('三态：0 个 PR = 无从判断（不是绿）；正文全空 = 没查成', async (t) => {
    const { judgeHarvest } = await import(LIB);
    await t.test('空列表 → empty 标记，交调用方 SKIP', () => {
      const v = judgeHarvest([]);
      assert.ok(v.empty === true, JSON.stringify(v));
    });
    await t.test('有 PR 但正文全空 → 没查成', () => {
      const v = judgeHarvest([{ number: 1, body: '' }, { number: 2 }]);
      assert.ok(v.unscanned === true, JSON.stringify(v));
    });
    await t.test('不是数组 → 没查成', () => {
      assert.equal(judgeHarvest(null).unscanned, true);
    });
  });

  it('夹具三态有判别力', async (t) => {
    const { inspectHarvestFixtures } = await import(LIB);
    const r = inspectHarvestFixtures({ readJson: readFix });
    await t.test('red 判红 / ok 干净 / empty 没查成', () => {
      assert.ok(r.ok && r.kinds.red > 0, JSON.stringify(r));
    });
  });
});
