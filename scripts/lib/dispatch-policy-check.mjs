// scripts/lib/dispatch-policy-check.mjs — docs/dispatch-policy.json 的 preflight + breaker + commander 节校验（#842 / #843 / #849）
//
// dao-check 用。自持解析：**不 import scripts/lib/preflight.mjs**（消费方），否则自己查自己查不出错。
// preflight：enabled/useHealthTable 布尔；timeoutMs ∈ [500,60000]；maxCandidates 整数 ∈ [1,12]。
// breaker：windowHours 1–168、failuresToTrip 1–20、cooldownHours 0.25–168、halfOpenProbes 整数 1–5；overrides 按 target 覆盖同范围。
// commander：maxDispatchPerRound 整数 ∈ [1,20]；requireModelInRouting 布尔。缺 commander 节不拦（#842 旧夹具兼容）。
// 三态可分：文件不在 / 坏 JSON / 缺 preflight 节 = 没查成（unscanned）；越界 / 缺 breaker = 红；齐且合范围 = 绿。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const POLICY_REL = join('docs', 'dispatch-policy.json');

/** 自持校验（不复用消费方解析）。返回 { ok, unscanned, problems }。 */
export function inspectDispatchPolicySource(src) {
  let doc;
  try {
    doc = JSON.parse(src);
  } catch (e) {
    return { ok: false, unscanned: true, problems: [`不是 JSON：${String(e.message || e).slice(0, 120)}`] };
  }
  if (!doc || typeof doc !== 'object') return { ok: false, unscanned: true, problems: ['顶层不是对象'] };
  const pf = doc.preflight;
  if (!pf || typeof pf !== 'object') return { ok: false, unscanned: true, problems: ['缺 preflight 节'] };
  const problems = [];
  if (typeof pf.enabled !== 'boolean') problems.push('enabled 必须 true/false');
  if (typeof pf.useHealthTable !== 'boolean') problems.push('useHealthTable 必须 true/false');
  const t = Number(pf.timeoutMs);
  if (!Number.isFinite(t) || t < 500 || t > 60000) problems.push(`timeoutMs 越界（要 500~60000，实际 ${pf.timeoutMs}）`);
  const n = pf.maxCandidates;
  if (!Number.isInteger(n) || n < 1 || n > 12) problems.push(`maxCandidates 越界（要整数 1~12，实际 ${pf.maxCandidates}）`);
  problems.push(...inspectBreakerSection(doc.breaker));
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

function inspectBreakerFields(obj, prefix) {
  const problems = [];
  const p = prefix || 'breaker';
  if (obj.windowHours !== undefined) {
    const w = Number(obj.windowHours);
    if (!Number.isFinite(w) || w < 1 || w > 168) problems.push(`${p}.windowHours 越界（要 1~168，实际 ${obj.windowHours}）`);
  }
  if (obj.failuresToTrip !== undefined) {
    const f = obj.failuresToTrip;
    if (!Number.isInteger(f) || f < 1 || f > 20) problems.push(`${p}.failuresToTrip 越界（要整数 1~20，实际 ${obj.failuresToTrip}）`);
  }
  if (obj.cooldownHours !== undefined) {
    const c = Number(obj.cooldownHours);
    if (!Number.isFinite(c) || c < 0.25 || c > 168) problems.push(`${p}.cooldownHours 越界（要 0.25~168，实际 ${obj.cooldownHours}）`);
  }
  if (obj.halfOpenProbes !== undefined) {
    const h = obj.halfOpenProbes;
    if (!Number.isInteger(h) || h < 1 || h > 5) problems.push(`${p}.halfOpenProbes 越界（要整数 1~5，实际 ${obj.halfOpenProbes}）`);
  }
  return problems;
}

function inspectBreakerSection(br) {
  if (!br || typeof br !== 'object' || Array.isArray(br)) return ['缺 breaker 节'];
  const problems = inspectBreakerFields(br, 'breaker');
  if (br.windowHours === undefined) problems.push('breaker 缺 windowHours');
  if (br.failuresToTrip === undefined) problems.push('breaker 缺 failuresToTrip');
  if (br.cooldownHours === undefined) problems.push('breaker 缺 cooldownHours');
  if (br.halfOpenProbes === undefined) problems.push('breaker 缺 halfOpenProbes');
  if (br.overrides !== undefined) {
    if (!br.overrides || typeof br.overrides !== 'object' || Array.isArray(br.overrides)) {
      problems.push('breaker.overrides 必须是对象');
    } else {
      for (const [k, v] of Object.entries(br.overrides)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          problems.push(`breaker.overrides[${k}] 必须是对象`);
          continue;
        }
        problems.push(...inspectBreakerFields(v, `breaker.overrides[${k}]`));
      }
    }
  }
  return problems;
}

function inspectFile(file) {
  if (!existsSync(file)) return { ok: false, unscanned: true, problems: [`文件不在：${file}`] };
  let src;
  try { src = readFileSync(file, 'utf8'); }
  catch (e) { return { ok: false, unscanned: true, problems: [`读失败：${String(e.message || e).slice(0, 120)}`] }; }
  return inspectDispatchPolicySource(src);
}

export function inspectDispatchPolicyLive(root) {
  if (!root) return { ok: false, unscanned: true, problems: ['没给仓库根（没查成）'] };
  return inspectFile(join(root, POLICY_REL));
}

/** 夹具判别力：red 必须拦（ok:false 非 unscanned）、ok 必须绿、empty 必须没查成。 */
export function inspectDispatchPolicyFixtures(root) {
  if (!root) return { ok: false, unscanned: true, error: '没给样本根目录' };
  if (!existsSync(root)) return { ok: false, unscanned: true, error: `样本目录不在：${root}` };
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];
  for (const kind of ['red', 'ok', 'empty']) {
    const file = join(root, kind, 'dispatch-policy.json');
    if (!existsSync(file)) { problems.push(`缺 ${kind}/dispatch-policy.json`); continue; }
    const r = inspectFile(file);
    if (kind === 'empty') {
      if (!r.unscanned) problems.push(`empty/ 应没查成但判成 ${JSON.stringify(r)}`);
      else kinds.empty += 1;
    } else if (kind === 'red') {
      if (r.unscanned || r.ok) problems.push(`red/ 自称该红但判成 ${JSON.stringify(r)}`);
      else kinds.red += 1;
    } else {
      if (r.unscanned || !r.ok) problems.push(`ok/ 自称该绿但判成 ${JSON.stringify(r)}`);
      else kinds.ok += 1;
    }
  }
  if (kinds.red === 0 || kinds.ok === 0 || kinds.empty === 0) {
    return { ok: false, unscanned: true, error: `样本种类不够 red=${kinds.red} ok=${kinds.ok} empty=${kinds.empty}`, kinds, problems };
  }
  if (problems.length) return { ok: false, unscanned: false, error: problems[0], kinds, problems };
  return { ok: true, unscanned: false, kinds };
}
