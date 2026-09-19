// packages/fleet/src/legs.mjs —— T39 阶梯③：换腿。纯函数：从候选里挑「同 family 的另一条腿」。
//
// 为什么要**同 family**：契约把 family 钉死了——审查者的 family 必须 ≠ 执行者的 family（异厂独立），
// 且 judgeReview 会比 `reviewerFamily === task.roles.reviewer.family`。跨 family 换腿会破坏这两条，
// 所以默认只在**同 family** 内换；跨 family 属于「改契约」，不是运行期能自己拍的。
//
// 换腿**只换会话**：树/分支/提交/checkpoint 一律不动（用户核心要求「不弃用已完成内容」）。

/** 候选形态来自 scripts/lib/leg-choice.mjs：{ id, family, rank(null=淘汰), eliminated, reasons }。 */
export function alternateProfiles({ candidates = [], primary = null, limit = 3 } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const primaryFamily = (list.find((c) => c && c.id === primary) || {}).family || null;
  const alive = list
    .filter((c) => c && c.id && c.eliminated !== true && Number.isInteger(c.rank) && c.id !== primary)
    .sort((a, b) => a.rank - b.rank);
  // 同 family 优先；没有同 family 的（或主腿 family 未知）就退而用其余可用腿。
  const same = primaryFamily ? alive.filter((c) => c.family === primaryFamily) : [];
  const rest = alive.filter((c) => !same.includes(c));
  return [...same, ...rest].slice(0, limit).map((c) => c.id);
}
