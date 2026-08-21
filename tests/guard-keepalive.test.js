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
    const loop = K.buildKeepaliveLoopCmd({ onceCmdPath: 'C:\\\\u\\\\.dao\\\\guard\\\\keepalive.cmd', intervalSec: 120 });
    await t.test('拒绝访问时的循环调 keepalive.cmd，不是第二只狗', () => {
      assert.ok(/call ".*keepalive\.cmd"/.test(loop) && /timeout \/t 120/.test(loop) && /goto loop/.test(loop),
        'loop  →  ' + loop);
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
});
