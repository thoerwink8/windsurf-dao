// scripts/lib/ledger-query.mjs —— 账本查询（#588 追加）
//
// 把「人要记住怎么查才不出错」封进命令：按事件 ts 排序，不按文件 mtime；
// 按 job_id / pr_number / issue 字段匹配，不 grep 数字（会命中 event_id）。
// 检查器自己 JSON.parse，不走 event-writer。
//
// 三态：查到 N 条 / 查到 0 条 / 没查成（目录不在或有文件不是 JSON）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

export function unclosedJobIds(events) {
  const closed = new Set();
  for (const e of events || []) {
    if (e && e.type === 'job.closed' && e.job_id) closed.add(e.job_id);
  }
  const open = [];
  const seen = new Set();
  for (const e of events || []) {
    if (!e || e.type !== 'job.dispatch' || !e.job_id) continue;
    if (closed.has(e.job_id) || seen.has(e.job_id)) continue;
    seen.add(e.job_id);
    open.push(e.job_id);
  }
  return open;
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
