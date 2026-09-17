// scripts/lib/land-decision.mjs —— 核绿之后怎么合、落后要不要再审（ephemeral-lifecycle）
//
// 拍板：审查看这份 diff；合入是 squash 打到此刻的 master。落后 ≠ 冲突。
//
// #1133 续项（评论 5688676783）：旧批准不能裸继承。当前 head 独立审查绿才通常放行；
// GitHub 聚合 APPROVED 不能压过当前 HEAD 的 CHANGES_REQUESTED，也不能单独代替 HEAD 证据。
// 纯 master 对接可以继承，但必须有绑定「批准 commit / 目标 HEAD / master」的树级三态证明。
// 双亲 merge commit、提交标题、祖先关系都不是正控。

import { normalizeReviewState } from './review-state.mjs';

export const DOCK_OK = 'ok';
export const DOCK_RED = 'red';
export const DOCK_UNKNOWN = 'unknown';

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
 * 历史上最后一条判别态若是 APPROVED，取出它打在哪个 commit 上。
 * DISMISSED 终止继承：其后若没有新的 APPROVED，commit 为空且 revoked=true。
 */
export function lastApprovedCommitId(reviews) {
  if (!Array.isArray(reviews)) return { scanned: false };
  let last = null;
  for (const rv of reviews) {
    const state = normalizeReviewState(rv);
    if (state === 'DISMISSED') {
      last = { state: 'DISMISSED', cid: reviewCommitId(rv) || null };
      continue;
    }
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED') continue;
    const cid = reviewCommitId(rv);
    if (!cid) return { scanned: false, reason: 'commit-id-unscanned' };
    last = { state, cid };
  }
  if (!last || last.state !== 'APPROVED') {
    return {
      scanned: true,
      commit: null,
      ...(last && last.state === 'DISMISSED' ? { revoked: true } : {}),
    };
  }
  return { scanned: true, commit: last.cid };
}

function reviewCommitId(rv) {
  if (!rv || typeof rv !== 'object') return '';
  return String(rv.commit_id || rv.commitId || (rv.commit && rv.commit.oid) || '').trim();
}

/**
 * 当前 head 没有新判定、历史上最后一条是 APPROVED：这是「也许只是对接了 master」。
 * 没有三态证明之前，不得当可合。
 */
export function needsDockProof({
  greenAtHead = false,
  atHead = null,
  lastJudgment = null,
} = {}) {
  return greenAtHead !== true && atHead === 0 && lastJudgment === 'APPROVED';
}

/**
 * 这张 PR 现在能不能当「审官已经放行、可以合入」。
 *
 * greenAtHead：当前 head 上最后一条是绿。
 * latestRed / redAtHead：当前 head 上最后一条是红——**优先于**聚合 APPROVED / 旧 head 绿。
 * decisionApproved：GitHub 聚合 reviewDecision。签名保留，但不能单独代替 HEAD 证据，也不参与放行。
 * dock：needsDockProof 时必须是 { state:'ok' }；没证明 / 红 / unknown 都不放行。
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
  latestRed = false,
  redAtHead = false,
  mergePolicy = null,
  mergePolicySource = null,
  dock = null,
} = {}) {
  void decisionApproved;
  void mergePolicySource;
  // 当前 HEAD 的红判定优先：聚合 reviewDecision 或旧 HEAD 的 APPROVED 不得开合门。
  // #1225 返工：列表快照还是 APPROVED、逐条 reviews 已是当前 HEAD CHANGES_REQUESTED
  // 时，旧公式仍把 decisionApproved 当绿，manual 出口产「待人工合并」把返工吃掉。
  if (latestRed === true || redAtHead === true) return false;
  let reviewGreen = false;
  if (greenAtHead === true) reviewGreen = true;
  else if (needsDockProof({ greenAtHead, atHead, lastJudgment })) {
    reviewGreen = !!(dock && dock.state === DOCK_OK);
  }
  if (!reviewGreen) return false;
  // manual：判绿也不放行。是否真能合，由调用点拿拍板证据另判。
  //
  // 三档都拦（#1223：没查成不许退回 auto）：
  //   · framework —— issue 带 type/体系；
  //   · hold      —— classifyAsk 命中 human_holds；
  //   · unscanned —— 账本/署名单没查成。旧实现把这一档排除出闸，于是
  //     「署名 issue 没扫到」直接产 merge。mergePolicySource 仍接收，供调用点留痕。
  if (mergePolicy === 'manual') return false;
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

/**
 * 树级纯对接判据。正控只有「批准 commit 与 HEAD 各自对当前 master 做虚拟合入，得到同一棵树」。
 * 双亲 / 标题 / 祖先即使传入也当不存在——那些不是证明。
 *
 * 三态：ok / red / unknown。冲突、对象读失败、虚拟合入没跑成 → unknown，不得放行。
 */
export function judgePureDock(facts = {}) {
  const approved = String(facts.approved || '').trim();
  const head = String(facts.head || '').trim();
  const master = String(facts.master || '').trim();
  if (facts.objectReadFailed === true) {
    return { state: DOCK_UNKNOWN, why: '对象读取失败，不得放行' };
  }
  if (!approved || !head || !master) {
    return { state: DOCK_UNKNOWN, why: '三态证据不齐（批准 commit / HEAD / master）' };
  }
  if (facts.approvedMasterUnscanned === true || facts.headMasterUnscanned === true) {
    return { state: DOCK_UNKNOWN, why: '虚拟合入没跑成，不得放行' };
  }
  if (facts.approvedMasterConflict === true || facts.headMasterConflict === true) {
    return { state: DOCK_UNKNOWN, why: '虚拟合入有冲突，无法判定纯对接' };
  }
  const approvedMasterTree = String(facts.approvedMasterTree || '').trim();
  const headMasterTree = String(facts.headMasterTree || '').trim();
  if (!approvedMasterTree || !headMasterTree) {
    return { state: DOCK_UNKNOWN, why: '虚拟合入没产出树，不得放行' };
  }
  if (approvedMasterTree === headMasterTree) {
    return { state: DOCK_OK, why: 'HEAD 与批准 commit 对当前 master 的虚拟合入树相同——纯对接' };
  }
  return { state: DOCK_RED, why: 'HEAD 含批准之后的新树内容——不是纯对接' };
}

function parseMergeTree(r) {
  const out = String((r && r.out) || '');
  const first = out.trim().split(/\r?\n/)[0] || '';
  const tree = /^[0-9a-f]{40,}$/i.test(first) ? first.toLowerCase() : '';
  if (r && r.ok === true && tree) return { tree, conflict: false, unscanned: false };
  if (tree && r && r.ok === false) return { tree, conflict: true, unscanned: false };
  const err = `${out}\n${(r && (r.error || r.stderr)) || ''}`;
  if (r && r.ok === false && /conflict/i.test(err)) {
    return { tree: '', conflict: true, unscanned: false };
  }
  return { tree: '', conflict: false, unscanned: true };
}

/**
 * 生产取证：注入 run（argv → {ok,out,error}），用 git merge-tree --write-tree 做树级对比。
 * fetch 失败不直接判 unknown——本地对象在就继续；对象读不到才 unknown。
 */
export function provePureDock({
  approved,
  head,
  masterRef = 'origin/master',
  run,
} = {}) {
  if (typeof run !== 'function') {
    return { state: DOCK_UNKNOWN, why: '取证 run 没给' };
  }
  const a = String(approved || '').trim();
  const h = String(head || '').trim();
  const mref = String(masterRef || '').trim();
  if (!a || !h || !mref) {
    return { state: DOCK_UNKNOWN, why: '三态证据不齐（批准 commit / HEAD / master）' };
  }

  run(['git', 'fetch', '--quiet', 'origin', '+refs/heads/master:refs/remotes/origin/master']);
  run(['git', 'fetch', '--quiet', 'origin', a]);
  run(['git', 'fetch', '--quiet', 'origin', h]);

  const verify = (spec) => run(['git', 'rev-parse', '--verify', '--quiet', spec]);
  const aC = verify(`${a}^{commit}`);
  const hC = verify(`${h}^{commit}`);
  const mC = verify(`${mref}^{commit}`);
  if (!aC || aC.ok !== true || !hC || hC.ok !== true || !mC || mC.ok !== true) {
    return {
      state: DOCK_UNKNOWN,
      why: '对象读取失败，不得放行',
      approved: a,
      head: h,
      master: mref,
    };
  }
  const master = String(mC.out || '').trim();
  const mergeApproved = parseMergeTree(run(['git', 'merge-tree', '--write-tree', a, master]));
  const mergeHead = parseMergeTree(run(['git', 'merge-tree', '--write-tree', h, master]));
  const judged = judgePureDock({
    approved: a,
    head: h,
    master,
    approvedMasterTree: mergeApproved.tree,
    headMasterTree: mergeHead.tree,
    approvedMasterConflict: mergeApproved.conflict,
    headMasterConflict: mergeHead.conflict,
    approvedMasterUnscanned: mergeApproved.unscanned,
    headMasterUnscanned: mergeHead.unscanned,
  });
  return { ...judged, approved: a, head: h, master };
}
