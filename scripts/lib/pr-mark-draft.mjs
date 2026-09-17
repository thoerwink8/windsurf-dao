// scripts/lib/pr-mark-draft.mjs —— m=manual 转 draft（#1223 第 3 点）
//
// 审官任务书原先直接调 `gh-as reviewer -- pr ready --undo`。GitHub 拒了
// （convertPullRequestToDraft 权限不足）时没有任何账本事件，指挥官还当
// draft 合门挂着——#1218 就是这样被自动化合并的。
//
// 本函数：转成了才算成；失败必须带 escalate，不许静默当转成了。

export function planMarkDraft({ pr, run } = {}) {
  if (pr == null || String(pr).trim() === '') {
    return { ok: false, unscanned: true, error: '没给 PR 号——没查成，不装成转成了' };
  }
  if (typeof run !== 'function') {
    return { ok: false, unscanned: true, error: '没给 run——没查成，不装成转成了' };
  }
  const r = run(['node', 'scripts/gh-as.mjs', 'reviewer', '--', 'pr', 'ready', String(pr), '--undo']);
  if (r && r.ok === true) return { ok: true, pr: Number(pr) || pr };
  const detail = (r && (r.error || r.out)) || '命令失败';
  return {
    ok: false,
    escalate: true,
    reason: 'manual-draft-failed',
    pr: Number(pr) || pr,
    error: String(detail).trim().slice(0, 240),
    why: `PR #${pr} 转 draft 失败：${String(detail).trim().slice(0, 180)}——m=manual 的 GitHub 合门没挂上，必须报帅，不许静默当转成了`,
  };
}
