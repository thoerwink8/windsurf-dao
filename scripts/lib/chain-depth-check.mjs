// scripts/lib/chain-depth-check.mjs —— 补丁链层数闸（memory patch-stacking-is-two-strikes 的 gate）
//
// 来历：那条判例已经撞到第 3 次（2026-08-15 信箱台三层、2026-09-07 reviewer-entrance 第 3 层
// 且差点在 dispatch-overinvest 上加第 6 层），`gate` 一直是空的。判例自己写明缺的是什么：
//
//   > 「同一 slug ≥3 层」「有 chain 锚但没有对应 PR」两个判据都是确定性的量、
//   > 都做得成 dao-check 项，但 2026-09-07 尚未拍板配上。
//
// 全局 CLAUDE.md 的规矩是「同一种办法连错两次就换路」——第 2 层就该停手从零重推。
// 所以 ≥3 层意味着那次停手没有发生，这是**已经越线**的确定性证据，不是风格问题。
//
// 判据只认锚里的**最大层号**，不数提交条数：同一层可以有很多次提交
// （2026-09-10 实测 session-visibility 有 19 条锚，全是 #0，那是一层，不是 19 层）。
// 数条数会把「一层反复改」误报成「补了十九层」，而误报的闸最后一定被关掉。

/**
 * 从一行 commit 标题里认锚。形态：`[chain:<slug>#<层号>]`，层号后面允许带备注。
 *
 * 「层号后面允许带备注」不是宽容，是实况：2026-09-10 拿真实仓库跑这个闸时判绿，
 * 说最深只有 `reviewer-entrance#2`；而 `git log` 里明明有 `dispatch-overinvest#5`。
 * 原因是那条锚写作 `[chain:dispatch-overinvest#5·换方向]`——层号后跟了中文后缀，
 * 要求数字紧贴 `]` 的正则把**最深的那条链整条跳过了**。
 * 漏报比误报危险：闸判绿而越线的链就在眼前。所以这里只认「数字后面不是数字」，
 * 后面是什么都不管。
 */
export const CHAIN_ANCHOR_RE = /\[chain:([a-z0-9][a-z0-9-]*)#(\d{1,2})(?!\d)/gi;

/**
 * 把 commit 标题行解析成 slug → 最大层号。
 * @param {string[]} lines commit 标题（一行一条，可带 hash 前缀）
 * @returns {Map<string, number>}
 */
export function maxDepthBySlug(lines) {
  const out = new Map();
  for (const line of lines || []) {
    for (const m of String(line).matchAll(CHAIN_ANCHOR_RE)) {
      const slug = m[1].toLowerCase();
      const depth = Number(m[2]);
      if (!Number.isFinite(depth)) continue;
      if (!out.has(slug) || out.get(slug) < depth) out.set(slug, depth);
    }
  }
  return out;
}

/** 越线阈值：第 2 层就该停手，所以 ≥3 层是「停手没发生」的证据。 */
export const DEPTH_LIMIT = 3;

/**
 * @param {{lines: string[]|null, limit?: number}} input
 *   lines 为 null 表示 git 没查成——必须与「查了没有锚」分开报，否则闸静默开门。
 * @returns {{state:'ok'|'red'|'unknown', detail:string, over?: Array<{slug:string,depth:number}>}}
 */
export function classifyChainDepth({ lines, limit = DEPTH_LIMIT } = {}) {
  if (!Array.isArray(lines)) {
    return { state: 'unknown', detail: 'git log 没查成——不是「没有补丁链」' };
  }
  const depths = maxDepthBySlug(lines);
  if (depths.size === 0) {
    // 「扫完 0 条锚」是可能的（新仓、或锚还没开始用），但要说清扫描面有多大，
    // 否则 0 条锚和 0 行输入看起来一样。
    return { state: 'ok', detail: `扫了 ${lines.length} 行 commit 标题，没有 chain 锚` };
  }
  const over = [...depths.entries()]
    .filter(([, d]) => d >= limit)
    .map(([slug, depth]) => ({ slug, depth }))
    .sort((a, b) => b.depth - a.depth);
  if (over.length) {
    const names = over.map((o) => `${o.slug}#${o.depth}`).join('、');
    return {
      state: 'red',
      over,
      detail: `${over.length} 条补丁链到了第 ${limit} 层以上：${names}——第 2 层就该停手从零重推（grill-ai）`,
    };
  }
  const top = [...depths.entries()].sort((a, b) => b[1] - a[1])[0];
  return { state: 'ok', detail: `${depths.size} 条补丁链，最深 ${top[0]}#${top[1]}（限 ${limit}）` };
}
