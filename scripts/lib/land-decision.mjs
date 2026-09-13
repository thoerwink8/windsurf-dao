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
 * mergePolicy：这张 PR 的合门（'manual' | 'auto' | null）。见下。
 *
 * ── mergePolicy 为什么必须是一路输入（2026-09-13 实咬 #1218 / #1223）──
 *
 * 改之前，`m=manual` 的**唯一实现**是调用点的 `pr.isDraft`：manual 的 PR 只要还是 draft
 * 就报帅等拍板，一旦不是 draft 就直接合——`approvedToLand` 的签名里根本没有 mergePolicy。
 * 那不是一道闸，是「希望 draft 位别丢」的约定。
 *
 * 2026-09-13 现场：PR #1218（type/体系，manual）转 draft 被 GitHub 拒
 * （`Resource not accessible by integration (convertPullRequestToDraft)`）→ 不再是 draft
 * → 判绿 → 被 app/dao-marshal 自动合并（07:15:53Z）。整件事在账本里 0 条事件。
 *
 * 为什么不能从 `isDraft` 反推：draft 是 GitHub 侧的一个状态位，API 权限、webhook 竞态、
 * 有人点 Ready for review 都能把它拿掉，而它被谁拿掉都不通知我们——失效是**静默**的。
 * 我们自己的决定（谁写码、谁来审、要不要人拍）应当在产生那一刻写一次，
 * 一路带到消费那一刻，而不是每次从别人的状态反推。
 *
 * 收严的口径（用户 2026-09-13 拍板，选项①）：
 *   · `auto` 或未提供（null）→ 维持现有判定，**不收紧**（老调用方/夹具不受影响）；
 *   · `manual` → 判绿**不足以**放行，必须由调用点另行核对拍板证据
 *     （`canReleaseApprovedDraft` 那一套：批准单 + 当前 head + 全绿 CI）。
 *     本函数只负责「不给绿放行」这一半——它不自己去读证据，因为证据在 PR 正文与 issue 上，
 *     读它们要出网，这里保持纯函数。
 */
export function approvedToLand({
  greenAtHead = false,
  decisionApproved = false,
  atHead = null,
  lastJudgment = null,
  mergePolicy = null,
  mergePolicySource = null,
} = {}) {
  const green = greenAtHead === true || decisionApproved === true
    || (atHead === 0 && lastJudgment === 'APPROVED');
  if (!green) return false;
  // manual：判绿也不放行。是否真能合，由调用点拿拍板证据另判。
  //
  // **只认「查过、确实是 manual」那两档**（framework / hold）：
  //   · framework —— issue 带 type/体系，是查到的；
  //   · hold      —— classifyAsk 命中 human_holds，也是查到的。
  // `unscanned` 那一档**不拦**：它代表「issue 没扫到 / 正文没读成」，不是「查过是 manual」。
  // 拿它当 manual 会把「这轮没扫到这张 PR 的 issue」变成「所有 PR 都不许合」——
  // 2026-09-13 写完本条当场被 tests/exhausted.test.js 抓住：夹具只给 prs 不给 issues，
  // 于是每条判绿的 PR 都变成「待人工合并」，把一整片无关用例打红。
  // 没查成是「这条判据这轮不生效」，与「查过确实是 manual」是两回事。
  if (mergePolicy === 'manual' && mergePolicySource !== 'unscanned') return false;
  return true;
}

/**
 * `m=manual` 的 PR 能不能合——拍板证据齐不齐。
 *
 * 与 `canReleaseApprovedDraft` 分开写，因为那个函数要求 `pr.isDraft === true`
 * （它服务的是「draft 收口泵」那条路），而本函数要吃 **非 draft** 的 manual PR——
 * 正是 #1218 漏掉的那一格。
 *
 * 证据三条，缺一不合：
 *   ① 有明确的批准单（正文只署一张，且是 issue 不是 PR）；
 *   ② 那张单带「已拍板」+「已消歧」——人真的拍过；
 *   ③ 审查绿在当前 head 上，且 CI 全绿。
 */
export function manualMergeApproved({ pr, issue, greenAtHead, evidence = {} } = {}) {
  if (!pr || !issue) return { ok: false, why: '没给 pr / issue——没查成，不合' };
  const { explicitApprovalIssue, isApprovedExecutionTask, checksSucceeded } = evidence;
  if (typeof explicitApprovalIssue !== 'function' || typeof isApprovedExecutionTask !== 'function'
    || typeof checksSucceeded !== 'function') {
    return { ok: false, why: '拍板证据的判据没给全——没查成，不合' };
  }
  if (greenAtHead !== true) return { ok: false, why: '当前 head 上审查没绿' };
  if (!checksSucceeded(pr)) return { ok: false, why: '有 check 没成功（没查成 ≠ 绿）' };
  const n = explicitApprovalIssue(pr);
  if (n == null || n !== Number(issue.number)) {
    return { ok: false, why: `正文没有唯一的批准单署名（解析得 ${n == null ? '空' : `#${n}`}，单是 #${issue.number}）` };
  }
  if (!isApprovedExecutionTask(issue)) {
    return { ok: false, why: '批准单上没有「已拍板」+「已消歧」两个标——人还没拍' };
  }
  return { ok: true, why: '有批准单且当前 head 审查与 CI 均绿' };
}
