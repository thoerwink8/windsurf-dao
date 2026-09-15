// scripts/lib/test-child-guard.mjs —— dao-check 测试子进程的寿命判据（纯逻辑，无 IO）
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
//   ① 本文件（父进程侧）：注册表 + 每套超时。父进程还活着时，它保证挂住的套子被砍。
//   ② tests/helpers/parent-alive.mjs（子进程侧）：父进程被 SIGKILL 时，①的定时器
//      跟着父进程一起没了，只有子进程自己发现「爹没了」才救得回来。
//      主线程定时器管不到卡在 spawnSync 里的进程（事件循环不转，仓内测试也并非
//      每个 spawnSync 都有 timeout）。② 给 owner 的亲儿子另起旁路看门狗
//      （owner-watchdog.py）：独立事件循环，同步阻塞也杀得掉。不把
//      PR_SET_PDEATHSIG 打在 node 本体上——ACP 会话必须活过发起进程。
//
// 为什么超时判**没查成而不是绿**：跑不完的套子没给出任何安全性，把它算绿就是
// 「没查成当成查过没事」。为什么不判成普通的红：红的含义是「测试发现了问题」，
// 超时的含义是「这次没测到」，两者要给人不同的下一步（前者改代码，后者查为什么挂住）。
//
// 为什么这不算「拿墙钟当闸」（CLAUDE.md 明令禁止）：闸判的不是「跑得慢就算你输」，
// 是「等到这个份上已经不可能拿到结果了」。刻度按实测定：本机最慢的一套
// acp-runtime.test.js 空载 33.5s，池宽 6 抢占时按 3 倍算约 100s，默认 10 分钟 ≈ 18 倍余量。
// 想再放宽用 DAO_CHECK_SUITE_TIMEOUT_MS（毫秒；0 = 关掉超时，回到出事前的行为）。

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
export function createChildRegistry({ kill } = {}) {
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
     * **只杀登记的那个 pid，不连进程组**。第一版用 `kill(-pid)` 连组杀，为此给
     * spawn 加了 `detached: true`；2026-09-15 实测那个 detached 会让
     * acp-runtime / execution-runtime 随机报红——acp-runtime.mjs:109 用
     * `pgid === pid` 判「是不是进程组头」，detached 正好把每套测试变成组头
     * （master 三连绿、带 detached 四跑两红、去掉后三连绿）。
     * 孙子那一层改由 tests/helpers/parent-alive.mjs 兜底，它看 owner pid，与进程组无关。
     */
    killAll(signal = 'SIGKILL') {
      const killed = [];
      const missing = [];
      const failed = [];
      for (const pid of [...live.keys()]) {
        try {
          doKill(pid, signal);
          killed.push(pid);
        } catch (e) {
          if (e && e.code === 'ESRCH') missing.push(pid);
          else failed.push({ pid, error: String((e && e.message) || e) });
        }
        live.delete(pid);
      }
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
// 爹是测试进程，测试进程死了它才变 1。判据统一成「那个**特定的** dao-check 还在不在」，
// 任意深度的后代都适用（DAO_CHECK_OWNER_PID 随 env 一路继承）。

export const OWNER_PID_ENV = 'DAO_CHECK_OWNER_PID';
export const OWNER_TOKEN_ENV = 'DAO_CHECK_OWNER_TOKEN';
export const OWNER_TOKEN = 'dao-check';
/** 多久看一眼爹还在不在。30s：孤儿多活半分钟没关系，每秒轮询 /proc 才是新负担。 */
export const OWNER_POLL_MS = 30 * 1000;
export const OWNER_POLL_ENV = 'DAO_CHECK_OWNER_POLL_MS';

/** 轮询间隔可调——不可调就没法在一条快测试里验这层，而验不了的兜底等于没有。 */
export function ownerPollMs(env = {}) {
  const n = Number(String(env[OWNER_POLL_ENV] ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : OWNER_POLL_MS;
}

/**
 * 那个 pid 还是不是当初起我们的 dao-check。
 *
 * `readCmdline(pid)` 读 `/proc/<pid>/cmdline`（读不到返回 null），`probe(pid)` 是
 * `process.kill(pid, 0)` 那种存活探。**两样都要**：
 *   · 光用 probe：pid 会被复用。35 小时足够让同一个 pid 变成别的进程，
 *     那时探到「活着」就把孤儿判成了合法子进程——正是本单要治的病。
 *   · 光用 cmdline：非 Linux 没有 /proc，判据当场失效。
 * 所以有 /proc 时以 cmdline 为准（能识破 pid 复用），没有时退回 probe 并**说明是退回的**。
 *
 * 返回 `{ alive, basis }`；判不出来一律 `alive: true`（fail-open）——
 * 这层是兜底止血，不是闸；判错方向会误杀正在跑的测试，那比漏掉一个孤儿糟得多。
 */
export function ownerAlive({ pid, token = OWNER_TOKEN, readCmdline, probe } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { alive: true, basis: 'no-owner' };

  if (typeof readCmdline === 'function') {
    let raw;
    try {
      raw = readCmdline(n);
    } catch {
      raw = null;
    }
    if (raw != null) {
      // cmdline 是 NUL 分隔的，直接找子串即可
      const hit = String(raw).includes(String(token));
      return { alive: hit, basis: hit ? 'cmdline' : 'cmdline-mismatch' };
    }
    // 读不到：进程没了，或者本机没有 /proc。下面用 probe 分辨。
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
