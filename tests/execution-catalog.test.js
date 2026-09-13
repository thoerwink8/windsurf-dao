// No network, processes, real credentials or production config. HTTP uses injected fetch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = import('../scripts/lib/execution-catalog.mjs');
const NOW = '2026-09-09T16:00:00.000Z';
const OLD = '2026-09-07T16:00:00.000Z';

function profile(id = 'cheap', family = 'deepseek', price = 0.1) {
  return { id, backend: 'mirasim', agent: 'pi', model: family === 'deepseek' ? 'deepseek-v4-flash' : 'grok-4.6', modelFamily: family,
    route: 'local', provider: 'reseller-a', accountPoolId: 'pool-a', enabled: true,
    roles: ['companion', 'review-low-risk', 'implementation', 'architecture', 'review'],
    availability: { status: 'available', evidenceKind: 'execution', checkedAt: NOW, sourceId: 'proof' },
    quality: { status: 'qualified', tier: 'strong', sourceId: 'proof' },
    capabilities: Object.fromEntries(['read', 'write', 'test', 'review', 'architecture'].map(k => [k, { status: 'verified', sourceId: 'proof' }])),
    pricing: { status: 'known', currency: 'USD', unit: 'per_million_tokens', inputPerMillion: price, outputPerMillion: price * 2, sourceId: 'proof', checkedAt: NOW } };
}
function fixture(profiles = [profile()]) {
  return { schemaVersion: 1, updatedAt: NOW, freshness: { maxAgeHours: 24, priceMaxAgeHours: 24 },
    providers: [{ id: 'reseller-a', kind: 'api' }, { id: 'reseller-b', kind: 'api' }],
    accountPools: [{ id: 'pool-a', availability: { status: 'available', checkedAt: NOW } }],
    sources: [{ id: 'proof', kind: 'evidence' }], profiles, snapshots: [] };
}
function source(extra = {}) { return { id: 'menu', provider: 'reseller-a', kind: 'openai-models', access: 'public', url: 'https://models.example/v1/models', ...extra }; }
function withSource(extra = {}) { const c = fixture(); c.sources.push(source(extra)); c.profiles[0].modelSourceId = 'menu'; return c; }
const jsonResponse = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const select = async (c, options = {}) => (await lib).selectExecutionProfile(c, { role: 'companion', now: NOW, ...options });

test('ranks cost only after quality and capabilities qualify; cheap weak model cannot review architecture', async () => {
  const cheap = profile('cheap'), strong = profile('strong', 'xai', 5);
  cheap.quality.tier = 'basic';
  let result = await select(fixture([strong, cheap]));
  assert.equal(result.profile.id, 'cheap');
  result = await select(fixture([strong, cheap]), { role: 'architecture', authorFamily: 'anthropic' });
  assert.equal(result.profile.id, 'strong');
  assert.ok(result.rejected.find(p => p.id === 'cheap').reasons.includes('quality_not_qualified'));
  strong.capabilities.architecture.status = 'declared';
  assert.equal((await select(fixture([strong, cheap]), { role: 'architecture', authorFamily: 'anthropic' })).status, 'blocked');
});

test('low risk review accepts standard tier; high risk escalates without allowing weaker cheap models', async () => {
  const p = profile(); p.quality.tier = 'standard';
  assert.equal((await select(fixture([p]), { role: 'review-low-risk', authorFamily: 'xai' })).status, 'selected');
  assert.equal((await select(fixture([p]), { role: 'review-low-risk', task: { risk: 'high' }, authorFamily: 'xai' })).status, 'blocked');
  assert.equal((await select(fixture([p]), { role: 'review', authorFamily: 'xai' })).status, 'blocked');
});

test('reseller change does not make the same developer family an independent reviewer', async () => {
  const writer = profile('writer'), same = profile('resold'), other = profile('other', 'xai', 9);
  same.provider = 'reseller-b'; same.model = 'deepseek/deepseek-v4-flash';
  const result = await select(fixture([writer, same, other]), { role: 'review', authorProfileId: 'writer' });
  assert.equal(result.profile.id, 'other');
  assert.ok(result.rejected.find(p => p.id === 'resold').reasons.includes('same_model_family'));
  assert.equal((await select(fixture([other]), { role: 'review' })).status, 'blocked');
});

test('Auto/unknown model family cannot satisfy independent review; dishonest family rejected', async () => {
  const p = profile(); p.model = 'auto'; p.modelFamily = 'unknown';
  assert.equal((await select(fixture([p]), { role: 'review', authorFamily: 'xai' })).status, 'blocked');
  p.model = 'deepseek-v4-flash'; p.modelFamily = 'reseller-a';
  assert.equal((await select(fixture([p]))).reason, 'invalid_catalog');
});

test('disabled, unknown, unavailable, stale and unverified execution are never false green', async () => {
  for (const state of ['unknown', 'unavailable', 'unverified', 'auth_required', 'stale']) {
    const p = profile(); p.availability.status = state;
    assert.equal((await select(fixture([p]))).status, 'blocked', state);
  }
  for (const mutate of [p => { p.enabled = false; }, p => { p.availability.checkedAt = OLD; }, p => { p.availability.evidenceKind = 'model_list'; }, p => { delete p.availability.checkedAt; }]) {
    const p = profile(); mutate(p); assert.equal((await select(fixture([p]))).status, 'blocked');
  }
  const c = fixture(); c.accountPools[0].availability.status = 'auth_required';
  assert.equal((await select(c)).status, 'blocked');
});

test('unknown, partial, NaN, negative, reference and stale prices never become zero', async () => {
  const { estimateProfileCost } = await lib;
  for (const patch of [{ status: 'unknown' }, { status: 'reference' }, { checkedAt: OLD }, { inputPerMillion: null }, { outputPerMillion: NaN }, { outputPerMillion: -1 }, { currency: 'credits' }, { inputPerMillion: '0' }]) {
    const p = profile(); Object.assign(p.pricing, patch);
    assert.deepEqual(estimateProfileCost(p, {}, { now: NOW }).amount, null);
    assert.equal((await select(fixture([p]))).status, 'blocked');
  }
  const p = profile(); p.pricing.status = 'unknown';
  assert.equal((await select(fixture([p]), { allowUnknownPrice: true })).status, 'selected');
  assert.equal((await select(fixture([p]), { allowUnknownPrice: true, task: { maxCostUsd: 100 } })).status, 'blocked');
});

test('known prices sort before explicit unknown opt-in; real free metadata still requires qualification', async () => {
  const unknown = profile('unknown'); unknown.pricing.status = 'unknown';
  const known = profile('known', 'xai', 10);
  assert.equal((await select(fixture([unknown, known]), { allowUnknownPrice: true })).profile.id, 'known');
  known.pricing.inputPerMillion = 0; known.pricing.outputPerMillion = 0;
  assert.equal((await select(fixture([known]))).ranked[0].estimatedCost.amount, 0);
  known.quality.status = 'unverified';
  assert.equal((await select(fixture([known]))).status, 'blocked');
});

test('token mix changes actual ranking, budget ceiling and profile allowlist constrain selection', async () => {
  const a = profile('input-cheap'), b = profile('output-cheap', 'xai');
  a.pricing.outputPerMillion = 10; b.pricing.inputPerMillion = 10;
  const c = fixture([a, b]);
  assert.equal((await select(c, { task: { inputTokens: 1e6, outputTokens: 1 } })).profile.id, 'input-cheap');
  assert.equal((await select(c, { task: { inputTokens: 1, outputTokens: 1e6 } })).profile.id, 'output-cheap');
  assert.equal((await select(c, { allowedProfileIds: ['output-cheap'] })).profile.id, 'output-cheap');
  assert.equal((await select(c, { task: { maxCostUsd: 0 } })).status, 'blocked');
});

test('missing and future timestamps are unknown; malformed requirements fail closed', async () => {
  const { freshness } = await lib;
  for (const stamp of [undefined, null, 'broken', '2026-09-10T16:00:00.000Z']) assert.equal(freshness(stamp, { now: NOW }).status, 'unknown');
  assert.equal(freshness(OLD, { now: NOW }).status, 'stale');
  for (const options of [{ role: 'invented' }, { role: '__proto__' }, { task: { requiredCapabilities: {} } }, { task: { minQuality: 'toString' } }, { task: null }, { task: { inputTokens: -1 }, allowUnknownPrice: true }]) assert.equal((await select(fixture(), options)).reason, 'invalid_requirements');
});

test('refresh is GET only and does not promote a menu into execution, entitlement or quality', async () => {
  const { refreshExecutionCatalog } = await lib;
  const c = withSource(); c.profiles[0].availability.status = 'unverified'; c.profiles[0].availability.checkedAt = OLD;
  const before = structuredClone(c);
  const result = await refreshExecutionCatalog(c, { now: NOW, fetchImpl: async (url, opts) => {
    assert.equal(url, 'https://models.example/v1/models'); assert.equal(opts.method, 'GET'); assert.equal(opts.redirect, 'error');
    return jsonResponse({ data: [{ id: 'deepseek-v4-flash', price: 0, owned_by: 'someone@example.com', token: 'private' }] });
  } });
  assert.equal(result.ok, true); assert.equal(result.catalog.profiles[0].modelDiscovery.status, 'listed');
  assert.deepEqual(result.catalog.profiles[0].availability, before.profiles[0].availability);
  assert.equal((await select(result.catalog)).status, 'blocked');
  assert.equal(result.catalog.snapshots[0].models[0].pricing.status, 'unknown');
  assert.ok(!JSON.stringify(result).includes('someone@example.com'));
  assert.deepEqual(c, before);
});

test('failed refresh retains last good models but marks failure; old snapshot cannot appear fresh', async () => {
  const { refreshExecutionCatalog } = await lib;
  const c = withSource(); c.snapshots = [{ sourceId: 'menu', status: 'ok', checkedAt: OLD, lastSuccessAt: OLD, models: [{ id: 'deepseek-v4-flash' }] }];
  for (const fetchImpl of [async () => new Response('private upstream body', { status: 403 }), async () => { throw new Error('private key or URL here'); }, async () => jsonResponse({ data: [] }), async () => jsonResponse({ error: 'private' }), async () => new Response('not json')]) {
    const r = await refreshExecutionCatalog(c, { now: NOW, fetchImpl });
    assert.equal(r.ok, false); assert.equal(r.catalog.snapshots[0].lastSuccessAt, OLD);
    assert.equal(r.catalog.snapshots[0].models.length, 1);
    assert.equal((await select(r.catalog)).status, 'blocked');
    assert.ok(!JSON.stringify(r).includes('private'));
  }
});

test('model removed from successful fresh menu blocks selection despite older execution proof', async () => {
  const { refreshExecutionCatalog } = await lib;
  const r = await refreshExecutionCatalog(withSource(), { now: NOW, fetchImpl: async () => jsonResponse({ data: [{ id: 'another-model' }] }) });
  assert.equal(r.catalog.profiles[0].modelDiscovery.status, 'not_listed');
  assert.ok((await select(r.catalog)).rejected[0].reasons.includes('model_not_listed'));
});

test('metadata price is provider-specific reference and never copied across resellers', async () => {
  const { refreshExecutionCatalog } = await lib;
  const c = withSource({ kind: 'models-dev', metadataProvider: 'opencode-go' });
  delete c.profiles[0].modelSourceId; c.profiles[0].pricingSourceId = 'menu';
  const r = await refreshExecutionCatalog(c, { now: NOW, fetchImpl: async () => jsonResponse({ 'opencode-go': { models: { 'deepseek-v4-flash': { cost: { input: 0.22, output: 0.66 }, tool_call: true } } }, deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 0.14, output: 0.28 } } } } }) });
  assert.equal(r.catalog.profiles[0].pricing.inputPerMillion, 0.22);
  assert.equal(r.catalog.profiles[0].pricing.status, 'reference');
  assert.equal((await select(r.catalog)).status, 'blocked');
});

test('group credential is only sent to configured GET endpoint and never returned or echoed', async () => {
  const { refreshExecutionCatalog } = await lib;
  const c = withSource({ access: 'gateway-group', credential: { kind: 'newapi-group', env: 'CATALOG_TEST_KEY' } });
  const secret = 'test-private-credential-value';
  for (const id of ['deepseek-v4-flash', secret]) {
    const r = await refreshExecutionCatalog(c, { now: NOW, env: { CATALOG_TEST_KEY: secret }, fetchImpl: async (_, opts) => {
      assert.equal(opts.headers.Authorization, `Bearer ${secret}`); return jsonResponse({ data: [{ id }] });
    } });
    assert.ok(!JSON.stringify(r).includes(secret)); assert.equal(r.ok, id !== secret);
  }
  c.sources[1].access = 'direct';
  await assert.rejects(refreshExecutionCatalog(c, { fetchImpl: () => assert.fail('must not call provider') }), /invalid_catalog/);
});

test('insecure/query/credential URLs and missing credentials stop before network; failures never echo secrets', async () => {
  const { refreshExecutionCatalog } = await lib;
  for (const url of ['http://models.example/v1/models', 'https://me:secret@models.example/models', 'https://models.example/models?token=secret']) {
    const r = await refreshExecutionCatalog(withSource({ url }), { now: NOW, fetchImpl: () => assert.fail('no request') });
    assert.equal(r.ok, false); assert.equal(r.catalog.snapshots[0].reason, 'unsafe_source_url');
  }
  const r = await refreshExecutionCatalog(withSource({ access: 'direct', credential: { kind: 'provider-key', env: 'CATALOG_MISSING' } }), { now: NOW, env: {}, fetchImpl: () => assert.fail('no request') });
  assert.equal(r.catalog.snapshots[0].reason, 'credential_missing');
});

test('credential inventory distinguishes group key, native key and misleading old Codex backup without disclosure', async () => {
  const { discoverExecutionCredentials } = await lib;
  const files = new Map([
    ['/fiction/.pi/agent/pi-gateway.json', JSON.stringify({ providers: [{ id: 'gw-opencode', keyFile: '/fiction/.mirasim/keys/opencode.key' }] })],
    ['/fiction/.mirasim/keys/opencode.key', 'private-group'], ['/fiction/.mirasim/keys/mycodex.key', 'private-group'],
    ['/fiction/.codex/auth.json', JSON.stringify({ OPENAI_API_KEY: 'private-group' })],
    ['/fiction/.commandcode/auth.json', JSON.stringify({ apiKey: 'private-native' })],
  ]);
  const rows = discoverExecutionCredentials({ home: '/fiction', read: file => { if (!files.has(file)) throw new Error('missing'); return files.get(file); }, exists: file => files.has(file) });
  assert.equal(rows.find(r => r.provider === 'opencode-go').kind, 'newapi-group');
  assert.equal(rows.find(r => r.provider === 'commandcode' && r.kind === 'provider-key').present, true);
  assert.equal(rows.find(r => r.provider === 'pqapi').kind, 'newapi-group');
  assert.ok(!JSON.stringify(rows).includes('private-'));
});

test('Pi native credentials are discovered; relabeling a known group key cannot send it to a direct provider', async () => {
  const { discoverExecutionCredentials, refreshExecutionCatalog } = await lib;
  const files = new Map([
    ['/fiction/.mirasim/keys/opencode.key', 'group-secret'],
    ['/fiction/.pi/agent/auth.json', JSON.stringify({ 'opencode-go': { type: 'api_key', key: 'native-secret' }, deepseek: { type: 'api_key', key: 'group-secret' } })],
  ]);
  const read = file => { if (!files.has(file)) throw new Error('missing'); return files.get(file); };
  const rows = discoverExecutionCredentials({ home: '/fiction', read, exists: file => files.has(file) });
  const native = rows.find(r => r.provider === 'opencode-go' && r.location === '~/.pi/agent/auth.json');
  assert.equal(native.present, true); assert.equal(native.kind, 'provider-key');
  assert.equal(rows.find(r => r.provider === 'deepseek').kind, 'newapi-group');
  const c = withSource({ access: 'direct', credential: { kind: 'provider-key', file: '~/.pi/agent/auth.json', jsonPath: ['deepseek', 'key'] } });
  const r = await refreshExecutionCatalog(c, { now: NOW, home: '/fiction', read, fetchImpl: () => assert.fail('group key must not leave for upstream') });
  assert.equal(r.ok, false); assert.equal(r.catalog.snapshots[0].reason, 'credential_kind_mismatch');
  assert.ok(!JSON.stringify(r).includes('group-secret'));
});

test('refreshing unrelated source cannot renew old execution or old model/price evidence', async () => {
  const { refreshExecutionCatalog } = await lib;
  const c = withSource();
  c.sources.push(source({ id: 'second-menu' }));
  c.snapshots.push({ sourceId: 'menu', status: 'ok', checkedAt: OLD, lastSuccessAt: OLD, models: [{ id: 'deepseek-v4-flash' }] });
  const r = await refreshExecutionCatalog(c, { now: NOW, sourceIds: ['second-menu'], fetchImpl: async () => jsonResponse({ data: [{ id: 'grok-4.6' }] }) });
  assert.equal(r.catalog.snapshots.find(s => s.sourceId === 'menu').checkedAt, OLD);
  assert.ok((await select(r.catalog)).rejected[0].reasons.includes('model_catalog_not_fresh'));
});

test('mycodex filename alone cannot falsely classify an original upstream key as a NewAPI group key', async () => {
  const { refreshExecutionCatalog } = await lib;
  const testValue = 'upstream-test-value';
  const c = withSource({ access: 'direct', credential: { kind: 'provider-key', env: 'NATIVE_TEST_KEY' } });
  const r = await refreshExecutionCatalog(c, { now: NOW, home: '/fiction', env: { NATIVE_TEST_KEY: 'upstream-test-value' }, read: file => {
    if (file === '/fiction/.mirasim/keys/mycodex.key') return 'upstream-test-value';
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }, fetchImpl: async (_, opts) => {
    assert.equal(opts.headers.Authorization, `Bearer ${testValue}`);
    return jsonResponse({ data: [{ id: 'deepseek-v4-flash' }] });
  } });
  assert.equal(r.ok, true);
});

test('implicit model aliases must be unique with pinned route, ACP cannot borrow Mirasim relay', async () => {
  const { validateCatalog } = await lib;
  const a = profile('a'), b = profile('b');
  a.defaultForModels = ['grok-4.6']; b.defaultForModels = ['grok-4.6'];
  for (const p of [a, b]) p.implicitSelection = { authorized: true, fallback: 'none' };
  assert.equal(validateCatalog(fixture([a, b])).ok, false);
  b.defaultForModels = []; a.route = 'auto';
  assert.equal(validateCatalog(fixture([a, b])).ok, false);
  const c = fixture(); c.providers[0].kind = 'relay'; c.profiles[0].backend = 'acp'; c.profiles[0].route = 'cloud';
  assert.equal(validateCatalog(c).ok, false);
});

test('real catalog is structurally valid; no V4.1/GPT4omini/Llama IDs fabricated in profiles', async () => {
  const { loadExecutionCatalog, validateCatalog } = await lib;
  const c = loadExecutionCatalog(); assert.equal(validateCatalog(c).ok, true);
  const backendFor = agent => [...new Set(c.profiles.filter(p => p.agent === agent).map(p => p.backend))].sort();
  assert.deepEqual(backendFor('cursor'), ['acp']);
  assert.deepEqual(backendFor('devin'), ['acp']);
  assert.deepEqual([...new Set(c.profiles.filter(p => p.agent === 'grok').map(p => p.route))], ['local']);
  const relay = c.profiles.filter(p => /relay/.test(p.provider));
  assert.deepEqual([...new Set(relay.map(p => p.backend))], ['mirasim']);
  assert.deepEqual([...new Set(relay.map(p => p.route))], ['cloud']);
  assert.deepEqual(c.profiles.filter(p => /v4[.-]1|gpt4omini|llama/i.test(p.model ?? '')).map(p => p.id), []);
  const pools = c.profiles.filter(p => ['devin-native', 'windsurf'].includes(p.provider)).map(p => p.accountPoolId);
  assert.equal(new Set(pools).size, 1, 'user-confirmed shared allowance must not create duplicate quotas');
});

test('atomic public snapshot writes stay service-readable; private outputs retain mode and failed writes preserve file', async t => {
  const { writeExecutionCatalog } = await lib;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-catalog-mode-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'catalog.json'), privateFile = path.join(dir, 'private.json');
  const oldUmask = process.umask(0o077);
  try {
    writeExecutionCatalog(fixture(), file);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    writeExecutionCatalog(fixture(), file);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    writeExecutionCatalog(fixture(), privateFile, { mode: 0o600 });
    writeExecutionCatalog(fixture(), privateFile);
    if (process.platform !== 'win32') assert.equal(fs.statSync(privateFile).mode & 0o777, 0o600);
  } finally { process.umask(oldUmask); }
  const before = fs.readFileSync(file, 'utf8'), broken = fixture(); broken.cycle = broken;
  assert.throws(() => writeExecutionCatalog(broken, file));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['catalog.json', 'private.json']);
});

test('CLI uses explicit output, nonzero partial/blocked status and safe diagnostics (injected refresh)', async t => {
  const { main } = await import('../scripts/execution-catalog.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-catalog-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.json'), output = path.join(dir, 'output.json');
  const c = fixture(); fs.writeFileSync(input, JSON.stringify(c)); const before = fs.readFileSync(input, 'utf8');
  const logs = []; const io = { stdout: x => logs.push(x), stderr: x => logs.push(x) };
  let code = await main(['refresh', '--catalog', input, '--output', output, '--json'], { ...io, refresh: async catalog => ({ catalog, ok: false, reports: [{ sourceId: 'fixture', status: 'error' }] }) });
  assert.equal(code, 2); assert.ok(fs.existsSync(output)); assert.equal(fs.readFileSync(input, 'utf8'), before);
  code = await main(['select', '--catalog', input, '--role', 'review', '--json'], io); assert.equal(code, 2);
  code = await main(['select', '--catalog', input, '--task', '{"secret":'], io); assert.equal(code, 1);
  assert.ok(!logs.join('\n').includes('SyntaxError'));
});
