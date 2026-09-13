// scripts/lib/land-decision.mjs —— 核绿之后怎么合、落后要不要再审（ephemeral-lifecycle）
//
// 拍板：审查看这份 diff；合入是 squash 打到此刻的 master。落后 ≠ 冲突。
// 当前 head 上没有新判定时：历史上最后一条若是 APPROVED，那是对接 master，不要再审；
// 若是 CHANGES_REQUESTED，那是工人按红项改完，要再看一眼（同一轮审查，不是第二套复审）。

/**
 * @param {{ scanned?: boolean, latestGreen?: boolean, latestRed?: boolean }} all
 * @returns {'APPROVED'|'CHANGES_REQUESTED'|null}
 */
export function lastJudgmentOf(all) {
  if (!all || all.scanned === false) return null;
  if (all.latestGreen) return 'APPROVED';
  if (all.latestRed) return 'CHANGES_REQUESTED';
  return null;
}

/**
 * 这张 PR 现在能不能当「审官已经放行、可以合入」。
 * greenAtHead：当前 head 上最后一条是绿。
 * decisionApproved：GitHub 聚合 reviewDecision（开了分支保护才有）。
 * atHead === 0 且历史上最后一条是 APPROVED：head 只因对接 master 变了。
 */
export function approvedToLand({
  greenAtHead = false,
  decisionApproved = false,
  atHead = null,
  lastJudgment = null,
} = {}) {
  if (greenAtHead === true || decisionApproved === true) return true;
  return atHead === 0 && lastJudgment === 'APPROVED';
}
