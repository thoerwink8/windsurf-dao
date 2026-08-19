// scripts/lib/dianjiangtai-reviewer-slot.mjs —— 审读/审查 A 位锁 GPT（#581→#648→#658 2026-08-19 恢复）
//
// 用户 2026-08-19 拍板（#658）：GPT 恢复使用，审官选型序回到 **GPT 顶位 → Opus（UI 时顶）→ 其余**。
// 在途不换：已挂的 kimi-k3 / grok 审官继续跑完；UI 类（含复审）GPT 禁令不动（bans.yml）。
// kimi-k3 / glm-5.2 条目保留（登记不删），但不再顶审官位（#648 时代的顶位作废）。
// GPT 撞 [[bans]]（不在门闩通过集合）时按既有选型序顺延：Opus 顶位。
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
