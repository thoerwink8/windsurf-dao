// #1012：出站待拍板卡片。判别：缺 {repo,number} 拒发；飞书失败报没送进群；
// 发出去的卡必须是 buildHubCard 那一份；普通播报不许走这条路。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const toUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const LIB = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'hub-ask.mjs')));
const CARD = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'feishu-hub-card.mjs')));
const CLI = import(toUrl(path.join(ROOT, 'scripts', 'hub-ask.mjs')));

const REPO = 'thoerwink8/windsurf-dao';

describe('validateHubAsk：缺 {repo, number} 拒发', () => {
  it('缺仓库', async () => {
    const { validateHubAsk } = await LIB;
    const r = validateHubAsk({ number: 1012 });
    assert.equal(r.ok, false);
    assert.match(r.error, /缺仓库/);
    assert.match(r.error, /对不回单/);
  });

  it('缺单号', async () => {
    const { validateHubAsk } = await LIB;
    const r = validateHubAsk({ repo: REPO });
    assert.equal(r.ok, false);
    assert.match(r.error, /缺单号/);
  });

  it('单号不是正整数', async () => {
    const { validateHubAsk } = await LIB;
    assert.equal(validateHubAsk({ repo: REPO, number: 0 }).ok, false);
    assert.equal(validateHubAsk({ repo: REPO, number: -3 }).ok, false);
    assert.equal(validateHubAsk({ repo: REPO, number: 'x' }).ok, false);
  });

  it('齐了才过', async () => {
    const { validateHubAsk } = await LIB;
    const r = validateHubAsk({ repo: REPO, number: '1012' });
    assert.equal(r.ok, true);
    assert.equal(r.repo, REPO);
    assert.equal(r.number, 1012);
  });
});

describe('runHubAsk：复用 buildHubCard + 记 hubPending + 认回执', () => {
  it('成功路径：卡片就是 buildHubCard 那份，pending 写上 {repo, number}', async () => {
    const { runHubAsk } = await LIB;
    const { buildHubCard } = await CARD;
    const fields = {
      repo: REPO, number: 1012, title: '主动问',
      what: '待拍板只发纯文字', impact: '手机上点不了',
      recommend: '发带按钮的卡', why: '用户要 Linux 也弹卡',
    };
    const store = { hubPending: {} };
    const sent = [];
    const r = runHubAsk(fields, {
      store,
      send: (card) => { sent.push(card); return { ok: true, messageId: 'om_card_1012' }; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.messageId, 'om_card_1012');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], buildHubCard(fields));
    assert.equal(store.hubPending.om_card_1012.repo, REPO);
    assert.equal(store.hubPending.om_card_1012.number, 1012);
    assert.equal(store.hubPending.om_card_1012.what, '待拍板只发纯文字');
    assert.match(sent[0].header.title.content, /待拍板：/);
    assert.equal(sent[0].elements[1].actions.length, 3);
  });

  it('send 失败：报没送进群，不写 pending', async () => {
    const { runHubAsk } = await LIB;
    const store = { hubPending: {} };
    const r = runHubAsk({ repo: REPO, number: 1012 }, {
      store,
      send: () => ({ ok: false, error: '没送进群：飞书 500' }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /没送进群/);
    assert.equal(Object.keys(store.hubPending).length, 0);
  });

  it('send 抛错：报没送进群', async () => {
    const { runHubAsk } = await LIB;
    const r = runHubAsk({ repo: REPO, number: 1012 }, {
      store: { hubPending: {} },
      send: () => { throw new Error('network down'); },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /没送进群/);
    assert.match(r.error, /network down/);
  });

  it('退出码 0 但没 message_id：失败', async () => {
    const { runHubAsk } = await LIB;
    const r = runHubAsk({ repo: REPO, number: 1012 }, {
      store: { hubPending: {} },
      send: () => ({ ok: true, messageId: 'null' }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /没送进群/);
    assert.match(r.error, /message_id/);
  });

  it('没有 store：拒发', async () => {
    const { runHubAsk } = await LIB;
    const r = runHubAsk({ repo: REPO, number: 1012 }, {
      send: () => ({ ok: true, messageId: 'om_x' }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /hubPending/);
  });

  it('缺仓库：send 根本不调', async () => {
    const { runHubAsk } = await LIB;
    let called = 0;
    const r = runHubAsk({ number: 1012 }, {
      store: { hubPending: {} },
      send: () => { called += 1; return { ok: true, messageId: 'om_x' }; },
    });
    assert.equal(r.ok, false);
    assert.equal(called, 0);
  });

  it('已有 decided 的 pending 不被后写冲掉', async () => {
    const { runHubAsk } = await LIB;
    const store = {
      hubPending: {
        om_card_1012: { repo: REPO, number: 1012, decided: { choice: 'recommend', who: '老板' } },
      },
    };
    const r = runHubAsk({ repo: REPO, number: 1012, what: '新卡' }, {
      store,
      send: () => ({ ok: true, messageId: 'om_card_1012' }),
    });
    assert.equal(r.ok, true);
    assert.equal(store.hubPending.om_card_1012.decided.choice, 'recommend');
    assert.equal(store.hubPending.om_card_1012.what, '新卡');
  });
});

describe('classifySendResult / parseMessageId', () => {
  it('ENOENT → 没送进群', async () => {
    const { classifySendResult } = await LIB;
    const r = classifySendResult({ error: { code: 'ENOENT', message: 'not found' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /没送进群/);
  });

  it('非 0 退出 → 没送进群', async () => {
    const { classifySendResult } = await LIB;
    const r = classifySendResult({ status: 1, stderr: 'permission denied' });
    assert.equal(r.ok, false);
    assert.match(r.error, /没送进群/);
    assert.match(r.error, /permission denied/);
  });

  it('stdout 空 / null 字面量都不算发出去', async () => {
    const { classifySendResult, parseMessageId } = await LIB;
    assert.equal(parseMessageId(''), '');
    assert.equal(parseMessageId('null'), '');
    assert.equal(parseMessageId('"om_abc"'), 'om_abc');
    assert.equal(classifySendResult({ status: 0, stdout: '' }).ok, false);
    assert.equal(classifySendResult({ status: 0, stdout: 'null' }).ok, false);
    const ok = classifySendResult({ status: 0, stdout: '"om_abc"\n' });
    assert.equal(ok.ok, true);
    assert.equal(ok.messageId, 'om_abc');
  });
});

describe('fieldsFrom*：没单号拒，有单号才组卡', () => {
  it('escalate 缺号拒', async () => {
    const { fieldsFromEscalate } = await LIB;
    const r = fieldsFromEscalate({ repo: REPO, why: '报帅' });
    assert.equal(r.ok, false);
  });

  it('escalate 双向门带推荐', async () => {
    const { fieldsFromEscalate } = await LIB;
    const r = fieldsFromEscalate({
      repo: REPO, number: 42, why: '缺审官标', reason: 'missing-labels',
    });
    assert.equal(r.ok, true);
    assert.equal(r.fields.number, 42);
    assert.match(r.fields.deadline, /双向门/);
    assert.match(r.fields.recommend, /大脑边界内处置/);
  });

  it('inventory / breaker 同样要单号', async () => {
    const { fieldsFromInventory, fieldsFromBreaker } = await LIB;
    assert.equal(fieldsFromInventory({ repo: REPO, key: 'orphan-cwd' }).ok, false);
    assert.equal(fieldsFromBreaker({ repo: REPO, text: '全开' }).ok, false);
    const inv = fieldsFromInventory({ repo: REPO, number: 7, key: 'orphan-cwd', detail: '工位拆了' });
    assert.equal(inv.ok, true);
    assert.equal(inv.fields.what, '工位拆了');
    const br = fieldsFromBreaker({ repo: REPO, number: 9, text: '全部路径 open' });
    assert.equal(br.ok, true);
    assert.equal(br.fields.number, 9);
  });
});

describe('CLI：缺参退非 0；help 不发卡', () => {
  it('parseHubAskArgs 认 --repo/--number', async () => {
    const { parseHubAskArgs } = await CLI;
    const o = parseHubAskArgs(['--repo', REPO, '--number', '1012', '--what', 'x']);
    assert.equal(o.repo, REPO);
    assert.equal(o.number, '1012');
    assert.equal(o.what, 'x');
  });

  it('真跑 CLI 缺 --number → exit 1，stderr 拒发', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hub-ask.mjs'), '--repo', REPO], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /缺单号|拒发/);
  });

  it('--help 退出 0', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hub-ask.mjs'), '--help'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--repo/);
  });
});

describe('指挥官：待拍板走卡片，普通播报仍是纯文字', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'commander.mjs'), 'utf8');

  it('notify-hub 仍调 hubOnce/hubSay，不调 sendHubAsk', () => {
    const start = src.indexOf("case 'notify-hub'");
    const end = src.indexOf("case 'escalate'");
    const block = src.slice(start, end);
    assert.match(block, /hubOnce\(/);
    assert.equal(block.includes('sendHubAsk'), false);
    assert.equal(block.includes('hubAskOnce'), false);
  });

  it('心跳仍走 hubSay 纯文字', () => {
    assert.match(src, /hubSay\('\[指挥官\] 一切正常/);
  });

  it('代拍通知仍走 hubOnce 纯文字（不是待拍板问用户）', () => {
    const i = src.indexOf('function runDaipai');
    const fn = src.slice(i, src.indexOf('function escalate('));
    assert.match(fn, /hubOnce\(/);
    assert.equal(fn.includes('hubAskOnce'), false);
  });

  it('escalate 开出单号后才 hubAskOnce', () => {
    const i = src.indexOf('function escalate(action');
    const fn = src.slice(i, src.indexOf('function reconcileEscalations'));
    assert.match(fn, /askEscalateCard/);
    assert.match(fn, /opened\.ok && opened\.number/);
    // 已有 OPEN 单不重开，但**照样要发卡**。#1063 把「已有 OPEN」拆成了两条出口
    // （对象已登记 = noop、同因新对象 = append），两条都得发——漏一条，机器主动问用户就哑一半。
    assert.match(fn, /verdict === 'noop'[\s\S]*?askEscalateCard/);
    assert.match(fn, /verdict === 'append'[\s\S]*?askEscalateCard/);
    // 账本没键、gh 却搜到已有单那条路同样要发卡。
    assert.match(fn, /if \(existing\)[\s\S]*?askEscalateCard/);
    assert.equal(/hubOnce\(\{[\s\S]*esc:/.test(fn), false);
  });

  it('首次发卡失败、下一轮同 OPEN 单重试，不重开', async () => {
    const { escalate, escalateDedupKey } = await import(toUrl(path.join(ROOT, 'scripts', 'commander.mjs')));
    const action = { kind: 'escalate', reason: 'missing-labels', why: '缺审官标', issue: 901 };
    const key = escalateDedupKey(action); // #1063：键按原因，不再带对象号
    const state = { escalateLedger: {}, hubSeen: {} };
    const sends = [];
    const opens = [];
    let sendOk = false;
    const gh = (args) => {
      if (args[0] === 'issue' && args[1] === 'view') return { ok: true, out: 'OPEN\n' };
      if (args[0] === 'search') return { ok: true, out: '[]' };
      return { ok: false, error: `unexpected gh ${args.join(' ')}` };
    };
    const send = (fields) => {
      sends.push(fields);
      return sendOk ? { ok: true, messageId: 'om_retry' } : { ok: false, error: '没送进群：飞书 500' };
    };
    const openIssue = (x) => {
      opens.push(x);
      return { ok: true, number: 42 };
    };
    const say = () => {};

    const first = escalate(action, { state, dryRun: false, say, gh, send, openIssue });
    assert.equal(first.ok, true);
    assert.equal(first.number, 42);
    assert.equal(opens.length, 1);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].number, 42);
    assert.equal(state.escalateLedger[key].issue, 42);
    assert.equal(state.hubSeen[`esc:${key}`], undefined, '失败不许盖去重戳');

    const second = escalate(action, { state, dryRun: false, say, gh, send, openIssue });
    assert.equal(second.ok, true);
    assert.equal(second.issue, 42);
    assert.equal(opens.length, 1, 'OPEN 单不重开');
    assert.equal(sends.length, 2, '失败后下一轮必须重试发卡');
    assert.equal(state.hubSeen[`esc:${key}`], undefined);

    sendOk = true;
    const third = escalate(action, { state, dryRun: false, say, gh, send, openIssue });
    assert.equal(third.ok, true);
    assert.equal(third.issue, 42);
    assert.equal(opens.length, 1);
    assert.equal(sends.length, 3);
    assert.equal(typeof state.hubSeen[`esc:${key}`], 'string', '成功才盖去重戳');

    const fourth = escalate(action, { state, dryRun: false, say, gh, send, openIssue });
    assert.equal(fourth.ok, true);
    assert.equal(opens.length, 1);
    assert.equal(sends.length, 3, '已成功发送后 6h 内不重复卡');
  });

  it('open-issue 开单成功 + 首次发卡失败 → 下一轮不重开、会重试卡；成功后 6h 内不再发', async () => {
    const { decide, WAKE_LIMIT } = await import(toUrl(path.join(ROOT, 'scripts', 'lib', 'commander-core.mjs')));
    const { execOpenIssue } = await import(toUrl(path.join(ROOT, 'scripts', 'commander.mjs')));
    const sit = {
      github: { scanned: true, issues: [], prs: [] },
      orca: { scanned: true, worktrees: [] },
      reviewPending: { scanned: true, items: [] },
      prReviews: { scanned: true, byPr: {} },
      stall: { scanned: true, strikes: { term_q: { strikes: 2 } } },
      wakeCounts: { 'stall:term_q': WAKE_LIMIT },
      commanderPolicy: { maxDispatchPerRound: 20, requireModelInRouting: false },
      routingModels: ['grok-4.6'],
      healthRedModels: [],
      at: '2026-09-05T12:00:00.000Z',
    };

    const first = decide(sit);
    const created = first.actions.filter((a) => a.kind === 'open-issue');
    assert.equal(created.length, 1, JSON.stringify(first.actions));
    assert.equal(created[0].existing, undefined);
    assert.equal(created[0].reason, 'wake-exhausted');
    assert.equal(created[0].term, 'term_q');

    const afterOpen = {
      ...sit,
      openIssueLedger: { 'wake-exhausted+term_q': { at: '2026-09-05T10:00:00.000Z', number: 900 } },
    };
    const second = decide(afterOpen);
    const retry = second.actions.filter((a) => a.kind === 'open-issue');
    assert.equal(retry.length, 1, '开单成功但卡没送到，下一轮必须重试卡');
    assert.equal(retry[0].existing, true);
    assert.equal(retry[0].number, 900);
    assert.equal(second.actions.filter((a) => a.kind === 'escalate' && a.reason === 'wake-exhausted').length, 0);

    const sends = [];
    let sendOk = false;
    const send = (fields) => {
      sends.push(fields);
      return sendOk ? { ok: true, messageId: 'om_open_retry' } : { ok: false, error: '没送进群：飞书 500' };
    };
    const state = { hubSeen: {}, openIssueLedger: afterOpen.openIssueLedger };
    const say = () => {};

    const failed = execOpenIssue(retry[0], { state, dryRun: false, say, send });
    assert.equal(failed.ok, true);
    assert.equal(failed.existing, true);
    assert.equal(failed.number, 900);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].number, 900);
    assert.equal(state.hubSeen['esc:wake-exhausted+term_q'], undefined, '失败不许盖去重戳');
    assert.equal(state.openIssueLedger['wake-exhausted+term_q'].number, 900, '不重开');

    const third = decide({ ...afterOpen, hubSeen: state.hubSeen });
    const retryAgain = third.actions.filter((a) => a.kind === 'open-issue');
    assert.equal(retryAgain.length, 1, '仍无成功戳，继续重试');
    assert.equal(retryAgain[0].existing, true);

    sendOk = true;
    const okSend = execOpenIssue(retryAgain[0], { state, dryRun: false, say, send });
    assert.equal(okSend.ok, true);
    assert.equal(sends.length, 2);
    assert.equal(typeof state.hubSeen['esc:wake-exhausted+term_q'], 'string', '成功才盖去重戳');

    const fourth = decide({
      ...afterOpen,
      hubSeen: state.hubSeen,
      at: '2026-09-05T12:30:00.000Z',
    });
    assert.equal(fourth.actions.filter((a) => a.kind === 'open-issue').length, 0, '成功后 6h 内不再发');
    assert.equal(sends.length, 2);
  });

  it('sendHubAsk 认回执不认退出码', () => {
    const fn = src.slice(src.indexOf('function sendHubAsk'), src.indexOf('function hubAskOnce'));
    assert.match(fn, /messageId/);
    assert.match(fn, /没送进群/);
    assert.match(fn, /messageId === 'null'/);
  });
});

describe('盘点：红项合并消息仍是纯文字；开单后才发卡', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'commander-inventory.mjs'), 'utf8');

  it('合并盘点播报走 hubOnce', () => {
    assert.match(src, /hubOnce\(\{ state, key: `inv:/);
  });

  it('到时机提醒走 hubOnce，不发卡', () => {
    assert.match(src, /hubOnce\(\{ state, key: surfacingDedupKey/);
  });

  it('开出单号才 fieldsFromInventory + hubAskOnce', () => {
    assert.match(src, /fieldsFromInventory/);
    assert.match(src, /hubAskOnce\(\{ state, key: `invcard:/);
    assert.match(src, /opened\.ok && opened\.number\) askInv/);
  });
});

describe('熔断：有单号才 hubAsk，否则退回 hubSay', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'provider-breaker.mjs'), 'utf8');

  it('escalateAllOpen 先开单再决定发卡还是纯文字', () => {
    const i = src.indexOf('export function escalateAllOpen');
    const fn = src.slice(i, src.indexOf('export function stallTargetOf'));
    assert.match(fn, /typeof hubAsk === 'function'/);
    assert.match(fn, /hubSay\(text\)/);
    assert.match(fn, /issue\.ok && issue\.number/);
  });

  it('夹具不传 hubAsk 时行为不变：仍走 hubSay', async () => {
    const { applyEvent, escalateAllOpen } = await import(toUrl(path.join(ROOT, 'scripts', 'lib', 'provider-breaker.mjs')));
    const T0 = Date.parse('2026-09-04T00:00:00Z');
    const POL = { windowHours: 24, failuresToTrip: 1, cooldownHours: 24, halfOpenProbes: 1 };
    let s = { targets: {} };
    s = applyEvent(s, { type: 'trip', target: 'a', hours: 24 }, POL, T0);
    s = applyEvent(s, { type: 'trip', target: 'b', hours: 24 }, POL, T0);
    const hubs = [];
    const asks = [];
    const esc = escalateAllOpen({
      doc: s, now: T0,
      hubSay: (t) => { hubs.push(t); return { ok: true }; },
      openIssue: () => ({ ok: true, number: 88 }),
    });
    assert.equal(esc.sent, true);
    assert.equal(hubs.length, 1, '没注入 hubAsk 必须仍走纯文字，测试夹具不破');
    assert.equal(asks.length, 0);
    assert.equal(esc.issue.number, 88);
  });

  it('注入 hubAsk 且开出单号 → 发卡，不走 hubSay', async () => {
    const { applyEvent, escalateAllOpen } = await import(toUrl(path.join(ROOT, 'scripts', 'lib', 'provider-breaker.mjs')));
    const T0 = Date.parse('2026-09-04T00:00:00Z');
    const POL = { windowHours: 24, failuresToTrip: 1, cooldownHours: 24, halfOpenProbes: 1 };
    let s = { targets: {} };
    s = applyEvent(s, { type: 'trip', target: 'a', hours: 24 }, POL, T0);
    s = applyEvent(s, { type: 'trip', target: 'b', hours: 24 }, POL, T0);
    const hubs = [];
    const asks = [];
    const esc = escalateAllOpen({
      doc: s, now: T0,
      hubSay: (t) => { hubs.push(t); return { ok: true }; },
      openIssue: () => ({ ok: true, number: 88 }),
      hubAsk: (x) => { asks.push(x); return { ok: true, messageId: 'om_b' }; },
    });
    assert.equal(esc.sent, true);
    assert.equal(asks.length, 1);
    assert.equal(asks[0].number, 88);
    assert.equal(hubs.length, 0, '有单号必须发卡，不许再发纯文字待拍板');
  });

  it('开单失败 → 退回纯文字，总控群不能哑', async () => {
    const { applyEvent, escalateAllOpen } = await import(toUrl(path.join(ROOT, 'scripts', 'lib', 'provider-breaker.mjs')));
    const T0 = Date.parse('2026-09-04T00:00:00Z');
    const POL = { windowHours: 24, failuresToTrip: 1, cooldownHours: 24, halfOpenProbes: 1 };
    let s = { targets: {} };
    s = applyEvent(s, { type: 'trip', target: 'a', hours: 24 }, POL, T0);
    s = applyEvent(s, { type: 'trip', target: 'b', hours: 24 }, POL, T0);
    const hubs = [];
    const asks = [];
    const esc = escalateAllOpen({
      doc: s, now: T0,
      hubSay: (t) => { hubs.push(t); return { ok: true }; },
      openIssue: () => ({ ok: false, error: 'gh down' }),
      hubAsk: (x) => { asks.push(x); return { ok: true }; },
    });
    assert.equal(esc.sent, true);
    assert.equal(asks.length, 0);
    assert.equal(hubs.length, 1);
  });

  it('开单成功 + 发卡失败 → 回退 hubSay，总控群不能哑', async () => {
    const { applyEvent, escalateAllOpen, settleAllOpen } = await import(toUrl(path.join(ROOT, 'scripts', 'lib', 'provider-breaker.mjs')));
    const T0 = Date.parse('2026-09-04T00:00:00Z');
    const POL = { windowHours: 24, failuresToTrip: 1, cooldownHours: 24, halfOpenProbes: 1 };
    let s = { targets: {} };
    s = applyEvent(s, { type: 'trip', target: 'a', hours: 24 }, POL, T0);
    s = applyEvent(s, { type: 'trip', target: 'b', hours: 24 }, POL, T0);
    const hubs = [];
    const asks = [];
    const esc = escalateAllOpen({
      doc: s, now: T0,
      hubSay: (t) => { hubs.push(t); return { ok: true }; },
      openIssue: () => ({ ok: true, number: 88 }),
      hubAsk: (x) => { asks.push(x); return { ok: false, error: '没送进群：飞书 500' }; },
    });
    assert.equal(asks.length, 1);
    assert.equal(asks[0].number, 88);
    assert.equal(hubs.length, 1, '发卡失败必须回退纯文字');
    assert.equal(esc.sent, true, '纯文字送达也算 sent');
    assert.equal(esc.issue.number, 88);
    assert.equal(esc.ask.ok, false);
    assert.match(esc.ask.error, /没送进群/);
    assert.equal(esc.hub.ok, true);

    const settled = settleAllOpen(s, {
      now: T0,
      hubSay: (t) => { hubs.push(t); return { ok: true }; },
      openIssue: () => ({ ok: true, number: 88 }),
      hubAsk: (x) => { asks.push(x); return { ok: false, error: '没送进群：飞书 500' }; },
    });
    assert.equal(settled.escalate.sent, true);
    assert.equal(typeof settled.doc.allOpenAlertedAt, 'string', '纯文字送达才盖去重戳');
  });

  it('开单成功 + 发卡失败 + 纯文字也失败 → 不盖戳，下次再试', async () => {
    const { applyEvent, settleAllOpen } = await import(toUrl(path.join(ROOT, 'scripts', 'lib', 'provider-breaker.mjs')));
    const T0 = Date.parse('2026-09-04T00:00:00Z');
    const POL = { windowHours: 24, failuresToTrip: 1, cooldownHours: 24, halfOpenProbes: 1 };
    let s = { targets: {} };
    s = applyEvent(s, { type: 'trip', target: 'a', hours: 24 }, POL, T0);
    s = applyEvent(s, { type: 'trip', target: 'b', hours: 24 }, POL, T0);
    const settled = settleAllOpen(s, {
      now: T0,
      hubSay: () => ({ ok: false, error: 'hub-say exit 1' }),
      openIssue: () => ({ ok: true, number: 88 }),
      hubAsk: () => ({ ok: false, error: '没送进群：飞书 500' }),
    });
    assert.equal(settled.escalate.sent, false);
    assert.equal(settled.escalate.ask.ok, false);
    assert.equal(settled.doc.allOpenAlertedAt, undefined, '没送达不盖戳');
  });
});

describe('出站卡进 hubPending 后，回传链路仍幂等', () => {
  it('runHubAsk 记下的 pending，第二次点击不写评论', async () => {
    const { runHubAsk } = await LIB;
    const M = await import(toUrl(path.join(ROOT, 'scripts', 'feishu-triage.mjs')));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub1012-'));
    const store = M.createStateStore(path.join(dir, 'threads.json'));
    const sent = runHubAsk({
      repo: REPO, number: 1012, title: '主动问', what: '机器问用户',
    }, {
      store,
      send: () => ({ ok: true, messageId: 'om_out_1' }),
    });
    assert.equal(sent.ok, true);
    assert.equal(store.hubPending.om_out_1.number, 1012);

    const comments = [];
    const event = {
      event_type: 'card.action.trigger',
      event: {
        context: { open_message_id: 'om_out_1' },
        operator: { open_id: 'ou_boss', user_name: '老板' },
        action: { value: { issue: '1012', choice: 'recommend', repo: REPO } },
      },
    };
    const first = await M.handleEvent(event, {
      groups: {}, store, deps: { now: () => Date.now(), ghComment: async (...a) => comments.push(a) },
      triage: async () => ({}), client: null,
    });
    assert.equal(first.cardKind, 'ok');
    assert.equal(comments.length, 1);

    const second = await M.handleEvent(event, {
      groups: {}, store, deps: { now: () => Date.now(), ghComment: async (...a) => comments.push(a) },
      triage: async () => ({}), client: null,
    });
    assert.equal(second.cardKind, 'duplicate');
    assert.equal(comments.length, 1, '再点一次不许再写评论');
  });
});
