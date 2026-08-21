#!/usr/bin/env node
// scripts/guard-keepalive.mjs —— Windows 计划任务保活 watchdog + flow（#683 / #693）
//
// 改这段前必须知道：本进程自己不是守卫、不跑检测矩阵。OS 每 2 分钟叫一次
// --once：查进程、缺了从镜像拉起、写 ~/.dao/guard/keepalive.jsonl。
// schtasks 被拒时：VBS 隐藏拉起 --loop（node 常驻，无 timeout 窗口）+ --loop-wait
// （循环死写 halt.jsonl 并报 GitHub）。--loop / --loop-wait 由 VBS 启动，不要手挂。
// 用法：
//   node scripts/guard-keepalive.mjs --once           检查并按需拉起（计划任务默认）
//   node scripts/guard-keepalive.mjs --install        写 keepalive.cmd + 注册 schtasks
//   node scripts/guard-keepalive.mjs --print-install  只打印，不写本机
//   node scripts/guard-keepalive.mjs --status         查任务和进程
//   node scripts/guard-keepalive.mjs --dry-run        只打印计划，不 spawn
//   node scripts/guard-keepalive.mjs --check-loop     单次查循环活性（死则报警）

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notifyGuardHalt } from './lib/guard-halt.mjs';
import {
  TASK_NAME,
  INTERVAL_MIN,
  LOOP_CMD_NAME,
  LOOP_VBS_NAME,
  LOOP_BOOT_NAME,
  LOOP_SPAWN_NAME,
  LOOP_RESIDENT_NAME,
  WAIT_RESIDENT_NAME,
  LOOP_PS1_NAME,
  STARTUP_CMD_NAME,
  STARTUP_VBS_NAME,
  LOOP_PID_NAME,
  WAIT_PID_NAME,
  LOOP_HEARTBEAT_NAME,
  HEARTBEAT_STALE_MS,
  MONITOR_GRACE_MS,
  defaultGuardDir,
  defaultMirrorPath,
  defaultStartupDir,
  listNodeProcesses,
  findRunningGuards,
  resolveMainPath,
  resolveGuardScripts,
  planKeepalive,
  applyKeepalivePlan,
  startDetached,
  buildKeepaliveCmd,
  buildKeepaliveLoopVbs,
  buildStartResidentsPs1,
  buildLoopBootMjs,
  buildLoopSpawnMjs,
  buildLoopResidentMjs,
  buildWaitResidentMjs,
  buildSchtasksArgs,
  writeInstallFiles,
  readInstall,
  appendKeepaliveLog,
  writeLoopHeartbeat,
  readLoopHeartbeat,
  readPidFile,
  planLoopMonitor,
  loopHaltRecord,
} from './lib/guard-keepalive.mjs';

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), '..');

function printUsage() {
  console.log(`用法：
  node scripts/guard-keepalive.mjs [--once] [--dry-run]
  node scripts/guard-keepalive.mjs --install
  node scripts/guard-keepalive.mjs --print-install
  node scripts/guard-keepalive.mjs --status
  node scripts/guard-keepalive.mjs --check-loop

  --once           检查 watchdog/flow，不在则拉起（计划任务默认；也是无旗标默认）
  --dry-run        只打印计划，不 spawn
  --install        写 ~/.dao/guard/keepalive.cmd 并 schtasks /Create（每 ${INTERVAL_MIN} 分钟）
  --print-install  打印 cmd / VBS 与 schtasks 参数，不写本机
  --status         查计划任务 + 当前守卫进程 + 循环心跳
  --check-loop     单次查循环活性；死/停跳则 halt.jsonl + GitHub
  --loop             常驻循环（由 --install / --spawn-residents 拉起，不要手挂）
  --loop-wait        循环死亡检测（同上）
  --spawn-residents  用 detached+windowsHide 拉起 --loop 和 --loop-wait 后退出（登录 VBS 调这个）`);
}

function parseArgs(argv) {
  const args = {
    once: true, install: false, printInstall: false, status: false, dryRun: false,
    help: false, loop: false, loopWait: false, checkLoop: false, spawnResidents: false,
  };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--once') args.once = true;
    else if (a === '--install') args.install = true;
    else if (a === '--print-install') args.printInstall = true;
    else if (a === '--status') args.status = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--loop') args.loop = true;
    else if (a === '--loop-wait') args.loopWait = true;
    else if (a === '--check-loop') args.checkLoop = true;
    else if (a === '--spawn-residents') args.spawnResidents = true;
    else {
      console.error(`未知参数：${a}`);
      process.exit(3);
    }
  }
  return args;
}

function nodePath() {
  return process.execPath;
}

function paths() {
  const home = homedir();
  const dir = defaultGuardDir({ env: process.env, homedir: home });
  const mirrorPath = process.env.DAO_GUARD_MIRROR || defaultMirrorPath(home);
  const install = readInstall({ dir });
  const mainPath = resolveMainPath({ env: process.env, exists: existsSync, install });
  const hereScript = HERE;
  const mainScript = mainPath ? join(mainPath, 'scripts', 'guard-keepalive.mjs') : join(REPO_ROOT, 'scripts', 'guard-keepalive.mjs');
  const mirrorScript = join(mirrorPath, 'scripts', 'guard-keepalive.mjs');
  return { dir, home, mirrorPath, install, mainPath, hereScript, mainScript, mirrorScript };
}

function installPlan() {
  const p = paths();
  const cmdText = buildKeepaliveCmd({
    nodePath: nodePath(),
    mirrorScript: p.mirrorScript,
    hereScript: p.hereScript,
    mainScript: p.mainScript,
  });
  const cmdPath = join(p.dir, 'keepalive.cmd');
  const schtasksArgs = buildSchtasksArgs({
    taskName: TASK_NAME,
    intervalMin: INTERVAL_MIN,
    cmdPath,
  });
  return { ...p, cmdText, cmdPath, schtasksArgs };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function monitorGraceMs() {
  const n = Number(process.env.DAO_GUARD_LOOP_GRACE_MS);
  return Number.isFinite(n) && n >= 0 ? n : MONITOR_GRACE_MS;
}

function monitorStaleMs() {
  const n = Number(process.env.DAO_GUARD_LOOP_STALE_MS);
  return Number.isFinite(n) && n > 0 ? n : HEARTBEAT_STALE_MS;
}

function unlinkQuiet(path) {
  try { if (existsSync(path)) unlinkSync(path); } catch { /* 旧文件删不掉不挡装 */ }
}

function waitForLoopPid(dir, timeoutMs = 5000) {
  const pidFile = join(dir, LOOP_PID_NAME);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const got = readPidFile(pidFile);
    if (got.ok && got.pid && pidAlive(got.pid)) return got.pid;
    spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100)'], { windowsHide: true });
  }
  return null;
}

function residentScript() {
  const p = paths();
  for (const s of [p.hereScript, p.mirrorScript, p.mainScript]) {
    if (s && existsSync(s)) return s;
  }
  return HERE;
}

function startLoopNow() {
  const p = paths();
  const dir = p.dir;
  const script = residentScript();
  const pidFile = join(dir, LOOP_PID_NAME);
  const hb = readLoopHeartbeat(dir);
  if (existsSync(pidFile)) {
    const old = Number(String(readFileSync(pidFile, 'utf8') || '').trim());
    if (Number.isFinite(old) && old > 0 && pidAlive(old)) {
      if (hb.ok && hb.heartbeat && hb.heartbeat.pid === old && hb.heartbeat.kind === 'node-loop') {
        return { action: 'already', pid: old };
      }
      try { process.kill(old); } catch { /* 旧 cmd 循环，杀了再换隐藏 node */ }
    }
  }
  unlinkQuiet(pidFile);
  unlinkQuiet(join(dir, WAIT_PID_NAME));
  unlinkQuiet(join(dir, LOOP_HEARTBEAT_NAME));
  unlinkQuiet(join(dir, 'loop-boot.error'));
  mkdirSync(dir, { recursive: true });
  const spawnPath = join(dir, LOOP_SPAWN_NAME);
  writeFileSync(join(dir, LOOP_RESIDENT_NAME), buildLoopResidentMjs({
    nodePath: nodePath(),
    cliPath: script,
  }), 'utf8');
  writeFileSync(join(dir, WAIT_RESIDENT_NAME), buildWaitResidentMjs({
    nodePath: nodePath(),
    cliPath: script,
  }), 'utf8');
  writeFileSync(spawnPath, buildLoopSpawnMjs({
    nodePath: nodePath(),
  }), 'utf8');
  // node spawn(detached+windowsHide) 几秒内被收掉。
  // Start-Process -WindowStyle Hidden + RedirectStandardOutput 本机实测能活。
  const startHidden = (residentName) => {
    const scriptPath = join(dir, residentName);
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const commandLine = `"${nodePath()}" "${scriptPath}"`;
    const ps = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(commandLine)}; CurrentDirectory = ${q(dir)} }`;
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
  };
  const launchedLoop = startHidden(LOOP_RESIDENT_NAME);
  const launchedWait = startHidden(WAIT_RESIDENT_NAME);
  if (launchedLoop.error || (launchedLoop.status !== 0 && launchedLoop.status != null)) {
    return {
      action: 'start-failed',
      error: String(launchedLoop.error?.message || launchedLoop.stderr || launchedLoop.stdout || `exit ${launchedLoop.status}`).slice(0, 240),
    };
  }
  if (launchedWait.error || (launchedWait.status !== 0 && launchedWait.status != null)) {
    return {
      action: 'start-failed',
      error: String(launchedWait.error?.message || launchedWait.stderr || launchedWait.stdout || `exit ${launchedWait.status}`).slice(0, 240),
    };
  }
  const pid = waitForLoopPid(dir, 8000);
  return { action: 'started', pid, method: 'start-process', script };
}

function cmdSpawnResidents() {
  const r = startLoopNow();
  console.log(JSON.stringify({ ok: Boolean(r.pid), action: 'spawn-residents', ...r }));
  return r.pid ? 0 : 3;
}

function installLoopFallback(plan, written, schtasksError) {
  mkdirSync(plan.dir, { recursive: true });
  const bootPath = join(plan.dir, LOOP_BOOT_NAME);
  const spawnPath = join(plan.dir, LOOP_SPAWN_NAME);
  const vbsPath = join(plan.dir, LOOP_VBS_NAME);
  writeFileSync(bootPath, buildLoopBootMjs({
    hereScript: plan.hereScript,
    mirrorScript: plan.mirrorScript,
    mainScript: plan.mainScript,
  }), 'utf8');
  writeFileSync(join(plan.dir, LOOP_RESIDENT_NAME), buildLoopResidentMjs({
    nodePath: nodePath(),
    cliPath: plan.hereScript,
  }), 'utf8');
  writeFileSync(join(plan.dir, WAIT_RESIDENT_NAME), buildWaitResidentMjs({
    nodePath: nodePath(),
    cliPath: plan.hereScript,
  }), 'utf8');
  writeFileSync(spawnPath, buildLoopSpawnMjs({
    nodePath: nodePath(),
  }), 'utf8');
  const ps1Path = join(plan.dir, LOOP_PS1_NAME);
  writeFileSync(ps1Path, buildStartResidentsPs1({
    nodePath: nodePath(),
    dir: plan.dir,
  }), 'utf8');
  const vbsText = buildKeepaliveLoopVbs({ ps1Path });
  writeFileSync(vbsPath, vbsText, 'utf8');
  unlinkQuiet(join(plan.dir, LOOP_CMD_NAME));
  const startupDir = defaultStartupDir({ env: process.env });
  let startupPath = null;
  if (startupDir && existsSync(startupDir)) {
    startupPath = join(startupDir, STARTUP_VBS_NAME);
    writeFileSync(startupPath, vbsText, 'utf8');
    unlinkQuiet(join(startupDir, STARTUP_CMD_NAME));
  }
  const loop = startLoopNow();
  const ok = Boolean(loop && loop.pid);
  return {
    ok,
    action: 'install',
    method: 'startup-loop',
    taskName: TASK_NAME,
    intervalMin: INTERVAL_MIN,
    cmdPath: written.cmdPath,
    bootPath,
    vbsPath,
    startupPath,
    loop,
    schtasksError,
    mainPath: plan.mainPath,
    error: ok ? undefined : '隐藏循环没起来（5s 内没有活 pid）——不是装成功。看 ~/.dao/guard/loop-boot.error',
    note: 'schtasks 拒绝访问；已写隐藏 VBS 循环并当场拉起（仍是 OS 定时，不是第二只狗）',
  };
}

function cmdInstall(printOnly) {
  const plan = installPlan();
  if (printOnly) {
    process.stdout.write(plan.cmdText);
    console.log(`# schtasks ${plan.schtasksArgs.join(' ')}`);
    const spawnPath = join(plan.dir, LOOP_SPAWN_NAME);
    console.log('# fallback ASCII boot (only if schtasks Access Denied):');
    process.stdout.write(buildLoopBootMjs({
      hereScript: plan.hereScript,
      mirrorScript: plan.mirrorScript,
      mainScript: plan.mainScript,
    }));
    console.log('# fallback spawn helper:');
    process.stdout.write(buildLoopResidentMjs({
      nodePath: nodePath(),
      cliPath: plan.hereScript,
    }));
    console.log('# wait resident:');
    process.stdout.write(buildWaitResidentMjs({
      nodePath: nodePath(),
      cliPath: plan.hereScript,
    }));
    console.log('# spawn helper:');
    process.stdout.write(buildLoopSpawnMjs({
      nodePath: nodePath(),
    }));
    console.log('# start-residents.ps1:');
    process.stdout.write(buildStartResidentsPs1({
      nodePath: nodePath(),
      dir: plan.dir,
    }));
    console.log('# fallback hidden VBS:');
    process.stdout.write(buildKeepaliveLoopVbs({
      ps1Path: join(plan.dir, LOOP_PS1_NAME),
    }));
    return 0;
  }
  const written = writeInstallFiles({
    dir: plan.dir,
    nodePath: nodePath(),
    mirrorScript: plan.mirrorScript,
    hereScript: plan.hereScript,
    mainScript: plan.mainScript,
    mainPath: plan.mainPath,
    cmdText: plan.cmdText,
  });
  const created = spawnSync('schtasks', plan.schtasksArgs, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  const out = String(created.stdout || '') + String(created.stderr || '');
  const schtasksFail = created.error || (created.status !== 0 && created.status != null);
  if (schtasksFail) {
    const err = created.error?.message || out.trim() || `exit ${created.status}`;
    const fallback = installLoopFallback(plan, written, err);
    console.log(JSON.stringify(fallback));
    if (!fallback.ok) return 3;
    return cmdOnce({ dryRun: false });
  }
  const queried = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (queried.error || (queried.status !== 0 && queried.status != null)) {
    console.error(`schtasks 写了但查询失败：${queried.error?.message || queried.stderr || `exit ${queried.status}`}——不是装成功`);
    return 3;
  }
  console.log(JSON.stringify({
    ok: true,
    action: 'install',
    method: 'schtasks',
    taskName: TASK_NAME,
    intervalMin: INTERVAL_MIN,
    cmdPath: written.cmdPath,
    mainPath: plan.mainPath,
    query: String(queried.stdout || '').trim().split(/\r?\n/)[0],
  }));
  return cmdOnce({ dryRun: false });
}

function cmdOnce({ dryRun }) {
  const p = paths();
  const listed = listNodeProcesses();
  const scripts = resolveGuardScripts({
    mirrorPath: p.mirrorPath,
    repoRoot: REPO_ROOT,
    mainPath: p.mainPath,
    exists: existsSync,
  });
  const plan = planKeepalive({ listed, scripts });
  if (dryRun) {
    console.log(JSON.stringify({ ok: plan.ok, dryRun: true, error: plan.error || null, actions: plan.actions }, null, 2));
    return plan.ok ? 0 : 2;
  }
  if (!plan.ok) {
    const payload = { at: new Date().toISOString(), ok: false, error: plan.error };
    try { appendKeepaliveLog(p.dir, payload); } catch { /* 落盘失败也要把错误打出来 */ }
    console.error(plan.error);
    return 2;
  }
  const applied = applyKeepalivePlan(plan, {
    execPath: nodePath(),
    logDir: p.dir,
    start: startDetached,
  });
  const started = applied.results.some((r) => r.action === 'started');
  if (started) {
    spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000)'], { windowsHide: true });
    const again = listNodeProcesses();
    if (again.ok) {
      const live = findRunningGuards(again.processes);
      applied.observed = {
        watchdog: live.watchdog.map((x) => x.pid),
        flow: live.flow.map((x) => x.pid),
      };
    } else {
      applied.observed = { ok: false, error: again.error };
    }
  }
  try { appendKeepaliveLog(p.dir, applied); } catch (e) {
    console.error(`keepalive.jsonl 没写成：${e.message}`);
  }
  console.log(JSON.stringify(applied));
  const liveOk = !applied.observed
    || applied.observed.ok === false
    || ((applied.results.find((r) => r.name === 'watchdog')?.action !== 'started' || (applied.observed.watchdog || []).length > 0)
      && (applied.results.find((r) => r.name === 'flow')?.action !== 'started' || (applied.observed.flow || []).length > 0));
  return applied.ok && liveOk ? 0 : 1;
}

function loopStatus(dir) {
  const loopPid = readPidFile(join(dir, LOOP_PID_NAME));
  const waitPid = readPidFile(join(dir, WAIT_PID_NAME));
  const hb = readLoopHeartbeat(dir);
  if (!loopPid.ok) return { ok: false, error: loopPid.error };
  if (!waitPid.ok) return { ok: false, error: waitPid.error };
  if (!hb.ok) return { ok: false, error: hb.error };
  const pid = loopPid.pid;
  const alive = pid ? pidAlive(pid) : false;
  const waitAlive = waitPid.pid ? pidAlive(waitPid.pid) : false;
  const hbAt = hb.heartbeat?.at ? Date.parse(hb.heartbeat.at) : NaN;
  const ageMs = Number.isFinite(hbAt) ? Date.now() - hbAt : null;
  const stale = alive ? (ageMs == null || ageMs > monitorStaleMs()) : !alive && Boolean(pid);
  return {
    ok: true,
    pid,
    alive,
    waitPid: waitPid.pid,
    waitAlive,
    heartbeatAt: hb.heartbeat?.at || null,
    heartbeatAgeMs: ageMs,
    stale,
    kind: hb.heartbeat?.kind || null,
  };
}

function cmdStatus() {
  const queried = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  const listed = listNodeProcesses();
  const guards = listed.ok ? findRunningGuards(listed.processes) : { watchdog: [], flow: [] };
  const p = paths();
  const loop = loopStatus(p.dir);
  const schOk = queried.status === 0;
  console.log(JSON.stringify({
    task: schOk
      ? { ok: true, name: TASK_NAME, out: String(queried.stdout || '').trim().slice(0, 400) }
      : { ok: false, error: String(queried.stderr || queried.stdout || `exit ${queried.status}`).trim().slice(0, 240) },
    processes: listed.ok
      ? { ok: true, watchdog: guards.watchdog.map((x) => x.pid), flow: guards.flow.map((x) => x.pid) }
      : { ok: false, error: listed.error },
    loop,
  }, null, 2));
  return ((schOk || (loop.ok && loop.alive)) && listed.ok) ? 0 : 1;
}

function alarmLoop(dir, decision, pid) {
  const record = loopHaltRecord({ ...decision, pid });
  let notified = null;
  try { notified = notifyGuardHalt(record); }
  catch (e) { notified = { error: String(e && e.message ? e.message : e) }; }
  const payload = { at: new Date().toISOString(), event: 'loop-dead', decision, notified };
  try { appendKeepaliveLog(dir, payload); } catch { /* 落盘失败也要把错误打出来 */ }
  return { record, notified, payload };
}

function cmdCheckLoop() {
  const p = paths();
  const loopPid = readPidFile(join(p.dir, LOOP_PID_NAME));
  const hb = readLoopHeartbeat(p.dir);
  if (!loopPid.ok) {
    console.error(loopPid.error);
    return 2;
  }
  if (!hb.ok) {
    console.error(hb.error);
    return 2;
  }
  const pid = loopPid.pid;
  const decision = planLoopMonitor({
    pid,
    pidAlive: pid ? pidAlive(pid) : false,
    heartbeat: hb.heartbeat,
    now: Date.now(),
    seenPid: pid,
    waiterStartedAt: Date.now(),
    graceMs: monitorGraceMs(),
    staleMs: monitorStaleMs(),
  });
  const payload = { at: new Date().toISOString(), ok: decision.action === 'ok' || decision.action === 'grace', decision };
  if (decision.action === 'dead' || decision.action === 'stale') {
    const alarmed = alarmLoop(p.dir, decision, pid);
    payload.notified = alarmed.notified;
    console.log(JSON.stringify(payload));
    return 2;
  }
  console.log(JSON.stringify(payload));
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cmdLoop() {
  const p = paths();
  mkdirSync(p.dir, { recursive: true });
  const pidFile = join(p.dir, LOOP_PID_NAME);
  const existing = readPidFile(pidFile);
  if (existing.ok && existing.pid && existing.pid !== process.pid && pidAlive(existing.pid)) {
    console.log(JSON.stringify({ ok: true, action: 'already', pid: existing.pid }));
    process.exit(0);
    return;
  }
  writeFileSync(pidFile, String(process.pid), 'utf8');
  const pulse = () => {
    try { writeLoopHeartbeat(p.dir, { pid: process.pid, kind: 'node-loop' }); }
    catch (e) { console.error(`loop heartbeat 没写成：${e.message}`); }
  };
  pulse();
  const pulseMs = Number(process.env.DAO_GUARD_LOOP_PULSE_MS);
  const intervalMs = Number(process.env.DAO_GUARD_LOOP_INTERVAL_MS);
  // 隐藏常驻进程在 Win11 默认终端下，30s 无 I/O 会被收掉（本机实测）。
  // 心跳 5s 一次既是活性文件，也是保活。--once 仍是 2 分钟。
  const pulseEvery = Number.isFinite(pulseMs) && pulseMs >= 500 ? pulseMs : 2_000;
  const tickEvery = Number.isFinite(intervalMs) && intervalMs >= 1000 ? intervalMs : INTERVAL_MIN * 60 * 1000;
  console.log(JSON.stringify({ ok: true, action: 'loop', pid: process.pid, intervalMs: tickEvery, pulseMs: pulseEvery }));
  let lastOnce = 0;
  while (true) {
    pulse();
    const now = Date.now();
    if (now - lastOnce >= tickEvery) {
      lastOnce = now;
      try { cmdOnce({ dryRun: false }); }
      catch (e) { console.error(e); }
    }
    await sleep(pulseEvery);
  }
}

async function cmdLoopWait() {
  const p = paths();
  mkdirSync(p.dir, { recursive: true });
  const waitPidFile = join(p.dir, WAIT_PID_NAME);
  const existing = readPidFile(waitPidFile);
  if (existing.ok && existing.pid && existing.pid !== process.pid && pidAlive(existing.pid)) {
    console.log(JSON.stringify({ ok: true, action: 'already', pid: existing.pid }));
    process.exit(0);
    return;
  }
  writeFileSync(waitPidFile, String(process.pid), 'utf8');
  const startedAt = Date.now();
  let seenPid = null;
  const tickMs = Number(process.env.DAO_GUARD_LOOP_TICK_MS);
  const every = Number.isFinite(tickMs) && tickMs >= 200 ? tickMs : 2_000;
  while (true) {
    const loopPid = readPidFile(join(p.dir, LOOP_PID_NAME));
    const hb = readLoopHeartbeat(p.dir);
    if (loopPid.ok && hb.ok) {
      const pid = loopPid.pid;
      if (pid && pidAlive(pid)) seenPid = pid;
      const decision = planLoopMonitor({
        pid,
        pidAlive: pid ? pidAlive(pid) : false,
        heartbeat: hb.heartbeat,
        now: Date.now(),
        seenPid,
        waiterStartedAt: startedAt,
        graceMs: monitorGraceMs(),
        staleMs: monitorStaleMs(),
      });
      if (decision.action !== 'ok' && decision.action !== 'grace') {
        const out = alarmLoop(p.dir, decision, pid || seenPid);
        console.log(JSON.stringify({ ok: true, action: 'alarm', ...out.payload }));
        process.exit(0);
        return;
      }
    }
    await sleep(every);
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (args.printInstall) process.exit(cmdInstall(true));
  if (args.install) process.exit(cmdInstall(false));
  if (args.status) process.exit(cmdStatus());
  if (args.checkLoop) process.exit(cmdCheckLoop());
  if (args.spawnResidents) process.exit(cmdSpawnResidents());
  if (args.loop) return cmdLoop();
  if (args.loopWait) return cmdLoopWait();
  process.exit(cmdOnce({ dryRun: args.dryRun }));
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === HERE;
if (isDirectRun) {
  Promise.resolve(main()).catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
