// scripts/lib/preflight.mjs —— 派前探一针编排引擎（#842）
//
// 起 agent 前：先按健康表把红的排后、熔断 open 的直接拦，再逐位真探（同路径流式），
// 红了换下一位（同厂闸由调用方保证，本引擎只按给定顺序探），全红 → 报帅停手。
// 工人接线在 dispatch/launch.mjs（preflightWorkerSlate），审官在 dispatch/reviewer.mjs
// （preflightReviewer）；两者都调本文件 runPreflight，DRY。
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

export const DISPATCH_POLICY_DEFAULTS = { enabled: true, timeoutMs: 5000, maxCandidates: 4, useHealthTable: true };
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
  let firstUnscanned = null;
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
    const rec = { ts: (now instanceof Date ? now.toISOString() : new Date(now).toISOString()), target: r.target ?? target ?? null, state: r.state, code: r.code ?? null, ms: r.ms ?? null, why: r.why ?? null, dispatchId, role, model: c.id };
    doAudit(rec);
    probed.push({ id: c.id, ...rec });
    if (r.state === 'green') {
      if (rec.target) doRecord({ type: 'success', target: rec.target, why: '派前探绿' });
      return { ok: true, chosen: c.id, chosenLanding: c.landing, reordered: reordered.map(x => x.id), probed, hardBlocked, allRed: false, stop: false, skipped: false, reasons, notes };
    }
    if (r.state === 'unscanned') {
      // 探不了（grok Build / cursor / devin …）：不许当绿，但也没证据它挂了 → 按现状起，watchdog 兜底。
      if (!firstUnscanned) firstUnscanned = c;
      reasons[c.id] = [...(reasons[c.id] || []), `unscanned:${r.why || '探不了'}`];
      // 继续看后面有没有能探到绿的；没有再回退到它。
      continue;
    }
    if (r.state === 'no_finish') {
      // #953 新加的第四态：2xx + 有真内容，但没见到收尾事件。通道**是通的**，只是这一次流被掐了。
      // 不许当绿（它掩盖的正是 `stream ended before message_stop` 那类故障），
      // 也不许当红——判红会当场换模型，而网关偶尔漏一个收尾事件就把好通道换掉，
      // 派工会莫名其妙地换人甚至停手（2026-09-05 实咬：加完这一态没接下游，dao.test.js 间歇红）。
      // 走 unscanned 同样的保守路：先看后面有没有真绿的，没有再回退用它。
      if (!firstUnscanned) firstUnscanned = c;
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
    notes.push(`没探到绿，回退到探不了的 ${firstUnscanned.id}（按现状起，watchdog 兜底；不当绿）`);
    return {
      ok: true, chosen: firstUnscanned.id, chosenLanding: firstUnscanned.landing, unscannedFallback: true,
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
  const r = await doProbe(landing);
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
