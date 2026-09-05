// scripts/lib/stall-census.mjs —— 盘点「还卡着的东西」（2026-09-05 实咬）
//
// 补的是 agent-stall-watch 的两个盲格。两个都不是「判死尺子不准」——
// 尺子（liveness.progressSignature / applyProgressMemory）是对的，问题出在它两侧：
//
// ① **报过一次就永久闭嘴**。静默账本 `<state>-liveness.json` 的 settled 判据是
//    「prev.action 不是 restart-reviewer ⇒ 已了结」，于是所有 escalate（= 工人）第一轮报完
//    就再也不报；审官换人失败 3 次后也停手。实咬当天服务器账本里躺着
//    `minutes: 972` / `tries: 1` 的条目——16 小时没动，播报里一个字都没有。
//    而「现在还有多少个在静默」只 console.log 进日志（`活性：活 19 / 静默 41`），从不进播报：
//    盘上 41 个静默，群里 0 条。**去重是对的，永久闭嘴是错的**——所以这里加的不是「再报一遍」，
//    是**升级档**：静默跨过 3 小时 / 12 小时 / 一天 / 三天时各说一次，一个档只说一次。
//
// ② **无卡孤儿根本不在采样面里**。agent-stall-watch 按 `orca terminal list` 遍历，
//    而这类东西的定义就是「orca 里没有终端记录」——任何按卡遍历的扫描器都数不到它。
//    #829 的 grok 2026-09-03 turn_ended 之后又挂了两天，一声没响，就是这一格。
//    唯一能看见它的采样面是操作系统的进程表；连接键实测是 `进程 cwd` ↔ `终端 worktreePath`
//    （2026-09-05 实测：20 个进程目录 ⊆ 22 个终端目录，精确串匹配，无误差）。
//
// 硬边界（用户 2026-09-05 定，且仓内 memory deleted-card-process-outlived-it 咬过）：
// **只发现只报警，不杀进程不清卡**。那次「卡删了进程没死」对外发了 21 条重复评论。
// 处置留给人和 board-gc。本模块因此没有任何写动作。
//
// 三态：ok / red / unscanned。扫到 0 个样本一律 unscanned——
// 「这次没采到进程」和「采过了没有孤儿」分不开，就等于把没查成记成查过没事。

import { readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';

export const HOUR_MS = 60 * 60 * 1000;

/** 静默升级档：已经报过的静默跨过这些线时各再说一次。低于第一档不说（45 分钟那条由上游首报负责）。 */
export const SILENCE_TIERS = [
  { ms: 3 * HOUR_MS, label: '3 小时' },
  { ms: 12 * HOUR_MS, label: '12 小时' },
  { ms: 24 * HOUR_MS, label: '一天' },
  { ms: 72 * HOUR_MS, label: '三天' },
];

/** 无卡进程升级档：第一档是 0 —— 这类东西一发现就得说，它比静默严重（没有卡就没有任何人在看它）。 */
export const NO_CARD_TIERS = [
  { ms: 0, label: '刚发现' },
  { ms: 6 * HOUR_MS, label: '6 小时' },
  { ms: 24 * HOUR_MS, label: '一天' },
  { ms: 72 * HOUR_MS, label: '三天' },
];

/** 新起的进程还没来得及被 orca 登记就被判成孤儿是误报。给这么久的宽限。 */
export const DEFAULT_GRACE_MS = 10 * 60 * 1000;

/** 落到第几档（返回下标；低于第一档返回 -1）。档位表必须升序，乱序自己排。 */
export function tierOf(ms, tiers = SILENCE_TIERS) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return -1;
  const list = Array.isArray(tiers) ? tiers : [];
  let hit = -1;
  for (let i = 0; i < list.length; i += 1) {
    const t = Number(list[i]?.ms);
    if (Number.isFinite(t) && n >= t) hit = i;
  }
  return hit;
}

/**
 * 升级档播报计划。**这是「永久闭嘴」的解药，不是「再报一遍」**：
 * 同一个东西同一档只说一次；跨到更高档才再说一次；退回低档不倒退（tier 只涨不跌，
 * 免得一个抖动就把已经说过的档重新说一遍）。
 *
 * items: [{ key, label, ms }]；memory: { [key]: { tier } }（落盘，下一轮传回来）。
 * 返回 { ok, state, alerts, memory, sampled }。items 不是数组 / 一个样本都没有 ⇒ unscanned。
 */
export function planTierAlerts({ items, memory, tiers = SILENCE_TIERS } = {}) {
  if (!Array.isArray(items)) {
    return { ok: false, state: 'unscanned', error: '没给清单（没查成）', alerts: [], memory: {}, sampled: 0 };
  }
  const prev = memory && typeof memory === 'object' ? memory : {};
  const next = {};
  const alerts = [];
  const seen = new Map();
  for (const it of items) {
    if (!it || it.key == null) continue;
    const key = String(it.key);
    // 同一个键在一轮里出现多次（一张卡好几个终端）取最久的那个，不重复播。
    const old = seen.get(key);
    if (!old || Number(it.ms) > Number(old.ms)) seen.set(key, it);
  }
  for (const [key, it] of seen) {
    const idx = tierOf(it.ms, tiers);
    const recorded = Number(prev[key]?.tier);
    const announced = Number.isFinite(recorded) ? recorded : -1;
    // 只涨不跌：记账取两者较大的，播报只在真的涨了的时候。
    const kept = Math.max(announced, idx);
    next[key] = { tier: kept };
    if (idx > announced && idx >= 0) {
      alerts.push({ key, label: String(it.label ?? key), ms: Number(it.ms) || 0, tier: idx, tierLabel: tiers[idx]?.label || '' });
    }
  }
  return { ok: true, state: alerts.length ? 'red' : 'ok', alerts, memory: next, sampled: seen.size };
}

/**
 * 进程的工作目录 → 它属于哪张卡的树。
 * 形如 `/home/orca/orca/workspaces/<仓>/<卡目录>`；再深的子目录一律收敛到卡目录。
 * 卡目录被删掉时 Linux 的 readlink 会返回 `<路径> (deleted)`，先剥掉再判——
 * 那正是最该报的一类（卡没了进程还在，memory deleted-card-process-outlived-it）。
 * 认不出 ⇒ null（主树、家目录、系统进程都会走到这里，不参与本闸）。
 */
export function worktreeRootOf(cwd, { marker = 'orca/workspaces' } = {}) {
  let s = String(cwd || '').replace(/\\/g, '/').trim();
  if (!s) return null;
  const del = / \(deleted\)$/;
  const deleted = del.test(s);
  if (deleted) s = s.replace(del, '');
  const m = new RegExp(`^(.*/${marker}/[^/]+/[^/]+)(?:/.*)?$`).exec(s);
  if (!m) return null;
  return { root: m[1], card: m[1].slice(m[1].lastIndexOf('/') + 1), deleted };
}

/**
 * 无卡进程判官（纯函数，探头由调用方注入，方便造违规样本）。
 *
 * terminals: orca terminal list 的原样数组（只读 worktreePath）。
 * processes: [{ pid, cwd, cmd, ageMs }]。
 *
 * 判据：进程 cwd 落在某张卡的树里，而 orca 的终端清单里没有任何一条认领这个目录 ⇒ 无卡。
 * 卡目录已被删掉的（cwd 带 deleted）直接算无卡——那连目录都没有了，不可能有人在看它。
 *
 * 三态：
 *   unscanned —— 终端清单不是数组 / 进程清单不是数组 / **一个候选进程都没采到**。
 *                最后一条是关键：候选为 0 时「进程表没读成」和「确实没有孤儿」长得一模一样。
 *   red       —— 有无卡进程。
 *   ok        —— 采到了候选，且每个都能在终端清单里找到自己的卡。
 */
export function classifyNoCardProcesses({ terminals, processes, graceMs = DEFAULT_GRACE_MS, marker } = {}) {
  if (!Array.isArray(terminals)) {
    return { state: 'unscanned', detail: '终端清单没读成（没查成，不是没有孤儿）', strays: [], sampled: 0, known: 0 };
  }
  if (!Array.isArray(processes)) {
    return { state: 'unscanned', detail: '进程清单没读成（没查成，不是没有孤儿）', strays: [], sampled: 0, known: 0 };
  }
  const known = new Set();
  for (const t of terminals) {
    const p = String(t?.worktreePath || '').replace(/\\/g, '/').replace(/\/+$/, '').trim();
    if (p) known.add(p);
  }
  // 采样面 = 能认出卡树的进程，**不看年龄**。全都太新只说明这一轮没有够老的候选，
  // 不等于进程表没读成——把年龄过滤放进采样面会让「刚重启完」被误报成没查成。
  const candidates = [];
  for (const p of processes) {
    const hit = worktreeRootOf(p?.cwd, marker ? { marker } : undefined);
    if (!hit) continue;
    candidates.push({ ...p, root: hit.root, card: hit.card, cardDeleted: hit.deleted });
  }
  if (candidates.length === 0) {
    return {
      state: 'unscanned',
      detail: '一个在卡里跑的程序都没采到（没查成，不是没有孤儿）',
      strays: [], sampled: 0, known: known.size,
    };
  }
  const byRoot = new Map();
  for (const c of candidates) {
    if (Number(c.ageMs) < graceMs) continue; // 刚起的还没被登记，宽限内不算
    const claimed = known.has(c.root.replace(/\/+$/, ''));
    if (claimed && !c.cardDeleted) continue;
    const cur = byRoot.get(c.root);
    if (!cur || Number(c.ageMs) > Number(cur.ageMs)) {
      byRoot.set(c.root, { root: c.root, card: c.card, cardDeleted: c.cardDeleted, pid: c.pid, cmd: c.cmd, ageMs: Number(c.ageMs) || 0, count: 0 });
    }
  }
  for (const c of candidates) {
    const hit = byRoot.get(c.root);
    if (hit) hit.count += 1;
  }
  const strays = [...byRoot.values()].sort((a, b) => b.ageMs - a.ageMs);
  return {
    state: strays.length ? 'red' : 'ok',
    detail: strays.length
      ? `${strays.length} 张卡的程序还在跑，可盘面上已经没有它们了`
      : `采到 ${candidates.length} 个在卡里跑的程序，每个都还认得到自己的卡`,
    strays,
    sampled: candidates.length,
    known: known.size,
  };
}

/**
 * 进程表探头（唯一有副作用的一格）。
 *
 * 三种不 ok 要分开，混起来就会把「查不成」洗成「没这回事」：
 *   notApplicable —— 这台机器压根没有进程表可读（不是 Linux）。**不是绿，也不是没查成**，
 *                    是这一格在这台机器上不存在。仓内 dao-check ⑦⑧⑨ 一贯这么分
 *                    （「本机无 orca 一律 SKIP，不再把本机无 orca 当红」）。
 *                    开发机跑 dao-check 时走这条，不该把退出码染红。
 *   没查成        —— 该读的地方读不开 / 读出来是空的。服务器上出现这个就是真出事了。
 *   ok            —— 真读到了。
 *
 * 年龄取 /proc/<pid> 目录的 mtime（= 进程起始时刻，与 ps etimes 实测逐秒一致，且不依赖时钟频率）。
 * 读不到的（别的用户、刚退出）跳过并计数——全跳过时候选为 0，上面的判官会判「没查成」。
 */
export function readProcessCensus({ procRoot = '/proc', platform = process.platform, now = Date.now() } = {}) {
  if (platform !== 'linux') {
    return {
      ok: false, notApplicable: true, processes: null, skipped: 0,
      error: '这台机器没有进程表可读（不是 Linux）——这一格不适用，不是查过没事',
    };
  }
  let entries;
  try {
    entries = readdirSync(procRoot).filter((d) => /^\d+$/.test(d));
  } catch (e) {
    return { ok: false, notApplicable: false, error: `进程表读不开：${String(e?.code || e?.message).slice(0, 80)}（没查成）`, processes: null, skipped: 0 };
  }
  if (entries.length === 0) {
    return { ok: false, notApplicable: false, error: '进程表里一个进程都没有——没查成', processes: null, skipped: 0 };
  }
  const processes = [];
  let skipped = 0;
  for (const pid of entries) {
    let cwd;
    try {
      cwd = readlinkSync(`${procRoot}/${pid}/cwd`);
    } catch {
      skipped += 1; // 别的用户 / 刚退出，正常
      continue;
    }
    let ageMs = 0;
    try {
      ageMs = Math.max(0, now - statSync(`${procRoot}/${pid}`).mtimeMs);
    } catch { /* 拿不到年龄就当 0，宽限会挡住它 */ }
    let cmd = '';
    try {
      cmd = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 200);
    } catch { /* 命令行只用于人看，读不到不影响判定 */ }
    processes.push({ pid: Number(pid), cwd, cmd, ageMs });
  }
  return { ok: true, notApplicable: false, processes, skipped };
}

/** 跑了多久，说人话（不到一小时不说「0 小时」——那看着像没跑）。 */
export function humanAge(ms) {
  const n = Math.max(0, Number(ms) || 0);
  const h = Math.round(n / HOUR_MS);
  if (h < 1) return '不到 1 小时';
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

/** 播报文案（说人话闸：不出现路径、进程号、内部英文代号）。 */
export function noCardLine({ card, count, ageMs, cardDeleted }) {
  const what = cardDeleted ? '卡和它的目录都已经没了' : '盘面上找不到它的卡';
  return `「${String(card || '某张卡').slice(0, 48)}」还有 ${Number(count) || 1} 个程序在跑，`
    + `已经跑了${humanAge(ageMs)}，但${what}——该看一眼它是不是早该收工了`;
}

/** 静默升级播报文案（同上，说人话）。档位词前留一个空格，「已经3 小时」那样是贴着的。 */
export function standingLine({ label, tierLabel }) {
  return `${String(label || '某个会话')} 卡了 ${tierLabel}以上还没动静，还挂在盘面上——之前报过一次，现在还是这样`;
}
