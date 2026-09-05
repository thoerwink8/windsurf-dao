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
    // 卡名优先于终端标题。四家 CLI 都会盖掉 orca 设的标题，盖成一行 shell 提示符
    // （memory cc-session-name-terminal-title），拿它当名字有两个后果：播报里是一串路径，
    // 而且换人判据 parseReviewerCardName 认不出「PR-N-审官-模型」，静默审官全落到「只报警」——
    // 2026-09-05 服务器 dry-run 实测 9 个静默审官一个都没换成人，就是死在这一格。
    label: String(t.displayName || t.title || t.handle),
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

// ── 推进签名：把「有输出」和「有推进」分开 ────────────────────────────────────
//
// 2026-09-05 实咬：盘面 45 个会话判 active，其中 37 个是 pi 的 TUI 在空转重画边框
// （标题恒为 Pi ready，屏面只剩一条横线）。lastOutputAt 每次重画都刷新，
// 于是「一个字没干的终端」永远是 active——假阳率 82%，僵尸卡因此永远清不掉。
//
// 不用「认那几个字」修：那是又一层指纹，pi 改一版横幅就静默失效。
// 判据回到本模块开头那句话——**有没有可验证的推进**：把屏面内容做签名，跨轮比对。
// 内容变了才叫推进；内容一模一样，不管它刷新多少次都不是。
// 代价是要跨轮记账（第一轮只能记，判不了），换来的是与驱动、与厂商、与横幅文案全部无关。

/** 屏面内容签名。标题 + 屏面正文，去掉纯装饰行（TUI 边框重画时长度会抖）与空白差异。 */
export function progressSignature(session) {
  const raw = `${session?.label || ''} ${session?.preview || ''}`;
  const body = raw.replace(/[─-╿|=_.-]{8,}/g, '').replace(/\s+/g, ' ').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i += 1) {
    h = Math.imul(h ^ body.charCodeAt(i), 0x01000193) >>> 0;
  }
  return `${body.length}:${h.toString(36)}`;
}

/**
 * 用上一轮的签名账本修正每个会话的「上次真推进」。
 *
 * 签名变了 → 这一轮有推进，since = now。
 * 签名没变 → 屏上一个字没动，since 保持上一轮记的时刻（静默时长持续累加）。
 * 账本里没有 → 第一次见，since = now（第一轮不冤枉谁，第二轮起才判得出静默）。
 *
 * 返回 { sessions, memory }：sessions 的 lastProgressAt 已被换成签名 since，
 * memory 要落盘，下一轮传回来。
 */
export function applyProgressMemory({ sessions, memory, now = Date.now() } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const prev = memory && typeof memory === 'object' ? memory : {};
  const next = {};
  const out = [];
  for (const s of list) {
    if (!s || !s.id) { out.push(s); continue; }
    const sig = progressSignature(s);
    const old = prev[s.id];
    const since = old && old.sig === sig && Number.isFinite(Number(old.since))
      ? Number(old.since)
      : now;
    next[s.id] = { sig, since };
    // 驱动报的 lastProgressAt 与签名 since 取更早的那个：驱动说它 10 小时没输出，
    // 就不能因为「这是本轮第一次见到它」把它洗成刚刚才动过。
    const reported = typeof s.lastProgressAt === 'number' ? s.lastProgressAt : null;
    const merged = reported == null ? since : Math.min(reported, since);
    out.push({ ...s, lastProgressAt: merged, progressSig: sig, progressSince: since });
  }
  return { sessions: out, memory: next };
}
