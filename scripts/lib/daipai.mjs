// 双门制+超时代拍（2026-09-04 拍板：夜间无人值守不停摆——可逆岔路「双向门」到期无人回复
// 按推荐项代拍、可翻案；「单向门」（花钱/换人/不可逆）超时=拒绝，只等人，但只卡这一件不卡链）。
// 纯函数，commander.mjs 接线；业界准则：风险分层用确定性规则，不靠模型现场判断。
export const TWO_WAY_DEADLINE_MS = 4 * 60 * 60 * 1000;
export const DAIPAI_MAX_PER_ROUND = 2;

// 确定性门类表。不在表里的 reason 一律单向门——fail-closed：宁可等人，不许乱代拍。
export const TWO_WAY_REASONS = new Set([
  'missing-labels',      // 补标可逆
  'malformed-judgment',  // 让审官重发判定行可逆
  'approved-but-ci-red', // 查因/催工可逆（合并本身另有确定性闸把着）
]);

export function doorOf(reason) {
  return TWO_WAY_REASONS.has(String(reason || '')) ? 'two-way' : 'one-way';
}

/** 一张待拍板单要不要代拍。全显式入参可测；任何一项没查成都不代拍（没查成不是过期）。 */
export function classifyDaipai({ body, createdAt, comments, now = Date.now() } = {}) {
  const text = String(body || '');
  if (!text.includes('门类：双向门')) return { daipai: false, why: '非双向门' };
  const t0 = Date.parse(createdAt || '');
  if (Number.isNaN(t0)) return { daipai: false, unscanned: true, why: 'createdAt 没查成' };
  if (now - t0 < TWO_WAY_DEADLINE_MS) return { daipai: false, why: '未到期' };
  if (!Array.isArray(comments)) return { daipai: false, unscanned: true, why: 'comments 没查成' };
  if (comments.length > 0) return { daipai: false, why: '单上已有回复（人或大脑已介入），不代拍' };
  return { daipai: true };
}
