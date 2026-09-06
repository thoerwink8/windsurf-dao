// tests/cause-slug.test.js —— 「同一起因只许一张 OPEN 单」判据（#1063 ②）
//
// 违规样本先行：下面第一条就是 issue #1063 验收要的那个场景——两张带同一 `起因：` 的单，
// 检查必须红并**点名两张**；改掉一张后转绿。跑得过这两条，这道闸才算生效。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LIB = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'cause-slug-check.mjs').replace(/\\/g, '/'));

// 默认造在规矩生效之后（立规是 2026-09-06 19:46，commit c8bc759b）。
const 机器单 = (number, body, createdAt = '2026-09-07T00:00:00Z') => ({ number, body, createdAt, author: { login: 'app/dao-marshal' } });
const 用户单 = (number, body) => ({ number, body, createdAt: '2026-09-07T00:00:00Z', author: { login: 'thoerwink8' } });

describe('故意违规样本：同一起因两张单', () => {
  it('两张同 slug → 红，且点名两张', async () => {
    const { inspectCauseSlugs } = await LIB;
    const got = inspectCauseSlugs({
      issues: [机器单(101, '起因：escalate-noise\n\n正文'), 机器单(102, '起因：escalate-noise\n\n正文')],
    });
    assert.equal(got.kind, 'red');
    assert.deepEqual(got.dupes, [{ slug: 'escalate-noise', issues: [101, 102] }]);
    assert.match(got.line, /#101 #102/);
    assert.match(got.line, /合成一张/);
  });

  it('改掉一张 → 转绿（闸能开也能关，不是永远红）', async () => {
    const { inspectCauseSlugs } = await LIB;
    const got = inspectCauseSlugs({
      issues: [机器单(101, '起因：escalate-noise\n\n正文'), 机器单(102, '起因：另一件事\n\n正文')],
    });
    assert.equal(got.kind, 'ok');
  });
});

describe('缺「起因：」首行', () => {
  it('机器/帅位开的单缺起因行 → 红并点名', async () => {
    const { inspectCauseSlugs } = await LIB;
    const got = inspectCauseSlugs({ issues: [机器单(200, '没有起因行\n\n正文')] });
    assert.equal(got.kind, 'red');
    assert.deepEqual(got.missing, [200]);
  });

  it('用户本人开的单不纳入（规矩管的是机器与帅位）', async () => {
    const { inspectCauseSlugs } = await LIB;
    const got = inspectCauseSlugs({ issues: [用户单(201, '我随手记一笔')] });
    assert.equal(got.kind, 'ok');
    assert.equal(got.scanned, 0);
  });

  // 只认首行：写在正文中间不算。放宽到「正文里出现过」就没法机器判——
  // 引用别的单的起因、贴一段日志，都会被当成本单的起因。
  it('起因写在中间不算', async () => {
    const { inspectCauseSlugs } = await LIB;
    const got = inspectCauseSlugs({ issues: [机器单(202, '先说两句\n起因：x\n')] });
    assert.deepEqual(got.missing, [202]);
  });
});

// 立规当天盘面上有 23 张老单缺这行。追溯判红 = 这道检查永远红，而永远红的检查等于
// 没有检查（判例 downgrading-false-alarm-can-disable-the-guard）。所以规矩有生效起点。
describe('生效起点：不追溯立规之前的老单', () => {
  it('立规之前开的单缺起因行 → 不判红', async () => {
    const { inspectCauseSlugs } = await LIB;
    const got = inspectCauseSlugs({ issues: [机器单(300, '老单没有起因行', '2026-09-01T00:00:00Z')] });
    assert.equal(got.kind, 'ok');
  });

  it('立规之后开的单缺起因行 → 照旧判红', async () => {
    const { inspectCauseSlugs } = await LIB;
    const got = inspectCauseSlugs({ issues: [机器单(301, '新单没有起因行', '2026-09-07T00:00:00Z')] });
    assert.equal(got.kind, 'red');
  });

  // 重复 slug 不受起点限制：两张单撞同一个起因，跟它们多老没关系。
  it('老单之间同 slug 重复 → 照旧判红', async () => {
    const { inspectCauseSlugs } = await LIB;
    const got = inspectCauseSlugs({
      issues: [
        机器单(302, '起因：x\n', '2026-08-01T00:00:00Z'),
        机器单(303, '起因：x\n', '2026-08-02T00:00:00Z'),
      ],
    });
    assert.equal(got.kind, 'red');
    assert.deepEqual(got.dupes, [{ slug: 'x', issues: [302, 303] }]);
  });

  // 少一个字段就静默失效，是本仓最常见的闸失效方式。
  it('缺 createdAt → 没查成，不许当成老单放过', async () => {
    const { inspectCauseSlugs } = await LIB;
    const got = inspectCauseSlugs({ issues: [{ number: 304, body: '没起因行', author: { login: 'app/x' } }] });
    assert.equal(got.kind, 'unscanned');
  });
});

describe('三态分得开：绿 / 红 / 没查成', () => {
  it('扫完 0 张机器单 = 绿，且判词说清是「扫完」', async () => {
    const { inspectCauseSlugs } = await LIB;
    const got = inspectCauseSlugs({ issues: [] });
    assert.equal(got.kind, 'ok');
    assert.match(got.line, /扫完是 0 不是没查成/);
  });

  it('issues 不是数组 = 没查成，不是绿', async () => {
    const { inspectCauseSlugs } = await LIB;
    assert.equal(inspectCauseSlugs({}).kind, 'unscanned');
    assert.equal(inspectCauseSlugs({ issues: null }).kind, 'unscanned');
  });

  // 取数面少了 author，就分不出机器单和用户单。这时候必须判没查成——
  // 当成「都是用户的单」放过去，等于这道闸悄悄失效。
  it('缺 author / body 字段 = 没查成', async () => {
    const { inspectCauseSlugs } = await LIB;
    assert.equal(inspectCauseSlugs({ issues: [{ number: 1, body: 'x' }] }).kind, 'unscanned');
    assert.equal(inspectCauseSlugs({ issues: [{ number: 1, author: { login: 'app/x' } }] }).kind, 'unscanned');
  });

  it('作者读不出 = 没查成（不许当成用户的单放过）', async () => {
    const { inspectCauseSlugs } = await LIB;
    assert.equal(inspectCauseSlugs({ issues: [{ number: 1, body: 'x', author: {} }] }).kind, 'unscanned');
  });
});

describe('接线：dao-check 真的取了 author 并调了判据', () => {
  const fs = require('node:fs');
  const src = () => fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dao-check.mjs'), 'utf8');

  it('issue list 取了 author 字段（少它这道闸只能判没查成）', () => {
    assert.match(src(), /'number,title,body,labels,author,createdAt'/);
  });

  it('全量档调 checkCauseSlugLive，快档明说跳过', () => {
    const s = src();
    assert.match(s, /checkCauseSlugLive\(openBoard\)/);
    assert.match(s, /netParked\('同一起因只许一张 OPEN 单'/);
  });
});
