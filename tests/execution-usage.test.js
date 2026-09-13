const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const modulePromise = import(pathToFileURL(path.join(__dirname, '../scripts/lib/execution-usage.mjs')));
const root = path.join(__dirname, '..');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-usage-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, dir: path.join(home, '.dao/execution/usage') };
}
function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); }
function ndjson(...events) { return events.map(e => JSON.stringify(e) + '\n').join(''); }
const ts = n => `2026-09-09T00:00:${String(n).padStart(2, '0')}.000Z`;
function usage(n, extra = {}) { return { timestamp: ts(n), sessionId: 'session-a', requestId: `req-${n}`, model: 'grok-4.6', usage: { input_tokens: n * 10, output_tokens: n }, ...extra }; }
function app(M, f, event, extra = {}) { return M.appendUsage({ agent: 'grok', source: 'grok-native', event, context: { taskId: 'task-a', ...extra } }, f); }
function inputTotal(report) { return report.groups.reduce((s, g) => s + (g.metrics.inputTokens || 0), 0); }

test('normalizes real Devin export final_metrics; preserves billing source and separates estimates', async () => {
  const M = await modulePromise;
  // Shape and numeric values from devin-read-j8ujRx/export.json, no transcript.
  const row = M.normalizeUsage({ agent: 'devin', source: 'devin-export', event: {
    schema_version: '1', session_id: 'devin-fixture', agent: { name: 'devin', model_name: 'SWE-1.7 Medium' },
    steps: [{ message: 'PRIVATE PROMPT', metrics: { prompt_tokens: 18921 } }],
    final_metrics: { total_prompt_tokens: 57204, total_completion_tokens: 205, total_cached_tokens: 48640, total_steps: 11 },
  }, context: { profileId: 'devin-pro', accountPools: { 'devin-pro': 'shared-allowance' }, billingSource: 'devin-pro', accountId: 'private@example.test' } });
  assert.equal(row.metrics.inputTokens, 57204);
  assert.equal(row.metrics.outputTokens, 205);
  assert.equal(row.metrics.cacheReadTokens, 48640);
  assert.equal(row.kind, 'cumulative');
  assert.equal(row.charge.amount, null);
  assert.equal(row.estimate.amount, null);
  assert.equal(row.accountPoolId, 'shared-allowance');
  assert.equal(row.billingSource, 'devin-pro');
  assert.equal(row.model, 'SWE-1.7 Medium');
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE|private@example|steps/);
});

test('normalizes Grok native ACP turn_completed metrics, ticks are estimates', async () => {
  const M = await modulePromise;
  const row = M.normalizeUsage({ agent: 'grok', source: 'grok-native', event: {
    timestamp: 1788912000000, method: '_x.ai/session/update', params: { sessionId: 'grok-session', _meta: { eventId: 'event-1' }, update: {
      sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', usage: { inputTokens: 100, outputTokens: 5, cachedReadTokens: 80, cacheCreationTokens: 0, reasoningTokens: 2, costUsdTicks: 1000, modelUsage: { 'grok-4.6-build': {} } },
    } },
  } });
  assert.equal(row.kind, 'delta'); assert.equal(row.scope, 'turn');
  assert.equal(row.metrics.cacheReadTokens, 80);
  assert.deepEqual(row.estimate, { amount: 1000, unit: 'USD_ticks' });
  assert.equal(row.charge.amount, null);
  assert.equal(row.model, 'grok-4.6-build');
});

test('unknown metrics remain null, explicit zero survives except Mirasim backfill placeholders', async () => {
  const M = await modulePromise;
  const row = M.normalizeUsage({ agent: 'cursor', source: 'cursor-acp', event: { type: 'result', result: 'private text', usage: { input_tokens: 0, output_tokens: -1 } } });
  assert.equal(row.metrics.inputTokens, 0); assert.equal(row.metrics.outputTokens, null);
  assert.equal(row.metrics.cacheReadTokens, null);
  assert.equal(row.completeness.tokens, 'partial');
  assert.doesNotMatch(JSON.stringify(row), /private text/);
  const placeholder = M.normalizeUsage({ source: 'mirasim-ledger', event: { input: 0, output: 0, cacheRead: 0 } });
  assert.equal(placeholder.metrics.inputTokens, null);
});

test('cross-source request alias bridge dedups traffic, ledger, native regardless of order', async t => {
  const M = await modulePromise, f = fixture(t);
  M.appendUsage({ agent: 'grok', source: 'mirasim-traffic', event: { sessionId: 's', callId: 'local-call', model: 'grok-4.6', durationMs: 20 } }, f);
  M.appendUsage({ agent: 'grok', source: 'grok-native', event: { sessionId: 's', providerCallId: 'provider-call', model: 'grok-4.6', usage: { input_tokens: 120, output_tokens: 8 }, actualCharge: { amount: 0.5, unit: 'credits' } } }, f);
  M.appendUsage({ agent: 'grok', source: 'mirasim-ledger', event: { sessionId: 's', id: 's:local-call', relayCallId: 'remote-relay-call', providerCallId: 'provider-call', model: 'grok-4.6', input: 120, output: 8 } }, f);
  const report = M.reportUsage(f);
  assert.equal(report.deduplicatedRecords, 1);
  assert.equal(inputTotal(report), 120);
  assert.deepEqual(report.groups[0].sources.sort(), ['grok-native','mirasim-ledger','mirasim-traffic']);
  assert.deepEqual(report.groups[0].charges, [{ unit: 'credits', amount: 0.5 }]);
});

test('shared pool groups usage without deduplicating unrelated Devin and Windsurf calls', async t => {
  const M = await modulePromise, f = fixture(t);
  for (const agent of ['devin', 'windsurf']) M.appendUsage({ agent, source: `${agent}-native`, event: usage(1, { sessionId: `${agent}-session` }), context: { accountPools: { devin: 'shared', windsurf: 'shared' }, billingSource: `${agent}-pro` } }, f);
  const report = M.reportUsage({ ...f, groupBy: ['accountPoolId'] });
  assert.equal(report.groups.length, 1);
  assert.equal(inputTotal(report), 20);
  assert.equal(report.deduplicatedRecords, 2);
  assert.deepEqual(report.groups[0].billingSources.sort(), ['devin-pro','windsurf-pro']);
});

test('identical ID-less calls use source position, never token-content or shared pool dedup', async t => {
  const M = await modulePromise, f = fixture(t);
  const p = path.join(f.home, 'usage.ndjson');
  const e = { type: 'result', usage: { input_tokens: 10, output_tokens: 2 } };
  write(p, ndjson(e, e));
  M.collectUsage({ ...f, sources: [{ path: p, source: 'cursor-output', agent: 'cursor' }] });
  assert.equal(inputTotal(M.reportUsage(f)), 20);
  assert.equal(M.reportUsage(f).deduplicatedRecords, 2);
});

test('cumulative snapshots, deltas, resume, replay and late arrival reconcile exactly once', async t => {
  const M = await modulePromise, f = fixture(t);
  const cumulative = (n, tokens) => usage(n, { requestId: undefined, usageKind: 'cumulative', usageScope: 'session', usage: { input_tokens: tokens } });
  app(M, f, usage(1, { usage: { input_tokens: 100 } }));
  app(M, f, cumulative(2, 100));
  app(M, f, usage(3, { usage: { input_tokens: 20 } }));
  assert.equal(inputTotal(M.reportUsage(f)), 120, 'new turn after a snapshot adds only its delta');
  app(M, f, cumulative(4, 150));
  app(M, f, usage(3, { requestId: 'req-late', usage: { input_tokens: 30 } }));
  assert.equal(inputTotal(M.reportUsage(f)), 150, 'late detail covered by latest cumulative');
  app(M, f, cumulative(4, 150));
  assert.equal(inputTotal(M.reportUsage(f)), 150, 'replayed snapshot');
  app(M, f, usage(5, { usage: { input_tokens: 10 } }));
  assert.equal(inputTotal(M.reportUsage(f)), 160);
});

test('Devin cumulative export overlapping ACP per-turn totals is not added twice', async t => {
  const M = await modulePromise, f = fixture(t);
  for (const [id,n] of [['p1',100],['p2',50]]) M.appendUsage({ agent: 'devin', source: 'devin-acp', event: { session_id: 's', turnId: id, timestamp: ts(1), model: 'm', usage: { input_tokens: n } } }, f);
  M.appendUsage({ agent: 'devin', source: 'devin-export', event: { session_id: 's', timestamp: ts(2), agent: { model_name: 'm' }, final_metrics: { total_prompt_tokens: 150 } } }, f);
  assert.equal(inputTotal(M.reportUsage(f)), 150);
});

test('counter decrease reports a gap, epoch metadata allows explicit counter reset', async t => {
  const M = await modulePromise, f = fixture(t);
  for (const [i,n] of [[1,100],[2,20]]) app(M, f, { sessionId: 's', timestamp: ts(i), cumulative: true, usage: { input_tokens: n } });
  let report = M.reportUsage(f);
  assert.equal(inputTotal(report), 100);
  assert.ok(report.groups[0].gaps.includes('counter_decreased'));
  app(M, f, { sessionId: 's', timestamp: ts(3), cumulative: true, usage: { input_tokens: 30 } }, { counterEpoch: 'restart-2' });
  assert.equal(inputTotal(M.reportUsage(f)), 130);
});

test('unknown Grok usage semantics cannot silently doublecount an ambiguous stream', async t => {
  const M = await modulePromise, f = fixture(t);
  app(M, f, { sessionId: 's', type: 'usage', usage: { input_tokens: 100 } });
  const report = M.reportUsage(f);
  assert.equal(report.groups[0].metrics.inputTokens, null);
  assert.ok(report.groups[0].gaps.includes('unknown_usage_semantics'));
});

test('committed rows survive lost checkpoint; collector replay and process restart are idempotent', async t => {
  const M = await modulePromise, f = fixture(t), p = path.join(f.home, 'raw.ndjson');
  write(p, ndjson(usage(1), usage(2)));
  const options = { ...f, sources: [{ path: p, source: 'grok-acp', agent: 'grok' }] };
  assert.equal(M.collectUsage(options).committed, 2);
  fs.rmSync(path.join(f.dir, 'checkpoints'), { recursive: true });
  const replay = M.collectUsage(options);
  assert.equal(replay.committed, 0); assert.equal(replay.duplicates, 2);
  const cli = spawnSync(process.execPath, [path.join(root, 'scripts/execution-usage.mjs'), '--home', f.home, '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(inputTotal(JSON.parse(cli.stdout)), 30);
});

test('interrupted tail is not checkpointed until newline commits the complete event', async t => {
  const M = await modulePromise, f = fixture(t), p = path.join(f.home, 'raw.ndjson');
  const tail = JSON.stringify(usage(2));
  write(p, ndjson(usage(1)) + tail.slice(0, 25));
  const options = { ...f, sources: [{ path: p, source: 'grok-acp', agent: 'grok' }] };
  let result = M.collectUsage(options);
  assert.equal(result.committed, 1); assert.equal(result.complete, false);
  fs.appendFileSync(p, tail.slice(25) + '\n');
  result = M.collectUsage(options);
  assert.equal(result.committed, 1);
  assert.equal(inputTotal(M.reportUsage(f)), 30);
});

test('malformed complete line holds cursor and recovers once producer repairs it', async t => {
  const M = await modulePromise, f = fixture(t), p = path.join(f.home, 'raw.ndjson');
  write(p, ndjson(usage(1)) + 'bad-json\n' + ndjson(usage(2)));
  const options = { ...f, sources: [{ path: p, source: 'grok-acp', agent: 'grok' }] };
  assert.ok(M.collectUsage(options).gaps.includes('invalid_ndjson'));
  assert.equal(inputTotal(M.reportUsage(f)), 10);
  write(p, ndjson(usage(1),usage(2)));
  M.collectUsage(options);
  assert.equal(inputTotal(M.reportUsage(f)), 30);
});

test('failed row commit never advances checkpoint', async t => {
  const M = await modulePromise, f = fixture(t), p = path.join(f.home, 'raw.ndjson');
  write(p, ndjson(usage(1))); write(path.join(f.dir, 'rows'), 'not a directory');
  assert.throws(() => M.collectUsage({ ...f, sources: [{ path: p, source: 'grok-acp', agent: 'grok' }] }));
  assert.equal(fs.existsSync(path.join(f.dir, 'checkpoints')), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'collector.lock')), false);
});

test('bounded scan resumes across invocations, long lines remain an explicit gap', async t => {
  const M = await modulePromise, f = fixture(t), p = path.join(f.home, 'raw.ndjson');
  write(p, ndjson(usage(1),usage(2),usage(3)));
  const options = { ...f, limits: { maxBytesPerSource: Buffer.byteLength(ndjson(usage(1))) }, sources: [{ path: p, source: 'grok-acp', agent: 'grok' }] };
  assert.equal(M.collectUsage(options).committed, 1);
  assert.equal(M.collectUsage(options).committed, 1);
  assert.equal(M.collectUsage(options).committed, 1);
  assert.equal(inputTotal(M.reportUsage(f)), 60);
  const report = M.reportUsage({ ...f, limits: { maxRows: 1 } });
  assert.equal(report.complete, false); assert.ok(report.gaps.includes('report_row_limit'));
  write(p, ndjson({ type:'result', content:'x'.repeat(500) }));
  const blocked = M.collectUsage({ ...options, limits: { maxBytesPerSource: 64, maxLineBytes: 64 } });
  assert.equal(blocked.complete, false); assert.ok(blocked.gaps.includes('line_size_limit'));
});

test('Mirasim in-place backfill, even same file size, updates rather than adds a request', async t => {
  const M = await modulePromise, f = fixture(t), p = path.join(f.home, '.mirasim/insights/usage-2026-09.ndjson');
  const e = { id:'s:call', sessionId:'s', agent:'codex', provider:'openai-responses', input:0, output:0 };
  write(p, ndjson(e)); M.collectUsage(f);
  assert.equal(M.reportUsage(f).groups[0].metrics.inputTokens, null);
  write(p, ndjson({ ...e, input:9, output:1 }));
  fs.utimesSync(p, new Date(), new Date(Date.now()+1000));
  M.collectUsage(f);
  const report = M.reportUsage(f);
  assert.equal(report.deduplicatedRecords, 1); assert.equal(inputTotal(report), 9);
});

test('collects default Mirasim, ACP context and session metadata with configured shared pools', async t => {
  const M = await modulePromise, f = fixture(t);
  write(path.join(f.home, '.dao/execution/sessions', encodeURIComponent('codex:mira-session') + '.json'), { sessionKey:'codex:mira-session', agent:'codex', taskId:'relay-task', model:'gpt-model', route:'cloud', profileId:'relay', provider:'openai', accountPoolId:'relay-pool' });
  write(path.join(f.home, '.mirasim/insights/usage-2026-09.ndjson'), ndjson({ id:'mira-session:call', sessionId:'mira-session', agent:'codex', input:123, output:4, viaRelay:true }));
  write(path.join(f.home, '.mirasim/traffic/mira-session/index-0.ndjson'), ndjson({ callId:'call', sessionId:'mira-session', agent:'codex', viaRelay:true }));
  write(path.join(f.home, '.dao/execution/acp/acp1/status/context.json'), { sessionKey:'cursor:c1', agent:'cursor', taskId:'native-task', model:'composer', profileId:'cursor-native' });
  write(path.join(f.home, '.dao/execution/acp/acp1/usage.ndjson'), ndjson({ params:{sessionId:'c1',update:{sessionUpdate:'usage_update',usage:{input_tokens:42,output_tokens:3},requestId:'cursor-call'}} }));
  write(path.join(f.home, '.dao/execution/usage-config.json'), { accountPools:{ 'cursor-native':'cursor-pool' } });
  const result = M.collectUsage(f);
  assert.equal(result.complete, true);
  const report = M.reportUsage(f);
  assert.equal(report.groups.length, 2);
  const relay = report.groups.find(g=>g.taskId==='relay-task');
  assert.equal(relay.metrics.inputTokens, 123);
  assert.equal(relay.accountPoolId, 'relay-pool');
  assert.deepEqual(relay.billingSources, ['mirasim-relay']);
  const native = report.groups.find(g=>g.taskId==='native-task');
  assert.equal(native.metrics.inputTokens, 42);
  assert.equal(native.accountPoolId, 'cursor-pool');
});

test('protocol provider names are not vendors; grok native host maps to xai', async () => {
  const M = await modulePromise;
  const row = M.normalizeUsage({
    agent: 'grok', source: 'mirasim-ledger',
    event: {
      sessionId: 'sid', model: 'grok-4.6', provider: 'openai-responses',
      upstreamHost: 'cli-chat-proxy.grok.com', leg: 'direct', viaRelay: false,
      input: 10, output: 1, usageKnown: true,
    },
  });
  assert.equal(row.provider, 'xai');
  assert.equal(row.reportedProvider, 'openai-responses');
  assert.equal(row.billingSource, 'xai');
  assert.equal(row.accountPoolId, null);
  const cleaned = M.sanitizeUsageObservation(row);
  assert.equal(cleaned.provider, 'xai');
  assert.equal(cleaned.reportedProvider, 'openai-responses');
});

test('relay host is not the vendor; billing stays mirasim-relay', async () => {
  const M = await modulePromise;
  const row = M.normalizeUsage({
    agent: 'codex', source: 'mirasim-ledger',
    event: {
      sessionId: 'sid', model: 'gpt-5.6-luna', provider: 'openai-responses',
      upstreamHost: 'relay.mirasim.ai', leg: 'relay', viaRelay: true,
      input: 10, output: 1, usageKnown: true,
    },
  });
  assert.equal(row.provider, 'openai');
  assert.equal(row.reportedProvider, 'openai-responses');
  assert.equal(row.billingSource, 'mirasim-relay');
});

test('vendorTaskId in session metadata joins accountPoolId from usage sessionId', async t => {
  const M = await modulePromise, f = fixture(t);
  write(path.join(f.home, '.dao/execution/sessions', encodeURIComponent('grok:dispatch-1') + '.json'), {
    sessionKey: 'grok:dispatch-1', agent: 'grok', model: 'grok-4.6',
    vendorTaskId: 'backend-uuid', accountPoolId: 'xai-subscription', profileId: 'grok-mirasim-native',
  });
  write(path.join(f.home, '.mirasim/insights/usage-2026-09.ndjson'), ndjson({
    id: 'backend-uuid:call', sessionId: 'backend-uuid', agent: 'grok', model: 'grok-4.6',
    provider: 'openai-responses', upstreamHost: 'cli-chat-proxy.grok.com',
    input: 7, output: 2, usageKnown: true,
  }));
  M.collectUsage(f);
  const report = M.reportUsage(f);
  assert.equal(report.groups.length, 1);
  assert.equal(report.groups[0].provider, 'xai');
  assert.equal(report.groups[0].accountPoolId, 'xai-subscription');
  assert.equal(inputTotal(report), 7);
});

test('ambiguous model does not invent an account pool', async () => {
  const M = await modulePromise;
  const row = M.normalizeUsage({
    agent: 'codex', source: 'mirasim-ledger',
    event: {
      sessionId: 'orphan', model: 'gpt-5.6-sol', provider: 'openai-responses',
      upstreamHost: 'relay.mirasim.ai', viaRelay: true,
      input: 3, output: 1, usageKnown: true,
    },
  });
  assert.equal(row.provider, 'openai');
  assert.equal(row.accountPoolId, null);
});

test('Cursor output without usage stays visible; account balances do not become task charges', async t => {
  const M = await modulePromise, f = fixture(t);
  M.appendUsage({ agent:'cursor', source:'cursor-output', event:{ type:'result', sessionId:'c', result:'PRIVATE RESPONSE', duration_ms:123 }, context:{taskId:'cursor-task'} }, f);
  M.appendUsage({ agent:'cursor', source:'cursor-account', event:{ balance:{amount:10,unit:'USD'}, timestamp:ts(1), accountId:'secret@example.test' }, context:{accountPoolId:'cursor-pool'} }, f);
  const r = M.reportUsage(f);
  assert.equal(r.groups[0].metrics.inputTokens, null);
  assert.equal(r.groups[0].unknown.inputTokens, 1);
  assert.equal(r.groups[0].unknownCharges, 1);
  assert.deepEqual(r.groups[0].charges, []);
  assert.equal(r.accountSnapshots[0].balance.amount, 10);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE RESPONSE|secret@example/);
});

test('Cursor account request export dedups output using requestId and keeps reported cost', async t => {
  const M = await modulePromise, f = fixture(t);
  M.appendUsage({ agent:'cursor', source:'cursor-output', event:{requestId:'r1',sessionId:'c',usage:{input_tokens:20,output_tokens:2}} }, f);
  M.appendUsage({ agent:'cursor', source:'cursor-account', event:{requestId:'r1',sessionId:'c',tokenUsage:{inputTokens:20,outputTokens:2,inputCachedTokens:10},costInCents:3} }, f);
  const r=M.reportUsage(f);
  assert.equal(r.deduplicatedRecords,1); assert.equal(inputTotal(r),20);
  assert.deepEqual(r.groups[0].charges,[{unit:'USD',amount:0.03}]);
});

test('credentials and prompt content never enter rows, checkpoints, CLI output or errors', async t => {
  const M = await modulePromise, f = fixture(t), p=path.join(f.home,'raw.ndjson');
  write(p,ndjson({...usage(1), prompt:'PROMPT_SECRET', api_key:'KEY_SECRET', authorization:'AUTH_SECRET', accountId:'ACCOUNT_SECRET', userId:'USER_SECRET'}));
  M.collectUsage({...f,sources:[{path:p,source:'grok-acp',agent:'grok'}]});
  function files(p){return fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(p,e.name)):[path.join(p,e.name)]);}
  const all=files(f.dir).map(p=>fs.readFileSync(p,'utf8')).join('\n');
  assert.doesNotMatch(all,/PROMPT_SECRET|KEY_SECRET|AUTH_SECRET|ACCOUNT_SECRET|USER_SECRET/);
  const cli=spawnSync(process.execPath,[path.join(root,'scripts/execution-usage.mjs'),'--invalid-secret'],{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(cli.status,1); assert.doesNotMatch(cli.stderr,/invalid-secret/);
});

test('installer and service restrict execution to orca with a clean credential environment', () => {
  const service=fs.readFileSync(path.join(root,'host/machine/systemd/dao-execution-usage.service'),'utf8');
  const installer=fs.readFileSync(path.join(root,'scripts/install-execution-usage.sh'),'utf8');
  const timer=fs.readFileSync(path.join(root,'host/machine/systemd/dao-execution-usage.timer'),'utf8');
  assert.match(service,/^User=orca$/m); assert.match(service,/^Group=orca$/m);
  assert.match(service,/^UnsetEnvironment=.*GH_TOKEN.*GITHUB_TOKEN/m);
  assert.match(service,/^Environment=GH_CONFIG_DIR=\/var\/empty$/m);
  assert.match(service,/^NoNewPrivileges=true$/m);
  assert.match(installer,/runuser -u orca -- env -i HOME=\/home\/orca/);
  assert.match(installer,/NextElapseUSecRealtime/);
  assert.match(timer,/^OnCalendar=/m);
});

test('same-process normalized API appends the allowlisted snapshot idempotently', async t => {
  const M=await modulePromise, f=fixture(t);
  const row=M.normalizeUsage({agent:'grok',source:'grok-native',event:usage(1)});
  row.prompt='PRIVATE MUTATION';
  assert.equal(M.appendUsage(row,f).committed,true);
  assert.equal(M.appendUsage(row,f).committed,false);
  assert.equal(inputTotal(M.reportUsage(f)),10);
});

test('actual ACP runner raw envelope preserves historical model and receivedAt', async t => {
  const M=await modulePromise, f=fixture(t);
  const dir=path.join(f.home,'.dao/execution/acp/sessions/acp1');
  write(path.join(dir,'context.json'),{agent:'grok',sessionKey:'acp:acp1',taskId:'actual-task'});
  write(path.join(dir,'status.json'),{agent:'grok',sessionKey:'acp:acp1',model:'model-after-switch',backendSessionId:'s'});
  write(path.join(dir,'usage.ndjson'),ndjson({receivedAt:ts(1),sessionKey:'acp:acp1',agent:'grok',model:'grok-original',backendSessionId:'s',raw:{method:'_x.ai/session/update',params:{sessionId:'s',update:{sessionUpdate:'turn_completed',prompt_id:'p',usage:{inputTokens:40,outputTokens:2}}}}}));
  M.collectUsage(f);
  const r=M.reportUsage(f);
  assert.equal(r.groups[0].model,'grok-original');
  assert.equal(r.groups[0].taskId,'actual-task');
  assert.equal(inputTotal(r),40);
});

test('completed ACP session lacking usage still appears with unknown metrics', async t => {
  const M=await modulePromise, f=fixture(t);
  write(path.join(f.home,'.dao/execution/acp/sessions/acp1/status.json'),{agent:'cursor',sessionKey:'acp:acp1',taskId:'missing-task',model:'composer',phase:'completed',updatedAt:ts(1),text:'PRIVATE RESULT'});
  assert.equal(M.collectUsage(f).committed,1);
  const r=M.reportUsage(f);
  assert.equal(r.groups[0].taskId,'missing-task');
  assert.equal(r.groups[0].metrics.inputTokens,null);
  assert.equal(r.groups[0].completeness.tokens,'unknown');
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE RESULT/);
});

test('summary without model joins a sole model; ambiguous multi-model summary remains explicit', async t => {
  const M=await modulePromise, f=fixture(t);
  app(M,f,usage(1));
  app(M,f,{sessionId:'session-a',timestamp:ts(2),cumulative:true,usage:{input_tokens:10}});
  assert.equal(inputTotal(M.reportUsage(f)),10);
  app(M,f,usage(3,{model:'grok-other'}));
  const r=M.reportUsage(f);
  assert.equal(inputTotal(r),40);
  assert.ok(r.gaps.includes('ambiguous_summary_attribution'));
  assert.equal(r.unallocatedSummaries[0].metrics.inputTokens,10);
});

test('a reused backend session is grouped by each task instead of the first task', async t => {
  const M=await modulePromise, f=fixture(t);
  app(M,f,usage(1),{taskId:'task-one'});
  app(M,f,usage(2),{taskId:'task-two'});
  const r=M.reportUsage(f);
  assert.equal(r.groups.length,2);
  assert.equal(r.groups.find(g=>g.taskId==='task-one').metrics.inputTokens,10);
  assert.equal(r.groups.find(g=>g.taskId==='task-two').metrics.inputTokens,20);
});

test('Cursor JSON export and latest account snapshot are collected without live account calls', async t => {
  const M=await modulePromise, f=fixture(t);
  write(path.join(f.home,'.cursor/usage.json'),{usageEventsDisplay:[{id:'cursor-r1',timestamp:ts(1),tokenUsage:{inputTokens:15,outputTokens:2},costInCents:2}]});
  write(path.join(f.home,'.cursor/account-usage.json'),{timestamp:ts(1),balance:{amount:5,unit:'credits'}});
  M.collectUsage(f);
  write(path.join(f.home,'.cursor/account-usage.json'),{timestamp:ts(2),balance:{amount:4,unit:'credits'}});
  fs.utimesSync(path.join(f.home,'.cursor/account-usage.json'),new Date(),new Date(Date.now()+1000));
  M.collectUsage(f);
  const r=M.reportUsage(f);
  assert.equal(inputTotal(r),15);
  assert.equal(r.accountSnapshots.length,1);
  assert.equal(r.accountSnapshots[0].balance.amount,4);
});

test('explicit Devin export CLI source commits a unified report and resume does not grow rows', async t => {
  const f=fixture(t), p=path.join(f.home,'export.json');
  write(p,{session_id:'devin-session',agent:{name:'devin',model_name:'SWE-1.7 Medium'},final_metrics:{total_prompt_tokens:57204,total_completion_tokens:205,total_cached_tokens:48640}});
  const args=[path.join(root,'scripts/execution-usage.mjs'),'--home',f.home,'--collect','--json','--source',`devin-export=${p}`];
  const run=()=>spawnSync(process.execPath,args,{encoding:'utf8',env:{PATH:process.env.PATH}});
  const one=run();assert.equal(one.status,0,one.stderr);
  const a=JSON.parse(one.stdout);
  assert.equal(a.groups[0].agent,'devin'); assert.equal(inputTotal(a),57204);
  const two=run();assert.equal(two.status,0,two.stderr);
  assert.equal(JSON.parse(two.stdout).observations,a.observations);
});

test('live collector lock is respected, a missing owner from an interrupted startup is recoverable', async t => {
  const M=await modulePromise, f=fixture(t), lock=path.join(f.dir,'collector.lock');
  write(path.join(lock,'owner.json'),{pid:process.pid});
  assert.equal(M.collectUsage({...f,sources:[]}).busy,true);
  fs.unlinkSync(path.join(lock,'owner.json'));
  const old=new Date(Date.now()-180000);fs.utimesSync(lock,old,old);
  const r=M.collectUsage({...f,sources:[]});
  assert.equal(r.busy,undefined);assert.ok(r.gaps.includes('no_usage_sources'));
  assert.equal(fs.existsSync(lock),false);
});

test('real Cursor native result schema retains tokens and model across collector restart', async t => {
  const M=await modulePromise,f=fixture(t),p=path.join(f.home,'.dao/execution/native/cursor-probe/stdout.ndjson');
  write(path.join(path.dirname(p),'context.json'),{agent:'cursor',taskId:'cursor-native-probe'});
  write(p,ndjson({type:'system',subtype:'init',session_id:'cursor-native',model:'composer-2.5[fast=true]',apiKeySource:'PRIVATE AUTH SOURCE',cwd:'/private/workspace'}));
  M.collectUsage(f);
  fs.appendFileSync(p,ndjson({type:'result',subtype:'success',session_id:'cursor-native',request_id:'cursor-request',duration_ms:10722,duration_api_ms:10722,result:'PRIVATE PROMPT RESULT',usage:{inputTokens:24726,outputTokens:262,cacheReadTokens:15433,cacheWriteTokens:0}}));
  M.collectUsage(f);
  const r=M.reportUsage(f),g=r.groups[0];
  assert.equal(g.agent,'cursor');assert.equal(g.model,'composer-2.5[fast=true]');
  assert.equal(g.metrics.inputTokens,24726);assert.equal(g.metrics.outputTokens,262);
  assert.equal(g.metrics.cacheReadTokens,15433);assert.equal(g.metrics.cacheWriteTokens,0);
  assert.equal(g.metrics.durationMs,10722);assert.equal(g.unknownCharges,1);
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE|private\/workspace/);
});

test('root exporter publishes allowlisted immutable rows; orca imports and dedups the same request', async t => {
  const M=await modulePromise,f=fixture(t);
  const {exportRootMirasim}=await import(pathToFileURL(path.join(root,'scripts/execution-usage-export.mjs')));
  const rootHome=path.join(f.home,'root-workbench'),privateDir=path.join(f.home,'root-private'),inbox=path.join(f.home,'root-inbox');
  const event={id:'shared-session:call',sessionId:'shared-session',agent:'codex',providerCallId:'same-provider-request',input:123,output:5,model:'gpt-model',viaRelay:true,prompt:'PRIVATE ROOT PROMPT',accountId:'ROOT_ACCOUNT_SECRET',authorization:'ROOT_AUTH_SECRET'};
  write(path.join(rootHome,'.mirasim/insights/usage-2026-09.ndjson'),ndjson(event));
  write(path.join(rootHome,'.dao/execution/usage-config.json'),{sources:[{path:'/must-not-read/auth',source:'secret'}]});
  const options={home:rootHome,dir:privateDir,inbox,readerGid:process.getgid?.()??0};
  const exported=exportRootMirasim(options);
  assert.equal(exported.exported.complete,true);assert.equal(exported.exported.published,1);
  const shard=fs.readdirSync(path.join(inbox,'rows'))[0],file=path.join(inbox,'rows',shard,fs.readdirSync(path.join(inbox,'rows',shard))[0]);
  const text=fs.readFileSync(file,'utf8');assert.doesNotMatch(text,/PRIVATE ROOT|ROOT_ACCOUNT_SECRET|ROOT_AUTH_SECRET|authorization|prompt/);
  if(process.platform!=='win32'){assert.equal(fs.statSync(file).mode&0o777,0o640);assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o750);}
  M.appendUsage({agent:'codex',source:'mirasim-ledger',event},f);
  const imported=M.collectUsage({...f,sources:[],inboxes:[inbox]});
  assert.equal(imported.complete,true);
  const report=M.reportUsage(f);assert.equal(report.deduplicatedRecords,1);assert.equal(inputTotal(report),123);
  assert.equal(exportRootMirasim(options).exported.published,0);
});

test('incomplete or missing root inbox is explicit, and unexpected serialized fields never cross it', async t => {
  const M=await modulePromise,f=fixture(t),inbox=path.join(f.home,'inbox');
  assert.ok(M.importUsageInbox(inbox,f).gaps.includes('inbox_missing'));
  const row=M.normalizeUsage({agent:'grok',source:'grok-native',event:usage(1)});
  const cleaned=M.sanitizeUsageObservation({...row,prompt:'SECRET EXTRA FIELD',credentials:{value:'SECRET AUTH'}});
  assert.doesNotMatch(JSON.stringify(cleaned),/SECRET EXTRA|SECRET AUTH|credentials|prompt/);
  assert.deepEqual(cleaned.aliases,row.aliases);
  write(path.join(inbox,'manifest.json'),{schema:1,complete:false,exportedAt:new Date().toISOString()});
  assert.ok(M.importUsageInbox(inbox,f).gaps.includes('inbox_export_incomplete'));
});

function cursorAccountFixture(t){
  const f=fixture(t),session='cursor-backend',taskId='cursor-acp-task',sessionKey='acp:fake-cursor';
  write(path.join(f.home,'.config/cursor/auth.json'),{accessToken:'FAKE_CURSOR_OAUTH_VALUE',refreshToken:'FAKE_REFRESH_VALUE'});
  write(path.join(f.home,'.dao/execution/acp/sessions/fake-cursor/status.json'),{sessionKey,backendSessionId:session,agent:'cursor',taskId,phase:'done',model:'composer-2.5[fast=true]',startedAt:ts(1),updatedAt:ts(3),accountPoolId:'cursor-shared',text:'PRIVATE ACP ANSWER'});
  write(path.join(f.home,'.dao/execution/sessions',encodeURIComponent(sessionKey)+'.json'),{sessionKey,agent:'cursor',taskId,provider:'cursor',accountPoolId:'cursor-shared',startedAt:ts(1)});
  return {...f,session,taskId};
}
function fakeDashboard(events,calls=[],total=events.length){
  return async(url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});
    assert.match(url,/^https:\/\/api2\.cursor\.sh\/aiserver\.v1\.DashboardService\/(GetCurrentPeriodUsage|GetFilteredUsageEvents)$/);
    assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,['Bearer','FAKE_CURSOR_OAUTH_VALUE'].join(' '));
    const body=url.endsWith('GetCurrentPeriodUsage')?{billingCycleStart:String(Date.parse(ts(1))),billingCycleEnd:String(Date.parse(ts(59))),planUsage:{totalSpend:500,remaining:200,limit:1000},displayMessage:'PRIVATE ACCOUNT DISPLAY'}:{totalUsageEventsCount:total,usageEventsDisplay:typeof events==='function'?events(JSON.parse(options.body).page):events};
    return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  };
}

test('official Cursor account events recover ACP tokens and actual charges by conversationId without rerunning a prompt', async t => {
  const M=await modulePromise,f=cursorAccountFixture(t),calls=[];
  M.collectUsage(f);
  const event={conversationId:f.session,timestamp:String(Date.parse(ts(2))),model:'composer-2.5-fast',tokenUsage:{inputTokens:21075,outputTokens:345,cacheReadTokens:30400,totalCents:8.36},chargedCents:8.36,userEmail:'PRIVATE_ACCOUNT@example.test'};
  const fetchImpl=fakeDashboard([event,{...event,conversationId:'other-conversation',tokenUsage:{inputTokens:999999}}],calls);
  const options={...f,fetchImpl,now:()=>Date.parse(ts(10))};
  const collected=await M.syncCursorAccountUsage(options);
  assert.equal(collected.complete,true);assert.equal(collected.matchedSessions,1);
  await M.syncCursorAccountUsage({...options,now:()=>Date.parse(ts(11))});
  const report=M.reportUsage(f),g=report.groups.find(g=>g.taskId===f.taskId);
  assert.equal(g.metrics.inputTokens,21075);assert.equal(g.metrics.outputTokens,345);assert.equal(g.metrics.cacheReadTokens,30400);
  assert.equal(g.metrics.cacheWriteTokens,0,'missing non-optional protobuf int32 is a reported default zero');
  assert.deepEqual(g.charges,[{unit:'USD',amount:0.0836}]);
  assert.equal(report.groups.length,1,'resolved status placeholder does not leave a fake unknown model group');
  assert.deepEqual(g.reportedModels,['composer-2.5-fast']);
  assert.equal(report.taskAccounting[0].tokens,'reported');assert.equal(report.taskAccounting[0].charges,'reported');
  assert.equal(report.taskAccounting[0].complete,true);
  const account=report.accountSnapshots[0];assert.equal(account.balance.amount,2);assert.equal(account.allowance.spent,5);
  assert.match(account.apiSource,/GetCurrentPeriodUsage$/);
  assert.doesNotMatch(JSON.stringify(report),/FAKE_CURSOR_OAUTH|FAKE_REFRESH|PRIVATE ACP|PRIVATE_ACCOUNT|PRIVATE ACCOUNT DISPLAY/);
  assert.equal(calls.length,4);
});

test('Cursor account polling keeps identical-looking distinct calls and separates missing chargedCents from estimates', async t => {
  const M=await modulePromise,f=cursorAccountFixture(t);
  const event={conversationId:f.session,timestamp:String(Date.parse(ts(2))),model:'composer-2.5-fast',tokenUsage:{inputTokens:100,outputTokens:5,totalCents:2}};
  await M.syncCursorAccountUsage({...f,now:()=>Date.parse(ts(10)),fetchImpl:fakeDashboard([event,event])});
  const report=M.reportUsage(f),g=report.groups[0];
  assert.equal(g.metrics.inputTokens,200);assert.equal(g.metrics.outputTokens,10);
  assert.deepEqual(g.estimates,[{unit:'USD',amount:0.04}]);assert.deepEqual(g.charges,[]);
  assert.equal(report.taskAccounting[0].charges,'unknown');
});

test('Cursor account pagination reaches matching older rows; no match retains per-task missing evidence and actual account snapshot', async t => {
  const M=await modulePromise,f=cursorAccountFixture(t),calls=[];
  M.collectUsage(f);
  const first=Array.from({length:100},(_,i)=>({conversationId:'other-'+i,timestamp:String(Date.parse(ts(8))),model:'other'}));
  const target={conversationId:f.session,timestamp:String(Date.parse(ts(3))),model:'composer',tokenUsage:{inputTokens:50,outputTokens:2},chargedCents:0};
  const limited=await M.syncCursorAccountUsage({...f,maxPages:1,now:()=>Date.parse(ts(10)),fetchImpl:fakeDashboard(()=>first,calls,101)});
  assert.ok(limited.gaps.includes('cursor_account_page_limit'));
  let r=M.reportUsage(f);assert.equal(r.taskAccounting[0].tokens,'unknown');assert.ok(r.taskAccounting[0].accountCheckedAt);assert.equal(r.accountSnapshots.length,1);
  const complete=await M.syncCursorAccountUsage({...f,now:()=>Date.parse(ts(11)),fetchImpl:fakeDashboard(page=>page===1?first:[target],calls,101)});
  assert.equal(complete.pages,2);assert.equal(complete.matchedSessions,1);
  r=M.reportUsage(f);assert.equal(r.taskAccounting[0].tokens,'reported');assert.equal(inputTotal(r),50);
});

test('Cursor account auth failures persist only bounded reason codes, never provider error bodies or auth values', async t => {
  const M=await modulePromise,f=cursorAccountFixture(t);
  const result=await M.syncCursorAccountUsage({...f,now:()=>Date.parse(ts(10)),fetchImpl:async()=>new Response('PRIVATE AUTH ERROR BODY',{status:401})});
  assert.ok(result.gaps.includes('cursor_account_auth_required'));
  assert.doesNotMatch(fs.readFileSync(path.join(f.dir,'cursor-account-sync.json'),'utf8'),/PRIVATE AUTH|FAKE_CURSOR/);
});

test('privileged export unit executes only installed root-owned code and leaves the collector as orca',()=>{
  const unit=fs.readFileSync(path.join(root,'host/machine/systemd/dao-execution-usage-export.service'),'utf8');
  const installer=fs.readFileSync(path.join(root,'scripts/install-execution-usage.sh'),'utf8');
  const collector=fs.readFileSync(path.join(root,'host/machine/systemd/dao-execution-usage.service'),'utf8');
  assert.match(unit,/^User=root$/m);assert.match(unit,/^PrivateNetwork=true$/m);
  assert.match(unit,/ExecStart=.*\/usr\/local\/lib\/dao-execution-usage\/execution-usage-export\.mjs/);
  assert.doesNotMatch(unit,/ExecStart=.*\/srv\//);
  assert.match(installer,/install -o root -g root -m 644 .*execution-usage-export\.mjs/);
  assert.match(collector,/^User=orca$/m);assert.match(collector,/--inbox \/var\/lib\/dao-execution-usage\/root-inbox/);
  assert.doesNotMatch(installer,/chmod.*\/root|setfacl.*\/root/);
});

test('global commit budget resumes both NDJSON and JSON arrays without starving later sources',async t=>{
  const M=await modulePromise,f=fixture(t),a=path.join(f.home,'a.ndjson'),b=path.join(f.home,'b.json');
  write(a,ndjson(usage(1),usage(2),usage(3)));
  write(b,[{id:'c1',tokenUsage:{inputTokens:7}},{id:'c2',tokenUsage:{inputTokens:8}}]);
  const options={...f,limits:{maxCommittedPerRun:1},sources:[{path:a,source:'grok-native'},{path:b,source:'cursor-account'}]};
  for(let i=0;i<5;i++)assert.equal(M.collectUsage(options).committed,1);
  assert.equal(M.collectUsage(options).committed,0);
  assert.equal(inputTotal(M.reportUsage(f)),75);
});

test('root publication and inbox import bound new durable writes while preserving backlog for restart',async t=>{
  const M=await modulePromise,f=fixture(t),inbox=path.join(f.home,'inbox'),consumer=path.join(f.home,'consumer');
  for(let i=1;i<=3;i++)M.appendUsage({agent:'grok',source:'mirasim-ledger',event:usage(i)},f);
  write(path.join(f.dir,'collection.json'),{complete:true});
  for(let i=0;i<3;i++){const p=M.publishUsageInbox({dir:f.dir,inbox,readerGid:process.getgid?.()??0,limits:{maxCommittedPerRun:1}});assert.equal(p.published,1);assert.equal(p.complete,i===2);}
  for(let i=0;i<3;i++)assert.equal(M.importUsageInbox(inbox,{dir:consumer,limits:{maxCommittedPerRun:1}}).committed,1);
  assert.equal(inputTotal(M.reportUsage({dir:consumer})),60);
});
