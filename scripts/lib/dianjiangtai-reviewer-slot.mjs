// scripts/lib/dianjiangtai-reviewer-slot.mjs —— 审读/审查 A 位锁 GPT（#581）
//
// 用户 2026-08-17 拍板：默认推荐位固定 GPT，B/C 仍走评分。
// GPT 撞 UI 类 [[bans]]（不在门闩通过集合）时按既有选型序顺延：Opus 顶位。
// 本模块只决定 A 位模型，不改 B/C，不写账。

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
 * @returns {{ model: string|null, reason: 'reviewer_default_gpt'|'reviewer_order'|'no_candidate' }}
 */
export function pinReviewerSlotA({ models = [], passerIds = [] } = {}) {
  const byId = new Map((models || []).map(m => [m.id, m]));
  const passers = (passerIds || []).map(id => byId.get(id)).filter(Boolean);
  const gpt = passers.find(isGptModel);
  if (gpt) return { model: gpt.id, reason: 'reviewer_default_gpt' };
  const opus = passers.find(isOpusModel);
  if (opus) return { model: opus.id, reason: 'reviewer_order' };
  if (passers[0]) return { model: passers[0].id, reason: 'reviewer_order' };
  return { model: null, reason: 'no_candidate' };
}

export const REVIEWER_SELECT_ROLES = new Set(['审读', '审查']);
