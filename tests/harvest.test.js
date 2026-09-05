// #888 回流闸：段解析 / 受理证据 / 三行齐全 / 夹具三态 / live 取数覆盖面。
// 判别点：孤儿段（有段没人接）必须红——那正是「好东西烂在单里」的形状。
//
// PR #890 审官 P1 的四条负例全在这里（行边界）：`### 回流`、正文行内提到 `## 回流`、
// 三字段挤一行、只散句提及没真段——老实现（indexOf + 无锚正则）把前三条判 ok:true、
// 第四条判成孤儿红（假阳性）。这一组就是那张表的回归。
// 取舍照设计页：不合规标题一律「不认」（无段、不参与判定），宁可漏报，
// 不在本单顺手做「没写回流段」的自动识别。
// live 腿另配 fail-closed 判据：取数摸到上限就报没查成，不许报成近 7 天全量通过。
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
    await t.test('### 子标题不结束段（段内还能接着写）', () => {
      const r = scanHarvestSection('## 回流\n- 产物：x\n\n### 细节\n- 为什么通用：①a ②b\n- 落点：y\n');
      assert.deepEqual(r.missing, []);
    });
    await t.test('列表符号/粗体/英文冒号都认', () => {
      const r = scanHarvestSection('## 回流\n* **产物**: x\n1. 为什么通用：①a ②b\n- 落点：y\n');
      assert.deepEqual(r.missing, []);
    });

    // 下面两条是被真语料咬出来的：收紧行边界后，已合并 PR #901 那个写得很规范的段
    // 被判 thin（缺「为什么通用」）。闸把合规的段判红，比它原来漏掉不合规的段更坏。
    await t.test('字段名后带括号限定语（`为什么通用（≥2 场景）`）照旧认', () => {
      const r = scanHarvestSection('## 回流\n**产物**：x\n**为什么通用（≥2 场景）**：①a ②b\n**落点**：y\n');
      assert.deepEqual(r.missing, [], JSON.stringify(r));
    });
    await t.test('标记行以冒号收尾、值写在下面几行（#901 实例形状）', () => {
      const r = scanHarvestSection('## 回流\n**产物**：x\n**为什么通用（≥2 场景）**：\n1. 场景一\n2. 场景二\n\n**落点**：y\n');
      assert.deepEqual(r.missing, [], JSON.stringify(r));
      assert.match(r.fields['为什么通用'], /场景一/);
    });
    await t.test('换行取值撞到下一个标记就停 → 标记下面是空的，照旧判缺', () => {
      const r = scanHarvestSection('## 回流\n- 产物：\n- 为什么通用：①a ②b\n- 落点：y\n- 已回流：abcdef1\n');
      assert.deepEqual(r.missing, ['产物'], '空标记不许被下一行的值顶上：' + JSON.stringify(r));
    });
    await t.test('段末尾的空标记没有下文 → 判缺', () => {
      const r = scanHarvestSection('## 回流\n- 产物：x\n- 为什么通用：①a ②b\n- 落点：\n');
      assert.deepEqual(r.missing, ['落点'], JSON.stringify(r));
    });
    await t.test('括号限定语不给挤字段开后门（值里再挤别的字段仍不算）', () => {
      const r = scanHarvestSection('## 回流\n产物（说明）：x；为什么通用：①a ②b；落点：y\n');
      assert.deepEqual(r.missing, ['产物', '为什么通用', '落点'], JSON.stringify(r));
    });
  });

  it('行边界负例：格式不合规的段一个都不许判 ok:true（#890 审官 P1）', async (t) => {
    const { scanHarvestSection, judgeHarvest } = await import(LIB);
    const fields3 = '- 产物：x\n- 为什么通用：①a ②b\n- 落点：上收 scripts/lib';

    // N1：`### 回流` + 三行 + 受理。老实现因 `###` 含子串 `##` 判 ok:true。
    // 现在「不认」——无段、不参与判定（照设计页取舍：宁可漏报）。
    await t.test('N1 ### 回流 + 三行 + 受理 → 不认（无段，不参与判定）', () => {
      const body = `### 回流\n${fields3}\n- 已回流：abcdef1\n`;
      const s = scanHarvestSection(body);
      assert.equal(s.has, false, '`### 回流` 不是本协议段：' + JSON.stringify(s));
      assert.equal(s.accepted, false, '不认的段不许认出受理证据');
      const v = judgeHarvest([{ number: 9, body }]);
      assert.deepEqual([...v.thin, ...v.orphans], [], '不认 = 不参与判定：' + JSON.stringify(v));
    });

    await t.test('# 回流 / #### 回流 同样不认（只有二级标题算）', () => {
      for (const h of ['# 回流', '#### 回流']) {
        const s = scanHarvestSection(`${h}\n${fields3}\n- 已回流：abcdef1\n`);
        assert.equal(s.has, false, `${h} 不该被当成合规段：` + JSON.stringify(s));
      }
    });

    // N2：正文行内代码提到 `## 回流` + 三行 + 受理。老实现 indexOf 命中字面量 → ok:true。
    await t.test('N2 行内代码提到 `## 回流` + 三行 + 受理 → 不认', () => {
      const body = '本 PR 讲 `## 回流` 段怎么写\n' + fields3 + '\n- 已回流：abcdef1\n';
      const s = scanHarvestSection(body);
      assert.equal(s.has, false, JSON.stringify(s));
      assert.equal(s.accepted, false, '不许从散句里认出受理证据');
      const v = judgeHarvest([{ number: 9, body }]);
      assert.deepEqual([...v.thin, ...v.orphans], [], JSON.stringify(v));
    });

    await t.test('行内 ## 回流（前面有字）不是独立标题行', () => {
      const s = scanHarvestSection(`blah ## 回流 - 产物：x\n- 为什么通用：①a ②b\n- 落点：y\n- 回流单：#2\n`);
      assert.equal(s.has, false, JSON.stringify(s));
    });

    // N4：正文只散句提及 `## 回流`、没有真段。老实现 has:true 且三行全缺
    // → 同时判 thin + orphan（假阳性红）。现在「不认」，一条都不该出。
    await t.test('N4 只散句提及 ## 回流、没有真段 → 不认（不再误判孤儿红）', () => {
      const body = '本单给 PR 正文加了 ## 回流 段的判定，细节见设计页。\n';
      const s = scanHarvestSection(body);
      assert.equal(s.has, false, JSON.stringify(s));
      const v = judgeHarvest([{ number: 9, body }]);
      assert.ok(v.ok, '散句提及不该判红（老实现在这里假阳性）：' + JSON.stringify(v));
      assert.deepEqual([...v.thin, ...v.orphans], [], JSON.stringify(v));
    });

    // N3：三字段挤成一行 + 受理挤在同一行尾。老实现无锚正则三字段全中 + accepted → ok:true。
    await t.test('N3 三个字段挤成一行 → 三行不全，判红（且受理不算）', () => {
      const body = '## 回流\n产物：x；为什么通用：①a ②b；落点：上收 scripts/lib；已回流：abcdef1\n';
      const s = scanHarvestSection(body);
      assert.ok(s.has, '标题是合规的，段要认出来');
      assert.deepEqual(s.missing, ['产物', '为什么通用', '落点'], '挤一行不算三行体：' + JSON.stringify(s));
      assert.equal(s.accepted, false, '受理证据挤在同一行尾也不算接住：' + JSON.stringify(s));
      const v = judgeHarvest([{ number: 9, body }]);
      assert.ok(!v.ok && v.thin.length === 1 && v.orphans.length === 1, JSON.stringify(v));
    });

    await t.test('受理证据挤在别的字段行尾 → 不算接住（孤儿判红）', () => {
      const body = '## 回流\n- 产物：x\n- 为什么通用：①a ②b\n- 落点：y 顺手提一句 已回流：abcdef1\n';
      const s = scanHarvestSection(body);
      assert.equal(s.accepted, false, '证据必须自己占一行的行首：' + JSON.stringify(s));
      const v = judgeHarvest([{ number: 9, body }]);
      assert.ok(!v.ok && v.orphans.length === 1, JSON.stringify(v));
    });

    await t.test('受理证据挤在同一行的多个字段之间也不算', () => {
      const s = scanHarvestSection('## 回流\n- 产物：x\n- 为什么通用：①a ②b\n- 落点：y\n- 备注：本单 回流单：#5 已开\n');
      assert.equal(s.accepted, false, JSON.stringify(s));
    });

    await t.test('围栏代码块里的示例段不判红（演示模板 ≠ 交回流）', () => {
      const body = '讲用法：\n\n```\n## 回流\n- 产物：x\n- 为什么通用：①a ②b\n- 落点：y\n```\n';
      const s = scanHarvestSection(body);
      assert.equal(s.has, false, JSON.stringify(s));
      const v = judgeHarvest([{ number: 9, body }]);
      assert.ok(v.ok, '示例段不该判红：' + JSON.stringify(v));
    });

    await t.test('围栏里的字段行不顶数（真段在外面才算）', () => {
      const s = scanHarvestSection('## 回流\n- 产物：x\n\n```\n- 为什么通用：①a ②b\n- 落点：y\n```\n');
      assert.deepEqual(s.missing, ['为什么通用', '落点'], JSON.stringify(s));
    });

    await t.test('## 回流历史：换了标题名 = 另一个段，不判红也不当本协议段', () => {
      const v = judgeHarvest([{ number: 9, body: `## 回流历史\n${fields3}\n` }]);
      assert.ok(v.ok, '别名段判红就是假阳性：' + JSON.stringify(v));
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
    await t.test('不回流没写原因 → 不算接住', () => {
      assert.equal(scanHarvestSection(`${full}\n- 不回流：\n`).accepted, false);
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

  it('live 取数覆盖面：摸到上限就 fail-closed（#890 审官 P1）', async (t) => {
    const { judgeHarvestCoverage, harvestLiveArgs, HARVEST_LIVE_LIMIT } = await import(LIB);

    await t.test('取满上限 → 没查成（不许报成全量通过）', () => {
      const r = judgeHarvestCoverage(HARVEST_LIVE_LIMIT);
      assert.ok(!r.ok && r.unscanned && r.saturated, JSON.stringify(r));
      assert.match(r.error, /截断|没查成/);
    });
    await t.test('超过上限（真被截断也当截断）→ 没查成', () => {
      const r = judgeHarvestCoverage(HARVEST_LIVE_LIMIT + 5);
      assert.ok(!r.ok && r.unscanned, JSON.stringify(r));
    });
    await t.test('没摸到上限 → 覆盖面完整', () => {
      const r = judgeHarvestCoverage(HARVEST_LIVE_LIMIT - 1);
      assert.ok(r.ok && !r.unscanned && !r.saturated, JSON.stringify(r));
    });
    await t.test('条数不是非负整数 → 没查成，不是过', () => {
      for (const bad of [null, undefined, -1, 1.5, '30', NaN]) {
        const r = judgeHarvestCoverage(bad);
        assert.ok(!r.ok && r.unscanned, `${String(bad)} 该判没查成：` + JSON.stringify(r));
      }
    });
    await t.test('老上限 30 已装不下现实（2026-09-04 实测近 7 天 40 个 merged PR）', () => {
      assert.ok(judgeHarvestCoverage(30, 30).saturated, '老上限 30 在现实条数下就是取满');
      assert.ok(HARVEST_LIVE_LIMIT > 40, `上限 ${HARVEST_LIVE_LIMIT} 兜不住现实条数`);
      const r = judgeHarvestCoverage(40);
      assert.ok(r.ok, '40 条在上限内该算查全：' + JSON.stringify(r));
    });
    await t.test('取数参数与上限判据共用同一常量（防改了 limit 忘了改校验）', () => {
      const args = harvestLiveArgs('2026-08-28');
      const at = args.indexOf('--limit');
      assert.ok(at >= 0, JSON.stringify(args));
      assert.equal(args[at + 1], String(HARVEST_LIVE_LIMIT));
      assert.ok(args.includes('--search') && args.includes('merged:>=2026-08-28'), JSON.stringify(args));
      assert.ok(args.includes('number,body,mergedAt'), '正文字段必须取，否则全空=没查成');
      // 判据默认值必须跟着同一个常量走：拿 args 里的 limit 反喂判据，必须判截断。
      const r = judgeHarvestCoverage(Number(args[at + 1]));
      assert.ok(r.unscanned && r.saturated, JSON.stringify(r));
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
