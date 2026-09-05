// scripts/lib/liveness.mjs —— 会话活性：统一「上次真动是什么时候」（issue #940）
//
// 用户 2026-09-05 拍板（grill-ai 落闸后）：
//   问一：删掉指纹层，只判静默。问二：走统一接口，不做最小修复。
//
// 为什么不再用「匹配已知错误字样」发现故障：那要求预先知道全部失败形态。
// 实咬——6 个审官掉回裸 bash 提示符停了 10 小时，屏上没有任何错误字样，指纹零命中，一次没报。
// 而且上一次漏报的修法就是「往指纹表里加两条」，再加一条就是同方向第 2 层补丁。
// 换判据：**有没有可验证的推进**。它与错误形态无关，因此也与驱动无关。
//
// 采样面的旧病灶（agent-stall-watch.mjs 旧代码）：`if (!t.agentIdentity) continue`——
// reclaude 起的终端没有 agentIdentity，被整个跳过。那不是「漏报」，是「没采样」，
// 而两者在报告里长得一模一样。所以本模块的第一条规矩是：
//
//   **在采样面里但答不上来 ⇒ unscanned，报出来；绝不当 active。**
//
// 驱动适配器只需回答一句话：这个会话上次真动是什么时候（外加驱动自己知道的终态）。

/** 默认静默阈值：45 分钟。够长到不误伤长思考/长跑测试，够短到不至于像今天那样躺 10 小时。 */
export const DEFAULT_SILENCE_MS = 45 * 60 * 1000;

/** 活性判定的四态。done 与 active 分开——干完了不是卡住了。 */
export const LIVENESS_STATES = ['active', 'silent', 'done', 'unscanned'];

/** 驱动自报的终态 → 本模块的判定。认不出的字样一律不猜（走时间判据）。 */
const DRIVER_TERMINAL_STATES = new Map([
  ['completed', 'done'],
  ['done', 'done'],
  ['finished', 'done'],
  ['failed', 'done'],
  ['error', 'done'],
  ['cancelled', 'done'],
  ['canceled', 'done'],
]);

function parseAt(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * orca 终端 → 会话。**不再按 agentIdentity 过滤**：reclaude 起的终端就是靠这一点进采样面的。
 * 上次真动取 lastOutputAt——这个字段 orca 一直在返回，只是此前没有任何判据读它。
 */
export function sessionFromOrcaTerminal(t) {
  if (!t || !t.handle) return null;
  const at = parseAt(t.lastOutputAt);
  return {
    id: String(t.handle),
    driver: t.agentIdentity ? 'orca' : 'reclaude',
    label: String(t.title || t.displayName || t.handle),
    worktreeId: t.worktreeId || null,
    agentIdentity: t.agentIdentity || null,
    lastProgressAt: at,
    driverState: null,
    unscanned: at == null,
    why: at == null ? 'orca 终端没给 lastOutputAt——没查成，不当活着' : null,
    preview: typeof t.preview === 'string' ? t.preview : null,
  };
}

/**
 * mirasim 会话 → 会话。mirasim 自报 state（completed / incomplete / …），比刮屏可靠，优先用它。
 * 但 listSessions 不带时间戳：state 认不出终态、又没有时间 ⇒ unscanned，明说是缺时间戳，不猜「还活着」。
 */
export function sessionFromMirasimSession(s) {
  if (!s || !s.key) return null;
  const raw = s.state == null ? '' : String(s.state).toLowerCase();
  const terminal = DRIVER_TERMINAL_STATES.get(raw) || null;
  const at = parseAt(s.lastActivityAt ?? s.updatedAt ?? s.ts);
  const unscanned = !terminal && at == null;
  return {
    id: String(s.key),
    driver: 'mirasim',
    label: String(s.title || s.key),
    worktreeId: s.cwd || null,
    agentIdentity: null,
    lastProgressAt: at,
    driverState: raw || null,
    unscanned,
    why: unscanned
      ? `mirasim 会话 state=${raw || '(空)'} 不是终态，且没有活动时间戳——没查成，不当活着`
      : null,
    preview: typeof s.preview === 'string' ? s.preview : null,
  };
}

/**
 * 单个会话的活性。顺序：没查成 → 驱动自报终态 → 时间判据。
 * 「没查成」永远排在最前，因为它和「查过没事」必须分得开（本仓硬规矩）。
 */
export function assessLiveness(session, { now = Date.now(), thresholdMs = DEFAULT_SILENCE_MS } = {}) {
  if (!session || typeof session !== 'object') {
    return { state: 'unscanned', why: '没给会话对象——没查成' };
  }
  if (session.unscanned) {
    return { state: 'unscanned', why: session.why || '驱动答不上「上次真动」——没查成' };
  }
  const terminal = DRIVER_TERMINAL_STATES.get(String(session.driverState || '').toLowerCase());
  if (terminal) return { state: 'done', why: `驱动自报 ${session.driverState}` };
  const at = parseAt(session.lastProgressAt);
  if (at == null) {
    return { state: 'unscanned', why: '拿不到上次真动时间——没查成，不当活着' };
  }
  const silentMs = Math.max(0, now - at);
  if (silentMs >= thresholdMs) {
    return { state: 'silent', silentMs, why: `${Math.round(silentMs / 60000)} 分钟没有任何推进` };
  }
  return { state: 'active', silentMs, why: `${Math.round(silentMs / 60000)} 分钟前还在动` };
}

/**
 * 扫一轮。返回四态计数 + 静默清单 + 没查成清单。
 * 计数里 unscanned 单独一格，就是为了让「这轮压根没采到样本」与「采了都健康」在输出里长得不一样。
 */
export function scanLiveness({ sessions, now = Date.now(), thresholdMs = DEFAULT_SILENCE_MS } = {}) {
  if (!Array.isArray(sessions)) {
    return { ok: false, unscanned: true, error: '没给会话数组（没查成）', counts: null };
  }
  const counts = { active: 0, silent: 0, done: 0, unscanned: 0 };
  const silent = [];
  const unscanned = [];
  for (const s of sessions) {
    if (!s) continue;
    const a = assessLiveness(s, { now, thresholdMs });
    counts[a.state] = (counts[a.state] || 0) + 1;
    const row = { ...s, ...a };
    if (a.state === 'silent') silent.push(row);
    if (a.state === 'unscanned') unscanned.push(row);
  }
  const total = counts.active + counts.silent + counts.done + counts.unscanned;
  return {
    ok: true,
    // 采样面为空本身就是一种没查成：驱动全都没返回会话，跟「全都健康」不是一回事。
    sampledNothing: total === 0,
    counts,
    silent,
    unscanned,
    thresholdMs,
  };
}

/**
 * 静默会话按角色分流。审官静默 ⇒ 判死重起（走复审待办队列，一 PR 一审官的闸在那边）；
 * 其余静默 ⇒ 报帅。不在这里直接动手，只给动作意图，执行归调用方。
 */
export function routeSilent(session) {
  const label = String(session?.label || '');
  const isReviewer = /审官|reviewer/i.test(label);
  return isReviewer
    ? { action: 'restart-reviewer', why: `审官会话静默：${session?.why || ''}` }
    : { action: 'escalate', why: `会话静默：${session?.why || ''}` };
}
