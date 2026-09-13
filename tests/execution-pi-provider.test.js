// Injected filesystem and fetch only: no production credentials, network or Pi process.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = import('../scripts/lib/execution-pi-provider.mjs');
const NOW = Date.parse('2026-09-09T16:00:00Z');
const TEST_CREDENTIAL = 'native-test-value';

function setup(provider = 'deepseek') {
  const baseUrl = provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://opencode.ai/zen/go/v1';
  const p = { id: `${provider}-direct`, backend: 'mirasim', agent: 'pi', model: 'deepseek-v4-flash', route: 'local', provider, nativeProviderId: provider, agentModel: `${provider}/deepseek-v4-flash`, accountPoolId: `${provider}-pool`, enabled: false, availability: { status: 'unverified' } };
  const files = new Map([
    ['/fiction/.pi/agent/auth.json', { [provider]: { type: 'api_key', key: 'native-test-value' }, gw: { type: 'api_key', key: 'group-test-value' } }],
    ['/fiction/.pi/agent/models-store.json', { [provider]: { checkedAt: NOW, models: [{ id: p.model, provider, api: 'openai-completions', baseUrl }] } }],
    ['/fiction/.pi/agent/settings.json', { defaultProvider: 'gw', defaultModel: 'grok-4.6' }],
  ]);
  const reads = [];
  const options = { homeDir: '/fiction', now: NOW, env: {}, read: file => {
    reads.push(file);
    if (!files.has(file)) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    const value = files.get(file); return typeof value === 'string' ? value : JSON.stringify(value);
  } };
  return { p, files, options, reads, provider, baseUrl };
}
function adapterSetup() {
  const s = setup();
  s.p = { id: 'commandcode-deepseek', backend: 'mirasim', agent: 'pi', model: 'deepseek/deepseek-v4-flash', provider: 'commandcode', nativeProviderId: 'commandcode-local', agentModel: 'commandcode-local/deepseek/deepseek-v4-flash', route: 'local', accountPoolId: 'commandcode-subscription', enabled: false,
    piConnection: { schemaVersion: 1, kind: 'pi-openai-adapter', providerId: 'commandcode-local', modelId: 'deepseek/deepseek-v4-flash', baseUrl: 'http://127.0.0.1:4342/v1', api: 'openai-completions', allowLoopbackHttp: true, keyRef: { kind: 'file', file: '~/.config/ai-gateway/migration-1174/commandcode.key' } } };
  s.files.set('/fiction/.config/ai-gateway/migration-1174/commandcode.key', TEST_CREDENTIAL);
  return s;
}
const reply = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
function success(request, mutate = () => {}) {
  const body = JSON.parse(request.body);
  const data = { model: body.model, choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: { name: 'dao_connection_probe', arguments: JSON.stringify({ nonce: body.tools[0].function.parameters.properties.nonce.enum[0] }) } }] } }], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32, prompt_cache_hit_tokens: 5 } };
  mutate(data); return reply(data);
}

test('prepares both genuine Pi provider/model selectors, local route, original account pool and no secret', async () => {
  const { preparePiDirectLaunch } = await lib;
  for (const id of ['deepseek', 'opencode-go']) {
    const { p, options, files } = setup(id), before = JSON.stringify([...files]);
    const r = preparePiDirectLaunch(p, { workdir: '/task', prompt: 'Inspect files', model: 'deepseek-v4-flash', apiKey: 'must-not-forward' }, options);
    assert.equal(r.ok, true); assert.equal(r.launchSpec.model, `${id}/deepseek-v4-flash`);
    assert.equal(r.launchSpec.route, 'local'); assert.equal(r.launchSpec.agent, 'pi');
    assert.equal(r.launchSpec.profileId, p.id); assert.equal(r.launchSpec.accountPoolId, p.accountPoolId);
    assert.deepEqual(r.cliArgs, ['--model', `${id}/deepseek-v4-flash`]);
    assert.equal(r.configuration.required, false); assert.equal(r.evidence.executionVerified, false);
    assert.equal(p.enabled, false, 'preparation does not enable a candidate');
    assert.equal(JSON.stringify([...files]), before);
    assert.ok(!/native-test-value|group-test-value|must-not-forward/.test(JSON.stringify(r)));
  }
});

test('rejects foreign providers, opaque models, prefix/route/model overrides and arbitrary key references', async () => {
  const { preparePiDirectLaunch } = await lib;
  for (const patch of [{ nativeProviderId: 'gw' }, { provider: 'reseller' }, { route: 'cloud' }, { backend: 'acp' }, { model: 'deepseek/v4-flash' }, { model: 'flash*' }, { agentModel: 'gw-dspool/deepseek-v4-flash' }]) {
    const s = setup(); Object.assign(s.p, patch); assert.equal(preparePiDirectLaunch(s.p, {}, s.options).ok, false);
  }
  for (const request of [{ route: 'cloud' }, { route: 'auto' }, { model: 'deepseek-v4-pro' }, { provider: 'gw' }, { agent: 'codex' }, { profileId: 'other' }, { accountPoolId: 'other' }]) {
    const s = setup(); assert.equal(preparePiDirectLaunch(s.p, request, s.options).ok, false);
  }
  const s = setup(); s.p.piConnection = { schemaVersion: 1, kind: 'pi-native', providerId: 'deepseek', modelId: s.p.model, api: 'openai-completions', baseUrl: s.baseUrl, keyRef: { kind: 'pi-auth', providerId: 'deepseek', file: '/somewhere/secret' } };
  assert.equal(preparePiDirectLaunch(s.p, {}, s.options).reason, 'unsupported_key_reference');
});

test('missing/malformed/command/env native credentials and copied gateway credentials fail closed', async () => {
  const { inspectPiDirectProvider } = await lib;
  for (const key of ['', '!print-a-key', '${NATIVE_KEY}', 'has\nnewline', 'group-test-value']) {
    const s = setup(); s.files.get('/fiction/.pi/agent/auth.json').deepseek.key = key;
    assert.equal(inspectPiDirectProvider(s.p, s.options).ok, false);
  }
  const s = setup(); s.files.set('/fiction/.mirasim/keys/opencode.key', 'native-test-value');
  assert.equal(inspectPiDirectProvider(s.p, s.options).reason, 'credential_is_gateway_group');
  s.files.delete('/fiction/.pi/agent/auth.json');
  assert.equal(inspectPiDirectProvider(s.p, s.options).reason, 'native_config_unreadable');
});

test('native model registry must contain an exact fresh unique model on the official endpoint', async () => {
  const { inspectPiDirectProvider } = await lib;
  for (const mutate of [c => { c.checkedAt = NOW - 2 * 86_400_000; }, c => { c.checkedAt = NOW + 1; }, c => { delete c.checkedAt; }, c => { c.models[0].id = 'deepseek-v4-pro'; }, c => { c.models[0].baseUrl = 'https://reseller.example/v1'; }, c => { c.models[0].provider = 'gw'; }, c => { c.models[0].api = 'anthropic-messages'; }, c => { c.models.push(c.models[0]); }]) {
    const s = setup(); mutate(s.files.get('/fiction/.pi/agent/models-store.json').deepseek);
    assert.equal(inspectPiDirectProvider(s.p, s.options).ok, false);
  }
});

test('native provider shadowing, custom overrides, wrong Pi home and unreadable provenance are explicit blockers', async () => {
  const { inspectPiDirectProvider } = await lib;
  const s = setup(); s.files.set('/fiction/.pi/agent/models.json', { providers: { deepseek: { baseUrl: 'https://api.deepseek.com' } } });
  assert.equal(inspectPiDirectProvider(s.p, s.options).reason, 'native_provider_has_custom_override');
  s.files.delete('/fiction/.pi/agent/models.json'); s.files.set('/fiction/.pi/agent/pi-gateway.json', { providers: [{ id: 'deepseek' }] });
  assert.equal(inspectPiDirectProvider(s.p, s.options).reason, 'native_provider_shadowed_by_gateway');
  s.files.delete('/fiction/.pi/agent/pi-gateway.json');
  assert.equal(inspectPiDirectProvider(s.p, { ...s.options, env: { PI_CODING_AGENT_DIR: '/another' } }).reason, 'pi_agent_directory_mismatch');
  const read = s.options.read;
  assert.equal(inspectPiDirectProvider(s.p, { ...s.options, read: file => { if (file.endsWith('opencode.key')) throw Object.assign(new Error('private path and key'), { code: 'EACCES' }); return read(file); } }).reason, 'group_provenance_unreadable');
});

test('tool probe requires explicit opt-in and bounded limits, never retries', async () => {
  const { probePiDirectTools } = await lib;
  const s = setup(), noFetch = () => assert.fail('no network expected');
  assert.equal((await probePiDirectTools(s.p, { ...s.options, fetchImpl: noFetch })).reason, 'explicit_probe_opt_in_required');
  for (const limits of [{ maxTokens: 1000 }, { timeoutMs: 60000 }, { maxTokens: -1 }]) assert.equal((await probePiDirectTools(s.p, { ...s.options, ...limits, allowLiveRequest: true, fetchImpl: noFetch })).reason, 'invalid_probe_bounds');
  let count = 0;
  const r = await probePiDirectTools(s.p, { ...s.options, allowLiveRequest: true, fetchImpl: async () => { count++; return new Response('private upstream account details', { status: 403 }); } });
  assert.equal(count, 1); assert.equal(r.ok, false); assert.equal(r.reason, 'provider_auth_or_plan_rejected');
  assert.ok(!JSON.stringify(r).includes('private'));
});

test('real tool-call protocol, finish and nonce all required; receipt includes usage but no text or credentials', async () => {
  const { probePiDirectTools } = await lib;
  for (const provider of ['deepseek', 'opencode-go']) {
    const s = setup(provider);
    const r = await probePiDirectTools(s.p, { ...s.options, allowLiveRequest: true, fetchImpl: async (url, req) => {
      assert.equal(url, `${s.baseUrl}/chat/completions`); assert.equal(req.method, 'POST'); assert.equal(req.redirect, 'error');
      assert.equal(req.headers.Authorization, `Bearer ${TEST_CREDENTIAL}`); assert.ok(req.signal);
      assert.equal(JSON.parse(req.body).max_tokens, 96);
      return success(req, d => { d.choices[0].message.content = 'private text'; d.account_id = 'private account'; });
    } });
    assert.equal(r.ok, true); assert.equal(r.scope, 'direct_http_tool_protocol');
    assert.deepEqual(r.usage, { inputTokens: 20, outputTokens: 12, totalTokens: 32, cachedInputTokens: 5, reasoningTokens: null });
    assert.equal(r.actualCost, null); assert.equal(r.executionProfilePromoted, false);
    assert.ok(!/private|native-test-value/.test(JSON.stringify(r)));
  }
});

test('empty/unfinished/wrong model or tool arguments, missing usage and transport errors never become green/free', async () => {
  const { probePiDirectTools } = await lib;
  for (const mutate of [d => { d.choices = []; }, d => { d.choices[0].finish_reason = 'length'; }, d => { d.model = 'different-model'; }, d => { delete d.model; }, d => { d.choices[0].message.tool_calls[0].function.arguments = '{}'; }, d => { d.choices[0].message.tool_calls[0].function.name = 'other'; }]) {
    const s = setup(); const r = await probePiDirectTools(s.p, { ...s.options, allowLiveRequest: true, fetchImpl: async (_, req) => success(req, mutate) });
    assert.equal(r.ok, false); assert.equal(r.actualCost, null);
  }
  const s = setup();
  let r = await probePiDirectTools(s.p, { ...s.options, allowLiveRequest: true, fetchImpl: async (_, req) => success(req, d => { delete d.usage; }) });
  assert.equal(r.usage.totalTokens, null); assert.equal(r.actualCost, null);
  r = await probePiDirectTools(s.p, { ...s.options, allowLiveRequest: true, fetchImpl: async () => { throw new Error('secret echoed in upstream error'); } });
  assert.equal(r.ok, false); assert.ok(!JSON.stringify(r).includes('secret'));
});

test('credential changing after preparation is checked against the exact value to transmit', async () => {
  const { probePiDirectTools } = await lib;
  const s = setup(), read = s.options.read; let authReads = 0;
  const r = await probePiDirectTools(s.p, { ...s.options, allowLiveRequest: true, read: file => {
    if (file.endsWith('/auth.json') && ++authReads > 1) return JSON.stringify({ deepseek: { type: 'api_key', key: 'group-test-value' }, gw: { type: 'api_key', key: 'group-test-value' } });
    return read(file);
  }, fetchImpl: () => assert.fail('changed group credential must not leave for upstream') });
  assert.equal(r.ok, false); assert.equal(r.reason, 'native_configuration_changed');
});

test('CommandCode plan uses official models.json request-time key resolution, does not write or expose secrets', async () => {
  const { planPiAdapterConfiguration, preparePiDirectLaunch } = await lib;
  const s = adapterSetup();
  s.files.set('/fiction/.pi/agent/models.json', { providers: { unrelated: { apiKey: 'private-unrelated-value' } } });
  const before = JSON.stringify([...s.files]), r = planPiAdapterConfiguration(s.p, s.options);
  assert.equal(r.ok, true); assert.equal(r.configuration.required, true); assert.equal(r.configuration.writesPerformed, false);
  const config = r.configuration.merge.providers['commandcode-local'];
  assert.equal(config.baseUrl, 'http://127.0.0.1:4342/v1'); assert.equal(config.api, 'openai-completions');
  assert.equal(config.authHeader, true); assert.ok(config.apiKey.startsWith('!/bin/cat -- '));
  assert.deepEqual(config.models.map(m => m.id), ['deepseek/deepseek-v4-flash']);
  assert.equal(r.configuration.billingPolicy.actualCost, null); assert.equal(r.configuration.billingPolicy.piCostEstimate, 'ignore');
  assert.equal(JSON.stringify([...s.files]), before);
  assert.ok(!/native-test-value|private-unrelated-value/.test(JSON.stringify(r)));
  assert.equal(preparePiDirectLaunch(s.p, {}, s.options).status, 'configuration_required');
  // Install only in the in-memory fixture using Pi's real schema; no filesystem write.
  s.files.get('/fiction/.pi/agent/models.json').providers['commandcode-local'] = config;
  const ready = preparePiDirectLaunch(s.p, {}, s.options);
  assert.equal(ready.ok, true); assert.equal(ready.launchSpec.model, 'commandcode-local/deepseek/deepseek-v4-flash');
  assert.equal(ready.launchSpec.route, 'local'); assert.equal(ready.launchSpec.provider, 'commandcode');
  assert.equal(ready.launchSpec.nativeProviderId, 'commandcode-local');
  assert.equal(ready.connection.transport.authRequired, true);
});

test('loopback auth exception is explicit and restricted to the exact endpoint, with no untrusted key commands', async () => {
  const { planPiAdapterConfiguration } = await lib;
  for (const endpoint of ['http://localhost:4342/v1', 'http://127.0.0.1:3000/v1', 'http://127.0.0.1:4342/v1?next=remote', 'http://0.0.0.0:4342/v1', 'https://api.commandcode.ai/alpha/generate']) {
    const s = adapterSetup(); s.p.piConnection.baseUrl = endpoint;
    assert.equal(planPiAdapterConfiguration(s.p, s.options).reason, 'explicit_loopback_auth_required');
  }
  const s = adapterSetup(); delete s.p.piConnection.allowLoopbackHttp;
  assert.equal(planPiAdapterConfiguration(s.p, s.options).reason, 'explicit_loopback_auth_required');
  s.p.piConnection.allowLoopbackHttp = true; s.p.piConnection.keyRef.file = '/outside/commandcode.key';
  assert.equal(planPiAdapterConfiguration(s.p, s.options).reason, 'adapter_key_file_outside_native_store');
});

test('adapter conflicting auth/config does not silently choose a new billable route', async () => {
  const { planPiAdapterConfiguration } = await lib;
  const s = adapterSetup(); s.files.get('/fiction/.pi/agent/auth.json')['commandcode-local'] = { type: 'api_key', key: 'another-value' };
  assert.equal(planPiAdapterConfiguration(s.p, s.options).reason, 'adapter_auth_store_conflict');
  delete s.files.get('/fiction/.pi/agent/auth.json')['commandcode-local'];
  s.files.set('/fiction/.pi/agent/models.json', { providers: { 'commandcode-local': { baseUrl: 'https://another.example/v1' } } });
  assert.equal(planPiAdapterConfiguration(s.p, s.options).reason, 'adapter_provider_config_conflict');
});

test('CommandCode loopback probe remains authenticated, bounded, redirect-disabled and cost-unknown', async () => {
  const { planPiAdapterConfiguration, probePiDirectTools } = await lib;
  const s = adapterSetup(), plan = planPiAdapterConfiguration(s.p, s.options);
  s.files.set('/fiction/.pi/agent/models.json', plan.configuration.merge);
  const r = await probePiDirectTools(s.p, { ...s.options, allowLiveRequest: true, fetchImpl: async (url, req) => {
    assert.equal(url, 'http://127.0.0.1:4342/v1/chat/completions'); assert.equal(req.redirect, 'error');
    assert.equal(req.headers.Authorization, `Bearer ${TEST_CREDENTIAL}`);
    assert.equal(JSON.parse(req.body).model, 'deepseek/deepseek-v4-flash');
    return success(req);
  } });
  assert.equal(r.ok, true); assert.equal(r.actualCost, null); assert.equal(r.executionProfilePromoted, false);
});
