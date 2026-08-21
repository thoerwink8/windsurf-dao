// scripts/lib/dianjiangtai-reviewer-slot.mjs —— 审读/审查 A 位按 JSON 选型序
//
// 2026-08-22：审官顺位真相源 docs/model-routing.json（审官.审查.模型）。
// 本模块只决定 A 位模型与换人顺序，不改 B/C，不写账。
// #679：换人跳过工人那一厂。

import { assertCrossVendor } from './reviewer-vendor-gate.mjs';

function orderedPasserIds({ models = [], passerIds = [], order = [] } = {}) {
  const byId = new Map((models || []).map(m => [m.id, m]));
  const set = new Set(passerIds || []);
  const out = [];
  for (const id of order || []) {
    if (set.has(id) && byId.has(id)) out.push(id);
  }
  for (const id of passerIds || []) {
    if (!out.includes(id) && byId.has(id)) out.push(id);
  }
  return out;
}

/**
 * @param {{ models: Array<{id:string,provider?:string}>, passerIds: string[], order?: string[] }} input
 * @returns {{ model: string|null, reason: 'reviewer_order'|'no_candidate' }}
 */
export function pinReviewerSlotA({ models = [], passerIds = [], order = [], workerId = null } = {}) {
  const ids = orderedPasserIds({ models, passerIds, order });
  if (ids.length === 0) return { model: null, reason: 'no_candidate' };
  const top = ids[0];
  if (workerId != null && String(workerId).trim() !== '') {
    const gate = assertCrossVendor({ workerId, reviewerId: top, models });
    if (gate.state === 'same_vendor') {
      return { model: null, reason: 'same_vendor_blocked', error: gate.error };
    }
  }
  return { model: top, reason: 'reviewer_order' };
}

export const REVIEWER_SELECT_ROLES = new Set(['审读', '审查']);

export function reviewerOrder({ models = [], passerIds = [], order = [] } = {}) {
  return orderedPasserIds({ models, passerIds, order });
}

export function nextReviewerAfter({ currentId, models = [], passerIds = [], workerId, order = [] } = {}) {
  const list = reviewerOrder({ models, passerIds, order });
  if (list.length === 0) {
    return { ok: false, unscanned: false, exhausted: true, error: '审官选型序空（没查成候选）' };
  }
  const cur = String(currentId || '');
  const i = list.indexOf(cur);
  const start = i < 0 ? -1 : i;
  for (let k = start + 1; k < list.length; k++) {
    const cand = list[k];
    if (workerId != null && String(workerId).trim() !== '') {
      const gate = assertCrossVendor({ workerId, reviewerId: cand, models });
      if (gate.state === 'unscanned') {
        return { ok: false, unscanned: true, exhausted: false, error: gate.error };
      }
      if (gate.state === 'same_vendor') continue;
    }
    return { ok: true, next: cand, from: cur || null };
  }
  if (workerId != null && String(workerId).trim() !== '') {
    return {
      ok: false,
      unscanned: false,
      exhausted: true,
      error: '选型序走完仍同厂，没法再换（不许降级同厂）',
    };
  }
  return { ok: false, unscanned: false, exhausted: true, error: '审官选型序走完，没法再换' };
}

export function parseReviewerCardName(name) {
  const n = String(name || '').trim();
  const m = n.match(/PR-#?(\d+)\s+审官·(\S+)/);
  if (!m) return { ok: false, error: '卡名不是 PR-#N 审官·模型' };
  return { ok: true, pr: Number(m[1]), model: m[2] };
}

/** 卡名给人看。程序判据不要用这个读实际工人模型——fallback 后卡名可能停在请求模型。 */
export function parseWorkerModelFromCard(name) {
  const n = String(name || '').trim();
  const m = n.match(/工人·(\S+)/);
  if (!m) return { ok: false, error: '卡名不是 …工人·模型' };
  return { ok: true, model: m[1] };
}

/** capacity 四档续命之后：能换人就换，认不出审官卡才报帅。#679：跳过工人那一厂。 */
export function planCapacitySwitch({ displayName, models = [], passerIds = [], workerId, order = [] } = {}) {
  const parsed = parseReviewerCardName(displayName);
  if (!parsed.ok) {
    return { ok: false, action: 'escalate', error: parsed.error };
  }
  if (workerId == null || String(workerId).trim() === '') {
    return { ok: false, action: 'escalate', unscanned: true, error: '没查成工人模型，不许换人' };
  }
  const next = nextReviewerAfter({
    currentId: parsed.model, models, passerIds, workerId, order,
  });
  if (!next.ok) {
    return { ok: false, action: 'escalate', error: next.error, exhausted: !!next.exhausted };
  }
  return { ok: true, action: 'switch', pr: parsed.pr, from: parsed.model, to: next.next };
}
