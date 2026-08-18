// scripts/lib/dianjiangtai-reviewer-slot.mjs —— 审读/审查 A 位锁 KIMI-K3（#581→#648→2026-08-19 追加拍板）
//
// 用户 2026-08-19 拍板（#648 评论 #6）：GPT 暂时不可用，后续审官一律 kimi-k3（cursor/kimi-k3-high），
// 默认推荐位顶 KIMI-K3，B/C 仍走评分；GPT 恢复另拍。glm-5.2 保留登记但不再顶审官位。
// KIMI-K3 撞 [[bans]]（不在门闩通过集合）时按既有选型序顺延：Opus 顶位。
// 本模块只决定 A 位模型，不改 B/C，不写账。

export function isGptModel(model) {
  if (!model) return false;
  return model.provider === 'gpt' || /^gpt/i.test(model.id || '');
}

export function isKimiModel(model) {
  if (!model) return false;
  return model.provider === 'cursor' && /^kimi/i.test(model.id || '');
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
  // #648（2026-08-19 追加）：GPT 暂时不可用（恢复另拍）→ 顶位 kimi-k3（cursor/kimi-k3-high），GPT 不参与 A 位顺延。
  const nonGpt = passers.filter(m => !isGptModel(m));
  const kimi = nonGpt.find(isKimiModel);
  if (kimi) return { model: kimi.id, reason: 'reviewer_order' };
  const opus = nonGpt.find(isOpusModel);
  if (opus) return { model: opus.id, reason: 'reviewer_order' };
  if (nonGpt[0]) return { model: nonGpt[0].id, reason: 'reviewer_order' };
  return { model: null, reason: 'no_candidate' };
}

export const REVIEWER_SELECT_ROLES = new Set(['审读', '审查']);
