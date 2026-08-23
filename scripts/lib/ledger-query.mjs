// scripts/lib/ledger-query.mjs —— 账本查询（#588 追加）
//
// 把「人要记住怎么查才不出错」封进命令：按事件 ts 排序，不按文件 mtime；
// 按 job_id / pr_number / issue 字段匹配，不 grep 数字（会命中 event_id）。
// 检查器自己 JSON.parse，不走 event-writer。
//
// 三态：查到 N 条 / 查到 0 条 / 没查成（目录不在或有文件不是 JSON）。

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function eventSortKey(e) {
  return [
    String((e && e.ts) || ''),
    String((e && e.machine) || ''),
    Number.isInteger(e && e.seq) ? e.seq : 0,
    String((e && e.event_id) || ''),
  ];
}

export function compareEvents(a, b) {
  const ka = eventSortKey(a);
  const kb = eventSortKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

export function readLedgerEvents(dir) {
  if (!dir || !existsSync(dir)) {
    return { unscanned: true, error: `账本目录不在：${dir}`, events: [] };
  }
  let names;
  try {
    names = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch (e) {
    return { unscanned: true, error: `账本目录读不了：${String(e.message || e).slice(0, 120)}`, events: [] };
  }
  const events = [];
  const bad = [];
  for (const name of names) {
    try {
      const e = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (!e || typeof e !== 'object') {
        bad.push(`${name}: 不是对象`);
        continue;
      }
      events.push(e);
    } catch (err) {
      bad.push(`${name}: ${String(err.message || err).slice(0, 80)}`);
    }
  }
  if (bad.length) {
    return {
      unscanned: true,
      error: `${bad.length} 个事件不是 JSON（${bad.slice(0, 3).join('；')}）`,
      events,
    };
  }
  events.sort(compareEvents);
  return { unscanned: false, events };
}

export function matchesIssue(event, issue) {
  const n = Number(issue);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (Number(event.pr_number) === n) return true;
  if (Number(event.issue) === n || Number(event.issue_number) === n) return true;
  const id = String(event.job_id || '');
  return id === `gh-pr-${n}` || id === `gh-pr-${n}-review`;
}

/** 派工去重窗口（2026-08-23 delete-all-ceremony 拍板）：10 分钟内同 issue 连发 = 重复建卡（#759）。 */
export const DISPATCH_DEDUP_WINDOW_MS = 10 * 60 * 1000;

// ── 派工去重索引（2026-08-23 async-launch 拍板）────────────────────
//
// 事前查重不再全量读账本（441+ 个事件文件逐次派工全读一遍）。换单文件索引：
// 事件文件名以 ts 开头、字典序即时间序，索引记下「扫到哪个文件（watermark）+ 扫出的
// 派工类事实」，下次只增量解析新文件（外加 mtime 晚于索引建成时刻的迟到文件，防
// 别台机器钟漂/回填落下的旧名文件）。索引只是缓存：不在/损坏 → 全量扫一次重建；
// 结果与全量扫等价（去重只认 10 分钟窗，索引保留 retainMs 内的 dispatch 与
// 对应 closed/handoff 事实，裁剪更老的）。
// 索引文件名不带 .json 后缀：readLedgerEvents / event-writer 的 dirIndex 只扫 .json，
// 互不干扰。

export const DISPATCH_INDEX_NAME = '.dispatch-index';
export const DISPATCH_INDEX_VERSION = 1;
/** 索引里 dispatch 事实的保留窗（远大于 10 分钟去重窗，钟漂余量）。 */
export const DISPATCH_INDEX_RETAIN_MS = 6 * 60 * 60 * 1000;

export function dispatchIndexPath(dir) {
  return join(dir, DISPATCH_INDEX_NAME);
}

function loadDispatchIndex(dir) {
  const p = dispatchIndexPath(dir);
  if (!existsSync(p)) return null;
  try {
    const idx = JSON.parse(readFileSync(p, 'utf8'));
    if (!idx || idx.v !== DISPATCH_INDEX_VERSION) return null;
    if (!Array.isArray(idx.dispatches) || !Array.isArray(idx.closedIds) || !Array.isArray(idx.handoffs)) return null;
    if (typeof idx.watermark !== 'string' || !Number.isFinite(idx.builtAt)) return null;
    return idx;
  } catch {
    return null; // 损坏 = 没有索引，全量重建（缓存不许变成新的故障源）
  }
}

function eventDedupKey(e) {
  if (e && e.event_id) return `id:${e.event_id}`;
  return `raw:${JSON.stringify(e)}`;
}

/**
 * 索引增量读「派工去重够用的」事件集：retainMs 内的 job.dispatch 全文 +
 * 对应 job.closed / job.handoff(rename) 事实（合成事件形态，recentDispatchDup 直接可用）。
 * 返回与 readLedgerEvents 同态的 { unscanned, events, error? }，外加索引命中信息。
 * 新解析的文件里有坏 JSON → unscanned（与全量读同纪律：查不成不拦路，但显形）。
 */
export function readDispatchEventsIndexed(dir, { now, retainMs = DISPATCH_INDEX_RETAIN_MS } = {}) {
  if (!dir || !existsSync(dir)) {
    return { unscanned: true, error: `账本目录不在：${dir}`, events: [] };
  }
  const nowMs = now == null ? Date.now() : (now instanceof Date ? now.getTime() : Date.parse(now));
  if (!Number.isFinite(nowMs)) {
    return { unscanned: true, error: `now 非法（没查成）: ${now}`, events: [] };
  }
  let names;
  try {
    names = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  } catch (e) {
    return { unscanned: true, error: `账本目录读不了：${String(e.message || e).slice(0, 120)}`, events: [] };
  }

  const idx = loadDispatchIndex(dir);
  const todo = [];
  for (const name of names) {
    if (!idx) { todo.push(name); continue; }
    if (name > idx.watermark) { todo.push(name); continue; }
    // 迟到的旧名文件（别台钟漂 / 回填）：mtime 比索引新就重扫它，合并时按 event_id 去重。
    try {
      if (statSync(join(dir, name)).mtimeMs > idx.builtAt) todo.push(name);
    } catch { /* mtime 读不到就不重扫，索引里已有它 */ }
  }

  const fresh = [];
  const bad = [];
  for (const name of todo) {
    try {
      const e = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (!e || typeof e !== 'object') { bad.push(`${name}: 不是对象`); continue; }
      fresh.push(e);
    } catch (err) {
      bad.push(`${name}: ${String(err.message || err).slice(0, 80)}`);
    }
  }
  if (bad.length) {
    return {
      unscanned: true,
      error: `${bad.length} 个事件不是 JSON（${bad.slice(0, 3).join('；')}）`,
      events: [],
    };
  }

  const seen = new Set();
  const dispatches = [];
  const closedIds = new Set();
  const handoffs = [];
  const handoffSeen = new Set();
  const absorb = (e) => {
    if (!e || typeof e !== 'object') return;
    const key = eventDedupKey(e);
    if (seen.has(key)) return;
    seen.add(key);
    if (e.type === 'job.dispatch' && e.job_id) dispatches.push(e);
    else if (e.type === 'job.closed' && e.job_id) closedIds.add(String(e.job_id));
    else if (e.type === 'job.handoff' && e.kind === 'job_id_rename' && e.from_job_id && e.to_job_id) {
      const hk = `${e.from_job_id}->${e.to_job_id}`;
      if (!handoffSeen.has(hk)) {
        handoffSeen.add(hk);
        handoffs.push({ from_job_id: e.from_job_id, to_job_id: e.to_job_id });
      }
    }
  };
  for (const e of idx ? idx.dispatches : []) absorb(e);
  for (const id of idx ? idx.closedIds : []) closedIds.add(String(id));
  for (const h of idx ? idx.handoffs : []) {
    const hk = `${h.from_job_id}->${h.to_job_id}`;
    if (!handoffSeen.has(hk)) { handoffSeen.add(hk); handoffs.push(h); }
  }
  for (const e of fresh) absorb(e);

  // 裁剪：dispatch 只留 retainMs 窗内（去重只看 10 分钟，6h 余量足够）；
  // closed/handoff 只留与留存 dispatch 相关的（索引体积有界）。
  const since = nowMs - Math.max(DISPATCH_DEDUP_WINDOW_MS, Number(retainMs) || 0);
  const kept = dispatches.filter(e => {
    const t = Date.parse(e.ts || '');
    return Number.isFinite(t) && t >= since;
  });
  const keptIds = new Set(kept.map(e => String(e.job_id)));
  const keptClosed = [...closedIds].filter(id => keptIds.has(id));
  const keptHandoffs = handoffs.filter(h => keptIds.has(String(h.from_job_id)));

  // 索引回写（best-effort）：写不动不挡查询，下次全量/增量照算。
  let indexWritten = false;
  if (names.length > 0) {
    try {
      const payload = {
        v: DISPATCH_INDEX_VERSION,
        builtAt: Date.now(),
        watermark: names[names.length - 1],
        dispatches: kept,
        closedIds: keptClosed,
        handoffs: keptHandoffs,
      };
      const p = dispatchIndexPath(dir);
      const tmp = `${p}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      renameSync(tmp, p);
      indexWritten = true;
    } catch { /* 缓存写不动不挡路 */ }
  }

  // 合成事件集：recentDispatchDup 只认 type/job_id/ts/terminal/card_name/issue_number 等字段，
  // closed/handoff 合成事件不带 ts 不影响判定（unclosedJobIds/continuedJobIds 不读 ts）。
  const events = [
    ...kept,
    ...keptClosed.map(id => ({ type: 'job.closed', job_id: id })),
    ...keptHandoffs.map(h => ({ type: 'job.handoff', kind: 'job_id_rename', from_job_id: h.from_job_id, to_job_id: h.to_job_id })),
  ];
  events.sort(compareEvents);
  return {
    unscanned: false,
    events,
    indexed: idx != null,
    scannedNew: todo.length,
    retained: kept.length,
    indexWritten,
  };
}


/**
 * 派工去重事前查（#759）：同一 issue（或无 issue 时同终端+同卡名）在 withinMs 内
 * 已有一条未结的 job.dispatch → 命中。已 closed / 已 handoff 接续的旧派工不算命中
 * （返工重派是合法动作）。三态：hit / clear / unscanned（events 不是数组或 now 非法）。
 * ts 解析不了的 dispatch 事件跳过并计数显形；未来时间戳容忍 60s 钟漂。
 */
export function recentDispatchDup(events, { issue, terminal, name, withinMs = DISPATCH_DEDUP_WINDOW_MS, now } = {}) {
  if (!Array.isArray(events)) {
    return { ok: false, unscanned: true, error: '没给 events 数组（没查成）' };
  }
  const nowMs = now == null ? Date.now() : (now instanceof Date ? now.getTime() : Date.parse(now));
  if (!Number.isFinite(nowMs)) {
    return { ok: false, unscanned: true, error: `now 非法（没查成）: ${now}` };
  }
  const windowMs = Math.max(0, Number(withinMs) || 0);
  const since = nowMs - windowMs;
  const open = new Set(unclosedJobIds(events));
  const wantIssue = issue != null && String(issue).trim() !== '';
  const wantName = name != null && String(name).trim() !== '';
  const hits = [];
  let skippedBadTs = 0;
  for (const e of events) {
    if (!e || e.type !== 'job.dispatch') continue;
    const t = Date.parse(e.ts || '');
    if (!Number.isFinite(t)) { skippedBadTs += 1; continue; }
    if (t < since || t > nowMs + 60000) continue;
    if (!open.has(e.job_id)) continue;
    const issueHit = wantIssue && matchesIssue(e, issue);
    const termHit = !wantIssue && terminal && wantName
      && e.terminal === terminal && (e.card_name || e.cardName) === name;
    if (issueHit || termHit) hits.push(e);
  }
  const base = { windowMs, ...(skippedBadTs ? { skippedBadTs } : {}) };
  if (hits.length === 0) return { ok: true, clear: true, hit: null, ...base };
  const latest = hits[hits.length - 1];
  return {
    ok: true,
    clear: false,
    hits: hits.length,
    hit: {
      job_id: latest.job_id || null,
      ts: latest.ts || null,
      model: latest.model || null,
      terminal: latest.terminal || null,
      issue_number: latest.issue_number ?? latest.issue ?? null,
      dispatch_id: latest.dispatch_id || null,
      card_name: latest.card_name || latest.cardName || null,
    },
    ...base,
  };
}

/** dispatch-<id> 已被 handoff 接到还在账本里的 gh-pr-N 时，不算未结。 */
export function continuedJobIds(events) {
  const dispatchIds = new Set();
  for (const e of events || []) {
    if (e && e.type === 'job.dispatch' && e.job_id) dispatchIds.add(e.job_id);
  }
  const continued = new Set();
  for (const e of events || []) {
    if (!e || e.type !== 'job.handoff' || e.kind !== 'job_id_rename') continue;
    const from = e.from_job_id;
    const to = e.to_job_id;
    if (from && to && dispatchIds.has(to)) continued.add(from);
  }
  return continued;
}

export function unclosedJobIds(events) {
  const closed = new Set();
  for (const e of events || []) {
    if (e && e.type === 'job.closed' && e.job_id) closed.add(e.job_id);
  }
  const continued = continuedJobIds(events);
  const open = [];
  const seen = new Set();
  for (const e of events || []) {
    if (!e || e.type !== 'job.dispatch' || !e.job_id) continue;
    if (closed.has(e.job_id) || continued.has(e.job_id) || seen.has(e.job_id)) continue;
    seen.add(e.job_id);
    open.push(e.job_id);
  }
  return open;
}

export function describeUnclosedJobs(events) {
  const ids = unclosedJobIds(events);
  const firstDispatch = new Map();
  for (const e of events || []) {
    if (e && e.type === 'job.dispatch' && e.job_id && !firstDispatch.has(e.job_id)) {
      firstDispatch.set(e.job_id, e);
    }
  }
  return ids.map(id => {
    const d = firstDispatch.get(id);
    const missing = [];
    const alias = String(id).startsWith('dispatch-');
    if (alias && d && d.pr_number == null) missing.push('job.closed（尚无 PR，等接续）');
    else if (alias) missing.push('job.closed', '接续到 gh-pr-N');
    else missing.push('job.closed');
    return {
      job_id: id,
      identity: (d && d.identity) || null,
      model: (d && d.model) || null,
      missing,
    };
  });
}

/**
 * @returns {{
 *   kind: 'unscanned'|'zero'|'ok',
 *   error?: string,
 *   events: object[],
 *   count: number,
 *   line: string
 * }}
 */
export function queryLedger({ events, recent, issue, unclosed } = {}) {
  if (!Array.isArray(events)) {
    return { kind: 'unscanned', error: '没给 events 数组', events: [], count: 0, line: '账本查询：没查成（没给事件）' };
  }
  let out = events.slice();
  if (issue != null && String(issue).trim() !== '') {
    out = out.filter(e => matchesIssue(e, issue));
  }
  if (unclosed) {
    const open = new Set(unclosedJobIds(events));
    out = out.filter(e => e && e.type === 'job.dispatch' && open.has(e.job_id));
  }
  if (recent != null && String(recent).trim() !== '') {
    const n = Number(recent);
    if (!Number.isInteger(n) || n <= 0) {
      return { kind: 'unscanned', error: `--recent 不是正整数: ${recent}`, events: [], count: 0, line: '账本查询：没查成（--recent 非法）' };
    }
    out = out.slice(-n);
  }
  if (out.length === 0) {
    return { kind: 'zero', events: [], count: 0, line: '账本查询：查到 0 条（不是没查成）' };
  }
  return { kind: 'ok', events: out, count: out.length, line: `账本查询：查到 ${out.length} 条` };
}

export function formatUnclosedDetails(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '账本未结单：0 个（未混入战绩）。';
  const lines = [`账本未结单：${rows.length} 个（未混入战绩）：`];
  for (const row of rows) {
    const who = row.identity ? ` ${row.identity}` : '';
    lines.push(`- ${row.job_id}${who} 缺：${(row.missing || []).join('、')}`);
  }
  return lines.join('\n');
}

export function formatLedgerQuery(result) {
  if (!result || result.kind === 'unscanned') {
    return `没查成：${result && result.error ? result.error : '查询失败'}`;
  }
  if (result.kind === 'zero') return result.line;
  const lines = [result.line];
  for (const e of result.events) {
    const bits = [
      e.ts || '?',
      e.type || '?',
      e.job_id || '-',
      e.pr_number != null ? `pr=${e.pr_number}` : null,
      e.model || null,
    ].filter(Boolean);
    lines.push(bits.join('  '));
  }
  return lines.join('\n');
}
