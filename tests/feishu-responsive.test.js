const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const moduleAt = name => import(pathToFileURL(path.join(__dirname, '../scripts', name)));
const repo = 'thoerwink8/windsurf-dao';
test('approved postponement stays out of refiner and never grants execution', async () => {
  const { selectCandidates } = await moduleAt('lib/refine-core.mjs');
  const issue = { number: 819, title: '以后再做', labels: ['已拍板'] };
  const r = selectCandidates([issue]);
  assert.equal(r.items.length, 0);
  assert.equal(r.skipped[0].number, 819);
  assert.deepEqual(issue.labels, ['已拍板']);
});
function event(id = 'om_decision') {
  return { action: { value: { repo, issue: '1174', choice: 'recommend' } },
    operator: { open_id: 'ou_test' }, context: { open_message_id: id, open_chat_id: 'oc_test' } };
}

test('a slow real child process leaves the callback event loop responsive', async () => {
  const { runAsync } = await moduleAt('lib/feishu-io.mjs');
  let finished = false;
  const child = runAsync(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("ok"), 700)'])
    .then(r => { finished = true; return r; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(finished, false, 'a synchronous child would have already blocked this timer');
  assert.equal((await child).stdout, 'ok');
});

test('refreshing many cards does not delay a decision; repeated refresh clicks coalesce', async () => {
  const M = await moduleAt('feishu-triage.mjs');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const store = { hubPending: { om_old: { repo, number: 1174 } }, save() {} };
  let reads = 0, updates = 0;
  const client = { updateCard: async () => { updates++; await gate; }, sendText: async () => {} };
  const options = { groups: {}, store, creds: { hubChatId: 'oc_test' }, client,
    read: async () => { reads++; return { ok: true, stdout: JSON.stringify([
      { number: 1174, title: '测试', labels: ['待拍板'], body: '' }]) }; } };
  const refresh = M.handleListPending(options);
  const repeated = M.handleListPending(options);
  assert.equal(repeated, refresh);
  await new Promise(resolve => setImmediate(resolve));
  const deferred = [];
  const ack = await M.liveCardAction(event(), { store, deps: { ghComment: async () => {} },
    defer: fn => deferred.push(fn), client });
  assert.match(ack.toast.content, /正在保存/);
  assert.equal(updates, 1);
  assert.equal(reads, 1);
  release();
  await refresh;
  await deferred[0]();
  assert.equal(store.hubPending.om_decision.decided.choice, 'recommend');
});

test('a failed GitHub write keeps the decision retryable and reports the failure', async () => {
  const M = await moduleAt('feishu-triage.mjs');
  const store = { hubPending: { om_decision: { repo, number: 1174 } }, save() {} };
  const deferred = [], replies = [];
  const ack = await M.liveCardAction(event(), { store,
    deps: { ghComment: async () => { throw new Error('unavailable'); } },
    client: { reply: async (_id, text) => replies.push(text) }, defer: fn => deferred.push(fn) });
  assert.equal(ack.card, undefined);
  await deferred[0]();
  assert.equal(store.hubPending.om_decision.decided, undefined);
  assert.match(replies[0], /未能确认已保存/);
});

test('conflicting clicks while saving reserve one issue even across two message IDs', async () => {
  const M = await moduleAt('feishu-triage.mjs');
  const store = { hubPending: { first: { repo, number: 1174 }, second: { repo, number: 1174 } }, save() {} };
  const deferred = [], comments = [];
  const args = { store, deps: { ghComment: async (...a) => comments.push(a) }, defer: fn => deferred.push(fn) };
  await M.liveCardAction(event('first'), args);
  const other = event('second'); other.action.value.choice = 'wait';
  const ack = await M.liveCardAction(other, args);
  assert.match(ack.toast.content, /上一项选择/);
  assert.equal(deferred.length, 1);
  await deferred[0]();
  assert.equal(comments.length, 1);
  assert.equal(store.hubPending.second.decided.choice, 'recommend');
});

test('a replacement refresh preserves a decision saved while the old update waits', async () => {
  const M = await moduleAt('feishu-triage.mjs');
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const store = { hubPending: { om_decision: { repo, number: 1174 } }, save() {} };
  const cards = [], deferred = [];
  let calls = 0;
  const client = { updateCard: async (_id, card) => {
    if (++calls === 1) { await blocked; throw Error('deleted'); }
    cards.push(card);
  }, sendCard: async () => 'om_replacement', sendText: async () => {} };
  const refresh = M.handleListPending({ groups: {}, store, creds: { hubChatId: 'oc_test' }, client,
    read: async () => ({ ok: true, stdout: JSON.stringify([{ number: 1174, labels: ['待拍板'] }]) }) });
  await new Promise(resolve => setImmediate(resolve));
  await M.liveCardAction(event(), { store, client, deps: { ghComment: async () => {} }, defer: fn => deferred.push(fn) });
  const save = deferred[0]();
  await new Promise(resolve => setImmediate(resolve));
  release();
  await Promise.all([refresh, save]);
  assert.equal(store.hubPending.om_replacement.decided.choice, 'recommend');
  assert.match(cards.at(-1).header.title.content, /已拍/);
});

test('local save failure after GitHub success never claims the decision was not saved', async () => {
  const M = await moduleAt('feishu-triage.mjs');
  const store = { hubPending: {}, save() { throw Error('disk full'); } };
  const replies = [], deferred = [];
  await M.liveCardAction(event(), { store, deps: { ghComment: async () => {} },
    client: { reply: async (_id, text) => replies.push(text) }, defer: fn => deferred.push(fn) });
  await deferred[0]();
  assert.equal(store.hubPending.om_decision.decided.choice, 'recommend');
  assert.equal(replies.some(text => /还没有保存|未能确认/.test(text)), false);
});

test('stale GitHub read cannot reopen an issue already decided on a different card', async () => {
  const M = await moduleAt('feishu-triage.mjs');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const store = { hubPending: {}, save() {} }, deferred = [], sent = [], comments = [];
  const client = { sendCard: async (_chat, card) => { sent.push(card); return 'om_new'; }, sendText: async () => {} };
  const refresh = M.handleListPending({ groups: {}, store, creds: { hubChatId: 'oc_test' }, client,
    read: async () => { await gate; return { ok: true, stdout: JSON.stringify([{ number: 1174, labels: ['待拍板'] }]) }; } });
  const args = { store, client, deps: { ghComment: async (...a) => comments.push(a) }, defer: fn => deferred.push(fn) };
  const wait = event('om_old'); wait.action.value.choice = 'wait';
  await M.liveCardAction(wait, args); await deferred[0]();
  release(); await refresh;
  assert.equal(sent.length, 0);
  const duplicate = await M.liveCardAction(event('om_new'), args);
  assert.match(duplicate.toast.content, /已经拍过/);
  await deferred[1]();
  assert.equal(comments.length, 1);
  assert.equal(store.hubPending.om_old.decided.choice, 'wait');
});

test('a deleted alias does not prevent updating the surviving decision card', async () => {
  const M = await moduleAt('feishu-triage.mjs');
  const store = { hubPending: { deleted: { repo, number: 1174 }, live: { repo, number: 1174 } }, save() {} };
  const patches = [], deferred = [];
  await M.liveCardAction(event('live'), { store, deps: { ghComment: async () => {} }, defer: fn => deferred.push(fn),
    client: { updateCard: async id => { patches.push(id); if (id === 'deleted') throw Error('gone'); } } });
  await deferred[0]();
  assert.deepEqual(patches, ['deleted', 'live']);
});

test('failed card replacement reports failure instead of a successful count', async () => {
  const M = await moduleAt('feishu-triage.mjs');
  const sent = [];
  const store = { hubPending: { om_old: { repo, number: 1174 } }, save() {} };
  const r = await M.handleListPending({ groups: {}, store, creds: { hubChatId: 'oc_test' },
    read: async () => ({ ok: true, stdout: JSON.stringify([{ number: 1174, labels: ['待拍板'] }]) }),
    client: { updateCard: async () => { throw Error('deleted'); },
      sendCard: async () => { throw Error('unavailable'); }, sendText: async (_id, text) => sent.push(text) } });
  assert.equal(r.applied.ok, false);
  assert.match(sent[0], /1 张卡片未发送成功/);
});
