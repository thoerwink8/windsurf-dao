// scripts/lib/board-v0.mjs —— 看板 v0 判官（#818，零界面）
//
// 拍板 2026-09-07（7A）：一张表 + 超时告警发总控群 + 「状态」回表。
// 本文件零 IO。取数在 board-collect.mjs，告警在 board-watch.mjs。
//
// 三条硬规矩（本仓反复实咬）：
//   1. 没查成 ≠ 没有，更不等于超时。源挂了只坏自己那几行，不许显示成一切正常。
//   2. 超时看墙钟，不看「连续 N 轮没动」。同一主体同一阶段已报过 → 不刷屏；跨阶段才再报。
//   3. 总控群「状态」走确定性闸回这张表，不靠 LLM 编盘面；问候仍不甩表。

import { looksLikeStatusQuery } from './feishu-group-profile.mjs';
import { PENDING_LABEL } from './pending-disambiguation.mjs';
import { DISAMBIGUATED_LABEL } from './dispatch/card.mjs';
import { AWAITING_CALL_LABEL } from './now-board.mjs';
import { EXHAUSTED_LABEL, WAITING_USER_LABEL } from './exhausted.mjs';
import { ensurePlain, plainViolations, threeLines } from './plain-words.mjs';

/** 跟 docs/release-policy.json budget.per_issue.worker_wall_hours_max 对齐。 */
export const DEFAULT_WORKER_WALL_HOURS = 4;

export const BOARD_KINDS = ['issue', 'pr', 'queue'];
export const BOARD_STATES = ['green', 'red', 'unscanned'];

const ISSUE_PENDING = PENDING_LABEL;
const ISSUE_READY = DISAMBIGUATED_LABEL;
const ISSUE_AWAIT = AWAITING_CALL_LABEL;

function labelNames(labels) {
  if (!Array.isArray(labels)) return null;
  const out = [];
  for (const l of labels) {
    if (typeof l === 'string') { if (l) out.push(l); continue; }
    if (l && typeof l.name === 'string' && l.name) out.push(l.name);
  }
  return out;
}

function pickModel(names, fallback) {
  if (Array.isArray(names)) {
    const hit = names.find((n) => /^model\//.test(n));
    if (hit) return hit.slice('model/'.length);
  }
  const fb = fallback == null ? '' : String(fallback).trim();
  return fb || null;
}

function hoursBetween(startedAt, now) {
  const t0 = Date.parse(startedAt);
  const t1 = now instanceof Date ? now.getTime() : Date.parse(now) || Number(now);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  const h = (t1 - t0) / 3600000;
  if (!Number.isFinite(h) || h < 0) return null;
  return Math.round(h * 10) / 10;
}

function envelope(src) {
  if (!src || typeof src !== 'object') {
    return { scanned: false, error: '这一源根本没给（没查成）', items: [] };
  }
  if (src.scanned !== true) {
    return { scanned: false, error: String(src.error || '没查成（源没说为什么）'), items: [] };
  }
  if (!Array.isArray(src.items)) {
    return { scanned: false, error: String(src.error || '源说查成了却没给数组（按没查成算）'), items: [] };
  }
  return { scanned: true, error: null, items: src.items };
}

function sourceState(env) {
  if (!env.scanned) return { state: 'unscanned', why: env.error, count: 0 };
  return { state: 'green', why: null, count: env.items.length };
}

function unscannedRow(kind, why) {
  return {
    state: 'unscanned',
    kind,
    id: null,
    stage: null,
    elapsedHours: null,
    model: null,
    title: null,
    why: String(why || '没查成'),
    startedAt: null,
  };
}

function rowState({ elapsedHours, thresholdHours, whyUnscanned }) {
  if (whyUnscanned) return 'unscanned';
  if (elapsedHours != null && Number.isFinite(thresholdHours) && elapsedHours > thresholdHours) return 'red';
  return 'green';
}

/** issue 阶段：待拍板 / 待消歧 / 已消歧待派 / 在办。label 不是数组 = 这行没查成。 */
export function assessIssueStage(issue) {
  const names = labelNames(issue && issue.labels);
  if (names == null) return { stage: null, unscanned: true, why: '这张单的标签没查成' };
  if (names.includes(ISSUE_AWAIT)) return { stage: '待拍板', unscanned: false, why: null };
  if (names.includes(ISSUE_PENDING)) return { stage: '待消歧', unscanned: false, why: null };
  if (names.includes(ISSUE_READY)) return { stage: '已消歧待派', unscanned: false, why: null };
  return { stage: '在办', unscanned: false, why: null };
}

/** PR 阶段：工人干活 / 等审 / 已红返工 / 已绿待合 / 卡死。 */
export function assessPrStage(pr) {
  const names = labelNames(pr && pr.labels);
  if (names && (names.includes(EXHAUSTED_LABEL) || names.includes(WAITING_USER_LABEL))) {
    return { stage: '卡死', unscanned: false, why: null };
  }
  const decision = String((pr && pr.reviewDecision) || '').toUpperCase();
  if (decision === 'APPROVED') return { stage: '已绿待合', unscanned: false, why: null };
  if (decision === 'CHANGES_REQUESTED') return { stage: '已红返工', unscanned: false, why: null };
  if (pr && pr.isDraft === true) return { stage: '工人干活', unscanned: false, why: null };
  return { stage: '等审', unscanned: false, why: null };
}

/** 队列阶段：排队 / 执行中 / 完成 / 失败。 */
export function assessQueueStage(order) {
  const s = String((order && order.status) || '').toLowerCase();
  if (s === 'running') return { stage: '执行中', unscanned: false, why: null };
  if (s === 'failed') return { stage: '失败', unscanned: false, why: null };
  if (s === 'done') return { stage: '完成', unscanned: false, why: null };
  return { stage: '排队', unscanned: false, why: null };
}

function ledgerModelMap(ledger) {
  const env = envelope(ledger);
  const map = new Map();
  if (!env.scanned) return { scanned: false, error: env.error, map };
  for (const e of env.items) {
    if (!e || e.type !== 'job.dispatch') continue;
    const model = e.model ? String(e.model) : null;
    if (!model) continue;
    const issue = e.issue != null ? String(e.issue) : (e.issue_number != null ? String(e.issue_number) : null);
    const pr = e.pr_number != null ? String(e.pr_number) : null;
    if (issue) map.set(`issue:${issue}`, model);
    if (pr) map.set(`pr:${pr}`, model);
  }
  return { scanned: true, error: null, map };
}

function finishRow(partial, { now, thresholdHours }) {
  const elapsedHours = hoursBetween(partial.startedAt, now);
  const state = rowState({
    elapsedHours,
    thresholdHours,
    whyUnscanned: partial.state === 'unscanned' ? partial.why : null,
  });
  return {
    ...partial,
    elapsedHours,
    state: partial.state === 'unscanned' ? 'unscanned' : state,
  };
}

export function issueToRow(issue, { now, thresholdHours, modelFromLedger } = {}) {
  const id = issue && issue.number != null ? String(issue.number) : null;
  if (!id) return unscannedRow('issue', '这张单没有编号（按没查成算）');
  const st = assessIssueStage(issue);
  if (st.unscanned) {
    return finishRow({
      state: 'unscanned', kind: 'issue', id, stage: null, model: null,
      title: issue.title ? String(issue.title) : null, why: st.why,
      startedAt: issue.createdAt || issue.updatedAt || null,
    }, { now, thresholdHours });
  }
  const names = labelNames(issue.labels) || [];
  return finishRow({
    state: 'green',
    kind: 'issue',
    id,
    stage: st.stage,
    model: pickModel(names, modelFromLedger),
    title: issue.title ? String(issue.title) : null,
    why: null,
    startedAt: issue.createdAt || issue.updatedAt || null,
  }, { now, thresholdHours });
}

export function prToRow(pr, { now, thresholdHours, modelFromLedger } = {}) {
  const id = pr && pr.number != null ? String(pr.number) : null;
  if (!id) return unscannedRow('pr', '这张合并请求没有编号（按没查成算）');
  const st = assessPrStage(pr);
  const names = labelNames(pr.labels) || [];
  return finishRow({
    state: 'green',
    kind: 'pr',
    id,
    stage: st.stage,
    model: pickModel(names, modelFromLedger),
    title: pr.title ? String(pr.title) : null,
    why: null,
    startedAt: pr.createdAt || pr.updatedAt || null,
  }, { now, thresholdHours });
}

export function queueToRow(order, { now, thresholdHours } = {}) {
  const id = order && order.id ? String(order.id) : null;
  if (!id) return unscannedRow('queue', '这条排队单没有编号（按没查成算）');
  const st = assessQueueStage(order);
  const issue = order.issue != null ? String(order.issue) : null;
  return finishRow({
    state: 'green',
    kind: 'queue',
    id,
    issue,
    stage: st.stage,
    model: order.model ? String(order.model) : null,
    title: order.name || order.title || null,
    why: null,
    startedAt: order.ts || order.startedAt || null,
  }, { now, thresholdHours });
}

/**
 * 三源合成一张表。任一路信封坏掉只产出那一路的没查成行。
 * ledger 只用来补模型，挂了不另产行（模型就空着）。
 */
export function renderBoard({
  now = new Date().toISOString(),
  issues, prs, queue, ledger,
  thresholdHours = DEFAULT_WORKER_WALL_HOURS,
} = {}) {
  const at = now instanceof Date ? now : new Date(now);
  const iso = Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
  const th = Number(thresholdHours);
  const threshold = Number.isFinite(th) ? th : DEFAULT_WORKER_WALL_HOURS;
  const models = ledgerModelMap(ledger);

  const issEnv = envelope(issues);
  const prEnv = envelope(prs);
  const qEnv = envelope(queue);

  const sources = {
    issues: sourceState(issEnv),
    prs: sourceState(prEnv),
    queue: sourceState(qEnv),
    ledger: models.scanned
      ? { state: 'green', why: null, count: models.map.size }
      : { state: 'unscanned', why: models.error, count: 0 },
  };

  const rows = [];
  if (!issEnv.scanned) rows.push(unscannedRow('issue', issEnv.error));
  else {
    for (const it of issEnv.items) {
      const id = it && it.number != null ? String(it.number) : null;
      rows.push(issueToRow(it, {
        now: iso, thresholdHours: threshold,
        modelFromLedger: id ? models.map.get(`issue:${id}`) : null,
      }));
    }
  }
  if (!prEnv.scanned) rows.push(unscannedRow('pr', prEnv.error));
  else {
    for (const it of prEnv.items) {
      const id = it && it.number != null ? String(it.number) : null;
      rows.push(prToRow(it, {
        now: iso, thresholdHours: threshold,
        modelFromLedger: id ? models.map.get(`pr:${id}`) : null,
      }));
    }
  }
  if (!qEnv.scanned) rows.push(unscannedRow('queue', qEnv.error));
  else {
    for (const it of qEnv.items) rows.push(queueToRow(it, { now: iso, thresholdHours: threshold }));
  }

  return {
    updatedAt: iso,
    thresholdHours: threshold,
    rows,
    sources,
  };
}

export function alertKey(row) {
  if (!row || !row.kind || row.id == null || !row.stage) return null;
  return `${row.kind}:${row.id}:${row.stage}`;
}

function ledgerHas(ledger, key) {
  if (!key) return false;
  if (!ledger || typeof ledger !== 'object') return false;
  const alerts = ledger.alerts;
  if (alerts && typeof alerts === 'object' && !Array.isArray(alerts) && alerts[key]) return true;
  if (Array.isArray(alerts)) return alerts.some((a) => a && a.key === key);
  return false;
}

/**
 * 超时告警纯函数。
 * 该报：墙钟超阈值且行是查成的。
 * 不报：同主体同阶段已报过；源没查成；耗时没算出来。
 */
export function planStageTimeoutAlerts({ rows, thresholdHours = DEFAULT_WORKER_WALL_HOURS, ledger } = {}) {
  const th = Number(thresholdHours);
  const threshold = Number.isFinite(th) ? th : DEFAULT_WORKER_WALL_HOURS;
  const alerts = [];
  const skipped = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const key = alertKey(row);
    if (row.state === 'unscanned') {
      skipped.push({ id: row.id, kind: row.kind, reason: '没查成，不报超时' });
      continue;
    }
    if (row.elapsedHours == null) {
      skipped.push({ id: row.id, kind: row.kind, reason: '耗时没算出来，不报超时' });
      continue;
    }
    if (!(row.elapsedHours > threshold)) continue;
    if (!key) {
      skipped.push({ id: row.id, kind: row.kind, reason: '缺阶段，对不上主体' });
      continue;
    }
    if (ledgerHas(ledger, key)) {
      skipped.push({ id: row.id, kind: row.kind, stage: row.stage, reason: '同主体同阶段已报过' });
      continue;
    }
    alerts.push({
      key,
      kind: row.kind,
      id: row.id,
      stage: row.stage,
      elapsedHours: row.elapsedHours,
      model: row.model,
      title: row.title,
      text: formatTimeoutAlert(row, threshold),
    });
  }
  return { alerts, skipped, thresholdHours: threshold };
}

export function formatTimeoutAlert(row, thresholdHours = DEFAULT_WORKER_WALL_HOURS) {
  const who = describeRow(row);
  const stage = row && row.stage ? `「${row.stage}」` : '这一阶段';
  const hours = row && row.elapsedHours != null ? row.elapsedHours : '?';
  const text = threeLines({
    what: `${who}在${stage}已经超过 ${thresholdHours} 小时（已过 ${hours} 小时）。`,
    impact: '可能卡住了，还没人往下走。',
    plan: '先报这一次；同一张单同一阶段不再刷屏。',
  });
  return ensurePlain(text, 'board-watch');
}

function describeRow(row) {
  if (!row) return '有一张单';
  if (row.kind === 'pr') return `合并请求 #${row.id}`;
  if (row.kind === 'queue') {
    return row.issue ? `排队单（#${row.issue}）` : '一条排队单';
  }
  return row.id ? `单 #${row.id}` : '有一张单';
}

function describeKind(kind) {
  if (kind === 'pr') return '合并请求';
  if (kind === 'queue') return '排队单';
  return '单';
}

/** 给人看 / 总控群回的表。过说人话闸；没查成的源单独列，不许装成全绿。 */
export function formatBoardTable(board) {
  const rows = Array.isArray(board && board.rows) ? board.rows : [];
  const lines = [];
  const visible = rows.filter((r) => r && r.state !== 'unscanned' && r.id);
  const missing = rows.filter((r) => r && r.state === 'unscanned');
  if (visible.length === 0 && missing.length === 0) {
    lines.push('看板这会儿是空的，没有在途的单。');
  } else {
    lines.push('看板：');
    for (const r of visible) {
      const bits = [describeKind(r.kind) + (r.id ? ` #${r.id}` : '')];
      if (r.stage) bits.push(r.stage);
      if (r.elapsedHours != null) bits.push(`${r.elapsedHours} 小时`);
      if (r.model) bits.push(r.model);
      if (r.state === 'red') bits.push('超时');
      const title = r.title ? String(r.title).replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      lines.push(`- ${bits.join(' · ')}${title ? `  ${title}` : ''}`);
    }
  }
  if (missing.length) {
    lines.push('有一面没查成（不是没有）：');
    for (const r of missing) {
      lines.push(`- ${describeKind(r.kind)}：${r.why || '没查成'}`);
    }
  }
  const src = board && board.sources;
  if (src && src.ledger && src.ledger.state === 'unscanned' && src.ledger.why) {
    if (!missing.some((r) => /账本/.test(String(r.why || '')))) {
      lines.push(`- 派工记录：${src.ledger.why}`);
    }
  }
  const text = lines.join('\n');
  return ensurePlain(text, 'board-table');
}

export function loadBoardThreshold(doc) {
  const w = Number(doc && doc.board && doc.board.workerWallHoursMax);
  if (Number.isFinite(w) && w >= 0.25 && w <= 168) return w;
  return DEFAULT_WORKER_WALL_HOURS;
}

export { plainViolations, looksLikeStatusQuery };
