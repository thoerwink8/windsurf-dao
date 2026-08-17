#!/usr/bin/env node
// scripts/inbox-station.mjs —— 信箱台幂等保证（issue #464）
//
// Orca「You have N orchestration messages」横幅强制接管用户输入框：消息到达即注入，
// ack 速度治不了。已实证的解法是把 Run 的 coordinator 绑到后台哑终端，横幅只注给它；
// 终端内中继 check --wait → 写日志 → 自动 ack，帅 tail 文件收信。
//
// 本脚本把手工四步收成一条幂等命令。全活着秒退；缺任何一环自动重建。
// 不用 stdin 注入（防输入污染）：重建走 terminal create --command。
//
// 关键实证（写进命令之前必须知道）：
//   - 终端换会话后 Run 绑定丢失（run_required）
//   - 新帅必须 run-use 才能 task-create，而 run-use 会夺走 coordinator
//   - 所以帅的派工序是「run-use → 派工 → ensure 归还」乒乓
//   - 同进程残留绑定可继续 task-create（ensure 夺回横幅后，帅本进程仍能发件）
//   - 中继每轮 check 前先 run-use 自夺回，防别的帅夺走后 check 变 consumer_fenced
//
// 用法：
//   node scripts/inbox-station.mjs ensure [--run <id>] [--log <path>]
//   node scripts/inbox-station.mjs relay  [--run <id>] [--log <path>]
//
// ensure stdout 一行 JSON：{ok, runId, handle, logPath, action, reason}
//
// 身份判据（issue #493 返工）：终端归属从 run-show 的 coordinator_handle 取得，
// 标题只出不进——标题仍带 run 后缀（信箱台·<run后缀>（勿关））但只是给人看的显示，
// ensure 的判定一律不读标题：标题被改名/被重置成 pwsh.exe 也不影响认台。
//   - 本 run 的台 = run-show(runId).coordinator_handle 对应的终端（租约新鲜+PID在+runId对）
//   - 撞上别的 run 的台（本 run coordinator 被别的 run 的活台占着）→ 拒绝顶替并报出对方 run id
//   - 默认日志 = _flow/inbox-<run后缀>.log，不传 --log 也天然按 run 隔离

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOrcaStdout } from './lib/orca-stdout.mjs';
import { orcaErrorText } from './lib/orca-error.mjs';
import {
  planStationRetire,
  applyStationRetire,
  resolveStationCloseTarget,
  previewHandlesForRun,
} from './lib/run-lifecycle.mjs';
export { parseOrcaStdout };

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ORCA_TIMEOUT_MS = 30000;
const READY_WAIT_MS = 30000;
const READY_POLL_MS = 1000;

// 旧裸标题（信箱台（勿关））只是历史格式的说明，判定路径一律不读标题（#493 返工：标题只出不进）。
export const TITLE = '信箱台（勿关）';
export const READY_MARK = 'INBOX_STATION_READY';
// 无 run 时的兜底日志（正常路径永远带 run，见 defaultLogRel）
export const DEFAULT_LOG_REL = join('_flow', 'inbox.log');
// 无租约自带 ttl 时的默认窗口：覆盖默认 check --wait 15s + 余量
export const LEASE_TTL_MS = 25000;
export const LEASE_GRACE_MS = 10000;

export function runShort(runId) {
  return String(runId || '').replace(/^run_/, '');
}

// 标题只出不进：仍生成带 run 后缀的标题给人看，但没有任何判定路径读标题。
export function stationTitle(runId) {
  return `信箱台·${runShort(runId)}（勿关）`;
}

// 默认日志按 run 隔离：_flow/inbox-<run后缀>.log。不传 --log 是这个脚本的最常见用法，
// 必须天然安全（issue #493：默认写死同一个 inbox.log 是「必混」隐患）。
export function defaultLogRel(runId) {
  const short = runShort(runId);
  return short ? join('_flow', `inbox-${short}.log`) : DEFAULT_LOG_REL;
}

// ══════════════════════════════════════════════════════════════════════
// 纯函数（单测直接 import，不经过 live orca）
// ══════════════════════════════════════════════════════════════════════

export function parseArgs(argv) {
  const args = {
    cmd: 'ensure',
    run: null,
    log: null,
    worktree: null,
    timeoutMs: 15000,
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
      case '--worktree': args.worktree = rest[++i] || ''; break;
      case '--timeout-ms': {
        const n = Number(rest[++i]);
        if (!Number.isFinite(n) || n <= 0) throw new Error('参数 --timeout-ms 需要正整数');
        args.timeoutMs = n;
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

// 身份从 run 层取：run-show(runId).coordinator_handle 指向谁，谁就是本 run 的台。
// 标题改名/被重置成 pwsh.exe 不影响——handle 是身份，标题是显示（#493 返工）。
export function findCoordinatorTerminal(terminals, coordinatorHandle) {
  if (!Array.isArray(terminals) || !coordinatorHandle) return null;
  return terminals.find((t) => t?.handle === coordinatorHandle) || null;
}

// 本 run 的中继活着 = 本 run 的租约新鲜 + PID 在 + runId 对。
// 与具体终端无关：中继每轮 run-use 自夺回，coordinator 被帅临时借走也会自己回来。
export function isStationAlive(lease, runId, opts = {}) {
  if (!lease || lease.runId !== runId) return false;
  return isLeaseFresh(lease, opts.now, opts.ttlMs) && isProcessAlive(lease.pid);
}

// 租约/启动脚本都落在日志同目录、按日志名区分：_flow/inbox-<run>.log →
// _flow/inbox-<run>.lease / _flow/inbox-<run>.cmd。默认日志按 run 隔离后，
// 这些伴生文件必须也按 run 隔离，否则两条 run 的台共写同一个 lease，
// 活性判断互相污染（issue #493：身份必须一路贯穿）。
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
    // EPERM：进程在，只是没权限发信号。ESRCH 才是不存在。
    return e && e.code === 'EPERM';
  }
}

// 活性只认「租约未过期 + PID 仍在 + （给了 runId 时）租约归属对」。
// READY 行 / 脚本名 / check 字样是历史屏面，relay 退回 shell 后仍会留在 preview，不能当活。
export function isRelayAlive(terminal, opts = {}) {
  if (!terminal || terminal.connected === false || terminal.orphaned === true) return false;
  const lease = opts.lease ?? null;
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs;
  const runId = opts.runId;
  if (runId && lease?.runId && lease.runId !== runId) return false;
  if (!isLeaseFresh(lease, now, ttlMs)) return false;
  return isProcessAlive(lease.pid);
}

export function decideReady({ terminal, lease, coordinatorHandle, now, ttlMs } = {}) {
  const handle = terminal?.handle || null;
  if (!handle) return { ok: false, error: 'no-terminal' };
  if (!isRelayAlive(terminal, { lease, now, ttlMs })) {
    return { ok: false, error: 'relay-not-alive' };
  }
  if (!coordinatorHandle || coordinatorHandle !== handle) {
    return { ok: false, error: 'coordinator-not-held' };
  }
  return { ok: true };
}

// rebuild 等就绪：超时不得降成 warning 成功。
export function acceptRebuildReady(ready) {
  if (!ready?.ok) {
    return { ok: false, error: ready?.error || '中继未就绪或 coordinator 未夺回' };
  }
  return { ok: true, handle: ready.handle || ready.terminal?.handle || null };
}

export function finalizeEnsure({
  runShowOk,
  coordinatorHandle,
  handle,
  relayAlive,
  runId,
  logPath,
  action,
  reason,
} = {}) {
  if (!relayAlive) {
    return {
      exitCode: 1,
      payload: statusPayload({
        ok: false,
        runId,
        handle,
        logPath,
        action,
        reason: 'relay-not-alive',
        error: '中继未存活',
        coordinatorHandle,
      }),
    };
  }
  if (!runShowOk) {
    return {
      exitCode: 1,
      payload: statusPayload({
        ok: false,
        runId,
        handle,
        logPath,
        action,
        reason: 'coordinator-unknown',
        error: 'run-show 失败',
        coordinatorHandle: coordinatorHandle || null,
      }),
    };
  }
  // all-alive 秒退：中继活着即可，coordinator 被借走不失败（也不改租约 handle）。
  // rebuild/restart 仍要夺回，否则新台横幅不在自己手里。
  if (action !== 'ok' && (!coordinatorHandle || coordinatorHandle !== handle)) {
    return {
      exitCode: 1,
      payload: statusPayload({
        ok: false,
        runId,
        handle,
        logPath,
        action,
        reason: 'coordinator-not-held',
        error: coordinatorHandle ? `coordinator 仍是 ${coordinatorHandle}` : 'coordinator 为空',
        coordinatorHandle: coordinatorHandle || null,
      }),
    };
  }
  return {
    exitCode: 0,
    payload: statusPayload({ ok: true, runId, handle, logPath, action, reason }),
  };
}

export function decideEnsureAction({ runId, coordinatorHandle, terminals, lease, foreignStation, now, ttlMs } = {}) {
  // 身份从 run 层独立取得：本 run 的台 = run-show 的 coordinator_handle 对应的终端，
  // 活不活看本 run 的租约（新鲜 + PID 在 + runId 对）。判定不读任何标题。
  const coordTerm = findCoordinatorTerminal(terminals, coordinatorHandle);
  const relayAlive = isStationAlive(lease, runId, { now, ttlMs });
  if (relayAlive) {
    // 中继活着即全活着：coordinator 若被帅临时借走，中继每轮 run-use 会自夺回。
    // 返回的 handle 只能是租约里已验证的台，不能是当前 coordinator（#601 审官红：借走时会污染租约）。
    return { action: 'ok', reason: 'all-alive', handle: (lease && lease.handle) || null };
  }
  // 本 run 的台死了或从没有过。coordinator 可能仍挂在死壳/帅的终端上。
  if (coordTerm) {
    if (foreignStation) {
      // 本 run 的 coordinator 被别的 run 的活台占着 → 拒绝顶替，报出对方 run id。
      return {
        action: 'reject',
        reason: 'foreign-station',
        foreignRunId: foreignStation.runId,
        foreignHandle: foreignStation.handle || coordTerm.handle,
      };
    }
    // coordinator 被非本 run 台的终端占着（帅的终端 / 死壳）：本 run 台死了就重启。
    if (lease && lease.runId === runId) return { action: 'restart', reason: 'relay-dead' };
    return { action: 'rebuild', reason: 'no-terminal' };
  }
  if (lease && lease.runId === runId) return { action: 'restart', reason: 'relay-dead' };
  return { action: 'rebuild', reason: 'no-terminal' };
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
    from: msg?.from_handle ?? msg?.fromHandle ?? null,
    to: msg?.to_handle ?? msg?.toHandle ?? null,
    subject: msg?.subject ?? '',
    body: msg?.body ?? '',
    payload: msg?.payload ?? null,
  });
}

export function parseCheckResult(json) {
  const result = json?.result ?? json ?? {};
  const messages =
    result.messages
    ?? result.delivery?.messages
    ?? result.batch?.messages
    ?? (Array.isArray(result) ? result : []);
  const deliveryId =
    result.delivery_id
    ?? result.deliveryId
    ?? result.delivery?.id
    ?? result.batch?.id
    ?? result.ack
    ?? json?.delivery_id
    ?? null;
  return {
    messages: Array.isArray(messages) ? messages : [],
    deliveryId: deliveryId || null,
  };
}

export function pickRun(runs, { preferredId, currentId, allowedIds } = {}) {
  const list = Array.isArray(runs) ? runs : [];
  const alive = (r) => r && r.legacy !== 1 && r.legacy !== true && r.id !== 'run_legacy_local';
  const allowed = allowedIds == null
    ? null
    : (allowedIds instanceof Set ? allowedIds : new Set(allowedIds));
  const allow = (r) => !allowed || allowed.has(r.id);
  if (preferredId) {
    const hit = list.find((r) => r.id === preferredId);
    if (hit) return hit;
  }
  if (currentId) {
    const hit = list.find((r) => r.id === currentId && alive(r) && allow(r));
    if (hit) return hit;
  }
  return list
    .filter((r) => alive(r) && allow(r))
    .slice()
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0] || null;
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

export function extractHandle(json) {
  return json?.result?.handle
    || json?.result?.terminal?.handle
    || json?.handle
    || json?.result?.startupTerminal?.handle
    || null;
}

export function buildLaunchScript({ nodePath, scriptPath, runId, logPath }) {
  // cmd.exe 脚本：先 run-use 再进中继。避免 pwsh 把带引号路径当表达式（ParserError）。
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  return [
    '@echo off',
    `orca orchestration run-use --id ${runId} --json`,
    `${q(nodePath)} ${q(scriptPath)} relay --run ${runId} --log ${q(logPath)}`,
    '',
  ].join('\r\n');
}

export function buildRelayCommand({ launchPath }) {
  return `cmd.exe /c ${quoteWin(launchPath)}`;
}

export function statusPayload({
  ok = true,
  runId,
  handle,
  logPath,
  action,
  reason,
  error,
  coordinatorHandle,
} = {}) {
  const payload = { ok, runId, handle, logPath, action, reason };
  if (error) payload.error = error;
  if (coordinatorHandle != null) payload.coordinatorHandle = coordinatorHandle;
  return payload;
}

export function quoteWin(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

// ══════════════════════════════════════════════════════════════════════
// orca 封装
// ══════════════════════════════════════════════════════════════════════

function errText(e) {
  return orcaErrorText(e);
}

function runOrca(cmdArgs, timeout = ORCA_TIMEOUT_MS) {
  const r = spawnSync('orca', cmdArgs, { encoding: 'utf8', timeout, windowsHide: true });
  if (r.error || (r.status !== 0 && r.status != null)) {
    if (r.stdout) {
      const parsed = parseOrcaStdout(r.stdout);
      if (parsed.ok && parsed.json?.error) return { ok: false, error: parsed.json.error, json: parsed.json };
      if (parsed.ok && parsed.json?.ok === false) return { ok: false, error: parsed.json.error || parsed.json, json: parsed.json };
    }
    return { ok: false, error: String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 240) };
  }
  const parsed = parseOrcaStdout(r.stdout);
  if (!parsed.ok) return parsed;
  if (parsed.json?.ok === false) return { ok: false, error: parsed.json.error || parsed.json, json: parsed.json };
  return { ok: true, json: parsed.json };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnOrca(cmdArgs, timeout) {
  return new Promise((resolvePromise) => {
    const child = spawn('orca', cmdArgs, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, timeout);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out, err });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolvePromise({ code: 1, out, err: String(e.message || e) });
    });
  });
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
  const r = runOrca(['worktree', 'list', '--json']);
  if (!r.ok) return { ok: false, error: r.error, worktrees: [] };
  const worktrees = unwrapOrca(r.json, 'worktrees') || unwrapOrca(r.json, 'items') || [];
  return { ok: Array.isArray(worktrees), worktrees: Array.isArray(worktrees) ? worktrees : [], error: r.error };
}

function listRuns() {
  const r = runOrca(['orchestration', 'run-list', '--json']);
  if (!r.ok) return { ok: false, error: r.error, runs: [] };
  const runs = unwrapOrca(r.json, 'runs');
  return { ok: Array.isArray(runs), runs: Array.isArray(runs) ? runs : [], error: r.error };
}

function listWorkers() {
  const r = runOrca(['orchestration', 'worker-list', '--json']);
  if (!r.ok) return { ok: false, error: r.error, workers: [] };
  const workers = unwrapOrca(r.json, 'workers');
  return { ok: Array.isArray(workers), workers: Array.isArray(workers) ? workers : [], error: r.error };
}

function inFlightRunIds(workers) {
  const ids = new Set();
  for (const w of Array.isArray(workers) ? workers : []) {
    if (!w?.runId) continue;
    const st = w.dispatchStatus;
    const ws = w.workerState;
    if (st === 'dispatched' || st === 'running' || ws === 'ready' || ws === 'working' || ws === 'waiting') {
      ids.add(w.runId);
    }
  }
  return ids;
}

function currentRunId() {
  const r = runOrca(['orchestration', 'run-current', '--json']);
  if (!r.ok) return null;
  const run = unwrapOrca(r.json, 'run');
  return run?.id || null;
}

function showRun(runId) {
  const r = runOrca(['orchestration', 'run-show', '--id', runId, '--json']);
  if (!r.ok) return { ok: false, error: r.error, run: null };
  return { ok: true, run: unwrapOrca(r.json, 'run') };
}

function resolveRunId(preferredId) {
  const listed = listRuns();
  if (!listed.ok && preferredId) return { ok: true, runId: preferredId };
  if (!listed.ok) return { ok: false, error: `run-list 失败: ${errText(listed.error)}` };
  const workers = preferredId ? { ok: true, workers: [] } : listWorkers();
  const allowedIds = preferredId ? null : (workers.ok ? inFlightRunIds(workers.workers) : null);
  const picked = pickRun(listed.runs, {
    preferredId,
    currentId: currentRunId(),
    allowedIds,
  });
  if (!picked) {
    return {
      ok: false,
      error: preferredId
        ? `找不到可绑定的编排 Run（run-list 空或只剩 legacy）`
        : '没有在途单的 Run，不建台（ensure 不再认最新墓碑，避免实验/孤儿 Run 再起一台）',
    };
  }
  return { ok: true, runId: picked.id };
}

function resolveLogPath(arg, runId) {
  if (arg) return resolve(arg);
  const listed = listWorktrees();
  const main = findMainWorktree(listed.worktrees);
  const base = main?.path || ROOT;
  return join(base, defaultLogRel(runId));
}

function resolveCreateWorktree(arg) {
  if (arg) return arg;
  const listed = listWorktrees();
  const main = findMainWorktree(listed.worktrees);
  if (main?.id) return main.id;
  if (main?.path) return `path:${main.path}`;
  return 'active';
}

// ══════════════════════════════════════════════════════════════════════
// ensure / rebuild / reclaim
// ══════════════════════════════════════════════════════════════════════

function loadLease(logPath) {
  try {
    return parseLease(readFileSync(leasePath(logPath), 'utf8'));
  } catch {
    return null;
  }
}

export function mergeLeaseHandle(prev, nextHandle) {
  return nextHandle || (prev && prev.handle) || null;
}

/** 租约 handle 只来自创建出来的信箱台。ensure 活着时不得用当前 coordinator 覆写。 */
export function acceptLeaseHandleStamp({ prevHandle, nextHandle, source } = {}) {
  if (!nextHandle) return false;
  if (source === 'rebuild') return true;
  if (prevHandle && prevHandle === nextHandle) return true;
  return false;
}

function persistLease(logPath, runId, ttlMs = LEASE_TTL_MS, handle) {
  const prev = loadLease(logPath);
  writeFileSync(leasePath(logPath), formatLease({
    pid: process.pid,
    runId,
    ts: Date.now(),
    ttlMs,
    handle: mergeLeaseHandle(prev, handle),
  }), 'utf8');
}

function stampLeaseHandle(logPath, handle) {
  if (!handle) return;
  const prev = loadLease(logPath);
  if (!prev) return;
  writeFileSync(leasePath(logPath), formatLease({ ...prev, handle }), 'utf8');
}

async function waitReady(handle, { runId, logPath, timeoutMs = READY_WAIT_MS } = {}) {
  const t0 = Date.now();
  let lastError = '中继未就绪或 coordinator 未夺回';
  while (Date.now() - t0 < timeoutMs) {
    const listed = listTerminals();
    const mine = (listed.terminals || []).find((t) => t.handle === handle) || null;
    const shown = runId ? showRun(runId) : { ok: false, run: null };
    const ready = decideReady({
      terminal: mine || { handle, connected: true },
      lease: loadLease(logPath),
      coordinatorHandle: shown.run?.coordinator_handle || null,
    });
    if (ready.ok && mine) return { ok: true, terminal: mine };
    lastError = ready.error || lastError;
    await sleep(READY_POLL_MS);
  }
  return { ok: false, error: `等 ${timeoutMs}ms ${lastError}` };
}

function writeLaunchFile(logPath, runId) {
  const launchPath = launchFilePath(logPath);
  mkdirSync(dirname(launchPath), { recursive: true });
  writeFileSync(launchPath, buildLaunchScript({
    nodePath: process.execPath,
    scriptPath: SCRIPT_PATH,
    runId,
    logPath,
  }), 'utf8');
  return launchPath;
}

async function rebuildStation({ old, runId, logPath, worktree }) {
  // old 只在调用方能验证归属时才传（本版 ensure 一律传 null：归属从 run-show 取，
  // 标题只出不进无法反查旧台；新台的启动脚本 run-use 会自行夺回 coordinator，
  // 死壳/帅的终端留在场上无害，绝不误关不是自己的终端）。
  if (old?.handle) {
    runOrca(['terminal', 'close', '--terminal', old.handle, '--tab', '--json']);
    await sleep(800);
  }
  const launchPath = writeLaunchFile(logPath, runId);
  const cmd = buildRelayCommand({ launchPath });
  const title = stationTitle(runId);
  const created = runOrca([
    'terminal', 'create',
    '--worktree', worktree,
    '--title', title,
    '--command', cmd,
    '--json',
  ]);
  if (!created.ok) return { ok: false, error: `terminal create 失败: ${errText(created.error)}` };
  const handle = extractHandle(created.json);
  if (!handle) return { ok: false, error: `terminal create 没返回 handle: ${JSON.stringify(created.json).slice(0, 200)}` };
  runOrca(['terminal', 'rename', '--terminal', handle, '--title', title, '--json']);
  const ready = await waitReady(handle, { runId, logPath });
  return acceptRebuildReady({ ...ready, handle });
}

async function cmdEnsure(args) {
  const runResolved = resolveRunId(args.run);
  if (!runResolved.ok) {
    console.log(JSON.stringify({ ok: false, error: runResolved.error }));
    process.exit(1);
  }
  const runId = runResolved.runId;
  const logPath = resolveLogPath(args.log, runId);
  mkdirSync(dirname(logPath), { recursive: true });

  const listed = listTerminals();
  if (!listed.ok) {
    console.log(JSON.stringify({ ok: false, error: `terminal list 失败: ${errText(listed.error)}` }));
    process.exit(1);
  }
  // 身份从 run 层独立取得：本 run 的台 = coordinator_handle 对应的终端；判定不读标题。
  const shown = showRun(runId);
  const coordinatorHandle = shown.run?.coordinator_handle || null;
  const lease = loadLease(logPath);
  const coordTerm = findCoordinatorTerminal(listed.terminals, coordinatorHandle);
  const relayAlive = isStationAlive(lease, runId);
  const foreignStation = !relayAlive && coordTerm
    ? await findForeignStation(coordTerm, runId)
    : null;
  const decision = decideEnsureAction({
    runId,
    coordinatorHandle,
    terminals: listed.terminals,
    lease,
    foreignStation,
  });

  let handle = (lease && lease.handle) || decision.handle || null;
  let action = decision.action;
  let reason = decision.reason;

  if (decision.action === 'reject') {
    console.log(JSON.stringify({
      ok: false,
      runId,
      logPath,
      action: 'reject',
      reason: 'foreign-station',
      foreignRunId: decision.foreignRunId,
      foreignHandle: decision.foreignHandle,
      error: `本 run 的 coordinator 被别的 run 的信箱台占着（${decision.foreignRunId ?? '未知'}），拒绝顶替`,
    }));
    process.exit(1);
  }

  if (decision.action === 'rebuild' || decision.action === 'restart') {
    const rebuilt = await rebuildStation({
      old: null,
      runId,
      logPath,
      worktree: resolveCreateWorktree(args.worktree),
    });
    if (!rebuilt.ok) {
      console.log(JSON.stringify({ ok: false, error: rebuilt.error, action, reason }));
      process.exit(1);
    }
    handle = rebuilt.handle;
    if (acceptLeaseHandleStamp({
      prevHandle: loadLease(logPath)?.handle || null,
      nextHandle: handle,
      source: 'rebuild',
    })) {
      stampLeaseHandle(logPath, handle);
    }
  } else if (acceptLeaseHandleStamp({
    prevHandle: (lease && lease.handle) || null,
    nextHandle: handle,
    source: 'ensure',
  })) {
    stampLeaseHandle(logPath, handle);
  }

  const afterShow = showRun(runId);
  const afterList = listTerminals();
  const afterTerm = (afterList.terminals || []).find((t) => t.handle === handle)
    || findCoordinatorTerminal(afterList.terminals, afterShow.run?.coordinator_handle || null);
  const final = finalizeEnsure({
    runShowOk: afterShow.ok,
    coordinatorHandle: afterShow.run?.coordinator_handle || null,
    handle,
    relayAlive: isRelayAlive(afterTerm, { lease: loadLease(logPath), runId }),
    runId,
    logPath,
    action,
    reason,
  });
  console.log(JSON.stringify(final.payload));
  if (final.exitCode !== 0) process.exit(final.exitCode);
}

// 只在「本 run 台死 + coordinator 还挂在某个终端上」时查：那个终端是不是别的 run 的活台。
// 身份全部从 run-show / 各 run 的租约取，不读标题。
async function findForeignStation(coordTerm, runId) {
  if (!coordTerm) return null;
  const listed = listRuns();
  if (!listed.ok) return null;
  for (const r of Array.isArray(listed.runs) ? listed.runs : []) {
    if (!r?.id || r.id === runId || r.legacy) continue;
    const shown = showRun(r.id);
    if (!shown.ok || shown.run?.coordinator_handle !== coordTerm.handle) continue;
    const yLease = loadLease(resolveLogPath(null, r.id));
    if (isStationAlive(yLease, r.id)) {
      return { runId: r.id, handle: coordTerm.handle };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// relay（跑在哑终端里）
// ══════════════════════════════════════════════════════════════════════

async function waitCheck({ ackId, timeoutMs }) {
  const args = ['orchestration', 'check', '--wait', '--timeout-ms', String(timeoutMs), '--json'];
  if (ackId) args.push('--ack', ackId);
  return spawnOrca(args, timeoutMs + 15000);
}

async function cmdRelay(args) {
  const runResolved = resolveRunId(args.run);
  if (!runResolved.ok) {
    console.error(`inbox-station relay: ${runResolved.error}`);
    process.exit(1);
  }
  const runId = runResolved.runId;
  const logPath = resolveLogPath(args.log, runId);
  mkdirSync(dirname(logPath), { recursive: true });
  const leaseTtlMs = args.timeoutMs + LEASE_GRACE_MS;

  console.log(`${READY_MARK} run=${runId} log=${logPath}`);
  persistLease(logPath, runId, leaseTtlMs);

  let lastAck = null;
  for (;;) {
    persistLease(logPath, runId, leaseTtlMs);
    const used = runOrca(['orchestration', 'run-use', '--id', runId, '--json']);
    if (!used.ok) {
      console.error(`${READY_MARK} run-use 失败: ${errText(used.error)}`);
      await sleep(2000);
      continue;
    }
    console.log(`${READY_MARK} run-use ok run=${runId}`);
    persistLease(logPath, runId, leaseTtlMs);

    const waited = await waitCheck({ ackId: lastAck, timeoutMs: args.timeoutMs });
    persistLease(logPath, runId, leaseTtlMs);
    const parsed = parseOrcaStdout(waited.out);
    if (!parsed.ok) {
      // 超时空转也算活着：租约已在 wait 前后续期，PID 仍在即可
      console.error(`${READY_MARK} check 无 JSON: ${(waited.err || waited.out || '').slice(0, 160)}`);
      lastAck = null;
      continue;
    }
    if (parsed.json?.ok === false) {
      const code = parsed.json?.error?.code || '';
      console.error(`${READY_MARK} check 失败: ${errText(parsed.json.error)}`);
      if (code === 'consumer_fenced' || code === 'run_required') lastAck = null;
      await sleep(1000);
      continue;
    }

    const { messages, deliveryId } = parseCheckResult(parsed.json);
    const { loggable, heartbeats } = splitMessages(messages);
    if (loggable.length) {
      appendFileSync(logPath, `${loggable.map((m) => formatLogLine(m)).join('\n')}\n`, 'utf8');
      console.log(`${READY_MARK} logged=${loggable.length} heartbeat=${heartbeats.length}`);
    } else if (heartbeats.length) {
      console.log(`${READY_MARK} heartbeat=${heartbeats.length} (acked, not logged)`);
    } else {
      console.log(`${READY_MARK} idle`);
    }
    lastAck = deliveryId || null;
  }
}

function cmdRetire(args) {
  if (!args.run) {
    console.log(JSON.stringify({ ok: false, error: 'retire 要 --run' }));
    process.exit(1);
  }
  const shown = showRun(args.run);
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
  const pidAlive = lease && lease.pid ? isProcessAlive(lease.pid) : null;
  const target = resolveStationCloseTarget({
    runId: args.run,
    lease,
    leaseRead,
    pidAlive,
    coordinatorHandle: shown.run?.coordinator_handle || null,
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
  const applied = applyStationRetire(plan, {
    closeTerminal: (h) => runOrca(['terminal', 'close', '--terminal', h, '--tab', '--json']),
    unlink: unlinkSync,
  });
  console.log(JSON.stringify(applied));
  if (!applied.ok) process.exit(1);
}

function printUsage() {
  console.log(`用法：
  node scripts/inbox-station.mjs ensure [--run <id>] [--log <path>] [--worktree <sel>]
  node scripts/inbox-station.mjs relay  [--run <id>] [--log <path>] [--timeout-ms <n>]
  node scripts/inbox-station.mjs retire --run <id> [--log <path>]

  ensure  幂等保证哑终端 + 中继 + coordinator 归属；全活着秒退，stdout 一行 JSON
          action: rebuild(本 run 无台新建) / restart(本 run 台死了重启) / reject(撞上别的 run 的台)
          身份从 run-show 的 coordinator_handle 取，标题只出不进（改名/重置不影响认台）
          不传 --run 时只认在途 dispatch 的 Run，不认最新墓碑（#593）
  relay   跑在哑终端内：每轮 run-use 自夺回 → check --wait → 写日志 → ack
          heartbeat 只 ack 不写日志；默认日志 _flow/inbox-<run后缀>.log，按 run 隔离
  retire  关该 Run 的信箱台并删租约（orca 没有 run-delete；退役后墓碑仍在 run-list）
          关台身份看租约 PID/runId/handle（或 preview 唯一命中），不看 coordinator_handle
          证不出且 PID 还活着就失败，不许只删文件；alreadyGone 看 close 结果不是列表条数`);
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
