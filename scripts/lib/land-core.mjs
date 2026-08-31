// land 收工决策层（2026-08-31 拍板：commit 后推主分支 + 清已合并派生物，做成一条幂等命令）。
// 全部判断在这层纯函数里，tests/land.test.js 拿假盘面逐类验判别力；land.mjs 只执行不判断。
//
// 三条安全底线（与 orca 编排/审官流程不打架的根据）：
//   1. 只运默认分支——派生分支的「进主分支」属于 PR/审官闭环，land 拒绝代劳（拒绝≠帮忙 rebase）。
//   2. 只删「已合并进默认分支」的东西：分支用 git branch -d（未合并 git 自己会拒），
//      worktree 还要求树干净 + 非主树 + 非当前树 + 不挂默认分支 + orca 没在管。
//   3. 本地与远端发散 → 停手报告，不自动 rebase/merge（auto-merge-races 教训：追加会跟合并赛跑）。

/** 运不运、怎么运。ahead/behind 相对 origin/<defaultBranch>。 */
export function decideShip({ branch, defaultBranch, ahead, behind, hasOrigin }) {
  if (!branch || branch === 'HEAD') {
    return { action: 'refuse', reason: 'HEAD 游离（detached）——先落到分支再收工' };
  }
  if (branch !== defaultBranch) {
    return {
      action: 'refuse',
      reason: `当前在派生分支 ${branch}——进主分支走 PR/审官闭环（编排态）或先合进 ${defaultBranch}（停派工态），land 不代劳`,
    };
  }
  if (!hasOrigin) return { action: 'local-only', reason: '没有 origin 远端，只做本地清理' };
  if (ahead > 0 && behind > 0) {
    return { action: 'stop-diverged', reason: `与 origin/${defaultBranch} 发散（本地 ${ahead} / 远端 ${behind}）——人工决定 rebase 还是先看远端多了什么` };
  }
  if (ahead > 0) return { action: 'push', reason: `领先 ${ahead} 个提交，检查过了就推` };
  if (behind > 0) return { action: 'ff', reason: `落后 ${behind} 个提交，快进到远端` };
  return { action: 'clean', reason: '与远端一致，没有要运的' };
}

/** 删不删这条本地分支。merged = 已合并进默认分支（git branch --merged 的判定）。 */
export function decideBranchDelete({ name, merged, isDefault, isCurrent, checkedOutAt }) {
  if (isDefault) return { del: false, reason: '默认分支' };
  if (isCurrent) return { del: false, reason: '当前分支' };
  if (checkedOutAt) return { del: false, reason: `被 worktree 占用：${checkedOutAt}` };
  if (!merged) return { del: false, reason: '未合并——不是垃圾，是没做完的活' };
  return { del: true, reason: '已合并进默认分支' };
}

/** 拆不拆这棵 git worktree。 */
export function decideWorktreeRemove({ branch, merged, dirty, isMain, isCurrent, isDefaultBranch, orcaManaged, detached }) {
  if (isMain) return { remove: false, reason: '主树' };
  if (isCurrent) return { remove: false, reason: '自己所在的树' };
  if (orcaManaged) return { remove: false, reason: 'orca 在管（有卡/agent）——删卡走编排闭环，land 不碰' };
  if (isDefaultBranch) return { remove: false, reason: '挂着默认分支的树（如 mirasim 会话树）' };
  if (detached) return { remove: false, reason: 'HEAD 游离，判不了合没合并' };
  if (dirty) return { remove: false, reason: '有未提交改动——里面可能是别人半成品' };
  if (!merged) return { remove: false, reason: `分支 ${branch} 未合并` };
  return { remove: true, reason: `分支 ${branch} 已合并且树干净` };
}
