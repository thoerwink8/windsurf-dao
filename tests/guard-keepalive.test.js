// #683/#693 守卫保活：认 watchdog.mjs / flow.mjs；列表没查成不许当 0；#693 起只留 --once 入口（帥位触发）。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'guard-keepalive.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));
const CLI = path.join(__dirname, '..', 'scripts', 'guard-keepalive.mjs');

describe('guard-keepalive', () => {
  it('命令行分类：认守卫脚本，不认同名噪音', async (t) => {
    const K = await LIB_LOAD;
    await t.test('watchdog.mjs 命中', () => {
      assert.ok(K.classifyCommandLine('C:\\\\nvm4w\\\\nodejs\\\\node.exe C:\\\\Users\\\\Administrator\\\\.dao\\\\guard-mirror\\\\scripts\\\\watchdog.mjs') === 'watchdog',
        'watchdog.mjs');
    });
    await t.test('flow.mjs 命中', () => {
      assert.ok(K.classifyCommandLine('"C:\\\\nvm4w\\\\nodejs\\\\node.exe" "D:\\\\frank\\\\windsurf-dao\\\\scripts\\\\flow.mjs" --state-file x') === 'flow',
        'flow.mjs');
    });
    await t.test('watchdog-report.mjs 不是 watchdog', () => {
      assert.ok(K.classifyCommandLine('node scripts/lib/watchdog-report.mjs') == null, 'watchdog-report');
    });
    await t.test('chrome-devtools watchdog/main.js 不是', () => {
      assert.ok(K.classifyCommandLine('node .../chrome-devtools-mcp/build/src/telemetry/watchdog/main.js --parent-pid=1') == null,
        'chrome-devtools');
    });
    await t.test('CodeGraph CODEGRAPH_NO_WATCHDOG 不是', () => {
      assert.ok(K.classifyCommandLine('node -e "Disable with CODEGRAPH_NO_WATCHDOG=1"') == null, 'codegraph');
    });
    await t.test('tests/watchdog.test.js 不是', () => {
      assert.ok(K.classifyCommandLine('node --test tests/watchdog.test.js') == null, 'test file');
    });
  });

  it('进程列表：空输出是扫完 0；坏 JSON 是没查成', async (t) => {
    const K = await LIB_LOAD;
    const empty = K.parseProcessJson('');
    await t.test('空 = 0 个进程，ok', () => {
      assert.ok(empty.ok && empty.processes.length === 0, '空  →  ' + JSON.stringify(empty));
    });
    const one = K.parseProcessJson('{"ProcessId":11,"CommandLine":"node scripts/watchdog.mjs"}');
    await t.test('单对象不是数组也能解析', () => {
      assert.ok(one.ok && one.processes[0].pid === 11, '单对象  →  ' + JSON.stringify(one));
    });
    const bad = K.parseProcessJson('<html>nope');
    await t.test('坏 JSON 没查成', () => {
      assert.ok(bad.ok === false && /没查成/.test(bad.error) && bad.processes.length === 0, '坏 JSON  →  ' + JSON.stringify(bad));
    });
  });

  it('计划：已在则 already；不在则 start；列表失败不许 start', async (t) => {
    const K = await LIB_LOAD;
    const scripts = {
      watchdog: { script: 'W', cwd: 'C', exists: true, extraArgs: ['--heartbeat-file', 'h'] },
      flow: { script: 'F', cwd: 'C', exists: true, extraArgs: ['--state-file', 's'] },
    };
    const fail = K.planKeepalive({ listed: { ok: false, error: 'timeout' }, scripts });
    await t.test('列表失败 ok=false 且无 start', () => {
      assert.ok(fail.ok === false && /没查成/.test(fail.error) && fail.actions.length === 0, '失败  →  ' + JSON.stringify(fail));
    });
    const none = K.planKeepalive({ listed: { ok: true, processes: [] }, scripts });
    await t.test('0 个进程 → 两个 start', () => {
      assert.ok(none.ok && none.actions.every((a) => a.action === 'start') && none.actions.length === 2,
        '全 start  →  ' + JSON.stringify(none.actions));
    });
    const live = K.planKeepalive({
      listed: {
        ok: true,
        processes: [
          { pid: 9, commandLine: 'node scripts/watchdog.mjs' },
          { pid: 8, commandLine: 'node scripts/flow.mjs' },
        ],
      },
      scripts,
    });
    await t.test('都在 → already，不 start', () => {
      assert.ok(live.ok && live.actions.every((a) => a.action === 'already') && !live.actions.some((a) => a.action === 'start'),
        'already  →  ' + JSON.stringify(live.actions));
    });
    const missing = K.planKeepalive({
      listed: { ok: true, processes: [] },
      scripts: { watchdog: { exists: false }, flow: { exists: false } },
    });
    await t.test('脚本不在 → missing-script，不是 already', () => {
      assert.ok(missing.ok && missing.actions.every((a) => a.action === 'missing-script'),
        '缺脚本  →  ' + JSON.stringify(missing.actions));
    });
  });

  it('apply：start 调 spawn；already 不 spawn', async (t) => {
    const K = await LIB_LOAD;
    const spawned = [];
    const plan = {
      ok: true,
      actions: [
        { name: 'watchdog', action: 'already', pid: 1 },
        { name: 'flow', action: 'start', script: 'F', cwd: 'C', extraArgs: ['--state-file', 's'] },
      ],
    };
    const applied = K.applyKeepalivePlan(plan, {
      execPath: 'node',
      logDir: null,
      start: (opts) => { spawned.push(opts); return { pid: 99 }; },
    });
    await t.test('只 spawn flow', () => {
      assert.ok(spawned.length === 1 && spawned[0].script === 'F' && spawned[0].extraArgs[0] === '--state-file',
        'spawn  →  ' + JSON.stringify(spawned));
    });
    await t.test('startDetached 走 detached + stdio ignore', () => {
      const calls = [];
      const r = K.startDetached({
        execPath: 'C:/n/node.exe',
        script: 'W.mjs',
        extraArgs: ['--heartbeat-file', 'h'],
        cwd: 'C:/m',
        spawnFn: (exe, args, opts) => {
          calls.push({ exe, args, opts });
          return { pid: 4242, unref() {} };
        },
      });
      assert.ok(calls[0].exe === 'C:/n/node.exe' && calls[0].args[0] === 'W.mjs' && calls[0].opts.detached === true && calls[0].opts.stdio === 'ignore' && calls[0].opts.windowsHide === true && r.pid === 4242,
        'detached  →  ' + JSON.stringify({ r, calls }));
    });
    await t.test('结果含 already + started', () => {
      const kinds = applied.results.map((r) => r.action).join(',');
      assert.ok(applied.ok && kinds === 'already,started' && applied.results[1].pid === 99, '结果  →  ' + JSON.stringify(applied));
    });
  });

  it('#693 自研保活入口已删：--install/--print-install/--status 一律拒绝', async (t) => {
    for (const flag of ['--install', '--print-install', '--status']) {
      const r = spawnSync(process.execPath, [CLI, flag], {
        encoding: 'utf8',
        cwd: path.resolve(__dirname, '..'),
        windowsHide: true,
      });
      await t.test(`${flag} → exit 3 未知参数`, () => {
        assert.ok(r.status === 3 && /未知参数/.test(r.stderr || ''), `${flag}  →  status=${r.status} ${(r.stderr || '').slice(0, 120)}`);
      });
    }
    const help = spawnSync(process.execPath, [CLI, '--help'], {
      encoding: 'utf8',
      cwd: path.resolve(__dirname, '..'),
      windowsHide: true,
    });
    await t.test('--help 退出码 0 且只讲 --once', () => {
      assert.ok(help.status === 0 && /--once/.test(help.stdout || ''), 'help  →  ' + (help.stdout || '').slice(0, 200));
    });
  });

  it('onceResultBits：两个 hook 共用的 --once 结果读取口', async (t) => {
    const K = await LIB_LOAD;
    const bits = K.onceResultBits({
      ok: true,
      results: [
        { name: 'watchdog', action: 'already', pid: 7 },
        { name: 'flow', action: 'started', pid: 99 },
      ],
    });
    await t.test('started/failed/all 各归各', () => {
      assert.ok(bits.started.length === 1 && bits.failed.length === 0
        && bits.all.join(',') === 'watchdog=already(7),flow=started(99)', 'bits  →  ' + JSON.stringify(bits));
    });
    const bad = K.onceResultBits({ results: [{ name: 'flow', action: 'start-failed', error: 'x' }] });
    await t.test('start-failed 进 failed', () => {
      assert.ok(bad.failed.length === 1 && bad.started.length === 0, 'bad  →  ' + JSON.stringify(bad));
    });
    await t.test('doc 不是对象也不炸', () => {
      const empty = K.onceResultBits(null);
      assert.ok(empty.all.length === 0 && empty.started.length === 0 && empty.failed.length === 0, 'null  →  ' + JSON.stringify(empty));
    });
  });

  it('resolveGuardScripts 镜像优先，心跳指到主树', async (t) => {
    const K = await LIB_LOAD;
    const scripts = K.resolveGuardScripts({
      mirrorPath: 'M',
      repoRoot: 'R',
      mainPath: 'D:/frank/windsurf-dao',
      exists: (p) => String(p).replace(/\\/g, '/').includes('M/scripts'),
    });
    await t.test('watchdog 用镜像脚本', () => {
      const s = scripts.watchdog.script.replace(/\\/g, '/');
      assert.ok(scripts.watchdog.exists && /M\/scripts\/watchdog\.mjs$/.test(s), '镜像  →  ' + s);
    });
    await t.test('heartbeat-file 指主树 _flow', () => {
      assert.ok(scripts.watchdog.extraArgs.includes('--heartbeat-file') && /_flow[\\/]heartbeat\.json/.test(scripts.watchdog.extraArgs.join(' ')),
        'hb  →  ' + scripts.watchdog.extraArgs.join(' '));
    });
  });

  it('worktree porcelain 第一棵是主树', async () => {
    const K = await LIB_LOAD;
    const p = K.parseWorktreePorcelain('worktree D:/frank/windsurf-dao\nHEAD abc\nbranch refs/heads/master\n\nworktree C:/wt\nHEAD def\n');
    assert.ok(p === 'D:/frank/windsurf-dao', 'porcelain  →  ' + p);
  });

  it('进程列表带 StartedMs（启动宽限的依据），缺了为 null', async (t) => {
    const K = await LIB_LOAD;
    const one = K.parseProcessJson('{"ProcessId":11,"CommandLine":"node scripts/watchdog.mjs","StartedMs":1755753600000}');
    await t.test('StartedMs 解析成 startedMs', () => {
      assert.ok(one.ok && one.processes[0].startedMs === 1755753600000, 'startedMs  →  ' + JSON.stringify(one));
    });
    const old = K.parseProcessJson('{"ProcessId":11,"CommandLine":"node scripts/watchdog.mjs"}');
    await t.test('老形态没有 StartedMs → null 不炸', () => {
      assert.ok(old.ok && old.processes[0].startedMs === null, 'null  →  ' + JSON.stringify(old));
    });
  });

  it('心跳读写：tmp+rename 落盘，读回四态（ok/missing/corrupt/unchecked）', async (t) => {
    const K = await LIB_LOAD;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-hb-'));
    const p = path.join(dir, 'watchdog-heartbeat.json');
    await t.test('写完读回 ok 带 ts', () => {
      K.writeGuardHeartbeat(p, { ts: '2026-08-21T06:50:00.000Z', round: 3, pid: 1234 });
      const hb = K.readGuardHeartbeat(p);
      assert.ok(hb.state === 'ok' && hb.ts === Date.parse('2026-08-21T06:50:00.000Z'), 'ok  →  ' + JSON.stringify(hb));
    });
    await t.test('不存在 → missing', () => {
      const hb = K.readGuardHeartbeat(path.join(dir, 'nope.json'));
      assert.ok(hb.state === 'missing', 'missing  →  ' + JSON.stringify(hb));
    });
    await t.test('坏 JSON → corrupt', () => {
      const bad = path.join(dir, 'bad.json');
      fs.writeFileSync(bad, 'not json{', 'utf8');
      const hb = K.readGuardHeartbeat(bad);
      assert.ok(hb.state === 'corrupt' && hb.error, 'corrupt  →  ' + JSON.stringify(hb));
    });
    await t.test('缺 ts → corrupt', () => {
      const nots = path.join(dir, 'nots.json');
      fs.writeFileSync(nots, '{"round":1}', 'utf8');
      const hb = K.readGuardHeartbeat(nots);
      assert.ok(hb.state === 'corrupt', 'corrupt  →  ' + JSON.stringify(hb));
    });
    await t.test('路径 null → unchecked（没查成，不是停更）', () => {
      const hb = K.readGuardHeartbeat(null);
      assert.ok(hb.state === 'unchecked', 'unchecked  →  ' + JSON.stringify(hb));
    });
  });

  it('心跳路径：watchdog 落守卫状态目录；flow 跟 --state-file 同目录', async (t) => {
    const K = await LIB_LOAD;
    await t.test('watchdog 默认 ~/.dao/guard', () => {
      const p = K.watchdogHeartbeatPath({ env: {}, homedir: '/h' }).replace(/\\/g, '/');
      assert.ok(p === '/h/.dao/guard/watchdog-heartbeat.json', 'path  →  ' + p);
    });
    await t.test('DAO_GUARD_HALT_DIR 改道', () => {
      const p = K.watchdogHeartbeatPath({ env: { DAO_GUARD_HALT_DIR: '/x' }, homedir: '/h' }).replace(/\\/g, '/');
      assert.ok(p === '/x/watchdog-heartbeat.json', 'path  →  ' + p);
    });
    await t.test('flow 有 mainPath 落主树 _flow', () => {
      const p = K.flowHeartbeatPath({ mainPath: '/m', flowSpec: { cwd: '/mir' } }).replace(/\\/g, '/');
      assert.ok(p === '/m/_flow/heartbeat.json', 'path  →  ' + p);
    });
    await t.test('flow 无 mainPath 落拉起 cwd 的 _flow', () => {
      const p = K.flowHeartbeatPath({ mainPath: null, flowSpec: { cwd: '/mir' } }).replace(/\\/g, '/');
      assert.ok(p === '/mir/_flow/heartbeat.json', 'path  →  ' + p);
    });
    await t.test('两边都不知道 → null（不乱杀）', () => {
      assert.ok(K.flowHeartbeatPath({ mainPath: null, flowSpec: null }) === null, 'null');
    });
  });

  it('#699 计划：心跳新鲜不动；停更/缺失/损坏杀掉重启；没查成不乱杀', async (t) => {
    const K = await LIB_LOAD;
    const now = 1_800_000_000_000;
    const scripts = {
      watchdog: { script: 'W', cwd: 'C', exists: true, extraArgs: [] },
      flow: { script: 'F', cwd: 'C', exists: true, extraArgs: [] },
    };
    const procs = [
      { pid: 9, commandLine: 'node scripts/watchdog.mjs', startedMs: now - 3600_000 },
      { pid: 8, commandLine: 'node scripts/flow.mjs', startedMs: now - 3600_000 },
    ];
    const plan = (heartbeats) => K.planKeepalive({ listed: { ok: true, processes: procs }, scripts, heartbeats, now });

    await t.test('心跳新鲜 → already 不动', () => {
      const p = plan({ watchdog: { state: 'ok', ts: now - 30_000 }, flow: { state: 'ok', ts: now - 100_000 } });
      assert.ok(p.ok && p.actions.every((a) => a.action === 'already')
        && p.actions.every((a) => a.heartbeat && a.heartbeat.state === 'fresh'), 'fresh  →  ' + JSON.stringify(p.actions));
    });
    await t.test('watchdog 停更超 5 分钟 → restart 带 killPids；flow 新鲜不受影响', () => {
      const p = plan({ watchdog: { state: 'ok', ts: now - 6 * 60_000 }, flow: { state: 'ok', ts: now - 100_000 } });
      const w = p.actions.find((a) => a.name === 'watchdog');
      const f = p.actions.find((a) => a.name === 'flow');
      assert.ok(w.action === 'restart' && w.reason === 'heartbeat-stale' && w.killPids.join() === '9' && w.script === 'W'
        && f.action === 'already', 'stale  →  ' + JSON.stringify(p.actions));
    });
    await t.test('flow 停更超 10 分钟 → restart', () => {
      const p = plan({ watchdog: { state: 'ok', ts: now - 10_000 }, flow: { state: 'ok', ts: now - 11 * 60_000 } });
      const f = p.actions.find((a) => a.name === 'flow');
      assert.ok(f.action === 'restart' && f.reason === 'heartbeat-stale' && f.killPids.join() === '8', 'flow stale  →  ' + JSON.stringify(f));
    });
    await t.test('心跳缺失 + 进程老 → restart（按停更处理）', () => {
      const p = plan({ watchdog: { state: 'missing' }, flow: { state: 'ok', ts: now - 1000 } });
      const w = p.actions.find((a) => a.name === 'watchdog');
      assert.ok(w.action === 'restart' && w.reason === 'heartbeat-missing', 'missing  →  ' + JSON.stringify(w));
    });
    await t.test('心跳损坏 + 进程老 → restart', () => {
      const p = plan({ watchdog: { state: 'corrupt', error: '不是 JSON' }, flow: { state: 'ok', ts: now - 1000 } });
      const w = p.actions.find((a) => a.name === 'watchdog');
      assert.ok(w.action === 'restart' && w.reason === 'heartbeat-corrupt', 'corrupt  →  ' + JSON.stringify(w));
    });
    await t.test('启动宽限：停更/缺失但进程活了不到一个阈值窗口 → already 不杀', () => {
      const young = [
        { pid: 9, commandLine: 'node scripts/watchdog.mjs', startedMs: now - 60_000 },
        { pid: 8, commandLine: 'node scripts/flow.mjs', startedMs: now - 60_000 },
      ];
      const p = K.planKeepalive({
        listed: { ok: true, processes: young }, scripts, now,
        heartbeats: { watchdog: { state: 'ok', ts: now - 3600_000 }, flow: { state: 'missing' } },
      });
      assert.ok(p.actions.every((a) => a.action === 'already' && a.heartbeat && a.heartbeat.grace === true),
        'grace  →  ' + JSON.stringify(p.actions));
    });
    await t.test('心跳没查成（unchecked）→ already 不杀（不许乱杀）', () => {
      const p = plan({ watchdog: { state: 'unchecked' }, flow: { state: 'ok', ts: now - 1000 } });
      const w = p.actions.find((a) => a.name === 'watchdog');
      assert.ok(w.action === 'already' && w.heartbeat.state === 'unchecked', 'unchecked  →  ' + JSON.stringify(w));
    });
    await t.test('不传 heartbeats（老调用方）→ unchecked 不杀', () => {
      const p = K.planKeepalive({ listed: { ok: true, processes: procs }, scripts, now });
      assert.ok(p.ok && p.actions.every((a) => a.action === 'already'), 'compat  →  ' + JSON.stringify(p.actions));
    });
    await t.test('进程不在仍 start（心跳判据只在进程在时生效）', () => {
      const p = K.planKeepalive({
        listed: { ok: true, processes: [] }, scripts, now,
        heartbeats: { watchdog: { state: 'ok', ts: now - 3600_000 }, flow: { state: 'missing' } },
      });
      assert.ok(p.actions.every((a) => a.action === 'start'), 'start  →  ' + JSON.stringify(p.actions));
    });
  });

  it('#699 apply：restart 先杀后拉；杀不掉不拉（防双重守卫）', async (t) => {
    const K = await LIB_LOAD;
    await t.test('先 kill 两个 pid 再 start，结果 restarted', () => {
      const calls = [];
      const applied = K.applyKeepalivePlan({
        ok: true,
        actions: [{ name: 'watchdog', action: 'restart', killPids: [9, 10], script: 'W', cwd: 'C', extraArgs: [], reason: 'heartbeat-stale' }],
      }, {
        execPath: 'node', logDir: null,
        kill: (pid) => { calls.push(['kill', pid]); return { ok: true, pid }; },
        start: (opts) => { calls.push(['start', opts.script]); return { pid: 99, method: 'detached' }; },
      });
      const r = applied.results[0];
      assert.ok(applied.ok && r.action === 'restarted' && r.pid === 99 && r.killed.join() === '9,10'
        && JSON.stringify(calls) === JSON.stringify([['kill', 9], ['kill', 10], ['start', 'W']]),
        'restarted  →  ' + JSON.stringify({ r, calls }));
    });
    await t.test('杀失败 → restart-failed 且不 start', () => {
      const calls = [];
      const applied = K.applyKeepalivePlan({
        ok: true,
        actions: [{ name: 'watchdog', action: 'restart', killPids: [9], script: 'W', cwd: 'C', extraArgs: [], reason: 'heartbeat-stale' }],
      }, {
        execPath: 'node', logDir: null,
        kill: (pid) => { calls.push(['kill', pid]); return { ok: false, pid, error: 'denied' }; },
        start: (opts) => { calls.push(['start', opts.script]); return { pid: 99 }; },
      });
      const r = applied.results[0];
      assert.ok(applied.ok === false && r.action === 'restart-failed' && calls.length === 1 && calls[0][0] === 'kill',
        'restart-failed  →  ' + JSON.stringify({ r, calls }));
    });
    await t.test('already 带心跳状态进结果（日志可观测）', () => {
      const applied = K.applyKeepalivePlan({
        ok: true,
        actions: [{ name: 'flow', action: 'already', pid: 8, heartbeat: { state: 'fresh', ageMs: 1000 } }],
      }, { execPath: 'node', logDir: null, start: () => ({ pid: 1 }), kill: () => ({ ok: true }) });
      assert.ok(applied.results[0].heartbeat && applied.results[0].heartbeat.state === 'fresh', 'hb  →  ' + JSON.stringify(applied.results[0]));
    });
  });

  it('#699 onceResultBits：restarted 算拉起（话面显形），restart-failed 算失败', async (t) => {
    const K = await LIB_LOAD;
    const bits = K.onceResultBits({
      ok: true,
      results: [
        { name: 'watchdog', action: 'restarted', pid: 42, killed: [9], reason: 'heartbeat-stale' },
        { name: 'flow', action: 'already', pid: 8 },
      ],
    });
    await t.test('restarted 进 started', () => {
      assert.ok(bits.started.length === 1 && bits.failed.length === 0
        && bits.all.join(',') === 'watchdog=restarted(42),flow=already(8)', 'bits  →  ' + JSON.stringify(bits));
    });
    const bad = K.onceResultBits({ results: [{ name: 'watchdog', action: 'restart-failed', error: 'x' }] });
    await t.test('restart-failed 进 failed', () => {
      assert.ok(bad.failed.length === 1 && bad.started.length === 0, 'bad  →  ' + JSON.stringify(bad));
    });
  });
});
