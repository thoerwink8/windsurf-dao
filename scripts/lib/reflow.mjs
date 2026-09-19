// scripts/lib/reflow.mjs —— T37 ②：回流收件箱（子仓 → 本仓）的判据，与 docs/observations 同形。
//
// 起因：`## 回流` 段是**子仓交卷时写在它自己 PR 正文里**的（已有规矩，`scripts/lib/harvest-check.mjs`），
// 但那段只在子仓的 PR 里——本仓看不到它有没有被处置。本仓要有个落点把产物接住：
//   inbox/    子仓提的「可上收产物」落这里（一条一个文件）
//   accepted/ 已上收（记：上收到哪、谁接的）
//   rejected/ 未收——**必须写理由**
//
// 三条牙（都是确定性的量，不当墙钟闸用）：
//   · inbox 超时未处置 → 红（默认 7 天）；
//   · inbox 堆积到上限 → 红；
//   · rejected 缺理由 → 红（不可协商层 C2：抑制必须带理由）。
//
// 本模块只做判断，不碰文件系统。取数在 scripts/reflow.mjs，便于单测。
// 三态：quiet（扫成了，没有待处置）/ notice / block，另加 unscanned（读不到 ≠ 收件箱是空的）。

export const REFLOW_DIR_REL = 'host/reflow';
export const DEFAULT_OVERDUE_DAYS = 7;
export const DEFAULT_MAX_PENDING = 5;

/**
 * 一份回流文档的状态。没标过 = 没处置过（不许当已读）。
 * 「处置：」行也算已处置——约定要容得下最省事的写法，否则没人会遵守。
 */
export function parseReflowDoc(text, { name, mtimeMs, box } = {}) {
  const raw = String(text ?? '');
  const fmEnd = raw.startsWith('---') ? raw.indexOf('\n---', 3) : -1;
  const fm = fmEnd > 0 ? raw.slice(3, fmEnd) : '';
  const pick = (key) => {
    const m = fm.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const handledLine = /^\s*(?:[>*-]\s*)*处置\s*[:：]\s*\S/m.test(raw);
  const inRejected = box === 'rejected';
  const reason = pick('理由') || (raw.match(/^\s*(?:[>*-]\s*)*理由\s*[:：]\s*(\S.*)$/m) || [])[1] || null;
  const title = (raw.match(/^#\s+(.+)$/m) || [])[1] || String(name || '').replace(/\.md$/, '');
  return {
    name: String(name || ''),
    box: String(box || 'inbox'),
    title: title.trim().slice(0, 60),
    from: pick('来源仓'),
    at: Number.isFinite(mtimeMs) ? mtimeMs : null,
    handled: box !== 'inbox' || handledLine,
    // rejected 里没有理由 = 没接住（C2）。accepted/inbox 不适用这条。
    missingReason: inRejected && !reason,
  };
}

/**
 * 扫一轮回流收件箱。三态分得开：
 *   quiet  —— 扫成了，没有待处置
 *   notice —— 有未处置，提醒一行
 *   block  —— 超时 / 堆积到上限 / rejected 缺理由 / 未提交，本轮必须先处置
 * unscanned 单独一格：目录读不了 ≠ 收件箱是空的。
 */
export function assessReflow({
  docs, untracked = [], now = Date.now(),
  overdueDays = DEFAULT_OVERDUE_DAYS, maxPending = DEFAULT_MAX_PENDING,
  unscanned = null,
} = {}) {
  if (unscanned) {
    return { mode: 'notice', unscanned: true, lines: [`回流收件箱没查成：${unscanned}——不是「没有待处置」`], pending: [], overdue: [], missingReason: [] };
  }
  if (!Array.isArray(docs)) {
    return { mode: 'notice', unscanned: true, lines: ['回流收件箱没查成：拿不到文件清单——不是「没有待处置」'], pending: [], overdue: [], missingReason: [] };
  }
  const pending = docs.filter((d) => d && !d.handled);
  const missingReason = docs.filter((d) => d && d.missingReason);
  const overdueMs = Math.max(0, overdueDays) * 86400000;
  const overdue = pending.filter((d) => Number.isFinite(d.at) && now - d.at >= overdueMs);

  const lines = [];
  for (const d of pending.slice(0, 5)) {
    const days = Number.isFinite(d.at) ? Math.floor((now - d.at) / 86400000) : null;
    lines.push(`${d.name}${d.from ? `（来源 ${d.from}）` : ''}${days == null ? '' : `，${days} 天前`}：${d.title}`);
  }
  if (pending.length > 5) lines.push(`另有 ${pending.length - 5} 条未处置`);
  for (const d of missingReason) lines.push(`${d.name} 判了「不收」却没写理由——抑制必须带理由`);
  for (const u of untracked) lines.push(`${u} 还没提交进 git——别的机器看不到它，等于没写`);

  const mustAct = overdue.length > 0 || pending.length >= maxPending || missingReason.length > 0 || untracked.length > 0;
  if (!pending.length && !missingReason.length && !untracked.length) {
    return { mode: 'quiet', unscanned: false, lines: [], pending, overdue, missingReason };
  }
  return { mode: mustAct ? 'block' : 'notice', unscanned: false, lines, pending, overdue, missingReason, untracked };
}

/** 判红与否：block 就是红（与 harvest 孤儿段同一出口口径）。 */
export function judgeReflow(assessed) {
  if (!assessed || assessed.unscanned) return { state: 'unscanned', why: (assessed && assessed.lines && assessed.lines[0]) || '没查成' };
  if (assessed.mode === 'block') {
    return { state: 'red', why: `${assessed.pending.length} 条待处置（超时 ${assessed.overdue.length}、缺理由 ${assessed.missingReason.length}、未提交 ${(assessed.untracked || []).length}）——本仓要逐条接住` };
  }
  if (assessed.mode === 'notice') return { state: 'green', why: `${assessed.pending.length} 条待处置，未超时` };
  return { state: 'green', why: '回流收件箱空（没有待处置，不是没查成）' };
}

/** 注入文本：block 时给硬性指令。 */
export function renderReflow(assessed) {
  if (!assessed || assessed.mode === 'quiet') return '';
  const head = assessed.mode === 'block'
    ? '[回流·硬闸] 子仓提上来的产物有人提没人接。本轮先处置，再干别的：'
    : '[回流] 子仓提上来的产物：';
  const tail = assessed.mode === 'block'
    ? '\n处置方式：接了就移进 accepted/ 并写「上收到哪、谁接的」；不接就移进 rejected/ 并写理由（没理由算红）；未提交的先 git add 提交。'
    : '';
  return `${head}\n· ${assessed.lines.join('\n· ')}${tail}`;
}
