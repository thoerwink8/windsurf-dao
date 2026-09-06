// #1052：总控群日报卡。判别：2.0 schema、唯一 Hero、四列 KPI 带 delta、
// 无变化不发、没查成不发假报、状态色必须图标+文字。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const toUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const LIB = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'feishu-daily-card.mjs')));
const PLAIN = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'plain-words.mjs')));

function snap(over = {}) {
  return {
    scanned: true,
    pending: 5,
    openPrs: 17,
    workers: 2,
    conflicts: 4,
    headlines: ['合并 4 张', '卡住 1 处'],
    ...over,
  };
}

describe('shouldSend：没查成 / 无变化 / 首期', () => {
  it('没查成不发', async () => {
    const { shouldSend } = await LIB;
    const r = shouldSend({ scanned: false, error: 'gh 挂了' }, null);
    assert.equal(r.send, false);
    assert.match(r.why, /没查成/);
  });

  it('snapshot 缺 scanned 也不发', async () => {
    const { shouldSend } = await LIB;
    assert.equal(shouldSend({ pending: 0 }, null).send, false);
  });

  it('没有上一期 → 发（首期）', async () => {
    const { shouldSend } = await LIB;
    const r = shouldSend(snap(), null);
    assert.equal(r.send, true);
    assert.equal(r.why, '首期');
  });

  it('数字和本期发生了什么都没变 → 不发', async () => {
    const { shouldSend } = await LIB;
    const a = snap();
    const r = shouldSend(a, { ...a });
    assert.equal(r.send, false);
    assert.match(r.why, /无变化/);
  });

  it('待拍板从 5 变 6 → 发', async () => {
    const { shouldSend } = await LIB;
    const r = shouldSend(snap({ pending: 6 }), snap());
    assert.equal(r.send, true);
  });

  it('headline 变了也算变化', async () => {
    const { shouldSend } = await LIB;
    const r = shouldSend(snap({ headlines: ['新的一条'] }), snap());
    assert.equal(r.send, true);
  });
});

describe('planDailySend：一天只发一张', () => {
  it('今天已经发过 → 不发，哪怕数字变了', async () => {
    const { planDailySend } = await LIB;
    const r = planDailySend({
      snapshot: snap({ pending: 9 }),
      previous: snap(),
      lastSentDay: '2026-09-07',
      today: '2026-09-07',
    });
    assert.equal(r.send, false);
    assert.match(r.why, /已经发过/);
  });

  it('换日且有变化 → 发', async () => {
    const { planDailySend } = await LIB;
    const r = planDailySend({
      snapshot: snap({ pending: 1 }),
      previous: snap(),
      lastSentDay: '2026-09-06',
      today: '2026-09-07',
    });
    assert.equal(r.send, true);
  });
});

describe('buildDailyCard：Card JSON 2.0 结构', () => {
  it('schema 是 2.0，不碰 1.0 elements 根', async () => {
    const { buildDailyCard, DAILY_CARD_SCHEMA } = await LIB;
    const card = buildDailyCard({ day: '2026-09-07', snapshot: snap(), repo: 'thoerwink8/windsurf-dao' });
    assert.equal(DAILY_CARD_SCHEMA, '2.0');
    assert.equal(card.schema, '2.0');
    assert.ok(card.body && Array.isArray(card.body.elements));
    assert.equal(card.elements, undefined);
  });

  it('header 图标+文字+语义色一起出现', async () => {
    const { buildDailyCard } = await LIB;
    const card = buildDailyCard({ day: '2026-09-07', snapshot: snap() });
    assert.equal(card.header.template, 'orange');
    assert.match(card.header.subtitle.content, /🟠/);
    assert.match(card.header.subtitle.content, /要你拍/);
    assert.match(card.header.title.content, /道·日报/);
    assert.match(card.header.title.content, /9 月 7 日/);
  });

  it('卡住时用红色，正常用绿色', async () => {
    const { buildDailyCard } = await LIB;
    const red = buildDailyCard({ day: '2026-09-07', snapshot: snap({ pending: 0, conflicts: 2, stuck: 2, headlines: [] }) });
    assert.equal(red.header.template, 'red');
    assert.match(red.header.subtitle.content, /🔴/);
    const green = buildDailyCard({
      day: '2026-09-07',
      snapshot: snap({ pending: 0, conflicts: 0, stuck: 0, openPrs: 1, workers: 0, headlines: [] }),
    });
    assert.equal(green.header.template, 'green');
    assert.match(green.header.subtitle.content, /🟢/);
  });

  it('唯一 Hero 是待拍板件数；column_set 正好 4 列且每列带 delta', async () => {
    const { buildDailyCard } = await LIB;
    const prev = snap({ pending: 5, openPrs: 15, workers: 5, conflicts: 4 });
    const card = buildDailyCard({ day: '2026-09-07', snapshot: snap(), previous: prev });
    const hero = card.body.elements.find((e) => e.tag === 'markdown' && /待拍板/.test(e.content || ''));
    assert.ok(hero);
    assert.match(hero.content, /\*\*待拍板 5 件\*\*/);
    const sets = card.body.elements.filter((e) => e.tag === 'column_set');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].columns.length, 4);
    const texts = sets[0].columns.map((c) => c.elements[0].content);
    assert.equal(texts.some((t) => t.includes('↑ +2')), true, '开放 PR 15→17 该有 +2');
    assert.equal(texts.some((t) => t.includes('↓ -3')), true, '在跑工人 5→2 该有 -3');
    assert.equal(texts.some((t) => t.includes('持平')), true);
  });

  it('看待拍板按钮走 callback，不是链接', async () => {
    const { buildDailyCard, DAILY_CALLBACK_LIST_PENDING } = await LIB;
    const card = buildDailyCard({ day: '2026-09-07', snapshot: snap() });
    const btn = card.body.elements.find((e) => e.tag === 'button' && e.text && e.text.content === '看待拍板');
    assert.ok(btn);
    assert.equal(btn.behaviors[0].type, 'callback');
    assert.equal(btn.behaviors[0].value.action, DAILY_CALLBACK_LIST_PENDING);
    const link = card.body.elements.find((e) => e.tag === 'button' && e.text && e.text.content === '看全部 PR');
    assert.equal(link.behaviors[0].type, 'open_url');
  });

  it('正文说人话', async () => {
    const { buildDailyCard } = await LIB;
    const { plainViolations } = await PLAIN;
    const card = buildDailyCard({ day: '2026-09-07', snapshot: snap(), nowLabel: '19:12' });
    const blobs = [
      card.header.title.content,
      card.header.subtitle.content,
      ...card.body.elements.flatMap((e) => {
        if (e.content) return [e.content];
        if (e.elements) return e.elements.map((x) => x.content).filter(Boolean);
        if (e.columns) return e.columns.flatMap((c) => (c.elements || []).map((x) => x.content));
        if (e.text) return [e.text.content];
        return [];
      }),
    ].join('\n');
    assert.deepEqual(plainViolations(blobs), []);
  });
});

describe('delta / headlines', () => {
  it('没有上一期写首期', async () => {
    const { deltaText } = await LIB;
    assert.equal(deltaText(5, null), '首期');
  });

  it('队列条目用人话来源，最多 5 行外加一条折叠', async () => {
    const { headlinesFromQueue } = await LIB;
    const items = [
      { source: 'heartbeat', text: '连续 7 天静默' },
      { source: 'breaker', text: '全部路径开着' },
      { source: 'stall', text: '有人卡住' },
      { source: 'release', text: '发了一版' },
      { source: 'commander', text: '派了一单' },
      { source: 'misc', text: '第六条' },
    ];
    const lines = headlinesFromQueue(items, 5);
    assert.equal(lines[0], '心跳：连续 7 天静默');
    assert.equal(lines.length, 6);
    assert.match(lines[5], /另有 1 条/);
  });
});
