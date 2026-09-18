// scripts/lib/dispatch-day-budget.mjs —— per_day.dispatch_max 接线（#1227）
//
// 改这段前必须知道：
//   1. 上限只认 docs/release-policy.json 的 budget.per_day.dispatch_max。
//      不许在这里手抄 20。JSON 改了闸跟着改；改 JSON 本身是改规则，人拍板。
//   2. 计哪些事件：本机账本 job.dispatch 里 identity=工人 且 source 是
//      dao-dispatch / dao-dispatch-mirasim。这就是 issue 表里 09-09 的 288 次。
//      不计入：审官（source=reviewer-create）、github-backfill（事后重建）、
//      dao-pr-open（开 PR 不是起工人会话）。
//   3. 日界用北京日历日（与 ledger-job.beijingIsoFrom 同一把尺）。
//   4. 满了（count >= max）⇒ 工人会话排队到次日。审官 / 合并仍走。
//   5. 三态：ok / exceeded / unscanned。没读到上限 ≠ 没有上限。

import { existsSync, readFileSync } from 'node:fs';
import { beijingDateOf } from './dianjiangtai-backfill.mjs';

export const POLICY_REL = 'docs/release-policy.json';
export const HALT_CODE = 'dispatch-day-exceeded';
export const UNSCANNED_CODE = 'dispatch-day-unscanned';

const COUNTED_SOURCES = new Set(['dao-dispatch', 'dao-dispatch-mirasim']);

function str(v) {
  return v == null ? '' : String(v).trim();
}

function errText(e) {
  return str(e && e.message ? e.message : e).split(/\r?\n/)[0].slice(0, 160);
}

function calendarDay(input) {
  if (input == null || input === '') return null;
  try {
    return beijingDateOf(input instanceof Date ? input.toISOString() : input);
  } catch {
    return null;
  }
}

/** 解析策略正文。纯函数：给什么字解什么，不碰文件系统。 */
export function parseDispatchDayBudget(text) {
  if (text == null) {
    return { unscanned: true, error: `没给 ${POLICY_REL} 正文（没查成）` };
  }
  let doc;
  try {
    doc = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch (e) {
    return { unscanned: true, error: `${POLICY_REL} 解析不了：${errText(e)}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { unscanned: true, error: `${POLICY_REL} 顶层不是对象` };
  }
  const max = doc?.budget?.per_day?.dispatch_max;
  if (!Number.isInteger(max) || max < 1) {
    return { unscanned: true, error: `${POLICY_REL} 的 budget.per_day.dispatch_max 不是正整数` };
  }
  const onExceed = str(doc?.budget?.per_day?.on_exceed);
  return {
    unscanned: false,
    max,
    onExceed: onExceed || null,
  };
}

export function loadDispatchDayBudgetFile(file) {
  if (!file) return { unscanned: true, error: `没给 ${POLICY_REL} 路径（没查成）` };
  try {
    if (!existsSync(file)) return { unscanned: true, error: `${POLICY_REL} 不在：${file}` };
    return parseDispatchDayBudget(readFileSync(file, 'utf8'));
  } catch (e) {
    return { unscanned: true, error: `读 ${POLICY_REL} 失败：${errText(e)}` };
  }
}

/** 这条约不计入日配额。查证钉在 2026-09-09 的 288 条 dao-dispatch-mirasim 工人事件。 */
export function isCountedDispatch(event) {
  if (!event || event.type !== 'job.dispatch') return false;
  if (event.identity !== '工人') return false;
  return COUNTED_SOURCES.has(str(event.source));
}

export function countDayDispatches(events, day) {
  if (!Array.isArray(events) || !day) return 0;
  let n = 0;
  for (const e of events) {
    if (!isCountedDispatch(e)) continue;
    if (calendarDay(e.ts) === day) n += 1;
  }
  return n;
}

/**
 * 今日还能不能再起工人会话。
 *
 * budget 没给 → skip（测试夹具可不注入）。
 * 生产路径必须注入；注入后 unscanned / exceeded 都要拦。
 * events 不是数组 → unscanned（没查成，不许当 0 次）。
 */
export function judgeDispatchDay({ events, budget, now } = {}) {
  if (budget == null) return { state: 'skip', count: null, max: null, day: null };
  if (budget.unscanned) {
    return {
      state: 'unscanned',
      count: null,
      max: null,
      day: null,
      error: budget.error || `${POLICY_REL} 的每日派工上限没查成`,
      missing: ['dispatchDayBudget'],
    };
  }
  const max = budget.max;
  if (!Number.isInteger(max) || max < 1) {
    return {
      state: 'unscanned',
      count: null,
      max: null,
      day: null,
      error: '每日派工上限不是正整数',
      missing: ['dispatchDayBudget'],
    };
  }
  if (!Array.isArray(events)) {
    return {
      state: 'unscanned',
      count: null,
      max,
      day: null,
      error: '今日派工账没查成，数不了次数',
      missing: ['dispatchLedger'],
    };
  }
  const day = calendarDay(now);
  if (!day) {
    return {
      state: 'unscanned',
      count: null,
      max,
      day: null,
      error: '当日时钟没查成，对不上北京日历日',
      missing: ['at'],
    };
  }
  const count = countDayDispatches(events, day);
  if (count >= max) return { state: 'exceeded', count, max, day };
  return { state: 'ok', count, max, day };
}

export function nextDispatchDayBlocked(judged) {
  const state = judged && judged.state;
  return state === 'exceeded' || state === 'unscanned';
}

export function dispatchDayExceededError({ count, max, day } = {}) {
  return `${HALT_CODE}：今日工人派工 ${count}/${max}（${day || '当日'}），排队到次日`;
}

export function dispatchDayUnscannedError({ error } = {}) {
  const detail = str(error) || `${POLICY_REL} 的每日派工上限没查成`;
  return `${UNSCANNED_CODE}：${detail}，工人派工排队到次日`;
}
