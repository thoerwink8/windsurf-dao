/**
 * Local, credential-free usage accounting (Node builtins only; no New API).
 *
 * Public API (also safe to await):
 *   normalizeUsage({ agent, source, event, context }) -> allowlisted observation
 *   appendUsage(input, { dir }) -> { committed, id }
 *   collectUsage({ home, dir, sources?, accountPools?, limits? }) -> collection status
 *   reportUsage({ home, dir, groupBy?, limits? }) -> unified, reconciled summary
 *   syncCursorAccountUsage({ home, dir }) -> read-only account sampling status
 *
 * dir defaults to ~/.dao/execution/usage. accountPools maps profileId (preferred)
 * or agent to a pool alias, e.g. { 'devin-pro': 'shared', windsurf: 'shared' }.
 * It affects grouping ONLY. Actual accounts are hashed; billingSource is retained.
 * Explicit source: { path, source, agent?, context?, format?: 'json'|'ndjson' }.
 * Runner context can specify usageKind=delta|cumulative, usageScope=call|turn|session,
 * counterEpoch, turnId, providerRequestId and billingSource. Never pass credentials.
 *
 * Each observation is an immutable, fsynced JSON row installed with atomic link.
 * Replay (including death between row commit and checkpoint) is idempotent. The
 * checkpoint is merely a read cursor, never the dedup authority. Report reconciles
 * request aliases and cumulative summaries, including observations arriving late.
 * All scans are bounded; hitting a bound is explicitly incomplete, never success.
 * syncCursorAccountUsage is a separate opt-in read-only Dashboard API sampler;
 * collectUsage itself never makes network calls. Root Mirasim uses a root-owned
 * exporter and an allowlisted immutable inbox, not access to /root for orca.
 * Report.complete describes collection/reconciliation; taskAccounting separately
 * states whether each task has reported core tokens and charges. Other counters
 * remain individually unknown. Cold backfill commits at most 1,000 new rows/run.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const METRICS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'durationMs'];
export const DEFAULT_LIMITS = Object.freeze({ maxSources: 4096, maxEntries: 30000, maxBytesPerSource: 4 * 1024 * 1024, maxLineBytes: 1024 * 1024, maxJsonBytes: 16 * 1024 * 1024, maxRows: 100000, maxGroups: 10000, maxRecords: 20000, maxCommittedPerRun: 1000 });
const digest = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const object = x => x && typeof x === 'object' && !Array.isArray(x) ? x : {};
const first = (...xs) => xs.find(x => x !== undefined && x !== null) ?? null;
const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
const label = x => (typeof x === 'string' || typeof x === 'number') && /^[\p{L}\p{N}_.:/+-]{1,180}$/u.test(String(x)) && !/^(?:sk-|gh[pousr]_|github_pat_|Bearer)/i.test(String(x)) ? String(x) : null;
const displayLabel = x => typeof x === 'string' && x.length <= 180 && label(x.replace(/[\[\]=(), ]/g, '')) ? x : label(x);
const hashId = x => label(x) ? digest(String(x)) : null;
const unique = xs => [...new Set(xs.filter(x => x !== null && x !== undefined))];
const normalized = new WeakMap();
const defaults = options => {
  const home = options.home || os.homedir();
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const v of Object.values(limits)) if (!Number.isSafeInteger(v) || v < 1) throw new Error('invalid_usage_limit');
  return { ...options, home, dir: options.dir || path.join(home, '.dao/execution/usage'), limits };
};
function date(x) {
  const n = typeof x === 'number' ? (x < 1e11 ? x * 1000 : x) : Date.parse(x);
  return Number.isFinite(n) && Number.isFinite(new Date(n).getTime()) ? new Date(n).toISOString() : null;
}
function value(objects, keys) {
  for (const o of objects) for (const k of keys) {
    const n = number(k.split('.').reduce((v, part) => v?.[part], o));
    if (n !== null) return n;
  }
  return null;
}
function providerName(value, agent) {
  const p = label(value);
  if (p) return ({ 'openai-responses': 'openai', 'openai-chat': 'openai', 'x.ai': 'xai' })[p] || p;
  return ({ grok: 'xai', cursor: 'cursor', devin: 'cognition', windsurf: 'windsurf', claude: 'anthropic', codex: 'openai' })[agent] || null;
}
function money(x, fallbackUnit = null) {
  if (typeof x === 'number') return { amount: number(x), unit: label(fallbackUnit) };
  const o = object(x);
  return { amount: number(first(o.amount, o.total, o.value)), unit: label(first(o.unit, o.currency, fallbackUnit)) };
}

export function normalizeUsage({ agent, source = 'unknown', event = {}, context = {} } = {}) {
  const envelope = object(event);
  const root = object(first(envelope.event, envelope.raw, envelope));
  const p = object(root.params);
  const e = object(first(p.update, root.update, root.data, root.payload, root));
  const c = { ...envelope, ...object(envelope.context), ...context };
  const s = label(source) || 'unknown';
  const sourceAgent = /^(cursor|grok|devin|windsurf)-(?:export|native|output|acp|account)$/.exec(s)?.[1];
  const a = label(first(agent, typeof c.agent === 'string' ? c.agent : null, sourceAgent, typeof root.agent === 'string' ? root.agent : root.agent?.name, e.agent))?.toLowerCase() || 'unknown';
  const final = object(first(root.final_metrics, e.final_metrics));
  const total = object(first(e.total_usage, e.info?.total_token_usage, root.total_usage));
  const u = object(first(Object.keys(final).length ? final : null, Object.keys(total).length ? total : null, e.usage, root.usage, e.tokenUsage, root.tokenUsage, e.metrics, root.metrics, e));
  const objects = [u, e, root];
  const tokens = {
    'inputTokens': value(objects, ['inputTokens', 'input_tokens', 'prompt_tokens', 'promptTokens', 'total_prompt_tokens', 'input', 'numInputTokens']),
    'outputTokens': value(objects, ['outputTokens', 'output_tokens', 'completion_tokens', 'completionTokens', 'total_completion_tokens', 'output', 'numOutputTokens']),
    'cacheReadTokens': value(objects, ['cacheReadTokens', 'cachedReadTokens', 'cachedInputTokens', 'inputCachedTokens', 'cached_tokens', 'cache_read_input_tokens', 'total_cached_tokens', 'cacheRead', 'input_tokens_details.cached_tokens', 'prompt_tokens_details.cached_tokens']),
    'cacheWriteTokens': value(objects, ['cacheWriteTokens', 'cacheCreationTokens', 'cache_creation_input_tokens', 'cacheWrite']),
    'reasoningTokens': value(objects, ['reasoningTokens', 'reasoning_tokens', 'reasoning', 'output_tokens_details.reasoning_tokens', 'completion_tokens_details.reasoning_tokens']),
    'totalTokens': value(objects, ['totalTokens', 'total_tokens']),
    durationMs: value(objects, ['durationMs', 'duration_ms', 'apiDurationMs', 'duration_api_ms']),
  };
  // Mirasim writes zero placeholders before usage backfill. Explicit usageKnown
  // can affirm a real zero; an all-zero placeholder must not pretend completeness.
  if (s.startsWith('mirasim') && !root.usageKnown && METRICS.slice(0,6).every(k => tokens[k] === 0 || tokens[k] === null)) {
    for (const k of METRICS.slice(0,6)) tokens[k] = null;
  }
  const sessionId = label(first(c.backendSessionId, c.sessionId, p.sessionId, root.sessionId, root.session_id, e.sessionId, root.sessionKey, c.sessionKey));
  const turnId = label(first(e.prompt_id, e.turnId, root.turnId, root.turn_id, c.turnId));
  const eventId = label(first(root.eventId, e.eventId, p._meta?.eventId, root._meta?.eventId, root.id, e.id, c.eventId));
  const providerCallId = hashId(first(root.providerCallId, e.providerCallId, root.providerRequestId, e.providerRequestId, c.providerCallId, c.providerRequestId));
  const requestId = hashId(first(root.requestId, root.request_id, e.requestId, e.request_id, c.requestId));
  let callId = label(first(root.callId, e.callId, root.relayCallId));
  if (!callId && s === 'mirasim-ledger' && sessionId && eventId?.startsWith(`${sessionId}:`)) callId = eventId.slice(sessionId.length + 1);
  const callIds = unique([callId, label(root.callId), label(root.relayCallId), s === 'mirasim-ledger' && sessionId && eventId?.startsWith(`${sessionId}:`) ? eventId.slice(sessionId.length + 1) : null]);
  const profileId = label(first(c.profileId, root.profileId));
  const reportedProvider = label(first(root.provider, e.provider, c.provider));
  const provider = providerName(first(root.billingProvider, e.billingProvider, c.provider, reportedProvider), a);
  const route = label(first(root.route, e.route, typeof root.viaRelay === 'boolean' ? (root.viaRelay ? 'relay' : 'direct') : null, c.route));
  const poolMap = object(c.accountPools);
  const accountPoolId = label(first(c.accountPoolId, poolMap[profileId], poolMap[a], root.accountPoolId));
  // Only an opaque identifier enters disk/report; no email, userId, workspace or
  // account object is copied. Pool aliases are operator-supplied, never dedup keys.
  const rawAccount = first(c.accountId, root.accountId, e.accountId);
  const accountId = (typeof rawAccount === 'string' || typeof rawAccount === 'number') ? `acct:${digest(String(rawAccount))}` : null;
  const billingSource = displayLabel(first(root.billingSource, root.billing_source, e.billingSource, u.billingSource, c.billingSource, route === 'relay' || route === 'cloud' ? 'mirasim-relay' : null, reportedProvider, provider));
  let kind = label(first(c.usageKind, e.usageKind, u.usageKind, root.usageKind));
  let scope = label(first(c.usageScope, e.usageScope, u.scope, root.usageScope));
  const cumulative = first(e.cumulative, u.cumulative, root.cumulative);
  if (!kind) {
    if (cumulative === true || Object.keys(final).length || Object.keys(total).length || s === 'mirasim-session') kind = 'cumulative';
    else if (cumulative === false || /turn_completed|result/.test(String(e.sessionUpdate || root.type || '')) || turnId || providerCallId || requestId || callId || s === 'mirasim-ledger' || s === 'mirasim-traffic') kind = 'delta';
    else kind = 'unknown';
  }
  if (!['delta', 'cumulative'].includes(kind)) kind = 'unknown';
  if (!scope) scope = kind === 'cumulative' ? 'session' : turnId && !providerCallId && !requestId ? 'turn' : 'call';
  if (s === 'cursor-account' && !providerCallId && !requestId && !callId) {
    if (!c.usageScope && !root.usageScope) {
      if (eventId && (e.tokenUsage || root.tokenUsage)) { scope = 'call'; kind = 'delta'; }
      else { scope = 'account'; kind = 'cumulative'; }
    }
  }
  if (!['call', 'turn', 'session', 'account'].includes(scope)) scope = 'session';
  const model = displayLabel(first(e.model, root.model, u.model, root.agent?.model_name, envelope.model, c.model, Object.keys(object(u.modelUsage)).length === 1 ? Object.keys(u.modelUsage)[0] : null));
  const estimate = money(first(u.estimatedCost, root.estimatedCost, root.costEstimate, u.cost_usd, root.total_cost_usd, root.cost_usd), 'USD');
  // Grok ticks have a reported unit, not an assumed USD conversion or a charge.
  if (estimate.amount === null && number(u.costUsdTicks) !== null) Object.assign(estimate, { amount: u.costUsdTicks, unit: 'USD_ticks' });
  const charge = money(first(u.actualCharge, root.actualCharge, u.charge, root.charge, root.chargedAmount), first(root.chargeUnit, root.currency));
  if (s === 'cursor-account' && charge.amount === null && number(root.costInCents) !== null) Object.assign(charge, { amount: root.costInCents / 100, unit: 'USD' });
  const balance = money(first(root.balance, root.remaining, u.balance), first(root.balanceUnit, root.currency));
  const timestamp = date(first(root.ts, root.timestamp, root.timestamp_ms, e.timestamp, p._meta?.agentTimestampMs, root.updatedAt, c.timestamp, envelope.receivedAt));
  const aliases = [];
  const sessionNamespace = sessionId || label(c.sessionKey) || a;
  if (providerCallId) aliases.push(`provider:${provider || a}:${providerCallId}`);
  if (requestId) aliases.push(`request:${sessionNamespace}:${requestId}`);
  for (const id of callIds) aliases.push(`call:${sessionNamespace}:${digest(id)}`);
  if (eventId) aliases.push(`event:${sessionNamespace}:${digest(eventId)}`);
  if (scope === 'turn' && turnId) aliases.push(`turn:${sessionNamespace}:${digest(turnId)}`);
  const row = {
    schema: 1, source: s, agent: a, taskId: label(first(c.taskId, root.taskId)), attemptId: label(first(c.attemptId, root.attemptId)),
    sessionKey: label(c.sessionKey), sessionId, turnId, profileId, provider, reportedProvider, accountPoolId, accountId, billingSource, model, route,
    timestamp, kind, scope, counterEpoch: label(first(c.counterEpoch, root.counterEpoch)) || '0',
    reportedModel: displayLabel(first(root.reportedModel, e.reportedModel, model)),
    apiSource: label(first(c.apiSource, root.apiSource)),
    allowance: { spent: number(root.allowance?.spent), limit: number(root.allowance?.limit), unit: label(root.allowance?.unit) },
    accountingWindow: { start: date(root.accountingWindow?.start), end: date(root.accountingWindow?.end), complete: root.accountingWindow?.complete === true },
    aliases: unique(aliases), metrics: tokens, estimate, charge, balance,
  };
  // No content hashing as event identity: unrelated equal-cost calls stay separate.
  // A collector supplies a stable source position if the provider supplies no ID.
  row.identity = aliases[0] || (kind === 'cumulative' && sessionId ? `session:${digest([s, a, sessionId, row.counterEpoch])}` : c.sourceEventId ? `position:${digest(String(c.sourceEventId))}` : `unidentified:${randomUUID()}`);
  row.completeness = {
    'tokens': tokens.inputTokens === null && tokens.outputTokens === null ? 'unknown' : tokens.inputTokens !== null && tokens.outputTokens !== null ? 'reported' : 'partial',
    charge: charge.amount === null ? 'unknown' : charge.unit === null ? 'partial' : 'reported',
    semantics: kind === 'unknown' ? 'unknown' : 'known',
    attribution: row.taskId ? 'task' : scope === 'account' ? 'account' : 'unattributed',
    identity: !row.identity.startsWith('unidentified:') ? 'stable' : 'unknown',
  };
  normalized.set(row, structuredClone(row));
  return row;
}

function mkdir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
function syncDir(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch (e) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(e.code)) throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function atomic(file, value, immutable = false, access = {}) {
  if (immutable && fs.existsSync(file)) return false;
  mkdir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', access.mode ?? 0o600);
    if (Number.isInteger(access.gid) && process.platform !== 'win32') fs.fchownSync(fd, process.getuid(), access.gid);
    fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (immutable) {
      try { fs.linkSync(tmp, file); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    } else fs.renameSync(tmp, file);
    syncDir(path.dirname(file));
    return true;
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function json(file, maxBytes = 1024 * 1024) {
  try {
    if (fs.statSync(file).size > maxBytes) throw new Error('usage_json_too_large');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function appendUsage(input, options = {}) {
  const { dir } = defaults(options);
  // Same-process normalizeUsage output is accepted; untrusted parsed JSON must
  // enter through {event, context}, so arbitrary payload fields cannot enter disk.
  const row = normalized.get(input) || normalizeUsage(input);
  const id = digest(row);
  return { committed: atomic(path.join(dir, 'rows', id.slice(0, 2), `${id}.json`), row, true), id };
}

/** Reconstruct a serialized observation through the same field allowlist. Used
 * only at the root/orca inbox boundary; hashes remain hashes, preserving aliases
 * across collectors. Unknown fields, messages, auth and account objects vanish. */
export function sanitizeUsageObservation(input) {
  if (input?.schema !== 1) throw new Error('invalid_usage_observation');
  const r = object(input);
  const row = normalizeUsage({ agent: label(r.agent), source: label(r.source), event: {
    model: displayLabel(r.model), reportedModel: displayLabel(r.reportedModel), provider: label(r.reportedProvider), usageKnown: true,
    usage: Object.fromEntries(METRICS.map(k => [k, number(r.metrics?.[k])])),
    estimatedCost: money(r.estimate), actualCharge: money(r.charge), balance: money(r.balance),
    allowance: { spent: number(r.allowance?.spent), limit: number(r.allowance?.limit), unit: label(r.allowance?.unit) },
    accountingWindow: { start: date(r.accountingWindow?.start), end: date(r.accountingWindow?.end), complete: r.accountingWindow?.complete === true },
  }, context: Object.fromEntries(['taskId','attemptId','sessionKey','sessionId','turnId','profileId','provider','accountPoolId','billingSource','route','timestamp','counterEpoch','apiSource'].map(k => [k, k === 'billingSource' ? displayLabel(r[k]) : label(r[k])]).concat([['usageKind',r.kind],['usageScope',r.scope]])) });
  row.timestamp = date(r.timestamp);
  row.reportedProvider = label(r.reportedProvider);
  row.accountId = typeof r.accountId === 'string' && /^acct:[a-f0-9]{64}$/.test(r.accountId) ? r.accountId : null;
  if (!Array.isArray(r.aliases) || r.aliases.length > 16) throw new Error('invalid_usage_alias');
  row.aliases = r.aliases.map(a => {
    if (typeof a !== 'string' || a.length > 512) throw new Error('invalid_usage_alias');
    const parts = a.split(':');
    if (!['provider','request','call','event','turn'].includes(parts[0]) || !/^[a-f0-9]{64}$/.test(parts.at(-1)) || parts.slice(1,-1).some(p => !label(p))) throw new Error('invalid_usage_alias');
    return a;
  });
  if (!row.aliases.includes(r.identity) && !/^(?:position|session):[a-f0-9]{64}$/.test(r.identity || '') && !/^unidentified:[a-f0-9-]{36}$/.test(r.identity || '')) throw new Error('invalid_usage_identity');
  row.identity = r.identity;
  row.completeness.identity = row.identity.startsWith('unidentified:') ? 'unknown' : 'stable';
  normalized.set(row, structuredClone(row));
  return row;
}

export function importUsageInbox(inbox, input = {}) {
  const options = defaults(input), result = { committed: 0, duplicates: 0, gaps: [] };
  try {
    if (!fs.lstatSync(inbox).isDirectory() || fs.lstatSync(inbox).isSymbolicLink()) throw new Error('unsafe_inbox');
    const manifest = json(path.join(inbox, 'manifest.json'));
    if (!manifest || manifest.schema !== 1) { result.gaps.push('inbox_manifest_missing'); return result; }
    if (!manifest.complete) result.gaps.push('inbox_export_incomplete');
    const age = Date.now() - Date.parse(manifest.exportedAt);
    if (!Number.isFinite(age) || age > 15 * 60 * 1000) result.gaps.push('inbox_export_stale');
    const budget = { count: 0, max: options.limits.maxRows + 512 };
    let rows = 0;
    walk(path.join(inbox, 'rows'), budget, f => {
      if (!/^[a-f0-9]{64}\.json$/.test(path.basename(f))) return;
      if (++rows > options.limits.maxRows) { budget.exhausted = true; return; }
      const row = sanitizeUsageObservation(json(f, 65536));
      if (result.committed >= options.limits.maxCommittedPerRun) { budget.exhausted = true; return; }
      const added = appendUsage(row, options);
      result[added.committed ? 'committed' : 'duplicates']++;
    });
    if (budget.exhausted) result.gaps.push('inbox_scan_limit');
  } catch (e) { result.gaps.push(e.code === 'ENOENT' ? 'inbox_missing' : 'inbox_invalid'); }
  return result;
}

/** Publish only normalized rows. Shared parents must be root-owned in production;
 * the exporter runs an installed root-owned copy, never the writable checkout. */
export function publishUsageInbox({ dir, inbox, readerGid, limits: requestedLimits } = {}) {
  const options = defaults({ dir, limits: requestedLimits });
  if (!Number.isSafeInteger(readerGid) || readerGid < 0 || !path.isAbsolute(inbox)) throw new Error('invalid_inbox_access');
  const sharedDir = d => {
    mkdir(d);
    const st = fs.lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('unsafe_inbox');
    if (process.platform !== 'win32' && (st.uid !== process.getuid() || st.gid !== readerGid)) fs.chownSync(d, process.getuid(), readerGid);
    if ((st.mode & 0o777) !== 0o750) fs.chmodSync(d, 0o750);
  };
  sharedDir(inbox); sharedDir(path.join(inbox, 'rows'));
  const budget = { count: 0, max: options.limits.maxRows + 512 };
  let count = 0, published = 0;
  const buckets = new Set();
  walk(path.join(dir, 'rows'), budget, f => {
    if (!/^[a-f0-9]{64}\.json$/.test(path.basename(f))) return;
    if (++count > options.limits.maxRows) { budget.exhausted = true; return; }
    const row = sanitizeUsageObservation(json(f, 65536)), id = digest(row);
    const bucket = path.join(inbox, 'rows', id.slice(0,2));
    if (!buckets.has(bucket)) { sharedDir(bucket); buckets.add(bucket); }
    const destination = path.join(bucket, `${id}.json`);
    if (!fs.existsSync(destination) && published >= options.limits.maxCommittedPerRun) { budget.exhausted = true; return; }
    if (atomic(destination, row, true, { mode: 0o640, gid: readerGid })) published++;
  });
  const collection = json(path.join(dir, 'collection.json'));
  const manifest = { schema: 1, origin: 'root-mirasim', exportedAt: new Date().toISOString(), complete: !budget.exhausted && collection?.complete === true, rows: count, published, sourceTypes: ['mirasim-ledger','mirasim-session','mirasim-traffic'] };
  atomic(path.join(inbox, 'manifest.json'), manifest, false, { mode: 0o640, gid: readerGid });
  return manifest;
}

export const CURSOR_USAGE_API = 'https://api2.cursor.sh/aiserver.v1.DashboardService/';

/** Read-only Cursor account accounting using the already logged-in user's OAuth
 * token. Endpoint/methods are fixed, redirects forbidden, responses bounded. The
 * 2026.08.31 CLI ships these DashboardService protobuf contracts. In particular,
 * UsageEventDisplay.conversationId identifies an ACP backend session exactly;
 * current context-window occupancy is never substituted for request usage.
 * Tests inject fetchImpl and a fake auth file; no unit test calls this service. */
export async function syncCursorAccountUsage(input = {}) {
  const options = defaults(input), checkedAtMs = input.now?.() ?? Date.now();
  const checkedAt = new Date(checkedAtMs).toISOString();
  const state = { source: 'cursor-dashboard', checkedAt, complete: false, pages: 0, matchedSessions: 0, unmatchedSessions: 0, gaps: [] };
  const finish = () => { state.gaps = unique(state.gaps); state.complete = state.gaps.length === 0; atomic(path.join(options.dir, 'cursor-account-sync.json'), state); return state; };
  const metadata = readMetadata(options.home, options.limits, state.gaps);
  const targets = new Map(), budget = { count: 0, max: options.limits.maxEntries };
  walk(path.join(options.home, '.dao/execution/acp/sessions'), budget, f => {
    if (path.basename(f) !== 'status.json') return;
    try {
      const status = json(f);
      if (status?.agent !== 'cursor' || !label(status.backendSessionId)) return;
      const context = { ...object(status.context), ...status, ...object(metadata.get(status.sessionKey)), backendSessionId: status.backendSessionId };
      targets.set(status.backendSessionId, context);
    } catch { state.gaps.push('cursor_context_unreadable'); }
  });
  if (budget.exhausted) state.gaps.push('cursor_context_scan_limit');
  let auth;
  try { auth = json(path.join(options.home, '.config/cursor/auth.json')); }
  catch { state.gaps.push('cursor_auth_unreadable'); return finish(); }
  if (typeof auth?.accessToken !== 'string' || !auth.accessToken) { state.gaps.push('cursor_auth_missing'); return finish(); }
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  const request = async (method, body) => {
    if (!['GetCurrentPeriodUsage','GetFilteredUsageEvents'].includes(method)) throw new Error('cursor_method_not_allowed');
    const response = await fetchImpl(CURSOR_USAGE_API + method, { method: 'POST', headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403 ? 'cursor_account_auth_required' : 'cursor_account_http_error'); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('cursor_account_empty_response');
    const chunks = []; let size = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('cursor_account_response_limit'); } chunks.push(Buffer.from(next.value)); }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const scalar = x => typeof x === 'number' ? number(x) : typeof x === 'string' && /^\d+(?:\.\d+)?$/.test(x) ? number(Number(x)) : null;
  const counter = (o, k) => o && typeof o === 'object' ? o[k] === undefined ? 0 : scalar(o[k]) : null;
  const config = json(path.join(options.home, '.dao/execution/usage-config.json')) || {};
  const poolIds = unique([...targets.values()].map(c => label(c.accountPoolId)));
  const pool = label(first(input.accountPoolId, config.accountPools?.cursor, poolIds.length === 1 ? poolIds[0] : null));
  const sourceContext = { agent: 'cursor', provider: 'cursor', accountPoolId: pool, billingSource: 'cursor-dashboard' };
  try {
    const period = await request('GetCurrentPeriodUsage', {});
    const plan = object(period.planUsage), hasPlan = period.planUsage && typeof period.planUsage === 'object';
    const usd = x => x === null ? null : x / 100;
    appendUsage({ source: 'cursor-account', agent: 'cursor', context: { ...sourceContext, usageScope: 'account', usageKind: 'cumulative', apiSource: CURSOR_USAGE_API + 'GetCurrentPeriodUsage', sourceEventId: `cursor-period:${checkedAt}` }, event: {
      timestamp: checkedAt, balance: { amount: hasPlan ? usd(counter(plan, 'remaining')) : null, unit: 'USD' },
      allowance: { spent: hasPlan ? usd(counter(plan, 'totalSpend')) : null, limit: hasPlan ? usd(counter(plan, 'limit')) : null, unit: 'USD' },
      accountingWindow: { start: scalar(period.billingCycleStart), end: scalar(period.billingCycleEnd), complete: true },
    } }, options);
    state.accountSnapshot = 'reported';
  } catch (e) { state.gaps.push(/^cursor_[a-z_]+$/.test(e.message) ? e.message : 'cursor_account_snapshot_failed'); }
  if (!targets.size) return finish();
  const maxPages = input.maxPages ?? 10, lookbackMs = input.lookbackMs ?? 7 * 86400000;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100 || !Number.isSafeInteger(lookbackMs) || lookbackMs < 1) throw new Error('invalid_cursor_account_limits');
  const startMs = checkedAtMs - lookbackMs;
  const knownStarts = [...targets.values()].map(c => Date.parse(c.startedAt)).filter(Number.isFinite);
  const earliestNeeded = knownStarts.length ? Math.max(startMs, Math.min(...knownStarts)) : startMs;
  const matches = new Map(); let fullWindow = false, oldestEvent = Infinity;
  try {
    for (let page = 1; page <= maxPages; page++) {
      const data = await request('GetFilteredUsageEvents', { teamId: 0, startDate: String(startMs), endDate: String(checkedAtMs), page, pageSize: 100 });
      state.pages++;
      const events = Array.isArray(data.usageEventsDisplay) ? data.usageEventsDisplay : data.usageEventsDisplay === undefined && counter(data, 'totalUsageEventsCount') === 0 ? [] : null;
      if (!events) throw new Error('cursor_usage_events_missing');
      for (const event of events) {
        const timestamp = scalar(event.timestamp);
        if (timestamp !== null) oldestEvent = Math.min(oldestEvent, timestamp < 1e11 ? timestamp * 1000 : timestamp);
        const sessionId = label(event.conversationId);
        if (!targets.has(sessionId)) continue;
        if (!matches.has(sessionId)) matches.set(sessionId, []);
        // An identical-looking row still represents another call; do not dedup
        // on pool, token counts, model, or timestamp. Aggregate the complete page
        // set once, then persist a session cumulative snapshot for safe replay.
        matches.get(sessionId).push(event);
      }
      const total = scalar(data.totalUsageEventsCount);
      if (events.length < 100 || (total !== null && page * 100 >= total)) { fullWindow = true; break; }
      if (oldestEvent < earliestNeeded) { fullWindow = true; break; }
    }
    if (!fullWindow) state.gaps.push('cursor_account_page_limit');
  } catch (e) { state.gaps.push(/^cursor_[a-z_]+$/.test(e.message) ? e.message : 'cursor_account_events_failed'); }
  for (const [sessionId, context] of targets) {
    const events = matches.get(sessionId);
    if (!events?.length) { state.unmatchedSessions++; continue; }
    const startedAt = Date.parse(context.startedAt);
    const covered = Number.isFinite(startedAt) && startedAt >= startMs && (fullWindow || oldestEvent < startedAt);
    if (!covered) { state.gaps.push('cursor_session_window_incomplete'); continue; }
    const models = unique(events.map(e => displayLabel(e.model)));
    for (const model of models.length ? models : [null]) {
      const subset = events.filter(e => displayLabel(e.model) === model);
      const total = getter => { const values = subset.map(getter); return values.every(v => v !== null) ? sum(values) : null; };
      const metrics = {};
      for (const k of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens']) metrics[k] = total(e => counter(e.tokenUsage, k));
      // ChargedCents is an optional, explicitly reported charge. TokenUsage's
      // totalCents is a separate estimate; a missing charge is never filled by it.
      const charged = total(e => scalar(e.chargedCents)), estimated = total(e => e.tokenUsage ? counter(e.tokenUsage, 'totalCents') : null);
      if (metrics.inputTokens === null || metrics.outputTokens === null) state.gaps.push('cursor_session_tokens_incomplete');
      appendUsage({ agent: 'cursor', source: 'cursor-account', context: { ...context, ...sourceContext, accountPoolId: label(context.accountPoolId) || pool, backendSessionId: sessionId, usageKind: 'cumulative', usageScope: 'session', apiSource: CURSOR_USAGE_API + 'GetFilteredUsageEvents' }, event: {
        sessionId, timestamp: checkedAt, model: models.length === 1 ? displayLabel(context.model) || model : model, reportedModel: model, usage: metrics,
        actualCharge: { amount: charged === null ? null : charged / 100, unit: 'USD' }, estimatedCost: { amount: estimated === null ? null : estimated / 100, unit: 'USD' },
        accountingWindow: { start: startMs, end: checkedAtMs, complete: covered },
      } }, options);
    }
    state.matchedSessions++;
  }
  return finish();
}

function walk(root, budget, callback, depth = 0) {
  if (depth > 5 || budget.exhausted) return;
  let dir;
  try { dir = fs.opendirSync(root); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  try {
    for (let ent; (ent = dir.readSync());) {
      if (++budget.count > budget.max) { budget.exhausted = true; break; }
      const file = path.join(root, ent.name);
      if (ent.isDirectory()) walk(file, budget, callback, depth + 1);
      else if (ent.isFile()) callback(file);
      if (budget.exhausted) break;
    }
  } finally { dir.closeSync(); }
}
function readMetadata(home, limits, gaps) {
  const map = new Map();
  const budget = { count: 0, max: limits.maxEntries };
  walk(path.join(home, '.dao/execution/sessions'), budget, f => {
    if (!f.endsWith('.json')) return;
    try {
      const c = object(json(f));
      for (const key of unique([c.sessionKey, c.sessionId, c.backendSessionId, decodeURIComponent(path.basename(f, '.json'))])) {
        map.set(key, c);
        if (typeof key === 'string' && key.startsWith(`${c.agent}:`)) map.set(key.slice(c.agent.length + 1), c);
      }
    } catch { gaps.push('invalid_context'); }
  });
  if (budget.exhausted) gaps.push('metadata_scan_limit');
  return map;
}
function contextFor(event, sourceContext, metadata) {
  const root = object(first(event.event, event.raw, event));
  const keys = [root.params?.sessionId, root.sessionId, root.session_id, root.sessionKey, sourceContext.sessionKey, sourceContext.sessionId];
  let meta = {};
  for (const k of keys) if (metadata.has(k)) { meta = metadata.get(k); break; }
  return { ...meta, ...sourceContext, ...object(event.context) };
}
function discover(options, gaps) {
  const { home, limits } = options;
  const sources = [];
  const add = spec => { if (sources.length < limits.maxSources) sources.push(spec); else gaps.push('source_limit'); };
  const budget = { count: 0, max: limits.maxEntries };
  const scan = (root, cb) => walk(root, budget, cb);
  scan(path.join(home, '.mirasim/insights'), f => {
    if (/^usage-.*\.ndjson$/.test(path.basename(f))) add({ path: f, source: 'mirasim-ledger', rewrite: true });
    if (/^session-usage-.*\.ndjson$/.test(path.basename(f))) add({ path: f, source: 'mirasim-session', rewrite: true });
  });
  scan(path.join(home, '.mirasim/traffic'), f => {
    if (/^index-\d+\.ndjson$/.test(path.basename(f))) add({ path: f, source: 'mirasim-traffic', context: { sessionId: path.basename(path.dirname(f)) } });
  });
  if (options.mirasimOnly) {
    if (budget.exhausted) gaps.push('discovery_scan_limit');
    return sources;
  }
  scan(path.join(home, '.dao/execution/acp'), f => {
    const name = path.basename(f);
    if (!['usage.ndjson', 'export.json', 'output.ndjson', 'account-usage.json', 'status.json'].includes(name)) return;
    if (name === 'status.json' && ['usage.ndjson', 'output.ndjson', 'export.json'].some(n => {
      try { return fs.statSync(path.join(path.dirname(f), n)).size > 0; } catch { return false; }
    })) return;
    let c = {};
    for (const n of ['status.json', 'context.json', 'status/context.json']) {
      try { const o = object(json(path.join(path.dirname(f), n))); c = { ...c, ...o, ...object(o.context) }; } catch { gaps.push('invalid_context'); }
    }
    c.sessionKey ||= path.basename(path.dirname(f));
    if (name === 'status.json') Object.assign(c, { usageKind: 'cumulative', usageScope: 'session' });
    add({ path: f, source: name === 'status.json' ? 'native-status' : name === 'export.json' ? 'devin-export' : name === 'account-usage.json' ? 'cursor-account' : `${label(c.agent) || 'native'}-acp`, agent: c.agent, context: c, format: name.endsWith('.json') ? 'json' : 'ndjson' });
  });
  // Native Grok's own append-only ACP updates contain turn_completed. No auth or
  // prompt history is read. Cursor account exports are optional local files.
  scan(path.join(home, '.grok/sessions'), f => {
    if (path.basename(f) === 'updates.jsonl') add({ path: f, source: 'grok-native', agent: 'grok', context: { sessionId: path.basename(path.dirname(f)) } });
  });
  // Native runners can retain stdout beside the same context/status metadata.
  // Cursor's SQLite chat/acp stores contain current context-window token_details,
  // not the CLI result's input/output/cache billing counters (2026.08.31 build).
  // Never reinterpret those context sizes as spent tokens. Exported usage/output
  // files remain usable without loading transcripts, SQLite, or provider SDKs.
  scan(path.join(home, '.dao/execution/native'), f => {
    if (!/^(?:usage|output|stdout)\.(?:ndjson|jsonl)$|\.stdout$/.test(path.basename(f))) return;
    let c = {};
    for (const n of ['status.json','context.json']) {
      try { const v = object(json(path.join(path.dirname(f), n))); c = { ...c, ...v, ...object(v.context) }; } catch { gaps.push('invalid_context'); }
    }
    add({ path: f, source: `${label(c.agent) || 'native'}-output`, agent: c.agent, context: c });
  });
  for (const f of ['usage.json', 'usage.ndjson', 'account-usage.json']) {
    const p = path.join(home, '.cursor', f);
    if (fs.existsSync(p)) add({ path: p, source: 'cursor-account', agent: 'cursor', format: f.endsWith('.ndjson') ? 'ndjson' : 'json' });
  }
  if (budget.exhausted) gaps.push('discovery_scan_limit');
  return sources;
}
function isUsage(event, source) {
  if (/mirasim|devin-export|cursor-account|native-status/.test(source)) return true;
  const r = object(first(event.event, event.raw, event));
  const u = object(first(r.params?.update, r.update, r.data, r.payload, r));
  return !!(u.usage || u.metrics || u.total_usage || u.final_metrics || r.usage || u.info?.total_token_usage || ['inputTokens','input_tokens','prompt_tokens','output_tokens','outputTokens'].some(k => number(u[k]) !== null) || /usage|result|turn_completed|session_finished/.test(String(u.sessionUpdate || u.type || r.type || event.type || '')));
}
function fileFingerprint(stat) { return `${stat.dev}:${stat.ino}`; }
function collectFile(spec, options, metadata, totals) {
  const { dir, limits } = options;
  const key = digest(path.resolve(spec.path));
  const checkpointFile = path.join(dir, 'checkpoints', `${key}.json`);
  let stat;
  try { stat = fs.statSync(spec.path); } catch (e) { totals.gaps.push(e.code === 'ENOENT' ? 'source_missing' : 'source_unreadable'); return; }
  if (!stat.isFile()) return;
  let cp;
  try { cp = json(checkpointFile) || {}; } catch { cp = {}; totals.gaps.push('checkpoint_replayed'); }
  const fingerprint = fileFingerprint(stat);
  const streamContext = cp.fingerprint === fingerprint && (cp.offset || 0) <= stat.size ? object(cp.context) : {};
  const commit = (event, position) => {
    // Cursor stream-json emits model/session in system:init, while the final
    // result carries request_id and usage. Checkpoint just these safe fields.
    if (event.type === 'system' && event.subtype === 'init') {
      const model = displayLabel(event.model), sessionId = label(event.session_id);
      if (model) streamContext.model = model;
      if (sessionId) streamContext.sessionId = sessionId;
    }
    if (number(event.timestamp_ms) !== null) streamContext.timestamp = date(event.timestamp_ms);
    if (!isUsage(event, spec.source)) return;
    const context = contextFor(event, { ...object(spec.context), ...streamContext }, metadata);
    context.accountPools = options.accountPools;
    context.sourceEventId = `${key}:${fingerprint}:${position}`;
    const result = appendUsage({ agent: spec.agent, source: spec.source, event, context }, options);
    totals[result.committed ? 'committed' : 'duplicates']++;
  };
  if (spec.format === 'json' || spec.path.endsWith('.json')) {
    if (stat.size > limits.maxJsonBytes) { totals.gaps.push('json_size_limit'); return; }
    if (cp.fingerprint === fingerprint && cp.size === stat.size && cp.mtimeMs === stat.mtimeMs && cp.complete !== false) return;
    let data;
    try { data = json(spec.path, limits.maxJsonBytes); } catch { totals.gaps.push('incomplete_json'); return; }
    const entries = Array.isArray(data) ? data : Array.isArray(data?.usageEvents) ? data.usageEvents : Array.isArray(data?.usageEventsDisplay) ? data.usageEventsDisplay : Array.isArray(data?.events) && spec.source === 'cursor-account' ? data.events : [data];
    if (entries.length > limits.maxRecords) { totals.gaps.push('record_limit'); return; }
    let i = cp.fingerprint === fingerprint && cp.size === stat.size && cp.mtimeMs === stat.mtimeMs ? cp.entryOffset || 0 : 0;
    for (; i < entries.length && totals.committed < limits.maxCommittedPerRun; i++) if (entries[i] && typeof entries[i] === 'object') commit(entries[i], i);
    atomic(checkpointFile, { fingerprint, size: stat.size, mtimeMs: stat.mtimeMs, entryOffset: i, complete: i === entries.length });
    if (i < entries.length) totals.gaps.push('collection_commit_limit');
    return;
  }
  let offset = cp.fingerprint === fingerprint && cp.offset <= stat.size ? cp.offset : 0;
  // Insights can be backfilled in place. Complete a bounded sweep before starting
  // a new generation, even if this busy file keeps growing between timer ticks.
  let target = cp.target;
  let targetMtime = cp.targetMtime;
  if (cp.tail && stat.size > target) { target = stat.size; targetMtime = stat.mtimeMs; }
  if (!target || offset >= target || cp.fingerprint !== fingerprint || target > stat.size) {
    if (cp.size === stat.size && cp.mtimeMs === stat.mtimeMs && offset === stat.size) return;
    if (spec.rewrite && (cp.mtimeMs !== stat.mtimeMs || cp.size !== stat.size)) offset = 0;
    target = stat.size; targetMtime = stat.mtimeMs;
  }
  const amount = Math.min(target - offset, limits.maxBytesPerSource);
  if (amount <= 0) return;
  const buffer = Buffer.alloc(amount);
  const fd = fs.openSync(spec.path, 'r');
  let bytes;
  try { bytes = fs.readSync(fd, buffer, 0, amount, offset); } finally { fs.closeSync(fd); }
  let start = 0;
  let records = 0;
  while (start < bytes && records < limits.maxRecords && totals.committed < limits.maxCommittedPerRun) {
    const end = buffer.indexOf(10, start);
    if (end < 0 || end >= bytes) break;
    if (end - start > limits.maxLineBytes) { totals.gaps.push('line_size_limit'); break; }
    const line = buffer.subarray(start, end).toString('utf8').trim();
    if (line) {
      let event;
      try { event = JSON.parse(line); } catch { totals.gaps.push('invalid_ndjson'); break; }
      if (!event || typeof event !== 'object') { totals.gaps.push('invalid_usage_event'); break; }
      commit(event, offset + start);
    }
    records++; start = end + 1;
  }
  // A partial/malformed line is retained at the source cursor for the next run.
  // Source bytes can advance only after all corresponding rows have committed.
  const next = offset + start;
  atomic(checkpointFile, { fingerprint, offset: next, target, targetMtime, context: streamContext, tail: next < target && offset + bytes >= target, size: next >= target ? target : cp.size, mtimeMs: next >= target ? targetMtime : cp.mtimeMs });
  if (next < target) totals.gaps.push(totals.committed >= limits.maxCommittedPerRun ? 'collection_commit_limit' : start === 0 && bytes >= limits.maxLineBytes ? 'line_size_limit' : next < offset + bytes && bytes < limits.maxBytesPerSource ? 'interrupted_tail' : 'source_scan_pending');
}

export function collectUsage(input = {}) {
  const options = defaults(input);
  mkdir(options.dir);
  const lock = path.join(options.dir, 'collector.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let pid;
    try { pid = json(path.join(lock, 'owner.json'))?.pid; } catch { /* failed owner write */ }
    let alive = true;
    if (Number.isSafeInteger(pid)) { try { process.kill(pid, 0); } catch (err) { alive = err.code !== 'ESRCH'; } }
    else alive = Date.now() - fs.statSync(lock).mtimeMs < 120000;
    if (alive) return { complete: false, busy: true, committed: 0, duplicates: 0, gaps: ['collector_busy'] };
    fs.rmSync(lock, { recursive: true, force: true });
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { return { complete: false, busy: true, committed: 0, duplicates: 0, gaps: ['collector_busy'] }; }
  }
  try {
    atomic(path.join(lock, 'owner.json'), { pid: process.pid });
    const totals = { complete: true, committed: 0, duplicates: 0, sources: 0, gaps: [] };
    const metadata = options.mirasimOnly ? new Map() : readMetadata(options.home, options.limits, totals.gaps);
    const config = options.readConfig === false ? null : json(path.join(options.home, '.dao/execution/usage-config.json'));
    options.accountPools ||= object(config?.accountPools);
    const sources = input.sources || [...discover(options, totals.gaps), ...(Array.isArray(config?.sources) ? config.sources : [])];
    if (sources.length > options.limits.maxSources) totals.gaps.push('source_limit');
    for (const spec of sources.slice(0, options.limits.maxSources)) {
      if (totals.committed >= options.limits.maxCommittedPerRun) { totals.gaps.push('collection_commit_limit'); break; }
      totals.sources++;
      collectFile(spec, options, metadata, totals);
    }
    totals.imported = 0;
    for (const inbox of input.inboxes || config?.inboxes || []) {
      const imported = importUsageInbox(inbox, options);
      totals.imported += imported.committed;
      totals.duplicates += imported.duplicates;
      totals.gaps.push(...imported.gaps);
    }
    totals.gaps = unique(totals.gaps);
    if (!totals.sources && !totals.imported && !(input.inboxes || config?.inboxes || []).length) totals.gaps.push('no_usage_sources');
    totals.complete = totals.gaps.length === 0;
    atomic(path.join(options.dir, 'collection.json'), { ...totals, collectedAt: new Date().toISOString() });
    return totals;
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

function coalesce(rows) {
  // Union-find handles traffic(callId) -> ledger(callId+providerCallId) -> native
  // providerCallId, independent of arrival order. Pool IDs are absent on purpose.
  const parents = rows.map((_, i) => i), aliases = new Map();
  const find = i => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
  rows.forEach((r, i) => {
    // Session/account snapshots are reconciled as a series, not event aliases.
    const keys = r.kind === 'cumulative' && ['session', 'account'].includes(r.scope) ? [`snapshot:${digest([r.source, r.identity, r.timestamp, r.metrics, r.charge, r.balance])}`] : unique([r.identity, ...r.aliases]);
    for (const k of keys) { if (aliases.has(k)) parents[find(i)] = find(aliases.get(k)); else aliases.set(k, i); }
  });
  const groups = new Map();
  rows.forEach((r, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  return [...groups.values()].map(rs => {
    // Rich usage wins over traffic placeholders; independently reported charges
    // and attribution still survive. Conflicting measurements are visible.
    rs.sort((a,b) => METRICS.filter(k => b.metrics[k] !== null).length - METRICS.filter(k => a.metrics[k] !== null).length);
    const r = structuredClone(rs[0]);
    r.sources = unique(rs.map(x => x.source));
    r.billingSources = unique(rs.map(x => x.billingSource));
    r.reportedModels = unique(rs.map(x => x.reportedModel || x.model));
    r.conflicts = [];
    for (const k of METRICS) {
      const values = unique(rs.map(x => x.metrics[k]));
      r.metrics[k] = values.length ? Math.max(...values) : null;
      if (values.length > 1) r.conflicts.push(k);
    }
    for (const k of ['taskId','attemptId','sessionKey','sessionId','turnId','profileId','provider','reportedProvider','accountPoolId','accountId','billingSource','model','route','timestamp']) r[k] = first(...rs.map(x => x[k]));
    for (const k of ['charge','estimate','balance']) r[k] = first(...rs.map(x => x[k]).filter(x => x.amount !== null)) || { amount: null, unit: null };
    return r;
  });
}
function sum(values) { const known = values.filter(v => v !== null); return known.length ? known.reduce((a,b) => a+b, 0) : null; }
function measured(rows, getter, gaps) {
  const deltas = rows.filter(r => r.kind === 'delta' && getter(r) !== null);
  const cumulative = rows.filter(r => r.kind === 'cumulative' && getter(r) !== null);
  if (!cumulative.length) return sum(deltas.map(getter));
  cumulative.sort((a,b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  let high = 0;
  for (const r of cumulative) { if (getter(r) < high) gaps.add('counter_decreased'); high = Math.max(high, getter(r)); }
  const latest = cumulative.at(-1);
  if (!latest.timestamp || deltas.some(r => !r.timestamp)) {
    if (deltas.length) gaps.add('overlap_without_timestamp');
    return Math.max(high, sum(deltas.map(getter)) || 0);
  }
  const before = deltas.filter(r => r.timestamp <= latest.timestamp);
  const after = deltas.filter(r => r.timestamp > latest.timestamp);
  return Math.max(high, sum(before.map(getter)) || 0) + (sum(after.map(getter)) || 0);
}
function sessionTotals(rows, gaps) {
  // A turn summary overlaps its identified calls. Reconcile it inside that turn
  // first, then reconcile session snapshots across all turns. With no turn IDs,
  // independent detailed/summary streams are compared, never blindly added.
  const calls = rows.filter(r => r.scope === 'call');
  const turns = rows.filter(r => r.scope === 'turn');
  const snapshots = rows.filter(r => r.scope === 'session');
  const result = {};
  const metric = getter => {
    const turnGroups = new Map();
    for (const r of [...calls, ...turns]) {
      const key = r.turnId || (r.scope === 'call' ? `call:${r.identity}` : `turn:${r.identity}`);
      if (!turnGroups.has(key)) turnGroups.set(key, []);
      turnGroups.get(key).push(r);
    }
    const reconciled = [];
    for (const [key, rs] of turnGroups) {
      const detail = rs.filter(r => r.scope === 'call');
      const summary = rs.filter(r => r.scope === 'turn');
      const a = measured(detail, getter, gaps), b = measured(summary, getter, gaps);
      reconciled.push({ ...rs.at(-1), kind: 'delta', timestamp: rs.map(r=>r.timestamp).filter(Boolean).sort().at(-1) || null, _value: a === null ? b : b === null ? a : Math.max(a,b), _key: key });
    }
    if (calls.some(r => !r.turnId) && turns.length) {
      const callTotal = measured(calls, getter, gaps), turnTotal = measured(turns, getter, gaps);
      gaps.add('turn_call_overlap');
      reconciled.splice(0, reconciled.length, { kind: 'delta', timestamp: null, _value: callTotal === null ? turnTotal : turnTotal === null ? callTotal : Math.max(callTotal, turnTotal) });
    }
    return measured([...reconciled, ...snapshots.map(r => ({ ...r, _value: getter(r) }))], r => r._value, gaps);
  };
  for (const k of METRICS) result[k] = metric(r => r.metrics[k]);
  const moneyTotals = kind => {
    const units = unique(rows.map(r => r[kind].amount !== null ? r[kind].unit || 'unknown' : null));
    return units.map(unit => ({ unit: unit === 'unknown' ? null : unit, amount: metric(r => (r[kind].unit || 'unknown') === unit ? r[kind].amount : null) }));
  };
  return { metrics: result, charges: moneyTotals('charge'), estimates: moneyTotals('estimate') };
}

export function reportUsage(input = {}) {
  const options = defaults(input);
  const groupBy = input.groupBy || ['taskId', 'agent', 'provider', 'accountPoolId', 'model'];
  const allowed = ['taskId','agent','provider','accountPoolId','model','profileId','route','billingSource','sessionId'];
  if (!Array.isArray(groupBy) || groupBy.some(k => !allowed.includes(k))) throw new Error('invalid_usage_group');
  const gaps = new Set();
  const rows = [];
  const budget = { count: 0, max: options.limits.maxRows + 512 };
  walk(path.join(options.dir, 'rows'), budget, f => {
    if (!f.endsWith('.json')) return;
    if (rows.length >= options.limits.maxRows) { budget.exhausted = true; gaps.add('report_row_limit'); return; }
    try { const r = json(f, 65536); if (r?.schema === 1) rows.push(r); else gaps.add('invalid_committed_row'); }
    catch { gaps.add('invalid_committed_row'); }
  });
  if (budget.exhausted) gaps.add('report_scan_limit');
  const records = coalesce(rows);
  const measuredSessions = new Set(records.filter(r => r.scope !== 'account' && r.kind !== 'unknown' && r.metrics.inputTokens !== null && r.metrics.outputTokens !== null).flatMap(r => unique([r.sessionId,r.sessionKey]).map(k => `${r.agent}:${k}`)));
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.source === 'native-status' && unique([r.sessionId,r.sessionKey]).some(k => measuredSessions.has(`${r.agent}:${k}`))) records.splice(i,1);
  }
  if (input.taskId) {
    const wanted = label(input.taskId);
    if (!wanted) throw new Error('invalid_usage_task');
    const selected = records.filter(r => r.taskId === wanted);
    const accounts = records.filter(r => r.scope === 'account' && selected.some(s => s.agent === r.agent && (!s.accountPoolId || !r.accountPoolId || s.accountPoolId === r.accountPoolId)));
    if (!selected.length) gaps.add('task_usage_missing');
    records.splice(0, records.length, ...selected, ...accounts);
  }
  const accountSeries = new Map();
  for (const r of records.filter(r => r.scope === 'account')) {
    const key = JSON.stringify([r.accountId || r.profileId, r.agent, r.provider, r.accountPoolId, r.source]);
    const prior = accountSeries.get(key);
    if (!prior || (r.timestamp || '') >= (prior.timestamp || '')) accountSeries.set(key, r);
  }
  const accountSnapshots = [...accountSeries.values()].map(r => ({ agent: r.agent, provider: r.provider, accountPoolId: r.accountPoolId, billingSource: r.billingSource, timestamp: r.timestamp, balance: r.balance, allowance: r.allowance ?? null, metrics: r.metrics, charge: r.charge, source: r.source, apiSource: r.apiSource ?? null, accountingWindow: r.accountingWindow ?? null }));
  const sessionRecords = new Map();
  for (const r of records.filter(r => r.scope !== 'account')) {
    const key = JSON.stringify([r.sessionId || r.sessionKey || r.identity, r.agent, r.counterEpoch]);
    if (!sessionRecords.has(key)) sessionRecords.set(key, []);
    sessionRecords.get(key).push(r);
  }
  const dimensionsToReconcile = unique(['taskId','provider','accountPoolId','model',...groupBy]);
  const unallocatedSummaries = [];
  const taskGaps = new Map();
  const markTaskGap = (taskId, gap) => { if (taskId) { if (!taskGaps.has(taskId)) taskGaps.set(taskId, new Set()); taskGaps.get(taskId).add(gap); } };
  const sessions = new Map();
  for (const rs of sessionRecords.values()) {
    // A missing model/task in a session summary can inherit the sole observed
    // value. Multiple possible values cannot be allocated by guessing: retain
    // that reported summary separately and mark the attribution gap explicitly.
    const values = Object.fromEntries(dimensionsToReconcile.map(k => [k, unique(rs.map(r => r[k]))]));
    for (const r of rs) {
      for (const k of dimensionsToReconcile) if (r[k] === null && values[k].length === 1) r[k] = values[k][0];
      if (r.scope === 'session' && dimensionsToReconcile.some(k => r[k] === null && values[k].length > 1)) {
        unallocatedSummaries.push({ agent: r.agent, source: r.source, timestamp: r.timestamp, metrics: r.metrics, charge: r.charge, reason: 'ambiguous_summary_attribution' });
        gaps.add('ambiguous_summary_attribution');
        markTaskGap(r.taskId, 'ambiguous_summary_attribution');
        continue;
      }
      const key = JSON.stringify([r.sessionId || r.sessionKey || r.identity, r.agent, r.counterEpoch, ...dimensionsToReconcile.map(k => r[k])]);
      if (!sessions.has(key)) sessions.set(key, []);
      sessions.get(key).push(r);
    }
  }
  const groups = new Map();
  for (const rs of sessions.values()) {
    const representative = { ...rs[0] };
    for (const k of groupBy) representative[k] = first(...rs.map(r => r[k]));
    const dimensions = Object.fromEntries(groupBy.map(k => [k, representative[k] ?? null]));
    const key = JSON.stringify(dimensions);
    if (!groups.has(key)) {
      if (groups.size >= options.limits.maxGroups) { gaps.add('report_group_limit'); continue; }
      groups.set(key, { ...dimensions, observations: 0, requests: 0, sessions: 0, metrics: Object.fromEntries(METRICS.map(k => [k, null])), unknown: Object.fromEntries(METRICS.map(k => [k, 0])), charges: [], estimates: [], unknownCharges: 0, sources: [], billingSources: [], reportedModels: [], gaps: [] });
    }
    const g = groups.get(key), sg = new Set();
    const totals = sessionTotals(rs, sg);
    g.observations += rs.length; g.requests += rs.filter(r => r.scope === 'call').length; g.sessions++;
    const cumulativeRows = rs.filter(s => s.scope === 'session' && s.kind === 'cumulative');
    const coveredBy = (r, predicate) => cumulativeRows.some(s => predicate(s) && (s.accountingWindow?.complete === true || s.timestamp && r.timestamp && s.timestamp >= r.timestamp));
    for (const k of METRICS) { g.metrics[k] = sum([g.metrics[k], totals.metrics[k]]); g.unknown[k] += rs.filter(r => r.metrics[k] === null && !coveredBy(r, s => s.metrics[k] !== null)).length; }
    for (const field of ['charges','estimates']) for (const m of totals[field]) { const prior = g[field].find(p => p.unit === m.unit); if (prior) prior.amount = sum([prior.amount, m.amount]); else g[field].push({ ...m }); }
    g.unknownCharges += rs.filter(r => r.charge.amount === null && !coveredBy(r, s => s.charge.amount !== null)).length;
    g.sources = unique([...g.sources, ...rs.flatMap(r => r.sources)]);
    g.billingSources = unique([...g.billingSources, ...rs.flatMap(r => r.billingSources)]);
    g.reportedModels = unique([...g.reportedModels, ...rs.flatMap(r => r.reportedModels)]);
    if (rs.some(r => r.kind === 'unknown')) sg.add('unknown_usage_semantics');
    if (rs.some(r => r.conflicts.length)) sg.add('conflicting_measurements');
    g.gaps = unique([...g.gaps, ...sg]);
    for (const taskId of unique(rs.map(r => r.taskId))) for (const gap of sg) markTaskGap(taskId, gap);
  }
  let collection = null;
  try { collection = json(path.join(options.dir, 'collection.json')); } catch { gaps.add('invalid_collection_state'); }
  if (!rows.length) gaps.add('no_usage_records');
  if (collection?.gaps) for (const g of collection.gaps) gaps.add(g);
  let accountCollection = null;
  try { accountCollection = json(path.join(options.dir, 'cursor-account-sync.json')); } catch { gaps.add('invalid_account_collection_state'); }
  for (const g of accountCollection?.gaps || []) gaps.add(g);
  for (const g of groups.values()) g.completeness = {
    'tokens': g.metrics.inputTokens === null && g.metrics.outputTokens === null ? 'unknown' : g.unknown.inputTokens || g.unknown.outputTokens ? 'partial' : 'reported',
    charges: g.charges.length === 0 ? 'unknown' : g.unknownCharges || g.charges.some(c => c.unit === null) ? 'partial' : 'reported',
    attribution: groupBy.some(k => g[k] === null) ? 'partial' : 'reported',
  };
  const tasks = new Map();
  for (const r of records) if (r.taskId && r.scope !== 'account') { if (!tasks.has(r.taskId)) tasks.set(r.taskId, []); tasks.get(r.taskId).push(r); }
  const taskAccounting = [...tasks].map(([taskId, rs]) => {
    const status = predicate => {
      const known = rs.filter(r => r.kind !== 'unknown' && predicate(r));
      if (!known.length) return 'unknown';
      const covered = r => known.some(s => s.kind === 'cumulative' && s.scope === 'session' && s.sessionId === r.sessionId && (s.accountingWindow?.complete === true || s.timestamp && r.timestamp && s.timestamp >= r.timestamp));
      return rs.every(r => (r.kind !== 'unknown' && predicate(r)) || covered(r)) ? 'reported' : 'partial';
    };
    const metrics = Object.fromEntries(METRICS.map(k => [k, status(r => r.metrics[k] !== null)]));
    const tokens = metrics.inputTokens === 'reported' && metrics.outputTokens === 'reported' ? 'reported' : metrics.inputTokens === 'unknown' && metrics.outputTokens === 'unknown' ? 'unknown' : 'partial';
    const charges = status(r => r.charge.amount !== null && r.charge.unit !== null);
    const reconciliationGaps = [...taskGaps.get(taskId) || []];
    return { taskId, agents: unique(rs.map(r => r.agent)), tokens, charges, metrics, complete: tokens === 'reported' && charges === 'reported' && reconciliationGaps.length === 0, sources: unique(rs.flatMap(r => r.sources)), apiSources: unique(rs.map(r => r.apiSource)), accountCheckedAt: rs.some(r => r.agent === 'cursor') ? accountCollection?.checkedAt ?? null : null, gaps: reconciliationGaps, missing: [tokens !== 'reported' ? 'tokens_not_fully_reported' : null, charges !== 'reported' ? 'charge_not_fully_reported' : null, reconciliationGaps.length ? 'accounting_reconciliation_gap' : null].filter(Boolean) };
  });
  return { schema: 1, generatedAt: new Date().toISOString(), complete: gaps.size === 0 && [...groups.values()].every(g => g.gaps.length === 0), accountingComplete: taskAccounting.length > 0 && taskAccounting.every(t => t.complete), taskAccounting, groupBy, observations: rows.length, deduplicatedRecords: records.length, groups: [...groups.values()], accountSnapshots, unallocatedSummaries, gaps: [...gaps], collection, accountCollection };
}
