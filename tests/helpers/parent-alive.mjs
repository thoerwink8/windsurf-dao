// tests/helpers/parent-alive.mjs —— 测试子进程的「爹没了就自杀」闸（预加载模块）
//
// 为什么要它：见 scripts/lib/test-child-guard.mjs 头部（2026-09-15，一个孤儿
// `node --test` 占了 5.98 GB、活了 35 小时）。那边的父进程侧超时管不了
// 「父进程被 SIGKILL」这一种——定时器跟父进程一起没了。这一层管得了。
//
// 怎么装：`NODE_OPTIONS=--import <本文件>`，与 no-network.mjs 同一条路
// （dao-check 的 runOneSuite 里接线）。NODE_OPTIONS 继承给子进程，所以测试
// spawn 出去的 CLI 同样被罩住——孤儿常常正是那一层。
//
// 三条自律，都是为了不给测试添乱：
//   · 定时器 unref：绝不因为它而让任何进程多活一毫秒。
//   · 快乐路径一个字都不打印：测试会断言子进程的 stdout/stderr。
//   · 判不出来就当爹还在（fail-open）：误杀正在跑的测试，比漏掉一个孤儿糟得多。
//
// 没有 DAO_CHECK_OWNER_PID 时整个模块什么都不做——手敲 `node --test` 不受影响。
//
// 主线程定时器管不到「卡在同步调用里」（事件循环不转）。仓内现有测试大量
// spawnSync 没设 timeout，不能把「同步段有界」当前提（2026-09-15 审官红项：
// SIGKILL owner 后 dao-dispatch-gate.test.js 以 PPID=1 继续活，正卡在无
// timeout 的 spawnSync 上）。
//
// 旁路看门狗（owner-watchdog.py）有自己的事件循环，同步阻塞也杀得掉。
// 只给 owner 的亲儿子装——那正是 dao-check 起的 `node --test`。孙子（CLI、
// ACP 会话）不装：ACP 必须活过「发起它的那个进程」（acp-runtime 有断言），
// 第一版把 PR_SET_PDEATHSIG 打在 node 本体上，那条当场红。看门狗看的是
// owner pid，不是立即父进程。Worker 线程的 unref 在 spawnSync 期间不会转，
// 不能拿来当同步段的清理。

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OWNER_PID_ENV, OWNER_TOKEN_ENV, OWNER_TOKEN, ownerPollMs, ORPHAN_EXIT_CODE, ownerAlive, orphanNote } from '../../scripts/lib/test-child-guard.mjs';

const ownerPid = Number(process.env[OWNER_PID_ENV]);
const token = process.env[OWNER_TOKEN_ENV] || OWNER_TOKEN;

function startOwnerWatchdog() {
  if (process.ppid !== ownerPid) return;
  const script = fileURLToPath(new URL('./owner-watchdog.py', import.meta.url));
  try {
    const child = spawn('python3', ['-I', '-B', script], {
      stdio: 'ignore',
      windowsHide: true,
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: process.env.HOME || '',
        DAO_WD_OWNER: String(ownerPid),
        DAO_WD_VICTIM: String(process.pid),
        DAO_WD_TOKEN: String(token),
        DAO_WD_POLL: String(ownerPollMs(process.env)),
      },
    });
    child.on('error', () => {});
    if (typeof child.unref === 'function') child.unref();
  } catch {
    // fail-open：看门狗起不来就只剩主线程定时器
  }
}

function readCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return null;  // 进程没了，或本机没有 /proc——由 probe 分辨
  }
}

function probe(pid) {
  process.kill(pid, 0);
}

if (Number.isInteger(ownerPid) && ownerPid > 0) {
  startOwnerWatchdog();
  const tick = () => {
    let verdict;
    try {
      verdict = ownerAlive({ pid: ownerPid, token, readCmdline, probe });
    } catch {
      return;  // 闸自己出错不许影响被测进程
    }
    if (verdict.alive) return;
    try {
      process.stderr.write(orphanNote(ownerPid, verdict.basis) + '\n');
    } catch { /* stderr 都写不了就算了，该退还是退 */ }
    process.exit(ORPHAN_EXIT_CODE);
  };
  const timer = setInterval(tick, ownerPollMs(process.env));
  if (typeof timer.unref === 'function') timer.unref();
}
