// scripts/lib/board-reset.mjs —— board-archive / board-reset 的纯函数层
//
// 场景：重测派单前「先存档再清盘」。盘面权威数据在 Orca 本机，存档也只留本机
// （~/.dao/board-archive/），不进任何 git 树（#558 三不要：记录类不要分支/评审/协同）。
//
// 硬规矩（与仓内守卫同原则）：
// - 没查成 ≠ 扫完是空的：任何一节采集失败，board-reset 一张卡都不删。
// - 主树（isMainWorktree）永不进清理名单。
// - 占用中（working/waiting agent）的卡不删，列清原因——先停 agent 再重跑。
// - 子卡不单独进名单：随父卡整树后序删（planWorktreeRm 的既有语义）。

/** 从 ps 的 worktrees 里挑出要清的顶层卡。主树进 guarded（永不清），子卡跳过（随父卡走）。 */
export function planBoardTargets(worktrees) {
  if (!Array.isArray(worktrees)) {
    return { ok: false, error: '盘面没查成（worktrees 不是数组）', targets: [], guarded: [] };
  }
  const targets = [];
  const guarded = [];
  for (const w of worktrees) {
    if (!w || typeof w !== 'object') continue;
    const id = w.worktreeId || w.id || null;
    const name = w.displayName || id || '(无名卡)';
    if (w.isMainWorktree) { guarded.push({ id, name, why: '主树永不删' }); continue; }
    if (w.isArchived) continue;
    if (w.parentWorktreeId) continue;
    if (!id) {
      return { ok: false, error: `卡 ${name} 没有 id，清理名单没查成，一张都不删`, targets: [], guarded: [] };
    }
    targets.push({ id, name, path: w.path || null });
  }
  return { ok: true, targets, guarded };
}

function fmtSectionLine(label, section) {
  if (!section || section.ok !== true) return `- ${label}：没查成（${section?.error || '缺节'}）`;
  return `- ${label}：${Array.isArray(section.data) ? section.data.length : 0}`;
}

/** 把快照渲染成人读 markdown 摘要。没查成的节必须显形，不许装成空。 */
export function formatBoardArchiveMd(snapshot) {
  const s = snapshot?.sections || {};
  const lines = [];
  lines.push(`# Orca 盘面存档 ${snapshot?.ts || '(无时间戳)'}`);
  lines.push('');
  lines.push(fmtSectionLine('卡片', s.worktrees));
  lines.push(fmtSectionLine('终端', s.terminals));
  lines.push(fmtSectionLine('工人（workers）', s.workers));
  lines.push(fmtSectionLine('Run', s.runs));
  lines.push(fmtSectionLine('信箱消息', s.inbox));
  lines.push('');
  if (s.worktrees?.ok === true && Array.isArray(s.worktrees.data)) {
    lines.push('## 卡片');
    lines.push('');
    for (const w of s.worktrees.data) {
      if (!w || typeof w !== 'object') continue;
      const id = w.worktreeId || w.id || '?';
      const name = w.displayName || id;
      const tags = [];
      if (w.isMainWorktree) tags.push('主树');
      if (w.isArchived) tags.push('已归档');
      if (w.parentWorktreeId) tags.push(`子卡 of ${w.parentWorktreeId}`);
      const states = (Array.isArray(w.agents) ? w.agents : []).map(a => a && a.state).filter(Boolean);
      if (states.length) tags.push(`agent=${states.join(',')}`);
      const links = [];
      if (w.linkedIssue != null) links.push(`issue #${w.linkedIssue}`);
      if (w.linkedPR != null) links.push(`PR #${w.linkedPR}`);
      lines.push(`- ${name}（${id}）${tags.length ? ` [${tags.join('；')}]` : ''}${links.length ? ` 关联 ${links.join(' ')}` : ''}`);
      if (w.path) lines.push(`  - 路径：${w.path}`);
      if (w.branch) lines.push(`  - 分支：${w.branch}`);
    }
    lines.push('');
  }
  const bad = Object.entries(s).filter(([, v]) => v && v.ok !== true);
  if (bad.length) {
    lines.push('## 没查成的节（≠ 扫完是空的）');
    lines.push('');
    for (const [k, v] of bad) lines.push(`- ${k}：${v.error || '没查成'}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** 清盘结果判定：有跳过/失败/收尾 gc 失败都不算清干净。 */
export function boardResetVerdict({ removed, skipped, gc } = {}) {
  const removedCount = Array.isArray(removed) ? removed.length : 0;
  const skippedCount = Array.isArray(skipped) ? skipped.length : 0;
  const gcOk = gc == null ? true : gc.ok === true;
  const ok = skippedCount === 0 && gcOk;
  const parts = [`已清 ${removedCount} 张`];
  if (skippedCount) parts.push(`跳过 ${skippedCount} 张（原因逐条见 skipped）`);
  if (!gcOk) parts.push(`收尾 run-gc 没成功：${gc?.error || `${gc?.failedCount ?? '?'} 条退役失败`}`);
  if (skippedCount === 0 && gcOk) parts.push('盘面已清干净');
  else parts.push('盘面没清干净，按 skipped/gc 逐条处理后重跑');
  return { ok, removedCount, skippedCount, gcOk, line: parts.join('；') };
}
