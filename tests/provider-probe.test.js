// provider-probe：派前探一针（#842）—— 用本地 fake HTTP server 验判据
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const LIB = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'provider-probe.mjs').replace(/\\/g, '/');

// fake gateway/codex server：按路径 + 查询串决定行为
let server;
let base;
before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const mode = u.searchParams.get('mode') || 'ok';
    // 认证：Authorization: Bearer faketoken / x-api-key: faketoken 才放行；否则 401（模拟假 token）
    const auth = req.headers['authorization'] || '';
    const xkey = req.headers['x-api-key'] || '';
    if (u.searchParams.get('checkauth') === '1' && !/faketoken/.test(auth) && !/faketoken/.test(xkey)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid token"}');
      return;
    }
    if (mode === '502') {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('bad gateway');
      return;
    }
    if (mode === 'hang') {
      // 不回，触发超时
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'empty') {
      // 2xx 空流：只发心跳/DONE，没有真内容
      res.write('data: {"choices":[{"delta":{}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (mode === 'anthropic') {
      res.write('event: content_block_delta\n');
      res.write('data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n');
      res.end();
      return;
    }
    if (mode === 'codex') {
      res.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
      res.end();
      return;
    }
    if (mode === 'pqfail') {
      // pqapi 实况：先发 `: PING` 心跳（不算内容、不算 error），再 response.failed
      res.write(': PING\n\n');
      res.write('event: response.failed\n');
      res.write('data: {"type":"response.failed","response":{"error":{"code":"dispatch_queue_timeout","message":"request timed out in the dispatch queue"}}}\n\n');
      res.end();
      return;
    }
    // openai 正常流：一段真 content
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

const gwConf = () => ({ ok: true, gateway: base, providers: [{ id: 'gw-dspool', token: 'faketoken', models: ['deepseek-v4-flash'] }, { id: 'gw', token: 'faketoken', models: ['grok-4.6'] }] });

describe('planProbe', () => {
  it('gw-dspool → anthropic /v1/messages，target 短名，headers 不含 key 明文', async () => {
    const { planProbe } = await import(LIB);
    const p = planProbe({ provider: 'gw', cli_model: 'gw-dspool/deepseek-v4-flash' }, { gatewayConfig: gwConf() });
    assert.equal(p.kind, 'gw-anthropic');
    assert.ok(p.url.endsWith('/v1/messages'), p.url);
    assert.equal(p.target, 'gw:dspool/deepseek-v4-flash');
    assert.equal(p.model, 'deepseek-v4-flash');
    // headers 只放打码描述，不含真 token
    assert.ok(!JSON.stringify(p.headers).includes('faketoken'));
  });
  it('gw（grok 组）→ openai /v1/chat/completions', async () => {
    const { planProbe } = await import(LIB);
    const p = planProbe({ provider: 'gw', cli_model: 'gw/grok-4.6' }, { gatewayConfig: gwConf() });
    assert.equal(p.kind, 'gw-openai');
    assert.ok(p.url.endsWith('/v1/chat/completions'), p.url);
    assert.equal(p.target, 'gw:grok/grok-4.6');
  });
  it('gpt → codex-responses /responses', async () => {
    const { planProbe } = await import(LIB);
    const p = planProbe({ provider: 'gpt', cli_model: 'gpt-5.6-sol' }, { codexConfig: { ok: true, baseUrl: base, authPath: '/x/auth.json' } });
    assert.equal(p.kind, 'codex-responses');
    assert.ok(p.url.endsWith('/responses'), p.url);
    assert.equal(p.target, 'direct:codex@pqapi/responses');
  });
  it('cursor/opencode-go/devin/grok → unscanned（不许当绿）', async () => {
    const { planProbe } = await import(LIB);
    for (const provider of ['cursor', 'opencode-go', 'devin', 'grok']) {
      const p = planProbe({ provider, cli_model: `${provider}/x` });
      assert.equal(p.kind, 'unscanned', provider);
    }
  });
});

describe('runProbe（判据：流式+真内容）', () => {
  const openaiPlan = (mode) => ({ kind: 'gw-openai', group: 'gw-dspool', url: `${base}/v1/chat/completions?checkauth=1&mode=${mode}`, body: { model: 'x', stream: true, messages: [] }, target: 'gw:dspool/x' });

  it('正常流 → green', async () => {
    const { runProbe } = await import(LIB);
    const r = await runProbe(openaiPlan('ok'), { gatewayConfig: gwConf() });
    assert.equal(r.state, 'green', JSON.stringify(r));
    assert.equal(r.code, 200);
  });
  it('2xx 空流 → red', async () => {
    const { runProbe } = await import(LIB);
    const r = await runProbe(openaiPlan('empty'), { gatewayConfig: gwConf() });
    assert.equal(r.state, 'red', JSON.stringify(r));
    assert.equal(r.code, 200);
    assert.match(r.why, /空流/);
  });
  it('502 → red', async () => {
    const { runProbe } = await import(LIB);
    const r = await runProbe(openaiPlan('502'), { gatewayConfig: gwConf() });
    assert.equal(r.state, 'red');
    assert.equal(r.code, 502);
  });
  it('超时 → red', async () => {
    const { runProbe } = await import(LIB);
    const r = await runProbe(openaiPlan('hang'), { gatewayConfig: gwConf(), timeoutMs: 300 });
    assert.equal(r.state, 'red');
    assert.match(r.why, /超时/);
  });
  it('假 token（401）→ red', async () => {
    const { runProbe } = await import(LIB);
    const badConf = { ok: true, gateway: base, providers: [{ id: 'gw-dspool', token: 'WRONG', models: [] }] };
    const r = await runProbe(openaiPlan('ok'), { gatewayConfig: badConf });
    assert.equal(r.state, 'red', JSON.stringify(r));
    assert.equal(r.code, 401);
  });
  it('anthropic 流 → green', async () => {
    const { runProbe } = await import(LIB);
    const plan = { kind: 'gw-anthropic', group: 'gw-dspool', url: `${base}/v1/messages?mode=anthropic`, body: {}, target: 'gw:dspool/x' };
    const r = await runProbe(plan, { gatewayConfig: gwConf() });
    assert.equal(r.state, 'green', JSON.stringify(r));
  });
  it('codex responses 流 → green', async () => {
    const { runProbe } = await import(LIB);
    const plan = { kind: 'codex-responses', url: `${base}/responses?mode=codex`, body: {}, target: 'direct:codex@pqapi/responses', authPath: 'INJECT' };
    // 注入 codex auth 读取
    const read = (p) => (p === 'INJECT' ? JSON.stringify({ OPENAI_API_KEY: 'faketoken' }) : '');
    const exists = () => true;
    const r = await runProbe(plan, { read, exists });
    assert.equal(r.state, 'green', JSON.stringify(r));
  });
  it('codex 流内 response.failed（心跳后失败）→ red，surface dispatch_queue_timeout', async () => {
    const { runProbe } = await import(LIB);
    const plan = { kind: 'codex-responses', url: `${base}/responses?mode=pqfail`, body: {}, target: 'direct:codex@pqapi/responses', authPath: 'INJECT' };
    const read = (p) => (p === 'INJECT' ? JSON.stringify({ OPENAI_API_KEY: 'faketoken' }) : '');
    const r = await runProbe(plan, { read, exists: () => true });
    assert.equal(r.state, 'red', JSON.stringify(r));
    assert.match(r.why, /dispatch_queue_timeout|流内失败/);
  });
  it('未知 provider（unscanned plan）→ unscanned', async () => {
    const { runProbe } = await import(LIB);
    const r = await runProbe({ kind: 'unscanned', why: 'x' });
    assert.equal(r.state, 'unscanned');
  });
});
