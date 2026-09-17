// #1342 真实 turn 结果 → 每条腿的成败账 → 熔断器。
//
// 病（2026-09-17 实咬）：熔断器只吃探针和撞死指纹。pqapi 探针 green、熔断 closed 的同一小时，
// relay 上的生产 turn 2 ok / 6 error；7 天 645 条 turn 里 48% 上游失败，而没有任何一把闸动过。
// 两条判据必须两头都有判别力：坏腿要判得出，好腿不许被自杀（我们自己 stop 的）冤枉。
// 纯函数夹具，不碰 ~/.mirasim、不出网。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const TO = import('file://' + path.join(REPO, 'scripts', 'lib', 'turn-outcomes.mjs').replace(/\\/g, '/'));
const BR = import('file://' + path.join(REPO, 'scripts', 'lib', 'provider-breaker.mjs').replace(/\\/g, '/'));
const PP = import('file://' + path.join(REPO, 'scripts', 'lib', 'provider-probe.mjs').replace(/\\/g, '/'));

const T0 = Date.parse('2026-09-17T09:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;
const ev = (name, ts, props, boot = 'b1') => ({ id: `e${++seq}`, name, ts: iso(ts), bootId: boot, props });
const submit = (ts, agent, model, boot) => ev('turn.submit', ts, { agent, model }, boot);
const finish = (ts, ok, errorCode, boot) => ev('turn.finish', ts, ok ? { ok: true, errorCode: null } : { ok: false, errorCode }, boot);

describe('classifyTurnOutcome：四分，不是两分', () => {
  it('ok / 自杀（interrupted、aborted）/ 断流（incomplete、timeout，#1386）/ 上游', async () => {
    const { classifyTurnOutcome } = await TO;
    assert.equal(classifyTurnOutcome({ ok: true }), 'ok');
    assert.equal(classifyTurnOutcome({ ok: false, errorCode: 'interrupted' }), 'self');
    assert.equal(classifyTurnOutcome({ ok: false, errorCode: 'aborted' }), 'self');
    assert.equal(classifyTurnOutcome({ ok: false, errorCode: 'incomplete' }), 'stream', '长流被掐不是腿坏');
    assert.equal(classifyTurnOutcome({ ok: false, errorCode: 'timeout' }), 'stream');
    for (const code of ['other', 'rate_limit', null, undefined, '']) {
      assert.equal(classifyTurnOutcome({ ok: false, errorCode: code }), 'upstream', `errorCode=${code} 是上游失败`);
    }
  });

  it('props 是 JSON 字串（diag 文件的写法）也认', async () => {
    const { propsOf, pairTurnEvents } = await TO;
    assert.deepEqual(propsOf({ props: '{"ok":false,"errorCode":"incomplete"}' }), { ok: false, errorCode: 'incomplete' });
    assert.deepEqual(propsOf({ props: '{half' }), {});
    assert.deepEqual(propsOf({}), {});
    const turns = pairTurnEvents([{ id: 'x', name: 'turn.finish', ts: iso(T0), bootId: 'b', agent: 'grok', model: 'grok-4.6', props: '{"ok":false,"errorCode":"incomplete","durationMs":2036823}' }]);
    assert.deepEqual(turns.map((t) => [t.agent, t.kind, t.durationMs]), [['grok', 'stream', 2036823]], '字串 props 不许折成「upstream」');
  });
});

describe('pairTurnEvents：submit→finish 按 bootId FIFO 配对', () => {
  it('配得上的带 agent/model，配不上的记 ?，同 id 重复只算一次', async () => {
    const { pairTurnEvents } = await TO;
    const events = [
      submit(T0, 'codex', 'gpt-5.6-luna'),
      submit(T0 + 1000, 'grok', 'grok-4.6'),
      finish(T0 + 5000, true),                 // → codex
      finish(T0 + 6000, false, 'other'),       // → grok
      finish(T0 + 7000, false, 'incomplete'),  // 没有 submit 了 → ?
    ];
    const dup = { ...events[2] };
    const turns = pairTurnEvents([...events, dup]);
    assert.equal(turns.length, 3, '重复 id 不重复计');
    assert.deepEqual(turns.map((t) => [t.agent, t.model, t.kind]), [
      ['codex', 'gpt-5.6-luna', 'ok'],
      ['grok', 'grok-4.6', 'upstream'],
      ['?', '?', 'stream'],
    ]);
  });

  it('finish 自带 agent/model 时以它为准，FIFO 不许张冠李戴（#1386 第二个洞）', async () => {
    const { pairTurnEvents } = await TO;
    // 两路并发：codex 先 submit、grok 后 submit；grok 先 finish。纯 FIFO 会把 grok 的结果记到 codex 头上。
    const turns = pairTurnEvents([
      submit(T0, 'codex', 'gpt-5.6-luna'),
      submit(T0 + 1, 'grok', 'grok-4.6'),
      { id: 'f1', name: 'turn.finish', ts: iso(T0 + 10), bootId: 'b1', agent: 'grok', model: 'grok-4.6', props: { ok: false, errorCode: 'interrupted' } },
      { id: 'f2', name: 'turn.finish', ts: iso(T0 + 20), bootId: 'b1', agent: 'codex', model: 'gpt-5.6-luna', props: { ok: true } },
    ]);
    assert.deepEqual(turns.map((t) => [t.agent, t.kind]), [['grok', 'self'], ['codex', 'ok']]);
  });

  it('不同 bootId 各排各的队', async () => {
    const { pairTurnEvents } = await TO;
    const turns = pairTurnEvents([
      submit(T0, 'codex', 'gpt-5.6-sol', 'A'),
      submit(T0 + 1, 'pi', 'kimi-k3', 'B'),
      finish(T0 + 10, false, 'other', 'B'),
      finish(T0 + 11, true, null, 'A'),
    ]);
    assert.deepEqual(turns.map((t) => [t.agent, t.kind]), [['pi', 'upstream'], ['codex', 'ok']]);
  });
});

describe('turnTargetOf：key 与健康表同一套', () => {
  it('codex 一律归 relay:codex（luna/sol 共用传输腿）；其余按选型落地', async () => {
    const { turnTargetOf, RELAY_CODEX_TARGET } = await TO;
    const { probeTargetForModel } = await import('file://' + path.join(REPO, 'scripts', 'lib', 'provider-health.mjs').replace(/\\/g, '/'));
    const { RELAY_CODEX_TARGET: FROM_PROBE } = await PP;
    assert.equal(RELAY_CODEX_TARGET, FROM_PROBE, '两个模块的常量必须同值（不 import 是为了防环）');
    const models = [
      { id: 'grok-4.6', provider: 'gw', cli_model: 'gw/grok-4.6' },
      { id: 'kimi-k3', provider: 'gw', cli_model: 'gw-sub/kimi-k3-high' },
    ];
    assert.equal(turnTargetOf({ agent: 'codex', model: 'gpt-5.6-luna' }, { models, probeTargetForModel }), 'relay:codex');
    assert.equal(turnTargetOf({ agent: 'codex', model: 'gpt-5.6-sol' }, { models, probeTargetForModel }), 'relay:codex');
    assert.equal(turnTargetOf({ agent: 'grok', model: 'grok-4.6' }, { models, probeTargetForModel }), 'gw:grok/grok-4.6');
    assert.equal(turnTargetOf({ agent: 'pi', model: 'nowhere' }, { models, probeTargetForModel }), null, '选型表里没有 = 不猜');
    assert.equal(turnTargetOf({ agent: '?', model: '?' }, { models, probeTargetForModel }), null);
    assert.equal(turnTargetOf({ agent: 'grok', model: 'grok-4.6' }, {}), null, '没给映射函数 = 没依据');
  });
});

describe('summarizeTurnOutcomes：自杀不进分母', () => {
  it('total 只算 ok+upstream；lastTs 取窗口内最后一条；窗口外丢掉', async () => {
    const { summarizeTurnOutcomes, failRatePct } = await TO;
    const turns = [
      { ts: iso(T0 - 3600e3), agent: 'codex', model: 'x', kind: 'upstream' }, // 窗口外
      { ts: iso(T0), agent: 'codex', model: 'x', kind: 'ok' },
      { ts: iso(T0 + 1), agent: 'codex', model: 'x', kind: 'upstream' },
      { ts: iso(T0 + 2), agent: 'codex', model: 'x', kind: 'self' },
      { ts: iso(T0 + 3), agent: 'codex', model: 'x', kind: 'self' },
    ];
    const s = summarizeTurnOutcomes(turns, { sinceMs: T0, targetOf: () => 'relay:codex' });
    assert.deepEqual(s['relay:codex'], { ok: 1, upstream: 1, self: 2, stream: 0, total: 2, lastTs: iso(T0 + 3) });
    assert.equal(failRatePct(s['relay:codex']), 50, '2 条自杀不许把 50% 算成 75%');
    assert.equal(failRatePct({ total: 0, upstream: 0 }), null, '没样本 ≠ 0%');
    assert.deepEqual(summarizeTurnOutcomes(turns, { sinceMs: T0, targetOf: () => null }), {}, '认不出 key 的一律跳过');
  });
});

describe('ingestTurnOutcomes：真实失败率开闸，样本不足不动，幂等', () => {
  const POL = { windowHours: 24, failuresToTrip: 3, cooldownHours: 24, halfOpenProbes: 1 };
  const KEY = 'relay:codex';
  const row = (ok, upstream, lastTs, self = 0) => ({ [KEY]: { ok, upstream, self, total: ok + upstream, lastTs } });

  it('连续三轮 ≥60% 失败 → open；每轮只记一次（同 lastTs 重喂不加）', async () => {
    const { ingestTurnOutcomes } = await BR;
    let doc = { targets: {} };
    doc = ingestTurnOutcomes(row(2, 6, iso(T0)), doc, POL, T0);
    assert.equal(doc.targets[KEY].state, 'closed');
    assert.equal(doc.targets[KEY].failures.length, 1);
    doc = ingestTurnOutcomes(row(2, 6, iso(T0)), doc, POL, T0 + 60e3);
    assert.equal(doc.targets[KEY].failures.length, 1, '同一批数据重喂不重复记（lastTurnAt 幂等戳）');
    doc = ingestTurnOutcomes(row(3, 7, iso(T0 + 20 * 60e3)), doc, POL, T0 + 20 * 60e3);
    doc = ingestTurnOutcomes(row(3, 9, iso(T0 + 40 * 60e3)), doc, POL, T0 + 40 * 60e3);
    assert.equal(doc.targets[KEY].state, 'open', '三轮都坏才 open——一小时的坏不是抖动');
    assert.match(doc.targets[KEY].why, /真实 turn 上游失败率 75%/);
  });

  it('样本不足（total < 8）不动，哪怕 100% 失败', async () => {
    const { ingestTurnOutcomes } = await BR;
    const doc = ingestTurnOutcomes(row(0, 7, iso(T0)), { targets: {} }, POL, T0);
    assert.deepEqual(doc.targets, {}, '7/7 失败也不评——没样本 ≠ 坏了');
  });

  it('自杀不算：8 条自杀 + 2 ok + 1 上游 ⇒ total=3 不够门槛', async () => {
    const { ingestTurnOutcomes } = await BR;
    const doc = ingestTurnOutcomes({ [KEY]: { ok: 2, upstream: 1, self: 8, total: 3, lastTs: iso(T0) } }, { targets: {} }, POL, T0);
    assert.deepEqual(doc.targets, {});
  });

  it('好腿（30%）：closed 不吃绿、只盖幂等戳；half-open 吃绿合闸', async () => {
    const { ingestTurnOutcomes, applyEvent } = await BR;
    let doc = ingestTurnOutcomes(row(7, 3, iso(T0)), { targets: {} }, POL, T0);
    assert.equal(doc.targets[KEY].state, 'closed');
    assert.equal(doc.targets[KEY].failures.length, 0);
    assert.equal(doc.targets[KEY].lastTurnAt, iso(T0));
    // 手动熔断 → 过冷却 → half-open → 一批好数据合闸
    doc = applyEvent(doc, { type: 'trip', target: KEY, hours: 1 }, POL, T0);
    const later = T0 + 2 * 3600e3;
    doc = ingestTurnOutcomes(row(9, 1, iso(later)), doc, POL, later);
    assert.equal(doc.targets[KEY].state, 'closed', 'half-open 见到好数据要合闸，否则坏腿修好了永远回不来');
  });

  it('策略 overrides 按 target 覆盖门槛', async () => {
    const { ingestTurnOutcomes, resolveTurnPolicy } = await BR;
    const pol = { ...POL, overrides: { [KEY]: { turnMinRequests: 3, turnFailRatePct: 50, turnWindowHours: 1 } } };
    assert.deepEqual(resolveTurnPolicy(pol, KEY), { turnMinRequests: 3, turnFailRatePct: 50, turnWindowHours: 6 },
      '窗口是全局的：数据只读一次，不按 target 各读一份');
    assert.deepEqual(resolveTurnPolicy(pol, 'other'), { turnMinRequests: 8, turnFailRatePct: 60, turnWindowHours: 6 });
    assert.equal(resolveTurnPolicy({ ...POL, turnWindowHours: 3 }).turnWindowHours, 3);
    const doc = ingestTurnOutcomes(row(1, 2, iso(T0)), { targets: {} }, pol, T0);
    assert.equal(doc.targets[KEY].failures.length, 1, '3 条样本、67% 失败，按覆盖门槛要记');
  });
});

describe('判别性实验：#1386 grok 那 46 条的真实形状——断流不许判死腿', () => {
  it('4 ok / 20 incomplete / 22 interrupted ⇒ total=4，样本不足不评；腿保持 closed', async () => {
    const { pairTurnEvents, summarizeTurnOutcomes, failRatePct } = await TO;
    const { ingestTurnOutcomes } = await BR;
    const events = [];
    let t = T0;
    const fin = (ok, code) => events.push({ id: `g${events.length}`, name: 'turn.finish', ts: iso(t += 60e3), bootId: 'b', agent: 'grok', model: 'grok-4.6', props: JSON.stringify(ok ? { ok: true } : { ok: false, errorCode: code }) });
    for (let i = 0; i < 4; i++) fin(true);
    for (let i = 0; i < 20; i++) fin(false, 'incomplete');
    for (let i = 0; i < 22; i++) fin(false, 'interrupted');
    const s = summarizeTurnOutcomes(pairTurnEvents(events), { sinceMs: T0, targetOf: () => 'native:xai-native' });
    assert.deepEqual({ ...s['native:xai-native'], lastTs: null }, { ok: 4, upstream: 0, self: 22, stream: 20, total: 4, lastTs: null });
    assert.equal(failRatePct(s['native:xai-native']), 0);
    const POL = { windowHours: 24, failuresToTrip: 3, cooldownHours: 1, halfOpenProbes: 1 };
    const doc = ingestTurnOutcomes(s, { targets: {} }, POL, t);
    assert.deepEqual(doc.targets, {}, '2026-09-17 那把闸不该开');
  });

  it('真上游失败（other/rate_limit）照样判：8 ok / 12 other 连三轮 ⇒ open，why 里点名断流不计', async () => {
    const { ingestTurnOutcomes } = await BR;
    const POL = { windowHours: 24, failuresToTrip: 3, cooldownHours: 1, halfOpenProbes: 1 };
    let doc = { targets: {} };
    for (let i = 0; i < 3; i++) {
      const t = T0 + i * 20 * 60e3;
      doc = ingestTurnOutcomes({ 'native:xai-native': { ok: 8, upstream: 12 + i, self: 0, stream: 30, total: 20 + i, lastTs: iso(t) } }, doc, POL, t);
    }
    assert.equal(doc.targets['native:xai-native'].state, 'open', '断流不计不等于上游失败也不计');
    assert.match(doc.targets['native:xai-native'].why, /30 条是断流/);
  });
});

describe('判别性实验：2026-09-17 那一小时的真实形状', () => {
  it('同一份账：relay 2 ok/6 err 三轮后 open；桥 4/4 与 grok 探针 closed', async () => {
    const { ingestTurnOutcomes } = await BR;
    const POL = { windowHours: 24, failuresToTrip: 3, cooldownHours: 24, halfOpenProbes: 1 };
    let doc = { targets: {} };
    for (let i = 0; i < 3; i++) {
      const t = T0 + i * 20 * 60e3;
      doc = ingestTurnOutcomes({
        'relay:codex': { ok: 2 + i, upstream: 6 + 2 * i, self: 1, total: 8 + 3 * i, lastTs: iso(t) },
        'gw:gptpool/gpt-5.6': { ok: 8 + i, upstream: 0, self: 0, total: 8 + i, lastTs: iso(t) },
      }, doc, POL, t);
    }
    assert.equal(doc.targets['relay:codex'].state, 'open');
    assert.equal(doc.targets['gw:gptpool/gpt-5.6'].state, 'closed');
    assert.equal(doc.targets['gw:gptpool/gpt-5.6'].failures.length, 0);
  });
});

describe('readTurnEvents：只读窗口内文件，目录不在 = 没查成', () => {
  it('mtime 早于窗口的文件不读；半截行跳过；两个目录都没有 ⇒ unscanned', async () => {
    const { readTurnEvents } = await TO;
    const files = {
      '/h/.mirasim/analytics/events-old.ndjson': { mtime: T0 - 48 * 3600e3, text: JSON.stringify(ev('turn.finish', T0 - 48 * 3600e3, { ok: true })) },
      '/h/.mirasim/analytics/events-new.ndjson': { mtime: T0, text: JSON.stringify(submit(T0, 'codex', 'x')) + '\n' + JSON.stringify(finish(T0 + 1, true)) + '\n{"half":' },
      '/h/.mirasim/diag/ev-now.ndjson': { mtime: T0, text: JSON.stringify(finish(T0 + 2, false, 'other')) },
    };
    const fsx = {
      readdir: (d) => Object.keys(files).filter((p) => p.startsWith(d + '/')).map((p) => p.slice(d.length + 1)),
      readFile: (p) => files[p].text,
      stat: (p) => ({ mtimeMs: files[p].mtime }),
    };
    const r = readTurnEvents({ home: '/h', sinceMs: T0 - 3600e3, ...fsx });
    assert.equal(r.ok, true);
    assert.deepEqual(r.files, ['/h/.mirasim/analytics/events-new.ndjson', '/h/.mirasim/diag/ev-now.ndjson']);
    assert.equal(r.events.length, 3, '半截行不算事件');
    const none = readTurnEvents({ home: '/h', sinceMs: 0, readdir: () => { throw new Error('ENOENT'); }, readFile: () => '', stat: () => ({ mtimeMs: 0 }) });
    assert.equal(none.unscanned, true);
    assert.equal(readTurnEvents({}).unscanned, true, '缺注入 = 没查成，不是空');
  });
});
