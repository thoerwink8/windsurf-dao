// scripts/lib/dianjiangtai-reviewer-slot.mjs —— 审读/审查 A 位锁 GLM-5.2（#581→#648）
//
// 用户 2026-08-19 拍板（#648）：GPT 暂时不可用，默认推荐位顶 GLM-5.2（cursor/glm-5.2-high），
// B/C 仍走评分；GPT 恢复另拍。GLM-5.2 撞 [[bans]]（不在门闩通过集合）时按既有选型序顺延：
// Opus 顶位。本模块只决定 A 位模型，不改 B/C，不写账。

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
  // #648：GPT 暂时不可用（恢复另拍）→ 顶位 GLM-5.2（cursor/glm-5.2-high），GPT 不参与 A 位顺延。
  const nonGpt = passers.filter(m => !isGptModel(m));
  const glm52 = nonGpt.find(m => m.id === 'glm-5.2');
  if (glm52) return { model: glm52.id, reason: 'reviewer_order' };
  const opus = nonGpt.find(isOpusModel);
  if (opus) return { model: opus.id, reason: 'reviewer_order' };
  if (nonGpt[0]) return { model: nonGpt[0].id, reason: 'reviewer_order' };
  return { model: null, reason: 'no_candidate' };
}

export const REVIEWER_SELECT_ROLES = new Set(['审读', '审查']);
