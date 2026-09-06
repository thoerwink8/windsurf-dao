// 推一把跳过已结束的单。纯函数，IO 在 CLI。
// 没查成 ⇒ skip（fail-close）：查不清就推，会把已关单再烧一轮（#1097 实咬）。

export function shouldSkipNudge({ kind, issueState, prState, issueUnscanned, prUnscanned } = {}) {
  if (kind === '工人') {
    if (issueUnscanned) return { skip: true, why: 'issue 态没查成，不推' };
    if (String(issueState || '').toUpperCase() === 'CLOSED') return { skip: true, why: 'issue 已关' };
    return { skip: false };
  }
  if (kind === '审官') {
    if (prUnscanned) return { skip: true, why: 'PR 态没查成，不推' };
    const st = String(prState || '').toUpperCase();
    if (st === 'MERGED' || st === 'CLOSED') return { skip: true, why: `PR 已${st}` };
    return { skip: false };
  }
  return { skip: true, why: '认不出工人/审官，不推' };
}
