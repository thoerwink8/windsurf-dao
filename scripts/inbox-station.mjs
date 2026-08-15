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

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ORCA_TIMEOUT_MS = 30000;
const READY_WAIT_MS = 30000;
const READY_POLL_MS = 1000;

export const TITLE = '信箱台（勿关）';
export const READY_MARK = 'INBOX_STATION_READY';
export const DEFAULT_LOG_REL = join('_flow', 'inbox.log');
export const LEASE_NAME = 'inbox-station.lease';
// 无租约自带 ttl 时的默认窗口：覆盖默认 check --wait 15s + 余量
export const LEASE_TTL_MS = 25000;
export const LEASE_GRACE_MS = 10000;

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
  if (!['ensure', 'relay'].includes(args.cmd)) {
    throw new Error(`未知命令: ${args.cmd}（只要 ensure / relay）`);
  }
  return args;
}

export function findInboxTerminal(terminals) {
  if (!Array.isArray(terminals)) return null;
  return terminals.find((t) => String(t?.title || '').includes(TITLE)) || null;
}

export function leasePath(logPath) {
  return join(dirname(logPath || DEFAULT_LOG_REL), LEASE_NAME);
}

export function formatLease({ pid, runId, ts, ttlMs }) {
  return `${JSON.stringify({
    pid,
    runId: runId ?? null,
    ts,
    ttlMs: ttlMs ?? LEASE_TTL_MS,
  })}\n`;
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
    return {
      pid,
      ts,
      runId: obj.runId ?? null,
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

// 活性只认「租约未过期 + PID 仍在」。READY 行 / 脚本名 / check 字样是历史屏面，
// relay 退回 shell 后仍会留在 preview，不能当活。
export function isRelayAlive(terminal, opts = {}) {
  if (!terminal || terminal.connected === false || terminal.orphaned === true) return false;
  const lease = opts.lease ?? null;
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs;
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
  if (!coordinatorHandle || coordinatorHandle !== handle) {
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

export function decideEnsureAction({ terminal, relayAlive, coordinatorHandle }) {
  if (!terminal) return { action: 'rebuild', reason: 'no-terminal' };
  if (!relayAlive) return { action: 'rebuild', reason: 'relay-dead' };
  // 被夺走也走重建：run-use --from 从 ensure 进程调用会绑错终端
  // （实测绑到新 pwsh，不是 --from 指定的信箱台）。夺回必须在信箱台
  // 自己的 PTY 里执行 run-use，而 --command 启动串是唯一不污染 stdin 的入口。
  if (!coordinatorHandle || coordinatorHandle !== terminal.handle) {
    return { action: 'rebuild', reason: 'coordinator-stolen' };
  }
  return { action: 'ok', reason: 'all-alive' };
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

export function pickRun(runs, { preferredId, currentId } = {}) {
  const list = Array.isArray(runs) ? runs : [];
  const alive = (r) => r && r.legacy !== 1 && r.legacy !== true && r.id !== 'run_legacy_local';
  if (preferredId) {
    const hit = list.find((r) => r.id === preferredId);
    if (hit) return hit;
  }
  if (currentId) {
    const hit = list.find((r) => r.id === currentId && alive(r));
    if (hit) return hit;
  }
  return list
    .filter(alive)
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
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (typeof e === 'object') return e.code ? `orca 报错 ${e.code}: ${e.message}` : String(e.message || e);
  return '';
}

export function parseOrcaStdout(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return { ok: false, error: 'orca 无输出' };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    // 有时 stdout 夹了非 JSON 行，取最后一段像 JSON 的
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return { ok: true, json: JSON.parse(text.slice(start, end + 1)) };
      } catch { /* fall through */ }
    }
    return { ok: false, error: `orca 输出不是 JSON: ${text.slice(0, 160)}` };
  }
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
  const picked = pickRun(listed.runs, { preferredId, currentId: currentRunId() });
  if (!picked) return { ok: false, error: '找不到可绑定的编排 Run（run-list 空或只剩 legacy）' };
  return { ok: true, runId: picked.id };
}

function resolveLogPath(arg) {
  if (arg) return resolve(arg);
  const listed = listWorktrees();
  const main = findMainWorktree(listed.worktrees);
  const base = main?.path || ROOT;
  return join(base, DEFAULT_LOG_REL);
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

function persistLease(logPath, runId, ttlMs = LEASE_TTL_MS) {
  writeFileSync(leasePath(logPath), formatLease({
    pid: process.pid,
    runId,
    ts: Date.now(),
    ttlMs,
  }), 'utf8');
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
  const launchPath = join(dirname(logPath), 'inbox-station.cmd');
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
  if (old?.handle) {
    runOrca(['terminal', 'close', '--terminal', old.handle, '--tab', '--json']);
    await sleep(800);
  }
  const launchPath = writeLaunchFile(logPath, runId);
  const cmd = buildRelayCommand({ launchPath });
  const created = runOrca([
    'terminal', 'create',
    '--worktree', worktree,
    '--title', TITLE,
    '--command', cmd,
    '--json',
  ]);
  if (!created.ok) return { ok: false, error: `terminal create 失败: ${errText(created.error)}` };
  const handle = extractHandle(created.json);
  if (!handle) return { ok: false, error: `terminal create 没返回 handle: ${JSON.stringify(created.json).slice(0, 200)}` };
  runOrca(['terminal', 'rename', '--terminal', handle, '--title', TITLE, '--json']);
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
  const logPath = resolveLogPath(args.log);
  mkdirSync(dirname(logPath), { recursive: true });

  const listed = listTerminals();
  if (!listed.ok) {
    console.log(JSON.stringify({ ok: false, error: `terminal list 失败: ${errText(listed.error)}` }));
    process.exit(1);
  }
  const terminal = findInboxTerminal(listed.terminals);
  const relayAlive = isRelayAlive(terminal, { lease: loadLease(logPath) });
  const shown = showRun(runId);
  const decision = decideEnsureAction({
    terminal,
    relayAlive,
    coordinatorHandle: shown.run?.coordinator_handle || null,
  });

  let handle = terminal?.handle || null;
  let action = decision.action;
  let reason = decision.reason;

  if (decision.action === 'rebuild') {
    const rebuilt = await rebuildStation({
      old: terminal,
      runId,
      logPath,
      worktree: resolveCreateWorktree(args.worktree),
    });
    if (!rebuilt.ok) {
      console.log(JSON.stringify({ ok: false, error: rebuilt.error, action, reason }));
      process.exit(1);
    }
    handle = rebuilt.handle;
  }

  const afterShow = showRun(runId);
  const afterList = listTerminals();
  const afterTerm = (afterList.terminals || []).find((t) => t.handle === handle)
    || findInboxTerminal(afterList.terminals);
  const final = finalizeEnsure({
    runShowOk: afterShow.ok,
    coordinatorHandle: afterShow.run?.coordinator_handle || null,
    handle,
    relayAlive: isRelayAlive(afterTerm, { lease: loadLease(logPath) }),
    runId,
    logPath,
    action,
    reason,
  });
  console.log(JSON.stringify(final.payload));
  if (final.exitCode !== 0) process.exit(final.exitCode);
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
  const logPath = resolveLogPath(args.log);
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

function printUsage() {
  console.log(`用法：
  node scripts/inbox-station.mjs ensure [--run <id>] [--log <path>] [--worktree <sel>]
  node scripts/inbox-station.mjs relay  [--run <id>] [--log <path>] [--timeout-ms <n>]

  ensure  幂等保证哑终端 + 中继 + coordinator 归属；全活着秒退，stdout 一行 JSON
  relay   跑在哑终端内：每轮 run-use 自夺回 → check --wait → 写日志 → ack
          heartbeat 只 ack 不写日志；默认日志 _flow/inbox.log`);
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
