#!/usr/bin/env node
// scripts/guard-keepalive.mjs —— Windows 计划任务保活 watchdog + flow（#683）
//
// 改这段前必须知道：本进程自己不是守卫、不跑检测矩阵。OS 每 2 分钟叫一次
// --once：查进程、缺了从镜像拉起、写 ~/.dao/guard/keepalive.jsonl。
// 用法：
//   node scripts/guard-keepalive.mjs --once           检查并按需拉起（计划任务默认）
//   node scripts/guard-keepalive.mjs --install        写 keepalive.cmd + 注册 schtasks
//   node scripts/guard-keepalive.mjs --print-install  只打印，不写本机
//   node scripts/guard-keepalive.mjs --status         查任务和进程
//   node scripts/guard-keepalive.mjs --dry-run        只打印计划，不 spawn

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TASK_NAME,
  INTERVAL_MIN,
  LOOP_CMD_NAME,
  STARTUP_CMD_NAME,
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
  buildKeepaliveLoopCmd,
  buildSchtasksArgs,
  writeInstallFiles,
  readInstall,
  appendKeepaliveLog,
} from './lib/guard-keepalive.mjs';

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), '..');

function printUsage() {
  console.log(`用法：
  node scripts/guard-keepalive.mjs [--once] [--dry-run]
  node scripts/guard-keepalive.mjs --install
  node scripts/guard-keepalive.mjs --print-install
  node scripts/guard-keepalive.mjs --status

  --once           检查 watchdog/flow，不在则拉起（计划任务默认；也是无旗标默认）
  --dry-run        只打印计划，不 spawn
  --install        写 ~/.dao/guard/keepalive.cmd 并 schtasks /Create（每 ${INTERVAL_MIN} 分钟）
  --print-install  打印 cmd 与 schtasks 参数，不写本机
  --status         查计划任务 + 当前守卫进程`);
}

function parseArgs(argv) {
  const args = { once: true, install: false, printInstall: false, status: false, dryRun: false, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--once') args.once = true;
    else if (a === '--install') args.install = true;
    else if (a === '--print-install') args.printInstall = true;
    else if (a === '--status') args.status = true;
    else if (a === '--dry-run') args.dryRun = true;
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

function startLoopNow(loopPath) {
  const pidFile = join(dirname(loopPath), 'loop.pid');
  if (existsSync(pidFile)) {
    const old = Number(String(readFileSync(pidFile, 'utf8') || '').trim());
    if (Number.isFinite(old) && old > 0 && pidAlive(old)) return { action: 'already', pid: old };
  }
  const child = spawn('cmd.exe', ['/c', loopPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: dirname(loopPath),
  });
  if (child && typeof child.unref === 'function') child.unref();
  if (child?.pid) writeFileSync(pidFile, String(child.pid), 'utf8');
  return { action: 'started', pid: child.pid };
}

function installLoopFallback(plan, written, schtasksError) {
  const intervalSec = INTERVAL_MIN * 60;
  const loopText = buildKeepaliveLoopCmd({ onceCmdPath: written.cmdPath, intervalSec });
  const loopPath = join(plan.dir, LOOP_CMD_NAME);
  writeFileSync(loopPath, loopText, 'utf8');
  const startupDir = defaultStartupDir({ env: process.env });
  let startupPath = null;
  if (startupDir && existsSync(startupDir)) {
    startupPath = join(startupDir, STARTUP_CMD_NAME);
    copyFileSync(loopPath, startupPath);
  }
  const loop = startLoopNow(loopPath);
  return {
    ok: true,
    action: 'install',
    method: 'startup-loop',
    taskName: TASK_NAME,
    intervalMin: INTERVAL_MIN,
    cmdPath: written.cmdPath,
    loopPath,
    startupPath,
    loop,
    schtasksError,
    mainPath: plan.mainPath,
    note: 'schtasks 拒绝访问；已写用户启动循环并当场拉起（仍是 OS 定时，不是第二只狗）',
  };
}

function cmdInstall(printOnly) {
  const plan = installPlan();
  if (printOnly) {
    process.stdout.write(plan.cmdText);
    console.log(`# schtasks ${plan.schtasksArgs.join(' ')}`);
    const loop = buildKeepaliveLoopCmd({ onceCmdPath: plan.cmdPath, intervalSec: INTERVAL_MIN * 60 });
    console.log('# fallback loop (only if schtasks Access Denied):');
    process.stdout.write(loop);
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

function cmdStatus() {
  const queried = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  const listed = listNodeProcesses();
  const guards = listed.ok ? findRunningGuards(listed.processes) : { watchdog: [], flow: [] };
  console.log(JSON.stringify({
    task: queried.status === 0
      ? { ok: true, name: TASK_NAME, out: String(queried.stdout || '').trim().slice(0, 400) }
      : { ok: false, error: String(queried.stderr || queried.stdout || `exit ${queried.status}`).trim().slice(0, 240) },
    processes: listed.ok
      ? { ok: true, watchdog: guards.watchdog.map((p) => p.pid), flow: guards.flow.map((p) => p.pid) }
      : { ok: false, error: listed.error },
  }, null, 2));
  return (queried.status === 0 && listed.ok) ? 0 : 1;
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
  process.exit(cmdOnce({ dryRun: args.dryRun }));
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === HERE;
if (isDirectRun) {
  main();
}
