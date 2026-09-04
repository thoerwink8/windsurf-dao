// scripts/lib/mirasim-monitor.mjs —— mirasim 执行体的保活/回收/健康（#880 卡 D）
//
// 卡 A（mirasim-runtime.mjs）冻结了五个动词；本文件是卡 D 新增的三块，全部只依赖
// 卡 A 的接口，不改它的文件：
//   ① 卡死判据（judgeStall）：换掉刮屏 stall——不看屏面，只看「该发生的事有没有发生」。
//      phase 还在跑，但账本行数 N 分钟没涨、快照正文也没变 → 判卡死。
//   ② 回收判据（judgeGcSession / judgeGcWorktree）：终态且过 TTL 的会话回收；分支已合并的树回收。
//   ③ 健康段（buildMirasimHealth）：服务在不在 + 版本、relay 模式与各 agent 路由、云端额度窗百分比。
//      —— 全部读真机（getState / getRelay 帧），不读策略表（策略是「该怎样」，健康表是「现在怎样」）。
//
// ★ 改这个文件前必须知道的一件事（PR #885 审官七条 P1 的共同根因）：
//   「读不到 / 没查成」一旦被编成「已知值」（账本读不到编成稳定的 rows='x'、partial 预览当
//   完整正文、Number(null) 折成 0、sessions:null 当空集），就会走进判死 / 回收 / 报健康 ok。
//   所以本文件只有 **一处** 判「查成了没有」——下面「没查成怎么传播」那一段
//   （gapReport / knownTimestamp / stallReadGaps）。新增判据一律从那儿取结论，
//   别在各自函数里另打补丁（八处补丁＝八个新洞）。
//
// ws op 名全部在 mirasim-server 的 server.cjs 里 grep 实证过，再连真机读回帧核对，
// 不是照参考实现假定的（2026-09-04 探测；2026-09-04 于真机 0.0.286 复核过下面每个字段）：
//   listSessions → {type:'sessions', sessions:[{sessionKey,agent,runState,updatedAt,numTurns,
//                    preview,workdir,branch,open,model,source,...}]}
//   getRelay     → {type:'relay', relay:{mode,available,agentRoutes,usage:{windows:[{label,
//                    usedPercent,remainingPercent,resetAt,status}]},...}}
//   deleteSession→ {type:'deleteSession', sessionKey, removeWorktree?:bool}（可连树一起删）
//   removeWorktree→ {type:'removeWorktree', path}
// 判官只吃入参、不碰 IO；wire 包装只收发、不判对错——判据不复用发消息那层。

import os from 'node:os';
import { openWire, PINNED_VERSION, liveServerPorts, DEFAULT_PORT } from './mirasim-runtime.mjs';

// 相位词表与 mirasim-runtime.mjs 对齐（那边没导出，这里各留一份，改了要一起改）。
// runState 词表取自 server.cjs 实证：`runState = ok ? 'completed' : 'incomplete'`，
// 另有 'running' 与 'queued'；服务端自己把 incomplete 映射成 'stalled' 展示。所以：
//   incomplete = 跑完了但没成 → 终态失败，不是卡死候选（别去 stop 一个已经停了的）。
//   queued     = 还没开跑 → 天然没有活性，绝不能按「账本不涨」判死。
// 真机 0.0.286 的 65 条会话里 30 条是 incomplete：把它当「还在跑」会一次误杀三十条。
export const DONE_PHASES = new Set(['done', 'complete', 'completed']);
export const FAILED_PHASES = new Set(['error', 'failed', 'aborted', 'cancelled', 'canceled', 'incomplete']);
export const PENDING_PHASES = new Set(['queued', 'pending', 'starting']);
const TERMINAL_PHASES = new Set([...DONE_PHASES, ...FAILED_PHASES]);

/** runState / phase 归一（照 runtime 的 normPhase）。 */
export function normPhase(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  if (s === 'complete' || s === 'completed') return 'done';
  return s;
}

export function isTerminalPhase(phase) {
  return TERMINAL_PHASES.has(normPhase(phase));
}

// ── 「没查成」怎么传播：全文件唯一一处判据（PR #885 审官七条 P1 的共同修法）────────
//
// 纪律三句：
//   ① 读不到 ≠ 值为 0/空/false。缺字段一律 null，绝不折成能参与算术或比较的值。
//   ② 一条读链路里只要有一格没查成，整条链路的结论就是 unknown——由 gapReport 汇总，
//      调用方按 unknown 走（不判死 / 不回收 / 不报 ok / exit 2），不许挑剩下那几格用。
//   ③ unknown 必须带得出「哪一格没查成」的人话（gaps[].why），否则没法排。

/**
 * 读链路盘点（唯一出处）。probes = [{name, known:boolean, why}]。
 * 返回 {ok, gaps:[{name,why}], why:'名字：原因；…'}；ok=false ⇒ 上层必须走 unknown。
 */
export function gapReport(probes = []) {
  const gaps = [];
  for (const p of Array.isArray(probes) ? probes : []) {
    if (!p || typeof p !== 'object') continue;
    if (p.known !== true) gaps.push({ name: String(p.name || '?'), why: String(p.why || '没查成') });
  }
  return { ok: gaps.length === 0, gaps, why: gaps.map(g => `${g.name}：${g.why}`).join('；') };
}

/**
 * 时间戳读回（唯一出处）。只认有限数值、纯数字串、可解析的时间串、Date；
 * null / undefined / 空串 / 非法值一律 null ——**绝不**走 Number() 折成 0
 * （审官第 6 条实咬：Number(null)===0 ⇒ 终态会话被当成静置几十年，立刻 GC）。
 */
export function knownTimestamp(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * 卡死判据的读链路盘点。判死要的证据只有两样算**主证**：
 *   · 完整快照正文（partial 预览不算——那只是前若干字，正文在变而预览不变时会误杀）
 *   · 账本行数（readable 才算；读不到既不冒充 0，也不冒充「稳定值」）
 * 两样任一没查成 → 整条 unknown，不进 stall TTL。
 * updatedAt 是**次证**：读不到只是少一次「看见它动了」的机会，不阻断判死，
 * 但也绝不折成 0（activitySig 里记 'x'，等它真有值时算「动过了」）。
 */
export function stallReadGaps({ view, ledger } = {}) {
  const v = view && typeof view === 'object' ? view : null;
  return gapReport([
    { name: '会话快照', known: !!v && v.missing !== true, why: v?.why || '快照与会话清单都没读到' },
    {
      name: '快照完整性',
      known: !!v && v.partial !== true,
      why: v?.why || '只读到会话清单的预览（partial）——正文没拿到，证不了「正文没变」',
    },
    { name: 'phase', known: !!v && !!normPhase(v.phase), why: '快照里没有 phase，判不出跑到哪' },
    {
      name: '账本',
      known: !!ledger && ledger.readable === true && Array.isArray(ledger.rows),
      why: ledger?.why || '账本读不到，证不了「行数没涨」',
    },
  ]);
}

/** 极轻量字符串指纹——只为「正文变没变」这一个是非题，不求抗碰撞。 */
function hashText(text) {
  const s = String(text || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h >>> 0}`;
}

/**
 * 活性指纹：把「该发生的事」压成一个串。任一分量前进都算「动过了」。
 *  - 账本行数：读不到记 'x'，不冒充 0
 *  - 快照正文哈希 + 长度
 *  - updatedAt：读不到记 'x'，不冒充 0
 * ⚠️ 这个串只在 stallReadGaps().ok 为真时才有「证明没动」的效力——'x' 是「没查成」的
 *   占位，两轮都是 'x' 只说明两轮都没查成，不说明它静止（审官第 1 条实咬）。
 */
export function activitySig({ ledger, text, updatedAt } = {}) {
  const rows = ledger && ledger.readable === true && Array.isArray(ledger.rows) ? ledger.rows.length : 'x';
  const at = knownTimestamp(updatedAt);
  return `${rows}|${hashText(text)}|${at === null ? 'x' : at}`;
}

/**
 * 卡死判据。只有「phase 还在跑」的会话才是候选。
 *  view   —— 卡 A readSession 的结果 {phase,text,missing,partial,why}
 *  ledger —— 卡 A readLedger 的结果 {readable,rows}
 *  updatedAt —— 会话清单里的 updatedAt（次要活性信号）
 *  prev   —— 上一轮账本里存的 {sig, sinceTs}（sinceTs = 这个指纹第一次出现的时刻）
 *  now / stallMs —— 现在、判死阈值
 * 返回 {status, reason, sig, sinceTs, gaps?}
 *  status: 'unknown'（读不到，没查成，绝不判死）| 'terminal'（已终态，交给 GC）
 *          | 'pending'（还没开跑，天然没活性，不判死）
 *          | 'live'（动过 或 还在宽限窗内）| 'stalled'（判死）
 */
export function judgeStall({ view, ledger, updatedAt, prev, now, stallMs } = {}) {
  const sig = activitySig({ ledger, text: view?.text, updatedAt });
  // ① 先过「没查成」闸。读链路任一主证缺失 → unknown，不进 stall TTL。
  //    sinceTs 顶到现在，避免下一轮拿旧窗接着误判。
  const gaps = stallReadGaps({ view, ledger });
  if (!gaps.ok) {
    return { status: 'unknown', reason: `${gaps.why}（没查成，不判死）`, sig, sinceTs: now, gaps: gaps.gaps };
  }
  const phase = normPhase(view.phase);
  if (TERMINAL_PHASES.has(phase)) {
    return { status: 'terminal', reason: `已到终态 ${phase}，不是卡死候选`, sig, sinceTs: now };
  }
  if (PENDING_PHASES.has(phase)) {
    return { status: 'pending', reason: `${phase} 还没开跑，天然没有活性，不判死`, sig, sinceTs: now };
  }
  // 到这里 phase 还在跑，且证据齐。看活性指纹动没动。
  const changed = !prev || prev.sig !== sig;
  if (changed) {
    return { status: 'live', reason: `${phase} 且活性在动（账本/正文/时间戳有前进）`, sig, sinceTs: now };
  }
  const stillMs = Number.isFinite(prev.sinceTs) ? now - prev.sinceTs : 0;
  if (stillMs >= stallMs) {
    const mins = Math.round(stillMs / 60000);
    return {
      status: 'stalled',
      reason: `${phase} 卡着不动：账本没涨、正文没变已 ${mins} 分钟（阈值 ${Math.round(stallMs / 60000)} 分钟）`,
      sig,
      sinceTs: prev.sinceTs,
    };
  }
  return {
    status: 'live',
    reason: `${phase} 静默 ${Math.round(stillMs / 60000)} 分钟，还没到判死阈值`,
    sig,
    sinceTs: prev.sinceTs,
  };
}

/** 错误指纹：给「两连同→不救报帅」用。取错误正文首行归一。 */
export function errorFingerprint(view) {
  const raw = view && typeof view.error === 'string' ? view.error : '';
  const first = raw.split('\n')[0].trim().slice(0, 120);
  return first ? first.replace(/[0-9a-f]{8,}/gi, '#').replace(/\d+/g, 'N') : null;
}

/**
 * 会话 GC 判据。终态 + 不 open + 过 TTL 才回收。
 *  meta —— 会话清单一条 {runState,updatedAt,open}
 * 返回 {gc, reason, terminal}
 * 「读不到」的三格全部 fail-closed 不回收：open 不是布尔、updatedAt 不是有效时间、now 不是数。
 */
export function judgeGcSession({ meta, now, ttlMs } = {}) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const phase = normPhase(m.runState);
  const terminal = TERMINAL_PHASES.has(phase);
  if (!terminal) {
    const why = PENDING_PHASES.has(phase) ? `${phase} 还没开跑` : `还在跑（${phase || '无 runState'}）`;
    return { gc: false, terminal: false, reason: `${why}，不回收` };
  }
  if (m.open === true) return { gc: false, terminal: true, reason: `${phase} 但连接仍 open，先不回收` };
  if (typeof m.open !== 'boolean') {
    return { gc: false, terminal: true, reason: 'open 字段读不到，判不了连接还在不在（没查成，不回收）' };
  }
  const at = knownTimestamp(m.updatedAt);
  const nowMs = knownTimestamp(now);
  if (at === null) {
    return {
      gc: false,
      terminal: true,
      reason: `updatedAt 不是有效时间（${JSON.stringify(m.updatedAt ?? null)}），算不出 TTL（没查成，不回收）`,
    };
  }
  if (nowMs === null) return { gc: false, terminal: true, reason: '没给有效的 now，算不出 TTL（没查成，不回收）' };
  const age = nowMs - at;
  if (age < ttlMs) {
    return {
      gc: false,
      terminal: true,
      reason: `${phase} 但只过了 ${Math.round(age / 60000)} 分钟（TTL ${Math.round(ttlMs / 60000)} 分钟）`,
    };
  }
  return { gc: true, terminal: true, reason: `${phase} 且静置 ${Math.round(age / 60000)} 分钟 > TTL，回收` };
}

/** 路径归一（比对保护名单用）：统一斜杠、去尾斜杠、小写（Windows 大小写不敏感）。 */
function normPath(p) {
  return String(p || '').split('\\').join('/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 工作树 GC 判据。只回收「分支已合并」的树。是否合并由调用方用 git 探好传进来，
 * 探不到（merged==null）一律不回收（没查成不动手）。
 *  branch —— 这棵树**当前在哪条分支**。会话清单的 branch 字段真机常为 null 或 'master'
 *            （0.0.286 实测 65 条：一半 null、一半 'master'），所以调用方要么反查 workdir，
 *            要么传 null 让这里拒掉——绝不拿会话字段冒充树的现状。
 *  defaultBranch —— 默认分支。挂着它的树永远算「已合并」，回收=误删，直接拒。
 *  protectedPaths —— 绝不回收的路径（本仓根/主树）。
 */
export function judgeGcWorktree({ path, branch, merged, defaultBranch = 'master', protectedPaths = [] } = {}) {
  if (!path) return { gc: false, reason: '没给树路径' };
  const target = normPath(path);
  for (const p of Array.isArray(protectedPaths) ? protectedPaths : []) {
    if (p && normPath(p) === target) return { gc: false, reason: `树 ${path} 在保护名单里（主树/本仓根），不回收` };
  }
  if (!branch) return { gc: false, reason: `树 ${path} 当前在哪条分支没查成（不回收）` };
  if (branch === 'HEAD') return { gc: false, reason: `树 ${path} HEAD 游离，判不了合没合并（不回收）` };
  if (branch === defaultBranch) {
    return { gc: false, reason: `树挂着默认分支 ${defaultBranch}——它永远算「已合并」，回收就是误删（不回收）` };
  }
  if (merged == null) return { gc: false, reason: `分支 ${branch} 是否已合并没查成（不回收）` };
  if (merged === false) return { gc: false, reason: `分支 ${branch} 还没合并，不回收` };
  return { gc: true, reason: `分支 ${branch} 已合并，回收树 ${path}` };
}

/** 一个额度窗折成健康表要的形状。 */
function windowView(w) {
  const o = w && typeof w === 'object' ? w : {};
  return {
    label: typeof o.label === 'string' ? o.label : '?',
    usedPercent: Number.isFinite(Number(o.usedPercent)) ? Number(o.usedPercent) : null,
    remainingPercent: Number.isFinite(Number(o.remainingPercent)) ? Number(o.remainingPercent) : null,
    status: typeof o.status === 'string' ? o.status : null,
  };
}

/**
 * 健康段（纯函数）。吃真机读回的 state 与 relay 帧，产出一段可进健康表的结论。
 *  input:
 *    state    —— getState 的 state 对象（连不上/没查成传 null）
 *    relay    —— getRelay 的 relay 对象（同上）
 *    connectError —— 连不上时的原因（有值 → 服务多半没在跑）
 *    pinnedVersion —— 钉死版本（默认取卡 A 的 PINNED_VERSION，别在这儿抄第二份值）
 * 返回 {state:'ok'|'red'|'unknown', probed, version, versionOk, mode, available, agentRoutes, windows, notes}
 *  state 三态照检查器纪律：ok=查过且对；red=查过不对；unknown=没查成（连不上/缺字段）。
 *  available（真机 0.0.286 的 relay 帧确带此字段，typeof boolean）：false=中转明确不可用→红；
 *  缺字段=可用性没查成→unknown。绝不因为「其它格都齐」就放行（审官第 5 条实咬）。
 */
export function buildMirasimHealth({ state, relay, connectError, pinnedVersion = PINNED_VERSION } = {}) {
  const notes = [];
  if (connectError) {
    return {
      state: 'red', probed: true, version: null, versionOk: false,
      mode: null, available: null, agentRoutes: null, windows: [],
      notes: [`连不上回环 ws（服务多半没在跑）：${connectError}`],
    };
  }
  if (!state || typeof state !== 'object') {
    return {
      state: 'unknown', probed: false, version: null, versionOk: false,
      mode: null, available: null, agentRoutes: null, windows: [],
      notes: ['没收到 state 帧，服务在不在没查成'],
    };
  }
  const version = typeof state.version === 'string' ? state.version : null;
  const versionOk = version === pinnedVersion;
  if (!versionOk) notes.push(`版本 ${version || '(空)'} ≠ 钉死 ${pinnedVersion}`);

  let mode = null;
  let agentRoutes = null;
  let available = null;
  let windows = [];
  if (!relay || typeof relay !== 'object') {
    notes.push('没收到 relay 帧，模式/路由/可用性/额度窗没查成');
  } else {
    mode = typeof relay.mode === 'string' ? relay.mode : null;
    agentRoutes = relay.agentRoutes && typeof relay.agentRoutes === 'object' ? relay.agentRoutes : null;
    available = typeof relay.available === 'boolean' ? relay.available : null;
    const ws = relay.usage && Array.isArray(relay.usage.windows) ? relay.usage.windows : null;
    if (ws) windows = ws.map(windowView);
    else notes.push('relay 帧里没有 usage.windows，额度窗没查成');
    if (mode == null) notes.push('relay 帧里没有 mode，中转模式没查成');
    if (agentRoutes == null) notes.push('relay 帧里没有 agentRoutes，各 agent 路由没查成');
    if (available === false) notes.push('relay.available=false——云端中转当前不可用（派前探针不许放行）');
    else if (available == null) notes.push('relay 帧里没有 available 字段，中转可用性没查成');
  }

  // 结论：版本不符、relay 明确不可用是真红；只要有「没查成」的分量就 unknown；全齐才 ok。
  const gaps = gapReport([
    { name: 'relay 帧', known: !!relay && typeof relay === 'object', why: '没收到' },
    { name: 'mode', known: mode != null, why: '缺字段' },
    { name: 'agentRoutes', known: agentRoutes != null, why: '缺字段' },
    { name: 'available', known: typeof available === 'boolean', why: '缺字段' },
    { name: '额度窗', known: windows.length > 0, why: '一个也没读到' },
  ]);
  const st = !versionOk || available === false ? 'red' : gaps.ok ? 'ok' : 'unknown';
  return { state: st, probed: true, version, versionOk, mode, available, agentRoutes, windows, notes };
}

// ── wire 包装（只收发，不判对错；判据在上面的纯判官） ────────────────────────

/** 枚举全部会话。返回 sessions[] 或 null（没查成）。 */
export async function wireListSessions(wire, timeoutMs = 6000) {
  wire.send({ type: 'listSessions' });
  const msg = await wire.waitFor(m => m && m.type === 'sessions', timeoutMs);
  return msg && Array.isArray(msg.sessions) ? msg.sessions : null;
}

/** 读 relay 帧（模式/路由/额度窗）。返回 relay 对象或 null。 */
export async function wireGetRelay(wire, timeoutMs = 5000) {
  wire.send({ type: 'getRelay' });
  const msg = await wire.waitFor(m => m && m.type === 'relay', timeoutMs);
  return msg && msg.relay && typeof msg.relay === 'object' ? msg.relay : null;
}

/**
 * 「短窗没 error 帧」这一招的唯一正确用法（照 runtime stopSession/interact 的写法）：
 * 连接断了/出错时 waitFor 也回 null——那是**没查成**，不是成功。
 * 审官第 4 条实咬：closed/failure 的线上 waitFor 回 null 被当成 ok:true 报「删成了」。
 * 注意这里只判「送进去了没」；「真删掉了没」一律靠调用方回读清单/看树还在不在自证。
 */
async function sendAndCheckAck(wire, frame, ackMs, rejectWhy) {
  try {
    wire.send(frame);
  } catch (e) {
    return { ok: false, why: `这一帧没发出去（${e?.message || e}）` };
  }
  const err = await wire.waitFor(m => m && m.type === 'error', ackMs);
  if (err) return { ok: false, why: err.message || rejectWhy };
  if (wire.closed || wire.failure) {
    return { ok: false, why: `连接断了（${wire.failure || 'closed'}），这一帧送没送到没查成` };
  }
  return { ok: true, why: null };
}

/** 删会话（可连树一起删）。ok:true 只代表「送进去了」，删成没成由调用方回读自证。 */
export async function wireDeleteSession(wire, { sessionKey, removeWorktree = false } = {}, ackMs = 1500) {
  return sendAndCheckAck(
    wire,
    { type: 'deleteSession', sessionKey, ...(removeWorktree ? { removeWorktree: true } : {}) },
    ackMs,
    '删会话被拒',
  );
}

/** 删工作树。ok:true 同样只代表「送进去了」。 */
export async function wireRemoveWorktree(wire, { path } = {}, ackMs = 1500) {
  return sendAndCheckAck(wire, { type: 'removeWorktree', path }, ackMs, '删树被拒');
}

// ── 共用采集器：一次连线读齐健康 / 保活 / 回收 / 额度都要的真机状态 ──────────────
// 帅位 2026-09-04 补：健康表段、派前 relay 腿探活、land 保护树、#881 额度统计——
// 全部读同一份采集，别各连各的、各判各的。

/** 活动会话的 workdir 集合（给 land 保护「mirasim 在用的树」）。open 或非终态都算在用。 */
export function activeWorkdirs(sessions) {
  const set = new Set();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s !== 'object' || typeof s.workdir !== 'string' || !s.workdir) continue;
    const terminal = TERMINAL_PHASES.has(normPhase(s.runState));
    if (s.open === true || !terminal) set.add(s.workdir);
  }
  return set;
}

/**
 * 「服务压根没在跑」的判别串。卡 A 的 readToken 在回环令牌文件读不到时抛这句；
 * 令牌文件是**服务在跑时才存在**的（~/.mirasim/run/local-<port>.token，一端口一份，
 * 2026-09-04 本机实证：只有 4970 有，4316 没有），所以「连令牌都没有」是
 * 「这个端口上没有服务」的正证据，不是「没查成」。
 * ⚠️ 这是一个指向卡 A 文案的指针：tests/mirasim-unknown.test.js 里有一条真调
 * 卡 A openWire 的检查，卡 A 改了这句文案那条测试就翻红（不留指向空气的指针）。
 */
export const SERVER_ABSENT_HINT = '读不到回环会话令牌';

/**
 * 该敲哪个端口（纯函数）。别写死 4316 去猜：本机服务在 4970 时，敲 4316 读不到令牌，
 * 会被说成「服务没在跑」，下游据此去删树（2026-09-04 实咬）。
 * 令牌文件名就写着端口，这是**读得到的事实**，不用猜。
 *  显式 port > MIRASIM_PORT > 只有一个在跑的端口 > 在跑的里含默认端口 > 默认端口
 * 多个在跑且不含默认端口 ⇒ port:null（不猜，交给调用方按「没查成」处置）。
 * 返回 {port, why}
 */
export function resolveProbePort({ port, envPort, live, defaultPort = DEFAULT_PORT } = {}) {
  const explicit = Number(port);
  if (Number.isFinite(explicit) && explicit > 0) return { port: explicit, why: `调用方指定 ${explicit}` };
  const env = Number(envPort);
  if (Number.isFinite(env) && env > 0) return { port: env, why: `MIRASIM_PORT=${env}` };
  const ports = live && live.readable === true && Array.isArray(live.ports) ? live.ports : null;
  if (!ports) return { port: Number(defaultPort), why: `本机服务端口没查成，退回默认 ${defaultPort}` };
  if (ports.length === 1) return { port: ports[0], why: `本机只有一个 mirasim 在跑：${ports[0]}（令牌文件读回来的）` };
  if (ports.includes(Number(defaultPort))) return { port: Number(defaultPort), why: `在跑的端口里有默认 ${defaultPort}` };
  if (ports.length === 0) return { port: Number(defaultPort), why: `本机没有 mirasim 在跑，仍按默认 ${defaultPort} 敲一下确认` };
  return { port: null, why: `本机有多个 mirasim 在跑（${ports.join('/')}）且都不是默认端口——不猜该敲哪个（没查成）` };
}

/**
 * 「这台机器上到底有没有 mirasim 服务在跑」——只有这个能支撑「没有会话在用树」。
 * 别拿「我敲的那个端口没令牌」代替它：本机服务在 4970 时去敲 4316 一样读不到令牌，
 * 而那台服务上真有 65 条带 workdir 的会话（2026-09-04 实咬，这一版加的洞，当场堵掉）。
 * 返回 {absent:true|false|null}；null = 连有没有都没查成（一律按看不见处理）。
 */
export function judgeServerPresence({ probedPort, live } = {}) {
  if (!live || live.readable !== true) return { absent: null, why: live?.why || '本机有没有 mirasim 服务没查成' };
  const ports = Array.isArray(live.ports) ? live.ports : [];
  if (ports.length === 0) return { absent: true, why: '本机一个端口上都没有 mirasim 服务（回环令牌一份都没有）' };
  const others = ports.filter(p => Number(p) !== Number(probedPort));
  if (others.length) {
    return { absent: false, why: `服务在 ${others.join('/')} 上跑着，我敲的是 ${probedPort}——端口对不上，不是「没有服务」` };
  }
  return { absent: false, why: `端口 ${probedPort} 上有服务（令牌在）` };
}

/**
 * land 删树前的前置闸（纯函数）。ws 连上了 ≠ 会话枚举成了：
 * listSessions 超时/没回帧时 sessions 是 null，activeWorkdirs 是空集——
 * 把它当「没有活动树」就会删掉正在用的树（审官第 3 条实咬）。
 *
 * 三态，别混成两态：
 *  ① probed        —— 连上且清单是数组：活动集是事实，按它保护树。
 *  ② blocking      —— **服务在跑但我没看见它的会话**（连上了清单没回帧；或令牌在、
 *     ws 却连不上/超时=服务多半卡着）。这时「没有活动树」和「看不见活动树」分不开，
 *     调用方这一轮**跳过全部删树**。
 *  ③ 服务没在跑    —— 连令牌都没有 ⇒ 没有 mirasim 会话 ⇒ 也就没有它在用的树。
 *     空集是事实，不 blocking（否则本机/CI 没起 mirasim 时 land 永远不敢清树）。
 * 返回 {probed, blocking, serverAbsent, why, workdirs}
 */
export function judgeWorkdirProbe(collected) {
  const c = collected && typeof collected === 'object' ? collected : null;
  const connectError = typeof c?.connectError === 'string' ? c.connectError : '';
  // 「服务没在跑」只认 judgeServerPresence 的结论（看全机令牌），不认单个端口读不到令牌。
  const presence = c?.presence && typeof c.presence === 'object' ? c.presence : { absent: null, why: '采集没带 presence（没查成）' };
  const serverAbsent = c?.reachable !== true && presence.absent === true;
  const g = gapReport([
    { name: 'ws 连线', known: c?.reachable === true, why: connectError || '连不上回环 ws' },
    { name: '会话清单', known: Array.isArray(c?.sessions), why: 'listSessions 没回 sessions 帧（超时/无回帧）' },
  ]);
  return {
    probed: g.ok,
    blocking: !g.ok && !serverAbsent,
    serverAbsent,
    why: serverAbsent
      ? `${presence.why}——没有 mirasim 会话，也就没有它在用的树（空集是事实）`
      : `${g.why}${presence.absent === false ? `；${presence.why}` : ''}`,
    workdirs: g.ok && c.activeWorkdirs instanceof Set ? c.activeWorkdirs : new Set(),
  };
}

/**
 * 额度窗落盘记录（#881 读这一份；一个文件一个写者＝本采集器）。
 * 路径约定 ~/.dao/mirasim-usage.json，格式如下——纯函数，写盘由调用方做。
 */
export function usageRecord({ relay, host, port, now } = {}) {
  const mode = relay && typeof relay.mode === 'string' ? relay.mode : null;
  const available = relay && typeof relay.available === 'boolean' ? relay.available : null;
  const agentRoutes = relay && relay.agentRoutes && typeof relay.agentRoutes === 'object' ? relay.agentRoutes : null;
  const windows = relay && relay.usage && Array.isArray(relay.usage.windows)
    ? relay.usage.windows.map(windowView) : [];
  const notes = [];
  if (!relay) notes.push('没收到 relay 帧，额度窗没查成');
  else if (windows.length === 0) notes.push('relay 帧里没有 usage.windows，额度窗没查成');
  if (relay && available === null) notes.push('relay 帧里没有 available 字段，中转可用性没查成');
  return {
    schema: 'mirasim-usage/1',
    updatedAt: knownTimestamp(now) ?? Date.now(),
    host: host || null,
    port: Number(port) || null,
    mode,
    available,
    agentRoutes,
    windows,
    readable: windows.length > 0,
    notes,
  };
}

/**
 * 单个 agent 的 relay 腿探活裁决（给派前探针/熔断用，target key = `mirasim:<agent>`）。
 * 探活 = 契约通过（版本对）+ 该 agent 的路由确实走 relay + relay.available 明确为 true。
 * 注：账本成功率是「可选」的加强判据（帅位补），本版先只做契约+路由+available，
 *     账本腿留给后面（见 PR「没查成/留给后面」）。
 * 返回 {target, state:'ok'|'red'|'unknown', why}
 */
export function probeMirasimTarget({ agent, health } = {}) {
  const target = `mirasim:${agent}`;
  if (!health || health.probed !== true) {
    return { target, state: 'unknown', why: health?.notes?.join('；') || '没采到 mirasim 健康（没查成）' };
  }
  if (health.state === 'red') return { target, state: 'red', why: health.notes?.join('；') || '健康段判红' };
  const routes = health.agentRoutes;
  if (!routes) return { target, state: 'unknown', why: '没读到 agentRoutes（没查成）' };
  const leg = routes[agent];
  if (leg == null) return { target, state: 'unknown', why: `agentRoutes 里没有 ${agent}（没查成）` };
  if (leg !== 'relay') return { target, state: 'ok', why: `${agent} 走 ${leg}（不烧 mirasim relay 腿）` };
  // 走 relay：available 必须明确为 true，再看额度窗读到没
  if (health.available === false) {
    return { target, state: 'red', why: `${agent}→relay 但 relay.available=false（中转不可用，不许放行）` };
  }
  if (health.available !== true) {
    return { target, state: 'unknown', why: `${agent}→relay 但 relay.available 没读到（没查成）` };
  }
  if (!health.windows.length) return { target, state: 'unknown', why: `${agent}→relay 但额度窗没读到（没查成）` };
  return { target, state: 'ok', why: `${agent}→relay 且 available，额度窗读到 ${health.windows.length} 个` };
}

/**
 * 共用采集：连一次 ws，把 state / relay / sessions 一次读齐，产出健康段、额度记录、
 * 活动树集合、每 agent 探活。连不上不抛——返回 reachable:false + connectError，让调用方
 * 各自决定「没查成」怎么处置。
 *  opts: { open, port, homeDir, now, pinnedVersion, agents, serverPorts }
 *    open —— 注入的开线函数（测试用假线）；默认用 runtime 的 openWire
 *    serverPorts —— 注入的「本机哪些端口有服务」读法（测试用假的）；默认卡 A 的 liveServerPorts
 * 端口解析交给 openWire（opts → MIRASIM_PORT → 默认），这里不再自己算一份。
 * ⚠️ reachable:true 只说明 ws 连上了。会话枚举成没成看 sessionsKnown（或过 judgeWorkdirProbe）。
 * presence 只在连不上时才需要：它把「服务没在跑」和「我敲错端口/服务卡着」分开——
 * 前者可以推出「没有会话在用树」，后两者不行。
 */
export async function probeMirasim({ open = openWire, port, homeDir, now = () => Date.now(), pinnedVersion = PINNED_VERSION, agents, serverPorts = liveServerPorts, listTimeoutMs = 15_000 } = {}) {
  const host = os.hostname();
  // 先读「本机哪些端口有服务」，据此定该敲哪个；这一读也是后面分辨
  // 「服务没在跑」和「我敲错了 / 服务卡着」的唯一依据。
  let live;
  try { live = serverPorts(homeDir); } catch (err) { live = { readable: false, ports: [], why: `本机服务清单没查成：${err?.message || err}` }; }
  const picked = resolveProbePort({ port, envPort: process.env.MIRASIM_PORT, live });
  const probedPort = picked.port;
  const fail = (connectError) => ({
    reachable: false, connectError, host, port: probedPort,
    state: null, relay: null, sessions: null, sessionsKnown: false,
    presence: judgeServerPresence({ probedPort, live }),
    portWhy: picked.why,
    health: buildMirasimHealth({ state: null, relay: null, connectError, pinnedVersion }),
    usage: usageRecord({ relay: null, host, port: probedPort, now: now() }),
    activeWorkdirs: new Set(), perAgent: {},
  });
  // 该敲哪个都没定下来：不瞎敲，直接报没查成（presence 会是 absent:false，下游 blocking）
  if (probedPort == null) return fail(picked.why);
  let wire = null;
  try {
    wire = await open({ homeDir, port: probedPort });
  } catch (e) {
    return fail(e?.message || String(e));
  }
  try {
    const state = wire.state || null;
    const relay = await wireGetRelay(wire);
    // 会话清单给足时间：真机 65 条、机器忙时 6 秒会超时，而超时=没查成=land 一棵树都不拆。
    // 宁可这条命令多等几秒，也不要因为「等不及」就把树的保护判成没查成（2026-09-04 实咬）。
    const sessions = await wireListSessions(wire, listTimeoutMs);
    const health = buildMirasimHealth({ state, relay, pinnedVersion });
    const usage = usageRecord({ relay, host, port: probedPort, now: now() });
    const routeAgents = agents || (health.agentRoutes ? Object.keys(health.agentRoutes) : []);
    const perAgent = {};
    for (const a of routeAgents) perAgent[a] = probeMirasimTarget({ agent: a, health });
    return {
      reachable: true, connectError: null, host, port: probedPort,
      state, relay, sessions, sessionsKnown: Array.isArray(sessions),
      presence: { absent: false, why: '连上了，服务就在跑' },
      portWhy: picked.why,
      health, usage, activeWorkdirs: activeWorkdirs(sessions), perAgent,
    };
  } finally {
    wire.close();
  }
}
