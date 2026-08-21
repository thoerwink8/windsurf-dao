// scripts/lib/model-routing-json.mjs —— 选型真相源 JSON（职责树）
//
// 2026-08-22 拍板：算法每次读工作区 docs/model-routing.json，本地改即生效。
// TOML 只留 [providers.*].launch；禁止 JSON↔TOML 双写选型段。

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertCrossVendor } from './reviewer-vendor-gate.mjs';

export const ROUTING_JSON = join(resolve(import.meta.dirname, '..', '..'), 'docs', 'model-routing.json');
export const DUTIES = ['帅', '工人', '审官'];

export function loadRoutingJsonRaw(file = ROUTING_JSON) {
  if (!existsSync(file)) throw new Error(`选型 JSON 不在: ${file}`);
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`选型 JSON 不是合法 JSON: ${String(e.message || e).split(/\r?\n/)[0]}`);
  }
  if (!doc || typeof doc !== 'object') throw new Error('选型 JSON 解析结果不是对象');
  return doc;
}

export function sortByRank(entries) {
  return [...entries].sort((a, b) => {
    const ra = a.顺位 == null ? Infinity : Number(a.顺位);
    const rb = b.顺位 == null ? Infinity : Number(b.顺位);
    return ra - rb || String(a.id).localeCompare(String(b.id));
  });
}

export function pickEnabledVendor(vendors) {
  return sortByRank((vendors || []).filter(v => v && v.禁用 !== true))[0] || null;
}

function pipeFromVendor(v) {
  if (!v || !v.id) return null;
  const out = { provider: String(v.id) };
  if (v.cli_model != null && String(v.cli_model) !== '') out.cli_model = String(v.cli_model);
  return out;
}

function mergeVendors(a, b) {
  const byId = new Map();
  for (const v of [...(a || []), ...(b || [])]) {
    if (!v?.id) continue;
    const prev = byId.get(v.id);
    byId.set(v.id, prev ? { ...prev, ...v, 顺位: v.顺位 ?? prev.顺位 } : { ...v });
  }
  return sortByRank([...byId.values()]);
}

export function dutyForIdentity(identity, workType) {
  if (identity === '审官' || workType === '审查') return '审官';
  if (identity === '帅' || identity === '协调者') return '帅';
  if (identity === '工人') return '工人';
  return null;
}

export function rankListFromTree(doc, duty, workType) {
  const list = doc?.[duty]?.[workType]?.模型;
  if (!Array.isArray(list)) return [];
  return sortByRank(list.filter(m => m && m.id && m.禁用 !== true));
}

export function rankOrderFromTree(doc, duty, workType) {
  return rankListFromTree(doc, duty, workType).map(m => String(m.id));
}

export function rankOrderFor(doc, identity, workType) {
  const duty = dutyForIdentity(identity, workType);
  if (!duty) return [];
  return rankOrderFromTree(doc, duty, workType);
}

export function reviewerSelectOrder(doc) {
  return rankOrderFromTree(doc, '审官', '审查');
}

function toLegacyModel(entry, roles) {
  const vendors = entry.厂商 || [];
  const primary = pickEnabledVendor(vendors) || vendors[0];
  const pipes = vendors.map(pipeFromVendor).filter(Boolean);
  const legacy = {
    id: entry.id,
    provider: primary?.id ? String(primary.id) : (pipes[0]?.provider || ''),
    roles,
    status: entry.status || '',
    why: entry.理由 || '',
    decided: entry.拍板 || '',
    reviewerDisabled: entry.禁用 === true,
  };
  if (primary?.cli_model) legacy.cli_model = String(primary.cli_model);
  if (pipes.length > 1) legacy.pipes = pipes;
  else if (pipes.length === 1 && pipes[0].cli_model) legacy.cli_model = pipes[0].cli_model;
  if (entry.trial_since) legacy.trial_since = entry.trial_since;
  return legacy;
}

/** 从职责树合并模型登记（供 pipes / 同厂闸 / yml 同源校验）。 */
export function modelsFromJson(doc) {
  const byId = new Map();
  const rolesById = new Map();
  for (const duty of DUTIES) {
    const workTypes = doc?.[duty];
    if (!workTypes || typeof workTypes !== 'object') continue;
    for (const [workType, cfg] of Object.entries(workTypes)) {
      for (const m of Array.isArray(cfg?.模型) ? cfg.模型 : []) {
        if (!m?.id) continue;
        const id = String(m.id);
        if (!rolesById.has(id)) rolesById.set(id, new Set());
        rolesById.get(id).add(workType);
        const prev = byId.get(id);
        byId.set(id, {
          id,
          厂商: mergeVendors(prev?.厂商, m.厂商),
          status: m.status || prev?.status || '正式',
          理由: m.理由 || prev?.理由 || '',
          拍板: m.拍板 || prev?.拍板 || '',
          trial_since: m.trial_since || prev?.trial_since,
          禁用: m.禁用 === true || prev?.禁用 === true,
        });
      }
    }
  }
  return [...byId.values()].map(entry => toLegacyModel(entry, [...(rolesById.get(entry.id) || [])]));
}

/** @deprecated 顺位树取代分时路由；保留导出名供旧调用方，恒返回 []。 */
export function routesFromJson(_doc) {
  return [];
}

export function bansFromJson(doc) {
  const raw = Array.isArray(doc?.禁令) ? doc.禁令 : [];
  const legacy = [];
  const policy = [];
  for (const b of raw) {
    if (!b) continue;
    const models = Array.isArray(b.模型) ? b.模型 : [];
    const workTypes = Array.isArray(b.工种) ? b.工种 : null;
    const scopeParts = [];
    if (models.length === 1) scopeParts.push(models[0]);
    else if (models.length > 1) scopeParts.push(models.join('/'));
    if (workTypes?.length) scopeParts.push(...workTypes);
    legacy.push({
      scope: scopeParts.join(' ') || b.id || '未命名禁令',
      why: b.理由 || '',
      decided: b.拍板 || '',
      precedence: b.优先级 || undefined,
    });
    policy.push({
      id: b.id || scopeParts.join('-') || 'ban',
      models,
      work_types: workTypes,
      identities: Array.isArray(b.身份) ? b.身份 : null,
      precedence: b.优先级 || undefined,
      why: b.理由 || '',
      decided: b.拍板 || '',
    });
  }
  return { legacy, policy };
}

export function rulesFromJson(doc) {
  return (Array.isArray(doc?.规则) ? doc.规则 : []).map(r => ({
    rule: r.名称 || r.rule || '',
    why: r.理由 || r.why || '',
    decided: r.拍板 || r.decided || '',
    constraint: r.约束 || r.constraint || undefined,
  })).filter(r => r.rule);
}

function isPolicyBanned(modelId, workType, identity, policyBans) {
  return (policyBans || []).some(b =>
    (b.models || []).includes(modelId)
    && (!b.work_types || b.work_types.length === 0 || b.work_types.includes(workType))
    && (!b.identities || b.identities.length === 0 || b.identities.includes(identity)),
  );
}

/**
 * 从职责树按顺位取 A 位（跳过禁用；可选门闩 passerIds；审官可过同厂硬闸）。
 */
export function pickRankedSlotA({
  doc,
  duty,
  workType,
  passerIds = null,
  workerId = null,
  models = [],
  policyBans = [],
  identity = null,
} = {}) {
  const list = doc?.[duty]?.[workType]?.模型;
  if (!Array.isArray(list)) return { model: null, reason: 'no_rank_list' };

  for (const m of sortByRank(list)) {
    if (!m?.id || m.禁用 === true) continue;
    const id = String(m.id);
    if (identity && isPolicyBanned(id, workType, identity, policyBans)) continue;
    if (passerIds && !passerIds.includes(id)) continue;
    const vendor = pickEnabledVendor(m.厂商);
    if (!vendor) continue;

    if (workerId != null && String(workerId).trim() !== '' && duty === '审官') {
      const gate = assertCrossVendor({ workerId, reviewerId: id, models });
      if (gate.state === 'same_vendor') {
        return { model: null, reason: 'same_vendor_blocked', error: gate.error };
      }
    }

    return {
      model: id,
      provider: String(vendor.id),
      cli_model: vendor.cli_model != null ? String(vendor.cli_model) : undefined,
      reason: duty === '审官' ? 'reviewer_order' : 'rank_order',
      vendor,
    };
  }
  return { model: null, reason: 'no_candidate' };
}

export function loadRoutingPolicy(file = ROUTING_JSON) {
  const raw = loadRoutingJsonRaw(file);
  const models = modelsFromJson(raw);
  const { legacy: bans, policy: policyBans } = bansFromJson(raw);
  const rules = rulesFromJson(raw);
  const tree = { 帅: raw.帅, 工人: raw.工人, 审官: raw.审官 };

  let dutyModelCount = 0;
  for (const duty of DUTIES) {
    for (const cfg of Object.values(raw?.[duty] || {})) {
      if (Array.isArray(cfg?.模型)) dutyModelCount += cfg.模型.length;
    }
  }

  if (models.length === 0 && dutyModelCount === 0 && bans.length === 0 && rules.length === 0) {
    throw new Error('选型 JSON 里职责树/禁令/规则都没扫到——0 条 = 本次等于没查');
  }

  return {
    updated: raw.updated || null,
    models,
    routes: [],
    bans,
    rules,
    policyBans,
    reviewerOrder: reviewerSelectOrder(raw),
    tree,
    raw,
    rankOrderFor(identity, workType) {
      return rankOrderFor(raw, identity, workType);
    },
    pickRanked(identity, workType, opts = {}) {
      const duty = dutyForIdentity(identity, workType);
      if (!duty) return { model: null, reason: 'no_duty' };
      return pickRankedSlotA({
        doc: raw,
        duty,
        workType,
        identity,
        models,
        policyBans,
        ...opts,
      });
    },
  };
}
