// OS 保活计划（#652 / #683 / #693）。
//
// 改这段前必须知道：活性终点是 Windows 计划任务，不是再加一层 AI。
// 本脚本每 2 分钟跑一次：查 watchdog.mjs / flow.mjs 进程在不在，不在则从
// ~/.dao/guard-mirror 拉起。进程列表没查成 ≠ 0 个，不许乱拉起。
// 不认 chrome-devtools / CodeGraph 那些名字里带 watchdog 的别的进程。
// schtasks 被拒时的 fallback 是隐藏的 node 常驻循环（#693），不是 cmd timeout
// 窗口；循环死由同单元的 --loop-wait 写 halt.jsonl + 报 GitHub，不造第三只狗。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultMirrorPath } from './guard-mirror.mjs';

export const TASK_NAME = 'dao-guard-keepalive';
export const INTERVAL_MIN = 2;
export const CMD_NAME = 'keepalive.cmd';
export const LOOP_CMD_NAME = 'keepalive-loop.cmd';
export const LOOP_VBS_NAME = 'keepalive-loop.vbs';
export const LOOP_PS1_NAME = 'start-residents.ps1';
export const LOOP_BOOT_NAME = 'loop-boot.mjs';
export const LOOP_SPAWN_NAME = 'loop-spawn.mjs';
export const LOOP_RESIDENT_NAME = 'loop-resident.mjs';
export const WAIT_RESIDENT_NAME = 'wait-resident.mjs';
export const STARTUP_CMD_NAME = 'dao-guard-keepalive.cmd';
export const STARTUP_VBS_NAME = 'dao-guard-keepalive.vbs';
export const LOOP_PID_NAME = 'loop.pid';
export const WAIT_PID_NAME = 'loop-wait.pid';
export const LOOP_HEARTBEAT_NAME = 'loop-heartbeat.json';
export const INSTALL_NAME = 'install.json';
export const LOG_NAME = 'keepalive.jsonl';
export const HEARTBEAT_STALE_MS = INTERVAL_MIN * 60 * 1000 * 3;
export const MONITOR_GRACE_MS = 120 * 1000;

export function defaultGuardDir({ env = process.env, homedir: home = homedir() } = {}) {
  if (env.DAO_GUARD_HALT_DIR) return env.DAO_GUARD_HALT_DIR;
  return join(home, '.dao', 'guard');
}

export function classifyCommandLine(cmd) {
  const s = String(cmd || '');
  if (!s) return null;
  // watchdog.mjs 不能当 watchdog-report.mjs 的前缀命中（后面必须是空白/"/结尾）。
  if (/(?:^|[\\/\s"])watchdog\.mjs(?:[\s"]|$)/i.test(s)) return 'watchdog';
  if (/(?:^|[\\/\s"])flow\.mjs(?:[\s"]|$)/i.test(s)) return 'flow';
  return null;
}

export function findRunningGuards(processes) {
  const found = { watchdog: [], flow: [] };
  for (const p of processes || []) {
    const kind = classifyCommandLine(p.commandLine);
    if (kind) found[kind].push({ pid: p.pid, commandLine: p.commandLine });
  }
  return found;
}

export function parseProcessJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: true, processes: [] };
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    return { ok: false, error: `进程列表不是 JSON：${e.message}——没查成，不是 0 个`, processes: [] };
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const processes = [];
  for (const p of arr) {
    if (!p) continue;
    const pid = Number(p.ProcessId ?? p.pid);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    processes.push({ pid, commandLine: String(p.CommandLine ?? p.commandLine ?? '') });
  }
  return { ok: true, processes };
}

export function listNodeProcesses({ spawn = spawnSync } = {}) {
  const r = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'watchdog\\.mjs|flow\\.mjs' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return {
      ok: false,
      error: String(r.error?.message || r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 240),
      processes: [],
    };
  }
  return parseProcessJson(r.stdout);
}

export function parseWorktreePorcelain(text) {
  const src = String(text || '');
  const m = src.match(/^worktree (.+)$/m);
  return m ? m[1].trim() : null;
}

function defaultGit(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return { ok: false, error: String(r.error?.message || r.stderr || r.stdout || `git exit ${r.status}`).trim() };
  }
  return { ok: true, out: String(r.stdout || '').trim() };
}

export function resolveMainPath({
  env = process.env,
  exists = existsSync,
  git = defaultGit,
  install,
} = {}) {
  if (env.DAO_GUARD_MAIN && exists(env.DAO_GUARD_MAIN)) return env.DAO_GUARD_MAIN;
  if (install?.mainPath && exists(install.mainPath)) return install.mainPath;
  const listed = git(['worktree', 'list', '--porcelain']);
  if (listed.ok) {
    const p = parseWorktreePorcelain(listed.out);
    if (p && exists(p)) return p;
  }
  return null;
}

export function resolveGuardScripts({
  mirrorPath,
  repoRoot,
  mainPath,
  exists = existsSync,
} = {}) {
  const pick = (name) => {
    const mirror = mirrorPath ? join(mirrorPath, 'scripts', name) : '';
    const local = repoRoot ? join(repoRoot, 'scripts', name) : '';
    if (mirror && exists(mirror)) {
      return { script: mirror, cwd: mirrorPath, exists: true };
    }
    if (local && exists(local)) {
      return { script: local, cwd: repoRoot, exists: true };
    }
    return { script: mirror || local, cwd: mirrorPath || repoRoot, exists: false };
  };
  const watchdog = pick('watchdog.mjs');
  const flow = pick('flow.mjs');
  if (watchdog.exists && mainPath) {
    watchdog.extraArgs = ['--heartbeat-file', join(mainPath, '_flow', 'heartbeat.json')];
  } else {
    watchdog.extraArgs = [];
  }
  if (flow.exists && mainPath) {
    flow.extraArgs = ['--state-file', join(mainPath, '_flow', 'state.json')];
  } else {
    flow.extraArgs = [];
  }
  return { watchdog, flow };
}

export function planKeepalive({ listed, scripts }) {
  if (!listed || listed.ok !== true) {
    return {
      ok: false,
      error: `进程列表没查成：${listed?.error || '未知'}——没查成不许当 0 个、不许乱拉起`,
      actions: [],
    };
  }
  const running = findRunningGuards(listed.processes);
  const actions = [];
  for (const name of ['watchdog', 'flow']) {
    const live = running[name] || [];
    if (live.length > 0) {
      actions.push({ name, action: 'already', pid: live[0].pid });
      continue;
    }
    const spec = scripts && scripts[name];
    if (!spec || !spec.exists) {
      actions.push({ name, action: 'missing-script', error: `${name} 脚本不在（镜像和本仓都没有）` });
      continue;
    }
    actions.push({
      name,
      action: 'start',
      script: spec.script,
      cwd: spec.cwd,
      extraArgs: spec.extraArgs || [],
    });
  }
  return { ok: true, actions, running };
}

/**
 * keepalive --once 会立刻退出。子进程若共用父进程的文件 stdio，父进程关句柄孩子就死。
 * detached + stdio ignore + unref + windowsHide：本机实测父进程 exit 后仍活。
 */
export function startDetached({
  execPath,
  script,
  extraArgs = [],
  cwd,
  spawnFn = spawn,
} = {}) {
  const child = spawnFn(execPath, [script, ...(extraArgs || [])], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  if (child && typeof child.unref === 'function') child.unref();
  if (!child || !child.pid) return { error: 'spawn 没给出 pid', method: 'detached' };
  return { pid: child.pid, method: 'detached' };
}

export function applyKeepalivePlan(plan, {
  execPath = process.execPath,
  logDir,
  start = startDetached,
  now = () => new Date().toISOString(),
} = {}) {
  if (!plan || plan.ok !== true) {
    return { ok: false, error: plan?.error || '没有计划', at: now(), results: [] };
  }
  const results = [];
  for (const a of plan.actions) {
    if (a.action === 'already') {
      results.push({ name: a.name, action: 'already', pid: a.pid });
      continue;
    }
    if (a.action === 'missing-script') {
      results.push({ name: a.name, action: 'missing-script', error: a.error });
      continue;
    }
    if (a.action !== 'start') {
      results.push({ name: a.name, action: a.action, error: '未知动作' });
      continue;
    }
    const logFile = logDir ? join(logDir, `${a.name}.log`) : null;
    try {
      const started = start({
        execPath,
        script: a.script,
        extraArgs: a.extraArgs,
        cwd: a.cwd,
        logFile,
      });
      if (started && started.error) {
        results.push({ name: a.name, action: 'start-failed', error: started.error, script: a.script });
      } else {
        results.push({ name: a.name, action: 'started', pid: started && started.pid, script: a.script, method: started && started.method });
      }
    } catch (e) {
      results.push({ name: a.name, action: 'start-failed', error: String(e && e.message ? e.message : e).slice(0, 240) });
    }
  }
  const failed = results.filter((r) => r.action === 'start-failed' || r.action === 'missing-script');
  return { ok: failed.length === 0, at: now(), results };
}

export function buildKeepaliveCmd({ nodePath, mirrorScript, hereScript, mainScript }) {
  return [
    '@echo off',
    'rem Generated by scripts/guard-keepalive.mjs --install. Re-run --install to refresh.',
    `set "NODE=${nodePath}"`,
    `set "MIRROR=${mirrorScript}"`,
    `set "HERE=${hereScript}"`,
    `set "MAIN=${mainScript}"`,
    'if exist "%MIRROR%" (',
    '  set "SCRIPT=%MIRROR%"',
    ') else if exist "%HERE%" (',
    '  set "SCRIPT=%HERE%"',
    ') else (',
    '  set "SCRIPT=%MAIN%"',
    ')',
    'if not exist "%SCRIPT%" (',
    '  echo keepalive script missing: %SCRIPT%',
    '  exit /b 2',
    ')',
    '"%NODE%" "%SCRIPT%" --once',
    '',
  ].join('\r\n');
}

/** VBS 字符串里的路径：双引号加倍。 */
export function vbsEscape(path) {
  return String(path || '').replace(/"/g, '""');
}

/**
 * ASCII 启动器：VBS 不能可靠携带中文工作树路径（UTF-8 无 BOM 时 WSH 会读烂，
 * FileExists 失败就静默掉到旧镜像，--loop 成未知参数）。候选路径放进这份 UTF-8
 * JS，由 Node 解析。
 */
export function buildLoopBootMjs({ hereScript, mirrorScript, mainScript }) {
  const lit = (p) => JSON.stringify(String(p || ''));
  return [
    '#!/usr/bin/env node',
    '// Generated by scripts/guard-keepalive.mjs --install. ASCII path launcher.',
    "import { existsSync, writeFileSync, unlinkSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath, pathToFileURL } from 'node:url';",
    `const candidates = [${lit(hereScript)}, ${lit(mirrorScript)}, ${lit(mainScript)}].filter(Boolean);`,
    'const here = dirname(fileURLToPath(import.meta.url));',
    'const errPath = join(here, \'loop-boot.error\');',
    'const script = candidates.find((p) => existsSync(p));',
    'if (!script) {',
    '  const msg = \'keepalive script missing: \' + candidates.join(\' | \');',
    '  try { writeFileSync(errPath, msg, \'utf8\'); } catch {}',
    '  console.error(msg);',
    '  process.exit(2);',
    '}',
    'try {',
    '  try { unlinkSync(errPath); } catch {}',
    '  const mod = await import(pathToFileURL(script).href);',
    '  if (typeof mod.main !== \'function\') throw new Error(\'keepalive main() missing\');',
    '  const ret = mod.main(process.argv.slice(2));',
    '  if (ret && typeof ret.then === \'function\') await ret;',
    '} catch (e) {',
    '  const msg = String(e && e.stack ? e.stack : e);',
    '  try { writeFileSync(errPath, msg, \'utf8\'); } catch {}',
    '  console.error(msg);',
    '  process.exit(2);',
    '}',
    '',
  ].join('\n');
}

function sleepBusy(ms) {
  return `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${Number(ms)});`;
}

/**
 * 本机常驻循环：阻塞 Atomics.wait，不靠事件循环。Win11 隐藏进程空转会被收掉。
 * 每 pulseMs 写心跳，每 intervalMs spawn CLI --once。
 */
export function buildLoopResidentMjs({
  nodePath,
  cliPath,
  intervalMs = INTERVAL_MIN * 60 * 1000,
  pulseMs = 2000,
} = {}) {
  const interval = Number.isFinite(intervalMs) && intervalMs >= 5000 ? Math.floor(intervalMs) : INTERVAL_MIN * 60 * 1000;
  const pulse = Number.isFinite(pulseMs) && pulseMs >= 500 ? Math.floor(pulseMs) : 2000;
  return [
    '#!/usr/bin/env node',
    '// Generated by scripts/guard-keepalive.mjs --install. Blocking resident loop.',
    "import { spawnSync } from 'node:child_process';",
    "import { writeFileSync, mkdirSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    'const dir = dirname(fileURLToPath(import.meta.url));',
    'mkdirSync(dir, { recursive: true });',
    `const cli = ${JSON.stringify(String(cliPath || ''))};`,
    `const node = ${JSON.stringify(String(nodePath || ''))};`,
    'writeFileSync(join(dir, \'loop.pid\'), String(process.pid));',
    'function pulse() {',
    '  writeFileSync(join(dir, \'loop-heartbeat.json\'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, kind: \'node-loop\' }));',
    '}',
    'pulse();',
    'let lastOnce = 0;',
    'for (;;) {',
    '  pulse();',
    '  const now = Date.now();',
    `  if (now - lastOnce >= ${interval}) {`,
    '    lastOnce = now;',
    `    spawnSync(node, [cli, '--once'], { cwd: dir, windowsHide: true, timeout: 60000, encoding: 'utf8' });`,
    '  }',
    `  ${sleepBusy(pulse)}`,
    '}',
    '',
  ].join('\n');
}

/** 循环死亡检测：每 tick 调 CLI --check-loop，死了就退出（报警在 --check-loop 里）。 */
export function buildWaitResidentMjs({ nodePath, cliPath, tickMs = 2000 } = {}) {
  const tick = Number.isFinite(tickMs) && tickMs >= 200 ? Math.floor(tickMs) : 2000;
  return [
    '#!/usr/bin/env node',
    '// Generated by scripts/guard-keepalive.mjs --install. Blocking loop-death waiter.',
    "import { spawnSync } from 'node:child_process';",
    "import { writeFileSync, mkdirSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    'const dir = dirname(fileURLToPath(import.meta.url));',
    'mkdirSync(dir, { recursive: true });',
    `const cli = ${JSON.stringify(String(cliPath || ''))};`,
    `const node = ${JSON.stringify(String(nodePath || ''))};`,
    'writeFileSync(join(dir, \'loop-wait.pid\'), String(process.pid));',
    'for (;;) {',
    `  const r = spawnSync(node, [cli, '--check-loop'], { cwd: dir, windowsHide: true, timeout: 30000, encoding: 'utf8' });`,
    '  if (r.status === 2) process.exit(0);',
    `  ${sleepBusy(tick)}`,
    '}',
    '',
  ].join('\n');
}

/**
 * 独立拉起常驻脚本。一次只拉一个（--wait 拉 waiter），父进程立刻退出。
 */
export function buildLoopSpawnMjs({ nodePath } = {}) {
  return [
    '#!/usr/bin/env node',
    '// Generated by scripts/guard-keepalive.mjs --install. Spawns one resident then exits.',
    "import { spawn } from 'node:child_process';",
    "import { openSync, closeSync, mkdirSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    'const dir = dirname(fileURLToPath(import.meta.url));',
    'mkdirSync(dir, { recursive: true });',
    `const node = ${JSON.stringify(String(nodePath || ''))};`,
    `const resident = process.argv[2] === '--wait' ? ${JSON.stringify(WAIT_RESIDENT_NAME)} : ${JSON.stringify(LOOP_RESIDENT_NAME)};`,
    'const stem = process.argv[2] === \'--wait\' ? \'keepalive-wait\' : \'keepalive-loop\';',
    'const target = join(dir, resident);',
    'const out = openSync(join(dir, stem + \'.log\'), \'a\');',
    'const err = openSync(join(dir, stem + \'.log.err\'), \'a\');',
    'const child = spawn(node, [target], {',
    '  cwd: dir,',
    '  detached: true,',
    '  stdio: [\'ignore\', out, err],',
    '  windowsHide: true,',
    '  env: process.env,',
    '});',
    'if (child && typeof child.unref === \'function\') child.unref();',
    'try { closeSync(out); } catch {}',
    'try { closeSync(err); } catch {}',
    'console.log(JSON.stringify({ ok: true, resident, pid: child && child.pid }));',
    'process.exit(0);',
    '',
  ].join('\n');
}

/**
 * 登录启动项：VBS 只点 ASCII 的 loop-spawn.mjs。不要 timeout /t。
 */
export function buildStartResidentsPs1({ nodePath, dir }) {
  const q = (p) => `'${String(p).replace(/'/g, "''")}'`;
  const start = (script) => {
    const cmd = `"${String(nodePath)}" "${script}"`;
    return `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(cmd)}; CurrentDirectory = ${q(dir)} } | Out-Null`;
  };
  return [
    '# Generated by scripts/guard-keepalive.mjs --install. Hidden Start-Process.',
    start(join(dir, LOOP_RESIDENT_NAME)),
    start(join(dir, WAIT_RESIDENT_NAME)),
    '',
  ].join('\r\n');
}

export function buildKeepaliveLoopVbs({ ps1Path }) {
  const ps1 = vbsEscape(ps1Path);
  return [
    "' Generated by scripts/guard-keepalive.mjs --install. Hidden start (Run 0).",
    "' Not a second watchdog. Re-run --install to refresh.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File ""${ps1}""", 0, False`,
    '',
  ].join('\r\n');
}

export function writeLoopHeartbeat(dir, payload = {}, {
  mkdir = mkdirSync,
  write = writeFileSync,
  now = () => new Date().toISOString(),
} = {}) {
  mkdir(dir, { recursive: true });
  const rec = {
    at: payload.at || now(),
    pid: payload.pid,
    kind: payload.kind || 'node-loop',
  };
  write(join(dir, LOOP_HEARTBEAT_NAME), JSON.stringify(rec), 'utf8');
  return rec;
}

export function readLoopHeartbeat(dir, { read = readFileSync, exists = existsSync } = {}) {
  const p = join(dir, LOOP_HEARTBEAT_NAME);
  if (!exists(p)) return { ok: true, missing: true, heartbeat: null };
  let parsed;
  try { parsed = JSON.parse(read(p, 'utf8')); }
  catch (e) {
    return { ok: false, error: `循环心跳不是 JSON：${e.message}——没查成`, heartbeat: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '循环心跳不是对象——没查成', heartbeat: null };
  }
  return { ok: true, heartbeat: parsed };
}

export function readPidFile(path, { read = readFileSync, exists = existsSync } = {}) {
  if (!exists(path)) return { ok: true, missing: true, pid: null };
  const n = Number(String(read(path, 'utf8') || '').trim());
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: 'pid 文件不是正整数——没查成', pid: null };
  }
  return { ok: true, pid: n };
}

/**
 * 循环活性：进程在且心跳新鲜 → ok；pid 在但心跳停 → stale；
 * 曾经出现过的 pid 没了 → dead。心跳没查成 → unscanned（不许当死）。
 * 宽限只覆盖「刚装、循环还没写出 pid」——pid 文件指向死进程不算宽限。
 */
export function planLoopMonitor({
  pid = null,
  pidAlive: alive = false,
  heartbeat = null,
  now = Date.now(),
  seenPid = null,
  waiterStartedAt = now,
  graceMs = MONITOR_GRACE_MS,
  staleMs = HEARTBEAT_STALE_MS,
} = {}) {
  const hbAt = heartbeat && heartbeat.at ? Date.parse(heartbeat.at) : NaN;
  const hasHb = Number.isFinite(hbAt);
  const age = hasHb ? now - hbAt : null;

  if (alive && pid) {
    if (!hasHb) {
      const waited = now - waiterStartedAt;
      if (waited < graceMs) return { action: 'grace', reason: 'pid-live-no-heartbeat' };
      return {
        action: 'stale',
        reason: 'no-heartbeat',
        message: `keepalive 循环进程在但从未写心跳（pid ${pid}）`,
      };
    }
    if (age > staleMs) {
      return {
        action: 'stale',
        reason: 'heartbeat-stale',
        message: `keepalive 循环心跳停了 ${Math.round(age / 1000)}s（pid ${pid}）`,
      };
    }
    return { action: 'ok', reason: 'alive' };
  }

  const known = seenPid || pid || (heartbeat && heartbeat.pid);
  if (known) {
    return {
      action: 'dead',
      reason: 'pid-gone',
      message: `keepalive 循环进程已死（pid ${pid || seenPid || heartbeat.pid || '?'}）`,
    };
  }

  const waited = now - waiterStartedAt;
  if (waited < graceMs) return { action: 'grace', reason: 'waiting-for-loop' };
  return {
    action: 'dead',
    reason: 'never-started',
    message: 'keepalive 循环在宽限后仍未出现',
  };
}

export function loopHaltRecord({ action, reason, message, pid } = {}) {
  const stale = action === 'stale';
  return {
    tag: stale ? '[keepalive] LOOP_STALE' : '[keepalive] LOOP_DEAD',
    message: message || (stale ? 'keepalive 循环心跳停了' : 'keepalive 循环进程已死'),
    pid: pid || null,
    rev: { state: stale ? 'stale' : 'dead', reason: reason || 'unknown' },
  };
}

export function defaultStartupDir({ env = process.env } = {}) {
  const appdata = env.APPDATA;
  if (!appdata) return null;
  return join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function isAccessDenied(text) {
  const s = String(text || '');
  return /Access is denied/i.test(s) || /拒绝访问/.test(s) || /ERROR:\s*Access/i.test(s);
}

export function buildSchtasksArgs({
  taskName = TASK_NAME,
  intervalMin = INTERVAL_MIN,
  cmdPath,
} = {}) {
  return [
    '/Create', '/TN', taskName,
    '/SC', 'MINUTE', '/MO', String(intervalMin),
    '/F', '/RL', 'LIMITED',
    '/TR', cmdPath,
  ];
}

export function readInstall({ dir, read = readFileSync, exists = existsSync } = {}) {
  const p = join(dir, INSTALL_NAME);
  if (!exists(p)) return null;
  try { return JSON.parse(read(p, 'utf8')); }
  catch { return null; }
}

export function writeInstallFiles({
  dir,
  nodePath,
  mirrorScript,
  hereScript,
  mainScript,
  mainPath,
  cmdText,
  mkdir = mkdirSync,
  write = writeFileSync,
  now = () => new Date().toISOString(),
} = {}) {
  mkdir(dir, { recursive: true });
  const cmdPath = join(dir, CMD_NAME);
  write(cmdPath, cmdText, 'utf8');
  const meta = {
    taskName: TASK_NAME,
    intervalMin: INTERVAL_MIN,
    nodePath,
    mainPath,
    hereScript,
    mainScript,
    mirrorScript,
    cmdPath,
    installedAt: now(),
  };
  write(join(dir, INSTALL_NAME), JSON.stringify(meta, null, 2), 'utf8');
  return { cmdPath, meta };
}

export function appendKeepaliveLog(dir, payload, {
  mkdir = mkdirSync,
  append = appendFileSync,
} = {}) {
  mkdir(dir, { recursive: true });
  append(join(dir, LOG_NAME), `${JSON.stringify(payload)}\n`, 'utf8');
}

export { defaultMirrorPath, dirname };
