// 可立即起但没起（dao-check 第 ⑮ 项，issue #577）。
//
// 单独成文件只为一件事：tests/ready-queue.tests.js 喂 fixture 验判别力，
// 不必跑整个 dao-check（那会递归——dao-check 会跑 tests/，tests 再跑 dao-check）。
//
// 判据（#577 正文，本检查自己解析，不调用 dao-cmd / ⑭ 的 closesNumbers）：
//   可立即起 = open issue 带「已消歧」label
//              + 无在途 PR（标题/正文里的 GitHub 关闭关键词署名）
//              + 无本地 worktree 卡（卡名 ^#N；master 主树与 archived 不计）
// 并发上限随 #576 next 落地；落地前不发明一个数字。满位是正当理由，所以本项
// 只出可见行、永不报红。没查成必须和「扫完 0 个」不同形。

const READY_LABEL = '已消歧';

/** 本检查自己的署名正则，不复用 dao-check ⑭ / dao-cmd。 */
const CLOSES_RE = /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/gi;

export function linkedIssueNumbers(text) {
  const found = [];
  const re = new RegExp(CLOSES_RE.source, CLOSES_RE.flags);
  let m;
  while ((m = re.exec(String(text || '')))) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0 && !found.includes(n)) found.push(n);
  }
  return found;
}

export function cardNumbersFromWorktrees(wts) {
  if (!Array.isArray(wts)) return { unscanned: true, error: 'worktrees 不是数组' };
  const numbers = [];
  for (const w of wts) {
    if (!w || w.isMainWorktree || w.isArchived) continue;
    const name = String(w.displayName || '');
    const m = name.match(/^#(\d+)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0 && !numbers.includes(n)) numbers.push(n);
    }
  }
  return { unscanned: false, numbers };
}

function labelNames(issue) {
  if (!issue || !Array.isArray(issue.labels)) return null;
  return issue.labels.map(l => (l && typeof l.name === 'string' ? l.name : '')).filter(Boolean);
}

/**
 * @param {{ issues?: unknown, prs?: unknown, worktrees?: unknown, error?: string }} snap
 * @returns {{ kind: 'unscanned'|'zero'|'ready', ready: number[]|null, line: string }}
 */
export function inspectReadyQueue(snap) {
  if (!snap || snap.error) {
    return {
      kind: 'unscanned',
      ready: null,
      line: `可立即起：没查成（${snap?.error || '快照没给全'}，≠ 扫完是 0）`,
    };
  }
  if (!Array.isArray(snap.issues)) {
    return { kind: 'unscanned', ready: null, line: '可立即起：没查成（issues 不是数组，≠ 扫完是 0）' };
  }
  if (!Array.isArray(snap.prs)) {
    return { kind: 'unscanned', ready: null, line: '可立即起：没查成（prs 不是数组，≠ 扫完是 0）' };
  }
  const cards = cardNumbersFromWorktrees(snap.worktrees);
  if (cards.unscanned) {
    return { kind: 'unscanned', ready: null, line: `可立即起：没查成（${cards.error}，≠ 扫完是 0）` };
  }
  if (snap.issues.length > 0 && snap.issues.some(i => i && typeof i.number === 'number' && !('labels' in i))) {
    return { kind: 'unscanned', ready: null, line: '可立即起：没查成（issue 没有 labels 字段，≠ 扫完是 0）' };
  }

  const inPr = new Set();
  for (const p of snap.prs) {
    for (const n of linkedIssueNumbers(`${p?.title || ''}\n${p?.body || ''}`)) inPr.add(n);
  }
  const inCard = new Set(cards.numbers);

  const ready = [];
  for (const i of snap.issues) {
    if (!i || typeof i.number !== 'number') continue;
    if (inPr.has(i.number) || inCard.has(i.number)) continue;
    const names = labelNames(i);
    if (!names) continue;
    if (names.includes(READY_LABEL)) ready.push(i.number);
  }
  ready.sort((a, b) => a - b);

  if (ready.length === 0) {
    return { kind: 'zero', ready: [], line: '可立即起 0 个（扫完，不是没查成）' };
  }
  return {
    kind: 'ready',
    ready,
    line: `有 ${ready.length} 个可立即起的单没起：${ready.map(n => `#${n}`).join(' ')}`,
  };
}
