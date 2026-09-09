// #1151：mirasim-server ws 探活。HTTP 200 / 进程在探不出「state 帧发不出」。
// 闸守四件事：纯函数三态、自愈闸（有在途不杀）、单元有墙钟、装机脚本验 NEXT + sudoers 写死。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const UNIT_DIR = path.join(ROOT, 'host', 'machine', 'systemd');
const SERVICE = path.join(UNIT_DIR, 'mirasim-ws-probe.service');
const TIMER = path.join(UNIT_DIR, 'mirasim-ws-probe.timer');
const SERVER_UNIT = path.join(UNIT_DIR, 'mirasim-server.service');
const INSTALLER = path.join(ROOT, 'scripts', 'install-mirasim-ws-probe.sh');
const SCRIPT = path.join(ROOT, 'scripts', 'mirasim-ws-probe.mjs');
const SUDOERS = path.join(ROOT, 'host', 'machine', 'sudoers.d', 'mirasim-ws-probe');
const LIB = 'file://' + path.join(ROOT, 'scripts', 'lib', 'mirasim-ws-probe.mjs').split(path.sep).join('/');
const IO = 'file://' + SCRIPT.split(path.sep).join('/');
const RUNTIME = 'file://' + path.join(ROOT, 'scripts', 'lib', 'mirasim-runtime.mjs').split(path.sep).join('/');

const NOW = '2026-09-08T14:33:00Z';

function unavailable(msg, over = {}) {
  const err = new Error(msg);
  err.name = over.name || 'MirasimUnavailableError';
  err.code = over.code || 'unavailable';
  return err;
}

describe('握手三态：判活看 state 帧，不看 HTTP / 进程', () => {
  it('故意样本：连不上 ws（SIGSTOP 挂起）→ red，不是没查成', async () => {
    const { classifyHandshake } = await import(LIB);
    const r = classifyHandshake({ error: unavailable('连不上回环 ws') });
    assert.equal(r.state, 'red');
    assert.match(r.why, /连不上回环 ws/);
  });

  it('连上了但没收到 state 帧 → red（正是 2026-09-08 那一晚）', async () => {
    const { classifyHandshake } = await import(LIB);
    const hung = classifyHandshake({
      ok: false, unscanned: true, version: null,
      errors: ['没收到 state 帧——这是「没查成」，不是版本不符'],
    });
    assert.equal(hung.state, 'red');
    assert.match(hung.why, /没收到 state 帧/);

    const thrown = classifyHandshake({
      error: unavailable('连上了但没收到 state 帧，契约没查成——不派'),
    });
    assert.equal(thrown.state, 'red');
  });

  it('收到 state 帧就算绿——版本不符是契约另一格，探活不当死', async () => {
    const { classifyHandshake } = await import(LIB);
    const ok = classifyHandshake({
      ok: true, unscanned: false, version: '0.0.282', errors: [],
    });
    assert.equal(ok.state, 'green');
    const upgraded = classifyHandshake({
      ok: false, unscanned: false, version: '0.0.283',
      errors: ['版本不符：钉死 0.0.282，服务端报 0.0.283'],
    });
    assert.equal(upgraded.state, 'green', '升级那天拿版本钉死当红会整晚误报、把还活着的服务杀了');
  });

  it('令牌不在 / 不认识的错 → unscanned，不算连红', async () => {
    const { classifyHandshake } = await import(LIB);
    const noToken = classifyHandshake({ error: unavailable('读不到回环会话令牌，服务多半没在跑') });
    assert.equal(noToken.state, 'unscanned');
    const empty = classifyHandshake({ error: unavailable('回环会话令牌是空的') });
    assert.equal(empty.state, 'unscanned');
    const other = classifyHandshake({ error: new Error('EPERM') });
    assert.equal(other.state, 'unscanned');
    const weird = classifyHandshake(null);
    assert.equal(weird.state, 'unscanned');
  });
});

describe('在途三态：没扫成不许当成 0', () => {
  it('扫成 0 个会话 vs 根本没扫到，分得开', async () => {
    const { classifyInFlight } = await import(LIB);
    const empty = classifyInFlight({ ok: true, procs: [] });
    assert.equal(empty.ok, true);
    assert.equal(empty.count, 0);
    assert.equal(empty.unscanned, false);

    const miss = classifyInFlight({ ok: false, unscanned: true, error: '/proc 读不动' });
    assert.equal(miss.ok, false);
    assert.equal(miss.unscanned, true);
    assert.equal(miss.count, null);

    const noArr = classifyInFlight({ ok: true });
    assert.equal(noArr.unscanned, true);
    assert.equal(classifyInFlight(null).unscanned, true);
  });
});

describe('strikes 折叠：只有 red 累计；unscanned 清零但不冒充绿', () => {
  it('连红累加；绿清零并记下 lastGreenAt；没查成不算连红', async () => {
    const { foldWsProbe } = await import(LIB);
    const r1 = foldWsProbe(null, { error: unavailable('连不上回环 ws') }, NOW);
    assert.equal(r1.state, 'red');
    assert.equal(r1.strikes, 1);
    const r2 = foldWsProbe(r1, { error: unavailable('连不上回环 ws') }, NOW);
    assert.equal(r2.strikes, 2);
    const g = foldWsProbe(r2, { ok: true, unscanned: false, version: '0.0.282' }, NOW);
    assert.equal(g.strikes, 0);
    assert.equal(g.state, 'green');
    assert.equal(g.lastGreenAt, NOW);
    const u = foldWsProbe(r2, { error: unavailable('读不到回环会话令牌，服务多半没在跑') }, NOW);
    assert.equal(u.strikes, 0);
    assert.equal(u.state, 'unscanned');
  });
});

describe('自愈闸：有在途只报警不杀；没查成也不杀', () => {
  it('连红未到阈值：不报警不杀', async () => {
    const { decideWsHeal } = await import(LIB);
    const d = decideWsHeal({
      folded: { state: 'red', strikes: 1 },
      inflight: { ok: true, unscanned: false, count: 0 },
      strikesToAlert: 2, strikesToHeal: 2,
    });
    assert.equal(d.heal, false);
    assert.equal(d.alert, false);
  });

  it('连红达阈值且无在途 → 报警 + 重启', async () => {
    const { decideWsHeal } = await import(LIB);
    const d = decideWsHeal({
      folded: { state: 'red', strikes: 2 },
      inflight: { ok: true, unscanned: false, count: 0 },
    });
    assert.equal(d.heal, true);
    assert.equal(d.alert, true);
    assert.match(d.reason, /无在途/);
  });

  it('连红达阈值但有在途会话 → 只报警不杀', async () => {
    const { decideWsHeal } = await import(LIB);
    const d = decideWsHeal({
      folded: { state: 'red', strikes: 2 },
      inflight: { ok: true, unscanned: false, count: 3, why: '3 个会话进程' },
    });
    assert.equal(d.heal, false);
    assert.equal(d.alert, true);
    assert.match(d.reason, /只报警不杀/);
  });

  it('在途没查成 → 报警但不杀（当成 0 会把活人杀掉）', async () => {
    const { decideWsHeal } = await import(LIB);
    const d = decideWsHeal({
      folded: { state: 'red', strikes: 2 },
      inflight: { ok: false, unscanned: true, count: null, why: '扫不成' },
    });
    assert.equal(d.heal, false);
    assert.equal(d.alert, true);
    assert.match(d.reason, /在途没查成/);
  });

  it('绿 / 没查成：不动刀不报警', async () => {
    const { decideWsHeal } = await import(LIB);
    assert.equal(decideWsHeal({ folded: { state: 'green', strikes: 0 } }).heal, false);
    assert.equal(decideWsHeal({ folded: { state: 'green', strikes: 0 } }).alert, false);
    assert.equal(decideWsHeal({ folded: { state: 'unscanned', strikes: 0 } }).heal, false);
    assert.equal(decideWsHeal({ folded: { state: 'unscanned', strikes: 0 } }).alert, false);
  });
});

describe('群里说人话', () => {
  it('报警三行体：出事 / 影响 / 我打算；恢复另说一句', async () => {
    const { buildWsAlert, buildWsRecovered } = await import(LIB);
    const text = buildWsAlert({
      folded: { state: 'red', strikes: 2, why: '连不上回环 ws' },
      decision: { heal: true, alert: true, reason: '无在途' },
      plan: { strikesToAlert: 2 },
    });
    assert.match(text, /连续 2 次没回 state 帧/);
    assert.match(text, /影响：/);
    assert.match(text, /我打算：/);
    assert.match(text, /重启 mirasim-server/);
    const keep = buildWsAlert({
      folded: { state: 'red', strikes: 2, why: '没收到 state 帧' },
      decision: { heal: false, alert: true, reason: '有 2 个在途会话，只报警不杀' },
    });
    assert.match(keep, /只报警不杀/);
    const rec = buildWsRecovered({ lastWhy: '连不上回环 ws' });
    assert.match(rec, /恢复了/);
    assert.match(rec, /连不上回环 ws/);
  });
});

describe('一轮探活（注入握手 / 扫进程，不碰真 ws）', () => {
  it('故意样本：两轮连不上 → 无在途才 restart，且留痕', async () => {
    const { runProbe } = await import(IO);
    const said = [];
    const heals = [];
    const writes = [];
    const hung = async () => { throw unavailable('连不上回环 ws'); };
    const emptyScan = () => ({ ok: true, procs: [] });

    const first = await runProbe({
      handshake: hung, scan: emptyScan, prev: { folded: null, alerted: false },
      nowIso: NOW, say: (t) => said.push(t), heal: () => { heals.push('x'); return { ok: true, why: 'restarted' }; },
      writeState: (s) => writes.push(s), quiet: false,
    });
    assert.equal(first.folded.state, 'red');
    assert.equal(first.folded.strikes, 1);
    assert.equal(first.decision.heal, false);
    assert.equal(heals.length, 0);
    assert.equal(said.length, 0);

    const second = await runProbe({
      handshake: hung, scan: emptyScan, prev: writes[0],
      nowIso: '2026-09-08T14:43:00Z',
      say: (t) => said.push(t), heal: () => { heals.push('x'); return { ok: true, why: '已执行 try-restart' }; },
      writeState: (s) => writes.push(s), quiet: false,
    });
    assert.equal(second.folded.strikes, 2);
    assert.equal(second.decision.heal, true);
    assert.equal(second.healed, true);
    assert.equal(heals.length, 1);
    assert.equal(said.length, 1);
    assert.match(said[0], /没回 state 帧/);
    assert.equal(writes[1].healed, true);
    assert.match(writes[1].healWhy, /try-restart/);
  });

  it('有在途：第二轮只报警，heal 一次都不调', async () => {
    const { runProbe } = await import(IO);
    const heals = [];
    const said = [];
    const hung = async () => { throw unavailable('没收到 state 帧'); };
    const busy = () => ({ ok: true, procs: [{ pid: 1, comm: 'pi', cwd: '/x' }] });
    const prev = { folded: { state: 'red', strikes: 1, why: '没收到 state 帧' }, alerted: false };
    const r = await runProbe({
      handshake: hung, scan: busy, prev, nowIso: NOW,
      say: (t) => said.push(t), heal: () => { heals.push('x'); return { ok: true, why: 'no' }; },
      skipWrite: true,
    });
    assert.equal(r.decision.heal, false);
    assert.equal(r.decision.alert, true);
    assert.equal(heals.length, 0);
    assert.equal(said.length, 1);
    assert.match(said[0], /只报警不杀/);
  });

  it('恢复：上一轮报过、本轮绿 → 说一句恢复，不再 restart', async () => {
    const { runProbe } = await import(IO);
    const said = [];
    const heals = [];
    const r = await runProbe({
      handshake: async () => ({ ok: true, unscanned: false, version: '0.0.282' }),
      scan: () => ({ ok: true, procs: [] }),
      prev: { folded: { state: 'red', strikes: 2, why: '连不上回环 ws' }, alerted: true },
      nowIso: NOW, say: (t) => said.push(t), heal: () => { heals.push('x'); return { ok: true }; },
      skipWrite: true,
    });
    assert.equal(r.folded.state, 'green');
    assert.equal(r.decision.heal, false);
    assert.equal(heals.length, 0);
    assert.equal(said.length, 1);
    assert.match(said[0], /恢复了/);
  });

  it('--quiet 不报警不重启，也不推进 alerted', async () => {
    const { runProbe } = await import(IO);
    const said = [];
    const writes = [];
    const r = await runProbe({
      handshake: async () => { throw unavailable('连不上回环 ws'); },
      scan: () => ({ ok: true, procs: [] }),
      prev: { folded: { state: 'red', strikes: 1 }, alerted: false },
      nowIso: NOW, say: (t) => said.push(t),
      heal: () => { throw new Error('quiet 不该调 heal'); },
      writeState: (s) => writes.push(s), quiet: true,
    });
    assert.equal(r.decision.heal, true, '闸本身到了阈值');
    assert.equal(r.healed, false);
    assert.equal(said.length, 0);
    assert.equal(writes[0].alerted, false);
  });
});

describe('handshake 是只读：不发 prompt、挂断', () => {
  it('收到 state 就返回 judgeContract 结果，一帧 prompt 都没有', async () => {
    const { createRuntime } = await import(RUNTIME);
    const sent = [];
    const wire = {
      state: {
        version: '0.0.282', workdir: '/srv', home: '/srv', platform: 'linux',
        agentsAvailable: ['claude'],
      },
      send(obj) { sent.push(obj); },
      async waitFor() { return null; },
      close() { this.hungUp = true; },
    };
    const rt = createRuntime({ connect: async () => wire });
    const v = await rt.handshake();
    assert.equal(v.ok, true);
    assert.equal(v.unscanned, false);
    assert.deepStrictEqual(sent.filter((f) => f.type === 'prompt'), []);
    assert.equal(wire.hungUp, true);
  });
});

describe('systemd 单元与装机脚本', () => {
  it('探活单元在，User=orca，timer 有 OnCalendar 墙钟点位 *:08/10', () => {
    assert.equal(fs.existsSync(SERVICE), true, 'mirasim-ws-probe.service 不在');
    assert.equal(fs.existsSync(TIMER), true, 'mirasim-ws-probe.timer 不在');
    const s = fs.readFileSync(SERVICE, 'utf8');
    const t = fs.readFileSync(TIMER, 'utf8');
    assert.match(s, /^User=orca$/m);
    assert.match(s, /scripts\/mirasim-ws-probe\.mjs/);
    assert.match(s, /^UnsetEnvironment=GH_TOKEN GITHUB_TOKEN$/m);
    assert.match(s, /^Environment=GH_CONFIG_DIR=\/var\/empty$/m);
    assert.match(t, /^OnCalendar=\*:08\/10$/m);
    assert.match(t, /^Persistent=true$/m);
  });

  it('mirasim-server unit 收进仓，Restart=always，垫片 MemoryMax 在文件里不是手搓 drop-in', () => {
    assert.equal(fs.existsSync(SERVER_UNIT), true, 'mirasim-server.service 不在仓内——结束不了手搓漂移');
    const s = fs.readFileSync(SERVER_UNIT, 'utf8');
    assert.match(s, /^User=orca$/m);
    assert.match(s, /^Restart=always$/m);
    assert.match(s, /^TimeoutStopSec=10s$/m, 'SIGSTOP 挂起时 SIGTERM 进不去，要靠这一行 SIGKILL，否则探针 30s 超时自愈失败');
    assert.match(s, /^MemoryHigh=2\.5G$/m);
    assert.match(s, /^MemoryMax=4G$/m);
    assert.match(s, /server\.cjs --port 4316/);
    assert.equal(fs.existsSync(path.join(UNIT_DIR, 'mirasim-server.service.d')), false,
      '垫片合进 unit 了，仓内不要再留一份 drop-in，⑳ 只比对 .service');
  });

  it('装机脚本在，要 root，装完验 NEXT，不 chmod 仓内文件，顺手删手搓 drop-in', () => {
    assert.equal(fs.existsSync(INSTALLER), true, '装机脚本不在，单元只能靠人手抄进 /etc');
    const text = fs.readFileSync(INSTALLER, 'utf8');
    const bad = text.split(/\r?\n/).filter((l) =>
      /^\s*chmod\b/.test(l) && /\$(ROOT|\{ROOT\})/.test(l));
    assert.deepEqual(bad, []);
    assert.match(text, /EUID/);
    assert.match(text, /NextElapseUSecRealtime/);
    assert.match(text, /mirasim-ws-probe\.timer/);
    assert.match(text, /memory-guard\.conf/);
    assert.match(text, /visudo/);
  });

  it('sudoers 白名单写死 try-restart mirasim-server，不许通配、不许指家目录', () => {
    assert.equal(fs.existsSync(SUDOERS), true, '白名单不在——连红了也重启不了');
    const rules = fs.readFileSync(SUDOERS, 'utf8').split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#'));
    assert.ok(rules.length > 0, '一条规则都没有，扫出 0 条不算通过');
    for (const r of rules) {
      assert.ok(!/[*?]/.test(r), `带通配等于把「能重启任何单元」给了 orca：${r}`);
      assert.match(r, /NOPASSWD:\s*\/usr\/bin\/systemctl try-restart mirasim-server\.service$/,
        `只许 try-restart 写死的那一个单元：${r}`);
      assert.ok(!/\/home\//.test(r), `白名单指向家目录 = 指向可写的地方：${r}`);
    }
  });

  it('NEW-MACHINE §9 有一行装法；INDEX 登记探活状态落点', () => {
    const nm = fs.readFileSync(path.join(ROOT, 'NEW-MACHINE.md'), 'utf8');
    assert.match(nm, /install-mirasim-ws-probe\.sh/);
    const index = fs.readFileSync(path.join(ROOT, 'host', 'machine', 'INDEX.md'), 'utf8');
    assert.match(index, /mirasim-ws-probe/);
    assert.match(index, /scripts\/mirasim-ws-probe\.mjs/);
  });
});

describe('旧 --install 不许再写 /etc', () => {
  it('--install 非零退出，且不碰 /etc', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--install'], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    assert.notEqual(r.status, 0);
    assert.match(String(r.stderr || ''), /--install 已退役/);
    assert.match(String(r.stderr || ''), /install-mirasim-ws-probe\.sh/);
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.doesNotMatch(src, /writeFileSync\(["']\/etc\/systemd/);
  });
});
