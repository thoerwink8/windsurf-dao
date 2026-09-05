// scripts/lib/preflight.mjs —— 派前探一针编排引擎（#842）
//
// 起 agent 前：先按健康表把红的排后、熔断 open 的直接拦，再逐位真探（同路径流式），
// 红了换下一位（同厂闸由调用方保证，本引擎只按给定顺序探），全红 → 报帅停手。
// 工人接线在 dispatch/launch.mjs（preflightWorkerSlate），审官在 dispatch/reviewer.mjs
// （preflightReviewer）；两者都调本文件 runPreflight，DRY。
//
// 只有 red 会换人。unscanned / no_finish / timeout 三态都是**软态**：通道没说过一句「不行」，
// 只是我们没拿到结论——先看后面有没有真绿的，全都没有就回退用第一个软态那位。
// 探针本身只回四态，timeout 是本文件在 red 里再分出来的一态（#853）：探针把「我们自己等不及了」
// 也算 red，而排队型网关首字节本来就慢（实测见 DISPATCH_POLICY_DEFAULTS 上方那张表），
// 5s 预算让整个 gw-sub 组每次必红，当场换掉正在干活的人。判据见 isProbeTimeout。
//
// 状态：每次探结果追加 ~/.dao/preflight/<YYYY-MM-DD>.ndjson（登记在 host/machine/INDEX.md，A 类）。
// 配置：docs/dispatch-policy.json 的 preflight 节；--no-preflight 单次覆盖并记账。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { probeLanding, probeTargetOf } from './provider-probe.mjs';
import { availabilityFor } from './provider-health.mjs';
import { BREAKER_DEFAULTS, inspectAvailability, recordEvent, loadBreakerDoc } from './provider-breaker.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');

// timeoutMs 的来历（#853，2026-09-05 实测，别凭感觉改）：
// 拿 provider-probe 的**同一条真实请求路径**对在役腿各探 8 针，量到首字节（= 首个 SSE 分片）
// 与整针收口（内容 + 收尾事件）的耗时：
//   grok-4.6@gw            首字节 0.76–1.10s   收口 1.5–2.9s
//   deepseek-v4-flash@gw-dspool  0.78–2.27s        0.90–2.27s
//   gpt-5.6-luna@gw-windsurf     1.38–1.65s        1.51–1.86s
//   glm-5.2@gw-windsurf          1.20–2.14s        2.10–7.35s
//   gemini-3.7-flash@gw-windsurf 2.38–4.89s        2.47–5.00s
//   kimi-k3@gw-sub              10.06–15.20s      10.26–15.20s
//   composer-2.5@gw-sub         10.80–16.54s      11.03–16.66s
// 结论一：5000ms 不是「偶尔误判」，是把整个 gw-sub 组（kimi-k3 / composer-2.5）**每次必红**，
//   并且刚好卡住 gemini 的上沿（实测 4889ms 首字节）。#853 的「误换位」由此而来。
// 结论二：预算要盖住的是整针收口而不只是首字节（探针读到收尾事件才收口），实测最慢 16.66s。
// 取 30000ms ≈ 实测最坏值的 1.8 倍，留出负载下的余量；仍在 validateDispatchPolicy 的 500–60000 内。
// 代价：全部候选都挂住时最坏 maxCandidates(4) × 30s = 120s。可接受，因为超时已不再判红换人。
// 真相源是 docs/dispatch-policy.json，本常量只是文件缺失时的兜底，两处必须同值。
export const DISPATCH_POLICY_DEFAULTS = { enabled: true, timeoutMs: 30000, maxCandidates: 4, useHealthTable: true };
export const COMMANDER_POLICY_DEFAULTS = { maxDispatchPerRound: 2, requireModelInRouting: true };
export const BREAKER_POLICY_DEFAULTS = { ...BREAKER_DEFAULTS, overrides: {} };

function parseCommanderSection(cm) {
  const src = cm && typeof cm === 'object' ? cm : {};
  const n = Number(src.maxDispatchPerRound);
  return {
    maxDispatchPerRound: Number.isInteger(n) && n >= 1 && n <= 20
      ? n
      : COMMANDER_POLICY_DEFAULTS.maxDispatchPerRound,
    requireModelInRouting: typeof src.requireModelInRouting === 'boolean'
      ? src.requireModelInRouting
      : COMMANDER_POLICY_DEFAULTS.requireModelInRouting,
  };
}

/** 读 docs/dispatch-policy.json 的 preflight + commander 节，缺项用缺省。文件不在 = 用缺省（不算错）。 */
export function loadDispatchPolicy({ root = ROOT, read = readFileSync, exists = existsSync } = {}) {
  const path = join(root, 'docs', 'dispatch-policy.json');
  if (!exists(path)) {
    return {
      ...DISPATCH_POLICY_DEFAULTS, breaker: { ...BREAKER_POLICY_DEFAULTS }, commander: { ...COMMANDER_POLICY_DEFAULTS },
      source: 'default', path,
    };
  }
  let doc;
  try {
    doc = JSON.parse(read(path, 'utf8'));
  } catch {
    return {
      ...DISPATCH_POLICY_DEFAULTS, breaker: { ...BREAKER_POLICY_DEFAULTS }, commander: { ...COMMANDER_POLICY_DEFAULTS },
      source: 'default(bad-json)', path,
    };
  }
  const pf = doc && doc.preflight && typeof doc.preflight === 'object' ? doc.preflight : {};
  const br = doc && doc.breaker && typeof doc.breaker === 'object' ? doc.breaker : {};
  return {
    enabled: pf.enabled !== undefined ? !!pf.enabled : DISPATCH_POLICY_DEFAULTS.enabled,
    timeoutMs: Number.isFinite(Number(pf.timeoutMs)) ? Number(pf.timeoutMs) : DISPATCH_POLICY_DEFAULTS.timeoutMs,
    maxCandidates: Number.isFinite(Number(pf.maxCandidates)) ? Number(pf.maxCandidates) : DISPATCH_POLICY_DEFAULTS.maxCandidates,
    useHealthTable: pf.useHealthTable !== undefined ? !!pf.useHealthTable : DISPATCH_POLICY_DEFAULTS.useHealthTable,
    breaker: {
      windowHours: Number.isFinite(Number(br.windowHours)) ? Number(br.windowHours) : BREAKER_POLICY_DEFAULTS.windowHours,
      failuresToTrip: Number.isFinite(Number(br.failuresToTrip)) ? Number(br.failuresToTrip) : BREAKER_POLICY_DEFAULTS.failuresToTrip,
      cooldownHours: Number.isFinite(Number(br.cooldownHours)) ? Number(br.cooldownHours) : BREAKER_POLICY_DEFAULTS.cooldownHours,
      halfOpenProbes: Number.isFinite(Number(br.halfOpenProbes)) ? Number(br.halfOpenProbes) : BREAKER_POLICY_DEFAULTS.halfOpenProbes,
      overrides: br.overrides && typeof br.overrides === 'object' ? br.overrides : {},
    },
    commander: parseCommanderSection(doc && doc.commander),
    source: 'file',
    path,
  };
}

/**
 * 校验 preflight + commander 取值范围（dao-check 自持，不 import 消费方）。
 * enabled/useHealthTable 必须布尔；timeoutMs ∈ [500, 60000]；maxCandidates 整数 ∈ [1, 12]。
 * commander.maxDispatchPerRound 整数 ∈ [1, 20]；requireModelInRouting 必须布尔。
 * 缺 commander 节不算没查成（#842 旧文件兼容），但 live 文件应有。
 */
export function validateDispatchPolicy(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return { ok: false, unscanned: true, problems: ['不是对象'] };
  const pf = doc.preflight;
  if (!pf || typeof pf !== 'object') return { ok: false, unscanned: true, problems: ['缺 preflight 节'] };
  if (typeof pf.enabled !== 'boolean') problems.push('enabled 必须 true/false');
  if (typeof pf.useHealthTable !== 'boolean') problems.push('useHealthTable 必须 true/false');
  const t = Number(pf.timeoutMs);
  if (!Number.isFinite(t) || t < 500 || t > 60000) problems.push(`timeoutMs 越界（要 500~60000，实际 ${pf.timeoutMs}）`);
  const n = Number(pf.maxCandidates);
  if (!Number.isInteger(n) || n < 1 || n > 12) problems.push(`maxCandidates 越界（要整数 1~12，实际 ${pf.maxCandidates}）`);
  const br = doc.breaker;
  if (!br || typeof br !== 'object') problems.push('缺 breaker 节');
  else {
    const w = Number(br.windowHours);
    if (!Number.isFinite(w) || w < 1 || w > 168) problems.push(`breaker.windowHours 越界（要 1~168，实际 ${br.windowHours}）`);
    const f = br.failuresToTrip;
    if (!Number.isInteger(f) || f < 1 || f > 20) problems.push(`breaker.failuresToTrip 越界（要整数 1~20，实际 ${br.failuresToTrip}）`);
    const c = Number(br.cooldownHours);
    if (!Number.isFinite(c) || c < 0.25 || c > 168) problems.push(`breaker.cooldownHours 越界（要 0.25~168，实际 ${br.cooldownHours}）`);
    const h = br.halfOpenProbes;
    if (!Number.isInteger(h) || h < 1 || h > 5) problems.push(`breaker.halfOpenProbes 越界（要整数 1~5，实际 ${br.halfOpenProbes}）`);
  }
  const cm = doc.commander;
  if (cm != null) {
    if (typeof cm !== 'object') problems.push('commander 必须是对象');
    else {
      if (typeof cm.requireModelInRouting !== 'boolean') problems.push('requireModelInRouting 必须 true/false');
      const m = Number(cm.maxDispatchPerRound);
      if (!Number.isInteger(m) || m < 1 || m > 20) problems.push(`maxDispatchPerRound 越界（要整数 1~20，实际 ${cm.maxDispatchPerRound}）`);
    }
  }
  return { ok: problems.length === 0, unscanned: false, problems };
}

/** 审计 ndjson 路径：~/.dao/preflight/<YYYY-MM-DD>.ndjson（UTC 日期）。 */
export function preflightAuditPath({ home = os.homedir(), now = new Date() } = {}) {
  const d = now instanceof Date ? now : new Date(now);
  const day = d.toISOString().slice(0, 10);
  return join(home, '.dao', 'preflight', `${day}.ndjson`);
}

/** 追加一条审计。字段：ts,target,state,code,ms,why,dispatchId（+role,model）。写不进不炸主流程。 */
export function appendPreflightAudit(record, { home = os.homedir(), now = new Date(), append = appendFileSync } = {}) {
  const path = preflightAuditPath({ home, now });
  const line = JSON.stringify({
    ts: record.ts || (now instanceof Date ? now.toISOString() : new Date(now).toISOString()),
    target: record.target ?? null,
    state: record.state,
    code: record.code ?? null,
    ms: record.ms ?? null,
    why: record.why ?? null,
    dispatchId: record.dispatchId ?? null,
    role: record.role ?? null,
    model: record.model ?? null,
  });
  try {
    mkdirSync(join(home, '.dao', 'preflight'), { recursive: true });
    append(path, line + '\n', 'utf8');
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: String(e.message || e), path };
  }
}

/** 名单条目 → 落地 { provider, cli_model }。兼容 routing 模型与名单条目（含 pipes）。 */
function landingOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.landing && entry.landing.provider) return entry.landing;
  if (Array.isArray(entry.pipes) && entry.pipes[0] && entry.pipes[0].provider) {
    return { provider: String(entry.pipes[0].provider), cli_model: entry.pipes[0].cli_model };
  }
  if (entry.provider) return { provider: String(entry.provider), cli_model: entry.cli_model };
  return null;
}

// 超时容差：AbortController 那颗 setTimeout 可能提前几毫秒响，Windows 上 Date.now 粒度约 15ms。
// 没有容差，一次「4998ms 被自己掐掉」会被当成真红——而它其实就是超时。
export const PROBE_TIMEOUT_TOLERANCE_MS = 50;

/** 回退时说清是哪一种软态（三种软态互不相同，不许在人话里合并）。 */
const SOFT_LABEL = {
  unscanned: '探不了',
  no_finish: '有真内容但没见到收尾',
  timeout: '超时，通道一句话都没表过态',
};

/**
 * 探针回了 red，再问一句：是**上游说不行**，还是**我们自己等不及了**？（#853）
 *
 * 判据只吃结构化字段，不解析 why 里的中文——那句话改个措辞，判据就会静默失效：
 *   · ms 摸到了我们自己给的预算 → 先响的是我们的秒表，不是上游的拒绝；
 *   · 上游没给过「不行」的状态码（code 为空，或 2xx 起了流却没吐出内容）。
 * 两条同时成立才算超时。401/403/429/5xx 这类真错误码一律照旧判红，快慢无关。
 */
export function isProbeTimeout(r, timeoutMs) {
  if (!r || r.state !== 'red') return false;
  const budget = Number(timeoutMs);
  if (!Number.isFinite(budget) || budget <= 0) return false;
  const ms = Number(r.ms);
  if (!Number.isFinite(ms)) return false;
  if (ms + PROBE_TIMEOUT_TOLERANCE_MS < budget) return false;
  if (r.code == null) return true;
  const code = Number(r.code);
  return Number.isFinite(code) && code >= 200 && code < 300;
}

/** 这一针实际用的预算：probeOpts.timeoutMs 覆盖 policy.timeoutMs（与 doProbe 的拼法保持一致）。 */
function effectiveTimeoutMs(policy, probeOpts) {
  const fromOpts = Number(probeOpts && probeOpts.timeoutMs);
  if (Number.isFinite(fromOpts) && fromOpts > 0) return fromOpts;
  const fromPolicy = Number(policy && policy.timeoutMs);
  return Number.isFinite(fromPolicy) && fromPolicy > 0 ? fromPolicy : DISPATCH_POLICY_DEFAULTS.timeoutMs;
}

/**
 * runPreflight —— 起 agent 前的探一针编排。纯逻辑 + 注入 probe/audit，可测。
 *
 * @param {object} args
 * @param {Array}  args.candidates  有序候选：[{ id, landing:{provider,cli_model} } | routing模型 | slate条目]
 * @param {object} args.policy      loadDispatchPolicy 结果
 * @param {boolean} args.noPreflight 单次跳过（--no-preflight），仍记账
 * @param {string} args.role        '工人'|'审官'（记账用）
 * @param {string|null} args.dispatchId
 * @param {object} [args.availabilityResult] availabilityFor 结果（不给则内部算）
 * @param {function} [args.probe]   async (landing)=>{state,code,ms,why,target}（缺省 probeLanding）
 * @param {function} [args.audit]   (record)=>void（缺省 appendPreflightAudit）
 * @param {object} [args.probeOpts] 传给 probe 的 opts（timeoutMs 等）
 * @param {Date|number} [args.now]
 * @returns {Promise<object>}
 */
function defaultRecordBreaker(event, { home, now, policy }) {
  if (process.env.NODE_TEST_CONTEXT) return { ok: true, skipped: 'test' };
  try {
    // 全部 open 的报警在 recordEvent 里面发、发成才盖戳；这里别再补一刀 escalateAllOpen（会撞 6h 去重）。
    return recordEvent(event, { home, now, policy: policy && policy.breaker });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export async function runPreflight({
  candidates = [], policy = DISPATCH_POLICY_DEFAULTS, noPreflight = false, role = '工人',
  dispatchId = null, availabilityResult = null, probe, audit, probeOpts = {}, now = new Date(),
  home = os.homedir(), recordBreaker, breakerDoc,
} = {}) {
  const doProbe = probe || ((landing) => probeLanding(landing, { timeoutMs: policy.timeoutMs, ...probeOpts }));
  const doAudit = audit || ((rec) => appendPreflightAudit(rec, { home, now }));
  const doRecord = recordBreaker || ((ev) => defaultRecordBreaker(ev, { home, now, policy }));
  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const nowMsValue = now instanceof Date ? now.getTime() : Number(now);
  if (!breakerDoc && !process.env.NODE_TEST_CONTEXT) {
    const loaded = loadBreakerDoc({ home });
    breakerDoc = loaded.doc;
  }

  const cands = (candidates || []).map(c => {
    if (c && typeof c === 'object' && c.id != null && (c.landing || c.pipes || c.provider)) {
      return { id: String(c.id), landing: landingOf(c) };
    }
    return { id: c && c.id != null ? String(c.id) : String(c), landing: landingOf(c) };
  }).filter(c => c.id);

  const notes = [];
  const probed = [];
  const reasons = {};

  // 未启用：透传第一位，不探不记账（--no-preflight 才记账）。
  if (!policy || policy.enabled === false) {
    const first = cands[0] || null;
    return {
      ok: !!first, chosen: first ? first.id : null, chosenLanding: first ? first.landing : null,
      reordered: cands.map(c => c.id), probed, hardBlocked: [], allRed: false, stop: false,
      skipped: true, reasons, notes: ['preflight 未启用（dispatch-policy.enabled=false），透传'],
    };
  }

  // 健康表 + 熔断表：算可用性用于排序与直接拦。
  const avail = availabilityResult
    || (policy.useHealthTable ? availabilityFor(cands, { now: nowMsValue, home, breakerPolicy: policy.breaker }) : { availability: {}, hardBlocked: {}, deprioritize: new Set(), reasons: {}, notes: [], unknown: false });
  for (const n of avail.notes || []) notes.push(n);
  for (const [id, rs] of Object.entries(avail.reasons || {})) reasons[id] = [...(reasons[id] || []), ...rs];

  // 熔断 open：直接拦，从候选剔除。
  const hardBlocked = [];
  const usable = [];
  for (const c of cands) {
    if (avail.hardBlocked && avail.hardBlocked[c.id]) {
      hardBlocked.push({ id: c.id, label: avail.hardBlocked[c.id] });
    } else {
      usable.push(c);
    }
  }
  if (usable.length === 0) {
    notes.push('全部候选被熔断 open 拦下');
    return {
      ok: false, chosen: null, chosenLanding: null, reordered: [], probed, hardBlocked,
      allRed: false, stop: true, skipped: false, reasons, notes,
    };
  }

  // 健康红 / 熔断 half-open 后置（稳定排序）。
  const dep = avail.deprioritize || new Set();
  const reordered = [
    ...usable.filter(c => !dep.has(c.id)),
    ...usable.filter(c => dep.has(c.id)),
  ];

  // --no-preflight：不探，选第一位，记一条 skipped。
  if (noPreflight) {
    const first = reordered[0];
    doAudit({ ts: nowIso, target: first ? probeTargetOf(first.landing) : null, state: 'skipped', code: null, ms: 0, why: '--no-preflight', dispatchId, role, model: first ? first.id : null });
    notes.push('--no-preflight：跳过探针，已记账');
    return {
      ok: !!first, chosen: first ? first.id : null, chosenLanding: first ? first.landing : null,
      reordered: reordered.map(c => c.id), probed, hardBlocked, allRed: false, stop: false,
      skipped: true, reasons, notes,
    };
  }

  // 逐位真探（上限 maxCandidates）。
  const budget = Math.max(1, Number(policy.maxCandidates) || DISPATCH_POLICY_DEFAULTS.maxCandidates);
  const timeoutBudgetMs = effectiveTimeoutMs(policy, probeOpts);
  let firstUnscanned = null;      // 第一个软态候选（探不了 / 没收尾 / 超时），全都没绿时回退用它
  let firstSoftState = null;      // 它是哪一种软态——回退的人话里要说清，不许糊成一句「不可用」
  const tried = reordered.slice(0, budget);
  const breakerPol = policy.breaker || BREAKER_POLICY_DEFAULTS;
  for (const c of tried) {
    const target = probeTargetOf(c.landing);
    if (target && breakerDoc && breakerDoc.targets && breakerDoc.targets[target]) {
      const av = inspectAvailability(breakerDoc.targets[target], nowMsValue, breakerPol);
      if (!av.available) {
        hardBlocked.push({ id: c.id, label: av.until ? `cooldown(until ${av.until})` : (av.why || 'cooldown') });
        reasons[c.id] = [...(reasons[c.id] || []), 'breaker:blocked-no-probe'];
        continue; // 冷却中不发请求
      }
      if (av.state === 'half-open') {
        const recProbe = doRecord({ type: 'probe', target, why: 'half-open 一针' });
        if (recProbe && recProbe.doc) breakerDoc = recProbe.doc;
      }
    }
    let r;
    try {
      r = await doProbe(c.landing);
    } catch (e) {
      r = { state: 'red', code: null, ms: null, why: `探针抛错：${String(e.message || e)}`, target: null };
    }
    // #853：探针把「我们等不及了」也归进 red，而排队型网关首字节本来就慢——
    // 实测 gw-sub 组（kimi-k3 / composer-2.5）首字节 10~16.5s，5s 预算下 100% 判红。
    // 判红的代价不是慢一点，是**当场换人**：#853 实咬里 luna 正在审 PR #850/#851、通道好好的，
    // 却被换成 glm。所以超时在这里升成独立一态，与 no_finish 同路（软态：不当绿、不换人、不记熔断）。
    if (isProbeTimeout(r, timeoutBudgetMs)) {
      r = { ...r, state: 'timeout', why: `${r.why || '超时'}（预算 ${timeoutBudgetMs}ms；上游未表态，不判红）` };
    }
    const rec = { ts: (now instanceof Date ? now.toISOString() : new Date(now).toISOString()), target: r.target ?? target ?? null, state: r.state, code: r.code ?? null, ms: r.ms ?? null, why: r.why ?? null, dispatchId, role, model: c.id };
    doAudit(rec);
    probed.push({ id: c.id, ...rec });
    if (r.state === 'green') {
      if (rec.target) doRecord({ type: 'success', target: rec.target, why: '派前探绿' });
      return { ok: true, chosen: c.id, chosenLanding: c.landing, reordered: reordered.map(x => x.id), probed, hardBlocked, allRed: false, stop: false, skipped: false, reasons, notes };
    }
    if (r.state === 'unscanned') {
      // 探不了（grok Build / cursor / devin …）：不许当绿，但也没证据它挂了 → 按现状起，watchdog 兜底。
      if (!firstUnscanned) { firstUnscanned = c; firstSoftState = r.state; }
      reasons[c.id] = [...(reasons[c.id] || []), `unscanned:${r.why || '探不了'}`];
      // 继续看后面有没有能探到绿的；没有再回退到它。
      continue;
    }
    if (r.state === 'timeout') {
      // #853 第五态：预算用完了，而上游连一句「不行」都没说过。
      // 走 unscanned/no_finish 同样的保守路：先看后面有没有真绿的，没有再回退用它。
      // **刻意不记熔断失败**——窗口内三次就 cooldown 24h，那正是把一次误判放大成
      // 「整条腿被拉黑一天」的机制，也正是 #853 里换错人的来源。
      // 已知代价：真正挂死（永不吐字）的上游因此不再被熔断拉黑，每次派工都要陪它耗满预算。
      // 换来的是不再误杀正在干活的通道；挂死那侧另有 dao-agent-stall 与 watchdog 兜。
      if (!firstUnscanned) { firstUnscanned = c; firstSoftState = r.state; }
      reasons[c.id] = [...(reasons[c.id] || []), `timeout:${r.why || '没等到'}`];
      continue;
    }
    if (r.state === 'no_finish') {
      // #953 新加的第四态：2xx + 有真内容，但没见到收尾事件。通道**是通的**，只是这一次流被掐了。
      // 不许当绿（它掩盖的正是 `stream ended before message_stop` 那类故障），
      // 也不许当红——判红会当场换模型，而网关偶尔漏一个收尾事件就把好通道换掉，
      // 派工会莫名其妙地换人甚至停手（2026-09-05 实咬：加完这一态没接下游，dao.test.js 间歇红）。
      // 走 unscanned 同样的保守路：先看后面有没有真绿的，没有再回退用它。
      if (!firstUnscanned) { firstUnscanned = c; firstSoftState = r.state; }
      reasons[c.id] = [...(reasons[c.id] || []), `no_finish:${r.why || '没见到收尾'}`];
      continue;
    }
    // red：换下一位；记失败事件（判定在纯函数里）
    reasons[c.id] = [...(reasons[c.id] || []), `probe:red(${r.code ?? '—'})`];
    if (rec.target) {
      const recFail = doRecord({ type: 'failure', target: rec.target, code: r.code, why: r.why || `派前探红 HTTP ${r.code ?? '—'}` });
      if (recFail && recFail.doc) breakerDoc = recFail.doc;
    }
  }

  // 没探到绿：有探不了的就按现状起它（保守：不因探不了而停摆）；否则全红 → 报帅停手。
  if (firstUnscanned) {
    const label = SOFT_LABEL[firstSoftState] || '软态';
    notes.push(`没探到绿，回退到 ${firstUnscanned.id}（${label}：按现状起，watchdog 兜底；不当绿）`);
    return {
      ok: true, chosen: firstUnscanned.id, chosenLanding: firstUnscanned.landing, unscannedFallback: true,
      fallbackState: firstSoftState,
      reordered: reordered.map(c => c.id), probed, hardBlocked, allRed: false, stop: false, skipped: false, reasons, notes,
    };
  }
  notes.push(`探了 ${probed.length} 位全红，报帅停手（不起 agent）`);
  return {
    ok: false, chosen: null, chosenLanding: null, reordered: reordered.map(c => c.id), probed, hardBlocked,
    allRed: true, stop: true, skipped: false, reasons, notes,
  };
}

/**
 * preflight 只读动词处理（dao.mjs 只加一行分发到这里）。
 * 探一个模型，输出与 ndjson 同形；--json 出结构化。
 */
export async function runPreflightCommand(args = {}, { routingModels, probe, home, now, recordBreaker, breakerDoc } = {}) {
  const modelId = args.model || args['--model'];
  if (!modelId) return { ok: false, error: 'preflight 要 --model <id>' };
  const models = routingModels || [];
  const model = models.find(m => m && m.id === modelId);
  if (!model) return { ok: false, error: `模型 ${modelId} 不在路由表` };
  const landing = landingOf(model);
  if (!landing || !landing.provider) return { ok: false, error: `模型 ${modelId} 缺落地（provider）` };
  const policy = loadDispatchPolicy({});
  const target = probeTargetOf(landing);
  const nowMsValue = now instanceof Date ? now.getTime() : (now != null ? Number(now) : Date.now());
  const doRecord = recordBreaker || ((ev) => defaultRecordBreaker(ev, { home, now: nowMsValue, policy }));
  if (!breakerDoc) {
    const loaded = loadBreakerDoc({ home });
    breakerDoc = loaded.doc;
  }
  if (target && breakerDoc && breakerDoc.targets && breakerDoc.targets[target]) {
    const av = inspectAvailability(breakerDoc.targets[target], nowMsValue, policy.breaker || BREAKER_POLICY_DEFAULTS);
    if (!av.available) {
      return {
        ok: false, blocked: true, model: modelId, landing, target,
        state: 'blocked', why: av.until ? `cooldown(until ${av.until})` : (av.why || '熔断冷却中'),
        error: `熔断冷却中，不发请求（${av.until ? `until ${av.until}` : av.why || 'open'}）`,
      };
    }
    if (av.state === 'half-open') doRecord({ type: 'probe', target, why: 'half-open 一针' });
  }
  const doProbe = probe || ((l) => probeLanding(l, { timeoutMs: policy.timeoutMs }));
  let r = await doProbe(landing);
  // 与 runPreflight 同一条判据（#853）：超时是独立一态，不判红也不记熔断失败。
  // 只读动词也要照办——否则人手探一针就能把一条正在排队的腿推进 cooldown。
  const timeoutBudgetMs = effectiveTimeoutMs(policy, null);
  if (isProbeTimeout(r, timeoutBudgetMs)) {
    r = { ...r, state: 'timeout', why: `${r.why || '超时'}（预算 ${timeoutBudgetMs}ms；上游未表态，不判红）` };
  }
  const rec = {
    ts: (now instanceof Date ? now : new Date()).toISOString(),
    target: r.target ?? target ?? null, state: r.state, code: r.code ?? null, ms: r.ms ?? null,
    why: r.why ?? null, dispatchId: null, role: 'preflight-verb', model: modelId,
  };
  appendPreflightAudit(rec, { home, now });
  if (rec.target && r.state === 'green') doRecord({ type: 'success', target: rec.target, why: 'preflight 绿' });
  if (rec.target && r.state === 'red') doRecord({ type: 'failure', target: rec.target, code: r.code, why: r.why || `preflight 红 HTTP ${r.code ?? '—'}` });
  return { ok: true, model: modelId, landing, ...rec, json: !!args.json };
}
