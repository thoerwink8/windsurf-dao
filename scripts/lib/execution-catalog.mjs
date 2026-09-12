import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NATIVE_LOGIN_FILES } from './provider-probe.mjs';

export const DEFAULT_CATALOG_PATH = fileURLToPath(new URL('../../docs/execution-profiles.json', import.meta.url));
const HOUR = 3_600_000;
const TIERS = { unknown: 0, basic: 1, standard: 2, strong: 3 };
const ROLES = {
  companion: { tier: 'basic', capabilities: ['read'] },
  'review-low-risk': { tier: 'standard', capabilities: ['read', 'review'], independent: true },
  implementation: { tier: 'standard', capabilities: ['read', 'write', 'test'] },
  architecture: { tier: 'strong', capabilities: ['read', 'architecture'], independent: true },
  review: { tier: 'strong', capabilities: ['read', 'review'], independent: true },
};
const STATES = ['available', 'unverified', 'unavailable', 'auth_required', 'unknown', 'stale'];
const idString = value => typeof value === 'string' && value.length > 0 && value.length <= 240;
const finitePrice = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const has = (obj, key) => Object.hasOwn(obj, key);
const time = value => typeof value === 'number' ? value : Date.parse(value);
const iso = now => new Date(time(now)).toISOString();

/** Model developer family, never the billing reseller. Unknown/Auto stays unknown. */
export function modelFamily(model) {
  const id = String(model ?? '').toLowerCase().replace(/^cursor-/, '').split('[')[0];
  const tail = id.split('/').at(-1);
  if (/^gpt(?:-|\d)|^o[134](?:-|$)/.test(tail)) return 'openai';
  if (/^claude(?:-|$)/.test(tail)) return 'anthropic';
  if (/^grok(?:-|$)/.test(tail)) return 'xai';
  if (/^deepseek(?:-|$)/.test(tail)) return 'deepseek';
  if (/^glm(?:-|$)/.test(tail)) return 'zai';
  if (/^kimi(?:-|$)/.test(tail)) return 'moonshot';
  if (/^gemini(?:-|$)/.test(tail)) return 'google';
  if (/^(llama|muse-spark)(?:-|$)/.test(tail)) return 'meta';
  if (/^composer(?:-|$)/.test(tail)) return 'cursor';
  if (/^qwen/.test(tail)) return 'alibaba';
  if (/^minimax(?:-|$)/.test(tail)) return 'minimax';
  if (/^swe(?:-|$)/.test(tail)) return 'cognition';
  return 'unknown';
}

/** Invalid/missing/future timestamps never acquire freshness from a new catalog.updatedAt. */
export function freshness(checkedAt, { now = Date.now(), maxAgeHours = 24 } = {}) {
  const ageMs = time(now) - time(checkedAt);
  const valid = Number.isFinite(ageMs) && ageMs >= 0 && Number.isFinite(maxAgeHours) && maxAgeHours > 0;
  return { status: !valid ? 'unknown' : ageMs > maxAgeHours * HOUR ? 'stale' : 'fresh', ageMs: valid ? ageMs : null };
}

export function unknownPricing(reason = 'not_published') {
  return { status: 'unknown', currency: null, unit: null, inputPerMillion: null, outputPerMillion: null, cacheReadPerMillion: null, sourceId: null, checkedAt: null, reason };
}

export function validateCatalog(catalog) {
  const errors = [];
  if (catalog?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  for (const key of ['providers', 'accountPools', 'sources', 'profiles', 'snapshots']) {
    if (!Array.isArray(catalog?.[key])) errors.push(`${key} must be an array`);
  }
  if (errors.length) return { ok: false, errors };
  const unique = key => {
    const ids = new Set();
    for (const entry of catalog[key]) {
      if (!entry || !idString(entry.id) || ids.has(entry.id)) errors.push(`${key}: missing/duplicate id`);
      ids.add(entry?.id);
    }
    return ids;
  };
  const providers = unique('providers'), pools = unique('accountPools'), sources = unique('sources');
  unique('profiles');
  const aliases = new Set();
  for (const p of catalog.profiles) {
    if (!p) continue;
    if (!['mirasim', 'acp'].includes(p.backend)) errors.push(`${p.id}: backend`);
    if (!idString(p.agent) || !(p.model === null || idString(p.model))) errors.push(`${p.id}: agent/model`);
    if (!['local', 'cloud', 'auto'].includes(p.route)) errors.push(`${p.id}: route`);
    if (p.backend === 'acp' && p.route !== 'local') errors.push(`${p.id}: ACP must use local route`);
    if (!providers.has(p.provider) || !pools.has(p.accountPoolId)) errors.push(`${p.id}: provider/accountPoolId reference`);
    const provider = catalog.providers.find(v => v.id === p.provider);
    if (provider?.kind === 'relay' && (p.backend !== 'mirasim' || p.route !== 'cloud')) errors.push(`${p.id}: relay requires Mirasim cloud`);
    if (!Array.isArray(p.roles) || p.roles.some(r => !has(ROLES, r))) errors.push(`${p.id}: roles`);
    if (typeof p.enabled !== 'boolean' || !STATES.includes(p.availability?.status)) errors.push(`${p.id}: enabled/availability`);
    if (!p.pricing || !['known', 'reference', 'unknown'].includes(p.pricing.status)) errors.push(`${p.id}: pricing`);
    if (p.quality && !has(TIERS, p.quality.tier)) errors.push(`${p.id}: quality tier`);
    if (p.defaultForModels !== undefined && !Array.isArray(p.defaultForModels)) errors.push(`${p.id}: defaultForModels`);
    for (const alias of Array.isArray(p.defaultForModels) ? p.defaultForModels : []) {
      if (!idString(alias) || aliases.has(alias)) errors.push(`${p.id}: missing/ambiguous default model alias`);
      aliases.add(alias);
      if (p.route === 'auto' || !p.implicitSelection?.authorized || p.implicitSelection?.fallback !== 'none') errors.push(`${p.id}: implicit selection must pin billing route`);
    }
    if (p.modelSourceId && !sources.has(p.modelSourceId)) errors.push(`${p.id}: modelSourceId`);
    if (p.pricingSourceId && !sources.has(p.pricingSourceId)) errors.push(`${p.id}: pricingSourceId`);
    // A reseller cannot be supplied as an invented independent family for a known model.
    if (modelFamily(p.model) !== 'unknown' && p.modelFamily !== modelFamily(p.model)) errors.push(`${p.id}: modelFamily mismatch`);
  }
  for (const s of catalog.sources) {
    if (!s) continue;
    if (!['openai-models', 'models-dev', 'evidence'].includes(s.kind)) errors.push(`${s.id}: source kind`);
    if (s.provider && !providers.has(s.provider)) errors.push(`${s.id}: source provider`);
    if (s.credential && !['newapi-group', 'provider-key'].includes(s.credential.kind)) errors.push(`${s.id}: credential kind`);
    if (s.access === 'gateway-group' && s.credential?.kind !== 'newapi-group') errors.push(`${s.id}: group credential required`);
    if (s.access === 'direct' && s.credential?.kind === 'newapi-group') errors.push(`${s.id}: group key cannot become provider key`);
  }
  for (const snapshot of catalog.snapshots) {
    if (!snapshot || !sources.has(snapshot.sourceId) || !Array.isArray(snapshot.models) || snapshot.models.some(m => !m || !idString(m.id))) errors.push('invalid snapshot');
  }
  return { ok: !errors.length, errors };
}

export function loadExecutionCatalog(file = DEFAULT_CATALOG_PATH) {
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  const valid = validateCatalog(catalog);
  if (!valid.ok) throw new Error(`Invalid execution catalog: ${valid.errors.join('; ')}`);
  return catalog;
}

/** Only a complete, fresh, comparable price is cost-rankable. Subscription/reference != free. */
export function estimateProfileCost(profile, task = {}, { now = Date.now(), maxAgeHours = 24 } = {}) {
  const p = profile.pricing;
  const unknown = reason => ({ status: 'unknown', amount: null, currency: null, reason });
  if (p?.status !== 'known') return unknown(p?.status === 'reference' ? 'reference_not_account_price' : 'price_unknown');
  if (freshness(p.checkedAt, { now, maxAgeHours }).status !== 'fresh') return unknown('price_stale');
  if (p.unit !== 'per_million_tokens' || p.currency !== 'USD' || !idString(p.sourceId)) return unknown('price_not_comparable');
  if (!finitePrice(p.inputPerMillion) || !finitePrice(p.outputPerMillion)) return unknown('price_incomplete');
  const input = task.inputTokens ?? 10_000, output = task.outputTokens ?? 2_000;
  if (!finitePrice(input) || !finitePrice(output)) return unknown('invalid_token_estimate');
  return { status: 'estimated', amount: (input * p.inputPerMillion + output * p.outputPerMillion) / 1e6, currency: 'USD', reason: 'uncached_token_estimate' };
}

function requirements(role, task) {
  const base = has(ROLES, role) ? ROLES[role] : null;
  if (!base) return null;
  const strong = task.risk === 'high' || task.kind === 'architecture' || task.type === 'architecture';
  const tier = Math.max(TIERS[base.tier], strong ? TIERS.strong : 0, TIERS[task.minQuality] ?? 0);
  return { tier, capabilities: [...new Set([...base.capabilities, ...(strong ? ['architecture'] : []), ...(task.requiredCapabilities ?? [])])], independent: !!base.independent || !!task.independentReview };
}

/** Pure selection: no health probes, credential reads, routing writes or network. */
export function selectExecutionProfile(catalog, { role = 'implementation', task = {}, authorProfileId, authorFamily, excludeProfileIds = [], allowedProfileIds, allowUnknownPrice = false, now = Date.now() } = {}) {
  const valid = validateCatalog(catalog);
  const blocked = (reason, rejected = []) => ({ status: 'blocked', reason, profile: null, ranked: [], rejected });
  if (!valid.ok) return blocked('invalid_catalog', valid.errors);
  if (!task || typeof task !== 'object' || Array.isArray(task) || (task.minQuality !== undefined && !has(TIERS, task.minQuality)) || (task.requiredCapabilities !== undefined && !Array.isArray(task.requiredCapabilities))) return blocked('invalid_requirements');
  for (const field of ['inputTokens', 'outputTokens', 'maxCostUsd']) if (task[field] !== undefined && !finitePrice(task[field])) return blocked('invalid_requirements');
  const req = requirements(role, task);
  if (!req || !Array.isArray(excludeProfileIds) || (allowedProfileIds !== undefined && !Array.isArray(allowedProfileIds))) return blocked('invalid_requirements');
  const author = catalog.profiles.find(p => p.id === authorProfileId);
  const writerFamily = author ? author.modelFamily : authorFamily;
  const maxAgeHours = catalog.freshness?.maxAgeHours ?? 24;
  const priceAge = catalog.freshness?.priceMaxAgeHours ?? 24;
  const ranked = [], rejected = [];
  for (const p of catalog.profiles) {
    const reasons = [];
    if (!p.enabled) reasons.push('disabled');
    if (allowedProfileIds && !allowedProfileIds.includes(p.id)) reasons.push('outside_authorized_profiles');
    if (excludeProfileIds.includes(p.id)) reasons.push('excluded');
    if (!p.roles.includes(role)) reasons.push('role_not_qualified');
    if (p.availability.status !== 'available') reasons.push(`availability_${p.availability.status}`);
    if (p.availability.evidenceKind !== 'execution' || !idString(p.availability.sourceId)) reasons.push('execution_not_verified');
    if (freshness(p.availability.checkedAt, { now, maxAgeHours }).status !== 'fresh') reasons.push('availability_not_fresh');
    const pool = catalog.accountPools.find(a => a.id === p.accountPoolId);
    if (pool.availability?.status !== 'available' || freshness(pool.availability?.checkedAt, { now, maxAgeHours }).status !== 'fresh') reasons.push('account_pool_not_ready');
    if (p.modelSourceId) {
      const snapshot = catalog.snapshots.find(s => s.sourceId === p.modelSourceId);
      if (!snapshot || snapshot.status !== 'ok' || freshness(snapshot.checkedAt, { now, maxAgeHours }).status !== 'fresh') reasons.push('model_catalog_not_fresh');
      else if (!snapshot.models.some(m => m.id === p.model)) reasons.push('model_not_listed');
    }
    if (p.quality?.status !== 'qualified' || !idString(p.quality?.sourceId) || (TIERS[p.quality?.tier] ?? 0) < req.tier) reasons.push('quality_not_qualified');
    for (const capability of req.capabilities) {
      const proof = p.capabilities?.[capability];
      if (proof?.status !== 'verified' || !idString(proof.sourceId)) reasons.push(`capability_${capability}_not_verified`);
    }
    if (req.independent) {
      if (!writerFamily || writerFamily === 'unknown') reasons.push('author_family_unknown');
      if (!p.modelFamily || p.modelFamily === 'unknown') reasons.push('reviewer_family_unknown');
      if (writerFamily === p.modelFamily) reasons.push('same_model_family');
      if (p.id === authorProfileId) reasons.push('same_author_profile');
    }
    const cost = estimateProfileCost(p, task, { now, maxAgeHours: priceAge });
    if (cost.status !== 'estimated' && (!allowUnknownPrice || task.maxCostUsd !== undefined)) reasons.push(cost.reason);
    if (task.maxCostUsd !== undefined && (!finitePrice(task.maxCostUsd) || cost.amount > task.maxCostUsd)) reasons.push('budget_exceeded');
    if (reasons.length) rejected.push({ id: p.id, reasons });
    else ranked.push({ profile: p, estimatedCost: cost });
  }
  ranked.sort((a, b) => {
    const aKnown = a.estimatedCost.status === 'estimated', bKnown = b.estimatedCost.status === 'estimated';
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    if (aKnown && a.estimatedCost.amount !== b.estimatedCost.amount) return a.estimatedCost.amount - b.estimatedCost.amount;
    return TIERS[b.profile.quality.tier] - TIERS[a.profile.quality.tier] || a.profile.id.localeCompare(b.profile.id);
  });
  return ranked.length ? { status: 'selected', reason: 'qualified_then_cost', profile: ranked[0].profile, ranked, rejected } : blocked('no_qualified_profile', rejected);
}

function readJson(file, read) { try { return JSON.parse(read(file, 'utf8')); } catch { return null; } }
function expandHome(file, home) { return file?.startsWith('~/') ? path.join(home, file.slice(2)) : file; }

function knownGroupKeys({ home, read }) {
  const config = readJson(path.join(home, '.pi/agent/pi-gateway.json'), read);
  const files = new Set((config?.providers ?? []).map(p => expandHome(p.keyFile, home)).filter(Boolean));
  // mycodex/pqapi filenames do not establish NewAPI provenance: the migrated sol
  // credential matches mycodex.key and official PQAPI /v1/models accepted it.
  for (const group of ['windsurf', 'opencode', 'cmdcode', 'grok', 'grokpool', 'dspool', 'gptpool', 'sub']) files.add(path.join(home, '.mirasim/keys', `${group}.key`));
  return [...files].map(file => { try { return read(file, 'utf8').trim(); } catch { return null; } }).filter(Boolean);
}

/** Safe credential inventory: values never returned. Association, not key prefix, defines kind. */
export function discoverExecutionCredentials({ home = os.homedir(), read = fs.readFileSync, exists = fs.existsSync } = {}) {
  const gateway = readJson(path.join(home, '.pi/agent/pi-gateway.json'), read);
  const groupKeys = knownGroupKeys({ home, read });
  const inventory = [];
  for (const [group, provider] of [['opencode', 'opencode-go'], ['cmdcode', 'commandcode'], ['windsurf', 'windsurf']]) {
    const entry = gateway?.providers?.find(p => p.id === `gw-${group}`);
    const file = expandHome(entry?.keyFile ?? path.join(home, '.mirasim/keys', `${group}.key`), home);
    inventory.push({ provider, kind: entry ? 'newapi-group' : 'unknown', present: exists(file), location: `~/.mirasim/keys/${group}.key`, evidence: entry ? 'pi_gateway_binding' : 'file_name_is_not_provenance' });
  }
  const direct = [
    ['opencode-go', '.pi/agent/auth.json', ['opencode-go', 'key']],
    ['deepseek', '.pi/agent/auth.json', ['deepseek', 'key']],
    ['commandcode', '.commandcode/auth.json', ['apiKey']],
    ['opencode-go', '.local/share/opencode/auth.json', ['opencode-go', 'key']],
    ['opencode', '.local/share/opencode/auth.json', ['opencode', 'key']],
  ];
  for (const [provider, file, keys] of direct) {
    let value = readJson(path.join(home, file), read);
    for (const key of keys) value = value?.[key];
    const isGroup = typeof value === 'string' && groupKeys.includes(value.trim());
    inventory.push({ provider, kind: isGroup ? 'newapi-group' : 'provider-key', present: typeof value === 'string' && !!value.trim(), location: `~/${file}`, evidence: isGroup ? 'matches_gateway_key' : 'native_auth_field' });
  }
  // An old base_url is not enough: the key may have since been replaced with a group key.
  const codex = readJson(path.join(home, '.codex/auth.json'), read);
  const codexKey = codex?.OPENAI_API_KEY;
  inventory.push({ provider: 'pqapi', kind: codexKey && groupKeys.includes(codexKey) ? 'newapi-group' : 'unknown', present: !!codexKey, location: '~/.codex/auth.json', evidence: codexKey && groupKeys.includes(codexKey) ? 'matches_gateway_key' : 'requires_endpoint_and_key_provenance' });
  // 本地登录型：**表与探针共用一份**（provider-probe.mjs 的 NATIVE_LOGIN_FILES）——
  // 同一组 provider/路径原先在两处各手打一遍，加一个 provider 就要记得改两个地方。
  for (const [provider, file] of Object.entries(NATIVE_LOGIN_FILES)) {
    inventory.push({ provider, kind: 'native-login', present: exists(path.join(home, file)), location: `~/${file}`, evidence: 'file_presence_only_not_session_health' });
  }
  return inventory;
}

function sourceUrl(source, { home, read }) {
  if (source.gatewayConfig) {
    const cfg = readJson(expandHome(source.gatewayConfig, home), read);
    if (!cfg?.gateway || !cfg.providers?.some(p => p.id === source.gatewayGroup)) throw new Error('source_config_missing');
    return `${cfg.gateway.replace(/\/+$/, '')}/v1/models`;
  }
  return source.url;
}

function credentialValue(source, { home, read, env }) {
  const c = source.credential;
  if (!c) return null;
  if (source.access === 'direct' && c.kind !== 'provider-key') throw new Error('credential_kind_mismatch');
  if (source.access === 'gateway-group' && c.kind !== 'newapi-group') throw new Error('credential_kind_mismatch');
  let value;
  if (c.env) value = env[c.env];
  else if (c.file) {
    const file = expandHome(c.file, home);
    if (c.jsonPath) { value = readJson(file, read); for (const key of c.jsonPath) value = value?.[key]; }
    else { try { value = read(file, 'utf8').trim(); } catch { /* fixed error below */ } }
  }
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new Error('credential_missing');
  if (source.access === 'direct' && knownGroupKeys({ home, read }).includes(value.trim())) throw new Error('credential_kind_mismatch');
  return value.trim();
}

// Provider responses and exceptions are untrusted; persist only schema-picked fields.
const safeModelId = value => typeof value === 'string' && value.length <= 240 && /^[a-zA-Z0-9][a-zA-Z0-9._/:\[\]=,+ -]*$/.test(value) && !/^(sk-|user_|Bearer )/i.test(value);
function metadataPrice(model, sourceId, checkedAt) {
  const cost = model?.cost;
  if (!finitePrice(cost?.input) || !finitePrice(cost?.output)) return unknownPricing();
  return { status: 'reference', currency: 'USD', unit: 'per_million_tokens', inputPerMillion: cost.input, outputPerMillion: cost.output, cacheReadPerMillion: finitePrice(cost.cache_read) ? cost.cache_read : null, sourceId, checkedAt, reason: 'public_metadata_not_account_bill' };
}

export function normalizeModelResponse(source, body, checkedAt) {
  let rows;
  if (source.kind === 'models-dev') {
    const models = body?.[source.metadataProvider]?.models;
    if (!models || Array.isArray(models) || typeof models !== 'object') throw new Error('invalid_model_list');
    rows = Object.entries(models).map(([id, row]) => ({ ...row, id }));
  } else {
    if (body?.error || !Array.isArray(body?.data)) throw new Error('invalid_model_list');
    rows = body.data;
  }
  if (!rows.length) throw new Error('empty_model_list');
  const seen = new Set();
  return rows.map(row => {
    if (!safeModelId(row.id) || seen.has(row.id)) throw new Error('invalid_model_list');
    seen.add(row.id);
    return {
      id: row.id, modelFamily: modelFamily(row.id),
      pricing: source.kind === 'models-dev' ? metadataPrice(row, source.id, checkedAt) : unknownPricing('model_list_has_no_verified_billing_price'),
      capabilities: source.kind === 'models-dev' ? { toolCall: typeof row.tool_call === 'boolean' ? row.tool_call : null, contextWindow: finitePrice(row.limit?.context) ? row.limit.context : null } : {},
    };
  });
}

/** GET model/metadata endpoints only; no completions, CLI startup, config writes or auth refresh. */
export async function refreshExecutionCatalog(catalog, { now = Date.now(), fetchImpl = globalThis.fetch, home = os.homedir(), read = fs.readFileSync, env = process.env, timeoutMs = 15_000, sourceIds } = {}) {
  const valid = validateCatalog(catalog);
  if (!valid.ok) throw new Error('invalid_catalog');
  const result = structuredClone(catalog), checkedAt = iso(now), reports = [];
  const context = { home, read, env };
  for (const source of result.sources) {
    if (source.kind === 'evidence' || source.enabled === false || (sourceIds && !sourceIds.includes(source.id))) continue;
    const previous = result.snapshots.find(s => s.sourceId === source.id);
    let snapshot, httpStatus = null;
    try {
      const url = new URL(sourceUrl(source, context));
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('unsafe_source_url');
      const key = credentialValue(source, context);
      const headers = { Accept: 'application/json' };
      if (key) headers.Authorization = `Bearer ${key}`;
      const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(timeoutMs) });
      httpStatus = response.status;
      if (!response.ok) { await response.body?.cancel(); throw new Error([401, 403].includes(httpStatus) ? 'auth_required' : 'http_error'); }
      const body = await response.json();
      const models = normalizeModelResponse(source, body, checkedAt);
      // Even a malicious response must not echo the in-memory credential through a model ID.
      if (key && JSON.stringify(models).includes(key)) throw new Error('invalid_model_list');
      snapshot = { sourceId: source.id, status: 'ok', checkedAt, lastSuccessAt: checkedAt, httpStatus, evidenceKind: source.kind === 'models-dev' ? 'public_metadata' : 'model_list', models };
    } catch (error) {
      const allowed = ['credential_missing', 'credential_kind_mismatch', 'source_config_missing', 'unsafe_source_url', 'auth_required', 'http_error', 'invalid_model_list', 'empty_model_list'];
      const reason = allowed.includes(error.message) ? error.message : ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'fetch_or_parse_failed';
      snapshot = { sourceId: source.id, status: reason === 'auth_required' ? 'auth_required' : 'error', checkedAt, lastSuccessAt: previous?.lastSuccessAt ?? null, httpStatus, reason, evidenceKind: 'failed_refresh', models: previous?.models ?? [] };
    }
    result.snapshots = result.snapshots.filter(s => s.sourceId !== source.id);
    result.snapshots.push(snapshot);
    reports.push({ sourceId: source.id, status: snapshot.status, count: snapshot.models.length, reason: snapshot.reason ?? null });
  }
  for (const profile of result.profiles) {
    if (profile.modelSourceId) {
      const s = result.snapshots.find(s => s.sourceId === profile.modelSourceId);
      profile.modelDiscovery = { status: !s || s.status !== 'ok' ? 'unknown' : s.models.some(m => m.id === profile.model) ? 'listed' : 'not_listed', checkedAt: s?.checkedAt ?? null, sourceId: profile.modelSourceId };
      // Never promote a model listing to successful execution, nor renew execution TTL.
    }
    if (profile.pricingSourceId) {
      const s = result.snapshots.find(s => s.sourceId === profile.pricingSourceId);
      const model = s?.status === 'ok' ? s.models.find(m => m.id === (profile.pricingModel ?? profile.model)) : null;
      profile.pricing = model ? structuredClone(model.pricing) : unknownPricing(s?.status === 'ok' ? 'model_price_not_listed' : 'price_refresh_failed');
    }
  }
  result.updatedAt = checkedAt;
  return { catalog: result, reports, ok: reports.length > 0 && reports.every(r => r.status === 'ok') };
}

/** Writing is explicit and limited to the chosen snapshot file. */
export function writeExecutionCatalog(catalog, file = DEFAULT_CATALOG_PATH, { mode } = {}) {
  const valid = validateCatalog(catalog);
  if (!valid.ok) throw new Error('invalid_catalog');
  // This is public deployment configuration. Private runtime snapshots can opt into 0600.
  let targetMode = mode;
  if (targetMode === undefined) {
    if (path.resolve(file) === path.resolve(DEFAULT_CATALOG_PATH)) targetMode = 0o644;
    else { try { targetMode = fs.statSync(file).mode & 0o777; } catch (e) { if (e.code !== 'ENOENT') throw e; targetMode = 0o644; } }
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', targetMode);
    fs.fchmodSync(fd, targetMode); // Ignore a restrictive caller umask for the public catalog.
    fs.writeFileSync(fd, `${JSON.stringify(catalog, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
