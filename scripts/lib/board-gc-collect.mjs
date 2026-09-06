// board-gc 的采样面：mirasim 树 + /proc 活树。不读 orca。
// 「没查成」与「零棵树」必须分得开——orca 退役后 `result.worktrees` 不是数组，
// 旧 CLI 把它当没查成整轮 exit 2，回收永远转不起来（#1065）。

export function cardsFromMirasim(scan) {
  if (!scan || scan.scanned !== true) {
    return { ok: false, error: String((scan && scan.error) || 'mirasim 树没查成') };
  }
  if (!Array.isArray(scan.worktrees)) {
    return { ok: false, error: 'mirasim 树扫成了却没给数组（契约不符，没查成）' };
  }
  return {
    ok: true,
    worktrees: scan.worktrees.map((w) => ({
      ...w,
      id: w.worktreeId,
      linkedPR: w.pr ? { number: w.pr } : undefined,
    })),
  };
}

/**
 * busyTrees 的路径 → planBoardGc 的 aliveWorktreeIds（卡 id = 树路径）。
 * busy 没查成不许当成「没有活人」。
 */
export function aliveIdsFromBusy(busy, worktrees) {
  if (!busy || busy.ok !== true || !Array.isArray(busy.trees)) {
    return { ok: false, error: String((busy && busy.error) || '在途树没查成') };
  }
  const paths = new Set(busy.trees);
  const alive = new Set();
  for (const w of Array.isArray(worktrees) ? worktrees : []) {
    const id = w && (w.worktreeId || w.id);
    const p = w && w.path;
    if (id && (paths.has(p) || paths.has(id))) alive.add(id);
  }
  return { ok: true, alive };
}
