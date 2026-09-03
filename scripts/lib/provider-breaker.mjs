// scripts/lib/provider-breaker.mjs —— 编排层熔断纯函数 + 落盘（#843）
//
// 健康表 ~/.dao/provider-health.json 由探针写；熔断表 ~/.dao/provider-breaker.json
// 由本文件写。一个文件一个写者。时钟一律由调用方传入（禁 Date.now）。
//
// 状态机（标准断路器）：
//   closed ──窗口内失败 ≥ failuresToTrip──► open（cooldownUntil = now + cooldownHours）
//   open   ──now ≥ cooldownUntil────────► half-open（只放 halfOpenProbes 针）
//   half-open ──绿──► closed（failures 清空）
//             ──红──► open 再一轮
//
// 三路信号只记事件，阈值判定全在 applyEvent，不许各写一套。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const BREAKER_DEFAULTS = Object.freeze({
  windowHours: 24,
  failuresToTrip: 3,
  cooldownHours: 24,
  halfOpenProbes: 1,
});

export const ALL_OPEN_DEDUP_MS = 6 * 3600 * 1000;

const BREAKER_REL = ['.dao', 'provider-breaker.json'];

export function breakerPath(home = os.homedir()) {
  return join(home, ...BREAKER_REL);
}

export function nowMs(now) {
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  if (now instanceof Date && Number.isFinite(now.getTime())) return now.getTime();
  if (typeof now === 'string') {
    const n = Date.parse(now);
    if (Number.isFinite(n)) return n;
  }
  throw new Error('熔断纯函数必须传入 now（禁 Date.now）');
}

function isoOf(ms) {
  return new Date(ms).toISOString();
}

function cloneDoc(state) {
  const targets = state && state.targets && typeof state.targets === 'object' ? state.targets : {};
  const out = { updatedAt: state && state.updatedAt, targets: {} };
  for (const [k, v] of Object.entries(targets)) {
    out.targets[k] = v && typeof v === 'object' ? { ...v, failures: Array.isArray(v.failures) ? [...v.failures] : [] } : v;
  }
  if (state && state.allOpenAlertedAt) out.allOpenAlertedAt = state.allOpenAlertedAt;
  return out;
}

function emptyTarget() {
  return { state: 'closed', failures: [] };
}

/** 策略 + 按 target 覆盖。overrides 不进入返回值。 */
export function resolveBreakerPolicy(policy, target) {
  const src = policy && typeof policy === 'object' ? policy : {};
  const base = {
    windowHours: Number.isFinite(Number(src.windowHours)) ? Number(src.windowHours) : BREAKER_DEFAULTS.windowHours,
    failuresToTrip: Number.isFinite(Number(src.failuresToTrip)) ? Number(src.failuresToTrip) : BREAKER_DEFAULTS.failuresToTrip,
    cooldownHours: Number.isFinite(Number(src.cooldownHours)) ? Number(src.cooldownHours) : BREAKER_DEFAULTS.cooldownHours,
    halfOpenProbes: Number.isFinite(Number(src.halfOpenProbes)) ? Number(src.halfOpenProbes) : BREAKER_DEFAULTS.halfOpenProbes,
  };
  const ov = src.overrides && target && src.overrides[target] && typeof src.overrides[target] === 'object'
    ? src.overrides[target] : null;
  if (!ov) return base;
  return {
    windowHours: Number.isFinite(Number(ov.windowHours)) ? Number(ov.windowHours) : base.windowHours,
    failuresToTrip: Number.isFinite(Number(ov.failuresToTrip)) ? Number(ov.failuresToTrip) : base.failuresToTrip,
    cooldownHours: Number.isFinite(Number(ov.cooldownHours)) ? Number(ov.cooldownHours) : base.cooldownHours,
    halfOpenProbes: Number.isFinite(Number(ov.halfOpenProbes)) ? Number(ov.halfOpenProbes) : base.halfOpenProbes,
  };
}

function filterFailures(failures, now, windowHours) {
  const windowMs = Number(windowHours) * 3600 * 1000;
  const cutoff = now - windowMs;
  return (failures || []).filter((iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= cutoff;
  });
}

function tripTarget(t, pol, now, why) {
  return {
    state: 'open',
    failures: Array.isArray(t.failures) ? [...t.failures] : [],
    trippedAt: isoOf(now),
    cooldownUntil: isoOf(now + Number(pol.cooldownHours) * 3600 * 1000),
    why: why || `${(t.failures || []).length} 次失败 within ${pol.windowHours}h`,
    halfOpenUsed: 0,
    ...(t.lastHealthAt ? { lastHealthAt: t.lastHealthAt } : {}),
    ...(t.lastStall ? { lastStall: t.lastStall } : {}),
  };
}

function closeTarget(t) {
  return {
    state: 'closed',
    failures: [],
    ...(t && t.lastHealthAt ? { lastHealthAt: t.lastHealthAt } : {}),
    ...(t && t.lastStall ? { lastStall: t.lastStall } : {}),
  };
}

/** 时间流逝：open 到点 → half-open；窗口外失败丢掉。不看 Date.now。 */
export function advanceTarget(target, policy, now) {
  const t = target && typeof target === 'object' ? target : emptyTarget();
  const pol = resolveBreakerPolicy(policy);
  const ms = nowMs(now);
  const failures = filterFailures(t.failures, ms, pol.windowHours);
  let state = t.state || 'closed';
  let halfOpenUsed = Number.isInteger(t.halfOpenUsed) ? t.halfOpenUsed : 0;
  const next = { ...t, failures, state, halfOpenUsed };
  if (state === 'open') {
    const until = Date.parse(t.cooldownUntil || '');
    if (Number.isFinite(until) && ms >= until) {
      next.state = 'half-open';
      next.halfOpenUsed = 0;
    }
  }
  return next;
}

/**
 * 单 target 是否还允许发请求。
 * closed → 是；open 冷却未到 → 否；half-open 且一针未用完 → 是。
 */
export function isAvailable(state, now, policy = BREAKER_DEFAULTS) {
  return inspectAvailability(state, now, policy).available;
}

export function inspectAvailability(state, now, policy = BREAKER_DEFAULTS) {
  if (!state || typeof state !== 'object') return { available: true, state: 'closed' };
  const pol = resolveBreakerPolicy(policy);
  const t = advanceTarget(state, pol, now);
  if (t.state === 'closed' || !t.state) return { available: true, state: 'closed' };
  if (t.state === 'open') {
    return {
      available: false,
      state: 'open',
      until: t.cooldownUntil,
      why: t.why || '熔断冷却中',
    };
  }
  if (t.state === 'half-open') {
    const budget = Math.max(1, Number(pol.halfOpenProbes) || 1);
    if ((t.halfOpenUsed || 0) >= budget) {
      return { available: false, state: 'half-open', why: 'half-open 一针已用' };
    }
    return { available: true, state: 'half-open' };
  }
  return { available: true, state: t.state };
}

function failureWhy(event, count, pol) {
  if (event && event.why) return event.why;
  const code = event && event.code != null ? String(event.code) : '';
  const hint = event && event.target ? ` (${event.target})` : '';
  return `${count} 次${code ? ` ${code}` : ''} within ${pol.windowHours}h${hint}`.replace(/  +/g, ' ');
}

/**
 * applyEvent(state, event, policy, now) → state'
 * state / 返回值都是整份熔断表 { updatedAt, targets }。
 * event.type ∈ failure | success | probe | reset | trip | tick
 * event.target 除 tick 外必填。
 */
export function applyEvent(state, event, policy, now) {
  const ms = nowMs(now);
  const doc = cloneDoc(state);
  doc.updatedAt = isoOf(ms);

  const ev = event && typeof event === 'object' ? event : { type: 'tick' };
  const type = String(ev.type || 'tick');

  // 先让所有 target 按时钟推进（open → half-open）。
  for (const [k, t] of Object.entries(doc.targets)) {
    doc.targets[k] = advanceTarget(t, resolveBreakerPolicy(policy, k), ms);
  }

  if (type === 'tick') return doc;
  const target = ev.target != null ? String(ev.target) : '';
  if (!target) return doc;

  const pol = resolveBreakerPolicy(policy, target);
  let t = advanceTarget(doc.targets[target] || emptyTarget(), pol, ms);

  if (type === 'failure') {
    if (t.state === 'open') {
      // 冷却中不该发请求；多余失败不刷新倒计时。
    } else if (t.state === 'half-open') {
      t = tripTarget(t, pol, ms, ev.why || 'half-open 一针仍红');
    } else {
      t.failures = [...(t.failures || []), isoOf(ms)];
      if (t.failures.length >= pol.failuresToTrip) {
        t = tripTarget(t, pol, ms, failureWhy(ev, t.failures.length, pol));
      }
    }
  } else if (type === 'success') {
    // 只 half-open 合闸清零。closed 窗口内失败按时间衰减，绿不擦历史（否则永远凑不满 3 次）。
    if (t.state === 'half-open') t = closeTarget(t);
  } else if (type === 'probe') {
    if (t.state === 'half-open') {
      t.halfOpenUsed = (t.halfOpenUsed || 0) + 1;
    }
  } else if (type === 'reset') {
    t = closeTarget(t);
  } else if (type === 'trip') {
    const hours = ev.hours != null && Number.isFinite(Number(ev.hours)) ? Number(ev.hours) : pol.cooldownHours;
    t = tripTarget(t, { ...pol, cooldownHours: hours }, ms, ev.why || `手动熔断 ${hours}h`);
  }

  doc.targets[target] = t;
  return doc;
}

/** 表里已有的 target 是否全部处于冷却中的 open。空表 / 单条不算（单条 open 还能派别的路）。 */
export function allTargetsOpen(doc, now) {
  const targets = doc && doc.targets && typeof doc.targets === 'object' ? doc.targets : {};
  const keys = Object.keys(targets);
  if (keys.length < 2) return false;
  const ms = nowMs(now);
  return keys.every((k) => {
    const t = advanceTarget(targets[k], BREAKER_DEFAULTS, ms);
    return t.state === 'open';
  });
}

export function formatAllOpenMessage(doc) {
  const lines = ['【卡点】编排层熔断：全部路径 open，停手不再派。'];
  const targets = doc && doc.targets ? doc.targets : {};
  for (const [k, t] of Object.entries(targets)) {
    lines.push(`- ${k}：${t && t.state ? t.state : '?'} ${t && t.why ? t.why : ''} 至 ${t && t.cooldownUntil ? t.cooldownUntil : ''}`);
  }
  return lines.join('\n');
}

export function planAllOpenAlert(doc, now) {
  if (!allTargetsOpen(doc, now)) return { alert: false };
  const ms = nowMs(now);
  const last = Date.parse((doc && doc.allOpenAlertedAt) || '');
  if (Number.isFinite(last) && ms - last < ALL_OPEN_DEDUP_MS) {
    return { alert: false, reason: '6 小时内已报过' };
  }
  return { alert: true, text: formatAllOpenMessage(doc), why: '全部 target 都 open' };
}

export function stampAllOpenAlert(doc, now, alerted) {
  const next = cloneDoc(doc);
  next.updatedAt = isoOf(nowMs(now));
  if (alerted) next.allOpenAlertedAt = isoOf(nowMs(now));
  else delete next.allOpenAlertedAt;
  return next;
}

export function ingestHealthTable(healthDoc, breakerDoc, policy, now) {
  if (!healthDoc || typeof healthDoc !== 'object') return cloneDoc(breakerDoc);
  const table = healthDoc.targets && typeof healthDoc.targets === 'object' ? healthDoc.targets : {};
  const updatedAt = healthDoc.updatedAt || null;
  let doc = cloneDoc(breakerDoc);
  for (const [key, row] of Object.entries(table)) {
    if (!row) continue;
    const st = String(row.state || '');
    if (st !== 'red' && st !== 'green') continue;
    const prev = doc.targets[key];
    if (updatedAt && prev && prev.lastHealthAt === updatedAt) continue;
    // 绿只在 half-open 合闸：closed 时吃绿会把窗口内失败清掉，永远撞不满 3 次。
    if (st === 'green') {
      const advanced = advanceTarget(prev || emptyTarget(), resolveBreakerPolicy(policy, key), now);
      if (advanced.state !== 'half-open') continue;
    }
    const type = st === 'red' ? 'failure' : 'success';
    doc = applyEvent(doc, {
      type,
      target: key,
      code: row.code,
      why: st === 'red' ? `健康表 red${row.code != null ? ` (${row.code})` : ''}` : '健康表 green',
    }, policy, now);
    if (doc.targets[key] && updatedAt) doc.targets[key].lastHealthAt = updatedAt;
  }
  return doc;
}

/**
 * 撞死指纹 → 失败事件。resolveTarget(term, info) 给不出 key 就跳过（不许猜路径）。
 * 同一 term 的 strikes 不递增不重复记。
 */
export function ingestStall(strikes, breakerDoc, policy, now, { resolveTarget } = {}) {
  const map = typeof resolveTarget === 'function' ? resolveTarget : () => null;
  let doc = cloneDoc(breakerDoc);
  for (const [term, info] of Object.entries(strikes && typeof strikes === 'object' ? strikes : {})) {
    if (!info || (info.strikes || 0) < 1) continue;
    const key = map(term, info);
    if (!key) continue;
    const prev = doc.targets[key];
    const seen = prev && prev.lastStall && prev.lastStall[term];
    if (seen != null && info.strikes <= seen) continue;
    doc = applyEvent(doc, {
      type: 'failure',
      target: key,
      why: `撞死指纹 ${info.sig || info.reported || ''} strikes=${info.strikes}`.trim(),
    }, policy, now);
    if (!doc.targets[key]) continue;
    doc.targets[key].lastStall = { ...(doc.targets[key].lastStall || {}), [term]: info.strikes };
  }
  return doc;
}

export function loadBreakerDoc({ home = os.homedir(), read = readFileSync, exists = existsSync } = {}) {
  const path = breakerPath(home);
  if (!exists(path)) return { ok: true, present: false, doc: { targets: {} }, path };
  try {
    const doc = JSON.parse(read(path, 'utf8'));
    if (!doc || typeof doc !== 'object') return { ok: true, present: true, doc: { targets: {} }, path, reason: '熔断表不是对象' };
    const targets = doc.targets && typeof doc.targets === 'object' ? doc.targets : {};
    return { ok: true, present: true, doc: { ...doc, targets }, path };
  } catch (e) {
    return { ok: false, present: true, doc: { targets: {} }, path, error: `熔断表不是 JSON：${String(e.message || e)}` };
  }
}

export function saveBreakerDoc(doc, { home = os.homedir(), write = writeFileSync, rename = renameSync } = {}) {
  const path = breakerPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const body = JSON.stringify(doc && typeof doc === 'object' ? doc : { targets: {} }, null, 2);
  write(tmp, body, 'utf8');
  rename(tmp, path);
  return { ok: true, path };
}

/**
 * 读-改-写。now 必填。返回 { doc, target, alert }；alert.alert 时调用方负责报帅 / 总控群。
 */
export function recordEvent(event, {
  home = os.homedir(), now, policy, read, exists, write, rename,
} = {}) {
  const loaded = loadBreakerDoc({ home, read, exists });
  let doc = applyEvent(loaded.doc, event, policy, now);
  const plan = planAllOpenAlert(doc, now);
  if (plan.alert) doc = stampAllOpenAlert(doc, now, true);
  else if (!allTargetsOpen(doc, now) && doc.allOpenAlertedAt) doc = stampAllOpenAlert(doc, now, false);
  saveBreakerDoc(doc, { home, write, rename });
  const key = event && event.target != null ? String(event.target) : null;
  return { ok: true, doc, target: key ? doc.targets[key] : null, alert: plan, path: breakerPath(home) };
}

export function defaultHubSay(text) {
  const r = spawnSync('hub-say', [String(text)], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.error) return { ok: false, error: `hub-say 起不来：${r.error.message}` };
  if (r.status !== 0) return { ok: false, error: String(r.stderr || `hub-say exit ${r.status}`).trim().slice(0, 200) };
  return { ok: true };
}

export function defaultOpenIssue({ title, body } = {}) {
  const r = spawnSync(process.execPath, [
    join(import.meta.dirname, '..', 'gh-as.mjs'), 'marshal', '--',
    'issue', 'create', '--title', String(title || ''), '--body', String(body || ''), '--label', '待拍板',
  ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: String(r.stderr || r.stdout || `exit ${r.status}`).slice(0, 200) };
  const m = String(r.stdout || '').match(/\/issues\/(\d+)/);
  return { ok: true, number: m ? Number(m[1]) : null, out: r.stdout };
}

/** 全部 open：总控群一条 + 报帅开待拍板（均可注入；夹具不碰真通道）。 */
export function escalateAllOpen({
  doc, now, hubSay = defaultHubSay, openIssue = defaultOpenIssue, dryRun = false,
} = {}) {
  const plan = planAllOpenAlert(doc, now);
  if (!plan.alert) return { sent: false, reason: plan.reason || '并非全部 open', plan };
  const text = plan.text;
  if (dryRun) return { sent: true, dryRun: true, text, hub: { ok: true, dryRun: true }, issue: { ok: true, dryRun: true } };
  const hub = hubSay(text);
  const issue = openIssue({
    title: '[待拍板] 编排层熔断：全部路径 open',
    body: `${text}\n\n查重标记（勿删）：[breaker-all-open]`,
  });
  return { sent: !!(hub && hub.ok), text, hub, issue, plan };
}

/** 从落地 / 指纹 info 尽量解析 target；认不出返回 null，不许猜。 */
export function stallTargetOf(term, info, { probeTargetOf } = {}) {
  if (info && info.target) return String(info.target);
  if (info && info.landing && probeTargetOf) return probeTargetOf(info.landing) || null;
  if (info && info.model && info.provider && probeTargetOf) {
    return probeTargetOf({ provider: info.provider, cli_model: info.model }) || null;
  }
  return null;
}

function healthDocFromHome(home, read, exists) {
  const path = join(home, '.dao', 'provider-health.json');
  if (!exists(path)) return { present: false, doc: null, path };
  try {
    return { present: true, doc: JSON.parse(read(path, 'utf8')), path };
  } catch (e) {
    return { present: true, doc: null, path, error: String(e.message || e) };
  }
}

function stallDocFromHome(home, read, exists) {
  const path = process.env.AGENT_STALL_WATCH_FILE || join(home, '.agent-stall-watch.json');
  if (!exists(path)) return { present: false, strikes: {}, path };
  try {
    const strikes = JSON.parse(read(path, 'utf8'));
    return { present: true, strikes: strikes && typeof strikes === 'object' ? strikes : {}, path };
  } catch (e) {
    return { present: true, strikes: {}, path, error: String(e.message || e) };
  }
}

/** dao.mjs breaker 动词：reset / trip / ingest-health / ingest-stall。时钟由调用方传入。 */
export function runBreakerCommand(args = {}, {
  home = os.homedir(), now, policy, read = readFileSync, exists = existsSync,
  write, rename, hubSay, openIssue, resolveTarget, dryRun = false,
} = {}) {
  const ms = now != null ? nowMs(now) : (() => { throw new Error('breaker 命令必须传入 now'); })();
  const pol = policy || BREAKER_DEFAULTS;
  const action = args.action || args.verb;
  const key = args.key != null && String(args.key).trim() !== '' ? String(args.key).trim() : null;
  const loaded = loadBreakerDoc({ home, read, exists });

  if (action === 'reset') {
    if (!key) return { ok: false, error: 'breaker reset 要 <key>' };
    const rec = recordEvent({ type: 'reset', target: key, why: '手动解除熔断' }, { home, now: ms, policy: pol, read, exists, write, rename });
    return { ok: true, action: 'reset', key, target: rec.target, doc: rec.doc, path: rec.path };
  }
  if (action === 'trip') {
    if (!key) return { ok: false, error: 'breaker trip 要 <key>' };
    const hours = args.hours != null ? Number(args.hours) : NaN;
    if (!Number.isFinite(hours) || hours < 0.25 || hours > 168) {
      return { ok: false, error: `breaker trip 要 --hours N（0.25~168，实际 ${args.hours}）` };
    }
    const rec = recordEvent({ type: 'trip', target: key, hours, why: `手动熔断 ${hours}h` }, { home, now: ms, policy: pol, read, exists, write, rename });
    const esc = escalateAllOpen({ doc: rec.doc, now: ms, hubSay, openIssue, dryRun });
    return { ok: true, action: 'trip', key, hours, target: rec.target, doc: rec.doc, path: rec.path, alert: rec.alert, escalate: esc };
  }
  if (action === 'ingest-health') {
    const h = healthDocFromHome(home, read, exists);
    if (!h.present) return { ok: true, action: 'ingest-health', skipped: true, reason: '健康表不在' };
    if (!h.doc) return { ok: false, error: `健康表读不了：${h.error || '不是对象'}` };
    let doc = ingestHealthTable(h.doc, loaded.doc, pol, ms);
    const plan = planAllOpenAlert(doc, ms);
    if (plan.alert) doc = stampAllOpenAlert(doc, ms, true);
    saveBreakerDoc(doc, { home, write, rename });
    const esc = escalateAllOpen({ doc, now: ms, hubSay, openIssue, dryRun });
    return { ok: true, action: 'ingest-health', doc, path: breakerPath(home), alert: plan, escalate: esc };
  }
  if (action === 'ingest-stall') {
    const s = stallDocFromHome(home, read, exists);
    if (!s.present) return { ok: true, action: 'ingest-stall', skipped: true, reason: '撞死指纹文件不在' };
    if (s.error) return { ok: false, error: `撞死指纹读不了：${s.error}` };
    const resolve = resolveTarget || ((term, info) => stallTargetOf(term, info));
    let doc = ingestStall(s.strikes, loaded.doc, pol, ms, { resolveTarget: resolve });
    const plan = planAllOpenAlert(doc, ms);
    if (plan.alert) doc = stampAllOpenAlert(doc, ms, true);
    saveBreakerDoc(doc, { home, write, rename });
    const esc = escalateAllOpen({ doc, now: ms, hubSay, openIssue, dryRun });
    return { ok: true, action: 'ingest-stall', doc, path: breakerPath(home), alert: plan, escalate: esc };
  }
  return { ok: false, error: `未知 breaker 动作: ${action}（只要 reset / trip / ingest-health / ingest-stall）` };
}
