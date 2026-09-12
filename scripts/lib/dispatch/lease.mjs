// scripts/lib/dispatch/lease.mjs —— 一棵树同时只许一个会话在跑（租约闸）
//
// 起因（2026-09-06 实测，六小时 137 个会话）：
//   dao-565 起了 20 个会话、dao-1007 与 dao-1055 各 16 个、dao-review-pr-1071 十四个，
//   后半段间隔精确 20 分钟——那是指挥官的节拍。收尾原因 50× stalled、30× at capacity。
//
// 「撞上游容量」是**结果不是原因**：二十棵树反复重投同一个模型池，把它打到没容量，
// 失败让票留在队列里，下一轮再投。越推越卡。所以正解不是给腿加熔断（那只会把好腿熔掉，
// 让同样多的会话挤到另一条腿），而是**同一件事同时只有一个执行者**——工作队列的第一条。
//
// 规矩早有（memory `one-pr-one-reviewer`），判据也早有（lib/dispatch/liveness.mjs），
// 只是判据落在**回收侧**（board-gc），从没接到**起会话**那条路上。本文件补这一跳。
//
// ── 判据为什么不读 mirasim 自己的 record.json ──────────────────────────────
// 试过，是错的。record.json 里的 `runPid` **不是会话进程，是 mirasim-server 自己的 pid**：
// 2026-09-06 实测五条 running 记录的 runPid 全是 767216，而 767216 是
// `mirasim-server/0.0.282/server.cjs`（PPID 1，systemd 起的，9 月 4 日就在跑）。
// 拿它判活性，要么全判成活（一条记录占住所有树），要么全判成死（闸永远不响）。
//
// 而且本仓硬规矩：检查逻辑不得复用被检查对象自己的记账。用 mirasim 的 runState 判
// 「mirasim 有没有会话在跑」，正是自己查自己。
//
// 真判据是**操作系统**：会话进程的 cwd 就是它那棵工作树，且它一定是 mirasim-server
// 的后代。两条都从 /proc 直接读，跟 mirasim 的记账无关。实测：
//   3015939 codex cwd=…/dao-review-pr-1040   ← 767216 (mirasim-server)
//   2977217 pi    cwd=…/dao-1055             ← 767216
//   3012989 pi    cwd=/tmp/mirasim-unix-smoke ← 619237（另一个实例，按祖先正确排除）
//
// 闸装在 mirasim-runtime 的 startSession 里，不装在各调用点：四个调用点
// （dao dispatch / dao start / 审官 create / 推一把）全从那一道门过，装在门里绕不开。

import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scanProcCwds } from '../proc-cwds.mjs';

/** 认 mirasim 服务进程用的字样。取自它自己的 argv：`…/mirasim-server/<版本>/server.cjs`。 */
export const MIRASIM_SERVER_MARK = 'mirasim-server';

/** 派工树根 `~/mirasim-worktrees`（登记在 host/machine/INDEX.md D 类）。布局 `<根>/<仓>/<分支>`。 */
export function worktreesRoot(home = homedir()) {
  return process.env.MIRASIM_WORKTREES || join(home, 'mirasim-worktrees');
}

/**
 * 「树里有人在干活」的原因名。**它是背压，不是失败**——调用方要能把它跟真失败分开：
 * 真失败该报帅开单，背压只该排队下一轮。分不开的后果实测过：指挥官会为每一次
 * 「这轮先不派」开一张待拍板单，那正是 2026-09-06 清掉的那类噪音单。
 */
export const LEASE_BUSY_REASON = 'lease-held';

/**
 * 扫 /proc，列出「在某棵树里干活的会话进程」。
 *
 * @returns {{ok:true, procs:Array<{pid:number,comm:string,cwd:string}>, resolved:number, total:number}
 *          |{ok:false, unscanned:true, error:string}}
 *
 * 三态出口。**「扫完没有」与「根本没扫到」必须分得开**。
 * 覆盖证明见 `scanProcCwds`：相关进程 = 本身份。别的用户 cwd 读不出是预期（Yama），
 * 不算没查成；本身份 cwd 没核清才是没查成。旧判据「任意读出一条 cwd 就算 ok」
 * 会在 60/249 时放行删除——#1176 审官 P1。
 *
 * 覆盖证明必须排在「服务不在 ⇒ 0 个会话」前面：服务不在不能反过来证明相关进程核清了。
 *
 * 覆盖证明、父链、cwd 必须吃同一份 PID 快照。再读一次 /proc，第一次之后才出现的
 * 本身份进程会静默漏掉，函数仍 ok:true——#1176 审官 P1。
 */
export function scanSessionProcs({
  readdir = readdirSync, read = readFileSync, readlink = readlinkSync, getuid,
} = {}) {
  const cover = scanProcCwds({ readdir, read, readlink, getuid });
  if (!cover.ok) {
    return {
      ok: false,
      unscanned: true,
      error: cover.error,
      resolved: cover.resolved || 0,
      total: cover.total || 0,
    };
  }

  const pids = Array.isArray(cover.pids)
    ? cover.pids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (!pids.length) {
    return { ok: false, unscanned: true, error: '覆盖证明没带回 PID 快照——没查成' };
  }

  // 先找 mirasim 服务进程：会话进程必须是它的后代。
  const servers = new Set();
  const ppid = new Map();
  for (const pid of pids) {
    let stat;
    try { stat = read(`/proc/${pid}/stat`, 'utf8'); } catch { continue; }
    const cut = stat.lastIndexOf(')');
    if (cut < 0) continue;
    const f = stat.slice(cut + 2).trim().split(/\s+/);
    ppid.set(pid, Number(f[1])); // 切掉 pid 和 comm 后，ppid 是第 2 个（原第 4）
    let cmd = '';
    try { cmd = read(`/proc/${pid}/cmdline`, 'utf8'); } catch { /* 内核线程没有 cmdline */ }
    if (cmd.includes(MIRASIM_SERVER_MARK) || cmd.includes('acp-session-runner.mjs')) servers.add(pid);
  }
  if (!servers.size) {
    // 服务不在 = 一个会话也不可能在跑。这是「查成了，结论是 0」，不是没查成。
    return { ok: true, procs: [], resolved: cover.resolved, total: pids.length, noServer: true };
  }

  const 是后代 = (pid) => {
    let cur = pid;
    for (let hop = 0; hop < 32; hop += 1) { // 深度封顶：父链万一成环也不许卡死起会话那条路
      if (servers.has(cur)) return true;
      const p = ppid.get(cur);
      if (!p || p === cur || p === 1) return false;
      cur = p;
    }
    return false;
  };

  const cwdByPid = new Map((cover.entries || []).map((e) => [Number(e.pid), e.cwd]));
  const procs = [];
  for (const pid of pids) {
    const cwd = cwdByPid.get(pid);
    if (!cwd) continue; // 退了 / 别人的 / 内核藏起来的——覆盖证明已经核过
    if (servers.has(pid)) continue; // 服务自己不是干活的会话，它的 cwd 不该占住任何树
    if (!是后代(pid)) continue;
    let comm = '';
    try { comm = read(`/proc/${pid}/comm`, 'utf8').trim(); } catch { /* 退了就算了 */ }
    procs.push({ pid, comm, cwd: String(cwd).replace(/\/+$/, '') });
  }

  return { ok: true, procs, resolved: cover.resolved, total: pids.length };
}

/**
 * 判一棵树的租约。纯函数——进程观测从外面给，好单测。
 *
 * @param {string} workdir            要起会话的树（绝对路径）
 * @param {Array<{pid,comm,cwd}>} procs  scanSessionProcs 的产物
 * @returns {{verdict:'free'|'held', holders?:Array, why:string}}
 */
export function judgeTreeLease({ workdir, procs } = {}) {
  const tree = String(workdir || '').replace(/\/+$/, '');
  if (!tree) return { verdict: 'free', why: '没给 workdir，租约无从判起（调用方自己会因为缺参数失败）' };
  if (!Array.isArray(procs)) {
    // 到不了这里：scanSessionProcs 不 ok 时调用方就该 fail-close 了。留着是为了别静默放行。
    return { verdict: 'held', why: '没拿到进程观测数组——没查成，按占用处理（fail-close）' };
  }

  const holders = procs.filter((p) => p && String(p.cwd).replace(/\/+$/, '') === tree);
  if (!holders.length) return { verdict: 'free', why: `${tree} 里没有会话进程在干活` };
  return {
    verdict: 'held',
    holders: holders.map((h) => ({ pid: h.pid, comm: h.comm || null })),
    why: `${tree} 已经有 ${holders.length} 个会话进程在干活（${holders.map((h) => `${h.comm || '?'} pid ${h.pid}`).join('、')}）`,
  };
}

/**
 * 现在有几棵树被占着——**在制品的真分母**（#1007）。
 *
 * 为什么用「被占的树数」而不是「进程数」：一个会话会顺手拉起 git / bash / node 一堆子进程
 * （实测一棵树能有十几个），按进程数算会把同一个会话数很多遍。一棵树 = 一个在干活的会话，
 * 这是与租约闸同一把尺，不另造判据。
 *
 * **审官树照数不误。** 原来的准入把审官排除在外（`isReviewerCard` 跳过），那是错的分母：
 * 审官吃同一份 CPU 和内存，而 2026-09-06 那晚 137 个会话里审官占 53 个。分母漏掉一半，
 * 算出来的余量必然偏大，闸也就形同虚设。
 *
 * @param {Array<{pid,comm,cwd}>} procs
 * @param {string} root  只数这个根下面的树（默认 mirasim 的工作树根）
 * @returns {{ok:true, trees:string[], count:number}|{ok:false,unscanned:true,error:string}}
 */
export function busyTrees(procs, { root = worktreesRoot() } = {}) {
  if (!Array.isArray(procs)) {
    return { ok: false, unscanned: true, error: '没拿到进程观测数组——在途数不当成 0（fail-close）' };
  }
  const base = String(root).replace(/\/+$/, '');
  const seen = new Set();
  for (const p of procs) {
    const cwd = String((p && p.cwd) || '').replace(/\/+$/, '');
    // 前缀要带斜杠：光比 includes('mirasim-worktrees') 会把 /tmp/mirasim-worktrees-fake 也算进来。
    if (!cwd || !cwd.startsWith(`${base}/`)) continue;
    seen.add(cwd);
  }
  const trees = [...seen].sort();
  return { ok: true, trees, count: trees.length };
}

/**
 * 生产入口：扫 /proc + 数在途。给派单准入用（#1007）。
 * 没查成 ⇒ ok:false，调用方必须收紧到不派——读不到 ≠ 可以随便派。
 */
export function checkInFlight({ io, root } = {}) {
  const scan = scanSessionProcs(io || {});
  if (!scan.ok) return { ok: false, unscanned: true, error: scan.error };
  return { ...busyTrees(scan.procs, root ? { root } : {}), noServer: scan.noServer === true };
}

/**
 * 生产入口：扫 /proc + 判。三态返回。
 *
 * @returns {{ok:true, verdict:'free'|'held', ...}|{ok:false, unscanned:true, error:string}}
 *
 * 没查成 ⇒ ok:false，调用方必须拒起（fail-close）。放行的代价实测是一棵树 20 个会话；
 * 拒起的代价是这轮不派、下轮再来，而且报得出来。
 */
export function checkTreeLease({ workdir, io } = {}) {
  const scan = scanSessionProcs(io || {});
  if (!scan.ok) return { ok: false, unscanned: true, error: scan.error };
  return {
    ok: true,
    scanned: { procs: scan.procs.length, resolved: scan.resolved, total: scan.total, noServer: scan.noServer === true },
    ...judgeTreeLease({ workdir, procs: scan.procs }),
  };
}
