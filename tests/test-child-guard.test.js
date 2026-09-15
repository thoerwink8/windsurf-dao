// tests/test-child-guard.test.js —— dao-check 测试子进程不许活过 dao-check
//
// 起因（2026-09-15 实咬）：本机 8 GB 内存里 5.98 GB 是一个孤儿
// `node --test tests/session-events.test.js`，PPID=1，已跑 1 天 11 小时 28 分。
// 那套测试单独跑是干净的；坏的是 dao-check 的 runOneSuite——没超时、没信号处理、
// 退出不清理。判据与两层分工见 scripts/lib/test-child-guard.mjs 头部。

import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import {
  DEFAULT_SUITE_TIMEOUT_MS, SUITE_TIMEOUT_ENV, SLOWEST_SUITE_OBSERVED_MS,
  OWNER_PID_ENV, OWNER_TOKEN_ENV, OWNER_TOKEN, OWNER_POLL_ENV, OWNER_POLL_MS,
  OWNER_STARTTIME_ENV, OWNER_BOOT_ENV, ORPHAN_EXIT_CODE,
  suiteTimeoutMs, timeoutNote, createChildRegistry, ownerAlive, ownerPollMs, orphanNote,
  descendantPids, killProcessTree, listLinuxProcesses,
  readProcStarttime, readProcBootId, formatOwnerToken, parseOwnerIdentity,
} from '../scripts/lib/test-child-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const DAO_CHECK = readFileSync(join(REPO, 'scripts', 'dao-check.mjs'), 'utf8');

describe('每套超时的刻度', () => {
  it('不设环境变量 = 默认 10 分钟', () => {
    assert.deepEqual(suiteTimeoutMs({}), { ms: DEFAULT_SUITE_TIMEOUT_MS, source: 'default' });
  });

  it('默认值相对实测最慢的一套留了 10 倍以上余量——余量不够的闸一定被关掉', () => {
    assert.ok(DEFAULT_SUITE_TIMEOUT_MS / SLOWEST_SUITE_OBSERVED_MS > 10,
      `默认 ${DEFAULT_SUITE_TIMEOUT_MS}ms / 最慢实测 ${SLOWEST_SUITE_OBSERVED_MS}ms`);
  });

  it('环境变量给数就用数', () => {
    assert.deepEqual(suiteTimeoutMs({ [SUITE_TIMEOUT_ENV]: '5000' }), { ms: 5000, source: 'env' });
  });

  it('0 = 显式关掉超时，回到出事前的行为', () => {
    assert.deepEqual(suiteTimeoutMs({ [SUITE_TIMEOUT_ENV]: '0' }), { ms: 0, source: 'disabled' });
  });

  it('写错的环境变量退回默认，且 source 认得出是写错了——「用户关掉」和「写错被忽略」不是一回事', () => {
    const got = suiteTimeoutMs({ [SUITE_TIMEOUT_ENV]: '十分钟' });
    assert.equal(got.ms, DEFAULT_SUITE_TIMEOUT_MS);
    assert.equal(got.source, 'bad-env');
    assert.equal(got.raw, '十分钟');
  });

  it('负数也算写错', () => {
    assert.equal(suiteTimeoutMs({ [SUITE_TIMEOUT_ENV]: '-1' }).source, 'bad-env');
  });

  it('空串当没设', () => {
    assert.equal(suiteTimeoutMs({ [SUITE_TIMEOUT_ENV]: '   ' }).source, 'default');
  });
});

describe('超时说明', () => {
  const note = timeoutNote('foo.test.js', 600000);

  it('说清这是没查成不是测试红', () => {
    assert.match(note, /没查成/);
  });

  it('给得出复现命令', () => {
    assert.match(note, /node --test tests\/foo\.test\.js/);
  });

  it('给得出放宽的办法', () => {
    assert.match(note, new RegExp(SUITE_TIMEOUT_ENV));
  });
});

describe('子进程注册表', () => {
  it('登记后能数出来', () => {
    const r = createChildRegistry({ kill: () => {} });
    r.add(111, { label: 'a.test.js' });
    r.add(222, { label: 'b.test.js' });
    assert.equal(r.size, 2);
  });

  it('退出的登记要能摘掉——摘不掉就会去杀一个已经复用给别人的 pid', () => {
    const r = createChildRegistry({ kill: () => {} });
    r.add(111);
    r.remove(111);
    assert.equal(r.size, 0);
  });

  it('非法 pid 不收', () => {
    const r = createChildRegistry({ kill: () => {} });
    assert.equal(r.add(undefined), false);
    assert.equal(r.add(0), false);
    assert.equal(r.add(-5), false);
    assert.equal(r.size, 0);
  });

  it('杀的是登记的那个 pid，不是它的进程组（负 pid 会连累 acp-runtime 的 pgid 判据）', () => {
    const sent = [];
    const r = createChildRegistry({ kill: (pid, sig) => sent.push([pid, sig]) });
    r.add(111);
    r.killAll('SIGKILL');
    assert.deepEqual(sent, [[111, 'SIGKILL']]);
  });

  it('有 listProcesses 时，连非 detached 后代一起杀，进程组头留下', () => {
    const sent = [];
    const r = createChildRegistry({
      kill: (pid, sig) => sent.push([pid, sig]),
      listProcesses: () => [
        { pid: 20, ppid: 1, pgid: 1 },
        { pid: 21, ppid: 20, pgid: 1 },
        { pid: 30, ppid: 20, pgid: 30 },
        { pid: 31, ppid: 30, pgid: 30 },
      ],
    });
    r.add(20);
    r.killAll('SIGKILL');
    assert.deepEqual(sent.map((x) => x[0]).sort((a, b) => a - b), [20, 21]);
  });

  it('杀的时候已经没了（ESRCH）算 missing，不算失败', () => {
    const r = createChildRegistry({ kill: () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; } });
    r.add(111);
    const got = r.killAll();
    assert.deepEqual(got.missing, [111]);
    assert.deepEqual(got.killed, []);
    assert.deepEqual(got.failed, []);
  });

  it('权限之类的错要进 failed 让人看见——静默吞掉就等于「清理过了」的假绿', () => {
    const r = createChildRegistry({ kill: () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; } });
    r.add(111);
    const got = r.killAll();
    assert.equal(got.failed.length, 1);
    assert.equal(got.failed[0].pid, 111);
  });

  it('杀完清空——第二次 killAll 不许重复发信号', () => {
    const sent = [];
    const r = createChildRegistry({ kill: (pid) => sent.push(pid) });
    r.add(111);
    r.killAll();
    r.killAll();
    assert.deepEqual(sent, [111]);
  });

  it('真去杀一个真的进程：登记 → killAll → 它真的没了', async () => {
    const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    assert.equal(alive(victim.pid), true, '现在应该还活着——不然这条测试什么都没验到');

    const r = createChildRegistry();
    r.add(victim.pid);
    const got = r.killAll('SIGKILL');
    assert.deepEqual(got.killed, [victim.pid]);

    await new Promise((res) => setTimeout(res, 300));
    assert.equal(alive(victim.pid), false);
  });
});

describe('子进程侧：爹没了就别活着', () => {
  it('starttime 对得上 ⇒ 爹还在', () => {
    const got = ownerAlive({
      pid: 4242,
      starttime: '12345',
      bootId: 'boot-1',
      readStarttime: () => '12345',
      readBootId: () => 'boot-1',
    });
    assert.deepEqual(got, { alive: true, basis: 'starttime' });
  });

  it('pid 还在但 starttime 变了 ⇒ 判死。35 小时足够 pid 被复用，光探存活会把孤儿判成合法子进程', () => {
    const got = ownerAlive({
      pid: 4242,
      starttime: '12345',
      readStarttime: () => '99999',
      probe: () => {},
    });
    assert.deepEqual(got, { alive: false, basis: 'starttime-mismatch' });
  });

  it('同 token 但不是当初那个 owner：cmdline 碰巧带 dao-check 也判死', () => {
    const got = ownerAlive({
      pid: 4242,
      token: OWNER_TOKEN,
      starttime: '111',
      readStarttime: () => '222',
      readCmdline: () => 'node\0/tmp/not-the-owner-dao-check-helper.mjs\0',
      probe: () => {},
    });
    assert.deepEqual(got, { alive: false, basis: 'starttime-mismatch' });
  });

  it('cmdline 碰巧带 dao-check 不能当 owner 证据', () => {
    const got = ownerAlive({
      pid: 4242,
      readCmdline: () => 'node\0/tmp/not-the-owner-dao-check-helper.mjs\0',
      probe: () => {},
    });
    assert.notDeepEqual(got, { alive: true, basis: 'cmdline' });
    assert.deepEqual(got, { alive: true, basis: 'probe' });
  });

  it('固定子串 dao-check 解析不出身份', () => {
    assert.deepEqual(parseOwnerIdentity({ token: OWNER_TOKEN }), { starttime: '', bootId: '' });
    assert.deepEqual(parseOwnerIdentity({ token: 'boot-1:12345' }), { starttime: '12345', bootId: 'boot-1' });
    assert.equal(formatOwnerToken({ bootId: 'boot-1', starttime: '12345' }), 'boot-1:12345');
  });

  it('读不到 /proc（非 Linux）⇒ 退回存活探，并说明是退回的', () => {
    const got = ownerAlive({ pid: 4242, starttime: '111', readStarttime: () => null, probe: () => {} });
    assert.deepEqual(got, { alive: true, basis: 'probe' });
  });

  it('读不到 /proc 且探到 ESRCH ⇒ 判死', () => {
    const got = ownerAlive({
      pid: 4242,
      readStarttime: () => null,
      probe: () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; },
    });
    assert.deepEqual(got, { alive: false, basis: 'probe' });
  });

  it('没记 owner pid ⇒ 当爹还在（手敲 node --test 不受影响）', () => {
    assert.deepEqual(ownerAlive({}), { alive: true, basis: 'no-owner' });
  });

  it('探本身报了别的错 ⇒ 当爹还在。判不出来就别杀——误杀正在跑的测试比漏掉孤儿糟得多', () => {
    const got = ownerAlive({
      pid: 4242,
      readStarttime: () => null,
      probe: () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; },
    });
    assert.deepEqual(got, { alive: true, basis: 'probe-error' });
  });

  it('readStarttime 自己抛了也不许炸，退回探', () => {
    const got = ownerAlive({
      pid: 4242,
      starttime: '111',
      readStarttime: () => { throw new Error('boom'); },
      probe: () => {},
    });
    assert.equal(got.alive, true);
    assert.equal(got.basis, 'probe');
  });

  it('轮询间隔默认 30s、可用环境变量调——调不了就验不了这层', () => {
    assert.equal(ownerPollMs({}), OWNER_POLL_MS);
    assert.equal(ownerPollMs({ [OWNER_POLL_ENV]: '100' }), 100);
    assert.equal(ownerPollMs({ [OWNER_POLL_ENV]: 'x' }), OWNER_POLL_MS);
  });

  it('孤儿退出说明里带 pid 和退出码', () => {
    const note = orphanNote(4242, 'cmdline-mismatch');
    assert.match(note, /4242/);
    assert.match(note, new RegExp(String(ORPHAN_EXIT_CODE)));
  });
});

describe('预加载闸装上之后的真实行为', () => {
  const preload = pathToFileURL(join(REPO, 'tests', 'helpers', 'parent-alive.mjs')).href;

  it('爹还在时：什么都不做，不打印一个字，也不拖慢退出', () => {
    const starttime = readProcStarttime(process.pid) || '';
    const bootId = readProcBootId() || '';
    const r = spawnSync(process.execPath, ['-e', 'console.log("hi")'], {
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        [OWNER_PID_ENV]: String(process.pid),
        [OWNER_TOKEN_ENV]: formatOwnerToken({ bootId, starttime }),
        [OWNER_STARTTIME_ENV]: starttime,
        [OWNER_BOOT_ENV]: bootId,
        [OWNER_POLL_ENV]: '50',
        NODE_OPTIONS: `--import ${preload}`,
      },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'hi\n');
    assert.equal(r.stderr, '');
  });

  let deadPid = 0;

  it('没记 owner pid 时：整个模块 no-op', () => {
    const env = { ...process.env, NODE_OPTIONS: `--import ${preload}` };
    delete env[OWNER_PID_ENV];
    const r = spawnSync(process.execPath, ['-e', 'console.log("hi")'], { encoding: 'utf8', timeout: 20000, env });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    // spawnSync 返回时这个进程已经死透了——顺手留下一个「确定不存在的 pid」给下一条用，
    // 省掉一次专门为造死 pid 的 spawn（spawn 预算是本仓的闸，能省一处是一处）。
    deadPid = r.pid;
  });

  it('爹没了时：挂住的子进程自己退出，退出码认得出是孤儿自杀', () => {
    assert.ok(deadPid > 0, '上一条没留下死 pid ⇒ 这条没在验它该验的东西');

    const r = spawnSync(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        [OWNER_PID_ENV]: String(deadPid),
        [OWNER_TOKEN_ENV]: OWNER_TOKEN,
        [OWNER_POLL_ENV]: '80',
        NODE_OPTIONS: `--import ${preload}`,
      },
    });
    assert.equal(r.status, ORPHAN_EXIT_CODE);
    assert.match(r.stderr, /孤儿/);
  });
});

test('owner 被 SIGKILL 时，卡在无 timeout 的同步调用里也必须退', { timeout: 15000 }, async () => {
  // 审官红项的判别实验：主线程定时器在同步子进程调用里排不上。
  // 树要跟生产一样——owner 是孩子的亲爹，不是兄弟。看门狗只给亲儿子装。
  const preload = pathToFileURL(join(REPO, 'tests', 'helpers', 'parent-alive.mjs')).href;
  const ownerPath = join(REPO, 'tests', 'helpers', 'dao-check-owner-fixture.mjs');
  const env = { ...process.env, DAO_SYNC_BLOCK_PRELOAD: preload, [OWNER_POLL_ENV]: '100' };
  delete env.NODE_TEST_CONTEXT;
  env.NODE_OPTIONS = '';

  const owner = spawn(process.execPath, [ownerPath], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env,
  });
  let out = '';
  owner.stdout.on('data', (d) => { out += d; });

  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  let childPid = 0;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    childPid = Number(String(out).trim());
    if (Number.isInteger(childPid) && childPid > 0) break;
    await wait(50);
  }
  assert.equal(Number.isInteger(childPid), true, `owner 没报出孩子 pid（stdout=${JSON.stringify(out)}）`);
  assert.equal(childPid > 0, true);

  await wait(500);
  assert.equal(alive(owner.pid), true, 'owner 现在该活着——不然 SIGKILL 验的是空气');
  assert.equal(alive(childPid), true, '孩子现在该卡在同步调用里——不然这条什么都没验到');

  process.kill(owner.pid, 'SIGKILL');
  const t0 = Date.now();
  while (alive(childPid) && Date.now() - t0 < 3000) await wait(50);
  assert.equal(alive(childPid), false, `owner SIGKILL 后 3s 孩子还在（elapsed ${Date.now() - t0}ms）——同步阻塞期间的清理没生效`);

  try { process.kill(owner.pid, 'SIGKILL'); } catch { /* 已经没了 */ }
  try { process.kill(childPid, 'SIGKILL'); } catch { /* 已经没了 */ }
});

describe('dao-check 里的接线（正控：接错了这几条要红）', () => {
  it('spawn 不许带 detached——它会把每套测试变成进程组头，acp-runtime 的 pgid 判据当场飘红', () => {
    assert.doesNotMatch(DAO_CHECK, /spawn\(cmd, args, \{[^}]*detached/);
  });

  it('spawn 出来的 pid 当场登记', () => {
    assert.match(DAO_CHECK, /testChildren\.add\(child\.pid/);
  });

  it('套子结束时摘登记', () => {
    assert.match(DAO_CHECK, /testChildren\.remove\(child\.pid\)/);
  });

  it('exit / SIGINT / SIGTERM 三条路都杀子进程', () => {
    assert.match(DAO_CHECK, /process\.on\('exit', \(\) => \{ testChildren\.killAll/);
    assert.match(DAO_CHECK, /\['SIGINT', 130\], \['SIGTERM', 143\]/);
  });

  it('装了信号处理器就得自己退——不自己退的话 dao-check 会被 Ctrl-C 后继续跑', () => {
    assert.match(DAO_CHECK, /killAll\('SIGKILL'\); process\.exit\(code\)/);
  });

  it('超时看门狗真的动手杀套子树', () => {
    assert.match(DAO_CHECK, /killProcessTree\(child\.pid/);
    assert.match(DAO_CHECK, /listProcesses:\s*listLinuxProcesses/);
  });

  it('超时报「没查成」，不报「测试红」——两者的下一步不一样', () => {
    assert.match(DAO_CHECK, /timedOut/);
    assert.match(DAO_CHECK, /fail\(`测试没查成：\$\{f\}（跑满/);
  });

  it('两道预加载都装上了：不出网 + 爹没了就自杀', () => {
    assert.match(DAO_CHECK, /no-network\.mjs/);
    assert.match(DAO_CHECK, /parent-alive\.mjs/);
    assert.match(DAO_CHECK, /--import \$\{pathToFileURL\(guard\)\.href\} --import \$\{pathToFileURL\(orphanGuard\)\.href\}/);
  });

  it('owner pid 传给子进程，否则子进程侧那层永远 no-op', () => {
    assert.match(DAO_CHECK, /\[OWNER_PID_ENV\]: String\(process.pid\)/);
    assert.match(DAO_CHECK, /OWNER_STARTTIME_ENV/);
    assert.match(DAO_CHECK, /OWNER_BOOT_ENV/);
  });

  it('子进程侧必须有同步阻塞期间也能用的清理，不许把未设 timeout 的 spawnSync 当成有界', () => {
    const src = readFileSync(join(REPO, 'tests', 'helpers', 'parent-alive.mjs'), 'utf8');
    assert.match(src, /owner-watchdog\.py/);
    assert.match(src, /process\.ppid/);
    assert.match(src, /OWNER_STARTTIME_ENV/);
    assert.doesNotMatch(src, /process\.dlopen/);
    assert.doesNotMatch(src, /每个 spawnSync 都自带 timeout/);
  });
});

describe('按套子清后代', () => {
  const procs = [
    { pid: 10, ppid: 1, pgid: 10 },
    { pid: 20, ppid: 10, pgid: 10 },
    { pid: 21, ppid: 20, pgid: 10 },
    { pid: 22, ppid: 21, pgid: 10 },
    { pid: 30, ppid: 20, pgid: 30 },
    { pid: 31, ppid: 30, pgid: 30 },
    { pid: 40, ppid: 10, pgid: 10 },
  ];

  it('runner 的非 detached 后代都在名单里', () => {
    assert.deepEqual(descendantPids(20, procs).sort((a, b) => a - b), [21, 22]);
  });

  it('刻意 detached 的 ACP 及其孩子不在名单里', () => {
    const got = descendantPids(20, procs);
    assert.equal(got.includes(30), false);
    assert.equal(got.includes(31), false);
  });

  it('不把别的套子算进来', () => {
    assert.equal(descendantPids(20, procs).includes(40), false);
  });

  it('killProcessTree 先杀后代再杀 root，组头不在名单', () => {
    const sent = [];
    const got = killProcessTree(20, {
      listProcesses: () => procs,
      kill: (pid, sig) => sent.push([pid, sig]),
    });
    assert.deepEqual(got.descendants.sort((a, b) => a - b), [21, 22]);
    assert.deepEqual(sent.map((x) => x[0]), [21, 22, 20]);
  });
});

test('看门狗真的砍得掉挂住的套子（端到端）', { timeout: 30000 }, async () => {
  // 造一套永远不结束的测试，照 runOneSuite 的形状起它，再让注册表动手。
  // 判据是「进程真的没了」，不是「函数返回了」。
  // （跑整个 dao-check 来验这件事要两分钟，太贵；那一层的证据在 PR 正文的违规样本里。）
  const dir = mkdtempSync(join(tmpdir(), 'dao-hang-'));
  try {
    const hang = join(dir, 'hang.test.js');
    // 空转的 Promise 不够：事件循环一空 node 自己就退了，那样测的是「它自己死了」。
    // 挂一个长定时器把循环撑住，才是真的挂住。
    writeFileSync(hang, "import {test} from 'node:test';\ntest('永不结束', async () => { await new Promise(() => { setTimeout(() => {}, 3600000); }); });\n");

    // NODE_TEST_CONTEXT 必须清掉：node 的测试运行器给子进程设了它，
    // 里层 `node --test` 继承到之后会以为自己就是那个被跑的测试文件，秒退 0。
    // 不清的话这条测试测的是「它自己死了」，跟看门狗一点关系都没有。
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', hang], {
      stdio: 'ignore', cwd: REPO, env,
    });
    const r = createChildRegistry();
    r.add(child.pid);

    await new Promise((res) => setTimeout(res, 800));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    assert.equal(alive(child.pid), true, '挂住的套子现在应该还活着——不然这条测试什么都没验到');

    r.killAll('SIGKILL');
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(alive(child.pid), false, '看门狗该把它杀掉');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('套子超时后非 detached 后代必须没了，刻意 detached 的留下', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dao-hang-tree-'));
  const pidFile = join(dir, 'pids.json');
  let detachedPid = 0;
  try {
    const hang = join(dir, 'hang-tree.test.js');
    writeFileSync(hang, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('永不结束且留下后代', async () => {
  const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const d = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true });
  d.unref();
  writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ grandchild: g.pid, detached: d.pid }));
  await new Promise(() => { setTimeout(() => {}, 3600000); });
});
`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', hang], {
      stdio: 'ignore', cwd: REPO, env,
    });
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    let pids = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        pids = JSON.parse(readFileSync(pidFile, 'utf8'));
        if (pids.grandchild > 0 && pids.detached > 0) break;
      } catch { /* 还没写出 */ }
      await wait(50);
    }
    assert.equal(pids != null, true, 'runner 没写出 pids 文件');
    assert.equal(pids.grandchild > 0, true, `grandchild pid 非法：${JSON.stringify(pids)}`);
    assert.equal(pids.detached > 0, true, `detached pid 非法：${JSON.stringify(pids)}`);
    detachedPid = pids.detached;
    await wait(200);
    assert.equal(alive(child.pid), true, 'runner 现在该活着——不然这条验的是空气');
    assert.equal(alive(pids.grandchild), true, '非 detached 后代现在该活着——不然没验到残留');
    assert.equal(alive(pids.detached), true, 'detached 现在该活着——不然没验到「该留的留下」');

    killProcessTree(child.pid, { listProcesses: listLinuxProcesses });
    const t0 = Date.now();
    while ((alive(child.pid) || alive(pids.grandchild)) && Date.now() - t0 < 3000) await wait(50);
    assert.equal(alive(child.pid), false, 'runner 超时后自己必须没了');
    assert.equal(alive(pids.grandchild), false, 'runner 超时后非 detached 后代必须没了——不能只验 runner 消失');
    assert.equal(alive(pids.detached), true, '刻意 detached 的 ACP 类进程必须留下');
  } finally {
    if (detachedPid) {
      try { process.kill(detachedPid, 'SIGKILL'); } catch { /* 已经没了 */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
