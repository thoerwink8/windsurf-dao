// #967：把 gw-remote-probe 从「只活在机器上」收进仓。
// 闸守四件事：纯函数（健康表折叠 / 探测面派生）、单元有墙钟、装机脚本验 NEXT、
// 旧 --install 不许再写出缺 OnCalendar 的模板。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const UNIT_DIR = path.join(ROOT, 'host', 'machine', 'systemd');
const SERVICE = path.join(UNIT_DIR, 'gw-remote-probe.service');
const TIMER = path.join(UNIT_DIR, 'gw-remote-probe.timer');
const INSTALLER = path.join(ROOT, 'scripts', 'install-gw-remote-probe.sh');
const SCRIPT = path.join(ROOT, 'scripts', 'gw-remote-probe.mjs');
const HEALTH = 'file://' + path.join(ROOT, 'scripts', 'lib', 'probe-health.mjs').split(path.sep).join('/');
const POLICY = 'file://' + path.join(ROOT, 'scripts', 'lib', 'gateway-policy.mjs').split(path.sep).join('/');

describe('探针纯函数：健康表折叠', () => {
  it('red 累计 strikes；green 清零并记下 lastGreenAt；unscanned 不算连红', async () => {
    const { foldTarget } = await import(HEALTH);
    const now = '2026-09-07T00:00:00Z';
    const r1 = foldTarget(null, { kind: 'pool', state: 'red', code: 403, ms: 12, why: 'HTTP 403' }, now);
    assert.equal(r1.strikes, 1);
    assert.equal(r1.state, 'red');
    const r2 = foldTarget(r1, { kind: 'pool', state: 'red', code: 403, ms: 13, why: 'HTTP 403' }, now);
    assert.equal(r2.strikes, 2);
    const g = foldTarget(r2, { kind: 'pool', state: 'green', code: 200, ms: 20, why: '20ms' }, now);
    assert.equal(g.strikes, 0);
    assert.equal(g.lastGreenAt, now);
    const u = foldTarget(r2, { kind: 'leg', state: 'unscanned', code: null, ms: null, why: '口关了' }, now);
    assert.equal(u.strikes, 0);
    assert.equal(u.state, 'unscanned');
  });

  it('读不到 / 过期的 legs.json → 全部 unscanned，不是红', async () => {
    const { mergeLegHealth } = await import(HEALTH);
    const legs = [{ key: 'leg:WindsurfAPI', nameLike: 'WindsurfAPI' }];
    const now = Date.parse('2026-09-07T12:00:00Z');
    const miss = mergeLegHealth(legs, null, now, 30);
    assert.equal(miss['leg:WindsurfAPI'].state, 'unscanned');
    const stale = mergeLegHealth(legs, {
      updatedAt: '2026-09-07T10:00:00Z',
      legs: { WindsurfAPI: { state: 'green', code: 200, ms: 9 } },
    }, now, 30);
    assert.equal(stale['leg:WindsurfAPI'].state, 'unscanned');
    const fresh = mergeLegHealth(legs, {
      updatedAt: '2026-09-07T11:50:00Z',
      legs: { WindsurfAPI: { state: 'green', code: 200, ms: 9 } },
    }, now, 30);
    assert.equal(fresh['leg:WindsurfAPI'].state, 'green');
  });

  it('连红达阈值才进 newlyBad；恢复的从 alerted 拿掉；unscanned 不参与', async () => {
    const { computeAlerts, buildHealthTable } = await import(HEALTH);
    const now = '2026-09-07T00:00:00Z';
    const table = buildHealthTable(null, [
      { key: 'gw:dspool/x', kind: 'pool', state: 'red', code: 403, ms: 1, why: '403' },
      { key: 'leg:WindsurfAPI', kind: 'leg', state: 'unscanned', code: null, ms: null, why: '口关了' },
    ], 30, now);
    const first = computeAlerts(table, [], 2);
    assert.deepEqual(first.newlyBad, []);
    assert.deepEqual(first.nowRed, ['gw:dspool/x']);
    const table2 = buildHealthTable(table, [
      { key: 'gw:dspool/x', kind: 'pool', state: 'red', code: 403, ms: 1, why: '403' },
    ], 30, now);
    const second = computeAlerts(table2, first.nextAlerted, 2);
    assert.deepEqual(second.newlyBad, ['gw:dspool/x']);
    const recovered = buildHealthTable(table2, [
      { key: 'gw:dspool/x', kind: 'pool', state: 'green', code: 200, ms: 8, why: '8ms' },
    ], 30, now);
    const after = computeAlerts(recovered, second.nextAlerted, 2);
    assert.deepEqual(after.recovered, ['gw:dspool/x']);
    assert.deepEqual(after.nextAlerted, []);
  });
});

describe('探针纯函数：探测面从策略派生', () => {
  function miniPolicy() {
    return {
      pools: {
        why: '测',
        list: [{
          alias: 'grok-4.6', group: 'grokpool',
          legs: [
            { nameLike: 'Grok-openai', priority: 1 },
            { nameLike: 'cursor-api-proxy', priority: 2 },
          ],
        }],
      },
      probe: {
        why: '测',
        intervalMin: 30, strikesToAlert: 2, heartbeatDays: 7,
        healthFile: '~/.dao/provider-health.json',
        legsEndpoint: 'https://example.test/health/legs.json',
        targets: [{ group: 'grokpool', model: 'grok-4.6' }],
        direct: [{ key: 'direct:codex@pqapi/responses', model: 'gpt-5.6-sol' }],
      },
    };
  }

  it('pool / leg / direct 三类 key 前缀一次算齐', async () => {
    const { probePlan } = await import(POLICY);
    const plan = probePlan(miniPolicy());
    assert.deepEqual(plan.pools.map((t) => t.key), ['gw:grokpool/grok-4.6']);
    assert.deepEqual(plan.legs.map((t) => t.key), ['leg:Grok-openai', 'leg:cursor-api-proxy']);
    assert.equal(plan.direct[0].kind, 'direct');
    assert.equal(plan.healthFile, '~/.dao/provider-health.json');
  });

  it('缺 pools/probe 节 → 抛，不是 silently 探空面', async () => {
    const { loadPolicy } = await import(POLICY);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-policy-'));
    const f = path.join(dir, 'gateway-policy.json');
    fs.writeFileSync(f, JSON.stringify({ pools: { why: 'x', list: [{ alias: 'a', group: 'g', legs: [{ nameLike: 'n', priority: 1 }] }] } }));
    assert.throws(() => loadPolicy(f), /缺节/);
  });

  it('probe 有 why 但缺 targets → loadPolicy / probePlan 都抛', async () => {
    const { loadPolicy, probePlan } = await import(POLICY);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-policy-'));
    const f = path.join(dir, 'gateway-policy.json');
    const policy = {
      pools: {
        why: 'ok',
        list: [{ alias: 'a', group: 'testpool', legs: [{ nameLike: 'n', priority: 1 }] }],
      },
      probe: { why: 'ok', intervalMin: 30, strikesToAlert: 2, heartbeatDays: 7 },
    };
    fs.writeFileSync(f, JSON.stringify(policy));
    assert.throws(() => loadPolicy(f), /probe\.targets 不能为空/);
    assert.throws(() => probePlan(policy), /probe\.targets 不能为空/);
  });

  it('probe.targets 空数组或条目缺 group/model → 抛', async () => {
    const { probePlan } = await import(POLICY);
    const base = miniPolicy();
    assert.throws(() => probePlan({ ...base, probe: { ...base.probe, targets: [] } }), /probe\.targets 不能为空/);
    assert.throws(
      () => probePlan({ ...base, probe: { ...base.probe, targets: [{ group: 'testpool' }] } }),
      /probe\.targets 条目缺 group\/model/,
    );
  });

  it('缺 targets 的策略跑主流程：非零退出，不写新健康表', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-probe-notargets-'));
    const policyFile = path.join(dir, 'gateway-policy.json');
    const healthFile = path.join(dir, 'provider-health.json');
    const oldTable = JSON.stringify({
      updatedAt: '2026-09-01T00:00:00Z',
      intervalMin: 30,
      targets: { 'gw:testpool/model': { kind: 'pool', state: 'green', why: 'old' } },
    }, null, 2);
    fs.writeFileSync(healthFile, oldTable);
    fs.writeFileSync(policyFile, JSON.stringify({
      pools: {
        why: 'ok',
        list: [{ alias: 'a', group: 'testpool', legs: [{ nameLike: 'n', priority: 1 }] }],
      },
      probe: { why: 'ok', intervalMin: 30, strikesToAlert: 2, heartbeatDays: 7 },
    }));
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      env: { ...process.env, GW_POLICY: policyFile, GW_HEALTH_FILE: healthFile },
    });
    assert.notEqual(r.status, 0);
    assert.match(String(r.stderr || ''), /probe\.targets 不能为空/);
    assert.equal(fs.readFileSync(healthFile, 'utf8'), oldTable);
  });
});

describe('周期探针 responses 请求体不许再漂成裸字符串', () => {
  it('主脚本必须用 codexResponsesProbeBody，不得手写 input: "reply …"', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.match(src, /codexResponsesProbeBody/);
    assert.doesNotMatch(src, /input:\s*["']reply with the single word ok["']/);
    assert.doesNotMatch(src, /input:\s*PROBE_MESSAGE/);
  });
});

describe('直连 responses：空 content 不算通', () => {
  it('response.completed + content:[] 即使序列化很长也是红', async () => {
    const { responsesEventHasContent } = await import(HEALTH);
    const empty = {
      type: 'response.completed',
      response: {
        id: 'resp_empty_content_padding_xxxxx',
        output: [{ type: 'message', role: 'assistant', content: [] }],
      },
    };
    assert.equal(JSON.stringify(empty.response.output).length > 40, true);
    assert.equal(responsesEventHasContent(empty), false);
  });

  it('completed 里有非空 text / output_text.delta 才算通', async () => {
    const { responsesEventHasContent } = await import(HEALTH);
    assert.equal(responsesEventHasContent({
      type: 'response.completed',
      response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] },
    }), true);
    assert.equal(responsesEventHasContent({
      type: 'response.output_text.delta',
      delta: 'ok',
    }), true);
    assert.equal(responsesEventHasContent({
      type: 'response.output_text.delta',
      delta: '',
    }), false);
  });
});

describe('systemd 单元与装机脚本', () => {
  it('单元在，User=orca，timer 有 OnCalendar 墙钟点位', () => {
    assert.equal(fs.existsSync(SERVICE), true, 'gw-remote-probe.service 不在');
    assert.equal(fs.existsSync(TIMER), true, 'gw-remote-probe.timer 不在');
    const s = fs.readFileSync(SERVICE, 'utf8');
    const t = fs.readFileSync(TIMER, 'utf8');
    assert.match(s, /^User=orca$/m);
    assert.match(s, /^UnsetEnvironment=GH_TOKEN GITHUB_TOKEN$/m);
    assert.match(s, /^Environment=GH_CONFIG_DIR=\/var\/empty$/m);
    assert.match(s, /scripts\/gw-remote-probe\.mjs/);
    assert.match(s, /^UnsetEnvironment=GH_TOKEN GITHUB_TOKEN$/m);
    assert.match(s, /^Environment=GH_CONFIG_DIR=\/var\/empty$/m);
    assert.match(t, /^OnCalendar=/m);
    assert.match(t, /^Persistent=true$/m);
    assert.match(t, /^OnCalendar=\*:09\/30$/m);
  });

  it('装机脚本在，要 root，装完验 NEXT，不 chmod 仓内文件', () => {
    assert.equal(fs.existsSync(INSTALLER), true, '装机脚本不在，单元只能靠人手抄进 /etc');
    const text = fs.readFileSync(INSTALLER, 'utf8');
    const bad = text.split(/\r?\n/).filter((l) =>
      /^\s*chmod\b/.test(l) && /\$(ROOT|\{ROOT\})/.test(l));
    assert.deepEqual(bad, []);
    assert.match(text, /EUID/);
    assert.match(text, /NextElapseUSecRealtime/);
    assert.match(text, /gw-remote-probe\.timer/);
  });

  it('NEW-MACHINE §9 有一行装法；INDEX 登记本机落点与健康表写入方', () => {
    const nm = fs.readFileSync(path.join(ROOT, 'NEW-MACHINE.md'), 'utf8');
    assert.match(nm, /install-gw-remote-probe\.sh/);
    const index = fs.readFileSync(path.join(ROOT, 'host', 'machine', 'INDEX.md'), 'utf8');
    assert.match(index, /~\/bin\/gw-remote-probe\.mjs/);
    assert.match(index, /~\/bin\/probe-health\.mjs/);
    assert.match(index, /scripts\/gw-remote-probe\.mjs/);
  });
});

describe('旧 --install 不许再写缺墙钟的模板', () => {
  it('--install 非零退出，且不碰 /etc', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--install'], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    assert.notEqual(r.status, 0);
    assert.match(String(r.stderr || ''), /--install 已退役/);
    assert.match(String(r.stderr || ''), /install-gw-remote-probe\.sh/);
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.doesNotMatch(src, /writeFileSync\("\/etc\/systemd\/system\/gw-remote-probe/);
  });
});
