// scripts/lib/pending-disambiguation.mjs —— 「待消歧」的拦与浮（#876，用户 2026-09-04 拍板）
//
// 改这段前必须知道：拦与浮是一件事的两半——拦住不派，是为了让它在**到时机**时被主动端上来，
// 而不是落了盘就当可做（2026-09-04 实咬：#818 看板被写成「收尾后马上开做」）。
//   拦：带「待消歧」label 的单禁止派工。真拦点两处——
//       派工侧 scripts/lib/dispatch/card.mjs 的 checkIssueDisambiguated（拒派，故意双标也拒）；
//       指挥官侧 scripts/lib/commander-core.mjs 的 collectCandidates（静默跳过，不天天刷屏）。
//   浮：单里写一行「时机：#N 关闭后」；#N 真关了 → 指挥官盘点提醒一条「到讨论时机了」，只提醒不派工。
// 三态铁律：时机行缺失 / #N 状态读不到 = 没查成——不提醒，也不报错刷屏（与「查过没事」分开形）。

import { threeLines } from './plain-words.mjs';

export const PENDING_LABEL = '待消歧';

// 时机行：「时机：#863 关闭后」。认全/半角冒号与空格；只取单号，后半句留给人读。
const TIMING_RE = /时机\s*[:：]\s*#\s*(\d+)/g;

function labelNameOf(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && typeof item.name === 'string') return item.name;
  return '';
}

/** 这张单带不带「待消歧」标。labels 不是数组时只答 false——「没查成」由调用方自己 fail-closed。 */
export function hasPendingLabel(labels) {
  if (!Array.isArray(labels)) return false;
  return labels.map(labelNameOf).includes(PENDING_LABEL);
}

/**
 * 从正文 + 评论里读时机行。入参可以是一段文本或一串文本（正文在前、评论按时间序在后）。
 * 取**最后一处**——后写的评论覆盖早先的说法。一处都没有 = 时机行缺失（found:false），不是「引用 0 号单」。
 */
export function parseTimingRef(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  let last = null;
  for (const t of list) {
    const re = new RegExp(TIMING_RE.source, 'g');
    let m;
    while ((m = re.exec(String(t || '')))) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0) last = n;
    }
  }
  return last == null ? { found: false, issue: null } : { found: true, issue: last };
}

/**
 * 一张待消歧单该不该端上来：
 *   due     —— 时机行有、它引用的单已关：到讨论时机了
 *   not-yet —— 引用的单还开着：不提醒
 *   unknown —— 时机行缺失，或引用单状态没查成：不提醒也不报错（只进盘点日志）
 */
export function assessSurfacing({ issue, title, timingRef, blockerState } = {}) {
  const base = { issue: issue ?? null, title: title || '', ref: timingRef ?? null };
  if (timingRef == null) {
    return { ...base, state: 'unknown', why: '单里没写「时机：#N 关闭后」，判不出到没到时机（没查成）' };
  }
  const st = String(blockerState || '').toUpperCase();
  if (st === 'CLOSED') return { ...base, state: 'due', why: `等的 #${timingRef} 已经关了` };
  if (st === 'OPEN') return { ...base, state: 'not-yet', why: `等的 #${timingRef} 还开着` };
  return { ...base, state: 'unknown', why: `等的 #${timingRef} 是开是关没查成` };
}

/** 一批单 → 三堆。入参不是数组 = 没查成（scanned:false），不许当「一个都没有」。 */
export function collectSurfacing(items) {
  if (!Array.isArray(items)) return { scanned: false, due: [], notYet: [], unknown: [] };
  const due = [];
  const notYet = [];
  const unknown = [];
  for (const it of items) {
    const v = assessSurfacing(it || {});
    if (v.state === 'due') due.push(v);
    else if (v.state === 'not-yet') notYet.push(v);
    else unknown.push(v);
  }
  due.sort((a, b) => Number(a.issue) - Number(b.issue));
  return { scanned: true, due, notYet, unknown };
}

/** 去重键：到时机的单集合。集合没变，6 小时内不重复说（hubOnce 兜）。 */
export function surfacingDedupKey(due = []) {
  return `surface:${due.map((d) => d.issue).sort((a, b) => Number(a) - Number(b)).join('+')}`;
}

/** 提醒文案（说人话、三行体；只提醒不派工）。一条不编号，多条编号。 */
export function buildSurfacingHubText(due = []) {
  const items = due.map((d) => threeLines({
    what: `#${d.issue}${d.title ? '「' + d.title + '」' : ''}到讨论时机了——${d.why}`,
    impact: '在你拍板怎么做之前，它不会被派出去干',
    plan: '等你拍怎么消歧：让我拷问你（grill-me）、出盲设计题，或者直接聊',
  }));
  const head = `有 ${due.length} 件先前搁置的事到讨论时机了：`;
  if (due.length === 1) return `${head}\n${items[0]}`;
  return [head, ...items.map((t, i) => `${i + 1}）${t.replace(/\n/g, '\n   ')}`)].join('\n');
}
