// Native Pi binding only. Scheduling/qualification remains in execution-catalog/runtime.
// Verified against Pi 0.85.1 upstream provider documentation (product docs, not a file
// in this repository) and CLI --model provider/id.
// Both providers already exist in Pi: never write models-store.json to invent a provider.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

// Per provider, the exact (api, baseUrl) pairs Pi's own catalog may declare for that provider.
// More than one pair per provider is real: opencode-go serves some models over
// anthropic-messages at https://opencode.ai/zen/go while the rest use openai-completions
// at .../go/v1. A pair absent from this table is never accepted — the match is exact and
// comes from the matched catalog row, not from a provider-wide default.
// Providers are limited to literal api_key auth; an OAuth-only provider cannot be added here
// without weakening that rule (see inspectPiDirectProvider's entry.type check).
// anthropic is deliberately absent: it has no account behind it and it is not a pi leg at all.
// Claude rides mirasim and reclaude only (user, 2026-09-13) — adding it back here would offer
// dispatch a route that is ruled out by decision, not by a credential that might show up.
const NATIVE = Object.freeze({
  deepseek: Object.freeze([{ baseUrl: 'https://api.deepseek.com', api: 'openai-completions' }]),
  'opencode-go': Object.freeze([
    { baseUrl: 'https://opencode.ai/zen/go/v1', api: 'openai-completions' },
    { baseUrl: 'https://opencode.ai/zen/go/v1', api: 'openai-responses' },
    { baseUrl: 'https://opencode.ai/zen/go', api: 'anthropic-messages' },
  ]),
});
const samePair = (a, b) => !!a && !!b && a.api === b.api && String(a.baseUrl).replace(/\/+$/, '') === String(b.baseUrl).replace(/\/+$/, '');
const DAY = 86_400_000;
const COMMANDCODE_URL = 'http://127.0.0.1:4342/v1';
const COMMANDCODE_MODEL = 'deepseek/deepseek-v4-flash';
const cleanId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value);
const fail = reason => ({ ok: false, status: 'blocked', reason, launchSpec: null });
function json(file, read, optional = false) {
  try { return JSON.parse(read(file, 'utf8')); }
  catch (e) { if (optional && e.code === 'ENOENT') return null; throw new Error('native_config_unreadable'); }
}

function nativeContext(options) {
  const homeDir = options.homeDir ?? os.homedir();
  return { homeDir, agentDir: options.agentDir ?? path.join(homeDir, '.pi', 'agent'), read: options.read ?? fs.readFileSync };
}

function groupKeyValues(auth, gateway, { homeDir, read }) {
  const values = Object.entries(auth).filter(([id]) => id === 'gw' || id.startsWith('gw-')).map(([, v]) => v?.key);
  const files = new Set((gateway?.providers ?? []).map(p => p.keyFile).filter(p => typeof p === 'string'));
  // mycodex/pqapi are NOT intrinsically group keys: the migrated PQAPI sol key
  // matches mycodex.key and was accepted by the official provider's model endpoint.
  for (const id of ['opencode', 'cmdcode', 'windsurf', 'dspool', 'gptpool', 'grok', 'grokpool', 'sub']) files.add(path.join(homeDir, '.mirasim', 'keys', `${id}.key`));
  for (const file of files) {
    try { values.push(read(file.startsWith('~/') ? path.join(homeDir, file.slice(2)) : file, 'utf8').trim()); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('group_provenance_unreadable'); }
  }
  return values.filter(v => typeof v === 'string' && v.length > 0);
}

/** Safe native models.json plan for the separately deployed CommandCode adapter.
 * No provider is invented in models-store.json, no key value is copied, no file is written.
 * Pi officially resolves !command values at request time. /bin/cat receives a quoted
 * fixed private file path; its stdout stays inside Pi's auth resolver, never this result.
 * Only this explicit literal loopback endpoint permits HTTP with authentication.
 */
export function planPiAdapterConfiguration(profile, options = {}) {
  try {
    const d = profile?.piConnection;
    if (profile?.backend !== 'mirasim' || profile.agent !== 'pi' || profile.route !== 'local' || profile.provider !== 'commandcode' || !cleanId(profile.id) || !cleanId(profile.accountPoolId)) return fail('not_a_commandcode_adapter_profile');
    if (d?.schemaVersion !== 1 || d.kind !== 'pi-openai-adapter' || d.providerId !== 'commandcode-local' || profile.nativeProviderId !== d.providerId || d.modelId !== COMMANDCODE_MODEL || profile.model !== COMMANDCODE_MODEL || d.api !== 'openai-completions') return fail('adapter_descriptor_mismatch');
    if (d.baseUrl !== COMMANDCODE_URL || d.allowLoopbackHttp !== true) return fail('explicit_loopback_auth_required');
    if (d.keyRef?.kind !== 'file' || typeof d.keyRef.file !== 'string' || Object.keys(d.keyRef).some(k => !['kind', 'file'].includes(k))) return fail('unsupported_key_reference');
    const context = nativeContext(options), { homeDir, agentDir, read } = context;
    if (!path.isAbsolute(homeDir) || !path.isAbsolute(agentDir)) return fail('absolute_agent_directory_required');
    const env = options.env ?? process.env;
    if (env.PI_CODING_AGENT_DIR && path.resolve(env.PI_CODING_AGENT_DIR) !== path.resolve(agentDir)) return fail('pi_agent_directory_mismatch');
    const keyFile = path.resolve(d.keyRef.file.startsWith('~/') ? path.join(homeDir, d.keyRef.file.slice(2)) : d.keyRef.file);
    const keyRoot = path.join(homeDir, '.config', 'ai-gateway');
    const relative = path.relative(keyRoot, keyFile);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.basename(keyFile) !== 'commandcode.key' || !/^[a-zA-Z0-9_./-]+$/.test(keyFile)) return fail('adapter_key_file_outside_native_store');
    const key = read(keyFile, 'utf8').trim();
    if (!key || /\s|\$|^!/.test(key)) return fail('native_credential_not_literal');
    const auth = json(path.join(agentDir, 'auth.json'), read, true) ?? {};
    const gateway = json(path.join(agentDir, 'pi-gateway.json'), read, true);
    if (gateway?.providers?.some(p => p.id === d.providerId)) return fail('native_provider_shadowed_by_gateway');
    if (groupKeyValues(auth, gateway, context).includes(key)) return fail('credential_is_gateway_group');
    // auth.json takes priority over models.json's command resolver. Reject a conflicting entry.
    if (auth[d.providerId] && (auth[d.providerId].type !== 'api_key' || auth[d.providerId].key !== key)) return fail('adapter_auth_store_conflict');
    const modelSelector = `${d.providerId}/${COMMANDCODE_MODEL}`;
    if (profile.agentModel && profile.agentModel !== modelSelector) return fail('model_selector_mismatch');
    const providerConfig = {
      baseUrl: COMMANDCODE_URL, api: 'openai-completions', authHeader: true,
      models: [{ id: COMMANDCODE_MODEL, name: 'DeepSeek V4 Flash (CommandCode)', input: ['text'], reasoning: false,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' } }],
    };
    // A native config reference, not a copied credential value.
    providerConfig.apiKey = `!/bin/cat -- '${keyFile}'`;
    const file = path.join(agentDir, 'models.json'), existing = json(file, read, true);
    const installed = existing?.providers?.[d.providerId];
    // Never return unrelated native provider blocks: they may contain literal credentials.
    if (installed && !isDeepStrictEqual(installed, providerConfig)) return fail('adapter_provider_config_conflict');
    return {
      ok: true, status: 'configuration_plan',
      connection: { schemaVersion: 1, kind: d.kind, providerId: d.providerId, modelId: COMMANDCODE_MODEL, modelSelector, baseUrl: COMMANDCODE_URL, api: d.api, agentDir, keyRef: { kind: 'file', file: keyFile }, transport: { allowLoopbackHttp: true, origin: 'http://127.0.0.1:4342', authRequired: true, redirect: 'error' } },
      configuration: { required: !installed, mechanism: 'pi_official_models_json', file, merge: { providers: { [d.providerId]: providerConfig } }, writesPerformed: false,
        billingPolicy: { piCostEstimate: 'ignore', actualCost: null, reason: 'custom_model_price_unknown_Pi_defaults_are_not_account_billing' } },
      evidence: { scope: 'native_configuration_only', executionVerified: false, billingVerified: false },
    };
  } catch (error) { return fail(error.code === 'ENOENT' ? 'adapter_credential_missing' : 'adapter_configuration_unreadable'); }
}

/** Reads credentials in memory, returns only a descriptor. Does not execute Pi or write files.
 * keyRef schema: {kind:'pi-auth', providerId:'deepseek'|'opencode-go'}.
 * The file is always <agentDir>/auth.json and its entry must be a literal api_key.
 * No custom path, command expansion, env-key override or credential value is accepted.
 */
export function inspectPiDirectProvider(profile, options = {}) {
  if (profile?.piConnection?.kind === 'pi-openai-adapter') {
    const planned = planPiAdapterConfiguration(profile, options);
    if (!planned.ok) return planned;
    return planned.configuration.required ? { ...planned, ok: false, status: 'configuration_required', reason: 'install_native_models_config', launchSpec: null } : { ...planned, status: 'prepared' };
  }
  try {
    if (!profile || profile.backend !== 'mirasim' || profile.agent !== 'pi' || profile.route !== 'local' || !cleanId(profile.id) || !cleanId(profile.accountPoolId)) return fail('not_a_native_pi_profile');
    const providerId = profile.nativeProviderId ?? profile.piConnection?.providerId;
    if (!Object.hasOwn(NATIVE, providerId) || profile.provider !== providerId) return fail('unsupported_native_provider');
    const native = NATIVE[providerId], modelId = profile.model;
    if (!cleanId(modelId)) return fail('exact_upstream_model_required');
    const modelSelector = `${providerId}/${modelId}`;
    if (profile.agentModel && profile.agentModel !== modelSelector) return fail('model_selector_mismatch');
    // The descriptor must name a pair this provider is allowed to serve. Which one is not
    // re-derived from the provider: the catalog row below must agree with it exactly.
    const declared = profile.piConnection;
    const pinned = declared && samePair({ api: declared.api, baseUrl: declared.baseUrl }, declared) ? native.find(n => samePair(n, declared)) : native[0];
    if (declared && (declared.schemaVersion !== 1 || declared.kind !== 'pi-native' || declared.providerId !== providerId || declared.modelId !== modelId || !pinned)) return fail('connection_descriptor_mismatch');
    if (declared?.keyRef && (Object.keys(declared.keyRef).some(k => !['kind', 'providerId'].includes(k)) || declared.keyRef.kind !== 'pi-auth' || declared.keyRef.providerId !== providerId)) return fail('unsupported_key_reference');
    const context = nativeContext(options);
    if (!path.isAbsolute(context.homeDir) || !path.isAbsolute(context.agentDir)) return fail('absolute_agent_directory_required');
    // Mirasim must launch under this same native Pi home. A global override could reroute it.
    const env = options.env ?? process.env;
    if (env.PI_CODING_AGENT_DIR && path.resolve(env.PI_CODING_AGENT_DIR) !== path.resolve(context.agentDir)) return fail('pi_agent_directory_mismatch');
    const { read, agentDir } = context;
    const auth = json(path.join(agentDir, 'auth.json'), read);
    const entry = auth?.[providerId];
    if (entry?.type !== 'api_key' || typeof entry.key !== 'string' || !entry.key.trim()) return fail('native_credential_missing');
    // Pi supports richer config-value syntax elsewhere; this helper deliberately uses literal native auth.
    if (/\s|\$|^!/.test(entry.key)) return fail('native_credential_not_literal');
    const gateway = json(path.join(agentDir, 'pi-gateway.json'), read, true);
    if (gateway?.providers?.some(p => p.id === providerId)) return fail('native_provider_shadowed_by_gateway');
    if (groupKeyValues(auth, gateway, context).includes(entry.key)) return fail('credential_is_gateway_group');
    const custom = json(path.join(agentDir, 'models.json'), read, true);
    if (custom?.providers && Object.hasOwn(custom.providers, providerId)) return fail('native_provider_has_custom_override');
    const store = json(path.join(agentDir, 'models-store.json'), read);
    const catalog = store?.[providerId];
    const ageMs = (options.now ?? Date.now()) - (typeof catalog?.checkedAt === 'number' ? catalog.checkedAt : Date.parse(catalog?.checkedAt));
    const maxAgeMs = options.catalogMaxAgeMs ?? DAY;
    if (!Number.isFinite(ageMs) || ageMs < 0 || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || ageMs > maxAgeMs) return fail('native_catalog_not_fresh');
    const rows = Array.isArray(catalog.models) ? catalog.models : Object.values(catalog.models ?? {});
    const matches = rows.filter(m => m?.id === modelId);
    if (matches.length !== 1) return fail('exact_model_not_in_native_catalog');
    const model = matches[0];
    if (model.provider !== providerId || !native.some(n => samePair(n, model))) return fail('native_model_endpoint_mismatch');
    const endpoint = native.find(n => samePair(n, model));
    return {
      ok: true, status: 'prepared',
      connection: { schemaVersion: 1, kind: 'pi-native', providerId, modelId, modelSelector, baseUrl: endpoint.baseUrl, api: endpoint.api, agentDir, keyRef: { kind: 'pi-auth', providerId }, catalogCheckedAt: new Date(Number.isFinite(catalog.checkedAt) ? catalog.checkedAt : Date.parse(catalog.checkedAt)).toISOString() },
      configuration: { required: false, mechanism: 'existing_native_provider_and_auth_store', agentDir },
      evidence: { scope: 'native_configuration_only', executionVerified: false, billingVerified: false },
    };
  } catch (error) {
    return fail(['group_provenance_unreadable', 'native_config_unreadable'].includes(error.message) ? error.message : 'native_config_invalid');
  }
}

/** Returns the exact spec to pass to Mirasim, not a bare model resolved through Pi's gw default.
 * This is preparation: it does not enable a disabled profile or bypass the runtime admission gate.
 * Main must ensure Mirasim's service home/PI_CODING_AGENT_DIR matches configuration.agentDir.
 */
export function preparePiDirectLaunch(profile, request = {}, options = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return fail('invalid_launch_request');
  const inspected = inspectPiDirectProvider(profile, options);
  if (!inspected.ok) return inspected;
  const c = inspected.connection;
  if ((request.route && request.route !== 'local') || (request.provider && request.provider !== profile.provider) || (request.agent && request.agent !== 'pi') || (request.profileId && request.profileId !== profile.id) || (request.profile && request.profile !== profile.id) || (request.accountPoolId && request.accountPoolId !== profile.accountPoolId)) return fail('launch_route_conflict');
  if (request.model && ![c.modelId, c.modelSelector].includes(request.model)) return fail('launch_model_conflict');
  const launchSpec = Object.fromEntries(['workdir', 'prompt', 'effort', 'clientRef', 'taskId', 'issue', 'pr'].filter(k => request[k] !== undefined).map(k => [k, request[k]]));
  Object.assign(launchSpec, { agent: 'pi', model: c.modelSelector, route: 'local', profileId: profile.id, provider: profile.provider, nativeProviderId: c.providerId, accountPoolId: profile.accountPoolId });
  return { ...inspected, launchSpec, cliArgs: ['--model', c.modelSelector] };
}

const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function usageSummary(usage) {
  return { inputTokens: numberOrNull(usage?.prompt_tokens), outputTokens: numberOrNull(usage?.completion_tokens), totalTokens: numberOrNull(usage?.total_tokens), cachedInputTokens: numberOrNull(usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens), reasoningTokens: numberOrNull(usage?.completion_tokens_details?.reasoning_tokens) };
}

/** Explicit, bounded opt-in verification: ONE HTTP request, no retry, no actual tool execution.
 * Verifies a synthetic function call and nonce; never prints/returns generated text, IDs or headers.
 * Default runtime preparation never invokes this function. Unit tests must inject fetch/read.
 * This is direct HTTP evidence, not Mirasim/Pi execution or quality/billing qualification.
 */
export async function probePiDirectTools(profile, options = {}) {
  if (options.allowLiveRequest !== true) return { ok: false, status: 'blocked', reason: 'explicit_probe_opt_in_required' };
  const prepared = inspectPiDirectProvider(profile, options);
  if (!prepared.ok) return prepared;
  const maxTokens = options.maxTokens ?? 96, timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 32 || maxTokens > 128 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 20_000) return { ok: false, status: 'blocked', reason: 'invalid_probe_bounds' };
  const c = prepared.connection, context = nativeContext(options);
  const nonce = randomBytes(8).toString('hex');
  const body = {
    model: c.modelId, stream: false, max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: `Call dao_connection_probe once with nonce ${nonce}. No prose.` }],
    tools: [{ type: 'function', function: { name: 'dao_connection_probe', description: 'Returns a test nonce; no external effects.', parameters: { type: 'object', properties: { nonce: { type: 'string', enum: [nonce] } }, required: ['nonce'], additionalProperties: false } } }],
    tool_choice: { type: 'function', function: { name: 'dao_connection_probe' } },
  };
  const started = performance.now();
  let httpStatus = null, usage = usageSummary(null);
  const receipt = (ok, reason) => ({ ok, status: ok ? 'verified' : 'failed', reason, scope: 'direct_http_tool_protocol', elapsedMs: Math.round(performance.now() - started), httpStatus, usage, actualCost: null, costStatus: 'unknown', executionProfilePromoted: false });
  try {
    const auth = json(path.join(context.agentDir, 'auth.json'), context.read, c.kind === 'pi-openai-adapter') ?? {};
    const entry = c.keyRef.kind === 'file' ? { type: 'api_key', key: context.read(c.keyRef.file, 'utf8').trim() } : auth?.[c.providerId];
    const gateway = json(path.join(context.agentDir, 'pi-gateway.json'), context.read, true);
    // Validate the exact captured value to transmit, rather than a second read's value.
    if (entry?.type !== 'api_key' || typeof entry.key !== 'string' || !entry.key || /\s|\$|^!/.test(entry.key) || groupKeyValues(auth, gateway, context).includes(entry.key)) return receipt(false, 'native_configuration_changed');
    const response = await (options.fetchImpl ?? fetch)(`${c.baseUrl}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${entry.key}` }, body: JSON.stringify(body),
    });
    httpStatus = response.status;
    if (!response.ok) { await response.body?.cancel(); return receipt(false, response.status === 402 ? 'provider_payment_required' : [401, 403].includes(response.status) ? 'provider_auth_or_plan_rejected' : 'provider_http_error'); }
    const data = await response.json();
    usage = usageSummary(data?.usage);
    if (data?.error || data.model !== c.modelId) return receipt(false, 'provider_response_mismatch');
    const choice = data?.choices?.[0], calls = choice?.message?.tool_calls;
    if (choice?.finish_reason !== 'tool_calls' || !Array.isArray(calls) || calls.length !== 1 || calls[0].type !== 'function' || calls[0].function?.name !== 'dao_connection_probe') return receipt(false, 'tool_protocol_not_verified');
    let args; try { args = JSON.parse(calls[0].function.arguments); } catch { return receipt(false, 'tool_arguments_invalid'); }
    if (args?.nonce !== nonce || Object.keys(args).length !== 1) return receipt(false, 'tool_arguments_invalid');
    return receipt(true, 'bounded_tool_call_complete');
  } catch (error) {
    return receipt(false, ['AbortError', 'TimeoutError'].includes(error.name) ? 'probe_timeout' : 'probe_transport_or_parse_failed');
  }
}
