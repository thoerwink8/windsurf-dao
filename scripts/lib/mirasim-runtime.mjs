// scripts/lib/mirasim-runtime.mjs —— mirasim-server 当执行体的唯一绑定入口（#880 卡 A）。
//
// 五个动词是 #880 冻结的接口；#1125 加了第六个 listSessions（orca 已随 #1115 退役，
// 冻结五个的理由没了，「现在有几个审官真在跑」只有这一帧答得出）：
//   ensureWorkspace(repo, branch)             → {path}
//   startSession({agent, workdir, prompt})    → {sessionKey, taskId}
//   readSession(sessionKey)                   → {phase, text, toolCalls, error}
//   listSessions()                            → {ok, sessions}（读不到 sessions=null，不回 []）
//   interact(sessionKey, answer)
//   stopSession(sessionKey)
//
// 服务端是 systemd 常驻的官方 mirasim-server（回环 ws，钉死一个版本）。控制面是私有协议、
// 混淆、无文档，厂商明写客户端/服务端严格版本相等、无兼容层（ai-gateway-stack DECISIONS §71）——
// 所以这里的规矩是「形状不对就报警拒派」，不是「尽力猜」。
//
// 仓外落点（都归 ai-gateway-stack，本仓只读、不写装法，登记在 host/machine/INDEX.md）：
//   ~/.mirasim/run     —— 回环 ws 的会话令牌（local-<端口>.token）。只读不打印。
//   ~/.mirasim/traffic —— 账本行（每次上游调用一行 ndjson），判完工的交叉核来源。
//
// 三条硬判据，全部来自实咬：
//  1. 起会话前先断言契约：state.version 必须等于钉死的版本，且 prompt / snapshot 真正要读的
//     那几个字段形状对得上。不符 → 抛 MirasimContractError，一帧 prompt 都不发。
//  2. 判完工不能只信自己这条连接的 snapshot：prompt 之后推送不保证送到发起连接
//     （§72 实咬：我方只见 queued，服务端其实 2.7 秒就干完了）。要 phase 是 done
//     **且** 账本交叉核对得上；两边不一致 → 判「没查成」，不判成。
//  3. snapshot 取不到本身也是「没查成」——服务端对它不认识的会话直接不回帧（实测超时，
//     不是回一个空 snapshot），这跟「跑完了但没内容」是两件事，不许合成一种。
//
// 分层：judge* / parse* / read* 是纯判官，只吃入参不碰 IO；createRuntime 只管收发，不判对错。
// 自己查自己查不出错——判完工的判据不复用发消息那一层的解析。

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { checkTreeLease, checkInFlight, LEASE_BUSY_REASON } from './dispatch/lease.mjs';
import {
  admitAndReserveChannel, recordChannelFailure, isCapacityError, CHANNEL_FULL_REASON,
} from './channel-concurrency.mjs';
import { loadRoutingJsonRaw, modelsFromJson } from './model-routing-json.mjs';
import { loadBreaker } from './provider-health.mjs';
import { ensureLocalLedger } from './ledger-home.mjs';
import { readLedgerEvents } from './ledger-query.mjs';
import { desiredFromEvents } from './session-reconcile.mjs';

/**
 * 读取本机在役的服务端版本——**唯一真值**。
 *
 * 为什么不再手打常量（2026-09-10 实咬）：原先这里是一个手写的 `PINNED_VERSION = '0.0.282'`，
 * 配套注释写「升级永远人工验证后再换这一行（§72 拍板）」。但升级器装上定时器后**会自己升级**，
 * 而"人工记得换这行"从来不成立——0.0.307 上线后契约断言全部不符，96 条派工被拒，
 * 11 张单卡死，故障还因为报帅 key 同源失效而没人被通知。
 *
 * 记忆判例 hand-typed-constant-will-be-wrong 说的就是这件事：需要手打的常量早晚被凭印象填。
 * 所以真值改从升级器**自己维护**的地方读——它验证 bundle 必须含 VERSION，
 * `mirasim-server/current` 软链指向在役版本目录。它换服务端，这里就跟着变，不需要谁记得。
 *
 * 读不到返回 null，调用方按「没查成」处理（fail-closed，不许猜一个版本去放行）。
 */
export function installedVersion(homeDir) {
  const candidates = [
    join(homeDir || os.homedir(), 'mirasim-server', 'current', 'VERSION'),
    '/usr/local/lib/mirasim-managed-update/VERSION',
  ];
  for (const p of candidates) {
    try {
      const v = readFileSync(p, 'utf8').trim();
      if (/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(v)) return v;
    } catch { /* 下一个候选 */ }
  }
  return null;
}

/**
 * 钉死的服务端版本。**留空即「跟随本机在役版本」**——这是默认，也是推荐。
 *
 * 它只在一种场景下需要显式给值：想刻意钉住某个版本、让服务端偷偷换版本时当场拒派
 * （例如排查期间冻结）。设成具体版本号就恢复旧的严格语义。
 *
 * 不再保留一个手打的默认值：那正是 2026-09-10 那次全链瘫痪的根因。
 */
export const PINNED_VERSION = null;
export const DEFAULT_PORT = 4316;

// sessionKey 的真形状：<执行体>:<uuid>（实测 listSessions 回的就是 "claude:a8d67849-…"）。
// 账本目录名就是后半段那个 uuid，交叉核靠这个映射。
const SESSION_KEY_RE = /^([a-z][a-z0-9_-]*):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

// snapshot.phase 的三类去向。判完工只认 DONE_PHASES，且还要过交叉核。
const DONE_PHASES = new Set(['done', 'complete', 'completed']);
const FAILED_PHASES = new Set(['error', 'failed', 'aborted', 'cancelled', 'canceled']);

/** 契约不符：报警拒派用这个，调用方不许把它当「重试一次就好」。 */
export class MirasimContractError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'MirasimContractError';
    this.code = 'contract';
    this.detail = detail;
  }
}

/** 连不上 / 令牌不在 / 没回帧：属于「没查成」，不是「查过没事」也不是契约不符。 */
export class MirasimUnavailableError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'MirasimUnavailableError';
    this.code = 'unavailable';
    this.detail = detail;
  }
}

/** 服务端明确拒了（error 帧 / ok:false）。 */
export class MirasimRejectedError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'MirasimRejectedError';
    this.code = 'rejected';
    this.detail = detail;
  }
}

// ── 纯判官 ────────────────────────────────────────────────────────────────────

/**
 * 起会话前的契约断言。只吃 state 帧的内容，不碰网络。
 * 返回 {ok, unscanned, version, errors}；unscanned=true 表示根本没收到 state（没查成）。
 *
 * pinnedVersion 为空 = 跟随本机在役版本（默认）。此时断言退化成「必须报出一个版本号」——
 * 仍然拦得住「服务端换了实现却连 version 都不报」这种形态突变，但不再因为升级而误拒。
 */
export function judgeContract(state, { agent, pinnedVersion = null } = {}) {
  if (!state || typeof state !== 'object') {
    return {
      ok: false,
      unscanned: true,
      version: null,
      errors: ['没收到 state 帧——这是「没查成」，不是版本不符'],
    };
  }
  const errors = [];
  const version = typeof state.version === 'string' ? state.version : null;
  if (pinnedVersion == null) {
    // 跟随模式：只要服务端报得出一个合法版本号就算过。不比对具体值——
    // 比对值是「刻意钉住」的语义，不是默认。
    if (version === null) errors.push('服务端没报 version 字段——帧形态变了，猜下去只会静默走错');
    else if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) errors.push(`服务端报的 version 形状不符：${version}`);
  } else if (version !== pinnedVersion) {
    errors.push(`版本不符：钉死 ${pinnedVersion}，服务端报 ${version === null ? '（没有 version 字段）' : version}`);
  }
  // 下面这几个字段是五个动词真正要读的。缺一个就说明帧形态换了，猜下去只会静默走错。
  for (const field of ['workdir', 'home', 'platform']) {
    if (typeof state[field] !== 'string' || !state[field]) {
      errors.push(`state.${field} 形状不符：要非空字符串，实际 ${JSON.stringify(state[field])}`);
    }
  }
  if (!Array.isArray(state.agentsAvailable)) {
    errors.push(`state.agentsAvailable 形状不符：要数组，实际 ${JSON.stringify(state.agentsAvailable)}`);
  } else if (agent && !state.agentsAvailable.includes(agent)) {
    errors.push(`服务端没有 ${agent} 这个执行体，它只有 ${state.agentsAvailable.join(' / ') || '（空）'}`);
  }
  return { ok: errors.length === 0, unscanned: false, version, errors };
}

/** prompt 的应答帧断言：要 accepted + sessionKey 形状对。 */
export function judgeAccepted(msg) {
  if (!msg || typeof msg !== 'object') {
    return { ok: false, missing: true, errors: ['没收到 prompt 的应答帧（没查成）'], sessionKey: '', taskId: '' };
  }
  if (msg.type === 'error') {
    return {
      ok: false,
      missing: false,
      rejected: true,
      errors: [`服务端拒了这一针：${msg.message || '（没给原因）'}`],
      sessionKey: '',
      taskId: '',
    };
  }
  const errors = [];
  if (msg.type !== 'accepted') errors.push(`应答帧类型不符：要 accepted，收到 ${JSON.stringify(msg.type)}`);
  const sessionKey = typeof msg.sessionKey === 'string' ? msg.sessionKey : '';
  if (!SESSION_KEY_RE.test(sessionKey)) {
    errors.push(`sessionKey 形状不符：要 <执行体>:<uuid>，收到 ${JSON.stringify(msg.sessionKey)}`);
  }
  if (msg.taskId !== undefined && typeof msg.taskId !== 'string') {
    errors.push(`taskId 形状不符：要字符串或不给，收到 ${JSON.stringify(msg.taskId)}`);
  }
  return {
    ok: errors.length === 0,
    missing: false,
    errors,
    sessionKey,
    taskId: typeof msg.taskId === 'string' ? msg.taskId : '',
  };
}

/**
 * snapshot 帧断言。服务端有两种形态，都收：
 *   订阅回执（跨连接读会话的正路）：{type:'snapshot', sessionKey, seq, snapshot:{…}}
 *   流式推送（边跑边推）：          {type:'session',  sessionKey, seq, patch:{full:{…}}}
 * msg 为空 = 服务端没回帧（missing，判「没查成」）。
 *
 * sessionKey 归属判定以「订阅时请求的 sessionKey」为上下文：
 *   - 顶层缺 sessionKey（真机哪天改成不带）→ 按上下文收，不丢；
 *   - 顶层明确存在且不匹配 → 拒（是别的会话的帧）；
 *   - 内层 snapshot 若明确带 sessionKey/uuid（真机 0.0.282 两者都不带，用 sessionId/taskId/anchor 另一套 uuid，
 *     不拿来对）→ 也核对一致，不匹配就拒。
 */
export function judgeSnapshot(msg, sessionKey) {
  if (!msg || typeof msg !== 'object') {
    return { ok: false, missing: true, errors: ['服务端没回 snapshot 帧（没查成，不是「跑完了没内容」）'] };
  }
  const errors = [];
  let full;
  if (msg.type === 'snapshot') {
    full = msg.snapshot;
  } else if (msg.type === 'session') {
    full = msg.patch && typeof msg.patch === 'object' ? msg.patch.full : undefined;
  } else {
    errors.push(`帧类型不符：要 snapshot 或 session，收到 ${JSON.stringify(msg.type)}`);
  }
  // 顶层 sessionKey：缺就按上下文收，明确写了别的会话才拒。
  if (sessionKey && typeof msg.sessionKey === 'string' && msg.sessionKey && msg.sessionKey !== sessionKey) {
    errors.push(`snapshot 顶层是别的会话的：要 ${sessionKey}，收到 ${JSON.stringify(msg.sessionKey)}`);
  }
  // 内层若明确带 sessionKey/uuid 也核对一致（真机不带，这两条是防它哪天开始带）。
  if (sessionKey && full && typeof full === 'object') {
    if (typeof full.sessionKey === 'string' && full.sessionKey && full.sessionKey !== sessionKey) {
      errors.push(`snapshot 内层 sessionKey 是别的会话的：要 ${sessionKey}，收到 ${JSON.stringify(full.sessionKey)}`);
    }
    const wantUuid = sessionUuid(sessionKey);
    if (wantUuid && typeof full.uuid === 'string' && full.uuid && full.uuid !== wantUuid) {
      errors.push(`snapshot 内层 uuid 是别的会话的：要 ${wantUuid}，收到 ${JSON.stringify(full.uuid)}`);
    }
  }
  if (!errors.length && (!full || typeof full !== 'object')) {
    errors.push(`快照体形状不符：要对象，实际 ${JSON.stringify(full)}`);
  }
  if (errors.length) return { ok: false, missing: false, errors };
  return {
    ok: true,
    missing: false,
    errors: [],
    snapshot: full,
    seq: Number.isFinite(msg.seq) ? msg.seq : null,
  };
}

/**
 * 会话清单里的一条 meta（listSessions 回的）。跨连接一定读得到，是 snapshot 取不到时的兜底。
 * 注意 meta 的 preview 只是**预览**，不是完整正文——用它就得标出来，不许当正文交差。
 */
export function judgeSessionMeta(msg, sessionKey) {
  if (!msg || typeof msg !== 'object' || !Array.isArray(msg.sessions)) {
    return { ok: false, missing: true, errors: ['listSessions 没回可用的 sessions 帧（没查成）'] };
  }
  const meta = msg.sessions.find(s => s && s.sessionKey === sessionKey);
  if (!meta) return { ok: false, missing: true, errors: [`会话清单里没有 ${sessionKey}`] };
  return { ok: true, missing: false, errors: [], meta };
}

/** runState（会话清单用的词）与 phase（快照用的词）归一到 phase 这一套词上。 */
function normPhase(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  if (s === 'complete' || s === 'completed') return 'done';
  return s;
}

/**
 * 从快照抽出 readSession 对外的四个字段。快照里没有的字段一律给 null / 空，不编。
 * incomplete 为真时，phase 即使是 done 也不算干完——服务端用它标「收尾了但没跑完」。
 */
export function readSessionView(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const phase = normPhase(s.phase) || normPhase(s.runState);
  const text = typeof s.text === 'string' ? s.text : '';
  const toolCalls = Array.isArray(s.toolCalls)
    ? s.toolCalls.filter(t => t && typeof t === 'object').map(t => ({
      id: t.id ?? null,
      name: typeof t.name === 'string' ? t.name : null,
      status: typeof t.status === 'string' ? t.status : null,
    }))
    : [];
  let error = null;
  if (typeof s.error === 'string' && s.error) error = s.error;
  else if (s.error && typeof s.error === 'object' && typeof s.error.message === 'string') error = s.error.message;
  return { phase, text, toolCalls, error, incomplete: s.incomplete === true,
    // waiting_user 判据要用到交互清单（#1174）：快照里有就原样透传，没有就不给字段——不编空数组。
    ...(Array.isArray(s.interactions) ? { interactions: s.interactions } : {}) };
}

/** 会话清单那条 meta 也折成同样的四个字段。text 只有预览，标 partial。 */
export function metaView(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const runState = typeof m.runState === 'string' ? m.runState.trim().toLowerCase() : '';
  return {
    phase: normPhase(m.runState),
    text: typeof m.preview === 'string' ? m.preview : '',
    toolCalls: [],
    error: typeof m.runDetail === 'string' && m.runDetail ? m.runDetail : null,
    incomplete: runState === 'incomplete' || m.incomplete === true,
    runState: runState || null,
    partial: true,
  };
}

/**
 * 找当前等回答的那个问题。服务端的 interact 只认 promptId（不认 sessionKey），
 * 所以 interact(sessionKey, answer) 必须先从快照把 promptId 翻出来。
 * 形状取自服务端实现：snapshot.interactions[] 每项带 promptId / questions[] / currentIndex。
 */
export function pendingInteraction(snapshot) {
  const list = Array.isArray(snapshot?.interactions) ? snapshot.interactions : [];
  const open = list.filter(x =>
    x && typeof x === 'object'
    && typeof x.promptId === 'string' && x.promptId
    && !x.answeredAt && !x.resolvedAt && x.answered !== true && x.done !== true);
  const pick = open.length ? open[open.length - 1] : null;
  if (!pick) return null;
  const questions = Array.isArray(pick.questions) ? pick.questions : [];
  const idx = Number.isInteger(pick.currentIndex) && pick.currentIndex >= 0 ? pick.currentIndex : 0;
  const question = questions[idx] || questions[0] || null;
  return {
    promptId: pick.promptId,
    questionId: question && typeof question.id === 'string' && question.id ? question.id : 'answer',
  };
}

/** sessionKey 的 uuid 段——账本目录名就是它。形状不对回 null，不硬切字符串。 */
export function sessionUuid(sessionKey) {
  const m = SESSION_KEY_RE.exec(String(sessionKey || ''));
  return m ? m[2] : null;
}

/** 账本 ndjson → 行数组。坏行单独计数，不当成 0 行。 */
export function parseLedgerRows(text) {
  const rows = [];
  let bad = 0;
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row && typeof row === 'object') rows.push(row);
      else bad++;
    } catch { bad++; }
  }
  return { rows, bad };
}

/**
 * journal 里的 MIRASIM_AGENT_TURN_TIMING 行 → 结构。
 * 真样本（2026-09-04 服务器）：
 *   [server 14:43:14] MIRASIM_AGENT_TURN_TIMING {"schemaVersion":1,"agent":"claude",
 *   "startedAt":1788504192143,"mode":"start","outcome":"ok",…,"stages":{…,"totalMs":2676}}
 * 注意：这行**不带 sessionKey**，只能按 agent + startedAt 时间窗对，不能按会话精确归因——
 * 所以它是次级判据，账本（按会话分目录）才是主判据。
 */
export function parseTurnTiming(text) {
  const out = [];
  let bad = 0;
  const marker = 'MIRASIM_AGENT_TURN_TIMING';
  for (const line of String(text || '').split('\n')) {
    const at = line.indexOf(marker);
    if (at === -1) continue;
    const jsonStart = line.indexOf('{', at);
    if (jsonStart === -1) { bad++; continue; }
    try {
      const row = JSON.parse(line.slice(jsonStart));
      if (row && typeof row === 'object') out.push(row); else bad++;
    } catch { bad++; }
  }
  return { turns: out, bad };
}

/**
 * 判完工。这是本文件的核心判据，规矩只有一条：**不许把「没查成」说成「成」**。
 *  view          —— readSessionView 的结果（phase/text/…）
 *  snapshotMissing —— 服务端没回 snapshot 帧
 *  ledger        —— readLedger 的结果 {readable, rows, why}
 *  journal       —— 可选次级判据 {readable, turns, why}
 *  since         —— 起针时刻（毫秒），只认这之后的账本行
 * 返回 {status:'done'|'running'|'failed'|'unknown', confirmedBy[], reason}
 */
export function judgeCompletion({ view, snapshotMissing = false, ledger, journal, since = 0 } = {}) {
  if (snapshotMissing) {
    return { status: 'unknown', confirmedBy: [], reason: '取不到 snapshot：服务端没回帧，这一针的状态没查成' };
  }
  const phase = view && typeof view.phase === 'string' ? view.phase : null;
  if (!phase) {
    return { status: 'unknown', confirmedBy: [], reason: '快照里没有 phase 字段，判不出跑到哪了（没查成）' };
  }
  // partial=只有会话清单的预览（metaView）。终态判定 fail-closed：预览里的 completed/error
  // 不许当完工或失败交差（PR #884/#887 审官同咬：completed meta + 成功账本行也不得 done）。
  // running 放行——非终态不结算，误差无害。
  if (view.partial === true && phase !== 'running') {
    return {
      status: 'unknown',
      confirmedBy: [],
      reason: `只读到会话清单的预览（partial，报 ${phase}）——正文没拿到，终态判定没查成`,
    };
  }
  if (FAILED_PHASES.has(phase)) {
    return { status: 'failed', confirmedBy: ['snapshot'], reason: `快照报 ${phase}${view.error ? `：${view.error}` : ''}` };
  }
  if (!DONE_PHASES.has(phase)) {
    return { status: 'running', confirmedBy: ['snapshot'], reason: `快照报 ${phase}，还没到完工` };
  }
  // 服务端自己标了「收尾了但没跑完」，那就不是干完
  if (view.incomplete === true) {
    return {
      status: 'failed',
      confirmedBy: ['snapshot'],
      reason: `快照报 ${phase} 但带着 incomplete 标记${view.error ? `：${view.error}` : '（半截收尾）'}`,
    };
  }

  // 到这里 snapshot 说完工了。单凭它不算——§72 实咬过它跟服务端真实状态能对不上。
  if (!ledger || ledger.readable !== true) {
    return {
      status: 'unknown',
      confirmedBy: ['snapshot'],
      reason: `快照说完工，但账本没读到（${ledger?.why || '没给账本'}）——交叉核没做成，判没查成`,
    };
  }
  const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
  const fresh = rows.filter(r => {
    const ts = Date.parse(r?.ts || '');
    return Number.isFinite(ts) ? ts >= since - 1000 : false;
  });
  const served = fresh.filter(r => Number(r?.status) >= 200 && Number(r?.status) < 300);
  if (served.length === 0) {
    return {
      status: 'unknown',
      confirmedBy: ['snapshot'],
      reason: `快照说完工，账本里却没有这次会话起针之后的成功调用行（共 ${rows.length} 行、其中起针后 ${fresh.length} 行）——两边不一致，判没查成`,
    };
  }

  const confirmedBy = ['snapshot', 'ledger'];
  // journal 是次级判据：读不到就明说没参与，不许当成「核过了」。
  if (journal && journal.readable === true) {
    const turns = Array.isArray(journal.turns) ? journal.turns : [];
    const inWindow = turns.filter(t => Number.isFinite(Number(t?.startedAt)) && Number(t.startedAt) >= since - 60_000);
    if (inWindow.length === 0) {
      return {
        status: 'unknown',
        confirmedBy,
        reason: `快照与账本都说成了，但 journal 时间窗里没有这一针的回合记录——三方对不上，判没查成`,
      };
    }
    if (inWindow.some(t => t.outcome && t.outcome !== 'ok')) {
      return {
        status: 'unknown',
        confirmedBy,
        reason: `快照说完工，journal 里同一时间窗的回合却不是 ok（${inWindow.map(t => t.outcome).join(',')}）——判没查成`,
      };
    }
    confirmedBy.push('journal');
  }
  return {
    status: 'done',
    confirmedBy,
    reason: `快照 ${phase} + 账本 ${served.length} 条成功调用行对上${confirmedBy.includes('journal') ? ' + journal 回合 ok' : '（journal 未参与：' + (journal?.why || '没读') + '）'}`,
  };
}

// ── 账本 / journal 读取（IO 可注入，测试不碰真盘） ─────────────────────────────

const defaultLedgerIo = {
  exists: p => existsSync(p),
  readdir: p => readdirSync(p),
  readFile: p => readFileSync(p, 'utf8'),
};

/**
 * 读某个会话的账本行。目录是 ~/.mirasim/traffic/<会话 uuid>/index-*.ndjson。
 * 读不到一律 readable:false + why，绝不返回「0 行」冒充「查过没事」。
 */
export function readLedger({ sessionKey, homeDir, io = defaultLedgerIo } = {}) {
  const uuid = sessionUuid(sessionKey);
  if (!uuid) return { readable: false, rows: [], why: `sessionKey 形状不对，拼不出账本目录：${JSON.stringify(sessionKey)}` };
  const home = homeDir || os.homedir();
  const dir = join(home, '.mirasim', 'traffic', uuid);
  try {
    if (!io.exists(dir)) return { readable: false, rows: [], why: '这个会话还没有账本目录' };
    const files = io.readdir(dir).filter(f => /^index-\d+\.ndjson$/.test(f)).sort();
    if (files.length === 0) return { readable: false, rows: [], why: '账本目录里没有 index-*.ndjson' };
    const rows = [];
    let bad = 0;
    for (const f of files) {
      const parsed = parseLedgerRows(io.readFile(join(dir, f)));
      rows.push(...parsed.rows);
      bad += parsed.bad;
    }
    return { readable: true, rows, bad, dir, why: null };
  } catch (e) {
    return { readable: false, rows: [], why: `账本读失败：${e?.message || e}` };
  }
}

/**
 * 次级判据：journal 的回合计时。
 * 本机实况：跑服务的那个用户不在读日志的那个组里，所以默认读不到 —— 这里如实返回
 * readable:false，让 judgeCompletion 记「journal 未参与」，不许假装核过。
 * 要用就由调用方注入一个真能读的 read()。
 */
export function readJournal({ read } = {}) {
  if (typeof read !== 'function') {
    return { readable: false, turns: [], why: '没注入日志读取器（服务账号不在能读系统日志的组里）' };
  }
  try {
    const text = read();
    if (typeof text !== 'string' || !text) return { readable: false, turns: [], why: '日志读取器没给出内容' };
    const { turns, bad } = parseTurnTiming(text);
    if (turns.length === 0) return { readable: false, turns: [], why: `日志里一条回合记录都没扫到（坏行 ${bad}）` };
    return { readable: true, turns, bad, why: null };
  } catch (e) {
    return { readable: false, turns: [], why: `日志读失败：${e?.message || e}` };
  }
}

// ── 连线层（只收发，不判对错） ────────────────────────────────────────────────

function tokenFile(homeDir, port) {
  // 落点 ~/.mirasim/run/local-<端口>.token（归 ai-gateway-stack，本仓只读）
  return join(homeDir, '.mirasim', 'run', `local-${port}.token`);
}

function readToken(homeDir, port) {
  const p = tokenFile(homeDir, port);
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    throw new MirasimUnavailableError('读不到回环会话令牌，服务多半没在跑', { why: e?.message || String(e) });
  }
  const token = String(raw).trim();
  if (!token) throw new MirasimUnavailableError('回环会话令牌是空的');
  return token;
}

/**
 * 开一条 ws，等服务端主动推来的 state 帧，之后按谓词取帧。
 * 令牌只进 URL，不进任何返回值、不进日志。
 */
async function defaultConnect({ homeDir, port, openTimeoutMs }) {
  const token = readToken(homeDir, port);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  const inbox = [];
  const waiters = [];
  let closed = false;
  let failure = null;

  const pump = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      const hit = inbox.findIndex(w.pred);
      if (hit !== -1) {
        const [msg] = inbox.splice(hit, 1);
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else if (closed || failure) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(null);
      }
    }
  };

  ws.onmessage = ev => {
    try { inbox.push(JSON.parse(ev.data)); } catch { /* 非 JSON 帧不是本层的事 */ }
    pump();
  };
  ws.onerror = e => { failure = e?.message || 'ws 出错'; pump(); };
  ws.onclose = () => { closed = true; pump(); };

  const wire = {
    get closed() { return closed; },
    get failure() { return failure; },
    send(obj) {
      if (closed) throw new MirasimUnavailableError('连接已断，这一帧没发出去');
      ws.send(JSON.stringify(obj));
    },
    waitFor(pred, timeoutMs) {
      const hit = inbox.findIndex(pred);
      if (hit !== -1) return Promise.resolve(inbox.splice(hit, 1)[0]);
      if (closed || failure) return Promise.resolve(null);
      return new Promise(resolve => {
        const w = { pred, resolve };
        w.timer = setTimeout(() => {
          const at = waiters.indexOf(w);
          if (at !== -1) waiters.splice(at, 1);
          resolve(null);
        }, timeoutMs);
        waiters.push(w);
      });
    },
    close() { try { ws.close(); } catch { /* 已断就算了 */ } },
  };

  const opened = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), openTimeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve(true); };
    const prevErr = ws.onerror;
    ws.onerror = e => { prevErr?.(e); clearTimeout(timer); resolve(false); };
  });
  if (!opened) {
    wire.close();
    throw new MirasimUnavailableError('连不上回环 ws', { port, why: failure });
  }
  // state 帧**不是**连上就推的（实咬：连上干等只等到超时），必须自己问一句。
  // 顺序照客户端自己的来：先 clientHello 再 getState。这两帧是只读的，
  // 不动任何会话——契约断言前不发业务帧这条规矩没破。
  wire.send({ type: 'clientHello' });
  wire.send({ type: 'getState' });
  wire.state = (await wire.waitFor(m => m.type === 'state', openTimeoutMs))?.state ?? null;
  return wire;
}

// ── 动词（#880 五个 + #1125 listSessions）────────────────────────────────────

/**
 * 渠道并发闸的**取数薄壳**（#1145）。判定与占槽都在 lib/channel-concurrency.mjs，
 * 这里只负责把三份快照读出来：
 *   · 路由表「腿」节 → 渠道上限（并发上限字段）
 *   · /proc 在途树 → 渠道在途数（**与租约闸同源**：同一个 checkInFlight，不复用 mirasim 自己的记账）
 *   · 派工账本未结 job → 树归哪个模型（树→模型→渠道的那一跳）
 *   · 熔断表 → 冷却中的渠道等同满员
 * 任一读不出来 ⇒ 返回 ok:false，门里 fail-close 拒起。
 *
 * 走 admitAndReserveChannel 而不是只读的 checkChannelCapacity：只读会留 TOCTOU 竞态
 * （两个并发都看到没满、都放行、真实并发超上限）。它在锁内「数预占+写预占」，返回的
 * release 必须由调用方在 finally 里调。
 */
function defaultChannelAdmit({ model, now } = {}) {
  return admitAndReserveChannel({
    model,
    now: now ?? Date.now(),
    io: {
      loadRouting: () => loadRoutingJsonRaw(),
      loadModels: (raw) => modelsFromJson(raw),
      checkInFlight: () => checkInFlight(),
      loadBreaker: () => loadBreaker(),
      loadJobs: () => {
        // 账本读不出来只是「这棵树归不到渠道」（进 unattributed），不是整闸没查成——
        // 所以这里吞掉异常回空数组，而不是让整道闸 fail-close 把所有会话拦死。
        try {
          const dir = ensureLocalLedger({}).dir;
          const listed = readLedgerEvents(dir);
          if (listed.unscanned) return [];
          const desired = desiredFromEvents(listed.events);
          return desired.items || [];
        } catch { return []; }
      },
    },
  });
}

export function createRuntime(opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const port = Number(opts.port || process.env.MIRASIM_PORT || DEFAULT_PORT);
  // 不传就是跟随本机在役版本（读 bundle 的 VERSION）。刻意钉住才显式给值。
  const pinnedVersion = opts.pinnedVersion || null;
  const connect = opts.connect || defaultConnect;
  const ledgerIo = opts.ledgerIo || defaultLedgerIo;
  const journalRead = opts.journalRead;
  const now = opts.now || (() => Date.now());
  // 租约判据可注入：单测给假的，生产读盘。默认必须是真闸——不给就不检查等于没有闸。
  const leaseCheck = opts.leaseCheck || checkTreeLease;
  // 渠道并发判据同理（#1145）。默认真闸，取数在 defaultChannelAdmit（读路由表 / /proc / 账本）。
  const channelAdmit = opts.channelAdmit || defaultChannelAdmit;
  // 撞容量落熔断表的写口，同样可注入（夹具不碰真 ~/.dao）。
  const channelFailed = opts.recordChannelFailure || recordChannelFailure;
  const t = {
    open: opts.openTimeoutMs ?? 8_000,
    accept: opts.acceptTimeoutMs ?? 30_000,
    snapshot: opts.snapshotTimeoutMs ?? 6_000,
    ack: opts.ackTimeoutMs ?? 1_500,
    worktree: opts.worktreeTimeoutMs ?? 60_000,
    // 会话名单要单独一个预算，不能跟 snapshot 共用（#1125）：名单是**全量枚举**，
    // 会话越多越慢——2026-09-07 实测 60 条时 3.0–5.4 秒，而 snapshot 的 6 秒余量只剩零点几秒，
    // 机器一有负载就越线。越线的后果不是「慢一点」，是判成「没查成」⇒ 这一轮一张票都不拉，
    // 队列看起来永远堵着。所以它宁可等久一点，也不能因为抖动就报没查成。
    list: opts.listTimeoutMs
      ?? (Number.parseInt(process.env.MIRASIM_LS_TIMEOUT_MS || '', 10) || 30_000),
  };
  const verifyTries = opts.worktreeVerifyTries ?? 4;
  const verifyDelayMs = opts.worktreeVerifyDelayMs ?? 700;

  const open = () => connect({ homeDir, port, openTimeoutMs: t.open });

  /** 契约断言。不符就抛，抛之前一帧业务消息都不发——这才叫「拒派」。 */
  const assertContract = (wire, agent) => {
    const verdict = judgeContract(wire.state, { agent, pinnedVersion });
    if (verdict.unscanned) {
      throw new MirasimUnavailableError('连上了但没收到 state 帧，契约没查成——不派', { errors: verdict.errors });
    }
    if (!verdict.ok) {
      throw new MirasimContractError(`契约断言不通过，拒派：${verdict.errors.join('；')}`, {
        errors: verdict.errors,
        version: verdict.version,
        pinnedVersion,
      });
    }
    return verdict;
  };

  async function ensureWorkspace(repo, branch) {
    const wire = await open();
    try {
      assertContract(wire);
      const listOnce = async () => {
        wire.send({ type: 'listWorkspaces' });
        const msg = await wire.waitFor(m => m.type === 'workspaces', t.snapshot);
        if (!msg || !Array.isArray(msg.workspaces)) {
          throw new MirasimUnavailableError('listWorkspaces 没回可用的 workspaces 帧（没查成）');
        }
        return msg.workspaces;
      };

      // 匹配必须按 realpath，不许按字面路径（2026-09-10 实咬）：主仓在服务端以
      // /home/orca/windsurf-dao（一个指向 /srv/projects/windsurf-dao 的符号链接）注册着，
      // 0.0.307 对 saveWorkspace 按 realpath 去重——再注册 /srv 路径会被当成重复条目删掉。
      // 字面匹配于是永远「列不到」，11 张单全卡在建树，看起来像服务端拒绝主仓，
      // 其实是这里的 find 认不出同一个仓的另一个名字。
      const realOf = p => { try { return realpathSync(String(p)); } catch { return String(p); } };
      const repoReal = realOf(repo);
      const sameRepo = w => w?.path === repo || realOf(w?.path) === repoReal;
      let workspaces = await listOnce();
      let entry = workspaces.find(sameRepo);
      if (!entry) {
        wire.send({ type: 'saveWorkspace', path: repo, name: repo.split('/').filter(Boolean).pop() || repo });
        // 读回自证：注册完再列一次，列不到就说明这一步没生效
        workspaces = await listOnce();
        entry = workspaces.find(sameRepo);
        if (!entry) throw new MirasimRejectedError(`注册工作区没生效，列不到 ${repo}`);
      }

      const findTree = list => (Array.isArray(list) ? list : []).find(w =>
        w && typeof w === 'object' && (w.branch === branch || w.head === branch));
      const already = findTree(entry.worktrees);
      if (already && typeof already.path === 'string' && already.path) {
        return { path: already.path, branch, created: false, verified: true };
      }

      const reqId = `dao-${now()}-${Math.random().toString(36).slice(2, 8)}`;
      wire.send({ type: 'addWorktree', path: repo, branch, base: opts.base ?? undefined, reqId });
      const added = await wire.waitFor(m => m.type === 'worktreeAdded' && m.reqId === reqId, t.worktree);
      if (!added) throw new MirasimUnavailableError('addWorktree 没回 worktreeAdded 帧（没查成，别当成没建成）', { reqId });
      if (!added.ok) {
        // 「already used by worktree at 'X'」是幂等命中，不是失败（2026-09-10 实咬）：
        // 服务端的 worktrees 缓存会陈旧（实测 69 条里 31 条有 branch，git 里真实存在的
        // dao-1145 等不在列表），findTree 于是漏判、走到新建，git 拒绝并**在错误里给出真实路径**。
        // git 比服务端缓存权威——按它给的路径当已有树返回。只认精确形状，别的拒绝照抛。
        const used = /already used by worktree at '([^']+)'/.exec(String(added.error || ''));
        if (used && existsSync(used[1])) {
          return { path: used[1], branch, created: false, verified: true };
        }
        throw new MirasimRejectedError(`建树被拒：${added.error || '（没给原因）'}`, {
          code: added.code ?? null,
          detail: added.detail ?? null,
        });
      }
      if (typeof added.path !== 'string' || !added.path) {
        throw new MirasimContractError('worktreeAdded 说 ok 却没给 path，形状不符', { got: added });
      }
      // 读回自证：从工作区列表里再确认一次这棵树在。
      // 服务端那份树的观察器是异步刷的，建完立刻列多半还是空——所以这里重试几次；
      // 真到最后还列不到才报 verified:false（树已建好但清单里没露面，值得看一眼）。
      let verified = false;
      for (let i = 0; i < verifyTries && !verified; i++) {
        if (i) await new Promise(r => setTimeout(r, verifyDelayMs));
        const after = await listOnce();
        verified = Boolean(findTree(after.find(w => w?.path === repo)?.worktrees));
      }
      return { path: added.path, branch: added.branch ?? branch, created: true, verified };
    } finally {
      wire.close();
    }
  }

  async function startSession({ agent, workdir, prompt, model, effort, clientRef, route } = {}) {
    // promptSent / explicitlyRejected 供 catch 里判「这次失败到底发出去没有」（#1174）。
    let promptSent = false;
    let explicitlyRejected = false;
    if (!agent || !workdir || !prompt) {
      throw new MirasimRejectedError('起会话要同时给 agent / workdir / prompt');
    }
    if (route !== undefined && !['local', 'cloud', 'auto'].includes(route)) {
      throw new MirasimRejectedError('route 必须是 local / cloud / auto');
    }
    try {
    // 租约闸：一棵树同时只许一个会话在跑（lib/dispatch/lease.mjs 有实测起因）。
    // 装在这里而不是各调用点——四个调用点（dao dispatch / dao start / 审官 create /
    // 推一把）全从这道门过，装在门里绕不开。放在连线之前：占着的树连 ws 都不开。
    const lease = leaseCheck({ workdir });
    if (!lease.ok) {
      // 没查成 ⇒ 拒起（fail-close）。放行的代价实测是一棵树 15 个会话；
      // 拒起的代价是这轮不派、下轮再来，而且报得出来。
      throw new MirasimUnavailableError(`租约没查成，拒起会话：${lease.error}`, { workdir });
    }
    if (lease.verdict === 'held') {
      // busy=true 是给调用方的**背压**标记，不是失败：树里有人在干活，下一轮再来就行。
      // 不标它，指挥官会把「这轮先不派」当成 dispatch-failed 去开一张待拍板单——
      // 那正是本仓刚花一整晚清掉的那种噪音单。
      throw new MirasimRejectedError(`租约被占，拒起会话：${lease.why}`, {
        workdir, holders: lease.holders || [], busy: true, reason: LEASE_BUSY_REASON,
      });
    }

    // 渠道并发闸（#1145）：挨着租约闸，同样装在门里、同样排在 open() 前面——
    // 满员时连 ws 都不开。装在门里的理由与租约闸一字不差：四个调用点
    // （dao dispatch / dao start / 审官 create / 推一把）全从这道门过，绕不开；
    // 审官起会话因此自动受闸，不用动审官选型那条核心路径。
    //
    // 渠道并发是**机器负载准入（admission）之上叠加的第二道闸**，不替代它：
    // 前者管这台机器还塞不塞得下，后者管上游那条渠道还收不收。
    //
    // **是原子占槽，不是读快照**（审官第二轮红项）：读快照会让两个并发都看到没满都放行，
    // 真实并发超上限（cap=2 的 pqapi 被顶到 3-4，正好落回 429 区，闸等于白设）。
    // admitAndReserveChannel 在锁内「数预占+写预占」，返回的 release 必须在 finally 里调。
    const chan = channelAdmit({ model, now: now() });
    if (!chan.ok) {
      // 没查成 ⇒ 拒起（fail-close），判据同租约闸：放行的代价是把上游打到 429 雪崩，
      // 拒起的代价是这轮不派、下轮再来，而且报得出来。
      // 「锁拿不到」也走这一支：拿不到锁说明有人在临界区，此刻数不准也占不上槽。
      throw new MirasimUnavailableError(`渠道并发没查成，拒起会话：${chan.error}`, { workdir, model: model || null });
    }
    if (chan.verdict === 'full') {
      // 满员/熔断冷却中都是**背压**，与租约被占同一类：必须带 busy + reason，
      // 否则指挥官会把「这轮轮不到这条渠道」当派工失败去开待拍板噪音单。
      throw new MirasimRejectedError(`渠道满员，拒起会话：${chan.why}`, {
        workdir, model: model || null, busy: true, reason: CHANNEL_FULL_REASON,
        channel: chan.channel || null, cap: chan.cap, inFlight: chan.inFlight,
        channelReason: chan.reason || null,
      });
    }
    // 预占已经占上：从这里往下**每一条出路**都必须退槽（成功、被拒、抛错），否则这个渠道
    // 会少一个名额直到 TTL 到点。所以下面整段包在 try/finally 里，release 放 finally。
    const releaseSlot = typeof chan.release === 'function' ? chan.release : () => {};

    try {
      const wire = await open();
      try {
        // 顺序是判据的一部分：先断言，通不过就一帧 prompt 都不发。
        assertContract(wire, agent);
        const startedAt = now();
        wire.send({
          type: 'prompt',
          prompt,
          agent,
          workdir,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(route ? { route: route === 'auto' ? null : route } : {}),
          clientRef: clientRef || `dao-${startedAt}`,
        });
        promptSent = true;
        const msg = await wire.waitFor(m => m.type === 'accepted' || m.type === 'error', t.accept);
        const verdict = judgeAccepted(msg);
        if (!verdict.ok) {
          if (verdict.missing) throw new MirasimUnavailableError(`起会话没查成：${verdict.errors.join('；')}`);
          if (verdict.rejected) {
            explicitlyRejected = true;
            // #1145 第三层：**真实上游拒绝**就落在这里。撞容量（429 / at-capacity）要喂熔断表，
            // 否则下一轮还会照原样重投同一条渠道——那正是 issue 里的 retry storm。
            // 退避轮数由 planBackoff 算（2→4→8 封顶），状态转移仍走 #843 breaker 的
            // applyEvent(trip)，不新造状态机。认不出指纹就不记（不猜——猜错会把普通失败熔成冷却）。
            const hit = isCapacityError(verdict.errors.join('；'));
            if (hit.hit && chan.target) {
              try {
                channelFailed({
                  target: chan.target, now: now(),
                  why: `起会话被上游拒（${hit.kind}）：${verdict.errors.join('；').slice(0, 120)}`,
                });
              } catch { /* 记不进熔断表不该把「起会话失败」这条真相盖掉 */ }
            }
            throw new MirasimRejectedError(verdict.errors.join('；'), {
              workdir, model: model || null,
              ...(hit.hit ? { capacity: true, capacityKind: hit.kind, channel: chan.channel || null } : {}),
            });
          }
          throw new MirasimContractError(`prompt 应答形状不符：${verdict.errors.join('；')}`, { got: msg });
        }
        return { sessionKey: verdict.sessionKey, taskId: verdict.taskId, startedAt };
      } finally {
        wire.close();
      }
    } finally {
      // 退槽。**删不掉不许让起会话失败**：预占有 TTL + pid 判死兜底，最坏是这个渠道少一个
      // 名额到 TTL 到点。这里也刻意不抛——在 finally 里抛会把真错误（上面那些）盖掉。
      try { releaseSlot(); } catch { /* 同上：TTL/pid 兜底，不掩盖真错误 */ }
    }
    } catch (error) {
      // promptSent && !explicitlyRejected = prompt 发出去了但没拿到明确拒绝 ⇒ 起会话状态不确定。
      // 标出来是给上层判「能不能当没起过、能不能重派」——不确定的重派会烧两次额度（#1174）。
      error.detail = { ...(error.detail || {}), launchUncertain: promptSent && !explicitlyRejected, clientRef: clientRef || null };
      throw error;
    }
  }

  // Identity reconciliation only. A matching record is not completion evidence.
  // The unified worktree lease guarantees no second managed launch in this window.
  function resolveStart({ agent, workdir, startedAt, since } = {}) {
    if (!/^[a-z][a-z0-9_-]*$/.test(agent || '') || !workdir) return { ok: false, unscanned: true, why: 'invalid start identity' };
    const earliest = typeof (startedAt ?? since) === 'number' ? (startedAt ?? since) : Date.parse(startedAt ?? since);
    if (!Number.isFinite(earliest)) return { ok: false, unscanned: true, why: 'missing start timestamp' };
    const root = join(homeDir, '.mirasim', 'sessions', agent);
    let ids;
    try { ids = readdirSync(root); } catch (e) { return { ok: false, missing: e.code === 'ENOENT', unscanned: e.code !== 'ENOENT', why: 'session records unavailable' }; }
    if (ids.length > 10000) return { ok: false, unscanned: true, why: 'session record scan limit' };
    const hits = [];
    for (const id of ids) {
      if (!SESSION_KEY_RE.test(`${agent}:${id}`)) continue;
      let row;
      try { row = JSON.parse(readFileSync(join(root, id, 'record.json'), 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') continue; return { ok: false, unscanned: true, why: 'session record unreadable' }; }
      const at = typeof row.createdAt === 'number' ? row.createdAt : Date.parse(row.createdAt);
      if (row.workdir === workdir && Number.isFinite(at) && at >= earliest - 1000) hits.push({ sessionKey: `${agent}:${id}`, startedAt: at });
    }
    if (hits.length !== 1) return { ok: false, missing: hits.length === 0, ambiguous: hits.length > 1, why: 'start identity not unique', matches: hits.length };
    return { ok: true, ...hits[0], confirmedBy: ['workdir', 'creation-window', 'persistent-session-record'] };
  }

  /**
   * 读会话。每次开新连接读——不靠 prompt 那条连接的推送（§72 实咬）。
   *
   * 读的正路是 subscribe：真机回 {type:'snapshot', sessionKey, seq, snapshot:{…}}——顶层带 sessionKey
   * 且等于所订阅的会话（2026-09-04 真机实探，见 PR「协议真相」段）；正文、工具、问答都在内层 snapshot 里。
   * 内层 snapshot 不带 sessionKey/uuid（它用 sessionId/taskId/anchor 另一套 uuid，跟 sessionKey 的 uuid 段无关，
   * 不能拿去跟 sessionKey 对）。谓词与判官都以「所订阅的 sessionKey」为上下文：顶层缺 sessionKey 时按上下文收，
   * 顶层明确存在且不匹配才丢——不然真机若哪天改成不带顶层 sessionKey，完整快照会被误丢、退成只有预览的 meta。
   * getSnapshot **不能**当跨连接的读法：它只在服务端手里有这条会话的缓存时才回帧，
   * 新连接上问一个刚起的会话会一帧都收不到（实咬：真烧的那一针连读 13 次全空，
   * 而账本里它 3.2 秒就 200 了——正是「没查成」被当成「没跑完」的那个坑）。
   * subscribe 也拿不到时退到会话清单的 meta（runState/preview 跨连接一定读得到），
   * 并标 partial：那里的正文只是预览。两条路都空才算 missing。
   */
  async function readSession(sessionKey) {
    const wire = await open();
    try {
      wire.send({ type: 'subscribe', sessionKey });
      const msg = await wire.waitFor(
        // 顶层缺 sessionKey 时按所订阅的会话收；只有顶层明确写了别的会话才跳过（留给别的等待者）。
        m => (m.type === 'snapshot' || m.type === 'session')
          && (typeof m.sessionKey !== 'string' || m.sessionKey === '' || m.sessionKey === sessionKey),
        t.snapshot,
      );
      const shape = judgeSnapshot(msg, sessionKey);
      if (shape.ok) {
        return {
          ...readSessionView(shape.snapshot),
          missing: false, partial: false, via: 'snapshot', why: null,
          seq: shape.seq, snapshot: shape.snapshot,
        };
      }
      if (!shape.missing) {
        // 收到帧但形状不对：这是契约问题，不许当「没这条会话」糊过去
        return { phase: null, text: '', toolCalls: [], error: null, missing: false, via: 'snapshot', why: shape.errors.join('；') };
      }
      wire.send({ type: 'listSessions' });
      const listed = await wire.waitFor(m => m.type === 'sessions', t.snapshot);
      const metaShape = judgeSessionMeta(listed, sessionKey);
      if (metaShape.ok) {
        return {
          ...metaView(metaShape.meta),
          missing: false, via: 'meta', snapshot: null, seq: null,
          why: '快照没回帧，这里读的是会话清单：正文只有预览',
        };
      }
      return {
        phase: null, text: '', toolCalls: [], error: null,
        missing: true, partial: false, via: null,
        why: `快照和会话清单都没读到（没查成）：${metaShape.errors.join('；')}`,
      };
    } finally {
      wire.close();
    }
  }

  /** 回答会话里等着的问题。服务端只认 promptId，所以先从快照翻出来。 */
  async function interact(sessionKey, answer) {
    const view = await readSession(sessionKey);
    if (view.missing) {
      return { ok: false, missing: true, why: `取不到快照，翻不出要回答哪个问题（${view.why}）` };
    }
    if (view.via !== 'snapshot' || !view.snapshot) {
      // 会话清单里没有问答字段。这时候「看不见问题」和「没有问题」分不开，只能报没查成。
      return { ok: false, missing: true, why: '只读到会话清单，看不见有没有在等回答（没查成）' };
    }
    const pending = pendingInteraction(view.snapshot);
    if (!pending) return { ok: false, missing: false, why: '这个会话现在没有等回答的问题' };
    const wire = await open();
    try {
      wire.send({ type: 'interact', promptId: pending.promptId, action: 'answer', value: String(answer ?? '') });
      // 服务端只在失败时回 error 帧；短窗内没 error 且连接还活着才算送进去了。
      // 连接断了/出错时 waitFor 也回 null——那是「没查成」，不是成功（PR #884 审官实咬）。
      const err = await wire.waitFor(m => m.type === 'error', t.ack);
      if (err) return { ok: false, missing: false, promptId: pending.promptId, why: err.message || '回答被拒' };
      if (wire.closed || wire.failure) {
        return { ok: false, missing: false, promptId: pending.promptId, why: `连接断了（${wire.failure || 'closed'}），回答送没送到没查成` };
      }
      return { ok: true, promptId: pending.promptId, questionId: pending.questionId };
    } finally {
      wire.close();
    }
  }

  async function stopSession(sessionKey) {
    const wire = await open();
    try {
      wire.send({ type: 'stop', sessionKey });
      const err = await wire.waitFor(m => m.type === 'error', t.ack);
      if (err) return { ok: false, why: err.message || '停不下来' };
      if (wire.closed || wire.failure) {
        return { ok: false, why: `连接断了（${wire.failure || 'closed'}），stop 送没送到没查成` };
      }
      return { ok: true, why: null };
    } finally {
      wire.close();
    }
  }

  /** 交叉核：账本为主（按会话分目录），journal 为次（只有时间窗，没有会话号）。 */
  function crossCheck(sessionKey) {
    return {
      ledger: readLedger({ sessionKey, homeDir, io: ledgerIo }),
      journal: readJournal({ read: journalRead }),
    };
  }

  /**
   * 等完工。轮询 snapshot，到终态再做交叉核。
   * 超时不叫失败也不叫成功，叫「没查成」——它俩在盘面上的处置完全不同。
   */
  async function waitForCompletion(sessionKey, { since = 0, timeoutMs = 600_000, pollMs = 3_000 } = {}) {
    const deadline = now() + timeoutMs;
    let last = null;
    for (;;) {
      const view = await readSession(sessionKey);
      last = view;
      const { ledger, journal } = crossCheck(sessionKey);
      const verdict = judgeCompletion({ view, snapshotMissing: view.missing, ledger, journal, since });
      if (verdict.status !== 'running') {
        if (verdict.status !== 'unknown' || now() >= deadline) return { ...verdict, view };
      }
      if (now() >= deadline) {
        return {
          status: 'unknown',
          confirmedBy: [],
          reason: `等到超时（${Math.round(timeoutMs / 1000)} 秒）也没判出完工：${verdict.reason}`,
          view: last,
        };
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
  }

  /**
   * 会话名单（#1125）。readSession 内部一直在用这一帧当兜底，只是没往外露。
   *
   * 为什么现在加第六个动词：#880 冻结五个动词是为了「orca 退役时删绑定、不改调用方」，
   * orca 已随 #1115 退役，那个理由没了。而「现在有几个审官真在跑」只有这一帧答得出——
   * 登记文件会留下死会话（#1121），进程会被服务端重新拉起来变成残壳，两个都不算数。
   *
   * 读不到一律回 {ok:false, missing:true}，**绝不回空数组**：下游拿「0 个在跑」会一次
   * 把上游池子拉满，那正是 #1125 要治的病。
   */
  async function listSessions() {
    const wire = await open();
    try {
      const deadline = now() + t.list;
      for (let limit = 256; limit <= 32768; limit *= 2) {
        wire.send({ type: 'listSessions', scope: 'global', limit });
        const msg = await wire.waitFor(m => m.type === 'sessions', Math.max(1, deadline - now()));
        if (!msg || !Array.isArray(msg.sessions)) {
          return { ok: false, missing: true, sessions: null, why: '服务端没回可用的 sessions 帧（没查成）' };
        }
        if (msg.hasMore === false) return { ok: true, missing: false, sessions: msg.sessions, scope: 'global', complete: true };
        if (msg.hasMore !== true || now() >= deadline) return { ok: false, missing: true, partial: true, sessions: null, why: '会话枚举未证明完整（hasMore 缺失或超时）' };
      }
      return { ok: false, missing: true, partial: true, sessions: null, why: '会话枚举超过上限，不能当完整清单' };
    } catch (e) {
      return { ok: false, missing: true, sessions: null, why: `会话名单没读成：${String(e?.message || e)}` };
    } finally {
      wire.close();
    }
  }

  return {
    ensureWorkspace,
    startSession,
    resolveStart,
    readSession,
    listSessions,
    interact,
    stopSession,
    waitForCompletion,
    crossCheck,
    config: { port, homeDir, pinnedVersion },
  };
}

// 默认实例：dao.mjs 直接引这五个动词，不必关心连线细节。
let shared = null;
const runtime = () => (shared ||= createRuntime());
/** 只给测试用：换掉默认实例。 */
export function _setSharedRuntime(r) { shared = r; }

export const ensureWorkspace = (repo, branch) => runtime().ensureWorkspace(repo, branch);
export const startSession = args => runtime().startSession(args);
export const readSession = sessionKey => runtime().readSession(sessionKey);
export const listSessions = () => runtime().listSessions();
export const interact = (sessionKey, answer) => runtime().interact(sessionKey, answer);
export const stopSession = sessionKey => runtime().stopSession(sessionKey);
export const waitForCompletion = (sessionKey, o) => runtime().waitForCompletion(sessionKey, o);
