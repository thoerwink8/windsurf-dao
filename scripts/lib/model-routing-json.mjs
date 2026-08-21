// scripts/lib/model-routing-json.mjs —— 选型真相源 JSON 加载与 legacy 转换
//
// 2026-08-22 拍板：用户自维护 docs/model-routing.json，读工作区本地文件即生效。
// 启动模板仍在 docs/model-routing.toml [providers.*]。

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROUTING_JSON = join(resolve(import.meta.dirname, '..', '..'), 'docs', 'model-routing.json');

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

function pipeFromVendor(v) {
  if (!v || !v.id) return null;
  const out = { provider: String(v.id) };
  if (v.cli_model != null && String(v.cli_model) !== '') out.cli_model = String(v.cli_model);
  return out;
}

export function modelsFromJson(doc) {
  const registry = doc?.模型;
  if (!registry || typeof registry !== 'object') return [];
  const out = [];
  for (const [id, entry] of Object.entries(registry)) {
    if (!entry || typeof entry !== 'object') continue;
    const vendors = Array.isArray(entry.厂商) ? entry.厂商 : [];
    const pipes = vendors.map(pipeFromVendor).filter(Boolean);
    const p0 = pipes[0] || {};
    const legacy = {
      id,
      provider: p0.provider || '',
      roles: Array.isArray(entry.roles) ? entry.roles : [],
      status: entry.status || '',
      why: entry.理由 || entry.why || '',
      decided: entry.拍板 || entry.decided || '',
      reviewerDisabled: entry.禁用 === true,
    };
    if (p0.cli_model) legacy.cli_model = p0.cli_model;
    if (pipes.length > 1) legacy.pipes = pipes;
    else if (pipes.length === 1 && pipes[0].cli_model) legacy.cli_model = pipes[0].cli_model;
    if (entry.trial_since) legacy.trial_since = entry.trial_since;
    out.push(legacy);
  }
  return out;
}

export function routesFromJson(doc) {
  const duties = doc?.职责;
  if (!duties || typeof duties !== 'object') return [];
  const routes = [];
  for (const workTypes of Object.values(duties)) {
    if (!workTypes || typeof workTypes !== 'object') continue;
    for (const [workType, cfg] of Object.entries(workTypes)) {
      for (const r of Array.isArray(cfg?.分时路由) ? cfg.分时路由 : []) {
        if (!r || !r.模型) continue;
        routes.push({
          role: workType,
          beijing: r.北京时间,
          model: r.模型,
          fallback: r.fallback,
          why: r.理由 || '',
          decided: r.拍板 || '',
        });
      }
    }
  }
  return routes;
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

export function reviewerSelectOrder(doc) {
  const slots = doc?.职责?.审官?.审查?.选型序;
  if (!Array.isArray(slots)) return [];
  const ordered = [];
  for (const slot of slots) {
    if (!slot || typeof slot !== 'object' || slot.禁用 === true) continue;
    if (slot.模型) ordered.push(String(slot.模型));
  }
  return ordered;
}

export function loadRoutingPolicy(file = ROUTING_JSON) {
  const raw = loadRoutingJsonRaw(file);
  const models = modelsFromJson(raw);
  const routes = routesFromJson(raw);
  const { legacy: bans, policy: policyBans } = bansFromJson(raw);
  const rules = rulesFromJson(raw);
  if (models.length === 0 && routes.length === 0 && bans.length === 0 && rules.length === 0) {
    throw new Error('选型 JSON 里模型/路由/禁令/规则都没扫到——0 条 = 本次等于没查');
  }
  return {
    updated: raw.updated || null,
    models,
    routes,
    bans,
    rules,
    policyBans,
    reviewerOrder: reviewerSelectOrder(raw),
    raw,
  };
}
