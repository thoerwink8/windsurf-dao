// land 收工决策层（2026-08-31 拍板：commit 后推主分支 + 清已合并派生物，做成一条幂等命令）。
// 全部判断在这层纯函数里，tests/land.test.js 拿假盘面逐类验判别力；land.mjs 只执行不判断。
//
// 三条安全底线（与 orca 编排/审官流程不打架的根据）：
//   1. 只运默认分支——派生分支的「进主分支」属于 PR/审官闭环，land 拒绝代劳（拒绝≠帮忙 rebase）。
//   2. 只删「已合并进默认分支」的东西：分支用 git branch -d（未合并 git 自己会拒），
//      worktree 还要求树干净 + 非主树 + 非当前树 + 不挂默认分支 + orca 没在管。
//      「已合并」由 landedMerged 一个函数说了算（留树/删支同源，#898）：ref 可达之外还要求
//      这条分支有过自己的提交——刚建还没提交的空分支 --merged 恒真，那是没开始不是干完了。
//   3. 本地与远端发散 → 停手报告，不自动 rebase/merge（auto-merge-races 教训：追加会跟合并赛跑）。

/** 哨兵那一行（收工提醒，非守卫）：只在默认分支确有未推提交时给一行；其余零输出。 */
export function landNoticeLine({ branch, defaultBranch, ahead }) {
  if (!branch || branch !== defaultBranch) return '';
  if (!Number.isFinite(ahead) || ahead <= 0) return '';
  return `[收工] ${defaultBranch} 领先远端 ${ahead} 个提交——收工跑 node scripts/land.mjs`;
}

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

/**
 * 「已合并」到底成不成立——留树与删支共用这一个判据（#898）。
 * merged = git branch --merged 说 tip 从默认分支可达；
 * everCommitted = 这条分支上有过自己的提交（tip 已离开创建基点）；null/false = 没有或没查成。
 * 刚 `worktree add -b` 出来、还没提交的分支 ref 与基点相等，--merged 恒真——那是「还没开始」，
 * 不是「干完合了」。#898 实咬：工人正在上面干活的空分支被当已合并清掉。
 */
export function landedMerged({ merged, everCommitted }) {
  return merged === true && everCommitted === true;
}

/** 删不删这条本地分支。merged/everCommitted 见 landedMerged。 */
export function decideBranchDelete({ name, merged, everCommitted, isDefault, isCurrent, checkedOutAt }) {
  if (isDefault) return { del: false, reason: '默认分支' };
  if (isCurrent) return { del: false, reason: '当前分支' };
  if (checkedOutAt) return { del: false, reason: `被 worktree 占用：${checkedOutAt}` };
  if (!merged) return { del: false, reason: '未合并——不是垃圾，是没做完的活' };
  if (!landedMerged({ merged, everCommitted })) {
    return { del: false, reason: everCommitted === null || everCommitted === undefined
      ? '有没有自己的提交没查成——没查成不是查过没事'
      : '还没有过自己的提交——是刚建没开始的活，不是已合并' };
  }
  return { del: true, reason: '已合并进默认分支' };
}

/** 拆不拆这棵 git worktree。merged/everCommitted 与删支共用 landedMerged（#898）。 */
export function decideWorktreeRemove({ branch, merged, everCommitted, dirty, isMain, isCurrent, isDefaultBranch, orcaManaged, detached }) {
  if (isMain) return { remove: false, reason: '主树' };
  if (isCurrent) return { remove: false, reason: '自己所在的树' };
  if (orcaManaged) return { remove: false, reason: 'orca 在管（有卡/agent）——删卡走编排闭环，land 不碰' };
  if (isDefaultBranch) return { remove: false, reason: '挂着默认分支的树（如 mirasim 会话树）' };
  if (detached) return { remove: false, reason: 'HEAD 游离，判不了合没合并' };
  if (dirty) return { remove: false, reason: '有未提交改动——里面可能是别人半成品' };
  if (!merged) return { remove: false, reason: `分支 ${branch} 未合并` };
  if (!landedMerged({ merged, everCommitted })) {
    return { remove: false, reason: `分支 ${branch} 还没有过自己的提交——刚建的树，工人可能正在上面开工` };
  }
  return { remove: true, reason: `分支 ${branch} 已合并且树干净` };
}

/**
 * 僵尸终端：orca 里登记着、但它挂的工位目录已经不在了（树被 land/worktree-rm 拆掉，终端登记留下来）。
 * 2026-09-04 实咬：服务器 70 个终端里 39 个是这种，探测每轮白扫、盘面看不清。
 * 只认「目录确实不存在」（exists === false）；探不到（null/undefined）一律不关——没查成不是没事。
 */
export function decideTerminalClose({ path, exists }) {
  if (!path) return { close: false, reason: '终端没挂工位（裸终端），不动' };
  if (exists !== false) return { close: false, reason: exists === true ? '工位目录还在' : '目录存在性没查成，不动' };
  return { close: true, reason: `工位目录已不在：${path}` };
}

/** precheck「有没有活」（#829）：有可运/可清 → true。判断只认上面 decide* 的结论，不另写闸。 */
export function hasLandWork({ shipAction, removeCount, deleteCount, zombieCount = 0 }) {
  if (shipAction === 'push' || shipAction === 'ff') return true;
  return (Number(removeCount) > 0) || (Number(deleteCount) > 0) || (Number(zombieCount) > 0);
}
