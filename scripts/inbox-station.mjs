#!/usr/bin/env node
// scripts/inbox-station.mjs —— 信箱台幂等保证（issue #464，#638 改成单台轮询全部在途 Run，
// 2026-08-23 拍板改 detached 后台进程）
//
// #667：删掉「靠 coordinator 横幅给帅收信」整层。人用窗口永不当 coordinator。
// 真信只进本台日志 `_flow/inbox.log` 和 GitHub；帅读这两处，不靠
// 「You have N orchestration messages」横幅。心跳不准发到 Run。
// 中继：写日志 → 可归档加速闸 + MERGED 扫描收树（#665）。
//
// #638（2026-08-19 拍板）：**不再一 Run 一台**——全机只保活一台。
// 2026-08-23 拍板（detached 化）：
//   - relay 从「哑终端里的进程」改成 **detached 后台进程**（spawn detached + windowsHide，
//     stdio 进 _flow/inbox.out.log）——面板 0 占用，不再占顶栏页签。
//   - 活性判据 = 全局租约 _flow/inbox.lease（新鲜 + PID 在 + PID 命令行是本脚本 relay）。
//     不再要 handle（没有终端了）；命令行核对防 #635 的 PID 复用假活。
//   - 旧式终端台（租约带 handle）ensure 时幂等迁移：关终端 + 杀残留 relay 进程 +
//     拉起 detached relay（action: rebuild, reason: detached-migration）。
//   - 不再反复多开：ensure/keepalive 先查租约+PID，活则不拉；关台双杀（关终端 + 杀 PID，
//     实证：终端没了 relay 进程还在，一台攒出 8 个 relay 同写一张日志）。
//   - 派工路不再跑 ensure（2026-08-23：ensure 挪出 dao，最慢 300s 是派工分钟级大头），
//     台保活归 guard-keepalive（hook 触发 --once，租约即心跳）。
//   - relay 行为不变：不 run-use（不抢 waiter），每轮读 `orchestration inbox`（跨 Run，
//     不绑 coordinator），过滤活跃 Run，去重后落盘非 heartbeat，跑可归档加速闸 +
//     每轮 MERGED 扫描（#665：可归档不是门）。
//   - #614 顺车：ensure 成功后顺手只读 run-gc 扫描，僵尸数超阈值在 stdout 打一行；
//     --apply 仍不自动。
//
// 用法（以 --help 为准，这里只列结构）：
//   node scripts/inbox-station.mjs ensure [--log <path>] [--gc-threshold <n>]
//   node scripts/inbox-station.mjs relay  [--log <path>] [--timeout-ms <n>]
//   node scripts/inbox-station.mjs retire --run <id> [--log <path>]
//
// ensure stdout 最后一行 JSON：{ok, handle:null, pid, logPath, action, reason, closedExtra, gc, ...}
//
// ensure 判定（#638 + 2026-08-23 detached）：
//   - 全活台扫描 _flow/inbox*.lease；活 = 租约新鲜 + PID 在（detached 台加命令行核对）
//   - 全局台（inbox.lease）活着且是 detached → ok（多余活台顺手关掉 = closed-extra）
//   - 全局台活着但是旧式终端台（租约带 handle）→ 迁移重建（detached-migration）
//   - 只有旧模型 per-run 台活着 → 全部关掉 + 重建全局台（旧 relay 不轮询全部 Run）
//   - 一个活台都没有 → 重建（reason: no-station）
//   - 租约读不成 / 进程列表没查成：证不出就不动，绝不误关别人的终端/进程
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOrcaStdout } from './lib/orca-stdout.mjs';
import { runOrca as sharedRunOrca } from './lib/orca-run.mjs';
import { orcaErrorText } from './lib/orca-error.mjs';
import {
  planStationRetire,
  applyStationRetire,
  resolveStationCloseTarget,
  previewHandlesForRun,
  planRunGc,
  partitionGcTargets,
} from './lib/run-lifecycle.mjs';
import {
  processArchiveNotices,
  processMergedScan,
  formatArchiveExecLog,
  formatMergedScanLog,
  parsePrStateOutput,
  parsePrReviewsOutput,
} from './lib/archive-exec.mjs';
import { recordStartupRevision, checkGuardRevision, haltIfStale } from './lib/guard-revision.mjs';
import { bootGuardOrHalt } from './lib/guard-mirror.mjs';
import { ghAs } from './lib/gh.mjs';
export { parseOrcaStdout };

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ORCA_TIMEOUT_MS = 30000;
const READY_WAIT_MS = 30000;
const READY_POLL_MS = 1000;

export const READY_MARK = 'INBOX_STATION_READY';
// 全局台默认日志：_flow/inbox.log（一条 Run 一个台的旧模型日志 inbox-<run>.log 是历史遗留）
export const DEFAULT_LOG_REL = join('_flow', 'inbox.log');
// 无租约自带 ttl 时的默认窗口：覆盖默认轮询间隔 + 余量
export const LEASE_TTL_MS = 25000;
export const LEASE_GRACE_MS = 10000;
// #614：僵尸 Run 阈值，只读 gc 超过它就在 ensure 输出里打一行
export const GC_THRESHOLD = 5;
// relay 每轮轮询间隔（毫秒）
export const RELAY_POLL_MS = 10000;

// 旧模型 per-run 日志按 run 隔离仍保留给 run-gc/retire 用
export function runShort(runId) {
  return String(runId || '').replace(/^run_/, '');
}

export function defaultLogRel(runId) {
  return runShort(runId) ? join('_flow', `inbox-${runShort(runId)}.log`) : DEFAULT_LOG_REL;
}

// ══════════════════════════════════════════════════════════════════════
// 纯函数（单测直接 import，不经过 live orca）
// ══════════════════════════════════════════════════════════════════════

export function parseArgs(argv) {
  const args = {
    cmd: 'ensure',
    run: null,
    log: null,
    timeoutMs: 15000,
    gcThreshold: GC_THRESHOLD,
    help: false,
  };
  const rest = argv.slice(2);
  let i = 0;
  if (rest[0] && !rest[0].startsWith('-')) {
    args.cmd = rest[0];
    i = 1;
  }
  for (; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '--run': args.run = rest[++i] || ''; break;
      case '--log': args.log = rest[++i] || ''; break;
      case '--timeout-ms': {
        const n = Number(rest[++i]);
        if (!Number.isFinite(n) || n <= 0) throw new Error('参数 --timeout-ms 需要正整数');
        args.timeoutMs = n;
        break;
      }
      case '--gc-threshold': {
        const n = Number(rest[++i]);
        if (!Number.isFinite(n) || n < 0) throw new Error('参数 --gc-threshold 需要非负整数');
        args.gcThreshold = n;
        break;
      }
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`未知参数: ${a}`);
    }
  }
  if (!['ensure', 'relay', 'retire'].includes(args.cmd)) {
    throw new Error(`未知命令: ${args.cmd}（只要 ensure / relay / retire）`);
  }
  return args;
}

export function isHandleOnBoard(handle, terminals) {
  if (!handle) return false;
  return (Array.isArray(terminals) ? terminals : []).some((t) => t && t.handle === handle);
}

// #638 全局台活性：租约新鲜 + PID 在。runId 不再是身份（一 Run 一台已退役）。
export function isStationAlive(lease, opts = {}) {
  if (!lease) return false;
  return isLeaseFresh(lease, opts.now, opts.ttlMs) && isProcessAlive(lease.pid);
}

export function decideReady({ lease, now, ttlMs, pid } = {}) {
  // 2026-08-23 detached：就绪 = 租约新鲜 + （给了 pid 时）租约就是我们拉起的那个进程。
  if (!isStationAlive(lease, { now, ttlMs })) {
    return { ok: false, error: 'relay-not-alive' };
  }
  if (pid != null && lease.pid !== pid) {
    return { ok: false, error: `租约 pid=${lease.pid} 不是刚拉起的 ${pid}` };
  }
  return { ok: true };
}

export function finalizeEnsure({
  relayAlive,
  handle,
  logPath,
  action,
  reason,
  closedExtra = [],
  closeFailures = [],
  gc,
  detached,
} = {}) {
  if (!relayAlive) {
    return {
      exitCode: 1,
      payload: statusPayload({
        ok: false,
        handle,
        logPath,
        action,
        reason: 'relay-not-alive',
        error: 'relay-not-alive',
        closedExtra,
        closeFailures,
        gc,
        detached,
      }),
    };
  }
  return {
    exitCode: 0,
    payload: statusPayload({
      ok: true,
      handle,
      logPath,
      action,
      reason,
      closedExtra,
      closeFailures,
      gc,
      detached,
    }),
  };
}

export function logStem(logPath) {
  const log = String(logPath || DEFAULT_LOG_REL).replace(/\\/g, '/');
  const base = log.split('/').pop() || 'inbox.log';
  return base.replace(/\.log$/i, '');
}

export function leasePath(logPath) {
  return join(dirname(logPath || DEFAULT_LOG_REL), `${logStem(logPath)}.lease`);
}

export function launchFilePath(logPath) {
  return join(dirname(logPath || DEFAULT_LOG_REL), `${logStem(logPath)}.cmd`);
}

export function formatLease({ pid, runId, ts, ttlMs, handle }) {
  const obj = {
    pid,
    runId: runId ?? null,
    ts,
    ttlMs: ttlMs ?? LEASE_TTL_MS,
  };
  if (handle) obj.handle = handle;
  return `${JSON.stringify(obj)}\n`;
}

export function parseLease(raw) {
  if (raw == null) return null;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    const pid = Number(obj?.pid);
    const ts = Number(obj?.ts);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(ts)) return null;
    const ttlMs = Number(obj?.ttlMs);
    const handle = typeof obj.handle === 'string' && obj.handle.trim() ? obj.handle.trim() : null;
    return {
      pid,
      ts,
      runId: obj.runId ?? null,
      handle,
      ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : LEASE_TTL_MS,
    };
  } catch {
    return null;
  }
}

export function isLeaseFresh(lease, now = Date.now(), ttlMs) {
  if (!lease || !Number.isFinite(lease.ts) || !Number.isFinite(now)) return false;
  const window = ttlMs ?? lease.ttlMs ?? LEASE_TTL_MS;
  const age = now - lease.ts;
  return age >= 0 && age <= window;
}

export function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// ══════════════════════════════════════════════════════════════════════
// #638 单台保证：扫描租约 + 关多余台
// ══════════════════════════════════════════════════════════════════════

const LEASE_FILE_RE = /^inbox(?:-[0-9a-f]+)?\.lease$/i;

/**
 * 扫 _flow 目录下所有信箱台租约（全局 inbox.lease + 旧模型 inbox-<run>.lease）。
 * 返回 [{ stem, leaseFile, runId, lease, files }]；读不成的条目 lease 为 null、
 * parseError 为 true（证不出就不动，绝不误关）。
 */
export function scanLeaseStations(flowDir) {
  if (!flowDir) return [];
  let names;
  try {
    names = readdirSync(flowDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!LEASE_FILE_RE.test(name)) continue;
    const stem = name.replace(/\.lease$/i, '');
    const leaseFile = join(flowDir, name);
    const logPath = join(flowDir, `${stem}.log`);
    let lease = null;
    let parseError = false;
    try {
      lease = parseLease(readFileSync(leaseFile, 'utf8'));
      if (!lease) parseError = true;
    } catch {
      parseError = true;
    }
    out.push({
      stem,
      leaseFile,
      runId: lease && lease.runId ? lease.runId : (stem === 'inbox' ? null : stem.replace(/^inbox-/, '')),
      lease,
      parseError,
      files: [leaseFile, join(flowDir, `${stem}.cmd`), logPath],
    });
  }
  return out;
}

/** 台活 = 租约新鲜 + PID 在。旧式终端台（租约带 handle）仍要 handle 在盘面
 * （#635：PID 复用会让「数字还活着」假阳性）；detached 台（无 handle）走 pidAlive
 * 注入做命令行核对（同防 PID 复用）。pidAlive 返回 null = 没查成 = 证不出就不动（当活）。 */
export function classifyStationLive(station, { terminals = [], now = Date.now(), pidAlive } = {}) {
  if (!station || !station.lease || station.parseError) return false;
  if (!isStationAlive(station.lease, { now })) return false;
  if (station.lease.handle) {
    return isHandleOnBoard(station.lease.handle, terminals);
  }
  if (typeof pidAlive === 'function') {
    return pidAlive(station.lease.pid) !== false;
  }
  return isProcessAlive(station.lease.pid);
}

/**
 * #638 单台决策：
 *   - 全局台（inbox.lease）活 → ok；其它活台全关（closed-extra）
 *   - 只有旧模型 per-run 台活 → 全关 + 重建全局台（旧 relay 不轮询全部 Run）
 *   - 一个活台都没有 → 重建（no-station）
 *   close 里的每台都必须已经证明（classifyStationLive 过），关的时候再走租约身份。
 */
export function planSingleStation({ stations = [], terminals = [], now = Date.now(), pidAlive } = {}) {
  const live = [];
  const unproven = [];
  for (const st of stations) {
    if (classifyStationLive(st, { terminals, now, pidAlive })) live.push(st);
    else unproven.push(st);
  }
  const global = live.find((s) => s.stem === 'inbox') || null;
  if (global) {
    // 2026-08-23 detached 化：活全局台仍是旧式终端台（租约带 handle）→ 迁移重建。
    if (global.lease && global.lease.handle) {
      return {
        ok: true,
        action: 'rebuild',
        reason: 'detached-migration',
        keep: null,
        close: live,
        unproven,
        rebuild: true,
      };
    }
    const close = live.filter((s) => s !== global);
    return {
      ok: true,
      action: 'ok',
      reason: close.length ? 'closed-extra' : 'all-alive',
      keep: global,
      close,
      unproven,
      rebuild: false,
    };
  }
  if (live.length === 0) {
    return {
      ok: true,
      action: 'rebuild',
      reason: 'no-station',
      keep: null,
      close: [],
      unproven,
      rebuild: true,
    };
  }
  return {
    ok: true,
    action: 'rebuild',
    reason: 'no-global-station',
    keep: null,
    close: live,
    unproven,
    rebuild: true,
  };
}

// 关一台的收口计划/执行：terminal close（证不出 alreadyGone 也算成功）+ 删 3 件套
export function planCloseStation(station) {
  return planStationRetire({
    runId: station.runId || station.stem || null,
    closeHandle: station.lease && station.lease.handle ? station.lease.handle : null,
    files: Array.isArray(station.files) ? station.files : [],
  });
}

export function applyCloseStation(station, { closeTerminal, unlink, killPid } = {}) {
  // 双杀（2026-08-23 detached 实证）：终端死了 relay 进程可能还在（一台 8 进程事故）。
  // 有 handle 关终端；lease.pid 活着就杀（killPid 实现必须核对命令行，拒杀非 relay）。
  const pid = station?.lease?.pid;
  let killed = null;
  if (pid && typeof killPid === 'function' && isProcessAlive(pid)) {
    killed = killPid(pid);
  }
  const retired = applyStationRetire(planCloseStation(station), { closeTerminal, unlink });
  if (killed) retired.killed = killed;
  return retired;
}

// ══════════════════════════════════════════════════════════════════════
// relay 活跃集：哪些 Run 的信要收
// ══════════════════════════════════════════════════════════════════════

/**
 * 活跃 Run 集 = 在途单 keep 集（planRunGc 的 protected）∪ 还有活 coordinator 的 Run。
 * 前者覆盖在途/待收口；后者覆盖「帅值守 Run / 刚派完还没收回 coordinator」的 Run——
 * planned worker_done 的最后一单完成但树还在盘面（待收口）也仍在 keep 里。
 */
export function activeRunIds({ runs, workers, worktrees, terminals } = {}) {
  const ids = new Set();
  const plan = planRunGc({ runs, workers, worktrees });
  if (plan.ok) {
    for (const r of plan.keep) {
      if (r && r.id) ids.add(r.id);
    }
  }
  if (Array.isArray(terminals)) {
    const onBoard = new Set(terminals.map((t) => t && t.handle).filter(Boolean));
    for (const r of Array.isArray(runs) ? runs : []) {
      if (!r || !r.id) continue;
      if (r.legacy) continue;
      if (r.coordinator_handle && onBoard.has(r.coordinator_handle)) ids.add(r.id);
    }
  }
  return ids;
}

/** 只留活跃 Run 的信，按 id 去重（Map 天然去重）。 */
export function relevantMessages(messages, activeIds, seen = new Set()) {
  const out = [];
  const byId = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || !m.id) continue;
    if (seen.has(m.id)) continue;
    if (!m.run_id || !activeIds.has(m.run_id)) continue;
    byId.set(m.id, m);
  }
  for (const m of byId.values()) out.push(m);
  return out;
}

/** 落盘点之前的去重：从日志文件回读已写过的 msg id。 */
export function readLoggedIds(logPath) {
  const ids = new Set();
  try {
    const text = readFileSync(logPath, 'utf8');
    const re = /"id"\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(text))) ids.add(m[1]);
  } catch {
    // 日志不存在/读不成 = 没有已写记录，不是失败
  }
  return ids;
}

export function shouldLogMessage(msg) {
  return String(msg?.type || '').toLowerCase() !== 'heartbeat';
}

export function splitMessages(messages) {
  const loggable = [];
  const heartbeats = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (shouldLogMessage(m)) loggable.push(m);
    else heartbeats.push(m);
  }
  return { loggable, heartbeats };
}

export function formatLogLine(msg, now = new Date()) {
  return JSON.stringify({
    ts: now.toISOString(),
    id: msg?.id ?? null,
    type: msg?.type ?? null,
    run_id: msg?.run_id ?? null,
    from: msg?.from_handle ?? msg?.fromHandle ?? null,
    to: msg?.to_handle ?? msg?.toHandle ?? null,
    subject: msg?.subject ?? '',
    body: msg?.body ?? '',
    payload: msg?.payload ?? null,
  });
}

export function findMainWorktree(worktrees) {
  const list = Array.isArray(worktrees) ? worktrees : [];
  return list.find((w) => w.isMainWorktree || w.git?.isMainWorktree) || null;
}

export function unwrapOrca(json, key) {
  if (json?.result && Object.prototype.hasOwnProperty.call(json.result, key)) return json.result[key];
  if (json && Object.prototype.hasOwnProperty.call(json, key)) return json[key];
  return null;
}

/** 进程命令行不指向当前（镜像）脚本 → 旧代码还在跑，ensure 必须重建。
 * 2026-08-23 detached：比对对象是 relay 进程的 CommandLine（不再是 .cmd 启动文件）。 */
export function launchNeedsRefresh(commandLine, expectedScriptPath) {
  if (!commandLine || !expectedScriptPath) return true;
  const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();
  return !norm(commandLine).includes(norm(expectedScriptPath));
}

export function statusPayload({
  ok = true,
  handle,
  logPath,
  action,
  reason,
  error,
  closedExtra,
  closeFailures,
  gc,
  detached,
} = {}) {
  const payload = { ok, handle, logPath, action, reason };
  if (Array.isArray(closedExtra) && closedExtra.length) payload.closedExtra = closedExtra;
  if (Array.isArray(closeFailures) && closeFailures.length) payload.closeFailures = closeFailures;
  if (gc) payload.gc = gc;
  if (Array.isArray(detached) && detached.length) payload.detached = detached;
  if (error) payload.error = error;
  return payload;
}

// #614 阈值行：僵尸数超过阈值才返回一行提示（否则 null，什么都不打）
export function gcThresholdLine({ zombieCount, threshold, scanned = true } = {}) {
  const n = Number(zombieCount);
  const t = Number(threshold);
  if (!Number.isFinite(n) || !Number.isFinite(t)) return null;
  if (scanned !== true) return null;
  if (n <= t) return null;
  return `⚠️ run-gc 只读：发现 ${n} 个僵尸 Run（阈值 ${t}），手动清理：node scripts/dao.mjs run-gc --apply`;
}

/** 从 run-gc 计划汇总只读统计（zwombie = planRunGc 的 retire 数）。 */
export function gcSummaryFromPlan(plan, threshold = GC_THRESHOLD) {
  if (!plan || plan.ok !== true) {
    return { ok: false, unscanned: true, zombieCount: null, keepCount: null, threshold };
  }
  return {
    ok: true,
    unscanned: false,
    zombieCount: (plan.retire || []).length,
    keepCount: (plan.keep || []).length,
    threshold,
  };
}

// ══════════════════════════════════════════════════════════════════════
// orca 封装
// ══════════════════════════════════════════════════════════════════════

function errText(e) {
  return orcaErrorText(e);
}

// spawn/归一化唯一真源在 scripts/lib/orca-run.mjs（#695 windowsHide、结构化错误透传都在那）。
function runOrca(cmdArgs, timeout = ORCA_TIMEOUT_MS) {
  return sharedRunOrca(cmdArgs, { timeout });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ══════════════════════════════════════════════════════════════════════
// 解析现场
// ══════════════════════════════════════════════════════════════════════

function listTerminals() {
  const r = runOrca(['terminal', 'list', '--json']);
  if (!r.ok) return { ok: false, error: r.error, terminals: [] };
  const terminals = unwrapOrca(r.json, 'terminals');
  if (!Array.isArray(terminals)) return { ok: false, error: 'terminal list 没有 terminals[]', terminals: [] };
  return { ok: true, terminals };
}

function listWorktrees() {
  const r = runOrca(['worktree', 'ps', '--json']);
  if (!r.ok) return { ok: false, error: r.error, worktrees: [] };
  const worktrees = unwrapOrca(r.json, 'worktrees') || unwrapOrca(r.json, 'items') || [];
  return { ok: Array.isArray(worktrees), worktrees: Array.isArray(worktrees) ? worktrees : [], error: r.error };
}

// #614 验收⑤：run-list 分页扫全（nextCursor 循环）。页失败 / 游标不前进 = 没扫成。
function listRuns(limit = 100) {
  const all = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const args = ['orchestration', 'run-list', '--limit', String(limit)];
    if (cursor) args.push('--cursor', cursor);
    args.push('--json');
    const r = runOrca(args);
    if (!r.ok) {
      return { ok: false, unscanned: true, error: `run-list 分页没查成: ${errText(r.error)}`, runs: [] };
    }
    const runs = unwrapOrca(r.json, 'runs');
    if (!Array.isArray(runs)) {
      return { ok: false, unscanned: true, error: 'run-list 分页结构不认识', runs: [] };
    }
    for (const run of runs) {
      if (run && run.id && !seen.has(run.id)) {
        seen.add(run.id);
        all.push(run);
      }
    }
    const next = r.json?.result?.nextCursor || null;
    if (!next) return { ok: true, runs: all };
    if (next === cursor) {
      return { ok: false, unscanned: true, error: 'run-list 游标不前进，分页扫全失败（没扫成）', runs: [] };
    }
    cursor = next;
  }
  return { ok: false, unscanned: true, error: 'run-list 分页超过 20 页，放弃（没扫成）', runs: [] };
}



function listWorkers() {
  const r = runOrca(['orchestration', 'worker-list', '--json']);
  if (!r.ok) return { ok: false, error: r.error, workers: [] };
  const workers = unwrapOrca(r.json, 'workers');
  return { ok: Array.isArray(workers), workers: Array.isArray(workers) ? workers : [], error: r.error };
}

function inboxMessages() {
  const r = runOrca(['orchestration', 'inbox', '--full', '--json']);
  if (!r.ok) return { ok: false, error: r.error, messages: [] };
  const messages = r.json?.result?.messages;
  return { ok: Array.isArray(messages), messages: Array.isArray(messages) ? messages : [], error: r.ok ? null : r.error };
}

function loadBoard() {
  const runs = listRuns();
  if (!runs.ok) return { ok: false, error: `run-list 没查成: ${errText(runs.error)}` };
  const workers = listWorkers();
  if (!workers.ok) return { ok: false, error: `worker-list 没查成: ${errText(workers.error)}` };
  const worktrees = listWorktrees();
  if (!worktrees.ok) return { ok: false, error: `worktree ps 没查成: ${errText(worktrees.error)}` };
  return { ok: true, runs: runs.runs, workers: workers.workers, worktrees: worktrees.worktrees };
}

function resolveLogPath(arg, runId) {
  if (arg) return resolve(arg);
  const listed = listWorktrees();
  const main = findMainWorktree(listed.worktrees);
  const base = main?.path || ROOT;
  return join(base, defaultLogRel(runId));
}

// ══════════════════════════════════════════════════════════════════════
// ensure / rebuild
// ══════════════════════════════════════════════════════════════════════

function loadLease(logPath) {
  try {
    return parseLease(readFileSync(leasePath(logPath), 'utf8'));
  } catch {
    return null;
  }
}

function persistLease(logPath, runId, ttlMs = LEASE_TTL_MS) {
  // 2026-08-23 detached：relay 写的租约不带 handle（没有终端了）。
  // 旧式终端台的残留 handle 不许被 relay 续命带下去（会把判活骗回旧式）。
  writeFileSync(leasePath(logPath), formatLease({
    pid: process.pid,
    runId,
    ts: Date.now(),
    ttlMs,
  }), 'utf8');
}

/** relay 诊断输出落点（detached 后没有终端屏面）：_flow/inbox.out.log。 */
export function relayOutPath(logPath) {
  return join(dirname(logPath || DEFAULT_LOG_REL), `${logStem(logPath)}.out.log`);
}

/** 列活着的 relay 进程（PID + 命令行）。没查成 ≠ 0 个——调用方按「证不出就不动」处理。 */
export function listRelayProcesses({ spawn = spawnSync } = {}) {
  const r = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'inbox-station\\.mjs' -and $_.CommandLine -match '\\brelay\\b' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
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
  const text = String(r.stdout || '').trim();
  if (!text) return { ok: true, processes: [] };
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    return { ok: false, error: `relay 进程列表不是 JSON：${e.message}——没查成，不是 0 个`, processes: [] };
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return {
    ok: true,
    processes: arr.filter(Boolean).map(p => ({
      pid: Number(p.ProcessId ?? p.pid),
      commandLine: String(p.CommandLine ?? p.commandLine ?? ''),
    })).filter(p => Number.isFinite(p.pid) && p.pid > 0),
  };
}

/** PID 命令行核对：是本脚本的 relay 才算（防 #635 PID 复用假活/误杀）。 */
export function pidIsRelay(pid, processes) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  return (Array.isArray(processes) ? processes : []).some(p => p && p.pid === n);
}

/** Windows 强杀 relay：先核对命令行是本脚本 relay，不是就拒杀（绝不误杀无关进程）。 */
export function killRelayPid(pid, { spawn = spawnSync, list = listRelayProcesses } = {}) {
  const listed = list({ spawn });
  if (!listed.ok) return { ok: false, pid, unscanned: true, error: `进程列表没查成，拒杀 ${pid}：${listed.error}` };
  if (!pidIsRelay(pid, listed.processes)) {
    return { ok: false, pid, error: `PID ${pid} 不是 inbox-station relay 进程，拒杀` };
  }
  const r = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return { ok: false, pid, error: String(r.error?.message || r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 160) };
  }
  return { ok: true, pid };
}

/** 等 detached relay 就绪：租约出现、新鲜、且 pid 是我们刚拉起的那个。 */
async function waitRelayLease({ logPath, pid, timeoutMs = READY_WAIT_MS } = {}) {
  const t0 = Date.now();
  let lastError = '中继未就绪';
  while (Date.now() - t0 < timeoutMs) {
    const ready = decideReady({ lease: loadLease(logPath), pid });
    if (ready.ok) return { ok: true, pid };
    lastError = ready.error || lastError;
    await sleep(READY_POLL_MS);
  }
  return { ok: false, error: `等 ${timeoutMs}ms ${lastError}` };
}

/** detached 拉起 relay：面板 0 占用；stdio 进 _flow/inbox.out.log（append）。 */
function spawnDetachedRelay({ logPath, spawnFn = spawn } = {}) {
  const outPath = relayOutPath(logPath);
  mkdirSync(dirname(outPath), { recursive: true });
  let fd;
  try {
    fd = openSync(outPath, 'a');
  } catch (e) {
    return { ok: false, error: `relay 诊断日志开不了 ${outPath}：${String(e?.message || e)}` };
  }
  let child;
  try {
    child = spawnFn(process.execPath, [SCRIPT_PATH, 'relay', '--log', logPath], {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
  } catch (e) {
    try { closeSync(fd); } catch { /* 关 fd 失败不盖主错误 */ }
    return { ok: false, error: `relay spawn 失败：${String(e?.message || e)}` };
  }
  try { closeSync(fd); } catch { /* 子进程已持有 dup 后的句柄 */ }
  if (!child || !child.pid) return { ok: false, error: 'relay spawn 没给出 pid' };
  if (typeof child.unref === 'function') child.unref();
  return { ok: true, pid: child.pid };
}

async function rebuildStation({ logPath }) {
  // 2026-08-23 detached：不再 terminal create 哑终端，直接 spawn 后台进程。
  // 不 run-use 不变：relay 是纯监听者，根治 consumer_fenced（#638）。
  const spawned = spawnDetachedRelay({ logPath });
  if (!spawned.ok) return spawned;
  const ready = await waitRelayLease({ logPath, pid: spawned.pid });
  if (!ready.ok) return { ok: false, error: ready.error, pid: spawned.pid };
  return { ok: true, handle: null, pid: spawned.pid };
}

async function gcZombieScan(threshold) {
  const runs = listRuns();
  if (!runs.ok) return { ok: false, unscanned: true, error: `run-list 没查成: ${errText(runs.error)}`, threshold };
  const workers = listWorkers();
  if (!workers.ok) return { ok: false, unscanned: true, error: `worker-list 没查成: ${errText(workers.error)}`, threshold };
  const worktrees = listWorktrees();
  if (!worktrees.ok) return { ok: false, unscanned: true, error: `worktree ps 没查成: ${errText(worktrees.error)}`, threshold };
  const plan = planRunGc({
    runs: runs.runs,
    workers: workers.workers,
    worktrees: worktrees.worktrees,
  });
  if (!plan.ok) return { ok: false, unscanned: true, error: plan.error, threshold };
  // #614：只数活僵尸（有租约 pending），墓碑计入会让提示行永远响（狼来了）
  const parts = partitionGcTargets(plan.retire, {
    leaseExistsFor: (runId) => {
      const logPath = resolveLogPath(null, runId);
      return [leasePath(logPath), launchFilePath(logPath), logPath].some((f) => existsSync(f));
    },
  });
  if (!parts.ok) return { ok: false, unscanned: true, error: parts.error, threshold };
  return {
    ok: true,
    unscanned: false,
    zombieCount: parts.pending.length,
    keepCount: plan.keep.length,
    tombstoneCount: parts.tombstones.length,
    threshold,
  };
}

async function cmdEnsure(args) {
  const logPath = resolveLogPath(args.log, null);
  mkdirSync(dirname(logPath), { recursive: true });

  const listed = listTerminals();
  if (!listed.ok) {
    console.log(JSON.stringify({ ok: false, error: `terminal list 失败: ${errText(listed.error)}` }));
    process.exit(1);
  }
  // detached 台判活的命令行核对（防 #635 PID 复用假活）。没查成 = null = 证不出就不动。
  const relayProcs = listRelayProcesses();
  const pidAlive = relayProcs.ok
    ? (pid) => pidIsRelay(pid, relayProcs.processes)
    : () => null;
  const pidCheck = relayProcs.ok ? 'ok' : 'unscanned';

  const stations = scanLeaseStations(dirname(logPath));
  let plan = planSingleStation({ stations, terminals: listed.terminals, pidAlive });
  if (!plan.rebuild && plan.keep && relayProcs.ok) {
    // stale-guard：活 relay 跑的不是当前（镜像）脚本 → 重建换血。
    const proc = relayProcs.processes.find(p => p.pid === plan.keep.lease?.pid);
    if (proc && launchNeedsRefresh(proc.commandLine, SCRIPT_PATH)) {
      plan = {
        ...plan,
        rebuild: true,
        action: 'rebuild',
        reason: 'stale-guard',
        keep: null,
        close: [plan.keep, ...plan.close],
      };
    }
  }

  const closedExtra = [];
  const closeFailures = [];
  for (const st of plan.close) {
    const applied = applyCloseStation(st, {
      closeTerminal: (h) => runOrca(['terminal', 'close', '--terminal', h, '--tab', '--json']),
      unlink: unlinkSync,
      killPid: (pid) => killRelayPid(pid),
    });
    const pid = st.lease && st.lease.pid ? st.lease.pid : null;
    if (applied.ok) {
      closedExtra.push({ runId: st.runId || null, handle: st.lease && st.lease.handle ? st.lease.handle : null, pid, result: applied.state || 'retired' });
    } else {
      closeFailures.push({ runId: st.runId || null, handle: st.lease && st.lease.handle ? st.lease.handle : null, pid, error: applied.error });
    }
  }

  const action = plan.action;
  const reason = plan.reason;
  let pid = (plan.keep && plan.keep.lease && plan.keep.lease.pid) || null;

  if (plan.rebuild === true) {
    const rebuilt = await rebuildStation({ logPath });
    if (!rebuilt.ok) {
      console.log(JSON.stringify({ ok: false, error: rebuilt.error, action, reason, closedExtra, closeFailures, pidCheck }));
      process.exit(1);
    }
    pid = rebuilt.pid;
  }

  // 终判：租约新鲜 + PID 在（detached 台没有 handle 可查；relay 每轮续租约，死了 25s 内必过期）
  const afterLease = loadLease(logPath);
  const relayAlive = isStationAlive(afterLease, { now: Date.now() });

  // 一个仓库一个（2026-08-23 实证：8 个孤儿 relay 同写一张 inbox.log）：租约外的
  // relay 进程全杀。killRelayPid 自带命令行核对，拒杀非 relay 进程。
  const livePid = relayAlive && afterLease ? afterLease.pid : pid;
  const killedOrphans = [];
  if (relayProcs.ok) {
    for (const p of relayProcs.processes) {
      if (p.pid === livePid) continue;
      const k = killRelayPid(p.pid);
      killedOrphans.push({ pid: p.pid, ok: k.ok === true, ...(k.error ? { error: k.error } : {}) });
    }
  }

  // #614 顺车：ensure 成功后只读 run-gc 扫描，超阈值打一行（stdout 最前，JSON 在最后一行）
  const gc = await gcZombieScan(args.gcThreshold);
  const line = gcThresholdLine({ zombieCount: gc.zombieCount, threshold: gc.threshold, scanned: gc.ok });
  if (relayAlive && line) console.log(line);

  const final = finalizeEnsure({
    relayAlive,
    handle: null,
    logPath,
    action,
    reason,
    closedExtra,
    closeFailures,
    gc,
  });
  final.payload.pid = pid;
  final.payload.pidCheck = pidCheck;
  if (killedOrphans.length) final.payload.killedOrphans = killedOrphans;
  console.log(JSON.stringify(final.payload));
  if (final.exitCode !== 0) process.exit(final.exitCode);
}

// ══════════════════════════════════════════════════════════════════════
// #637 可归档二次验证闸（纯决策在 archive-exec.mjs）
// ══════════════════════════════════════════════════════════════════════

function queryPrStateLive(pr) {
  const r = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'state'], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  return parsePrStateOutput({
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error,
  }, pr);
}

/** #826：生产归档轮询读 reviews。失败 unscanned，不许当已 approve。 */
export function queryPrReviewsLive(pr) {
  const r = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'reviews'], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  return parsePrReviewsOutput({
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error,
  }, pr);
}

function removeWorktreeLive(selector) {
  const r = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'dao.mjs'),
    'worktree-rm',
    '--worktree',
    String(selector),
    '--force',
  ], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    cwd: ROOT,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return {
      ok: false,
      error: String(r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim().slice(0, 240),
    };
  }
  return { ok: true };
}

function escalateArchiveLive({ subject, body }) {
  return runOrca([
    'orchestration', 'send',
    '--type', 'escalation',
    '--subject', subject,
    '--body', body,
    '--json',
  ]);
}

function commentGithubLive({ pr, body }) {
  if (!pr) return { ok: false, error: '没有 PR 号，无法写 GitHub 评论' };
  const r = ghAs('marshal', ['pr', 'comment', String(pr), '--body', String(body || '')]);
  if (!r.ok) {
    return { ok: false, error: r.error || `gh pr comment exit ${r.status}` };
  }
  return { ok: true };
}

const archiveCommentStore = new Set();
// PR #758：worktree-rm 连败计数（限量后转只升级，不每轮重试刷屏）
const archiveRmAttempts = new Map();

function runArchiveReady(messages, logPath) {
  try {
    const results = processArchiveNotices(messages, {
      queryPrState: queryPrStateLive,
      listWorktrees,
      removeWorktree: removeWorktreeLive,
      escalate: escalateArchiveLive,
      commentGithub: commentGithubLive,
      commentStore: archiveCommentStore,
      rmAttemptStore: archiveRmAttempts,
      now: new Date(),
    });
    if (results.length) {
      appendFileSync(logPath, `${results.map((row) => formatArchiveExecLog(row)).join('\n')}\n`, 'utf8');
      console.log(`${READY_MARK} archive=${results.length} ${results.map((row) => row.result).join(',')}`);
    }
    return results;
  } catch (e) {
    console.error(`${READY_MARK} archive 异常: ${String(e?.message || e).slice(0, 200)}`);
    return [];
  }
}

/** #826：生产归档扫描。queryPrReviews 必传——缺了 working/waiting 永远验不到 APPROVED。 */
export function runMergedScanWith({
  worktrees,
  queryPrState,
  queryPrReviews,
  removeWorktree,
  escalate,
  commentGithub,
  commentStore,
  rmAttemptStore,
  now = new Date(),
} = {}) {
  if (typeof queryPrReviews !== 'function') {
    return {
      ok: false,
      unscanned: true,
      error: 'runMergedScan 没给 queryPrReviews（没查成，不许当已 approve）',
      results: [],
    };
  }
  return processMergedScan({
    worktrees,
    queryPrState,
    queryPrReviews,
    removeWorktree,
    escalate,
    commentGithub,
    commentStore,
    rmAttemptStore,
    now,
  });
}

function runMergedScan(logPath) {
  const listed = listWorktrees();
  if (!listed.ok || !Array.isArray(listed.worktrees)) {
    const err = listed.error || '盘面 worktree 列表没查成';
    console.error(`${READY_MARK} MERGED_SCAN_UNSCANNED: ${err}——不是扫到 0`);
    try {
      appendFileSync(logPath, `${formatMergedScanLog({ ok: false, error: err })}\n`, 'utf8');
    } catch { /* 日志写失败不能把扫描失败装成扫到 0 */ }
    return { ok: false, unscanned: true, error: err, results: [] };
  }
  try {
    const scan = runMergedScanWith({
      worktrees: listed.worktrees,
      queryPrState: queryPrStateLive,
      queryPrReviews: queryPrReviewsLive,
      removeWorktree: removeWorktreeLive,
      escalate: escalateArchiveLive,
      commentGithub: commentGithubLive,
      commentStore: archiveCommentStore,
      rmAttemptStore: archiveRmAttempts,
      now: new Date(),
    });
    appendFileSync(logPath, `${formatMergedScanLog(scan)}\n`, 'utf8');
    const n = (scan.results || []).length;
    if (n) {
      console.log(`${READY_MARK} merged-scan=${n} ${scan.results.map((row) => row.result).join(',')}`);
    } else {
      console.log(`${READY_MARK} merged-scan=0 scanned=${scan.trees ?? 0}`);
    }
    return scan;
  } catch (e) {
    console.error(`${READY_MARK} MERGED_SCAN_UNSCANNED: ${String(e?.message || e).slice(0, 200)}`);
    return { ok: false, unscanned: true, results: [] };
  }
}

// ══════════════════════════════════════════════════════════════════════
// relay（跑在哑终端里，单台轮询全部在途 Run）
// ══════════════════════════════════════════════════════════════════════

async function cmdRelay(args) {
  const logPath = resolveLogPath(args.log, null);
  mkdirSync(dirname(logPath), { recursive: true });
  const leaseTtlMs = args.timeoutMs + LEASE_GRACE_MS;
  const pollMs = Math.max(2000, args.timeoutMs);
  const startupRev = recordStartupRevision({ cwd: ROOT });

  console.log(`${READY_MARK} run=all log=${logPath}`);
  persistLease(logPath, null, leaseTtlMs);

  let seen = new Set();
  let consecutiveBoardFail = 0;
  for (;;) {
    try {
      haltIfStale(checkGuardRevision({ startup: startupRev, cwd: ROOT }), { tag: '[inbox] STALE_CODE' });
      persistLease(logPath, null, leaseTtlMs);
      const board = loadBoard();
      if (!board.ok) {
        consecutiveBoardFail += 1;
        console.error(`${READY_MARK} 盘面失败(${consecutiveBoardFail}): ${board.error}`);
        await sleep(Math.min(30000, 2000 * consecutiveBoardFail));
        continue;
      }
      consecutiveBoardFail = 0;
      const terminals = listTerminals();
      const active = activeRunIds({
        runs: board.runs,
        workers: board.workers,
        worktrees: board.worktrees,
        terminals: terminals.ok ? terminals.terminals : [],
      });
      // 日志回读已写 id + 本进程已见过的 id，双保险去重（#638：inbox 无 ack，靠去重防重复落盘/重复归档）
      seen = new Set([...seen, ...readLoggedIds(logPath)]);
      const inbox = inboxMessages();
      persistLease(logPath, null, leaseTtlMs);
      if (!inbox.ok) {
        console.error(`${READY_MARK} inbox 失败: ${inbox.error}`);
        await sleep(pollMs);
        continue;
      }
      const relevant = relevantMessages(inbox.messages, active, seen);
      const { loggable, heartbeats } = splitMessages(relevant);
      if (loggable.length) {
        appendFileSync(logPath, `${loggable.map((m) => formatLogLine(m)).join('\n')}\n`, 'utf8');
        for (const m of loggable) if (m.id) seen.add(m.id);
        console.log(`${READY_MARK} logged=${loggable.length} heartbeat=${heartbeats.length} runs=${active.size}`);
      } else if (heartbeats.length) {
        console.log(`${READY_MARK} heartbeat=${heartbeats.length} (not logged) runs=${active.size}`);
      } else {
        console.log(`${READY_MARK} idle runs=${active.size}`);
      }
      runArchiveReady(loggable, logPath);
      runMergedScan(logPath);
      persistLease(logPath, null, leaseTtlMs);
    } catch (e) {
      console.error(`${READY_MARK} relay 异常: ${String(e?.message || e).slice(0, 200)}`);
    }
    await sleep(pollMs);
  }
}

function cmdRetire(args) {
  if (!args.run) {
    console.log(JSON.stringify({ ok: false, error: 'retire 要 --run' }));
    process.exit(1);
  }
  const shown = runOrca(['orchestration', 'run-show', '--id', args.run, '--json']);
  if (!shown.ok) {
    const text = errText(shown.error);
    const state = /run_not_found/i.test(text) ? 'run_not_found' : 'unscanned';
    console.log(JSON.stringify({ ok: false, state, runId: args.run, error: text }));
    process.exit(1);
  }
  const logPath = resolveLogPath(args.log, args.run);
  const listed = listTerminals();
  if (!listed.ok) {
    console.log(JSON.stringify({ ok: false, unscanned: true, runId: args.run, error: `terminal list 失败: ${errText(listed.error)}` }));
    process.exit(1);
  }
  const leaseFile = leasePath(logPath);
  let lease = null;
  let leaseRead = 'missing';
  if (existsSync(leaseFile)) {
    lease = parseLease(readFileSync(leaseFile, 'utf8'));
    if (!lease) {
      console.log(JSON.stringify({ ok: false, unscanned: true, runId: args.run, error: `租约坏了 ${leaseFile}` }));
      process.exit(1);
    }
    leaseRead = 'ok';
  }
  const target = resolveStationCloseTarget({
    runId: args.run,
    lease,
    leaseRead,
    coordinatorHandle: shown.json?.result?.run?.coordinator_handle || null,
    terminals: listed.terminals,
    previewHandles: previewHandlesForRun(listed.terminals, args.run),
  });
  if (!target.ok) {
    console.log(JSON.stringify({ ok: false, unscanned: !!target.unscanned, runId: args.run, error: target.error }));
    process.exit(1);
  }
  const plan = planStationRetire({
    runId: args.run,
    closeHandle: target.closeHandle,
    files: [leasePath(logPath), launchFilePath(logPath), logPath],
  });
  // 双杀：关终端之外，租约 PID 活着就杀（detached/残留 relay 进程；killRelayPid 核对命令行拒误杀）
  let killed = null;
  if (lease && lease.pid && isProcessAlive(lease.pid)) {
    killed = killRelayPid(lease.pid);
  }
  const applied = applyStationRetire(plan, {
    closeTerminal: (h) => runOrca(['terminal', 'close', '--terminal', h, '--tab', '--json']),
    unlink: unlinkSync,
  });
  if (killed) applied.killed = killed;
  console.log(JSON.stringify(applied));
  if (!applied.ok) process.exit(1);
}

function printUsage() {
  console.log(`用法：
  node scripts/inbox-station.mjs ensure [--log <path>] [--gc-threshold <n>]
  node scripts/inbox-station.mjs relay  [--log <path>] [--timeout-ms <n>]
  node scripts/inbox-station.mjs retire --run <id> [--log <path>]

  ensure  #638 + 2026-08-23 detached：只保活一台 detached 中继进程（不占面板）
          活性 = 全局租约 _flow/inbox.lease（新鲜 + PID 在 + 命令行是本脚本 relay）
          action: ok(all-alive/closed-extra) / rebuild(no-station / no-global-station / detached-migration / stale-guard)
          多余活台（旧模型 per-run 台 / 旧式终端台）幂等关掉；证不出身份的租约不动（绝不误关）
          成功后只读 run-gc（#614）：僵尸数超阈值在 stdout 最前打一行，--apply 仍手动
          #667：不 run-use（--from 台会 attested 错身份）
  relay  detached 后台进程：每轮读 orchestration inbox（跨 Run，不绑 coordinator，不 run-use），
          只收活跃 Run（在途 keep ∪ 活 coordinator）的信，去重落盘非 heartbeat，
          跑可归档加速闸 + 每轮 MERGED 扫描收树（可归档不是门）
          默认日志 _flow/inbox.log（单台一张日志）；诊断输出 _flow/inbox.out.log
  retire  关指定 Run 的信箱台并删租约（run-gc --apply 用；旧模型 per-run 台）
          关台身份看租约 TTL/handle（过期直接 alreadyGone；未过期证不出就失败）`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    console.error(String(e.message || e));
    printUsage();
    process.exit(2);
  }
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (args.cmd !== 'retire') {
    bootGuardOrHalt({
      repoRoot: ROOT,
      scriptFile: import.meta.url,
      argv: process.argv.slice(2),
    });
  }
  if (args.cmd === 'relay') return cmdRelay(args);
  if (args.cmd === 'retire') return cmdRetire(args);
  return cmdEnsure(args);
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((e) => {
    console.error(String(e?.stack || e));
    process.exit(1);
  });
}