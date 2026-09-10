// scripts/lib/session-dir-gc.mjs —— 会话目录对账清理的判据（#1176）
//
// 起因：2026-09-10 实测 listSessions 从 3-5 秒退化到 19-30 秒。根因是本机会话目录只增不减：
// ~/.mirasim/sessions 从 9-06 的 172 个涨到 9-09 的 1600+，而服务端每次全量枚举才能筛出近 60 条。
// 调度器每轮至少看一次盘面 ⇒ 每轮烧 20 秒 ⇒ 逼近 30 秒超时线 ⇒ 机器一有负载就判「没查成」⇒
// fail-closed 不派工，队列看起来永远堵着。清理后实测回落到 4.5 秒。
//
// 与 board-gc 的分工：board-gc 管**卡**（worktree 僵尸卡，判据在 lib/board-gc.mjs）；
// 本文件管**会话目录本体**（~/.mirasim/sessions/<agent>/<uuid>），那是 board-gc 不覆盖的一层。
// 两者都靠 liveness 认「有没有活着的进程」，判据不重复实现。
//
// 用户 2026-09-10 拍板：「issue 关了就说明事情做完了，本地不需要留代码记录」——
// GitHub 保有完整历史，本地会话目录只服务于「还在跑的活」，过期即为纯负担。

/** 默认保留窗口：这个时长内有过活动的会话一律留着，不看单号。 */
export const DEFAULT_KEEP_HOURS = 6;

/**
 * 从会话记录里认领它属于哪些 issue/PR 编号。
 *
 * 为什么要从 workdir/title/preview 三处一起认：worktree 路径（dao-1145）是最可靠的，
 * 但审官树叫 dao-review-pr-1032-2、快马树可能没编号，只能再从标题正文里捞。
 * 认不出编号不等于可以删——那是「没查成」，交给时效判据兜底，不许当成「不属于任何单」。
 */
export function refsOf(record) {
  const blob = [record?.workdir, record?.title, record?.preview].filter(Boolean).join(' ');
  const out = new Set();
  const re = /(?:dao[-_]|#|issue|pr)[\s#_-]*(\d{3,5})/gi;
  let m;
  while ((m = re.exec(blob))) out.add(m[1]);
  return out;
}

/**
 * 单条会话的判决。
 *
 * 判决顺序是安全边界，不许调换：
 *   1. 有活进程 → 永远保留（哪怕单早就关了，进程还在就是还在干活）
 *   2. 时间戳读不出 → 保留并标 unknown（「多老」没查成 ≠ 很老；见下）
 *   3. 保留窗口内有活动 → 保留（刚跑完的会话，调度器可能还要读它的结果）
 *   4. 盘面没查成 → 保留（fail-closed：GitHub 超时/限流时一次抖动就误删一批，不可接受）
 *   5. 引用的单全部关闭 → 删
 *   6. 其余（引用了 OPEN 单、或认不出编号）→ 看时效，超窗口就删
 *
 * 第 2 条是 #1175 审官抓出来的洞：旧版把读不出时间戳的记录直接归 remove（「坏记录按时效
 * 兜底当老的」）。可一次 stat 抖动、半写完的 record、权限错，形态跟「真的坏」一模一样，
 * 而归档是不可逆的。没查成就保留，是本文件其余各条同一条纪律。
 *
 * 第 6 条为什么敢删引用了 OPEN 单的会话：一个 9-06 完成的老会话即使提到仍开着的 #1122，
 * 对推进 #1122 也毫无帮助——它是历史，不是在途状态。只按单号会留下 400+ 个死记录。
 */
export function judgeSession(session, { closedRefs, boardScanned, now = Date.now(), keepHours = DEFAULT_KEEP_HOURS } = {}) {
  if (session?.alive) return { verdict: 'keep', why: '有活着的进程' };

  const updated = Number(session?.updatedAtMs);
  if (!Number.isFinite(updated)) {
    // 时间读不出来 = 「多老」这个事实没查成。没查成不是「很老」——一次 stat 抖动、
    // 半写完的 record、权限错，形态都一样；当老的删正是 fail-open（#1175 审官第三条抓的）。
    // 保留并标 unknown，让上层把「这轮有几个没查成」端出来，而不是悄悄归档。
    return { verdict: 'keep', unknown: true, why: '时间戳没查成——不猜多老（fail-closed）' };
  }
  const ageHours = (now - updated) / 3600000;
  if (ageHours < keepHours) return { verdict: 'keep', why: `${keepHours} 小时内有活动` };

  if (!boardScanned) return { verdict: 'keep', why: '盘面没查成，不许猜（fail-closed）' };

  const refs = refsOf(session?.record || {});
  if (refs.size > 0) {
    const open = [...refs].filter((n) => !closedRefs?.has(n));
    if (open.length === 0) return { verdict: 'remove', why: `引用的单全部已关闭（${[...refs].join(',')}）` };
    return { verdict: 'remove', why: `超 ${keepHours} 小时无活动的历史会话（仍引用 OPEN 单 ${open.join(',')}）` };
  }
  return { verdict: 'remove', why: `超 ${keepHours} 小时无活动，且认不出单号归属` };
}

/**
 * 全量对账。
 *
 * @param {{sessions: Array, closedRefs: Set<string>, boardScanned: boolean}} input
 *   sessions 每项形如 {id, agent, dir, alive, updatedAtMs, record}
 *   boardScanned 为 false 表示这轮没拿到 GitHub 盘面——此时只靠时效清，不用单号判据。
 * @returns {{state:'ok'|'unknown', remove:Array, keep:Array, detail:string}}
 */
export function planSessionGc({ sessions, closedRefs = new Set(), boardScanned = true, now = Date.now(), keepHours = DEFAULT_KEEP_HOURS } = {}) {
  if (!Array.isArray(sessions)) {
    return { state: 'unknown', remove: [], keep: [], detail: '会话清单不是数组（没查成）' };
  }
  if (sessions.length === 0) {
    // 「扫完 0 个」和「没扫到」必须分开：后者是扫描面坏了，当成「没有会话」会让清理器静默失效。
    return { state: 'unknown', remove: [], keep: [], detail: '一个会话目录都没扫到——没查成，不是「没有会话」' };
  }
  const remove = [];
  const keep = [];
  for (const s of sessions) {
    const j = judgeSession(s, { closedRefs, boardScanned, now, keepHours });
    (j.verdict === 'remove' ? remove : keep).push({ ...s, why: j.why });
  }
  const scope = boardScanned ? '' : '（盘面没查成，本轮只按时效清）';
  return {
    state: 'ok',
    remove,
    keep,
    detail: `扫到 ${sessions.length} 个会话目录：删 ${remove.length}、留 ${keep.length}${scope}`,
  };
}

/**
 * 无归属临时目录的判据（~/.codex/.tmp/git-* 这类）。
 *
 * 这批目录压根没有编号可认——codex 每次 git 操作留一个，从不回收。
 * 2026-09-10 实测攒了 11109 个，只有 65 个是当天的。它们唯一能用的判据就是时效。
 */
export function planOrphanGc({ entries, now = Date.now(), keepHours = 24 } = {}) {
  if (!Array.isArray(entries)) return { state: 'unknown', remove: [], detail: '临时目录清单不是数组（没查成）' };
  const remove = entries.filter((e) => {
    const t = Number(e?.mtimeMs);
    if (!Number.isFinite(t)) return false; // 时间读不出就别动，宁可留着
    return (now - t) / 3600000 >= keepHours;
  });
  return { state: 'ok', remove, detail: `扫到 ${entries.length} 个临时目录：删 ${remove.length}（超 ${keepHours} 小时）` };
}
