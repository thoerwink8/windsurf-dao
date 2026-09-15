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

/** 历史上最后一条判别态若是 APPROVED，取出它打在哪个 commit 上。 */
export function lastApprovedCommitId(reviews) {
  if (!Array.isArray(reviews)) return { scanned: false };
  let last = null;
  for (const rv of reviews) {
    const state = normalizeReviewState(rv);
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED') continue;
    const cid = reviewCommitId(rv);
    if (!cid) return { scanned: false, reason: 'commit-id-unscanned' };
    last = { state, cid };
  }
  if (!last || last.state !== 'APPROVED') return { scanned: true, commit: null };
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
 * redAtHead：当前 head 上最后一条是红——聚合 APPROVED 也压不掉。
 * decisionApproved：GitHub 聚合 reviewDecision。签名保留（#1225 仍会传入），
 *   但不能单独代替 HEAD 证据，也不参与放行。
 * dock：needsDockProof 时必须是 { state:'ok' }；没证明 / 红 / unknown 都不放行。
 *
 * mergePolicy 是 #1225 的事，本函数不认、不复制。
 */
export function approvedToLand({
  greenAtHead = false,
  decisionApproved = false,
  atHead = null,
  lastJudgment = null,
  redAtHead = false,
  dock = null,
} = {}) {
  void decisionApproved;
  if (redAtHead === true) return false;
  if (greenAtHead === true) return true;
  if (needsDockProof({ greenAtHead, atHead, lastJudgment })) {
    return !!(dock && dock.state === DOCK_OK);
  }
  return false;
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
