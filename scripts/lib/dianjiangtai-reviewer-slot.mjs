// scripts/lib/dianjiangtai-reviewer-slot.mjs —— 审读/审查 A 位锁 GPT（#581→#648→#658 2026-08-19 恢复）
//
// 用户 2026-08-19 拍板（#658）：GPT 恢复使用，审官选型序回到 **GPT 顶位 → Opus（UI 时顶）→ 其余**。
// 在途不换：已挂的 kimi-k3 / grok 审官继续跑完；UI 类（含复审）GPT 禁令不动（bans.yml）。
// kimi-k3 / glm-5.2 条目保留（登记不删），但不再顶审官位（#648 时代的顶位作废）。
// GPT 撞 [[bans]]（不在门闩通过集合）时按既有选型序顺延：Opus 顶位。
// 本模块只决定 A 位模型，不改 B/C，不写账。
// #679：换人跳过工人那一厂。不改 pinReviewerSlotA / 打分。

import { assertCrossVendor } from './reviewer-vendor-gate.mjs';

export function isGptModel(model) {
  if (!model) return false;
  return model.provider === 'gpt' || /^gpt/i.test(model.id || '');
}

export function isOpusModel(model) {
  if (!model) return false;
  return model.provider === 'claude' || /opus/i.test(model.id || '');
}

/**
 * @param {{ models: Array<{id:string,provider?:string}>, passerIds: string[] }} input
 * @returns {{ model: string|null, reason: 'reviewer_order'|'no_candidate' }}
 */
export function pinReviewerSlotA({ models = [], passerIds = [] } = {}) {
  const byId = new Map((models || []).map(m => [m.id, m]));
  const passers = (passerIds || []).map(id => byId.get(id)).filter(Boolean);
  // #658（2026-08-19 恢复）：门闩里有 GPT 锁 GPT；被 UI ban 剔掉（不在 passerIds）→ Opus 顶位；再顺延门闩首名。
  const gpt = passers.find(isGptModel);
  if (gpt) return { model: gpt.id, reason: 'reviewer_order' };
  const opus = passers.find(isOpusModel);
  if (opus) return { model: opus.id, reason: 'reviewer_order' };
  if (passers[0]) return { model: passers[0].id, reason: 'reviewer_order' };
  return { model: null, reason: 'no_candidate' };
}

export const REVIEWER_SELECT_ROLES = new Set(['审读', '审查']);

export function reviewerOrder({ models = [], passerIds = [] } = {}) {
  const byId = new Map((models || []).map(m => [m.id, m]));
  const passers = (passerIds || []).map(id => byId.get(id)).filter(Boolean);
  const ordered = [];
  const gpt = passers.find(isGptModel);
  const opus = passers.find(isOpusModel);
  if (gpt) ordered.push(gpt.id);
  if (opus) ordered.push(opus.id);
  for (const p of passers) {
    if (!ordered.includes(p.id)) ordered.push(p.id);
  }
  return ordered;
}

export function nextReviewerAfter({ currentId, models = [], passerIds = [], workerId } = {}) {
  const order = reviewerOrder({ models, passerIds });
  if (order.length === 0) {
    return { ok: false, unscanned: false, exhausted: true, error: '审官选型序空（没查成候选）' };
  }
  const cur = String(currentId || '');
  const i = order.indexOf(cur);
  const start = i < 0 ? -1 : i;
  for (let k = start + 1; k < order.length; k++) {
    const cand = order[k];
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
export function planCapacitySwitch({ displayName, models = [], passerIds = [], workerId } = {}) {
  const parsed = parseReviewerCardName(displayName);
  if (!parsed.ok) {
    return { ok: false, action: 'escalate', error: parsed.error };
  }
  if (workerId == null || String(workerId).trim() === '') {
    return { ok: false, action: 'escalate', unscanned: true, error: '没查成工人模型，不许换人' };
  }
  const next = nextReviewerAfter({
    currentId: parsed.model, models, passerIds, workerId,
  });
  if (!next.ok) {
    return { ok: false, action: 'escalate', error: next.error, exhausted: !!next.exhausted };
  }
  return { ok: true, action: 'switch', pr: parsed.pr, from: parsed.model, to: next.next };
}
