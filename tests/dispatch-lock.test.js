// 建树段互斥锁 + 僵尸 .running 清扫（#849）
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const LOCK = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'dispatch-lock.mjs').replace(/\\/g, '/'));
const DQ = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'dispatch-queue.mjs').replace(/\\/g, '/'));
const LOCK_SRC = path.join(__dirname, '..', 'scripts', 'lib', 'dispatch-lock.mjs');

describe('acquireWorktreeLock：互斥 + 死进程拆锁', () => {
  it('第二个拿不到，release 后才能拿', async () => {
    const { acquireWorktreeLock } = await LOCK;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-wtlock-'));
    const lockPath = path.join(dir, 'dispatch-worktree.lock');
    const a = acquireWorktreeLock({ lockPath, timeoutMs: 200, sleepFn: () => {} });
    assert.equal(a.ok, true, '第一个应拿到');
    const b = acquireWorktreeLock({ lockPath, timeoutMs: 80, sleepFn: () => {} });
    assert.equal(b.ok, false, '第二个应超时');
    a.release();
    const c = acquireWorktreeLock({ lockPath, timeoutMs: 200, sleepFn: () => {} });
    assert.equal(c.ok, true, '放锁后第三个应拿到');
    c.release();
  });

  it('持锁 pid 已死 → 拆过期锁再抢', async () => {
    const { acquireWorktreeLock } = await LOCK;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-wtlock-dead-'));
    const lockPath = path.join(dir, 'dispatch-worktree.lock');
    fs.writeFileSync(lockPath, '999999');
    const r = acquireWorktreeLock({
      lockPath, timeoutMs: 500, sleepFn: () => {},
      pidAlive: () => false,
    });
    assert.equal(r.ok, true, '死 pid 应拆锁让出  →  ' + JSON.stringify(r));
    r.release();
  });
});

// staleMs 兜底：pid 读不出 / pid 被无关活进程复用时 pidAlive 判不出，靠 mtime 年龄拆锁。
describe('acquireWorktreeLock：staleMs 过期锁按 mtime 拆', () => {
  const MIN = 60 * 1000;
  const statAged = (ageMs) => () => ({ mtimeMs: Date.now() - ageMs });

  it('pid 读不出 + mtime 超 staleMs → 拆锁拿到', async () => {
    const { acquireWorktreeLock } = await LOCK;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-wtlock-stale-nopid-'));
    const lockPath = path.join(dir, 'dispatch-worktree.lock');
    fs.writeFileSync(lockPath, ''); // open 到 write 之间被杀：锁在、pid 空
    const r = acquireWorktreeLock({
      lockPath, timeoutMs: 300, staleMs: 10 * MIN, sleepFn: () => {},
      stat: statAged(11 * MIN), pidAlive: () => { throw new Error('pid 空不该问 pidAlive'); },
    });
    assert.equal(r.ok, true, '空 pid 的老锁应按 mtime 拆  →  ' + JSON.stringify(r));
    r.release();
  });

  it('pid 读不出 + mtime 还新 → 不拆，等到超时', async () => {
    const { acquireWorktreeLock } = await LOCK;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-wtlock-fresh-nopid-'));
    const lockPath = path.join(dir, 'dispatch-worktree.lock');
    fs.writeFileSync(lockPath, '');
    const r = acquireWorktreeLock({
      lockPath, timeoutMs: 60, staleMs: 10 * MIN, sleepFn: () => {},
      stat: statAged(1 * MIN),
    });
    assert.equal(r.ok, false, '新锁不该被拆  →  ' + JSON.stringify(r));
    assert.match(String(r.error), /超时/);
    assert.equal(fs.existsSync(lockPath), true, '锁文件应原样留着');
  });

  it('pid 活着（可能是复用的无关进程）+ mtime 超 staleMs → 仍拆锁', async () => {
    const { acquireWorktreeLock } = await LOCK;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-wtlock-stale-alive-'));
    const lockPath = path.join(dir, 'dispatch-worktree.lock');
    fs.writeFileSync(lockPath, String(process.pid));
    const r = acquireWorktreeLock({
      lockPath, timeoutMs: 300, staleMs: 10 * MIN, sleepFn: () => {},
      stat: statAged(11 * MIN), pidAlive: () => true,
    });
    assert.equal(r.ok, true, '超龄锁不管 pid 活不活都拆  →  ' + JSON.stringify(r));
    r.release();
  });

  it('staleMs=0 关掉 mtime 判据：pid 活着的老锁不拆', async () => {
    const { acquireWorktreeLock } = await LOCK;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-wtlock-stale-off-'));
    const lockPath = path.join(dir, 'dispatch-worktree.lock');
    fs.writeFileSync(lockPath, String(process.pid));
    let statCalls = 0;
    const r = acquireWorktreeLock({
      lockPath, timeoutMs: 60, staleMs: 0, sleepFn: () => {},
      stat: () => { statCalls += 1; return { mtimeMs: 0 }; }, pidAlive: () => true,
    });
    assert.equal(r.ok, false, 'staleMs=0 只信 pid  →  ' + JSON.stringify(r));
    assert.equal(statCalls, 0, 'staleMs=0 不该 stat');
  });

  it('默认 staleMs 是 10 分钟（真实 stat 路径）：刚写的锁不被拆', async () => {
    const { acquireWorktreeLock, DEFAULT_STALE_MS } = await LOCK;
    assert.equal(DEFAULT_STALE_MS, 10 * MIN);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-wtlock-default-'));
    const lockPath = path.join(dir, 'dispatch-worktree.lock');
    fs.writeFileSync(lockPath, String(process.pid));
    const r = acquireWorktreeLock({ lockPath, timeoutMs: 60, sleepFn: () => {}, pidAlive: () => true });
    assert.equal(r.ok, false, '刚写的活锁默认不拆  →  ' + JSON.stringify(r));
  });
});

describe('判别性实验：并发 3 进程抢锁全部成功，临界区不重叠', () => {
  it('3 个子进程同时抢同一把锁，全部进临界区且 maxInside=1', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-wtlock-3p-'));
    const lockPath = path.join(dir, 'dispatch-worktree.lock');
    const logPath = path.join(dir, 'inside.log');
    const worker = path.join(dir, 'worker.mjs');
    fs.writeFileSync(worker, `
import { acquireWorktreeLock } from ${JSON.stringify('file://' + LOCK_SRC.replace(/\\\\/g, '/'))};
const lockPath = process.argv[2];
const logPath = process.argv[3];
const id = process.argv[4];
const got = acquireWorktreeLock({ lockPath, timeoutMs: 8000 });
if (!got.ok) { console.error('LOCK_FAIL ' + id + ' ' + got.error); process.exit(2); }
const { appendFileSync } = await import('node:fs');
appendFileSync(logPath, 'in ' + id + ' ' + Date.now() + '\\n');
await new Promise((r) => setTimeout(r, 80));
appendFileSync(logPath, 'out ' + id + ' ' + Date.now() + '\\n');
got.release();
`);
    const kids = [1, 2, 3].map((id) => spawn(process.execPath, [worker, lockPath, logPath, String(id)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const codes = await Promise.all(kids.map((c) => new Promise((resolve) => {
      let err = '';
      c.stderr.on('data', (d) => { err += d; });
      c.on('exit', (code) => resolve({ code, err }));
    })));
    assert.ok(codes.every((c) => c.code === 0), '三进程都应成功  →  ' + JSON.stringify(codes));
    const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\n/);
    assert.equal(lines.length, 6, '3 in + 3 out  →  ' + lines.join('|'));
    let inside = 0;
    let maxInside = 0;
    for (const line of lines) {
      if (line.startsWith('in ')) inside += 1;
      else if (line.startsWith('out ')) inside -= 1;
      maxInside = Math.max(maxInside, inside);
    }
    assert.equal(maxInside, 1, '临界区同时只许 1 个（串行化生效）');
  });
});

describe('reapStaleDispatchRunning：pid 死 / 超时 → 补 out.json 清 .running', () => {
  it('pid 已死 → 写 crashed out.json 并删 .running', async () => {
    const { writeDispatchOrder, dispatchOrderPaths, reapStaleDispatchRunning } = await DQ;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-reap-'));
    const id = 'dq-reap-dead';
    writeDispatchOrder({ dir, id, now: new Date(), args: {}, plan: {}, dedup: {} });
    const paths = dispatchOrderPaths(dir, id);
    fs.writeFileSync(paths.running, JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
    const r = reapStaleDispatchRunning(dir, { alive: () => false });
    assert.equal(r.ok, true);
    assert.equal(r.reaped.length, 1);
    assert.equal(r.reaped[0].reason, 'pid-dead');
    assert.equal(fs.existsSync(paths.running), false, '.running 应删');
    const out = JSON.parse(fs.readFileSync(paths.result, 'utf8'));
    assert.equal(out.ok, false);
    assert.equal(out.crashed, true);
  });

  it('pid 还活着且未超时 → 不动', async () => {
    const { writeDispatchOrder, dispatchOrderPaths, reapStaleDispatchRunning } = await DQ;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-reap-live-'));
    const id = 'dq-reap-live';
    writeDispatchOrder({ dir, id, now: new Date(), args: {}, plan: {}, dedup: {} });
    const paths = dispatchOrderPaths(dir, id);
    fs.writeFileSync(paths.running, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    const r = reapStaleDispatchRunning(dir, { alive: () => true, staleMs: 60 * 60 * 1000 });
    assert.equal(r.ok, true);
    assert.equal(r.reaped.length, 0);
    assert.equal(fs.existsSync(paths.running), true);
    assert.equal(fs.existsSync(paths.result), false);
  });
});

describe('判别性：执行体 SIGTERM → out.json 有失败记录', () => {
  it('子进程写 .running 后被 SIGTERM，crash guard 落 crashed', {
    // Windows 没有信号：child.kill('SIGTERM') 直接 TerminateProcess，处理器跑不到，等价 kill -9
    // （那条路归 reapStaleDispatchRunning 验）。执行体只跑 Linux（Contabo / CI），此形态只在那里验。
    skip: process.platform === 'win32' ? 'Windows 无 SIGTERM 处理器，只在 Linux 验' : false,
  }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-sigterm-'));
    const script = path.join(dir, 'crash-guard.mjs');
    const runner = path.join(dir, 'runner.mjs');
    const running = path.join(dir, 'dq-x.running');
    const result = path.join(dir, 'dq-x.out.json');
    fs.writeFileSync(script, `
import { writeFileSync, unlinkSync } from 'node:fs';
const running = process.argv[2];
const result = process.argv[3];
writeFileSync(running, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
const once = (why) => {
  writeFileSync(result, JSON.stringify({ ok: false, crashed: true, error: why }));
  try { unlinkSync(running); } catch {}
};
process.on('SIGTERM', () => { once('执行体收到 SIGTERM'); process.exit(1); });
setTimeout(() => {}, 30000);
`);
    fs.writeFileSync(runner, `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
const script = process.argv[2];
const running = process.argv[3];
const result = process.argv[4];
const child = spawn(process.execPath, [script, running, result], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 250));
child.kill('SIGTERM');
await new Promise((r) => child.once('exit', r));
if (!existsSync(result)) { console.error('NO_RESULT'); process.exit(2); }
const out = JSON.parse(readFileSync(result, 'utf8'));
if (out.ok !== false || out.crashed !== true) { console.error(JSON.stringify(out)); process.exit(3); }
if (existsSync(running)) { console.error('RUNNING_LEFT'); process.exit(4); }
console.log('ok');
`);
    const child = spawnSync(process.execPath, [runner, script, running, result], {
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.match(child.stdout, /ok/);
  });
});
