// scripts/lib/test-child-guard.mjs —— dao-check 测试子进程的寿命判据
//
// 2026-09-15 实咬：本机 8 GB 内存里有 5.98 GB 是**一个孤儿测试进程**——
// `node --test tests/session-events.test.js`，PPID=1，已经跑了 1 天 11 小时 28 分。
// 杀掉后可用内存从 3.4 GB 回到 9.5 GB，六个审官当场恢复。
//
// 那套测试本身是好的（单独跑 exit 0、106/106 过、无残留）。坏的是起它的人：
// `dao-check.mjs` 的 runOneSuite 原来 spawn 完就只等 close——**没有超时、没有信号
// 处理、退出时不清理**。于是任何一次「测试挂住 + dao-check 被杀」都留下一个永生的
// 子进程，而且它长得一点都不像故障：ps 里就是一行正常的 node --test。
//
// 两层，覆盖面不同，缺一不可：
//   ① 本文件（父进程侧）：注册表 + 每套超时 + 按套子的后代树清理。
//      父进程还活着时，它保证挂住的套子和它的非 detached 后代被砍。
//      ACP 等刻意 setsid 的进程（pgid === pid）不砍——它们必须活过发起进程。
//   ② tests/helpers/parent-alive.mjs（子进程侧）：父进程被 SIGKILL 时，①的定时器
//      跟着父进程一起没了，只有子进程自己发现「爹没了」才救得回来。
//      主线程定时器管不到卡在 spawnSync 里的进程（事件循环不转，仓内测试也并非
//      每个 spawnSync 都有 timeout）。② 给 owner 的亲儿子另起旁路看门狗
//      （owner-watchdog.py）：独立事件循环，同步阻塞也杀得掉。owner 死后
//      按 ppid 树清 runner 的非 detached 后代（跳过 pgid===pid 的 ACP），
//      不把「只杀 runner」当成整棵树已清。不把 PR_SET_PDEATHSIG 打在 node
//      本体上——ACP 会话必须活过发起进程。
//
// owner 身份是 pid + /proc starttime（+ boot_id）。cmdline 子串「dao-check」
// 不是身份：路径/参数碰巧带这四个字的新进程会把 pid 复用误判成旧 owner。
//
// 为什么超时判**没查成而不是绿**：跑不完的套子没给出任何安全性，把它算绿就是
// 「没查成当成查过没事」。为什么不判成普通的红：红的含义是「测试发现了问题」，
// 超时的含义是「这次没测到」，两者要给人不同的下一步（前者改代码，后者查为什么挂住）。
//
// 为什么这不算「拿墙钟当闸」（CLAUDE.md 明令禁止）：闸判的不是「跑得慢就算你输」，
// 是「等到这个份上已经不可能拿到结果了」。刻度按实测定：本机最慢的一套
// acp-runtime.test.js 空载 33.5s，池宽 6 抢占时按 3 倍算约 100s，默认 10 分钟 ≈ 18 倍余量。
// 想再放宽用 DAO_CHECK_SUITE_TIMEOUT_MS（毫秒；0 = 关掉超时，回到出事前的行为）。
//
// 寿命判据本身是纯函数（listProcesses / readStarttime 可注入）。Linux 默认读
// /proc 的实现附在同文件，生产接线不用再抄一份解析。

import { readdirSync, readFileSync } from 'node:fs';

export const DEFAULT_SUITE_TIMEOUT_MS = 10 * 60 * 1000;
export const SUITE_TIMEOUT_ENV = 'DAO_CHECK_SUITE_TIMEOUT_MS';

/** 本套最慢测试的实测墙钟（2026-09-15，空载，acp-runtime.test.js）。只用来解释上面那个默认值。 */
export const SLOWEST_SUITE_OBSERVED_MS = 33546;

/**
 * 读每套超时的毫秒数。
 * 返回 `{ ms, source }`：source 是 `default` / `env` / `disabled` / `bad-env`，
 * 让调用方能把「用户显式关掉」和「环境变量写错被忽略」分开报——两者都得到 ms=0/默认值，
 * 但一个是决定、一个是事故。
 */
export function suiteTimeoutMs(env = {}) {
  const raw = env[SUITE_TIMEOUT_ENV];
  if (raw == null || String(raw).trim() === '') {
    return { ms: DEFAULT_SUITE_TIMEOUT_MS, source: 'default' };
  }
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) {
    return { ms: DEFAULT_SUITE_TIMEOUT_MS, source: 'bad-env', raw: String(raw) };
  }
  if (n === 0) return { ms: 0, source: 'disabled' };
  return { ms: Math.floor(n), source: 'env' };
}

/** 超时那一刻追加进 TAP 输出的说明。判据的解释要跟结论待在一起，别让人回头翻源码。 */
export function timeoutNote(file, ms) {
  const s = (Number(ms) || 0) / 1000;
  return `\n# dao-check：${file} 跑满 ${s.toFixed(0)}s 仍未结束，已被杀掉。\n`
    + `# 这是「没查成」不是「测试红」：本次没拿到这套的结论。\n`
    + `# 复现：node --test tests/${file}（挂住的话它大概率在等一个永远不来的 IO）\n`
    + `# 确实需要更久：${SUITE_TIMEOUT_ENV}=<毫秒> node scripts/dao-check.mjs（0 = 不限时）\n`;
}

/**
 * 活着的子进程注册表。**只记 pid，不持有 child 对象**——退出钩子里能做的事很少，
 * 越简单越可靠；`process.on('exit')` 里只许同步调用，这里全是同步的。
 *
 * `kill` 可注入，测试才验得了「真去杀了谁、用了什么信号」——拿真 spawn 验这件事
 * 会把测试变成又慢又飘的那种。
 */
export function createChildRegistry({ kill, listProcesses } = {}) {
  const doKill = typeof kill === 'function' ? kill : process.kill.bind(process);
  const live = new Map();

  return {
    add(pid, { label = '' } = {}) {
      const n = Number(pid);
      if (!Number.isInteger(n) || n <= 0) return false;
      live.set(n, { label: String(label || '') });
      return true;
    },
    remove(pid) {
      return live.delete(Number(pid));
    },
    get size() {
      return live.size;
    },
    list() {
      return [...live.entries()].map(([pid, v]) => ({ pid, ...v }));
    },
    /**
     * 杀光。返回 `{ killed, missing, failed }`：
     *   killed  真发了信号的
     *   missing 发的时候已经没了（ESRCH）——正常竞态，不是错
     *   failed  其它错误（权限等），要让人看见
     *
     * **只杀登记的那个 pid 及其非 detached 后代，不连进程组**。第一版用
     * `kill(-pid)` 连组杀，为此给 spawn 加了 `detached: true`；2026-09-15
     * 实测那个 detached 会让 acp-runtime / execution-runtime 随机报红——
     * acp-runtime.mjs:109 用 `pgid === pid` 判「是不是进程组头」，detached
     * 正好把每套测试变成组头（master 三连绿、带 detached 四跑两红、去掉后三连绿）。
     * 后代按 ppid 树走、跳过 pgid===pid 的组头（ACP 等刻意脱离的会话）。
     */
    killAll(signal = 'SIGKILL') {
      const extra = [];
      if (typeof listProcesses === 'function') {
        let procs = [];
        try { procs = listProcesses() || []; } catch { procs = []; }
        for (const pid of live.keys()) {
          extra.push(...descendantPids(pid, procs, { skipGroupLeaders: true }));
        }
      }
      const killed = [];
      const missing = [];
      const failed = [];
      const seen = new Set();
      for (const pid of [...extra, ...live.keys()]) {
        const n = Number(pid);
        if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
        seen.add(n);
        try {
          doKill(n, signal);
          killed.push(n);
        } catch (e) {
          if (e && e.code === 'ESRCH') missing.push(n);
          else failed.push({ pid: n, error: String((e && e.message) || e) });
        }
      }
      live.clear();
      return { killed, missing, failed };
    },
  };
}

// ── 子进程侧：爹没了就别活着 ──────────────────────────────────────
//
// 上面那层只在父进程还活着时有效。父进程被 SIGKILL（会话被拆、OOM、kill -9）时
// 它的定时器一起没了，子进程照样永生——本次 35 小时孤儿走的就是这条路。
// 所以子进程自己也要能判「爹还在不在」。
//
// 不能只比 `process.ppid === 1`：孙子进程（测试 spawn 出去的 CLI）的 ppid 是它爹，
// 爹是测试进程，测试进程死了它才变 1。判据统一成「那个**特定的** dao-check 还在不在」。
// NODE_OPTIONS 会一路继承，但仓内有测试显式覆盖它（spawnSync 的 env 只留 PATH），
// 那些后代装不上 parent-alive，不能靠「env 继承」声称任意深度已经成立。
// owner-death 路径由亲儿子上的旁路看门狗按 ppid 树清掉完整的非 detached 后代
// （跳过 pgid===pid 的 ACP），这才是任意深度。

export const OWNER_PID_ENV = 'DAO_CHECK_OWNER_PID';
export const OWNER_TOKEN_ENV = 'DAO_CHECK_OWNER_TOKEN';
export const OWNER_STARTTIME_ENV = 'DAO_CHECK_OWNER_STARTTIME';
export const OWNER_BOOT_ENV = 'DAO_CHECK_OWNER_BOOT';
/** 旧 cmdline 子串，不再当身份。生产 token 是 `bootId:starttime`。 */
export const OWNER_TOKEN = 'dao-check';
/** 多久看一眼爹还在不在。30s：孤儿多活半分钟没关系，每秒轮询 /proc 才是新负担。 */
export const OWNER_POLL_MS = 30 * 1000;
export const OWNER_POLL_ENV = 'DAO_CHECK_OWNER_POLL_MS';

/** 轮询间隔可调——不可调就没法在一条快测试里验这层，而验不了的兜底等于没有。 */
export function ownerPollMs(env = {}) {
  const n = Number(String(env[OWNER_POLL_ENV] ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : OWNER_POLL_MS;
}

export function formatOwnerToken({ bootId, starttime } = {}) {
  const start = String(starttime || '');
  if (!start) return '';
  return `${String(bootId || '')}:${start}`;
}

/** token 形态是 `bootId:starttime`。固定子串 `dao-check` 解析不出身份。 */
export function parseOwnerIdentity({ token, starttime, bootId } = {}) {
  const start = starttime != null && String(starttime) !== '' ? String(starttime) : '';
  const boot = bootId != null && String(bootId) !== '' ? String(bootId) : '';
  if (start) return { starttime: start, bootId: boot };
  const raw = String(token || '');
  const i = raw.lastIndexOf(':');
  if (i < 0) return { starttime: '', bootId: '' };
  const maybeStart = raw.slice(i + 1);
  const maybeBoot = raw.slice(0, i);
  if (!maybeStart) return { starttime: '', bootId: '' };
  return { starttime: maybeStart, bootId: maybeBoot };
}

/**
 * 解析 `/proc/<pid>/stat` 里括号后的字段。starttime 是字段 22（下标 19）。
 * 纯函数，测试不用碰真 /proc。
 */
export function parseProcStat(stat) {
  const s = String(stat || '');
  const closed = s.lastIndexOf(')');
  if (closed < 0) return null;
  const fields = s.slice(closed + 2).trim().split(/\s+/);
  if (fields.length < 20) return null;
  return {
    state: fields[0],
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    starttime: fields[19],
  };
}

export function readProcStarttime(pid) {
  try {
    const parsed = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    return parsed && parsed.starttime ? parsed.starttime : null;
  } catch {
    return null;
  }
}

export function readProcBootId() {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * 那个 pid 还是不是当初起我们的 dao-check。
 *
 * 唯一身份是 **starttime（+ boot_id）**，不是 cmdline 子串。
 * `node /tmp/not-the-owner-dao-check-helper.mjs` 这种路径碰巧带 `dao-check`
 * 的新进程，pid 复用之后不能被认成旧 owner。
 *
 * `readStarttime(pid)` / `readBootId(pid)` 读 `/proc`（读不到返回 null），
 * `probe(pid)` 是 `process.kill(pid, 0)` 那种存活探。
 *   · 光用 probe：pid 会被复用。35 小时足够让同一个 pid 变成别的进程。
 *   · 光用 cmdline 子串：路径/参数碰巧带 `dao-check` 就会误判。
 * 有 starttime 就以它为准；读不到时退回 probe 并**说明是退回的**。
 *
 * `readCmdline` 仍接受（旧调用点不用改），但**不再当身份**。
 *
 * 返回 `{ alive, basis }`；判不出来一律 `alive: true`（fail-open）——
 * 这层是兜底止血，不是闸；判错方向会误杀正在跑的测试，那比漏掉一个孤儿糟得多。
 */
export function ownerAlive({
  pid,
  token = '',
  starttime,
  bootId,
  readStarttime,
  readBootId,
  readCmdline: _readCmdline,
  probe,
} = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { alive: true, basis: 'no-owner' };

  const expected = parseOwnerIdentity({ token, starttime, bootId });

  if (expected.starttime && typeof readStarttime === 'function') {
    let got = null;
    try { got = readStarttime(n); } catch { got = null; }
    if (got != null && String(got) !== '') {
      if (String(got) !== expected.starttime) {
        return { alive: false, basis: 'starttime-mismatch' };
      }
      if (expected.bootId && typeof readBootId === 'function') {
        let boot = null;
        try { boot = readBootId(n); } catch { boot = null; }
        if (boot != null && String(boot) !== '' && String(boot) !== expected.bootId) {
          return { alive: false, basis: 'boot-mismatch' };
        }
      }
      return { alive: true, basis: 'starttime' };
    }
  }

  if (typeof probe !== 'function') return { alive: true, basis: 'no-probe' };
  try {
    probe(n);
    return { alive: true, basis: 'probe' };
  } catch (e) {
    if (e && e.code === 'ESRCH') return { alive: false, basis: 'probe' };
    return { alive: true, basis: 'probe-error' };
  }
}

/** 子进程发现爹没了时用的退出码。挑一个不跟测试框架撞的数，日志里一眼认得出。 */
export const ORPHAN_EXIT_CODE = 97;

export function orphanNote(ownerPid, basis) {
  return `dao-check：起我的那个 dao-check（pid ${ownerPid}）已经不在了（判据 ${basis}），`
    + `本进程自行退出，免得变成没人管的孤儿（退出码 ${ORPHAN_EXIT_CODE}）`;
}

/**
 * runner 的后代 pid。`skipGroupLeaders`（默认开）跳过 pgid===pid 且不是
 * root 自己的进程——那是 setsid / detached 出来的 ACP 会话，必须留着。
 * 跳过组头时也不再顺着它往下走，它的孩子跟它一起留。
 */
export function descendantPids(rootPid, procs, { skipGroupLeaders = true } = {}) {
  const root = Number(rootPid);
  if (!Number.isInteger(root) || root <= 0 || !Array.isArray(procs)) return [];
  const childrenOf = new Map();
  for (const row of procs) {
    const pid = Number(row && row.pid);
    const ppid = Number(row && row.ppid);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue;
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(row);
  }
  const out = [];
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift();
    for (const row of childrenOf.get(parent) || []) {
      const pid = Number(row.pid);
      if (seen.has(pid)) continue;
      seen.add(pid);
      const pgid = Number(row.pgid);
      const isLeader = skipGroupLeaders && Number.isInteger(pgid) && pgid === pid && pid !== root;
      if (isLeader) continue;
      out.push(pid);
      queue.push(pid);
    }
  }
  return out;
}

export function listLinuxProcesses() {
  if (process.platform !== 'linux') return [];
  let names;
  try {
    names = readdirSync('/proc');
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const pid = Number(name);
      const parsed = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
      if (!parsed || ['Z', 'X'].includes(parsed.state)) continue;
      if (!Number.isInteger(parsed.ppid) || !Number.isInteger(parsed.pgid)) continue;
      out.push({ pid, ppid: parsed.ppid, pgid: parsed.pgid, starttime: parsed.starttime });
    } catch {
      // 扫描中途进程没了
    }
  }
  return out;
}

/**
 * 杀 root 及其非 detached 后代。先列树再动手，避免杀 root 之后孩子被 init
 * 收走、下一轮扫不到。组头（ACP）不在名单里。
 */
export function killProcessTree(rootPid, {
  listProcesses,
  kill,
  skipGroupLeaders = true,
  signal = 'SIGKILL',
} = {}) {
  const doKill = typeof kill === 'function' ? kill : process.kill.bind(process);
  let procs = [];
  if (typeof listProcesses === 'function') {
    try { procs = listProcesses() || []; } catch { procs = []; }
  }
  const descendants = descendantPids(rootPid, procs, { skipGroupLeaders });
  const killed = [];
  const missing = [];
  const failed = [];
  const seen = new Set();
  for (const pid of [...descendants, Number(rootPid)]) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    try {
      doKill(n, signal);
      killed.push(n);
    } catch (e) {
      if (e && e.code === 'ESRCH') missing.push(n);
      else failed.push({ pid: n, error: String((e && e.message) || e) });
    }
  }
  return { killed, missing, failed, descendants };
}
