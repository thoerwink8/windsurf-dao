// #1052：总控群日报卡。判别：2.0 schema、唯一 Hero、四列 KPI 带 delta、
// 无变化不发、没查成不发假报、状态色必须图标+文字。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const toUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const LIB = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'feishu-daily-card.mjs')));
const PLAIN = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'plain-words.mjs')));
const HUB_CARD = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'feishu-hub-card.mjs')));
const ADAPTER = import(toUrl(path.join(ROOT, 'scripts', 'feishu-triage.mjs')));

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

function flattenCardText(card) {
  const out = [];
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (typeof n.content === 'string') out.push(n.content);
    if (Array.isArray(n)) {
      for (const x of n) visit(x);
      return;
    }
    for (const v of Object.values(n)) visit(v);
  };
  visit(card);
  return out.join('\n');
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

  it('上期有头条、这期队列空且数字没变 → 不发空报', async () => {
    const { shouldSend, planDailySend } = await LIB;
    const prev = snap({ headlines: ['心跳：连续 7 天静默'] });
    const curr = snap({ headlines: [] });
    const r = shouldSend(curr, prev);
    assert.equal(r.send, false);
    assert.match(r.why, /无变化/);
    const planned = planDailySend({
      snapshot: curr,
      previous: prev,
      lastSentDay: '2026-09-06',
      today: '2026-09-07',
    });
    assert.equal(planned.send, false);
  });

  it('队列空但待拍板数字变了 → 仍发', async () => {
    const { shouldSend } = await LIB;
    const r = shouldSend(snap({ headlines: [], pending: 1 }), snap({ headlines: ['旧头条'], pending: 5 }));
    assert.equal(r.send, true);
    assert.equal(r.why, '有变化');
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
    assert.ok(card.body);
    assert.equal(Array.isArray(card.body.elements), true);
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
    const blobs = flattenCardText(card);
    assert.match(blobs, /待拍板 5 件/);
    assert.match(blobs, /这是今天唯一需要你动手的东西/);
    const sets = [];
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.tag === 'column_set') sets.push(n);
      if (Array.isArray(n)) { for (const x of n) visit(x); return; }
      for (const v of Object.values(n)) visit(v);
    };
    visit(card);
    const kpi = sets.find((s) => s.columns && s.columns.length === 4);
    assert.equal(kpi != null, true);
    assert.equal(kpi.columns.length, 4);
    const texts = kpi.columns.map((c) => (c.elements || []).map((e) => e.content).join('\n'));
    assert.equal(texts.some((t) => t.includes('↑ 上一期 +2')), true, '开放 PR 15→17 该有 +2');
    assert.equal(texts.some((t) => t.includes('↓ 上一期 -3')), true, '在跑工人 5→2 该有 -3');
    assert.equal(texts.some((t) => t.includes('持平 · 上一期')), true);
    for (const set of sets) {
      assert.equal(set.columns.length <= 4, true, `列数 ${set.columns.length} 超过 4`);
    }
  });

  it('两个按钮都走 callback，不走链接', async () => {
    const { buildDailyCard, DAILY_CALLBACK_LIST_PENDING, DAILY_CALLBACK_LIST_PRS, DAILY_KIND } = await LIB;
    const card = buildDailyCard({ day: '2026-09-07', snapshot: snap() });
    const btns = [];
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.tag === 'button') btns.push(n);
      if (Array.isArray(n)) { for (const x of n) visit(x); return; }
      for (const v of Object.values(n)) visit(v);
    };
    visit(card);
    assert.equal(btns.length, 2);
    assert.equal(btns[0].text.content, '看待拍板');
    assert.equal(btns[1].text.content, '看全部 PR');
    for (const b of btns) {
      assert.equal(b.behaviors[0].type, 'callback');
      assert.equal(b.value.kind, DAILY_KIND);
      assert.equal(b.url, undefined);
      assert.equal(b.behaviors[0].value.action, b.value.action);
    }
    assert.equal(btns[0].value.action, DAILY_CALLBACK_LIST_PENDING);
    assert.equal(btns[1].value.action, DAILY_CALLBACK_LIST_PRS);
    assert.equal(btns[0].type, 'primary_filled');
    assert.equal(Object.prototype.hasOwnProperty.call(card, 'template_id'), false);
  });

  it('正文说人话', async () => {
    const { buildDailyCard } = await LIB;
    const { plainViolations } = await PLAIN;
    const card = buildDailyCard({ day: '2026-09-07', snapshot: snap(), nowLabel: '19:12' });
    assert.deepEqual(plainViolations(flattenCardText(card)), []);
  });

  it('脚注在，但不许用 1.0 的 note（飞书 200861：schema V2 unsupported tag note）', async () => {
    const { buildDailyCard } = await LIB;
    const card = buildDailyCard({ day: '2026-09-07', snapshot: snap(), nowLabel: '19:12' });
    const tags = [];
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (typeof n.tag === 'string') tags.push(n.tag);
      if (Array.isArray(n)) { for (const x of n) visit(x); return; }
      for (const v of Object.values(n)) visit(v);
    };
    visit(card);
    assert.equal(tags.includes('note'), false);
    assert.equal(tags.includes('chart'), false);
    const text = flattenCardText(card);
    assert.match(text, /数据截止 · 19:12 · 只在有变化时推送/);
    const footnotes = [];
    const visitNote = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.tag === 'markdown' && typeof n.content === 'string' && n.content.includes('只在有变化时推送')) footnotes.push(n);
      if (Array.isArray(n)) { for (const x of n) visitNote(x); return; }
      for (const v of Object.values(n)) visitNote(v);
    };
    visitNote(card);
    assert.equal(footnotes.length, 1);
    assert.equal(footnotes[0].text_size, 'notation');
  });

  it('空事项不把存量当新闻；schema 2.0 用 width_mode 不用 1.0 的 wide_screen_mode', async () => {
    const { buildDailyCard } = await LIB;
    const card = buildDailyCard({
      day: '2026-09-07',
      snapshot: snap({ headlines: [] }),
    });
    const text = flattenCardText(card);
    assert.match(text, /数字有变，没有新的具体事项/);
    assert.equal(text.includes('这一期没有新事'), false);
    assert.equal(card.config.width_mode, 'default');
    assert.equal(card.config.wide_screen_mode, undefined);
    assert.equal(card.body.direction, 'vertical');
  });
});

describe('delta / headlines', () => {
  it('没有上一期写首期；有变化写对比哪一期', async () => {
    const { deltaText } = await LIB;
    assert.equal(deltaText(5, null), '首期');
    assert.equal(deltaText(5, 3), '↑ 上一期 +2');
    assert.equal(deltaText(1, 4), '↓ 上一期 -3');
    assert.equal(deltaText(2, 2), '持平 · 上一期');
    assert.equal(deltaText(null, 1), '没查成');
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

function dailyEvent({ action = 'list_pending', pending = 5, openPrs = 17 } = {}) {
  return {
    schema: '2.0',
    header: { event_type: 'card.action.trigger', event_id: 'e-daily' },
    event: {
      operator: { open_id: 'ou_user1', user_name: '老板' },
      action: { tag: 'button', value: { kind: 'daily', action, pending, openPrs } },
      context: { open_message_id: 'om_daily_1', open_chat_id: 'oc_hub' },
      token: 'tok_d',
    },
  };
}

describe('待拍板卡仍是 Card 1.0：本单不许顺手重写', () => {
  it('buildHubCard 没有 schema 2.0', async () => {
    const H = await HUB_CARD;
    const card = H.buildHubCard({ repo: 'thoerwink8/windsurf-dao', number: 1052, title: '日报卡' });
    assert.equal(card.schema, undefined);
    assert.equal(Array.isArray(card.elements), true);
    assert.equal(card.body, undefined);
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'feishu-hub-card.mjs'), 'utf8');
    assert.match(src, /Card 1\.0/);
    assert.equal(src.includes("schema: '2.0'"), false);
  });
});

describe('日报卡按钮回传不改待拍板路径', () => {
  it('点看待拍板：toast 一句、不换卡、不写 GitHub', async () => {
    const M = await ADAPTER;
    const comments = [];
    const store = { hubPending: {}, save() { store.saved = true; } };
    const res = await M.handleCardAction(dailyEvent(), {
      store,
      deps: { now: () => Date.now(), ghComment: async (...a) => comments.push(a) },
    });
    assert.equal(res.response.kind, 'daily');
    assert.equal(res.ack.toast.type, 'info');
    assert.match(res.ack.toast.content, /待拍板 5 件/);
    assert.equal(res.ack.card, undefined);
    assert.equal(res.actions.length, 0);
    assert.equal(comments.length, 0);
    assert.equal(store.hubPending.om_daily_1, undefined);
  });

  it('live 回包 3 秒内只 toast，不把日报卡换成空待拍板卡', async () => {
    const M = await ADAPTER;
    const comments = [];
    const deferred = [];
    const ack = await M.liveCardAction(dailyEvent({ action: 'list_prs', openPrs: 17 }), {
      store: { hubPending: {}, save() {} },
      deps: { now: () => Date.now(), ghComment: async (...a) => comments.push(a) },
      client: { sendText: async () => { throw new Error('回包路径不该发网'); } },
      defer: (fn) => deferred.push(fn),
    });
    assert.equal(ack.toast.type, 'info');
    assert.match(ack.toast.content, /开放 PR 17/);
    assert.equal(ack.card, undefined);
    assert.equal(comments.length, 0);
    assert.equal(deferred.length, 1);
  });

  it('待拍板卡回传仍走原路径（对照：本单没把两张卡搅在一起）', async () => {
    const M = await ADAPTER;
    const comments = [];
    const store = {
      hubPending: { om_card_1: { repo: 'thoerwink8/windsurf-dao', number: 846, title: '盘点' } },
      save() {},
    };
    const res = await M.handleEvent({
      schema: '2.0',
      header: { event_type: 'card.action.trigger', event_id: 'e-card' },
      event: {
        operator: { open_id: 'ou_user1', user_name: '老板' },
        action: { tag: 'button', value: { issue: '846', choice: 'recommend', repo: 'thoerwink8/windsurf-dao' } },
        context: { open_message_id: 'om_card_1', open_chat_id: 'oc_hub' },
      },
    }, {
      groups: {}, store,
      deps: { now: () => Date.now(), ghComment: async (...a) => comments.push(a) },
      triage: async () => { throw new Error('不该走消息 triage'); },
      client: null,
    });
    assert.equal(res.cardKind, 'ok');
    assert.equal(res.cardAck.card.type, 'raw');
    assert.match(res.cardAck.card.data.header.title.content, /已拍/);
    assert.equal(comments.length, 1);
  });
});
