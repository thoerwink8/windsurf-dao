// scripts/lib/dispatch-lock.mjs —— 执行体建树段互斥锁（#849）
//
// 13 个执行体同时 spawn 会一起写共用 .git/config（extensions.worktreeConfig），
// 撞「could not lock config file .git/config: File exists」。
// 消歧：执行体建树段加锁串行（最小改），不改异步架构为单进程消费。
//
// 实现：O_EXCL 锁文件（Linux flock 语义的可移植等价；本仓零依赖，node:fs 没有 flockSync）。
// 锁文件默认 ~/.dao/locks/dispatch-worktree.lock（仓外）。内容写持锁 pid，
// 持锁进程已死 → 拆过期锁（kill -9 不释放）。pid 读不出（open 到 write 之间被杀）或 pid 被无关进程
// 复用时 pidAlive 判不出死活，兜底看锁文件 mtime：超过 staleMs 一律当过期拆（建树只要秒级，
// 10 分钟远超正常持锁）。staleMs=0 关掉 mtime 判据、只信 pid。测试注入 lockPath / open / stat / pidAlive。

import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_LOCK_REL = ['.dao', 'locks', 'dispatch-worktree.lock'];
export const DEFAULT_TIMEOUT_MS = 120000;
export const DEFAULT_STALE_MS = 10 * 60 * 1000;

export function defaultLockPath({ home = homedir() } = {}) {
  return join(home, ...DEFAULT_LOCK_REL);
}

function defaultPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; } // 存在但没权限 = 还活着
}

function sleep(ms) {
  const t = Date.now() + Math.max(0, ms);
  while (Date.now() < t) { /* 短自旋：锁等待以 50ms 为步 */ }
}

function readLockPid(path, { read = readFileSync, exists = existsSync } = {}) {
  if (!exists(path)) return null;
  try {
    const n = Number(String(read(path, 'utf8')).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

/** 锁文件年龄（ms）；stat 不成（刚被别人拆掉）→ null，不当过期。 */
function lockAgeMs(path, { stat = statSync, now = Date.now } = {}) {
  try {
    const st = stat(path);
    const mtime = Number(st && st.mtimeMs);
    return Number.isFinite(mtime) ? Math.max(0, now() - mtime) : null;
  } catch { return null; }
}

/**
 * 拿排他锁。返回 { ok, path, release }；release 必须在 finally 调。
 * 超时 → ok:false。持锁 pid 已死、或锁文件 mtime 超过 staleMs → 拆过期锁再抢。
 */
export function acquireWorktreeLock({
  lockPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  staleMs = DEFAULT_STALE_MS,
  now = Date.now,
  open = openSync,
  close = closeSync,
  write = writeFileSync,
  read = readFileSync,
  mkdir = mkdirSync,
  unlink = unlinkSync,
  exists = existsSync,
  stat = statSync,
  pidAlive = defaultPidAlive,
  sleepFn = sleep,
  pid = process.pid,
} = {}) {
  const path = lockPath || defaultLockPath();
  try { mkdir(dirname(path), { recursive: true }); } catch { /* 目录已在 */ }

  const t0 = now();
  while (now() - t0 < timeoutMs) {
    try {
      const fd = open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { write(fd, String(pid)); } catch { /* pid 写不上不挡持锁 */ }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try { close(fd); } catch { /* ignore */ }
        try { unlink(path); } catch { /* ignore */ }
      };
      // process.exit()（fail/failCreated）不跑 finally，靠 exit 钩子放锁。
      if (typeof process !== 'undefined' && typeof process.once === 'function') {
        process.once('exit', release);
      }
      return { ok: true, path, release };
    } catch (e) {
      const code = e && e.code;
      if (code !== 'EEXIST') {
        return { ok: false, error: `建树锁打不开 ${path}：${String(e.message || e)}` };
      }
      const holder = readLockPid(path, { read, exists });
      const dead = holder != null && !pidAlive(holder);
      // 年龄用真实时钟对 mtime，不用注入的 now（那是给超时循环的假钟）；测试改 stat 控年龄。
      const age = staleMs > 0 ? lockAgeMs(path, { stat }) : null;
      const expired = age != null && age >= staleMs;
      if (dead || expired) {
        try { unlink(path); } catch { /* 别人抢先拆了 */ }
        continue;
      }
      sleepFn(50);
    }
  }
  return { ok: false, error: `建树锁等超时（${timeoutMs}ms）：${path}` };
}

/** 同步包一段建树回调：拿到锁才跑，无论成败都放锁。fail()/throw 也会放锁。 */
export function withWorktreeLockSync(fn, opts = {}) {
  const got = acquireWorktreeLock(opts);
  if (!got.ok) return { ok: false, error: got.error, locked: false };
  try {
    return fn();
  } finally {
    try { got.release(); } catch { /* ignore */ }
  }
}

/** 包一段建树回调：拿到锁才跑，无论成败都放锁。fn 可同步或 Promise。 */
export async function withWorktreeLock(fn, opts = {}) {
  const got = acquireWorktreeLock(opts);
  if (!got.ok) return { ok: false, error: got.error, locked: false };
  try {
    return await fn();
  } finally {
    try { got.release(); } catch { /* ignore */ }
  }
}
