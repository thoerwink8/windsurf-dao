// scripts/lib/docs-retire.mjs —— T47：文档清退。活文档会随代码漂移，得有东西让它退役。
//
// 起因（用户 2026-09-19）：「docs 落后的文档我希望能清掉，要有机制」。
// 现状：docs/ 下 129 个 md，其中 decisions/ 与 observations/ 是**判例档案**（拍板不删），
// 剩下约 17 个是活文档——**没有任何东西会让它们退役**。已有清退机制只管 issue / PR / 清单，文档本体没人管。
//
// 判据（全机械可判，不靠「看着旧」）：
//   · 每条活文档二选一：frontmatter `reviewed: YYYY-MM-DD`（最近复核过）或 `status: retired`（已退役）；
//   · **没标过 = 没复核过** → 计入 pending（不许当已读，与 issue-retire / 收件箱同口径）；
//   · `reviewed` 超期（默认 90 天）→ 红；pending 堆积到上限（默认 5 条）→ 红；
//   · **退役不删文件**：加 `status: retired` 即可（判例档案原则：删掉等于篡改历史）。
//
// 本模块只做判断，不碰文件系统。取数在 scripts/docs-retire.mjs，便于单测。
// 三态：quiet / notice / block，另加 unscanned（读不到 ≠ 没有落后文档）。

export const DOCS_DIR_REL = 'docs';
/** 档案目录：判例档案，永不进清退判据（拍板：删掉等于篡改历史）。 */
export const ARCHIVE_DIRS = Object.freeze(['decisions', 'observations', 'exams', 'retired']);
export const DEFAULT_OVERDUE_DAYS = 90;
export const DEFAULT_MAX_PENDING = 5;

/** 从 frontmatter 读 `reviewed` / `status`；读不到就是没标过（不许当已读）。 */
export function parseDocMeta(text, { name } = {}) {
  const raw = String(text ?? '');
  const end = raw.startsWith('---') ? raw.indexOf('\n---', 3) : -1;
  const fm = end > 0 ? raw.slice(3, end) : '';
  const pick = (key) => {
    const m = fm.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const reviewed = pick('reviewed');
  const at = reviewed ? Date.parse(reviewed) : NaN;
  const status = (pick('status') || '').toLowerCase();
  const title = (raw.match(/^#\s+(.+)$/m) || [])[1] || String(name || '').replace(/\.md$/, '');
  return {
    name: String(name || ''),
    title: title.trim().slice(0, 60),
    reviewed: reviewed || null,
    // 日期解析不了按「没标过」算——宁可不认，不认错。
    at: Number.isFinite(at) ? at : null,
    retired: status === 'retired',
  };
}

/**
 * 扫一轮活文档。三态分得开：
 *   quiet  —— 扫成了，没有待处置
 *   notice —— 有待处置但没超期、没堆满
 *   block  —— 有超期 / 堆到上限，本轮必须先处置
 * unscanned 单独一格：目录读不到 ≠ 没有落后文档。
 */
export function assessDocs({
  docs, now = Date.now(),
  overdueDays = DEFAULT_OVERDUE_DAYS, maxPending = DEFAULT_MAX_PENDING,
  unscanned = null,
} = {}) {
  if (unscanned) {
    return { mode: 'notice', unscanned: true, lines: [`文档清退没查成：${unscanned}——不是「没有落后文档」`], pending: [], overdue: [], never: [] };
  }
  if (!Array.isArray(docs)) {
    return { mode: 'notice', unscanned: true, lines: ['文档清退没查成：拿不到文档清单——不是「没有落后文档」'], pending: [], overdue: [], never: [] };
  }
  const live = docs.filter((d) => d && !d.retired);
  const never = live.filter((d) => d.at === null);
  const overdueMs = Math.max(0, overdueDays) * 86400000;
  const overdue = live.filter((d) => d.at !== null && now - d.at >= overdueMs);
  const pending = [...overdue, ...never];

  const lines = [];
  for (const d of overdue.slice(0, 5)) lines.push(`${d.name}（复核于 ${d.reviewed}，已超期）：${d.title}`);
  for (const d of never.slice(0, 5)) lines.push(`${d.name}（从没复核过）：${d.title}`);
  if (pending.length > 10) lines.push(`另有 ${pending.length - 10} 条`);

  const mustAct = overdue.length > 0 || pending.length >= maxPending;
  if (!pending.length) {
    return { mode: 'quiet', unscanned: false, lines: [], pending, overdue, never };
  }
  return { mode: mustAct ? 'block' : 'notice', unscanned: false, lines, pending, overdue, never };
}

/** 判红与否。block 就是红——与 issue-retire 同出口口径。 */
export function judgeDocsRetire(assessed) {
  if (!assessed || assessed.unscanned) {
    return { state: 'unscanned', why: (assessed && assessed.lines && assessed.lines[0]) || '没查成' };
  }
  if (assessed.mode === 'block') {
    return {
      state: 'red',
      why: `${assessed.pending.length} 条活文档待处置（超期 ${assessed.overdue.length}、从没复核 ${assessed.never.length}）——逐条过一遍：更新 reviewed 或标 status: retired`,
    };
  }
  if (assessed.mode === 'notice') return { state: 'green', why: `${assessed.pending.length} 条待处置，未超期` };
  return { state: 'green', why: '活文档都复核过（没有落后文档，不是没查成）' };
}
