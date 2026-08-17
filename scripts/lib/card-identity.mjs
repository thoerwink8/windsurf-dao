// 卡身份：判据走结构化字段，不读 displayName。
//
// #589：为人眼做的显示值不能回流当命令参数。是不是任务卡 / 子卡 / 审官卡
// 看 parentWorktreeId、dispatch 记账、childWorktreeIds，不看名字里有没有
// `#`、`·`、「审官」。改这段前必须知道：卡改名叫 zzz，四处判定必须不变。

export function worktreeIdOf(w) {
  return (w && (w.worktreeId || w.id)) || null;
}

export function isChildWorktree(w) {
  return !!(w && w.parentWorktreeId);
}

function idsEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right) return false;
  return left === right || left.endsWith(`::${right}`) || left.endsWith(right)
    || right.endsWith(`::${left}`) || right.endsWith(left);
}

export function isDispatchTracked(w, tracked) {
  if (!tracked || typeof tracked.has !== 'function') return false;
  const id = worktreeIdOf(w);
  if (id && (tracked.has(id) || [...tracked].some(t => idsEqual(t, id)))) return true;
  if (w && w.path && tracked.has(w.path)) return true;
  return false;
}

/**
 * 顶层任务卡：有 dispatch 记账，或顶层且像在干活（有 agent / 非 todo 状态）。
 * 子卡、主树、归档都不是任务卡。不读卡名。
 */
export function isTaskCard(w, { tracked } = {}) {
  if (!w || w.isMainWorktree === true || w.isArchived) return false;
  if (isChildWorktree(w)) return false;
  if (isDispatchTracked(w, tracked)) return true;
  const agents = Array.isArray(w.agents) ? w.agents : [];
  if (agents.length > 0) return true;
  const st = w.workspaceStatus;
  if (st && st !== 'todo') return true;
  return false;
}

export function classifyCardName(name) {
  const n = String(name || '').trim();
  if (/^(PR|ISSUE)-\d+ (工人|审官|辅助)·\S+/.test(n)) return 'new';
  if (/^#\d+ - /.test(n)) return 'legacy';
  return 'other';
}

export function findChildWorktrees(parent, worktrees) {
  const pid = worktreeIdOf(parent);
  const childIds = Array.isArray(parent?.childWorktreeIds) ? parent.childWorktreeIds : [];
  return (Array.isArray(worktrees) ? worktrees : []).filter(w => {
    const id = worktreeIdOf(w);
    if (id && childIds.some(c => idsEqual(c, id))) return true;
    if (pid && w && idsEqual(w.parentWorktreeId, pid)) return true;
    return false;
  });
}

function childHasDispatch(child, workers) {
  if (!Array.isArray(workers)) return false;
  const cid = worktreeIdOf(child);
  if (!cid) return false;
  return workers.some(w => idsEqual(w?.resource?.worktreeId, cid) || idsEqual(w?.worktreeId, cid));
}

/**
 * 找审官卡：工人卡的子卡，优先带 dispatch 记账的。不读卡名、不比对 issue/PR 号。
 */
export function findReviewerWorktree({ parent, worktrees, workers } = {}) {
  if (!parent) return { ok: false, error: '找审官没给工人卡' };
  if (!Array.isArray(worktrees)) {
    return { ok: false, unscanned: true, error: 'worktree 列表没查成，不许猜有没有审官卡' };
  }
  const children = findChildWorktrees(parent, worktrees);
  if (children.length === 0) {
    return { ok: false, error: '工人卡下没有子卡' };
  }
  const booked = Array.isArray(workers)
    ? children.filter(c => childHasDispatch(c, workers))
    : [];
  const pool = booked.length ? booked : children;
  pool.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  const pick = pool[0];
  return {
    ok: true,
    worktree: pick,
    worktreeId: worktreeIdOf(pick),
    via: booked.length ? '子卡+dispatch记账' : '子卡',
  };
}

/** 从卡上读 issue 号：linkedIssue / 定界区 / ISSUE- 前缀 / 旧 #N。PR- 不是 issue 号。 */
export function issueNumberFromWorktree(w) {
  if (!w) return null;
  if (typeof w.linkedIssue === 'number' && w.linkedIssue > 0) return w.linkedIssue;
  if (w.linkedIssue && typeof w.linkedIssue.number === 'number' && w.linkedIssue.number > 0) {
    return w.linkedIssue.number;
  }
  const zone = String(w.comment || '').match(/｜\[([^\]]*)\]/);
  if (zone) {
    const hit = zone[1].match(/#(\d+)/);
    if (hit) return Number(hit[1]);
  }
  const name = String(w.displayName || '');
  const issue = name.match(/ISSUE-(\d+)/);
  if (issue) return Number(issue[1]);
  const old = name.match(/^#(\d+)/);
  if (old) return Number(old[1]);
  return null;
}

/** 盘面给人看的号：linkedIssue / linkedPR / 卡名里的 PR-|ISSUE-|#N。 */
export function displayNumberFromWorktree(w) {
  const issue = issueNumberFromWorktree(w);
  if (issue) return issue;
  if (w && w.linkedPR && typeof w.linkedPR.number === 'number') return w.linkedPR.number;
  const name = String(w?.displayName || '');
  const pr = name.match(/PR-(\d+)/);
  if (pr) return Number(pr[1]);
  return null;
}
