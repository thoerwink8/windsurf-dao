// scripts/lib/leg-choice.mjs —— 腿表选择：从统一执行目录为角色生成候选与推荐（#816）。
//
// 谁提的：用户 2026-09-18「以前是模型推荐算法，现状其实还是推荐，但希望可以手动 ask 和
// 自动推荐，然后推荐列表优化」。场景：fleet 起任务时按角色（lead/executor/reviewer）选
// 执行档——选错一条腿的代价是整轮真跑（几十分钟）白烧，选型必须可见、可解释、可复核。
//
// 判据顺序（与 #816 拍板一致，不藏私货）：
//   ① 能力是否满足（目录角色命中强度 + 要求能力的验证强度）
//   ② 可用性（熔断 → 健康 → 并发余量）
//   ③ 成本（订阅 → 按量 → 未知）
//   ④ 历史真实成功率（执行记录里的真实终态；样本不足按未知）
//
// 两条硬边界：
//   · 淘汰的候选**留在列表里并带原因**——不许静默消失（用户明确要求）。
//   · 跨厂约束在候选生成阶段淘汰（excludeFamilies），不是事后拒绝。
//
// 本模块是纯函数：目录/健康/熔断/并发/历史全部由调用方注入；不读盘、不看时钟、不联网。
// 读盘的活儿在 loadLegChoiceData（best-effort；缺哪个源就注哪个 note，不猜）。

import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { loadHealthTable, loadBreaker, probeTargetForModel } from './provider-health.mjs';

const STRENGTH = Object.freeze({ verified: 0, declared: 1 });

/** fleet 角色 → 目录角色与要求能力。目录角色按序：先命中者算更强（review 强于 review-low-risk）。 */
export const ROLE_REQUIREMENTS = Object.freeze({
  lead: Object.freeze({ directoryRoles: Object.freeze(['architecture']), capabilities: Object.freeze(['read']) }),
  executor: Object.freeze({ directoryRoles: Object.freeze(['implementation']), capabilities: Object.freeze(['write', 'execute']) }),
  reviewer: Object.freeze({ directoryRoles: Object.freeze(['review', 'review-low-risk']), capabilities: Object.freeze(['read']) }),
});

const familyOf = profile => {
  const family = String(profile?.modelFamily || profile?.provider || '').trim().toLowerCase();
  return family || null;
};

/** 默认探针键：与健康表/熔断表同一把尺（probeTargetForModel），profile 认不出落地时返回 null。 */
export function defaultProbeKeyOf(profile) {
  try {
    return probeTargetForModel({ pipes: [{ provider: profile.provider, cli_model: profile.model }] });
  } catch {
    return null;
  }
}

function capabilityOf(profile, requirement) {
  const roles = Array.isArray(profile.roles) ? profile.roles : [];
  const roleMatch = requirement.directoryRoles.find(role => roles.includes(role)) || null;
  const caps = profile.capabilities && typeof profile.capabilities === 'object' ? profile.capabilities : {};
  const detail = {};
  const missing = [];
  let strength = 0;
  for (const name of requirement.capabilities) {
    const status = caps[name]?.status;
    detail[name] = status || 'missing';
    if (status === 'verified') continue;
    if (status === 'declared') { strength = Math.max(strength, STRENGTH.declared); continue; }
    missing.push(name);
  }
  return {
    ok: roleMatch !== null && missing.length === 0,
    roleMatch,
    roleRank: roleMatch ? requirement.directoryRoles.indexOf(roleMatch) : null,
    strength,
    detail,
    missing,
  };
}

function availabilityOf(profile, { health, breaker, headroom, probeKeyOf, now }) {
  const probeKey = probeKeyOf(profile);
  const breakerEntry = probeKey ? breaker?.targets?.[probeKey] : null;
  const breakerState = breakerEntry?.state ? String(breakerEntry.state) : null;
  const cooldownUntil = breakerEntry?.cooldownUntil ? Date.parse(breakerEntry.cooldownUntil) : null;
  // open 且冷却未到（或没有时钟可比）→ 直接拦（provider-health 的熔断语义：区别于健康红只后置）。
  const breakerOpen = breakerState === 'open' && !(Number.isFinite(cooldownUntil) && Number.isFinite(now) && cooldownUntil <= now);
  const breakerRank = breakerOpen ? 3 : breakerState === 'half-open' ? 1 : 0;
  const healthEntry = probeKey ? health?.targets?.[probeKey] : null;
  const healthState = healthEntry?.state ? String(healthEntry.state) : null;
  const healthRank = healthState === 'green' ? 0 : healthState === 'red' ? 2 : 1;
  const hr = headroom?.[profile.id] || null;
  const inFlight = Number.isFinite(hr?.inFlight) ? hr.inFlight : null;
  const cap = Number.isFinite(hr?.cap) ? hr.cap : null;
  let headroomRank = 1;
  let headroomWhy = '并发数据未登记';
  if (inFlight !== null && cap !== null) {
    headroomRank = inFlight >= cap ? 2 : 0;
    headroomWhy = inFlight >= cap ? `在途 ${inFlight}/${cap}（满员，起会话会被背压拒）` : `在途 ${inFlight}/${cap}`;
  } else if (inFlight !== null) {
    headroomWhy = `在途 ${inFlight}（上限未登记）`;
  }
  return { probeKey, breakerState, breakerOpen, breakerRank, cooldownUntil: breakerEntry?.cooldownUntil || null, healthState, healthRank, inFlight, cap, headroomRank, headroomWhy };
}

function costOf(profile) {
  const pool = String(profile.accountPoolId || '');
  if (/subscription/i.test(pool)) return { class: 'subscription', rank: 0, why: `订阅（${pool}）` };
  if (profile.pricing?.status === 'known') return { class: 'metered', rank: 1, why: '按量（目录里有价目）' };
  return { class: 'unknown', rank: 2, why: `成本未知（${pool || '未登记账号池'}）` };
}

function historyOf(profile, history) {
  const h = history?.[profile.id];
  const done = Number.isFinite(h?.done) ? h.done : 0;
  const failed = Number.isFinite(h?.failed) ? h.failed : 0;
  const sample = done + failed;
  if (sample < 1) return { known: false, rate: null, done, failed, sample, why: '历史样本不足' };
  return { known: true, rate: done / sample, done, failed, sample, why: `done ${done} / failed ${failed}（${Math.round((done / sample) * 100)}%）` };
}

/**
 * chooseLeg({ profiles, role, excludeFamilies, excludeIds, health, breaker, headroom, history, probeKeyOf, now })
 * → { role, recommended, candidates[], notes[], criteria[] }
 *
 * candidates：**全部**目录档（含被淘汰的），非淘汰按判据排序在前并带 rank（1 起），
 * 淘汰的留在后面带 eliminated{code,why}；任何一条都不静默消失。
 */
export function chooseLeg({
  profiles = [],
  role,
  excludeFamilies = [],
  excludeIds = [],
  health = null,
  breaker = null,
  headroom = null,
  history = null,
  probeKeyOf = defaultProbeKeyOf,
  now = null,
} = {}) {
  const requirement = ROLE_REQUIREMENTS[role];
  if (!requirement) throw new Error(`unknown role: ${role}`);
  const excludedFamilies = new Set(excludeFamilies.map(value => String(value).trim().toLowerCase()).filter(Boolean));
  const excludedIds = new Set(excludeIds.map(value => String(value)));
  const notes = [];
  if (health === null) notes.push('健康表没查成（unknown 不拦，只后置）');
  if (breaker === null) notes.push('熔断表缺失（视为无熔断）');
  if (headroom === null) notes.push('并发数据缺失（上限按未登记处理）');
  if (history === null) notes.push('历史数据缺失（成功率按未知处理）');

  const rows = [];
  for (const profile of profiles) {
    const id = String(profile.id || '');
    if (!id) continue;
    const family = familyOf(profile);
    const capability = capabilityOf(profile, requirement);
    const availability = availabilityOf(profile, { health, breaker, headroom, probeKeyOf, now });
    const cost = costOf(profile);
    const hist = historyOf(profile, history);
    let eliminated = null;
    const elim = (code, why) => { if (!eliminated) eliminated = { code, why }; };
    if (profile.enabled !== true) elim('disabled', '目录里未启用');
    else if (profile.availability?.status && profile.availability.status !== 'available') elim(`availability-${profile.availability.status}`, `目录可用性为 ${profile.availability.status}`);
    else if (profile.implicitSelection?.authorized === false) elim('implicit-selection-not-authorized', '目录声明不许被隐式选中');
    if (!eliminated && excludedIds.has(id)) elim('excluded-by-caller', '调用方显式排除');
    if (!eliminated && family && excludedFamilies.has(family)) elim('family-excluded', `同厂排除（family=${family}）`);
    if (!eliminated && !capability.ok) {
      if (capability.roleMatch === null) elim('role-missing', `目录角色不含 ${requirement.directoryRoles.join('/')}`);
      else elim('capability-missing', `能力未覆盖：${capability.missing.join('、')}`);
    }
    if (!eliminated && availability.breakerOpen) elim('breaker-open', `熔断 open${availability.cooldownUntil ? `（冷却至 ${availability.cooldownUntil}）` : ''}`);
    const reasons = [
      capability.ok
        ? `能力：${capability.roleMatch}；${requirement.capabilities.map(name => `${name}=${capability.detail[name]}`).join('、')}`
        : `能力不足：${capability.roleMatch === null ? '目录角色不符' : `缺 ${capability.missing.join('、')}`}`,
      `可用性：熔断 ${availability.breakerState || '无记录'}；健康 ${availability.healthState || '未查成'}；${availability.headroomWhy}`,
      `成本：${cost.why}`,
      `历史：${hist.why}`,
    ];
    rows.push({ profile, id, family, capability, availability, cost, history: hist, eliminated, reasons });
  }

  const rankOf = row => [
    row.capability.roleRank, row.capability.strength,
    row.availability.breakerRank, row.availability.healthRank, row.availability.headroomRank,
    row.cost.rank,
    row.history.known ? 0 : 1, row.history.known ? -row.history.rate : 0, -row.history.sample,
    row.id,
  ];
  const alive = rows.filter(row => !row.eliminated).sort((a, b) => {
    const ka = rankOf(a); const kb = rankOf(b);
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
  const dead = rows.filter(row => row.eliminated).sort((a, b) => a.id.localeCompare(b.id));
  const candidates = [...alive, ...dead].map((row, index) => ({
    id: row.id,
    agent: row.profile.agent || null,
    model: row.profile.model || null,
    backend: row.profile.backend || null,
    family: row.family,
    rank: row.eliminated ? null : index + 1,
    eliminated: row.eliminated,
    reasons: row.reasons,
    capability: { ok: row.capability.ok, roleMatch: row.capability.roleMatch, detail: row.capability.detail },
    availability: {
      health: row.availability.healthState,
      breaker: row.availability.breakerState,
      breakerOpen: row.availability.breakerOpen,
      inFlight: row.availability.inFlight,
      cap: row.availability.cap,
    },
    cost: { class: row.cost.class, why: row.cost.why },
    success: { known: row.history.known, rate: row.history.rate, done: row.history.done, failed: row.history.failed, sample: row.history.sample },
  }));
  return {
    role,
    recommended: alive.length ? alive[0].id : null,
    candidates,
    notes,
    criteria: ['能力（角色命中 + 验证强度）', '可用性（熔断 → 健康 → 并发余量）', '成本（订阅 → 按量 → 未知）', '历史真实成功率'],
  };
}

/** 人类可读的推荐列表（CLI 与飞书卡片共用同一份渲染，避免两处漂移）。 */
export function renderLegTable(result) {
  const lines = [];
  lines.push(`角色：${result.role}（目录角色 ${ROLE_REQUIREMENTS[result.role].directoryRoles.join('/')}；要求能力 ${ROLE_REQUIREMENTS[result.role].capabilities.join('、')}）`);
  lines.push(`推荐：${result.recommended || '（没有可用候选）'}`);
  for (const note of result.notes) lines.push(`注：${note}`);
  lines.push('');
  for (const item of result.candidates) {
    if (item.eliminated) {
      lines.push(`  ✗ ${item.id}（${item.family || '?'}）——淘汰：${item.eliminated.why}`);
    } else {
      const s = item.success.known ? `${Math.round(item.success.rate * 100)}%（${item.success.done}/${item.success.sample}）` : '样本不足';
      lines.push(`  ${item.rank}. ${item.id}（${item.family || '?'}）  成本=${item.cost.class}  历史=${s}  ${item.availability.inFlight !== null ? `在途=${item.availability.inFlight}${item.availability.cap !== null ? `/${item.availability.cap}` : ''}` : ''}`);
      lines.push(`     ${item.reasons.join('；')}`);
    }
  }
  return lines.join('\n');
}

/**
 * loadLegChoiceData({ home, root, now }) → { profiles, health, breaker, headroom, history, notes }
 * best-effort：每个源独立读、独立标注；读不到就注 note（不猜、不冒充查过）。
 * 历史与在途都来自执行记录（~/.dao/execution/sessions/*.json）：真实终态，不是模型自称。
 */
export function loadLegChoiceData({ home = os.homedir(), root = null, now = Date.now() } = {}) {
  const notes = [];
  let profiles = [];
  try {
    const file = root ? join(root, 'docs', 'execution-profiles.json') : new URL('../../docs/execution-profiles.json', import.meta.url);
    profiles = JSON.parse(readFileSync(file, 'utf8')).profiles || [];
  } catch (error) {
    notes.push(`执行目录读不到：${String(error?.message || error).slice(0, 120)}`);
  }
  let health = null;
  try {
    const loaded = loadHealthTable({ home, now });
    if (loaded.present && !loaded.unknown && loaded.table) health = { targets: loaded.table, updatedAt: loaded.updatedAt };
    else notes.push(loaded.reason || '健康表没查成');
  } catch (error) {
    notes.push(`健康表读失败：${String(error?.message || error).slice(0, 120)}`);
  }
  let breaker = null;
  try {
    const loaded = loadBreaker({ home });
    if (loaded.present && !loaded.unscanned) breaker = { targets: loaded.targets, updatedAt: loaded.updatedAt };
    else if (loaded.unscanned) notes.push(loaded.reason || '熔断表没查成');
  } catch (error) {
    notes.push(`熔断表读失败：${String(error?.message || error).slice(0, 120)}`);
  }
  const headroom = {};
  const history = {};
  let sessionsScanned = 0;
  try {
    const dir = join(home, '.dao', 'execution', 'sessions');
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      let record;
      try { record = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
      const id = String(record.profileId || '');
      if (!id) continue;
      sessionsScanned += 1;
      const state = String(record.state || '');
      const observed = String(record.observedState || '');
      if (['pending', 'running', 'streaming', 'active', 'waiting_user'].includes(state)) {
        headroom[id] = { inFlight: (headroom[id]?.inFlight || 0) + 1, cap: null };
      }
      const bucket = history[id] || { done: 0, failed: 0 };
      if (state === 'rejected' || state === 'gone' || state === 'incomplete') bucket.failed += 1;
      else if (state === 'stopped' && observed === 'done') bucket.done += 1;
      else if (state === 'stopped' && observed === 'failed') bucket.failed += 1;
      history[id] = bucket;
    }
    if (!sessionsScanned) notes.push('执行记录 0 条——历史与在途按未知处理');
  } catch (error) {
    notes.push(`执行记录读失败：${String(error?.message || error).slice(0, 120)}`);
  }
  return { profiles, health, breaker, headroom: Object.keys(headroom).length ? headroom : null, history: Object.keys(history).length ? history : null, notes };
}
