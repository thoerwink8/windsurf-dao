// #683 OS 保活：认 watchdog.mjs / flow.mjs；列表没查成不许当 0；安装计划可打印。
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

  it('安装计划：任务名、2 分钟、cmd 优先镜像', async (t) => {
    const K = await LIB_LOAD;
    const cmd = K.buildKeepaliveCmd({
      nodePath: 'C:\\\\nvm4w\\\\nodejs\\\\node.exe',
      mirrorScript: 'C:\\\\Users\\\\u\\\\.dao\\\\guard-mirror\\\\scripts\\\\guard-keepalive.mjs',
      hereScript: 'C:\\\\wt\\\\scripts\\\\guard-keepalive.mjs',
      mainScript: 'D:\\\\frank\\\\windsurf-dao\\\\scripts\\\\guard-keepalive.mjs',
    });
    await t.test('cmd 先 if exist MIRROR', () => {
      assert.ok(/set "MIRROR=/.test(cmd) && /if exist "%MIRROR%"/.test(cmd) && /--once/.test(cmd), 'cmd  →  ' + cmd);
    });
    const args = K.buildSchtasksArgs({ cmdPath: 'C:\\\\Users\\\\u\\\\.dao\\\\guard\\\\keepalive.cmd' });
    await t.test('schtasks 每 2 分钟 /F', () => {
      assert.ok(args.includes('dao-guard-keepalive') && args.includes('MINUTE') && args.includes('2') && args.includes('/F'),
        'args  →  ' + args.join(' '));
    });
    const boot = K.buildLoopBootMjs({
      hereScript: 'C:\\wt\\scripts\\guard-keepalive.mjs',
      mirrorScript: 'C:\\Users\\u\\.dao\\guard-mirror\\scripts\\guard-keepalive.mjs',
      mainScript: 'D:\\frank\\windsurf-dao\\scripts\\guard-keepalive.mjs',
    });
    await t.test('ASCII 启动器按 HERE → mirror → main 找 CLI', () => {
      assert.ok(/candidates/.test(boot) && boot.includes('guard-keepalive.mjs') && /await import/.test(boot),
        'boot  →  ' + boot.slice(0, 500));
    });
    const resident = K.buildLoopResidentMjs({
      nodePath: 'C:\\nvm4w\\nodejs\\node.exe',
      cliPath: 'C:\\wt\\scripts\\guard-keepalive.mjs',
    });
    await t.test('常驻循环用 Atomics.wait 阻塞，不靠 timeout /t', () => {
      assert.ok(/Atomics\.wait/.test(resident) && /--once/.test(resident) && /loop-heartbeat/.test(resident) && !/timeout \/t/.test(resident),
        'resident  →  ' + resident.slice(0, 500));
    });
    const spawn = K.buildLoopSpawnMjs({
      nodePath: 'C:\\nvm4w\\nodejs\\node.exe',
    });
    await t.test('独立 spawn 助手 detached 拉 resident，自己退出', () => {
      assert.ok(/loop-resident\.mjs/.test(spawn) && /wait-resident\.mjs/.test(spawn) && /detached: true/.test(spawn),
        'spawn  →  ' + spawn.slice(0, 500));
    });
    const ps1 = K.buildStartResidentsPs1({
      nodePath: 'C:\\nvm4w\\nodejs\\node.exe',
      dir: 'C:\\Users\\u\\.dao\\guard',
    });
    await t.test('Start-Process Hidden 拉常驻循环，无 timeout /t', () => {
      assert.ok(/Win32_Process/.test(ps1) && /loop-resident\.mjs/.test(ps1) && !/timeout \/t/.test(ps1),
        'ps1  →  ' + ps1);
    });
    const loop = K.buildKeepaliveLoopVbs({
      ps1Path: 'C:\\Users\\u\\.dao\\guard\\start-residents.ps1',
    });
    await t.test('拒绝访问时的循环是隐藏 VBS，不是 timeout 窗口', () => {
      assert.ok(/sh\.Run/.test(loop) && /, 0, False/.test(loop) && /start-residents\.ps1/.test(loop) && !/timeout \/t/.test(loop),
        'vbs  →  ' + loop);
    });
    await t.test('VBS 只跑 ASCII 启动器，不把中文工作树路径塞进 WSH', () => {
      assert.ok(/start-residents\.ps1/.test(loop) && !/ISSUE-/.test(loop),
        'ps1Path  →  ' + loop);
    });
    await t.test('Access Denied / 拒绝访问 都认', () => {
      assert.ok(K.isAccessDenied('ERROR: Access is denied.') && K.isAccessDenied('错误: 拒绝访问。'), 'denied');
    });
  });

  it('--print-install 不注册 schtasks，打印 cmd', async (t) => {
    const r = spawnSync(process.execPath, [CLI, '--print-install'], {
      encoding: 'utf8',
      cwd: path.resolve(__dirname, '..'),
      windowsHide: true,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    await t.test('退出码 0', () => {
      assert.ok(r.status === 0, 'exit  →  ' + `status=${r.status} ${out.slice(0, 200)}`);
    });
    await t.test('含 keepalive.cmd 生成内容和 schtasks', () => {
      assert.ok(/@echo off/.test(out) && /dao-guard-keepalive/.test(out) && /MINUTE/.test(out), '打印  →  ' + out.slice(0, 400));
    });
    await t.test('fallback 打印隐藏 VBS，不含 timeout /t', () => {
      assert.ok(/Win32_Process/.test(out) && /loop-resident\.mjs/.test(out) && /, 0, False/.test(out) && !/timeout \/t/.test(out),
        'vbs 打印  →  ' + out.slice(-500));
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

  it('循环监控：活着 / 死了 / 心跳停 / 宽限 / 没查成', async (t) => {
    const K = await LIB_LOAD;
    const now = Date.parse('2026-08-21T12:00:00.000Z');
    const fresh = { at: '2026-08-21T11:59:00.000Z', pid: 11, kind: 'node-loop' };
    await t.test('进程在且心跳新鲜 → ok', () => {
      const r = K.planLoopMonitor({ pid: 11, pidAlive: true, heartbeat: fresh, now, waiterStartedAt: now - 1000 });
      assert.ok(r.action === 'ok', 'ok  →  ' + JSON.stringify(r));
    });
    await t.test('pid 文件指向死进程 → dead，不算宽限', () => {
      const r = K.planLoopMonitor({
        pid: 11, pidAlive: false, heartbeat: fresh, now, seenPid: 11, waiterStartedAt: now,
      });
      assert.ok(r.action === 'dead' && r.reason === 'pid-gone' && /已死/.test(r.message), 'dead  →  ' + JSON.stringify(r));
    });
    await t.test('进程在但心跳停了 → stale', () => {
      const r = K.planLoopMonitor({
        pid: 11, pidAlive: true,
        heartbeat: { at: '2026-08-21T11:00:00.000Z', pid: 11, kind: 'node-loop' },
        now, staleMs: 6 * 60 * 1000,
      });
      assert.ok(r.action === 'stale' && r.reason === 'heartbeat-stale', 'stale  →  ' + JSON.stringify(r));
    });
    await t.test('刚装、还没 pid → grace', () => {
      const r = K.planLoopMonitor({
        pid: null, pidAlive: false, heartbeat: null, now, waiterStartedAt: now, graceMs: 120000,
      });
      assert.ok(r.action === 'grace' && r.reason === 'waiting-for-loop', 'grace  →  ' + JSON.stringify(r));
    });
    await t.test('宽限过了还没有循环 → dead never-started', () => {
      const r = K.planLoopMonitor({
        pid: null, pidAlive: false, heartbeat: null, now,
        waiterStartedAt: now - 180000, graceMs: 120000,
      });
      assert.ok(r.action === 'dead' && r.reason === 'never-started', 'never  →  ' + JSON.stringify(r));
    });
    const rec = K.loopHaltRecord({ action: 'dead', reason: 'pid-gone', message: 'keepalive 循环进程已死（pid 11）', pid: 11 });
    await t.test('死亡记录 tag 是 keepalive LOOP_DEAD', () => {
      assert.ok(rec.tag === '[keepalive] LOOP_DEAD' && rec.rev.state === 'dead' && rec.rev.reason === 'pid-gone',
        'record  →  ' + JSON.stringify(rec));
    });
  });

  it('心跳文件：缺文件是 0 不是没查成；坏 JSON 是没查成', async (t) => {
    const K = await LIB_LOAD;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-hb-'));
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
    const missing = K.readLoopHeartbeat(dir);
    await t.test('缺文件 scanned ok + missing', () => {
      assert.ok(missing.ok && missing.missing && missing.heartbeat == null, '缺  →  ' + JSON.stringify(missing));
    });
    K.writeLoopHeartbeat(dir, { pid: 7, kind: 'node-loop', at: '2026-08-21T00:00:00.000Z' });
    const got = K.readLoopHeartbeat(dir);
    await t.test('写回读到 pid', () => {
      assert.ok(got.ok && got.heartbeat.pid === 7 && got.heartbeat.kind === 'node-loop', '读  →  ' + JSON.stringify(got));
    });
    fs.writeFileSync(path.join(dir, K.LOOP_HEARTBEAT_NAME), 'nope\n', 'utf8');
    const bad = K.readLoopHeartbeat(dir);
    await t.test('坏 JSON 没查成', () => {
      assert.ok(bad.ok === false && /没查成/.test(bad.error), '坏  →  ' + JSON.stringify(bad));
    });
  });

  it('--check-loop 杀循环样本：死 pid → 写 halt.jsonl', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-check-'));
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
    fs.writeFileSync(path.join(dir, 'loop.pid'), '999999999\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'loop-heartbeat.json'), JSON.stringify({
      at: '2020-01-01T00:00:00.000Z', pid: 999999999, kind: 'node-loop',
    }), 'utf8');
    const r = spawnSync(process.execPath, [CLI, '--check-loop'], {
      encoding: 'utf8',
      cwd: path.resolve(__dirname, '..'),
      windowsHide: true,
      env: {
        ...process.env,
        DAO_GUARD_HALT_DIR: dir,
        DAO_GUARD_SKIP_HALT_REPORT: '1',
        DAO_GUARD_LOOP_GRACE_MS: '0',
      },
    });
    const out = String(r.stdout || '') + String(r.stderr || '');
    await t.test('退出码 2', () => {
      assert.ok(r.status === 2, 'exit  →  ' + `status=${r.status} ${out.slice(0, 400)}`);
    });
    const haltPath = path.join(dir, 'halt.jsonl');
    await t.test('halt.jsonl 留下 LOOP_DEAD', () => {
      assert.ok(fs.existsSync(haltPath), 'halt 存在  →  ' + haltPath);
      const line = fs.readFileSync(haltPath, 'utf8');
      assert.ok(/LOOP_DEAD/.test(line) && /pid-gone/.test(line), 'halt  →  ' + line);
    });
    await t.test('stdout 含 decision dead', () => {
      assert.ok(/"action":"dead"/.test(out) || /"action": "dead"/.test(out), 'stdout  →  ' + out.slice(0, 500));
    });
  });
});
