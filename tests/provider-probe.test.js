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
      // 完整 anthropic 流：有内容 + message_delta(stop_reason) + message_stop
      res.write('event: message_start\n');
      res.write('data: {"type":"message_start","message":{"id":"m1","model":"x"}}\n\n');
      res.write('event: content_block_delta\n');
      res.write('data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n');
      res.write('event: content_block_stop\n');
      res.write('data: {"type":"content_block_stop","index":0}\n\n');
      res.write('event: message_delta\n');
      res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
      res.write('event: message_stop\n');
      res.write('data: {"type":"message_stop"}\n\n');
      res.end();
      return;
    }
    if (mode === 'anthropic-cut') {
      // #953 反例：有 delta，流就断了——客户端看到的 `stream ended before message_stop`
      res.write('event: message_start\n');
      res.write('data: {"type":"message_start","message":{"id":"m1","model":"x"}}\n\n');
      res.write('event: content_block_delta\n');
      res.write('data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n');
      res.end();
      return;
    }
    if (mode === 'anthropic-done') {
      // anthropic 口给 [DONE] 不算收尾（它要 message_stop）——判别 [DONE] 有没有被当万能收尾
      res.write('data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (mode === 'codex') {
      res.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
      res.write('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
      res.end();
      return;
    }
    if (mode === 'codex-cut') {
      res.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
      res.end();
      return;
    }
    if (mode === 'truncated') {
      // openai 口：有 content，没 finish_reason 也没 [DONE]
      res.write('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
      res.end();
      return;
    }
    if (mode === 'finish') {
      res.write('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (mode === 'stall') {
      // 有内容后挂住不收尾：超时也得是 no_finish，不是「超时红」
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
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

describe('runProbe（判据：流式+真内容+正常收尾）', () => {
  const openaiPlan = (mode) => ({ kind: 'gw-openai', group: 'gw-dspool', url: `${base}/v1/chat/completions?checkauth=1&mode=${mode}`, body: { model: 'x', stream: true, messages: [] }, target: 'gw:dspool/x' });

  it('正常流 → green', async () => {
    const { runProbe } = await import(LIB);
    const r = await runProbe(openaiPlan('ok'), { gatewayConfig: gwConf() });
    assert.equal(r.state, 'green', JSON.stringify(r));
    assert.equal(r.code, 200);
    assert.equal(r.finish, '[DONE]');
  });
  it('带 finish_reason 的完整流 → green，记下 finish reason', async () => {
    const { runProbe } = await import(LIB);
    const r = await runProbe(openaiPlan('finish'), { gatewayConfig: gwConf() });
    assert.equal(r.state, 'green', JSON.stringify(r));
    assert.equal(r.finish, 'finish_reason');
    assert.equal(r.finishReason, 'stop');
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
  it('anthropic 完整流（到 message_stop）→ green，带 stop_reason', async () => {
    const { runProbe } = await import(LIB);
    const plan = { kind: 'gw-anthropic', group: 'gw-dspool', url: `${base}/v1/messages?mode=anthropic`, body: {}, target: 'gw:dspool/x' };
    const r = await runProbe(plan, { gatewayConfig: gwConf() });
    assert.equal(r.state, 'green', JSON.stringify(r));
    assert.equal(r.finish, 'message_stop');
    assert.equal(r.finishReason, 'end_turn');
  });
  it('codex responses 完整流（到 response.completed）→ green', async () => {
    const { runProbe } = await import(LIB);
    const plan = { kind: 'codex-responses', url: `${base}/responses?mode=codex`, body: {}, target: 'direct:codex@pqapi/responses', authPath: 'INJECT' };
    // 注入 codex auth 读取
    const read = (p) => (p === 'INJECT' ? JSON.stringify({ OPENAI_API_KEY: 'faketoken' }) : '');
    const exists = () => true;
    const r = await runProbe(plan, { read, exists });
    assert.equal(r.state, 'green', JSON.stringify(r));
    assert.equal(r.finish, 'response.completed');
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

// —— #953：流没收尾必须单独一态 ——
// 反例（截断流）不被拦住，等于这条判据没上线；反证（完整流判绿）不过，等于它是恒红。
describe('runProbe 收尾判据（no_finish 不许混进 green / red）', () => {
  const openaiPlan = (mode, extra = {}) => ({ kind: 'gw-openai', group: 'gw-dspool', url: `${base}/v1/chat/completions?mode=${mode}`, body: {}, target: 'gw:dspool/x', ...extra });
  const codexOpts = { read: (p) => (p === 'INJECT' ? JSON.stringify({ OPENAI_API_KEY: 'faketoken' }) : ''), exists: () => true };

  it('反例①：openai 口有 delta 但没 finish_reason / [DONE] → no_finish（不是 green）', async () => {
    const { runProbe } = await import(LIB);
    const r = await runProbe(openaiPlan('truncated'), { gatewayConfig: gwConf() });
    assert.equal(r.state, 'no_finish', JSON.stringify(r));
    assert.equal(r.code, 200);
    assert.equal(r.finish, null);
    assert.match(r.why, /没收尾/);
    assert.match(r.why, /finish_reason/);
  });
  it('反例②：anthropic 口断在 content_block_delta（stream ended before message_stop）→ no_finish', async () => {
    const { runProbe } = await import(LIB);
    const plan = { kind: 'gw-anthropic', group: 'gw-dspool', url: `${base}/v1/messages?mode=anthropic-cut`, body: {}, target: 'gw:dspool/x' };
    const r = await runProbe(plan, { gatewayConfig: gwConf() });
    assert.equal(r.state, 'no_finish', JSON.stringify(r));
    assert.match(r.why, /message_stop/);
    assert.match(r.why, /content_block_delta/); // 断在哪一步要能回答
  });
  it('anthropic 口的 [DONE] 不顶 message_stop → no_finish', async () => {
    const { runProbe } = await import(LIB);
    const plan = { kind: 'gw-anthropic', group: 'gw-dspool', url: `${base}/v1/messages?mode=anthropic-done`, body: {}, target: 'gw:dspool/x' };
    const r = await runProbe(plan, { gatewayConfig: gwConf() });
    assert.equal(r.state, 'no_finish', JSON.stringify(r));
  });
  it('codex 口只有 output_text.delta、没 response.completed → no_finish', async () => {
    const { runProbe } = await import(LIB);
    const plan = { kind: 'codex-responses', url: `${base}/responses?mode=codex-cut`, body: {}, target: 'direct:codex@pqapi/responses', authPath: 'INJECT' };
    const r = await runProbe(plan, codexOpts);
    assert.equal(r.state, 'no_finish', JSON.stringify(r));
    assert.match(r.why, /response\.completed/);
  });
  it('有内容后挂住到超时 → no_finish（说明是等收尾超时，不是「上游没回」那种红）', async () => {
    const { runProbe } = await import(LIB);
    const r = await runProbe(openaiPlan('stall'), { gatewayConfig: gwConf(), timeoutMs: 400 });
    assert.equal(r.state, 'no_finish', JSON.stringify(r));
    assert.match(r.why, /超时/);
  });
  it('判别力：同一条判据下，完整流仍判 green（不是恒红）', async () => {
    const { runProbe } = await import(LIB);
    const r = await runProbe(openaiPlan('finish'), { gatewayConfig: gwConf() });
    assert.equal(r.state, 'green', JSON.stringify(r));
  });
  it('四态互不相等：green / no_finish / red / unscanned 在输出上分得开', async () => {
    const { runProbe } = await import(LIB);
    const states = [
      (await runProbe(openaiPlan('finish'), { gatewayConfig: gwConf() })).state,
      (await runProbe(openaiPlan('truncated'), { gatewayConfig: gwConf() })).state,
      (await runProbe(openaiPlan('502'), { gatewayConfig: gwConf() })).state,
      (await runProbe({ kind: 'unscanned', why: 'x' })).state,
    ];
    assert.deepEqual(states, ['green', 'no_finish', 'red', 'unscanned']);
    assert.equal(new Set(states).size, 4);
  });
});

describe('extractFinish / settleScan（纯函数判据）', () => {
  it('extractFinish 按口分：finish_reason=null 不算收尾，[DONE] 不是 anthropic 的收尾', async () => {
    const { extractFinish } = await import(LIB);
    assert.equal(extractFinish('gw-openai', { choices: [{ delta: { content: 'hi' }, finish_reason: null }] }), null);
    assert.deepEqual(extractFinish('gw-openai', { choices: [{ delta: {}, finish_reason: 'stop' }] }), { event: 'finish_reason', reason: 'stop' });
    assert.equal(extractFinish('gw-anthropic', { type: 'content_block_stop' }), null);
    assert.deepEqual(extractFinish('gw-anthropic', { type: 'message_stop' }), { event: 'message_stop', reason: null });
    assert.equal(extractFinish('codex-responses', { type: 'response.output_text.delta', delta: 'hi' }), null);
    assert.deepEqual(extractFinish('codex-responses', { type: 'response.completed' }), { event: 'response.completed', reason: null });
    assert.deepEqual(
      extractFinish('codex-responses', { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }),
      { event: 'response.incomplete', reason: 'max_output_tokens' },
    );
  });
  it('scanLine 见内容不喊停（一见内容就停就永远看不到收尾）', async () => {
    const { scanLine, newScan } = await import(LIB);
    const scan = newScan();
    assert.equal(scanLine('gw-openai', 'data: {"choices":[{"delta":{"content":"hi"}}]}', scan), false);
    assert.equal(scan.gotContent, true);
    assert.equal(scanLine('gw-openai', 'data: [DONE]', scan), true);
    assert.equal(scan.finishEvent, '[DONE]');
  });
  it('scanLine 跳过心跳与非 data 字段行', async () => {
    const { scanLine, newScan } = await import(LIB);
    const scan = newScan();
    for (const line of [': PING', '', 'event: message_stop', 'id: 1']) {
      assert.equal(scanLine('gw-anthropic', line, scan), false, line);
    }
    assert.equal(scan.finishEvent, null); // event 字段行不当收尾证据
    assert.equal(scan.dataLines, 0);
  });
  it('settleScan 四态：空流红 / 有内容没收尾 no_finish / 齐了才绿 / 流内错误红', async () => {
    const { settleScan, newScan } = await import(LIB);
    const at = (patch) => settleScan('gw-anthropic', { ...newScan(), ...patch }, { code: 200, ms: 1, timeoutMs: 5000 });
    assert.equal(at({ finishEvent: 'message_stop' }).state, 'red');           // 收了尾但没内容
    assert.equal(at({ gotContent: true }).state, 'no_finish');                 // 有内容没收尾
    assert.equal(at({ gotContent: true, finishEvent: 'message_stop' }).state, 'green');
    assert.equal(at({ gotContent: true, error: 'boom' }).state, 'red');        // 上游自报失败最硬
  });
  it('settleScan：没内容就超时是 red，有内容才是 no_finish', async () => {
    const { settleScan, newScan } = await import(LIB);
    const opt = { code: 200, ms: 1, timeoutMs: 300, aborted: true };
    assert.equal(settleScan('gw-openai', newScan(), opt).state, 'red');
    assert.equal(settleScan('gw-openai', { ...newScan(), gotContent: true }, opt).state, 'no_finish');
    // 连接被掐断（非超时）同理
    const cut = { code: 200, ms: 1, netError: 'terminated' };
    assert.equal(settleScan('gw-openai', newScan(), cut).state, 'red');
    assert.equal(settleScan('gw-openai', { ...newScan(), gotContent: true }, cut).state, 'no_finish');
  });
});
