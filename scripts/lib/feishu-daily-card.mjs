// scripts/lib/feishu-daily-card.mjs —— 总控群「日报卡」（#1052）
//
// Card JSON 2.0。不改 buildHubCard（待拍板卡仍是 1.0）。
// 纯函数：不读时钟、不发网。上一期 snapshot 由调用方传入。
// 与上一期完全无变化 ⇒ shouldSend=false，不发「今日无事」。

import { createHash } from 'node:crypto';
import { ensurePlain } from './plain-words.mjs';

export const DAILY_CARD_SCHEMA = '2.0';
export const DAILY_CALLBACK_LIST_PENDING = 'list_pending';
export const SOURCE_LABELS = {
  heartbeat: '心跳',
  breaker: '熔断',
  stall: '卡住',
  release: '发布',
  commander: '指挥官',
  'board-gc': '清卡',
  inventory: '盘点',
  hub: '总控',
  misc: '',
};

function str(v) {
  return v == null ? '' : String(v).trim();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function formatDayTitle(day) {
  const s = str(day);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s || '今日';
  return `${Number(m[2])} 月 ${Number(m[3])} 日`;
}

export function deltaText(curr, prev) {
  if (prev == null || !Number.isFinite(Number(prev))) return '首期';
  const d = Number(curr) - Number(prev);
  if (d === 0) return '持平';
  if (d > 0) return `↑ +${d}`;
  return `↓ ${d}`;
}

export function toneOf({ pending, stuck } = {}) {
  if (Number(pending) > 0) {
    const n = Number(pending);
    return { template: 'orange', icon: '🟠', status: `有 ${n} 件要你拍` };
  }
  if (Number(stuck) > 0) {
    return { template: 'red', icon: '🔴', status: '有东西卡住' };
  }
  return { template: 'green', icon: '🟢', status: '一切正常' };
}

export function headlineOf(item) {
  if (!item) return '';
  const text = str(item.text);
  if (!text) return '';
  const src = SOURCE_LABELS[item.source] ?? str(item.source);
  return src ? `${src}：${text}` : text;
}

export function headlinesFromQueue(items, limit = 5) {
  const list = Array.isArray(items) ? items : [];
  const lines = [];
  for (const it of list) {
    const line = headlineOf(it);
    if (line) lines.push(line);
  }
  const extra = lines.length > limit ? lines.length - limit : 0;
  const shown = lines.slice(0, limit);
  if (extra > 0) shown.push(`另有 ${extra} 条，详情在 GitHub`);
  return shown;
}

export function snapshotDigest(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const body = {
    pending: s.pending ?? null,
    openPrs: s.openPrs ?? null,
    workers: s.workers ?? null,
    conflicts: s.conflicts ?? null,
    headlines: Array.isArray(s.headlines) ? s.headlines : [],
  };
  return createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex').slice(0, 16);
}

function kpiOnly(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return {
    pending: s.pending ?? null,
    openPrs: s.openPrs ?? null,
    workers: s.workers ?? null,
    conflicts: s.conflicts ?? null,
    headlines: [],
  };
}

function hasHeadlines(snapshot) {
  const list = snapshot && Array.isArray(snapshot.headlines) ? snapshot.headlines : [];
  return list.some((h) => str(h));
}

/**
 * 没查成不发（不许印一张全是 0 的假报）。
 * 上一期没有 → 发（首期）。
 * digest 相同 → 不发。
 * 本期队列空、数字也没变 → 不发「这一期没有新事」的空报
 * （发过之后队列会被清空，跨日不能把「头条消失」当成新闻）。
 */
export function shouldSend(curr, prev) {
  if (!curr || curr.scanned !== true) {
    return { send: false, why: '没查成，不发假报' };
  }
  if (!prev) return { send: true, why: '首期' };
  const currForDigest = hasHeadlines(curr) ? curr : kpiOnly(curr);
  const prevForDigest = hasHeadlines(curr) ? prev : kpiOnly(prev);
  const a = snapshotDigest(currForDigest);
  const b = snapshotDigest(prevForDigest);
  if (a === b) return { send: false, why: '与上一期无变化' };
  return { send: true, why: '有变化' };
}

export function planDailySend({ snapshot, previous, lastSentDay, today } = {}) {
  const day = str(today);
  if (str(lastSentDay) && day && str(lastSentDay) === day) {
    return { send: false, why: '今天已经发过', snapshot: snapshot || null };
  }
  const verdict = shouldSend(snapshot, previous);
  return { ...verdict, snapshot: snapshot || null };
}

function kpiColumn(label, value, delta) {
  const shown = value == null ? '没查成' : String(value);
  const md = `**${label}**\n${shown}\n${delta}`;
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    vertical_align: 'top',
    elements: [{ tag: 'markdown', content: ensurePlain(md, 'feishu-daily-card/kpi') }],
  };
}

function callbackButton(label, action, type) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    width: 'default',
    behaviors: [{ type: 'callback', value: { action } }],
  };
}

function linkButton(label, url) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: 'default',
    width: 'default',
    behaviors: [{ type: 'open_url', default_url: url }],
  };
}

/**
 * 构造 Card JSON 2.0。调用方保证 snapshot.scanned === true 才发。
 */
export function buildDailyCard({
  day, nowLabel, snapshot = {}, previous = null, repo = '',
} = {}) {
  const pending = num(snapshot.pending);
  const openPrs = num(snapshot.openPrs);
  const workers = num(snapshot.workers);
  const conflicts = num(snapshot.conflicts);
  const stuck = Number(snapshot.stuck) > 0 ? Number(snapshot.stuck) : (conflicts > 0 ? conflicts : 0);
  const tone = toneOf({ pending: pending || 0, stuck });
  const heroN = pending == null ? '没查成' : String(pending);
  const heroHint = pending > 0
    ? '这是今天唯一需要你动手的东西'
    : '今天没有要你拍的';
  const headlines = Array.isArray(snapshot.headlines) ? snapshot.headlines.filter(Boolean).slice(0, 6) : [];
  const happened = headlines.length
    ? headlines.map((h) => `- ${h}`).join('\n')
    : '- 这一期没有新事';
  const prUrl = str(repo) ? `https://github.com/${str(repo)}/pulls` : 'https://github.com/thoerwink8/windsurf-dao/pulls';
  const note = ['数据截止', str(nowLabel) || str(day), '只在有变化时推送'].filter(Boolean).join(' · ');

  const elements = [
    {
      tag: 'markdown',
      content: ensurePlain(`**待拍板 ${heroN} 件**\n${heroHint}`, 'feishu-daily-card/hero'),
    },
    { tag: 'hr' },
    {
      tag: 'column_set',
      flex_mode: 'bisect',
      background_style: 'grey',
      horizontal_spacing: '8px',
      columns: [
        kpiColumn('开放 PR', openPrs, deltaText(openPrs, previous && previous.openPrs)),
        kpiColumn('待拍板', pending, deltaText(pending, previous && previous.pending)),
        kpiColumn('在跑工人', workers, deltaText(workers, previous && previous.workers)),
        kpiColumn('冲突 PR', conflicts, deltaText(conflicts, previous && previous.conflicts)),
      ],
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: ensurePlain(`**本期发生了什么**\n${happened}`, 'feishu-daily-card/happened'),
    },
    {
      tag: 'note',
      elements: [{ tag: 'plain_text', content: ensurePlain(note, 'feishu-daily-card/note') }],
    },
    callbackButton('看待拍板', DAILY_CALLBACK_LIST_PENDING, 'primary'),
    linkButton('看全部 PR', prUrl),
  ];

  return {
    schema: DAILY_CARD_SCHEMA,
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `道·日报 · ${formatDayTitle(day)}` },
      subtitle: { tag: 'plain_text', content: `${tone.icon} ${tone.status}` },
      template: tone.template,
      icon: { tag: 'standard_icon', token: 'newspaper_outlined' },
    },
    body: { elements },
  };
}

export function isDailyListPending(value) {
  const v = value && typeof value === 'object' ? value : {};
  return str(v.action) === DAILY_CALLBACK_LIST_PENDING;
}
