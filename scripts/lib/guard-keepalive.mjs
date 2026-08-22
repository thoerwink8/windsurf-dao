// 守卫保活计划（#652 / #683 计划任务版 → #693 起改「帥位触发」→ #699 补心跳停更判定）。
//
// 改这段前必须知道：活性终点不再是 Windows 计划任务，也不是任何自研循环——
// 是随仓 .claude/settings.json 的 SessionStart hook（主树会话启动时；2026-08-22 起
// 不再要求 master，拉起闸在 guard-seat.mjs 的 guardLaunchGate）与
// board-hook（UserPromptSubmit，每轮兜底）调本库的 --once。不要再造 OS 级定时器。
// --once 查 watchdog.mjs / flow.mjs 进程在不在，不在则从 ~/.dao/guard-mirror 拉起；
// 进程在但心跳停更超阈值 = 「活但卡死」（#699 实证卡死一个多小时零信号），杀掉再拉起。
// 进程列表没查成 ≠ 0 个，不许乱拉起；心跳没查成（不知道读哪）不许乱杀。
// 不认 chrome-devtools / CodeGraph 那些名字里带 watchdog 的别的进程。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultMirrorPath } from './guard-mirror.mjs';

export const LOG_NAME = 'keepalive.jsonl';

// ── 心跳新鲜度（#699）──────────────────────────────────────────────
// 判据锚在「该发生的事有没有发生」：watchdog 每 30s 一轮（每轮开头写自身心跳）、
// flow 每 300s 一轮（启动即写 + 每轮结尾写 _flow/heartbeat.json）。
// 进程在而心跳停更超阈值 = 事件循环/写盘卡死——进程名看不出，只有心跳看得出。
//
// 阈值依据（改阈值先改这段注释，防漂移）：
//   watchdog 5 min = 10× 心跳周期（30s）。2×=60s 太紧：单轮对每个工位 read +
//     多次 gh/orca 调用（各自 15-30s 超时），忙时一轮可超分钟级，正常抖动会被误杀。
//     事故实证是 60+ 分钟没被发现，5 分钟把发现延迟压到 1/12。
//   flow 10 min = 2× 心跳周期（300s，issue #699 建议值）。gh 全挂时轮次提前
//     abort 并写 emptyHeartbeat，不会停更；慢轮次余量足够。
export const WATCHDOG_HEARTBEAT_NAME = 'watchdog-heartbeat.json';
export const WATCHDOG_HEARTBEAT_STALE_MS = 5 * 60 * 1000;
export const FLOW_HEARTBEAT_STALE_MS = 10 * 60 * 1000;

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
    if (kind) found[kind].push({ pid: p.pid, commandLine: p.commandLine, startedMs: p.startedMs ?? null });
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
    // StartedMs（WMI CreationDate 转的 unix ms）：#699 启动宽限用——活了不到一个
    // 阈值窗口的进程不杀（刚拉起还没写第一次心跳 / 版本闸换血窗口）。没有则为 null。
    const started = Number(p.StartedMs ?? p.startedMs);
    processes.push({
      pid,
      commandLine: String(p.CommandLine ?? p.commandLine ?? ''),
      startedMs: Number.isFinite(started) && started > 0 ? started : null,
    });
  }
  return { ok: true, processes };
}

export function listNodeProcesses({ spawn = spawnSync } = {}) {
  const r = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'watchdog\\.mjs|flow\\.mjs' } | Select-Object ProcessId,CommandLine,@{N='StartedMs';E={[DateTimeOffset]::new($_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress",
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
} = {}) {
  if (env.DAO_GUARD_MAIN && exists(env.DAO_GUARD_MAIN)) return env.DAO_GUARD_MAIN;
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

/** watchdog 自身心跳路径：守卫状态目录（~/.dao/guard 或 DAO_GUARD_HALT_DIR）下。 */
export function watchdogHeartbeatPath({ env = process.env, homedir: home = homedir() } = {}) {
  return join(defaultGuardDir({ env, homedir: home }), WATCHDOG_HEARTBEAT_NAME);
}

/** flow 心跳路径：与 keepalive 拉起时给的 --state-file 同目录（主树 _flow）；
 * mainPath 没解出来时，flow 用脚本仓根的 _flow（= 拉起时的 cwd），对齐同一个位置。
 * 两边都不知道 → null（心跳没查成，不许乱杀）。 */
export function flowHeartbeatPath({ mainPath, flowSpec } = {}) {
  if (mainPath) return join(mainPath, '_flow', 'heartbeat.json');
  if (flowSpec && flowSpec.cwd) return join(flowSpec.cwd, '_flow', 'heartbeat.json');
  return null;
}

/** 守卫写心跳用：tmp + rename，读者只见旧版或新版，不见半行（同 flow writeHeartbeat 约定）。 */
export function writeGuardHeartbeat(path, payload, {
  mkdir = mkdirSync,
  write = writeFileSync,
  rename = renameSync,
} = {}) {
  mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  write(tmp, JSON.stringify(payload, null, 2), 'utf8');
  rename(tmp, path);
}

/** 读心跳原始态：unchecked（不知道读哪）/ missing / corrupt / ok（带 ts）。
 * 新鲜/过期不在这里判——判要 now 与阈值，留在 planKeepalive（纯函数可测）。 */
export function readGuardHeartbeat(path, {
  exists = existsSync,
  read = readFileSync,
} = {}) {
  if (!path) return { state: 'unchecked' };
  if (!exists(path)) return { state: 'missing', path };
  let doc;
  try { doc = JSON.parse(read(path, 'utf8')); }
  catch (e) { return { state: 'corrupt', path, error: `心跳文件不是 JSON：${String(e && e.message || e).slice(0, 120)}` }; }
  const ts = Date.parse(doc && doc.ts);
  if (!Number.isFinite(ts)) return { state: 'corrupt', path, error: '心跳文件缺 ts 或 ts 不可解析' };
  return { state: 'ok', path, ts };
}

/** Windows 强杀：taskkill /F /T（带子树——卡死的守卫可能还挂着 gh/orca 子查询）。 */
export function killProcess(pid, { spawn = spawnSync } = {}) {
  const r = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return { ok: false, pid, error: String(r.error?.message || r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 160) };
  }
  return { ok: true, pid };
}

export function planKeepalive({ listed, scripts, heartbeats, now, staleMs }) {
  if (!listed || listed.ok !== true) {
    return {
      ok: false,
      error: `进程列表没查成：${listed?.error || '未知'}——没查成不许当 0 个、不许乱拉起`,
      actions: [],
    };
  }
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const stale = {
    watchdog: Number(staleMs?.watchdog) || WATCHDOG_HEARTBEAT_STALE_MS,
    flow: Number(staleMs?.flow) || FLOW_HEARTBEAT_STALE_MS,
  };
  const running = findRunningGuards(listed.processes);
  const actions = [];
  for (const name of ['watchdog', 'flow']) {
    const live = running[name] || [];
    if (live.length > 0) {
      // #699：进程在不算完，心跳也得在动。缺失/损坏按停更处理——心跳是活性唯一证据，
      // 「文件没了但进程在」与「卡死」在可观测面上不可区分；健康守卫启动即写心跳，
      // 长期没有 = 异常。唯一例外是启动宽限：最年轻进程活了不到一个阈值窗口
      // （刚拉起还没写第一次心跳 / 版本闸换血中），不杀。
      const hb = heartbeats && heartbeats[name] ? heartbeats[name] : { state: 'unchecked' };
      const youngest = live.reduce((m, p) => (Number.isFinite(p.startedMs) && (m == null || p.startedMs > m) ? p.startedMs : m), null);
      const processAgeMs = youngest != null ? at - youngest : null;
      if (hb.state === 'ok') {
        const ageMs = at - hb.ts;
        if (ageMs <= stale[name]) {
          actions.push({ name, action: 'already', pid: live[0].pid, heartbeat: { state: 'fresh', ageMs } });
          continue;
        }
        if (processAgeMs != null && processAgeMs < stale[name]) {
          actions.push({ name, action: 'already', pid: live[0].pid, heartbeat: { state: 'stale', ageMs, grace: true } });
          continue;
        }
        actions.push({
          name, action: 'restart', killPids: live.map((p) => p.pid),
          script: scripts?.[name]?.script, cwd: scripts?.[name]?.cwd, extraArgs: scripts?.[name]?.extraArgs || [],
          reason: 'heartbeat-stale', heartbeat: { state: 'stale', ageMs },
        });
        continue;
      }
      if (hb.state === 'missing' || hb.state === 'corrupt') {
        if (processAgeMs != null && processAgeMs < stale[name]) {
          actions.push({ name, action: 'already', pid: live[0].pid, heartbeat: { state: hb.state, grace: true, error: hb.error || null } });
          continue;
        }
        actions.push({
          name, action: 'restart', killPids: live.map((p) => p.pid),
          script: scripts?.[name]?.script, cwd: scripts?.[name]?.cwd, extraArgs: scripts?.[name]?.extraArgs || [],
          reason: `heartbeat-${hb.state}`, heartbeat: { state: hb.state, error: hb.error || null },
        });
        continue;
      }
      // unchecked：不知道心跳读哪（如主树没解出来）——没查成不杀，也不当查过没事（落日志显形）。
      actions.push({ name, action: 'already', pid: live[0].pid, heartbeat: { state: 'unchecked' } });
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
  kill = killProcess,
  now = () => new Date().toISOString(),
} = {}) {
  if (!plan || plan.ok !== true) {
    return { ok: false, error: plan?.error || '没有计划', at: now(), results: [] };
  }
  const results = [];
  for (const a of plan.actions) {
    if (a.action === 'already') {
      results.push({ name: a.name, action: 'already', pid: a.pid, ...(a.heartbeat ? { heartbeat: a.heartbeat } : {}) });
      continue;
    }
    if (a.action === 'missing-script') {
      results.push({ name: a.name, action: 'missing-script', error: a.error });
      continue;
    }
    if (a.action === 'restart') {
      // #699：先杀后拉。杀不掉就不拉——卡死的还在，再起一个 = 双重守卫双份报警。
      const killed = [];
      const killErrs = [];
      for (const pid of a.killPids || []) {
        try {
          const r = kill(pid);
          if (r && r.ok) killed.push(pid);
          else killErrs.push(`${pid}: ${r?.error || '未知'}`);
        } catch (e) {
          killErrs.push(`${pid}: ${String(e && e.message ? e.message : e).slice(0, 160)}`);
        }
      }
      if (killErrs.length > 0) {
        results.push({
          name: a.name, action: 'restart-failed',
          error: `杀掉卡死进程没成（${killErrs.join('；')}）——没敢拉起新进程防重复`,
          reason: a.reason, heartbeat: a.heartbeat,
        });
        continue;
      }
      try {
        const started = start({
          execPath,
          script: a.script,
          extraArgs: a.extraArgs,
          cwd: a.cwd,
          logFile: logDir ? join(logDir, `${a.name}.log`) : null,
        });
        if (started && started.error) {
          results.push({ name: a.name, action: 'start-failed', error: started.error, script: a.script, killed, reason: a.reason });
        } else {
          results.push({
            name: a.name, action: 'restarted', pid: started && started.pid, script: a.script,
            method: started && started.method, killed, reason: a.reason, heartbeat: a.heartbeat,
          });
        }
      } catch (e) {
        results.push({ name: a.name, action: 'start-failed', error: String(e && e.message ? e.message : e).slice(0, 240), killed, reason: a.reason });
      }
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
  const failed = results.filter((r) => r.action === 'start-failed' || r.action === 'missing-script' || r.action === 'restart-failed');
  return { ok: failed.length === 0, at: now(), results };
}

/** --once 输出 JSON 的读取口：两个 hook（SessionStart / board-hook）共用这一份，别各写各的解析。 */
export function onceResultBits(doc) {
  const results = Array.isArray(doc?.results) ? doc.results : [];
  const bit = (r) => `${r.name}=${r.action}${r.pid ? `(${r.pid})` : ''}`;
  return {
    // restarted 也是「拉起了一个新进程」：hook 话面要显形（卡死重启是事故，不许静默）。
    started: results.filter((r) => r.action === 'started' || r.action === 'restarted'),
    failed: results.filter((r) => r.action === 'start-failed' || r.action === 'missing-script' || r.action === 'restart-failed'),
    all: results.map(bit),
  };
}

export function appendKeepaliveLog(dir, payload, {
  mkdir = mkdirSync,
  append = appendFileSync,
} = {}) {
  mkdir(dir, { recursive: true });
  append(join(dir, LOG_NAME), `${JSON.stringify(payload)}\n`, 'utf8');
}

export { defaultMirrorPath, dirname };
