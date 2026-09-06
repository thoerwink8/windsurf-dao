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
 * 目录探测三态。**不能用 `existsSync`**（审官 PR #1075 判红第 1 条实咬）：
 * 它在权限错误等 stat 失败时同样回 false，于是「目录不可访问」又被洗成「没有树」——
 * 正是本文件要消除的那个 fail-open，换个地方原样复现。
 * 只有 ENOENT / ENOTDIR 才算「确实不存在」，其它错误一律没查成。
 *
 * @param {(p:string)=>any} stat 抛错时错误对象要带 code（node:fs 的 statSync 就是）
 * @returns {{kind:'yes'|'no'|'unscanned', error?:string}}
 */
export function probeDir(stat, path) {
  if (typeof stat !== 'function') return { kind: 'unscanned', error: '没给 stat（没查成）' };
  try {
    const st = stat(path);
    if (st && typeof st.isDirectory === 'function' && !st.isDirectory()) {
      return { kind: 'no' };
    }
    return { kind: 'yes' };
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'no' };
    return { kind: 'unscanned', error: `${path} 探不了：${code || String(e?.message || e)}（没查成）` };
  }
}

/**
 * 扫 mirasim 在管的树，产出与 orca 盘面兼容的形状（`linkedIssue` / `displayName`），
 * 好让 cardNumbersFromWorktrees 这类既有判定器不用改。
 *
 * @param {{root?:string, repo?:string, readdir:(p:string)=>string[], stat:(p:string)=>any, join:(...xs:string[])=>string}} io
 * @returns {{scanned:boolean, error?:string, worktrees:Array}}
 */
export function scanMirasimTrees({ root = DEFAULT_MIRASIM_ROOT, repo, readdir, stat, join } = {}) {
  if (typeof readdir !== 'function' || typeof stat !== 'function' || typeof join !== 'function') {
    return { scanned: false, error: 'scanMirasimTrees 没拿到 io（没查成，不许当成没有树）', worktrees: [] };
  }
  if (!root) return { scanned: false, error: 'mirasim 树根没给（没查成）', worktrees: [] };
  const rootProbe = probeDir(stat, root);
  if (rootProbe.kind === 'unscanned') {
    return { scanned: false, error: `mirasim 树根${rootProbe.error}`, worktrees: [] };
  }
  if (rootProbe.kind === 'no') {
    // 根目录**确实不存在** = 这台机器上没有 mirasim 在管树，这是查成了的空盘面。
    // 「读不了」走上面那支，不到这里。
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
    const probe = probeDir(stat, dir);
    // 仓目录读不了不许静默跳过：跳过 = 它下面的树全不算在途 = 全被重复派。
    if (probe.kind === 'unscanned') {
      return { scanned: false, error: `mirasim 仓目录${probe.error}`, worktrees: [] };
    }
    if (probe.kind === 'no') continue;
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
