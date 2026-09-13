// scripts/lib/main-checkout.mjs —— 主 clone 根：跑在 worktree 里也要拿到**同一个**机器本地根。
//
// 起因（2026-09-12 实咬）：`_flow/queue/review-pending/` 的落点由调用方 cwd 推
// （`reviewPendingDir({ root: ROOT })`，而 ROOT = 本脚本所在树的根）。工人在自己的
// worktree 里交卷，票就写进**那棵树**的 `_flow/`；drain 在主树里读，永远看不见它。
// 实锤两条：#1159 的票在 `dao-1152/_flow/…`、#1208 的票在 `dao-1174/_flow/…`，
// 主树队列里都没有——**票没丢，是写到了另一棵树**，而队列看起来只是「少了几张」。
// 这形状与 memory `migration-half-done-breaks-checks` 同源：真相源一份，读侧另一份。
//
// 为什么根必须由 git-common-dir 推、不能各树各自一份：
//   1. `_flow/` 是机器本地派生数据（已 gitignore），不随分支走；worktree 一删它的票就陪葬，
//      而队列的语义恰恰是「树没了活还在，等调度」。
//   2. 队列只该有一个读点。多份队列 = 多份「在役几个」的账，drain 的容量闸就量不准。
//
// 兜底：git 读不出来 / 不在仓里 → 退回脚本所在树根（与旧行为一致，不新造失败面）。
// 判据是**可测的**：同一次调用在任一 worktree 里跑，返回的必须是主 clone 根。

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

/**
 * 从脚本自身位置推本树根（与 dao-cmd.mjs 的 ROOT 同式）。
 * @param {string} arg `import.meta.dirname`、`import.meta.url`，或已是目录的绝对路径
 * @param {string} [rel] 从该目录再上溯几层（dao.mjs 的 ROOT 是 scripts/ 的上两层 → 传 '../..'）
 */
export function thisTreeRoot(arg, rel = '../..') {
  const p = String(arg || '');
  if (!p) return process.cwd();
  if (p.startsWith('file:')) return resolve(new URL(p).pathname, rel);
  return resolve(p, rel);
}

/**
 * 主 clone 根。
 *
 * @param {object} [opts]
 * @param {string} [opts.treeRoot] 本树根（缺省 process.cwd()）；用于「不在仓里」时的兜底。
 * @param {object} [opts.env] 测试注入。
 * @param {Function} [opts.spawn] 测试注入（签同 spawnSync）。
 * @param {Map} [opts.cache] 进程内缓存（同一个进程反复问同一个根时省一次 spawn）。
 * @returns {string} 绝对路径
 */
export function mainCheckoutRoot({ treeRoot, env, spawn = spawnSync, cache } = {}) {
  const e = env || process.env;
  const override = e.DAO_MAIN_CHECKOUT_ROOT;
  if (override && String(override).trim()) return resolve(String(override).trim());
  const from = treeRoot && String(treeRoot).trim() ? String(treeRoot) : process.cwd();
  if (cache && cache.has(from)) return cache.get(from);
  const r = spawn('git', ['-C', from, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    windowsHide: true, encoding: 'utf8',
  });
  let out = null;
  if (r && r.status === 0) {
    let g = String(r.stdout || '').trim();
    // 老 git 不认 --path-format：回退相对式，再自己接成绝对。
    if (g && !g.startsWith('/')) g = join(from, g);
    if (g) {
      // 主 clone 的 .git 是**目录**（worktree 的 common-dir 也指回它）。
      out = g.endsWith('/.git') ? dirname(g) : g;
    }
  }
  const root = out || resolve(from);
  if (cache) cache.set(from, root);
  return root;
}
