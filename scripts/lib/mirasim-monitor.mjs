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
// ws op 名全部在 mirasim-server 0.0.282 的 server.cjs 里 grep 实证过，再连真机读回帧核对，
// 不是照参考实现假定的（2026-09-04 探测记录）：
//   listSessions → {type:'sessions', sessions:[{sessionKey,agent,runState,updatedAt,numTurns,
//                    preview,workdir,branch,open,model,source,...}]}
//   getRelay     → {type:'relay', relay:{mode,agentRoutes,usage:{windows:[{label,usedPercent,
//                    remainingPercent,resetAt,status}]},...}}
//   deleteSession→ {type:'deleteSession', sessionKey, removeWorktree?:bool}（可连树一起删）
//   removeWorktree→ {type:'removeWorktree', path}
// 判官只吃入参、不碰 IO；wire 包装只收发、不判对错——判据不复用发消息那层。

import os from 'node:os';
import { openWire } from './mirasim-runtime.mjs';

// 相位词表与 mirasim-runtime.mjs 对齐（那边没导出，这里各留一份，改了要一起改）。
export const DONE_PHASES = new Set(['done', 'complete', 'completed']);
export const FAILED_PHASES = new Set(['error', 'failed', 'aborted', 'cancelled', 'canceled']);
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

/** 极轻量字符串指纹——只为「正文变没变」这一个是非题，不求抗碰撞。 */
function hashText(text) {
  const s = String(text || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h >>> 0}`;
}

/**
 * 活性指纹：把「该发生的事」压成一个串。任一分量前进都算「动过了」。
 *  - 账本行数（readLedger 的 rows.length）：读不到记 'x'，不冒充 0
 *  - 快照正文哈希 + 长度
 *  - updatedAt（会话清单的时间戳，跨连接一定读得到）
 */
export function activitySig({ ledger, text, updatedAt } = {}) {
  const rows = ledger && ledger.readable === true && Array.isArray(ledger.rows) ? ledger.rows.length : 'x';
  return `${rows}|${hashText(text)}|${Number(updatedAt) || 0}`;
}

/**
 * 卡死判据。只有「phase 还在跑」的会话才是候选。
 *  view   —— 卡 A readSession 的结果 {phase,text,missing}
 *  ledger —— 卡 A readLedger 的结果 {readable,rows}
 *  updatedAt —— 会话清单里的 updatedAt（次要活性信号）
 *  prev   —— 上一轮账本里存的 {sig, sinceTs}（sinceTs = 这个指纹第一次出现的时刻）
 *  now / stallMs —— 现在、判死阈值
 * 返回 {status, reason, sig, sinceTs}
 *  status: 'unknown'（读不到，没查成，绝不判死）| 'terminal'（已终态，交给 GC）
 *          | 'live'（动过 或 还在宽限窗内）| 'stalled'（判死）
 */
export function judgeStall({ view, ledger, updatedAt, prev, now, stallMs } = {}) {
  const sig = activitySig({ ledger, text: view?.text, updatedAt });
  if (!view || view.missing) {
    // 读不到会话状态：没查成。不判死也不判活，指纹留着但把 sinceTs 顶到现在，避免拿旧窗误判。
    return { status: 'unknown', reason: view?.why || '读不到会话快照与清单（没查成）', sig, sinceTs: now };
  }
  const phase = normPhase(view.phase);
  if (!phase) {
    return { status: 'unknown', reason: '快照里没有 phase，判不出跑到哪（没查成）', sig, sinceTs: now };
  }
  if (TERMINAL_PHASES.has(phase)) {
    return { status: 'terminal', reason: `已到终态 ${phase}，不是卡死候选`, sig, sinceTs: now };
  }
  // 到这里 phase 还在跑。看活性指纹动没动。
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
 */
export function judgeGcSession({ meta, now, ttlMs } = {}) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const phase = normPhase(m.runState);
  const terminal = TERMINAL_PHASES.has(phase);
  if (!terminal) return { gc: false, terminal: false, reason: `还在跑（${phase || '无 runState'}），不回收` };
  if (m.open === true) return { gc: false, terminal: true, reason: `${phase} 但连接仍 open，先不回收` };
  const age = Number.isFinite(Number(m.updatedAt)) ? now - Number(m.updatedAt) : null;
  if (age === null) return { gc: false, terminal: true, reason: 'updatedAt 读不到，算不出 TTL（没查成，不回收）' };
  if (age < ttlMs) {
    return { gc: false, terminal: true, reason: `${phase} 但只过了 ${Math.round(age / 60000)} 分钟（TTL ${Math.round(ttlMs / 60000)} 分钟）` };
  }
  return { gc: true, terminal: true, reason: `${phase} 且静置 ${Math.round(age / 60000)} 分钟 > TTL，回收` };
}

/**
 * 工作树 GC 判据。只回收「分支已合并」的树。是否合并由调用方用 git 探好传进来，
 * 探不到（merged==null）一律不回收（没查成不动手）。
 */
export function judgeGcWorktree({ path, branch, merged } = {}) {
  if (!path) return { gc: false, reason: '没给树路径' };
  if (!branch) return { gc: false, reason: '会话没登记分支，判不了是否已合并（不回收）' };
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
 *    pinnedVersion —— 钉死版本
 * 返回 {state:'ok'|'red'|'unknown', probed, version, versionOk, mode, agentRoutes, windows, notes}
 *  state 三态照检查器纪律：ok=查过且对；red=查过不对；unknown=没查成（连不上/缺字段）。
 */
export function buildMirasimHealth({ state, relay, connectError, pinnedVersion = '0.0.282' } = {}) {
  const notes = [];
  if (connectError) {
    return {
      state: 'red', probed: true, version: null, versionOk: false,
      mode: null, agentRoutes: null, windows: [],
      notes: [`连不上回环 ws（服务多半没在跑）：${connectError}`],
    };
  }
  if (!state || typeof state !== 'object') {
    return {
      state: 'unknown', probed: false, version: null, versionOk: false,
      mode: null, agentRoutes: null, windows: [],
      notes: ['没收到 state 帧，服务在不在没查成'],
    };
  }
  const version = typeof state.version === 'string' ? state.version : null;
  const versionOk = version === pinnedVersion;
  if (!versionOk) notes.push(`版本 ${version || '(空)'} ≠ 钉死 ${pinnedVersion}`);

  let mode = null;
  let agentRoutes = null;
  let windows = [];
  if (!relay || typeof relay !== 'object') {
    notes.push('没收到 relay 帧，模式/路由/额度窗没查成');
  } else {
    mode = typeof relay.mode === 'string' ? relay.mode : null;
    agentRoutes = relay.agentRoutes && typeof relay.agentRoutes === 'object' ? relay.agentRoutes : null;
    const ws = relay.usage && Array.isArray(relay.usage.windows) ? relay.usage.windows : null;
    if (ws) windows = ws.map(windowView);
    else notes.push('relay 帧里没有 usage.windows，额度窗没查成');
    if (mode == null) notes.push('relay 帧里没有 mode，中转模式没查成');
    if (agentRoutes == null) notes.push('relay 帧里没有 agentRoutes，各 agent 路由没查成');
  }

  // 结论：版本不符是真红；只要有「没查成」的分量就 unknown；全齐且版本对才 ok。
  const missing = mode == null || agentRoutes == null || windows.length === 0 || !relay;
  const st = !versionOk ? 'red' : missing ? 'unknown' : 'ok';
  return { state: st, probed: true, version, versionOk, mode, agentRoutes, windows, notes };
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
 * 删会话（可连树一起删）。服务端只在失败时回 error 帧；短窗没 error 即当送进去了，
 * 之后由调用方读回清单自证不在了——不靠这一帧当「删成」的证据。
 */
export async function wireDeleteSession(wire, { sessionKey, removeWorktree = false } = {}, ackMs = 1500) {
  wire.send({ type: 'deleteSession', sessionKey, ...(removeWorktree ? { removeWorktree: true } : {}) });
  const err = await wire.waitFor(m => m && m.type === 'error', ackMs);
  if (err) return { ok: false, why: err.message || '删会话被拒' };
  return { ok: true, why: null };
}

/** 删工作树。 */
export async function wireRemoveWorktree(wire, { path } = {}, ackMs = 1500) {
  wire.send({ type: 'removeWorktree', path });
  const err = await wire.waitFor(m => m && m.type === 'error', ackMs);
  if (err) return { ok: false, why: err.message || '删树被拒' };
  return { ok: true, why: null };
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
 * 额度窗落盘记录（#881 读这一份；一个文件一个写者＝本采集器）。
 * 路径约定 ~/.dao/mirasim-usage.json，格式如下——纯函数，写盘由调用方做。
 */
export function usageRecord({ relay, host, port, now } = {}) {
  const mode = relay && typeof relay.mode === 'string' ? relay.mode : null;
  const agentRoutes = relay && relay.agentRoutes && typeof relay.agentRoutes === 'object' ? relay.agentRoutes : null;
  const windows = relay && relay.usage && Array.isArray(relay.usage.windows)
    ? relay.usage.windows.map(windowView) : [];
  const notes = [];
  if (!relay) notes.push('没收到 relay 帧，额度窗没查成');
  else if (windows.length === 0) notes.push('relay 帧里没有 usage.windows，额度窗没查成');
  return {
    schema: 'mirasim-usage/1',
    updatedAt: Number(now) || Date.now(),
    host: host || null,
    port: Number(port) || null,
    mode,
    agentRoutes,
    windows,
    readable: windows.length > 0,
    notes,
  };
}

/**
 * 单个 agent 的 relay 腿探活裁决（给派前探针/熔断用，target key = `mirasim:<agent>`）。
 * 探活 = 契约通过（版本对）+ 该 agent 的路由确实走 relay + relay.available。
 * 注：账本成功率是「可选」的加强判据（帅位补），本版先只做契约+路由，
 *     账本腿留给后面（见 PR「没查成/留给后面」）。
 * 返回 {target, state:'ok'|'red'|'unknown', why}
 */
export function probeMirasimTarget({ agent, health } = {}) {
  const target = `mirasim:${agent}`;
  if (!health || health.probed !== true) {
    return { target, state: 'unknown', why: health?.notes?.join('；') || '没采到 mirasim 健康（没查成）' };
  }
  if (health.state === 'red') return { target, state: 'red', why: health.notes.join('；') || '健康段判红' };
  const routes = health.agentRoutes;
  if (!routes) return { target, state: 'unknown', why: '没读到 agentRoutes（没查成）' };
  const leg = routes[agent];
  if (leg == null) return { target, state: 'unknown', why: `agentRoutes 里没有 ${agent}（没查成）` };
  if (leg !== 'relay') return { target, state: 'ok', why: `${agent} 走 ${leg}（不烧 mirasim relay 腿）` };
  // 走 relay：看有没有额度窗读到（读得到即腿通）
  if (!health.windows.length) return { target, state: 'unknown', why: `${agent}→relay 但额度窗没读到（没查成）` };
  return { target, state: 'ok', why: `${agent}→relay，额度窗读到 ${health.windows.length} 个` };
}

/**
 * 共用采集：连一次 ws，把 state / relay / sessions 一次读齐，产出健康段、额度记录、
 * 活动树集合、每 agent 探活。连不上不抛——返回 reachable:false + connectError，让调用方
 * 各自决定「没查成」怎么处置。
 *  opts: { open, port, homeDir, now, pinnedVersion, agents }
 *    open —— 注入的开线函数（测试用假线）；默认用 runtime 的 openWire
 */
export async function probeMirasim({ open = openWire, port, homeDir, now = () => Date.now(), pinnedVersion = '0.0.282', agents } = {}) {
  const host = os.hostname();
  let wire = null;
  try {
    wire = await open({ homeDir, port });
  } catch (e) {
    const connectError = e?.message || String(e);
    const health = buildMirasimHealth({ state: null, relay: null, connectError, pinnedVersion });
    return {
      reachable: false, connectError, host, port: port ?? null,
      state: null, relay: null, sessions: null,
      health, usage: usageRecord({ relay: null, host, port, now: now() }),
      activeWorkdirs: new Set(), perAgent: {},
    };
  }
  try {
    const state = wire.state || null;
    const relay = await wireGetRelay(wire);
    const sessions = await wireListSessions(wire);
    const health = buildMirasimHealth({ state, relay, pinnedVersion });
    const usage = usageRecord({ relay, host, port, now: now() });
    const routeAgents = agents || (health.agentRoutes ? Object.keys(health.agentRoutes) : []);
    const perAgent = {};
    for (const a of routeAgents) perAgent[a] = probeMirasimTarget({ agent: a, health });
    return {
      reachable: true, connectError: null, host, port: port ?? null,
      state, relay, sessions,
      health, usage, activeWorkdirs: activeWorkdirs(sessions), perAgent,
    };
  } finally {
    wire.close();
  }
}
