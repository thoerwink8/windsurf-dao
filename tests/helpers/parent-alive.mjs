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
// 管不到的一种：**子进程正卡在一个长的同步调用里**（比如一串 spawnSync）。
// 那时事件循环根本不转，定时器排在后面永远轮不上。实测 2026-09-15：SIGKILL 掉
// dao-check 后 dao-dispatch-gate.test.js 又活了一分多钟才走——它整套都是 spawnSync。
// 这一层的承诺因此只到「不会永生」：同步段跑完就会被抓住，而同步段本身是有界的
// （每个 spawnSync 都自带 timeout）。真正永生的形态是「挂在 IO 上等一个不来的事件」，
// 那种事件循环空着，这一层一抓一个准——本次那个 35 小时的孤儿正是这种。

import { readFileSync } from 'node:fs';
import { OWNER_PID_ENV, OWNER_TOKEN_ENV, OWNER_TOKEN, ownerPollMs, ORPHAN_EXIT_CODE, ownerAlive, orphanNote } from '../../scripts/lib/test-child-guard.mjs';

const ownerPid = Number(process.env[OWNER_PID_ENV]);
const token = process.env[OWNER_TOKEN_ENV] || OWNER_TOKEN;

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
