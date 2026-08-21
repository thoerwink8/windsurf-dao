#!/usr/bin/env node
// scripts/guard-keepalive.mjs —— 帥位触发保活 watchdog + flow（#683 计划任务版 → #693 改 hook 触发 → #699 补心跳停更）
//
// 改这段前必须知道：本进程自己不是守卫、不跑检测矩阵，也没有 OS 级定时器了——
// #693 拍板删掉自研保活层（schtasks / 启动文件夹 VBS / resident 循环），唯一入口是
// --once：查进程、缺了从镜像拉起、写 ~/.dao/guard/keepalive.jsonl。触发点：
//   · 随仓 .claude/settings.json 的 SessionStart hook（主树 master 会话启动时）
//   · board-hook（UserPromptSubmit）每轮兜底：会话中途守卫死了，下一轮提示时拉起
// #699：进程在不算完——同时读守卫心跳，停更超阈值（活但卡死）杀掉再拉起。
// 用法：
//   node scripts/guard-keepalive.mjs --once           检查并按需拉起/重启（唯一入口；也是无旗标默认）
//   node scripts/guard-keepalive.mjs --dry-run        只打印计划，不 spawn 不杀

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultGuardDir,
  defaultMirrorPath,
  listNodeProcesses,
  findRunningGuards,
  resolveMainPath,
  resolveGuardScripts,
  planKeepalive,
  applyKeepalivePlan,
  startDetached,
  appendKeepaliveLog,
  watchdogHeartbeatPath,
  flowHeartbeatPath,
  readGuardHeartbeat,
} from './lib/guard-keepalive.mjs';

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(HERE), '..');

function printUsage() {
  console.log(`用法：
  node scripts/guard-keepalive.mjs [--once] [--dry-run]

  --once           检查 watchdog/flow：不在则拉起；进程在但心跳停更超阈值则杀掉重启
                   （#699「活但卡死」；唯一入口；也是无旗标默认）
  --dry-run        只打印计划，不 spawn 不杀

没有 --install / --status：#693 起保活不靠计划任务与自研循环，靠帥位 hook 触发。`);
}

function parseArgs(argv) {
  const args = { once: true, dryRun: false, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--once') args.once = true;
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
  const mainPath = resolveMainPath({ env: process.env, exists: existsSync });
  return { dir, home, mirrorPath, mainPath };
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
  // #699：进程在不算完，心跳也得在动。两个心跳路径与拉起时的落盘约定同源
  // （watchdog → 守卫状态目录；flow → --state-file 同目录），读不到按停更处理。
  const heartbeats = {
    watchdog: readGuardHeartbeat(watchdogHeartbeatPath({ env: process.env, homedir: p.home })),
    flow: readGuardHeartbeat(flowHeartbeatPath({ mainPath: p.mainPath, flowSpec: scripts.flow })),
  };
  const plan = planKeepalive({ listed, scripts, heartbeats, now: Date.now() });
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
  const started = applied.results.some((r) => r.action === 'started' || r.action === 'restarted');
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
  const startedNames = new Set(applied.results.filter((r) => r.action === 'started' || r.action === 'restarted').map((r) => r.name));
  const liveOk = !applied.observed
    || applied.observed.ok === false
    || ((!startedNames.has('watchdog') || (applied.observed.watchdog || []).length > 0)
      && (!startedNames.has('flow') || (applied.observed.flow || []).length > 0));
  return applied.ok && liveOk ? 0 : 1;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  process.exit(cmdOnce({ dryRun: args.dryRun }));
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === HERE;
if (isDirectRun) {
  main();
}
