// scripts/lib/break-link-check.mjs —— T48：断链闸。记了要有人修，不然「记录」就成了新的静默。
//
// 规矩在 #1460：「真跑 / 复核 / 上游任何一环断链 → 当场记 `[断链]` → 修复 → 补证据」。
// 病：`[断链]` 评论**人记得才写**；写了**没人修也没人查**——本轮实例「本机起不了审官」
// 留了痕，却既没开单也没有东西盯着它。
//
// 判据（机械可判）：每条 `[断链]` 评论必须落到下面任一条，否则红：
//   · 自带 `已修：<证据>` 或 `不修：<理由>`（C2：抑制必须带理由）；
//   · 自带 `已开单：#N` 且 #N 还开着；
//   · 自带 `起因：<slug>` 且该 slug 有 OPEN 单；
//   · 其 slug 在**别处的处置评论**里被处置过（`断链已处置：<slug> → …`）——
//     评论改不了（网关只支持 comment-upsert），所以处置得允许后补一条，否则旧评论永远红。
//
// 三态：绿 / 红 / **没查成**。取不到评论或 open 单列表一律没查成——不许当「没有断链」。

/** 只认评论**开头**的 `[断链]`（`**[断链]**` 也算）。写在中间不算——首部是规矩指定的位置。 */
export function isBreakComment(body) {
  return /^(?:\*\*|__)?\[断链\]/.test(String(body == null ? '' : body).trimStart());
}

/** 从一条 `[断链]` 评论里读它自带的处置与 slug。 */
export function parseBreakLink(body) {
  const raw = String(body == null ? '' : body);
  const line = (key) => {
    const m = raw.match(new RegExp(`^[ \\t]*(?:\\*\\*|__)?${key}(?:\\*\\*|__)?[ \\t]*[:：][ \\t]*(\\S.*)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const openedRaw = line('已开单');
  const opened = openedRaw ? (openedRaw.match(/#(\d+)/) || [])[1] : null;
  const slugRaw = line('起因');
  return {
    slug: slugRaw ? slugRaw.split(/\s+/)[0] : null,
    fixed: Boolean(line('已修')),
    wontfix: Boolean(line('不修')),
    opened: opened ? Number(opened) : null,
  };
}

/** 别处的处置评论：`断链已处置：<slug 或 issuecomment-<id>> → <结论>`。返回 Map<键, 结论>。
 *  **一条评论里可以放多条**（一次处置好几条断链是常态）——所以逐行全收，不能只取第一条。 */
export function parseDispositions(comments) {
  const out = new Map();
  for (const c of comments || []) {
    const body = c && typeof c.body === 'string' ? c.body : '';
    const re = /^[ \t]*(?:\*\*|__)?断链已处置(?:\*\*|__)?[ \t]*[:：][ \t]*(\S+)[ \t]*(?:→|->)[ \t]*(\S.*)$/gm;
    for (const m of body.matchAll(re)) out.set(m[1].trim(), m[2].trim());
  }
  return out;
}

/** 评论的稳定键：`issuecomment-<id>`（从 html_url 尾段取）。取不到返回 null。 */
export function commentKey(comment) {
  const m = /#?issuecomment-(\d+)/.exec(String((comment && comment.html_url) || ''));
  return m ? `issuecomment-${m[1]}` : null;
}

/**
 * 判一轮。`openNumbers` / `openSlugs` 必须是 Set——不是 Set 一律没查成（「扫不到」与「扫完没有」分得开）。
 * @returns {{state:'green'|'red'|'unscanned', breaks:number, unresolved:object[], why:string}}
 */
export function judgeBreakLinks({ comments, openNumbers, openSlugs } = {}) {
  if (!Array.isArray(comments)) return { state: 'unscanned', breaks: 0, unresolved: [], why: '评论没取到（取不到 ≠ 没有断链）' };
  if (!(openNumbers instanceof Set)) return { state: 'unscanned', breaks: 0, unresolved: [], why: 'OPEN 单号没取到（取不到 ≠ 没有在管的单）' };
  if (!(openSlugs instanceof Set)) return { state: 'unscanned', breaks: 0, unresolved: [], why: 'OPEN 单的起因 slug 没取到（取不到 ≠ 没有在管的单）' };

  const breaks = comments.filter((c) => c && typeof c.body === 'string' && isBreakComment(c.body));
  const dispositions = parseDispositions(comments);
  const unresolved = [];
  for (const c of breaks) {
    const p = parseBreakLink(c.body);
    if (p.fixed || p.wontfix) continue;
    if (p.opened !== null && openNumbers.has(p.opened)) continue;
    const key = commentKey(c);
    if (p.slug && (openSlugs.has(p.slug) || dispositions.has(p.slug))) continue;
    // 没写 slug 的老断链：按评论键处置（评论改不了，只能后补一条）。
    if (!p.slug && key && dispositions.has(key)) continue;
    unresolved.push({
      url: c.html_url || null,
      slug: p.slug,
      why: p.slug
        ? `起因 ${p.slug} 既没有 OPEN 单，也没有处置（已修 / 不修 / 断链已处置：${p.slug} → …）`
        : `既没写 \`起因：<slug>\`，也没写处置（已修 / 不修 / 断链已处置：${key || 'issuecomment-<id>'} → …）——没法追踪`,
    });
  }
  if (!breaks.length) return { state: 'green', breaks: 0, unresolved: [], why: '没有 `[断链]` 评论（扫完查出 0 条，不是没查成）' };
  if (unresolved.length) {
    return { state: 'red', breaks: breaks.length, unresolved, why: `${unresolved.length}/${breaks.length} 条断链没人管：${unresolved.map((u) => u.slug || '（无 slug）').slice(0, 5).join('、')}` };
  }
  return { state: 'green', breaks: breaks.length, unresolved: [], why: `${breaks.length} 条断链都有处置` };
}
