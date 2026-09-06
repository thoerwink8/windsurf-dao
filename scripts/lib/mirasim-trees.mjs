// scripts/lib/mirasim-trees.mjs —— mirasim 在管工作树的盘面（在途判据的采样面）
//
// 2026-09-06 实咬：指挥官判「这张 issue 有没有在途派工」时，卡面用的是
// `orca.worktrees`。orca 退役后那一段恒 `scanned:false`，而调用处写着
// `orca.worktrees || []` —— **把「没查成」洗成了「查过没有」**。
// 于是任何「已消歧 + 标签齐 + 还没开 PR」的 issue，每 20 分钟被重复派一次。
// #965 就是当场撞上的：我手动派完，同一份态势里指挥官仍说「无在途派工」。
//
// 采样面换成 mirasim 自己的工作树目录（它是这些树的所有者）。
// 「读不了目录」和「目录下没有树」必须分得开——前者是没查成，后者才是真的没有。
//
// 路径形状（与 scripts/nudge-stalled.mjs 的 idOfTree 同源，那个是垫片，退役时以本文件为准）：
//   <root>/<repo>/dao-<N>            工人树
//   <root>/<repo>/dao-<N>-2          同一单的第 2 棵（重派/解冲突）
//   <root>/<repo>/dao-review-pr-<N>  审官树（挂 PR 号，不是 issue 号）

export const DEFAULT_MIRASIM_ROOT = '/home/orca/mirasim-worktrees';

/**
 * 目录名 → 盘面身份。认不出回 null（不猜）：临时树没有单号，也就不该被算成在途派工。
 * @returns {{kind:'工人'|'审官', number:number, name:string}|null}
 */
export function identifyTreeDir(name) {
  const s = String(name || '');
  const r = /^dao-review-pr-(\d+)$/.exec(s);
  if (r) return { kind: '审官', number: Number(r[1]), name: s };
  const w = /^dao-(\d+)(?:-\d+)?$/.exec(s);
  if (w) return { kind: '工人', number: Number(w[1]), name: s };
  return null;
}

/**
 * 扫 mirasim 在管的树，产出与 orca 盘面兼容的形状（`linkedIssue` / `displayName`），
 * 好让 cardNumbersFromWorktrees 这类既有判定器不用改。
 *
 * @param {{root?:string, repo?:string, readdir:(p:string)=>string[], exists:(p:string)=>boolean, join:(...xs:string[])=>string}} io
 * @returns {{scanned:boolean, error?:string, worktrees:Array}}
 */
export function scanMirasimTrees({ root = DEFAULT_MIRASIM_ROOT, repo, readdir, exists, join } = {}) {
  if (typeof readdir !== 'function' || typeof exists !== 'function' || typeof join !== 'function') {
    return { scanned: false, error: 'scanMirasimTrees 没拿到 io（没查成，不许当成没有树）', worktrees: [] };
  }
  if (!root) return { scanned: false, error: 'mirasim 树根没给（没查成）', worktrees: [] };
  if (!exists(root)) {
    // 根目录不在 = 这台机器上没有 mirasim 在管树，这是**查成了**的空盘面，不是没查成。
    return { scanned: true, worktrees: [], empty: true, why: `树根不在：${root}` };
  }
  let repos;
  try {
    repos = repo ? [repo] : readdir(root);
  } catch (e) {
    return { scanned: false, error: `mirasim 树根读不了 ${root}：${String(e?.message || e)}（没查成）`, worktrees: [] };
  }
  const worktrees = [];
  for (const r of repos) {
    const dir = join(root, r);
    if (!exists(dir)) continue;
    let names;
    try {
      names = readdir(dir);
    } catch (e) {
      return { scanned: false, error: `mirasim 树目录读不了 ${dir}：${String(e?.message || e)}（没查成）`, worktrees: [] };
    }
    for (const n of names) {
      const id = identifyTreeDir(n);
      if (!id) continue;
      const path = join(dir, n);
      worktrees.push({
        worktreeId: path,
        path,
        repo: r,
        kind: id.kind,
        // 工人树挂 issue 号；审官树挂的是 PR 号，**不能当 linkedIssue**，
        // 否则「PR #965 的审官树」会被当成「issue #965 已在途」。
        linkedIssue: id.kind === '工人' ? id.number : null,
        pr: id.kind === '审官' ? id.number : null,
        displayName: id.kind === '工人' ? `ISSUE-#${id.number} 工人` : `PR-#${id.number} 审官`,
        isMainWorktree: false,
        isArchived: false,
      });
    }
  }
  return { scanned: true, worktrees };
}
