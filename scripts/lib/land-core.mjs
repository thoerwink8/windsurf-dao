// land 收工决策层（2026-08-31 拍板：commit 后推主分支 + 清已合并派生物，做成一条幂等命令）。
// 全部判断在这层纯函数里，tests/land.test.js 拿假盘面逐类验判别力；land.mjs 只执行不判断。
//
// 三条安全底线（与 orca 编排/审官流程不打架的根据）：
//   1. 只运默认分支——派生分支的「进主分支」属于 PR/审官闭环，land 拒绝代劳（拒绝≠帮忙 rebase）。
//   2. 只删「已合并进默认分支」的东西：判据见 judgeBranchGone（按内容判，不按提交号判——#839），
//      worktree 还要求树干净 + 非主树 + 非当前树 + 不挂默认分支 + orca 没在管。
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
 * 审官分支名里的 PR 号。orca 把卡名「PR-#820 审官·gpt-5.6-sol」落成分支 PR-820-审官-gpt-5.6-sol。
 * 不带「审官」二字的一律回 null——工人分支另有闭环，不许被审官那条规则顺手删掉。
 */
export function reviewerBranchPr(name) {
  const s = String(name || '');
  if (!/审官/.test(s)) return null;
  const m = s.match(/PR[-#\s]*(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * 采集「合没合并」要的两条事实。git 调用由外面注入（land.mjs 传它自己那个 git()，
 * 测试传真 git 临时仓的 runner），这层不 import child_process——判断层保持零依赖、可单测。
 *
 * @param git (args) => { status, out }，同 land.mjs 里的 git()
 * @returns {{ ancestor: boolean|null, contributes: boolean|null }}
 *   ancestor    分支 tip 是不是 defaultBranch 的祖先（null = 没查成）
 *   contributes 把分支合进 defaultBranch 之后树变不变：
 *               false = 合了等于没合（内容已全在主分支）；true = 真有主分支没有的东西；
 *               null  = 合不干净或 git 太老（需 git ≥ 2.38），判不了
 */
export function collectBranchMergeFacts({ git, branch, defaultBranch }) {
  if (typeof git !== 'function' || !branch || !defaultBranch) {
    return { ancestor: null, contributes: null, everHadContent: null };
  }
  const anc = git(['merge-base', '--is-ancestor', branch, defaultBranch]);
  const ancestor = anc.status === 0 ? true : anc.status === 1 ? false : null;

  // 这支**有没有过自己的改动**（相对它和主分支的分叉点）。少了这一问，按内容判会误删刚开工的分支：
  // 工人开工第一步就是 `git commit --allow-empty -m "起<任务>分支"`，那支的内容与主分支一模一样，
  // 「合进去等于没合」对它恒成立——2026-09-05 接线时被 land e2e 当场拦下（「未合并支必须留」）。
  // 分界：squash 合并的分支**有过真改动**（只是被压成了新 commit）；空提交撑的分支**从来没有过**。
  let everHadContent = null;
  const base = git(['merge-base', defaultBranch, branch]);
  if (base.status === 0) {
    const baseOid = String(base.out).trim();
    const diff = git(['diff', '--quiet', baseOid, branch]);
    // --quiet：0 = 无差异，1 = 有差异，其余 = 没查成
    everHadContent = diff.status === 0 ? false : diff.status === 1 ? true : null;
  }
  // merge-tree --write-tree 把两边合一次只吐树号：合出来的树 == 默认分支自己的树 ⇒ 这支合进去等于没合。
  // squash 合并后的原分支正是这个形状（提交号全不同、内容一模一样），提交号类判据全部失手。
  let contributes = null;
  const mt = git(['merge-tree', '--write-tree', defaultBranch, branch]);
  if (mt.status === 0) {
    const t = git(['rev-parse', `${defaultBranch}^{tree}`]);
    if (t.status === 0) contributes = String(mt.out).trim().split('\n')[0].trim() !== String(t.out).trim();
  }
  return { ancestor, contributes, everHadContent };
}

/**
 * 分支上还有没有「主分支缺的东西」——删分支和拆树共用这一把尺（一把尺只在一处）。
 *
 * 2026-09-03 实咬（#839）：PR 走 squash 合并后 master 上是一个全新提交，原分支的提交号在
 * master 里根本不存在，`git branch --merged` 于是永远判「未合并」，PR-820/821/830 三条审官分支
 * （零提交、纯粹是 PR head 的副本）被当成「没做完的活」永久留着，每合一个 PR 漏一条，只增不减。
 * 所以判据必须按**内容**判，不能按提交号判。
 *
 * 输入全是查好的事实，判不了就 null——「没查成」和「查过没事」在 reason 里必须分得开：
 *   merged       git branch --merged 的老判据（tip 是不是祖先）。true/false。
 *   contributes  见 collectBranchMergeFacts。undefined = 压根没探（老调用方，行为不变）；
 *                null = 探了没探成（合不干净/git 太老）——这一条一律不删。
 *   prState      分支对应 PR 的态 'MERGED'|'CLOSED'|'OPEN'。land 不依赖 gh，不传就不启用这条判据。
 *
 * @returns {{ gone: boolean, how: string|null, reason: string }}
 *   gone=true  没有主分支缺的东西了，可以删；how 说明凭哪条判的（决定删分支用 -d 还是 -D）
 *   gone=false reason 必须说清是「没做完」「没查成」还是「审官动了代码」——三者不许混成一句
 */
export function judgeBranchGone({ name, merged, contributes, everHadContent, prState } = {}) {
  // 祖先关系是无条件安全的，先判：tip 都在主分支里了，怎么删都丢不了东西。
  if (merged === true) return { gone: true, how: 'ancestor', reason: '已合并进默认分支' };

  // 审官分支：它本来就是 PR head 的只读副本，不该有自己的提交（有 = 审官改了代码，要报出来）。
  const pr = reviewerBranchPr(name);
  const st = String(prState || '').toUpperCase();
  if (pr != null && (st === 'OPEN' || st === 'MERGED' || st === 'CLOSED')) {
    if (st === 'OPEN') return { gone: false, how: null, reason: `审官分支，PR #${pr} 还开着——审没审完不由 land 判` };
    if (contributes === true) {
      return { gone: false, how: null, reason: `审官分支却有主分支没有的提交——审官不该改代码，要人看（PR #${pr} 已 ${st}）` };
    }
    return { gone: true, how: 'reviewer-pr-done', reason: `审官分支，PR #${pr} 已 ${st}，且没有自己的提交` };
  }

  if (contributes === false) {
    // 「合进去等于没合」对**从来没有过自己改动**的分支恒成立——工人开工第一步的空提交撑支
    // 就是这个形状。拿它当「已 squash 合并」会删掉刚开工的活（2026-09-05 被 land e2e 拦下）。
    // squash 过的分支有过真改动、只是被压成了新 commit；空提交撑的分支从来没有过，两者靠这一问分开。
    if (everHadContent === false) {
      return { gone: false, how: null, reason: '这支从来没有过自己的改动（空提交撑的分支）——不是 squash 合并完的残支，不删' };
    }
    // null = 探了没探成；undefined = 老调用方压根没探（行为与本次改动前一致，不回归）。两者必须分开。
    if (everHadContent === null) {
      return { gone: false, how: null, reason: '这支有没有过自己的改动没查成——没查成不是没事，本轮不动' };
    }
    return { gone: true, how: 'squash-content', reason: '合进默认分支等于没合，内容已全在（squash 合并后就是这个形状）' };
  }
  if (contributes === null) {
    return { gone: false, how: null, reason: '合没合并没查成（merge-tree 判不了：合不干净或 git 太老）——没查成不是没事，本轮不动' };
  }
  return { gone: false, how: null, reason: '未合并——不是垃圾，是没做完的活' };
}

/**
 * 删这条分支该用哪个 flag。默认 -d（git 自己再拦一道未合并，这是底线 2 的兜底）；
 * 只有**按内容证明过**「合进去等于没合」的两种情形才敢用 -D——因为 squash 之后 -d 必然拒绝，
 * 而那个拒绝正是 #839 的病。how 认不出一律回 -d：宁可删不掉，不可删错。
 */
export function branchDeleteFlag(how) {
  return (how === 'squash-content' || how === 'reviewer-pr-done') ? '-D' : '-d';
}

/**
 * 删不删这条本地分支。merged/contributes/prState 三条事实见 judgeBranchGone；
 * 只传 merged = 老调用方，行为与改判据前一致。回值多带 how/flag 给执行层挑 -d 还是 -D。
 */
export function decideBranchDelete({ name, merged, contributes, everHadContent, prState, isDefault, isCurrent, checkedOutAt }) {
  if (isDefault) return { del: false, reason: '默认分支' };
  if (isCurrent) return { del: false, reason: '当前分支' };
  if (checkedOutAt) return { del: false, reason: `被 worktree 占用：${checkedOutAt}` };
  const g = judgeBranchGone({ name, merged, contributes, everHadContent, prState });
  return { del: g.gone, reason: g.reason, how: g.how, flag: branchDeleteFlag(g.how) };
}

/** 拆不拆这棵 git worktree。合没合并与删分支同一把尺（审官树漏拆和审官分支漏删是同一个病）。 */
export function decideWorktreeRemove({ branch, merged, contributes, everHadContent, prState, dirty, isMain, isCurrent, isDefaultBranch, orcaManaged, detached }) {
  if (isMain) return { remove: false, reason: '主树' };
  if (isCurrent) return { remove: false, reason: '自己所在的树' };
  if (orcaManaged) return { remove: false, reason: 'orca 在管（有卡/agent）——删卡走编排闭环，land 不碰' };
  if (isDefaultBranch) return { remove: false, reason: '挂着默认分支的树（如 mirasim 会话树）' };
  if (detached) return { remove: false, reason: 'HEAD 游离，判不了合没合并' };
  if (dirty) return { remove: false, reason: '有未提交改动——里面可能是别人半成品' };
  const g = judgeBranchGone({ name: branch, merged, contributes, everHadContent, prState });
  if (!g.gone) return { remove: false, reason: `分支 ${branch}：${g.reason}` };
  return { remove: true, reason: `分支 ${branch} ${g.reason}，且树干净`, how: g.how };
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
