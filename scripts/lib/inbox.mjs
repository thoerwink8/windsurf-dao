// scripts/lib/inbox.mjs —— 收件箱：外部会话落盘的发现，怎么保证被读到（用户 2026-09-05 拍板）
//
// 起因：codex 审计会话把机制发现写成 docs/observations/*.md。它其实能实时给帅位发消息，
// 但消息只在帅位「活着且还有下一个 turn」时才到——会话一关就丢。而落盘的那两份文件当天是
// **未跟踪状态**，帅位是靠 `git status` 偶然看见 `??` 才知道的：落盘了没人读，等于没写。
//
// 用户拍板（三问）：
//   ① 内容改状态、不删——它是判例档案，删掉等于把判例扔了。
//   ② 同步靠 git，不另造通道；但**写入方没提交**才是当天的病根，所以未跟踪也要报。
//   ③ 每轮提醒挂在已有的 UserPromptSubmit 注入点；零条时不注入，不占 token。
//   牙口：提醒 + 超时硬拦（只提醒不拦的规矩，在渐变状态下等于永不触发——memory
//   rule-without-trigger-is-not-a-rule）。
//
// 本模块只做判断，不碰文件系统、不注入。取数与注入在 hook 里，便于单测。

export const INBOX_DIR_REL = 'docs/observations';
export const STATUS_NEW = 'new';
export const STATUS_DONE = 'done';
export const STATUS_WONTFIX = 'wontfix';
export const DEFAULT_OVERDUE_HOURS = 24;
export const DEFAULT_MAX_PENDING = 5;

/**
 * 一份收件箱文档的状态。
 * 没有 frontmatter 的老文件默认 new——「没标过」就是「没处置过」，不许当已读。
 * 「处置：」行是人写的落点（issue 号 / commit），有它也算已处置：约定要容得下最省事的写法，
 * 否则没人会遵守（判例：只写怎么做不写什么时候做，等于没写）。
 */
export function parseInboxDoc(text, { name, mtimeMs } = {}) {
  const raw = String(text ?? '');
  const fm = raw.startsWith('---') ? raw.slice(3, raw.indexOf('\n---', 3) + 1) : '';
  const pick = (key) => {
    const m = fm.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  let status = (pick('status') || '').toLowerCase();
  const handledLine = /^\s*(?:[>*-]\s*)*处置\s*[:：]\s*\S/m.test(raw);
  if (!status) status = handledLine ? STATUS_DONE : STATUS_NEW;
  const title = (raw.match(/^#\s+(.+)$/m) || [])[1] || String(name || '').replace(/\.md$/, '');
  return {
    name: String(name || ''),
    status,
    title: title.trim().slice(0, 60),
    at: Number.isFinite(mtimeMs) ? mtimeMs : null,
    handled: status === STATUS_DONE || status === STATUS_WONTFIX,
  };
}

/**
 * 扫一轮收件箱。三态必须分得开：
 *   quiet  —— 扫成了，没有未处置的（安静，不注入）
 *   notice —— 有未处置，提醒一行
 *   block  —— 有超时的 / 未处置堆积到上限，本轮必须先处置
 * 另外 `unscanned` 单独一格：目录读不了、git 查不成 ≠ 收件箱是空的。
 *
 * untracked：git 里没跟踪的收件箱文件。它们**一定**算未处置，且要单独说——
 * 因为「写了但没提交」在别的机器上根本看不到，是比「没处置」更早的一层病。
 */
export function assessInbox({
  docs, untracked = [], now = Date.now(),
  overdueHours = DEFAULT_OVERDUE_HOURS, maxPending = DEFAULT_MAX_PENDING,
  unscanned = null,
} = {}) {
  if (unscanned) {
    return { mode: 'notice', unscanned: true, lines: [`收件箱没查成：${unscanned}——不是「没有新东西」`], pending: [], overdue: [] };
  }
  if (!Array.isArray(docs)) {
    return { mode: 'notice', unscanned: true, lines: ['收件箱没查成：拿不到文档列表——不是「没有新东西」'], pending: [], overdue: [] };
  }
  const pending = docs.filter((d) => d && !d.handled);
  const overdueMs = Math.max(0, overdueHours) * 3600 * 1000;
  const overdue = pending.filter((d) => Number.isFinite(d.at) && now - d.at >= overdueMs);
  const lines = [];
  for (const d of pending.slice(0, 5)) {
    const hours = Number.isFinite(d.at) ? Math.round((now - d.at) / 3600000) : null;
    lines.push(`${d.name}${hours == null ? '' : `（${hours} 小时前）`}：${d.title}`);
  }
  if (pending.length > 5) lines.push(`另有 ${pending.length - 5} 条未处置`);
  for (const u of untracked) lines.push(`${u} 还没提交进 git——别的机器看不到它，等于没写`);

  const mustAct = overdue.length > 0 || pending.length >= maxPending || untracked.length > 0;
  if (!pending.length && !untracked.length) return { mode: 'quiet', unscanned: false, lines: [], pending, overdue };
  return {
    mode: mustAct ? 'block' : 'notice',
    unscanned: false,
    lines,
    pending,
    overdue,
    untracked,
  };
}

/** 注入文本。block 时给的是硬性指令，不是提示——本轮必须先处置。 */
export function renderInbox(assessed) {
  if (!assessed || assessed.mode === 'quiet') return '';
  const head = assessed.mode === 'block'
    ? '[收件箱·硬闸] 有别的会话给你留了发现，且已经超时或堆积。本轮先处置这些，再干别的：'
    : '[收件箱] 别的会话给你留了发现：';
  const tail = assessed.mode === 'block'
    ? '\n处置方式：每条要么落成 issue，要么在文件里加一行「处置：<结论>」；确实不做就把 frontmatter 的 status 标成 wontfix 并写理由。未提交的先 git add 提交——不提交别的机器看不到。'
    : '';
  return `${head}\n· ${assessed.lines.join('\n· ')}${tail}`;
}
