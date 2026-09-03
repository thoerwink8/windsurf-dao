// 编排层熔断（#843）：纯函数夹具 + CLI 动词 + 策略越界
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'provider-breaker.mjs').replace(/\\/g, '/');
const PREFLIGHT = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'preflight.mjs').replace(/\\/g, '/');
const POLICY_CHECK = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'dispatch-policy-check.mjs').replace(/\\/g, '/');
const REVIEWER = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'dispatch', 'reviewer.mjs').replace(/\\/g, '/');
const HEALTH = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'provider-health.mjs').replace(/\\/g, '/');
const CLI = path.resolve(__dirname, '..', 'scripts', 'dao.mjs');
const CMD = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'dao-cmd.mjs').replace(/\\/g, '/');

const KEY = 'direct:codex@pqapi/responses';
const POL = { windowHours: 24, failuresToTrip: 3, cooldownHours: 24, halfOpenProbes: 1 };
const T0 = Date.parse('2026-09-03T12:00:00Z');
const HOUR = 3600 * 1000;

function empty() { return { updatedAt: null, targets: {} }; }

function failN(applyEvent, n, start = T0) {
  let s = empty();
  for (let i = 0; i < n; i++) {
    s = applyEvent(s, { type: 'failure', target: KEY, code: 502, why: `${i + 1} 次 502 within 24h (pqapi/responses)` }, POL, start + i * 1000);
  }
  return s;
}

describe('applyEvent / isAvailable 状态机', () => {
  it('24h 内 3 红 → open，cooldownUntil = now + 24h', async () => {
    const { applyEvent, isAvailable } = await import(LIB);
    const s = failN(applyEvent, 3);
    const t = s.targets[KEY];
    assert.equal(t.state, 'open');
    assert.equal(t.failures.length, 3);
    assert.equal(t.cooldownUntil, new Date(T0 + 2 * 1000 + 24 * HOUR).toISOString());
    assert.equal(isAvailable(t, T0 + 2 * 1000, POL), false);
  });

  it('窗口外的失败不算（25h 前的红被丢掉）', async () => {
    const { applyEvent } = await import(LIB);
    let s = empty();
    s = applyEvent(s, { type: 'failure', target: KEY }, POL, T0);
    s = applyEvent(s, { type: 'failure', target: KEY }, POL, T0 + 1000);
    s = applyEvent(s, { type: 'failure', target: KEY }, POL, T0 + 25 * HOUR);
    assert.equal(s.targets[KEY].state, 'closed');
    assert.equal(s.targets[KEY].failures.length, 1);
  });

  it('第 4 次探在 cooldown 内被拦：isAvailable=false，failure 不刷新倒计时', async () => {
    const { applyEvent, isAvailable } = await import(LIB);
    const open = failN(applyEvent, 3);
    const until = open.targets[KEY].cooldownUntil;
    const later = applyEvent(open, { type: 'failure', target: KEY, code: 502 }, POL, T0 + 3 * 1000);
    assert.equal(later.targets[KEY].state, 'open');
    assert.equal(later.targets[KEY].cooldownUntil, until);
    assert.equal(isAvailable(later.targets[KEY], T0 + 3 * 1000, POL), false);
  });

  it('到点 half-open 只放一针；第二针被拦', async () => {
    const { applyEvent, isAvailable, inspectAvailability } = await import(LIB);
    let s = failN(applyEvent, 3);
    const openAt = T0 + 2 * 1000;
    const due = openAt + 24 * HOUR;
    s = applyEvent(s, { type: 'tick' }, POL, due);
    assert.equal(s.targets[KEY].state, 'half-open');
    assert.equal(isAvailable(s.targets[KEY], due, POL), true);
    s = applyEvent(s, { type: 'probe', target: KEY }, POL, due);
    assert.equal(s.targets[KEY].halfOpenUsed, 1);
    const av = inspectAvailability(s.targets[KEY], due, POL);
    assert.equal(av.available, false);
    assert.match(av.why || '', /一针已用/);
  });

  it('closed 时绿不擦窗口失败', async () => {
    const { applyEvent } = await import(LIB);
    let s = empty();
    s = applyEvent(s, { type: 'failure', target: KEY }, POL, T0);
    s = applyEvent(s, { type: 'failure', target: KEY }, POL, T0 + 1000);
    s = applyEvent(s, { type: 'success', target: KEY }, POL, T0 + 2000);
    assert.equal(s.targets[KEY].state, 'closed');
    assert.equal(s.targets[KEY].failures.length, 2);
  });

  it('half-open 绿 → closed 且 failures 清空', async () => {
    const { applyEvent } = await import(LIB);
    let s = failN(applyEvent, 3);
    const due = T0 + 2 * 1000 + 24 * HOUR;
    s = applyEvent(s, { type: 'tick' }, POL, due);
    s = applyEvent(s, { type: 'success', target: KEY }, POL, due);
    assert.equal(s.targets[KEY].state, 'closed');
    assert.deepEqual(s.targets[KEY].failures, []);
  });

  it('half-open 红 → 再 open 一轮', async () => {
    const { applyEvent, isAvailable } = await import(LIB);
    let s = failN(applyEvent, 3);
    const due = T0 + 2 * 1000 + 24 * HOUR;
    s = applyEvent(s, { type: 'tick' }, POL, due);
    s = applyEvent(s, { type: 'failure', target: KEY, why: 'half-open 一针仍红' }, POL, due);
    assert.equal(s.targets[KEY].state, 'open');
    assert.equal(isAvailable(s.targets[KEY], due, POL), false);
    assert.equal(s.targets[KEY].cooldownUntil, new Date(due + 24 * HOUR).toISOString());
  });

  it('overrides 按 target 覆盖 cooldownHours', async () => {
    const { applyEvent, resolveBreakerPolicy } = await import(LIB);
    const pol = { ...POL, overrides: { [KEY]: { cooldownHours: 6 } } };
    assert.equal(resolveBreakerPolicy(pol, KEY).cooldownHours, 6);
    const s = failN(applyEvent, 3);
    // 默认 24h；带 override 再 trip
    let s2 = empty();
    s2 = applyEvent(s2, { type: 'failure', target: KEY }, pol, T0);
    s2 = applyEvent(s2, { type: 'failure', target: KEY }, pol, T0 + 1000);
    s2 = applyEvent(s2, { type: 'failure', target: KEY }, pol, T0 + 2000);
    assert.equal(s2.targets[KEY].cooldownUntil, new Date(T0 + 2000 + 6 * HOUR).toISOString());
    assert.equal(s.targets[KEY].cooldownUntil, new Date(T0 + 2000 + 24 * HOUR).toISOString());
  });

  it('reset 清零；trip 立刻 open', async () => {
    const { applyEvent } = await import(LIB);
    let s = failN(applyEvent, 3);
    s = applyEvent(s, { type: 'reset', target: KEY }, POL, T0 + 5000);
    assert.equal(s.targets[KEY].state, 'closed');
    assert.deepEqual(s.targets[KEY].failures, []);
    s = applyEvent(s, { type: 'trip', target: KEY, hours: 6, why: '手动熔断 6h' }, POL, T0 + 6000);
    assert.equal(s.targets[KEY].state, 'open');
    assert.equal(s.targets[KEY].cooldownUntil, new Date(T0 + 6000 + 6 * HOUR).toISOString());
  });

  it('禁 Date.now：不传 now 抛错', async () => {
    const { applyEvent, isAvailable } = await import(LIB);
    assert.throws(() => applyEvent(empty(), { type: 'tick' }, POL), /必须传入 now/);
    assert.throws(() => isAvailable({ state: 'closed' }), /必须传入 now/);
  });
});

describe('cooldown 内不发请求（runPreflight）', () => {
  it('open 冷却中：probe 一次都不调', async () => {
    const { runPreflight } = await import(PREFLIGHT);
    let probed = 0;
    const breakerDoc = {
      targets: { [KEY]: { state: 'open', cooldownUntil: '2026-09-04T12:00:00Z', failures: ['a', 'b', 'c'] } },
    };
    const r = await runPreflight({
      candidates: [{ id: 'gpt-5.6-sol', provider: 'gpt', cli_model: 'gpt-5.6-sol' }],
      policy: { enabled: true, timeoutMs: 1000, maxCandidates: 4, useHealthTable: false, breaker: POL },
      now: new Date(T0),
      breakerDoc,
      recordBreaker: () => ({ ok: true }),
      probe: async () => { probed += 1; return { state: 'green', code: 200, target: KEY }; },
      audit: () => {},
    });
    assert.equal(probed, 0);
    assert.equal(r.stop, true);
    assert.ok(r.hardBlocked.find(h => h.id === 'gpt-5.6-sol'));
  });
});

describe('审官 gpt-5.6-sol 熔断 → 不起 codex', () => {
  it('direct:codex@pqapi/responses open → gpt-5.6-sol hardBlock，换下一位或停手', async () => {
    const { preflightReviewer } = await import(REVIEWER);
    const { availabilityFor } = await import(HEALTH);
    const MODELS = [
      { id: 'gpt-5.6-sol', provider: 'gpt', cli_model: 'gpt-5.6-sol' },
      { id: 'grok-4.6', provider: 'gw', cli_model: 'gw/grok-4.6' },
    ];
    const breaker = {
      present: true,
      targets: { [KEY]: { state: 'open', cooldownUntil: '2026-09-04T12:00:00Z', why: '3 次 502 within 24h (pqapi/responses)' } },
    };
    const avail = availabilityFor(MODELS, {
      health: { ok: true, present: false, unknown: true, table: null, reason: 'x' },
      breaker, now: T0, breakerPolicy: POL,
    });
    assert.ok(avail.hardBlocked['gpt-5.6-sol'], JSON.stringify(avail.hardBlocked));
    const r = await preflightReviewer({
      order: ['gpt-5.6-sol', 'grok-4.6'], models: MODELS, workerId: null,
      policy: { enabled: true, timeoutMs: 1000, maxCandidates: 4, useHealthTable: false, breaker: POL },
      availabilityResult: avail, now: new Date(T0),
      probe: async (l) => ({ state: 'green', code: 200, ms: 1, why: 'ok', target: l.provider === 'gpt' ? KEY : 'gw:grok/grok-4.6' }),
    });
    assert.notEqual(r.chosen, 'gpt-5.6-sol');
    assert.ok(r.hardBlocked.find(h => h.id === 'gpt-5.6-sol'));
    // 换到 grok 或停手，反正不起 codex
    assert.ok(r.chosen === 'grok-4.6' || r.stop === true);
  });
});

describe('全部 open → 报帅 + 总控群', () => {
  it('夹具：planAllOpenAlert 在全部 open 时报，6h 内不重报', async () => {
    const { applyEvent, planAllOpenAlert, stampAllOpenAlert, escalateAllOpen } = await import(LIB);
    let s = empty();
    s = applyEvent(s, { type: 'trip', target: 'a', hours: 24 }, POL, T0);
    s = applyEvent(s, { type: 'trip', target: 'b', hours: 24 }, POL, T0);
    const plan = planAllOpenAlert(s, T0);
    assert.equal(plan.alert, true);
    assert.match(plan.text, /全部路径 open/);
    const stamped = stampAllOpenAlert(s, T0, true);
    const again = planAllOpenAlert(stamped, T0 + 1000);
    assert.equal(again.alert, false);
    const hubs = [];
    const issues = [];
    const esc = escalateAllOpen({
      doc: s, now: T0,
      hubSay: (t) => { hubs.push(t); return { ok: true }; },
      openIssue: (x) => { issues.push(x); return { ok: true, number: 1 }; },
    });
    assert.equal(esc.sent, true);
    assert.equal(hubs.length, 1);
    assert.equal(issues.length, 1);
    assert.match(issues[0].title, /全部路径 open/);
  });

  // PR #851 审官红项：recordEvent 先盖 6h 戳、runBreakerCommand 再 escalate → 撞自己的去重，首次全 open 一条都没发。
  it('两个 target 先后 trip：首次全 open 必发一次，6h 内第二次不重发，过 6h 再发', async () => {
    const { runBreakerCommand, loadBreakerDoc } = await import(LIB);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-allopen-'));
    const hubs = [];
    const issues = [];
    const inj = {
      hubSay: (t) => { hubs.push(t); return { ok: true }; },
      openIssue: (x) => { issues.push(x); return { ok: true, number: 1 }; },
    };
    const first = runBreakerCommand({ action: 'trip', key: 'a', hours: 24 }, { home, now: T0, policy: POL, ...inj });
    assert.equal(first.escalate.sent, false, '单条 open 不报');
    assert.equal(hubs.length, 0);

    const second = runBreakerCommand({ action: 'trip', key: 'b', hours: 24 }, { home, now: T0 + 1000, policy: POL, ...inj });
    assert.equal(second.escalate.sent, true, '首次全 open 必发');
    assert.equal(hubs.length, 1);
    assert.equal(issues.length, 1);
    assert.equal(loadBreakerDoc({ home }).doc.allOpenAlertedAt, new Date(T0 + 1000).toISOString(), '发成后才盖戳');

    const third = runBreakerCommand({ action: 'trip', key: 'a', hours: 24 }, { home, now: T0 + HOUR, policy: POL, ...inj });
    assert.equal(third.escalate.sent, false);
    assert.match(third.escalate.reason, /6 小时内已报过/);
    assert.equal(hubs.length, 1, '6h 内不重发');

    const fourth = runBreakerCommand({ action: 'trip', key: 'a', hours: 24 }, { home, now: T0 + 7 * HOUR, policy: POL, ...inj });
    assert.equal(fourth.escalate.sent, true, '过 6h 仍全 open 再报一次');
    assert.equal(hubs.length, 2);
  });

  it('hub-say 没发成不盖戳，下次还会再试；dry-run 预演也不盖戳', async () => {
    const { runBreakerCommand, loadBreakerDoc } = await import(LIB);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-allopen-fail-'));
    let hubOk = false;
    const hubs = [];
    const inj = {
      hubSay: (t) => { hubs.push(t); return hubOk ? { ok: true } : { ok: false, error: 'hub-say exit 1' }; },
      openIssue: () => ({ ok: true, number: 1 }),
    };
    runBreakerCommand({ action: 'trip', key: 'a', hours: 24 }, { home, now: T0, policy: POL, ...inj });
    const failed = runBreakerCommand({ action: 'trip', key: 'b', hours: 24 }, { home, now: T0 + 1000, policy: POL, ...inj });
    assert.equal(failed.escalate.sent, false);
    assert.equal(loadBreakerDoc({ home }).doc.allOpenAlertedAt, undefined, '没发成不盖戳');

    const dry = runBreakerCommand({ action: 'trip', key: 'b', hours: 24 }, { home, now: T0 + 2000, policy: POL, ...inj, dryRun: true });
    assert.equal(dry.escalate.dryRun, true);
    assert.equal(loadBreakerDoc({ home }).doc.allOpenAlertedAt, undefined, 'dry-run 不盖戳');

    hubOk = true;
    const retried = runBreakerCommand({ action: 'trip', key: 'b', hours: 24 }, { home, now: T0 + 3000, policy: POL, ...inj });
    assert.equal(retried.escalate.sent, true, '通道恢复后补发');
    assert.equal(hubs.length, 2);
    assert.equal(loadBreakerDoc({ home }).doc.allOpenAlertedAt, new Date(T0 + 3000).toISOString());
  });
});

describe('ingest 三路只记事件', () => {
  it('健康表 red 记 failure；同一 updatedAt 不重复', async () => {
    const { ingestHealthTable } = await import(LIB);
    const health = { updatedAt: '2026-09-03T12:00:00Z', targets: { [KEY]: { state: 'red', code: 502 } } };
    let s = ingestHealthTable(health, empty(), POL, T0);
    assert.equal(s.targets[KEY].failures.length, 1);
    s = ingestHealthTable(health, s, POL, T0 + 1000);
    assert.equal(s.targets[KEY].failures.length, 1);
  });

  it('健康表 green 在 half-open 时合闸', async () => {
    const { applyEvent, ingestHealthTable } = await import(LIB);
    let s = empty();
    s = applyEvent(s, { type: 'trip', target: KEY, hours: 24 }, POL, T0);
    s = applyEvent(s, { type: 'tick' }, POL, T0 + 24 * HOUR);
    assert.equal(s.targets[KEY].state, 'half-open');
    const health = { updatedAt: '2026-09-04T12:00:00Z', targets: { [KEY]: { state: 'green', code: 200 } } };
    s = ingestHealthTable(health, s, POL, T0 + 24 * HOUR);
    assert.equal(s.targets[KEY].state, 'closed');
    assert.deepEqual(s.targets[KEY].failures, []);
  });

  it('撞死指纹认不出 target 就跳过，不许猜', async () => {
    const { ingestStall } = await import(LIB);
    const strikes = { term_x: { strikes: 3, sig: '429' } };
    const s = ingestStall(strikes, empty(), POL, T0, { resolveTarget: () => null });
    assert.deepEqual(s.targets, {});
  });

  it('撞死指纹给得出 key 才记；strikes 不递增不重记', async () => {
    const { ingestStall } = await import(LIB);
    const strikes = { term_x: { strikes: 2, sig: '429', target: KEY } };
    let s = ingestStall(strikes, empty(), POL, T0, { resolveTarget: (_t, info) => info.target });
    assert.equal(s.targets[KEY].failures.length, 1);
    s = ingestStall(strikes, s, POL, T0 + 1000, { resolveTarget: (_t, info) => info.target });
    assert.equal(s.targets[KEY].failures.length, 1);
  });
});

describe('策略校验：failuresToTrip: 0 必须红', () => {
  it('inspectDispatchPolicySource 拦 failuresToTrip: 0', async () => {
    const { inspectDispatchPolicySource } = await import(POLICY_CHECK);
    const src = JSON.stringify({
      preflight: { enabled: true, timeoutMs: 5000, maxCandidates: 4, useHealthTable: true },
      breaker: { windowHours: 24, failuresToTrip: 0, cooldownHours: 24, halfOpenProbes: 1 },
    });
    const r = inspectDispatchPolicySource(src);
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, false);
    assert.ok(r.problems.some(p => /failuresToTrip/.test(p)), JSON.stringify(r.problems));
  });

  it('红夹具含 failuresToTrip:0', () => {
    const red = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dispatch-policy-check', 'red', 'dispatch-policy.json'), 'utf8'));
    assert.equal(red.breaker.failuresToTrip, 0);
  });
});

describe('CLI breaker 动词', () => {
  it('已登记进 VERBS / FLAGS / USAGE', async () => {
    const S = await import(CMD);
    assert.ok(S.VERBS.includes('breaker'));
    assert.equal(S.verbFlagGaps().length, 0);
    assert.match(S.USAGE, /breaker reset/);
    assert.match(S.USAGE, /breaker trip/);
    const parsed = S.parseArgs(['node', 'dao.mjs', 'breaker', 'reset', KEY]);
    assert.equal(parsed.verb, 'breaker');
    assert.equal(parsed.action, 'reset');
    assert.equal(parsed.key, KEY);
    const trip = S.parseArgs(['node', 'dao.mjs', 'breaker', 'trip', KEY, '--hours', '6']);
    assert.equal(trip.action, 'trip');
    assert.equal(trip.key, KEY);
    assert.equal(trip.hours, '6');
  });

  it('reset / trip 写临时家目录；trip 缺 --hours 非零', async () => {
    const { runBreakerCommand, loadBreakerDoc } = await import(LIB);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-'));
    fs.mkdirSync(path.join(home, '.dao'), { recursive: true });
    const trip = runBreakerCommand(
      { action: 'trip', key: KEY, hours: 6 },
      { home, now: T0, policy: POL, dryRun: true, hubSay: () => ({ ok: true }), openIssue: () => ({ ok: true }) },
    );
    assert.equal(trip.ok, true);
    const loaded = loadBreakerDoc({ home });
    assert.equal(loaded.doc.targets[KEY].state, 'open');
    const reset = runBreakerCommand({ action: 'reset', key: KEY }, { home, now: T0 + 1000, policy: POL });
    assert.equal(reset.target.state, 'closed');
    const miss = spawnSync(process.execPath, [CLI, 'breaker', 'trip', KEY], { encoding: 'utf8', cwd: path.resolve(__dirname, '..') });
    assert.notEqual(miss.status, 0);
    assert.match(String(miss.stdout || miss.stderr), /--hours/);
  });
});
