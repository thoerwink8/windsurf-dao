// scripts/lib/model-routing-json.mjs —— 选型真相源 JSON（职责树）
//
// 2026-08-22 拍板：算法每次读工作区 docs/model-routing.json，本地改即生效。
// TOML 只留 [providers.*].launch；禁止 JSON↔TOML 双写选型段。

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
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
  if (doc.执行体?.profileCatalog) {
    const root = resolve(dirname(file), '..');
    const catalogPath = resolve(root, doc.执行体.profileCatalog);
    if (!catalogPath.startsWith(root + sep)) throw new Error('execution profile catalog must stay inside repository');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    if (!Array.isArray(catalog.profiles)) throw new Error('execution profile catalog has no profiles[]');
    Object.defineProperty(doc, 'executionProfiles', { value: catalog.profiles, enumerable: false });
  }
  return doc;
}

export function sortByRank(entries) {
  return [...entries].sort((a, b) => {
    const ra = a.顺位 == null ? Infinity : Number(a.顺位);
    const rb = b.顺位 == null ? Infinity : Number(b.顺位);
    return ra - rb || String(a.id).localeCompare(String(b.id));
  });
}

function landingOf(entry) {
  if (!entry || entry.provider == null || String(entry.provider).trim() === '') return null;
  const out = { provider: String(entry.provider).trim() };
  if (entry.cli_model != null && String(entry.cli_model) !== '') out.cli_model = String(entry.cli_model);
  return out;
}

function mergeLanding(prev, next) {
  if (!prev) {
    return {
      id: next.id,
      provider: next.provider,
      cli_model: next.cli_model,
      status: next.status || '正式',
      理由: next.理由 || '',
      拍板: next.拍板 || '',
      trial_since: next.trial_since,
      禁用: next.禁用 === true,
    };
  }
  return {
    id: prev.id,
    provider: next.provider || prev.provider,
    cli_model: next.cli_model ?? prev.cli_model,
    status: next.status || prev.status || '正式',
    理由: next.理由 || prev.理由 || '',
    拍板: next.拍板 || prev.拍板 || '',
    trial_since: next.trial_since || prev.trial_since,
    禁用: next.禁用 === true || prev.禁用 === true,
  };
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

/**
 * 执行目录匹配：精确 profile id 优先；没有精确命中才查 `defaultForModels`。
 * `resolveExecutionProfile` 与 `usableReviewerOrder` 共用这一份，alias 与
 * profile id 同名是合法目录形状，不许判成含糊。
 */
export function matchExecutionProfiles(spec, profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  const requested = spec.profileId || spec.profile || (list.some((p) => p && p.id === spec.model) ? spec.model : null);
  const matches = requested
    ? list.filter((p) => p && p.id === requested)
    : list.filter((p) => p && Array.isArray(p.defaultForModels) && p.defaultForModels.includes(spec.model));
  return { requested, matches };
}

/**
 * 把「审官顺位」按**执行目录的实际可用性**过一遍（#1233）。
 *
 * 病（2026-09-13 实咬）：顺位表和执行目录是两条真相源，谁也不问谁。审官序第 2 位
 * 是 `gpt-5.6-sol`，而 `docs/execution-profiles.json` 里那条 `availability.status`
 * 是 `unverified`——`resolveExecutionProfile` 照设计直接拒。于是每张按顺位选了 sol 的
 * 复审票，drain 必然失败，试满 3 次打「卡死/自动化认输」。**判绿可合的 PR 被推成卡死**，
 * 而认输评论只写「试了 3 次仍没推动」，真因埋在 drain 的返回值里没人看见。
 *
 * 所以这里做两件事，缺一不可：
 *   1. 顺位里**起不来的剔除**（usable）——与 `resolveExecutionProfile` 同一套完整准入
 *      （enabled、availability、backend∈{mirasim,acp}、agent、model；缺字段 / 非法 backend
 *      一律剔除，否则选出的腿执行器当场抛 invalid execution profile）；
 *   2. 剔了谁、为什么剔，**原样报出来**（`skipped`）——静默跳过会让下一个「选了必死的
 *      模型」继续以别的面目复发。
 *
 * 底线：全序都起不来时 `usable` 为空且 `allDead`，调用方**必须报「一个能起的审官都没有」**，
 * 不许退回到「那就用第一个」——那正是今天这场实咬。
 *
 * 没读到执行目录时**不剔任何人**（没有依据），但 `unscanned` 要说出来——「没读到」和
 * 「读到了、全都可用」必须分得开。
 *
 * 2026-09-17 再补一层（#1342）：**问熔断器**。顺位只问执行目录的静态可用性，而一条腿可以
 * 目录里 available、真实 turn 成功率 25%（relay 那天）。判红名单由调用方用 model-admission
 * 的 healthRedIds 算好传进来（同一个判据，不在这里再抄一份）；没传 = 不据此剔（没依据）。
 *
 * @param {string[]} order 审官顺位（reviewerSelectOrder 的输出）
 * @param {{profiles?: Array, redIds?: Iterable<string>}} opts profiles 来自 loadExecutionProfiles()；redIds 来自 healthRedIds()
 * @returns {{usable: string[], skipped: Array<{id: string, why: string}>, allDead: boolean, unscanned?: string}}
 */
export function usableReviewerOrder(order, { profiles, redIds } = {}) {
  const list = Array.isArray(order) ? order.map(String) : [];
  const catalog = Array.isArray(profiles) ? profiles : null;
  if (!catalog) return { usable: list, skipped: [], allDead: false, unscanned: '执行目录没读到（没查成：不据此剔除任何顺位）' };
  const red = redIds ? new Set([...redIds].map(String)) : null;
  const usable = [];
  const skipped = [];
  for (const id of list) {
    const { matches } = matchExecutionProfiles({ model: id }, catalog);
    if (matches.length === 0) { skipped.push({ id, why: '执行目录里没有这个模型的 profile' }); continue; }
    if (matches.length > 1) { skipped.push({ id, why: `执行目录里匹配到 ${matches.length} 条 profile，含糊` }); continue; }
    const p = matches[0];
    if (p.enabled !== true) { skipped.push({ id, why: `profile ${p.id} 未启用` }); continue; }
    // 与 resolveExecutionProfile 同一套完整准入：enabled / availability 之外，
    // 执行器还要合法 backend∈{mirasim,acp} 且 agent、model 都在。缺任何一项
    // 执行器抛 invalid execution profile，这里放行就会选出一条起不来的腿。
    if (!['mirasim', 'acp'].includes(p.backend) || !p.agent || !p.model) {
      skipped.push({ id, why: `profile ${p.id} 缺少合法 backend/agent/model` });
      continue;
    }
    const availability = typeof p.availability === 'string' ? p.availability : p.availability?.status;
    if (availability && availability !== 'available') {
      skipped.push({ id, why: `profile ${p.id} 的 availability=${availability}` });
      continue;
    }
    usable.push(id);
  }
  // 第二层：健康表/熔断器判红（#1342）。只对**目录里起得来**的那些判——目录停用/未验的
  // 已经在上面剔了，不算进「全红」的分母。
  //
  // 全红即旁路（Portkey circuit breaker 的「all targets OPEN → bypass」）：判红名单会把起得来的
  // 顺位剔空时**不剔**，但把这件事说出来。理由：一条 25% 成功率的腿比「没有审官」强——盘面
  // 冻住是 2026-09-17 花一天解掉的病，不许由这层再造一次；重试预算（3 次 + 判据版本）在给浪费兜底。
  // 只剔到剩一个不算全红——剩那个就派。
  let breakerBypassed;
  if (red && red.size > 0 && usable.length > 0) {
    const notRed = usable.filter((id) => !red.has(id));
    if (notRed.length === 0) {
      breakerBypassed = `审官顺位 ${usable.join('/')} 全部被健康表/熔断器判红——全红即旁路，照顺位派，不让盘面因为没审官冻住`;
    } else {
      for (const id of usable) {
        if (red.has(id)) skipped.push({ id, why: '健康表/熔断器判红（真实 turn 失败率或探针红），本轮不派它当审官' });
      }
      usable.splice(0, usable.length, ...notRed);
    }
  }
  return {
    usable, skipped, allDead: usable.length === 0 && list.length > 0,
    ...(breakerBypassed ? { breakerBypassed } : {}),
  };
}

/**
 * 生产容量换人用的候选顺位。
 *
 * 与默认选型同一把尺（#1233）：执行目录读得到就只用 `usable`；
 * 没读到（`unscanned`）不剔。`usable` 为空 = 一个能起的都没有，返回 `[]`，
 * 调用方必须显式失败，不许退回 `unverified` 席位去 `resolveExecutionProfile`。
 *
 * 策略顺位纯函数（`nextReviewerAfter` / `planReviewerOnCapacityDeath`）仍认全表；
 * 过滤只发生在生产接线把候选池塞进换人凭证的那一步。
 */
export function orderForCapacityFailover(policyOrder, { profiles } = {}) {
  const list = Array.isArray(policyOrder) ? policyOrder.map(String) : [];
  const r = usableReviewerOrder(list, { profiles });
  if (r.unscanned) return list;
  return r.usable;
}

function toLegacyModel(entry, roles) {
  const landing = landingOf(entry);
  const legacy = {
    id: entry.id,
    provider: landing?.provider || '',
    roles,
    status: entry.status || '',
    why: entry.理由 || '',
    decided: entry.拍板 || '',
    reviewerDisabled: entry.禁用 === true,
  };
  if (landing?.cli_model) legacy.cli_model = landing.cli_model;
  if (entry.trial_since) legacy.trial_since = entry.trial_since;
  return legacy;
}

/** 从职责树合并模型登记（供同厂闸 / yml 同源校验）。落地方式是单值 provider + cli_model。 */
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
        byId.set(id, mergeLanding(byId.get(id), { ...m, id }));
      }
    }
  }
  const models = [...byId.values()].map(entry => toLegacyModel(entry, [...(rolesById.get(entry.id) || [])]));
  const roleNames = { companion: '查证', implementation: '写码', architecture: '方案', review: '审查', 'review-low-risk': '审查' };
  for (const p of doc.executionProfiles || []) {
    if (!p?.id || !p.model || models.some(m => m.id === p.id)) continue;
    models.push({ id: p.id, provider: p.provider, cli_model: p.agentModel || p.model,
      roles: [...new Set((p.roles || []).map(r => roleNames[r]).filter(Boolean))], status: p.enabled ? '正式' : '停用',
      why: '统一执行目录', reviewerDisabled: !p.enabled, executionProfileId: p.id, actualModel: p.model, modelFamily: p.modelFamily });
  }
  return models;
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
    const landing = landingOf(m);
    if (!landing) continue;

    if (workerId != null && String(workerId).trim() !== '' && duty === '审官') {
      const gate = assertCrossVendor({ workerId, reviewerId: id, models });
      if (gate.state === 'same_vendor') {
        return { model: null, reason: 'same_vendor_blocked', error: gate.error };
      }
    }

    return {
      model: id,
      provider: landing.provider,
      cli_model: landing.cli_model,
      reason: duty === '审官' ? 'reviewer_order' : 'rank_order',
      vendor: { id: landing.provider, cli_model: landing.cli_model },
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
