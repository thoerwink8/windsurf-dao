// §73 四轴腿表：夹具三态 + 约束判别 + drop/restore 往返（drop 必须联动树禁用，否则是空话）。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'legs.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));
const FIX = path.join(__dirname, 'fixtures', 'legs');

const readFix = n => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.json`), 'utf8'));

describe('legs', () => {
  it('夹具三态：红校出错 / 绿干净 / 缺节=没查成', async (t) => {
    const S = await LIB_LOAD;
    const r = S.inspectLegsFixtures({ readJson: readFix });
    await t.test('三态齐且有判别力', () => {
      assert.ok(r.ok && r.kinds.red > 0 && r.kinds.ok === 1 && r.kinds.empty === 1,
        '三态齐  →  ' + JSON.stringify(r));
    });
    const empty = S.validateLegs(readFix('empty'));
    await t.test('缺节是没查成，不是零错通过', () => {
      assert.ok(empty.unscanned === true && empty.ok === false, JSON.stringify(empty));
    });
  });

  it('轴间约束逐条有判别力（§73 实测约束）', async (t) => {
    const S = await LIB_LOAD;
    const base = readFix('ok');
    const mk = (leg) => ({ ...base, 腿: [...base.腿, leg] });
    const legOf = (model, family, supplier, executor) => ({
      id: `${model}@${supplier}/${executor}`, 模型: model, 族: family, 供应商: supplier, 执行侧: executor,
      状态: '在役', 拍板: '2026-09-04',
    });
    await t.test('①mirasim 执行 claude 族 ⇒ 供应商必须 mirasim', () => {
      const v = S.validateLegs(mk(legOf('claude-x', 'claude', 'reclaude', 'mirasim')));
      assert.ok(v.errors.some(e => /约束①/.test(e)), v.errors.join('|'));
    });
    await t.test('②reclaude 只供 claude 族', () => {
      const v = S.validateLegs(mk(legOf('grok-x', 'pi', 'reclaude', 'orca')));
      assert.ok(v.errors.some(e => /约束②/.test(e)), v.errors.join('|'));
    });
    await t.test('③cc-local 只会说 claude 族', () => {
      const v = S.validateLegs(mk(legOf('grok-x', 'pi', 'gw', 'cc-local')));
      assert.ok(v.errors.some(e => /约束③/.test(e)), v.errors.join('|'));
    });
    await t.test('④mirasim 额度只能经 mirasim 执行', () => {
      const v = S.validateLegs(mk(legOf('kimi-x', 'pi', 'mirasim', 'orca')));
      assert.ok(v.errors.some(e => /约束④/.test(e)), v.errors.join('|'));
    });
    await t.test('id 必须等于四轴拼写', () => {
      const bad = { ...legOf('a-1', 'pi', 'gw', 'orca'), id: '别名' };
      const v = S.validateLegs(mk(bad));
      assert.ok(v.errors.some(e => /id .*与四轴不符/.test(e)), v.errors.join('|'));
    });
    await t.test('id 重复即红，且报出现次数（两个帅位并发补腿实咬）', () => {
      // 同一条腿抄三份——rebase 缝合的真实形态
      const dup = legOf('grok-4.6', 'pi', 'gw', 'orca');
      const v = S.validateLegs({ ...base, 腿: [...base.腿, dup, dup] });
      assert.ok(v.errors.some(e => /id 重复：grok-4\.6@gw\/orca 共出现 3 次/.test(e)), v.errors.join('|'));
      // 判别力：不重复时这条错误不许出现
      const clean = S.validateLegs(base);
      assert.ok(!clean.errors.some(e => /id 重复/.test(e)), clean.errors.join('|'));
    });
  });

  it('交叉核：启用条目没有在役腿 → 错；空转腿 → 警告不拦', async (t) => {
    const S = await LIB_LOAD;
    const red = readFix('red');
    await t.test('red 夹具的启用条目缺腿被点名', () => {
      const c = S.crossCheckLegsTree(red);
      assert.ok(!c.ok && c.errors.some(e => /deepseek-v4-flash/.test(e)), JSON.stringify(c.errors));
    });
    const ok = readFix('ok');
    ok.腿.push({
      id: 'kimi-k3@gw/orca', 模型: 'kimi-k3', 族: 'pi', 供应商: 'gw', 执行侧: 'orca',
      状态: '在役', 拍板: '2026-09-04', 落地: { provider: 'gw', cli_model: 'gw-sub/kimi-k3-high' },
    });
    await t.test('在役带落地却没消费方 → 警告，不判错', () => {
      const c = S.crossCheckLegsTree(ok);
      assert.ok(c.ok && c.warnings.some(w => /kimi-k3@gw\/orca/.test(w)), JSON.stringify(c));
    });
  });

  it('drop：影响面全黑拒绝语义 + 联动树禁用 + restore 只解自己禁的', async (t) => {
    const S = await LIB_LOAD;
    const doc = readFix('ok'); // 工人.写码 只有 grok 一条腿
    await t.test('拆唯一的腿 → anyBlack', () => {
      const impact = S.dropImpact(doc, { legIds: ['grok-4.6@gw/orca'] });
      assert.ok(impact.ok && impact.anyBlack && impact.slots[0].goesBlack, JSON.stringify(impact));
    });
    await t.test('拆空气（选择器没命中）→ 拒', () => {
      const impact = S.dropImpact(doc, { axis: '供应商', value: 'nonexist' });
      assert.ok(!impact.ok && /拆空气/.test(impact.error), JSON.stringify(impact));
    });
    await t.test('缺 --why → 拒', () => {
      const r = S.applyLegDrop(doc, { legIds: ['grok-4.6@gw/orca'] }, {});
      assert.ok(!r.ok && /--why/.test(r.error), JSON.stringify(r.error));
    });
    const dropped = S.applyLegDrop(doc, { legIds: ['grok-4.6@gw/orca'] }, { why: '测试拆腿', date: '2026-09-04' });
    await t.test('drop 联动：腿停用 + 树条目禁用且记来源', () => {
      assert.ok(dropped.ok, JSON.stringify(dropped));
      const leg = dropped.doc.腿.find(l => l.id === 'grok-4.6@gw/orca');
      const entry = dropped.doc.工人.写码.模型.find(m => m.id === 'grok-4.6');
      assert.equal(leg.状态, '停用');
      assert.equal(entry.禁用, true);
      assert.equal(entry.禁用来源, 'leg:grok-4.6@gw/orca');
    });
    await t.test('restore 往返：腿回在役、只解自己禁的条目', () => {
      const hand = structuredClone(dropped.doc);
      // 另一条人手禁的条目不许被 restore 碰
      hand.工人.写码.模型.push({ id: 'x-1', 顺位: 2, 禁用: true, provider: 'gw' });
      const r = S.applyLegRestore(hand, 'grok-4.6@gw/orca');
      assert.ok(r.ok, JSON.stringify(r));
      const leg = r.doc.腿.find(l => l.id === 'grok-4.6@gw/orca');
      const entry = r.doc.工人.写码.模型.find(m => m.id === 'grok-4.6');
      const handEntry = r.doc.工人.写码.模型.find(m => m.id === 'x-1');
      assert.equal(leg.状态, '在役');
      assert.equal(entry.禁用, false);
      assert.ok(!('禁用来源' in entry));
      assert.equal(handEntry.禁用, true, '人手禁的不许被 restore 解开');
    });
    await t.test('按轴选择器命中', () => {
      const impact = S.dropImpact(doc, { axis: '执行侧', value: 'orca' });
      assert.ok(impact.ok && impact.affected.includes('grok-4.6@gw/orca'), JSON.stringify(impact));
    });
  });

  it('N+1 报告：单腿与单轴裸奔都点名', async (t) => {
    const S = await LIB_LOAD;
    const n = await LIB_LOAD.then(L => L.nPlusOneReport(readFix('ok')));
    await t.test('唯一腿的工种被点名', () => {
      assert.ok(n.exposures.some(e => /工人\.写码 只有 1 条腿/.test(e)), JSON.stringify(n.exposures));
    });
  });

  it('真表（docs/model-routing.json）四轴合法且与职责树互证', async (t) => {
    const S = await LIB_LOAD;
    const real = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'model-routing.json'), 'utf8'));
    const v = S.validateLegs(real);
    const c = S.crossCheckLegsTree(real);
    await t.test('validate 绿', () => assert.deepEqual(v.errors, [], v.errors.join('|')));
    await t.test('cross 绿', () => assert.deepEqual(c.errors, [], c.errors.join('|')));
  });
});
