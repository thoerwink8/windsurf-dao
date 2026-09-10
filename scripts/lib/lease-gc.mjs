// scripts/lib/lease-gc.mjs —— 执行租约对账清理的判据（#1146/#1175 实咬）
//
// 起因（2026-09-10）：审官会话被上游断流打死（`stream disconnected before completion`），
// 留下一条 state=running 的租约挂在审官树上。此后 reviewer-create 一律报
// 「worktree already has an active or unknown session」——**死人占着树，活人进不来**。
// 实测 18 条租约里 13 条 running，而其中大部分会话早就不在了（最老的挂 21 小时）。
//
// 与 session-dir-gc 的分工：那个管**会话档案目录**，这个管**执行租约**（~/.dao/execution/leases）
// ——租约是「谁占着这棵工作树」，会话档案是「有没有人在跑」。两层的失效面不同：
// 会话没了租约还在 = 树被永久占住（本文件的案子）。
//
// 判决纪律与 session-dir-gc 一致：**任何「没查成」都保留**（fail-closed），
// 只有「明确死了」才放行；且只放行**过期的**，刚起的不动。

/** 默认宽限：租约在这个时长内一律不动（起会话、停会话都需要时间）。 */
export const DEFAULT_LEASE_GRACE_MIN = 30;

/**
 * 单条租约的判决。
 *
 * 判决顺序是安全边界，不许调换：
 *   1. 有活进程 → 永远保留（进程还在就是还在干活，哪怕记录看着过期）
 *   2. 会话名单里查不到会话（台账有、盘上没了）→ 宽限期后回收
 *   3. 名单里有会话、且报终态（done/failed/incomplete…）→ 宽限期后回收
 *   4. 宽限期内 → 保留（刚起的，什么都别动）
 *   5. 名单没查成 / 会话状态未知 → 保留（fail-closed：一次抖动就回收会杀掉在跑的活）
 *
 * @param {{state:string, sessionKey:string, workdir:string, ageMin:number, hasLiveProcess?:boolean}} lease
 * @param {{sessionState?:string|null, sessionsScanned:boolean, graceMin?:number}} ctx
 *   sessionState: 服务端名单里这条会话的状态（null=查不到）
 * @returns {{verdict:'keep'|'reap', why:string, unknown?:boolean}}
 */
export function judgeLease(lease, { sessionState = null, sessionsScanned = false, graceMin = DEFAULT_LEASE_GRACE_MIN } = {}) {
  const key = String(lease?.sessionKey || '(没有 sessionKey)');
  if (lease?.hasLiveProcess === true) return { verdict: 'keep', why: `${key} 有活进程` };

  const age = Number(lease?.ageMin);
  if (!Number.isFinite(age)) {
    return { verdict: 'keep', unknown: true, why: `${key} 租约年龄没查成——不猜（fail-closed）` };
  }
  if (age < graceMin) return { verdict: 'keep', why: `${key} 租约 ${age} 分钟 < 宽限 ${graceMin} 分钟` };

  if (!sessionsScanned) {
    return { verdict: 'keep', unknown: true, why: `${key} 会话名单没查成——不猜（fail-closed）` };
  }
  if (sessionState == null) {
    return { verdict: 'reap', why: `${key} 会话名单里查不到它（台账有、盘上没了），租约挂了 ${age} 分钟` };
  }
  const raw = String(sessionState).toLowerCase();
  if (['done', 'completed', 'complete', 'failed', 'error', 'aborted', 'cancelled', 'canceled', 'stopped', 'incomplete', 'gone'].includes(raw)) {
    return { verdict: 'reap', why: `${key} 会话已是终态 ${raw}，租约挂了 ${age} 分钟` };
  }
  // 名单里有、状态是 running/starting/… → 可能真在跑，保留（不赌）。
  return { verdict: 'keep', why: `${key} 会话状态 ${raw || '未知'}，按还在跑处理` };
}

/**
 * 登记表里**卡在中间态**的记录（`stopping` / `uncertain` / `pending`）。
 *
 * 为什么要单列（2026-09-10 实咬）：会话被上游断流打死时，清理流程只走了一半，
 * 登记表停在 `state=stopping, cleanupVerified=false`。此后同一条工作树永远起不了新会话——
 * 报「worktree has an unresolved launch or cleanup」或「unresolved registry reservation」。
 * 实测就是这三层残留（租约 / 登记预留 / 清理 token）把审官挡在门外。
 *
 * 判据与租约层同源：**会话名单说得清「它死了」才回收**；查不到会话（台账有、盘上没了）
 * 同样算死了。会话还在跑就保留——哪怕它卡在中间态，那也是真在跑的一次启动。
 *
 * @param {Array} records 登记表记录（含 state / sessionKey / workdir / updatedAt）
 */
export function judgeRegistryStuck(record, { sessionState = null, sessionsScanned = false, graceMin = DEFAULT_LEASE_GRACE_MIN, now = Date.now() } = {}) {
  const key = String(record?.sessionKey || record?.recordKey || '(没有 key)');
  const st = String(record?.state || '');
  if (!['stopping', 'uncertain', 'pending'].includes(st)) return { verdict: 'keep', why: `${key} 状态 ${st || '空'} 不是中间态` };
  const at = Number(record?.updatedAt) || Number(record?.acceptedAt) || 0;
  const ageMin = at > 0 ? (now - at) / 60000 : NaN;
  if (!Number.isFinite(ageMin)) return { verdict: 'keep', unknown: true, why: `${key} 记录年龄没查成——不猜（fail-closed）` };
  if (ageMin < graceMin) return { verdict: 'keep', why: `${key} 中间态 ${ageMin.toFixed(0)} 分钟 < 宽限 ${graceMin} 分钟` };
  if (!sessionsScanned) return { verdict: 'keep', unknown: true, why: `${key} 会话名单没查成——不猜（fail-closed）` };
  if (sessionState == null) return { verdict: 'reap', why: `${key} 停在 ${st} 但会话名单里没有它，挂了 ${ageMin.toFixed(0)} 分钟` };
  const raw = String(sessionState).toLowerCase();
  const terminal = ['done', 'completed', 'complete', 'failed', 'error', 'aborted', 'cancelled', 'canceled', 'stopped', 'incomplete', 'gone'];
  if (terminal.includes(raw)) return { verdict: 'reap', why: `${key} 停在 ${st} 而会话已是终态 ${raw}，挂了 ${ageMin.toFixed(0)} 分钟` };
  return { verdict: 'keep', why: `${key} 会话状态 ${raw}，按还在跑处理` };
}

/**
 * 全量对账。
 * @param {{leases:Array, sessions?:Map<string,string>|null, sessionsScanned:boolean, graceMin?:number}} input
 *   sessions: sessionKey → 状态（服务端名单）
 * @returns {{state:'ok'|'unknown', reap:Array, keep:Array, unknown:Array, detail:string}}
 */
export function planLeaseGc({ leases, sessions = null, sessionsScanned = false, graceMin = DEFAULT_LEASE_GRACE_MIN } = {}) {
  if (!Array.isArray(leases)) {
    return { state: 'unknown', reap: [], keep: [], unknown: [], detail: '租约清单不是数组——没查成' };
  }
  const reap = [];
  const keep = [];
  const unknown = [];
  for (const l of leases) {
    const key = String(l?.sessionKey || '');
    const st = sessions && key && sessions.has(key) ? sessions.get(key) : null;
    const j = judgeLease(l, { sessionState: st, sessionsScanned, graceMin });
    if (j.verdict === 'reap') reap.push({ ...l, why: j.why });
    else if (j.unknown) unknown.push({ ...l, why: j.why });
    else keep.push({ ...l, why: j.why });
  }
  return {
    state: 'ok',
    reap, keep, unknown,
    detail: `租约 ${leases.length} 条：可回收 ${reap.length}、保留 ${keep.length}、没查成 ${unknown.length}`,
  };
}
