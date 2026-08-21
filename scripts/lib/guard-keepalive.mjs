// OS 保活计划（#652 / #683）。
//
// 改这段前必须知道：活性终点是 Windows 计划任务，不是再加一层 AI。
// 本脚本每 2 分钟跑一次：查 watchdog.mjs / flow.mjs 进程在不在，不在则从
// ~/.dao/guard-mirror 拉起。进程列表没查成 ≠ 0 个，不许乱拉起。
// 不认 chrome-devtools / CodeGraph 那些名字里带 watchdog 的别的进程。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultMirrorPath } from './guard-mirror.mjs';

export const TASK_NAME = 'dao-guard-keepalive';
export const INTERVAL_MIN = 2;
export const CMD_NAME = 'keepalive.cmd';
export const LOOP_CMD_NAME = 'keepalive-loop.cmd';
export const STARTUP_CMD_NAME = 'dao-guard-keepalive.cmd';
export const INSTALL_NAME = 'install.json';
export const LOG_NAME = 'keepalive.jsonl';

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

/** schtasks 被拒时的非 AI 定时器：用户启动文件夹里的死循环，每 intervalSec 调一次 --once。 */
export function buildKeepaliveLoopCmd({ onceCmdPath, intervalSec = INTERVAL_MIN * 60 }) {
  const sec = Number(intervalSec);
  const n = Number.isFinite(sec) && sec >= 5 ? Math.floor(sec) : INTERVAL_MIN * 60;
  return [
    '@echo off',
    'rem Generated loop fallback when schtasks is Access Denied. Not a second watchdog.',
    ':loop',
    `timeout /t ${n} /nobreak >nul`,
    `call "${onceCmdPath}"`,
    'goto loop',
    '',
  ].join('\r\n');
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
