const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const mod = import('../scripts/lib/acp-client.mjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function transport(t, options = {}) {
  const { AcpClient } = await mod;
  const readable = new PassThrough();
  const writes = [];
  const writable = new Writable({ write(chunk, _encoding, callback) { writes.push(chunk.toString()); setImmediate(callback); } });
  const client = new AcpClient({ readable, writable, ...options });
  t.after(() => { client.close(); readable.destroy(); writable.destroy(); });
  return { client, readable, writes, send: frame => readable.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n') };
}

test('JSON-RPC correlates out-of-order responses while a human request is blocked', async t => {
  let answer;
  const { client, send, writes } = await transport(t, { onRequest: () => new Promise(resolve => { answer = resolve; }) });
  send({ id: 'human-1', method: 'cursor/ask_question', params: { questions: [] } });
  const first = client.request('one', {});
  const second = client.request('two', {});
  await tick(); await tick();
  const ids = writes.map(line => JSON.parse(line)).filter(frame => frame.method).map(frame => frame.id);
  assert.equal(ids.length, 2);
  send({ id: ids[1], result: { number: 2 } });
  send({ id: ids[0], result: { number: 1 } });
  assert.deepEqual(await Promise.all([first, second]), [{ number: 1 }, { number: 2 }]);
  assert.equal(writes.some(line => JSON.parse(line).id === 'human-1'), false);
  answer({ outcome: { outcome: 'cancelled' } });
  await tick(); await tick();
  assert.equal(JSON.parse(writes.at(-1)).id, 'human-1');
});

test('fragmented UTF-8 ACP notifications preserve the exact text and ordering', async t => {
  const received = [];
  const { readable } = await transport(t, { onNotification: (_method, params) => received.push(params.text) });
  const first = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { text: '问答 🌿' } }) + '\n');
  for (const byte of first) readable.write(Buffer.from([byte]));
  readable.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { text: 'next' } }) + '\n');
  await tick();
  assert.deepEqual(received, ['问答 🌿', 'next']);
});

test('unsupported blocking requests get JSON-RPC method-not-found instead of hanging', async t => {
  const { send, writes } = await transport(t);
  send({ id: 10, method: 'unknown/blocking', params: {} });
  await tick(); await tick();
  assert.equal(JSON.parse(writes[0]).error.code, -32601);
});

test('malformed and oversized protocol frames reject pending work without exposing raw bytes', async t => {
  for (const [line, expected] of [['raw-private-credential\n', 'invalid_json'], ['x'.repeat(200), 'frame_too_large']]) {
    const { client, readable } = await transport(t, { maxFrameBytes: 100 });
    const request = client.request('initialize', {});
    const rejected = assert.rejects(request, error => error.code === expected && !error.message.includes('raw-private-credential'));
    readable.write(line);
    await rejected;
    assert.equal(client.closed, true);
  }
});

test('transport closure settles every outstanding request', async t => {
  const { client, readable } = await transport(t);
  const requests = [client.request('initialize'), client.request('session/prompt', {}, { timeoutMs: 0 })];
  const rejected = requests.map(request => assert.rejects(request, error => error.code === 'transport_closed'));
  readable.end();
  await Promise.all(rejected);
});
