// hook-budget.js — 把「宿主给我多少时间」变成一个 hook 自己算得出的数
//
// ── 治的是什么病（issue #127）─────────────────────────────────────────────────
// `dao-scaffold-check.js` 里给死闸检测留了 `DEAD_GATES_TIMEOUT_MS = 30000`，
// 而它在 `~/.claude/settings.json` 里的注册是 `"timeout": 10`（秒）。
// ⇒ 那个 30 秒**永远够不着**：真到 10 秒宿主先把整个 hook 杀了。
// 于是内层写好的那条优雅降级路径（返回「✗ …跑不起来（手动复核：…）」）**结构上不可达**。
//
// 🔴 **这不是「反正现在很快」就没事** —— 2026-08-04 实测（本机，见下）：
//   · 该 hook 整跑 **4.7–5.4 s**，已经吃掉 10 s 预算的一半；
//   · 其中 **~4.15 s 是条款库结构闸的 7 次 PowerShell 冷起**（单次 444–772 ms），
//     而被检文件数 = `ccswitch/rules/` 下含条款的 .md 数量，**只会涨不会跌**。
//     13 份 rules 全部长出条款时就是 ~8.4 s + 其余 ~0.37 s ≈ **8.8 s，贴着 10 s 线**。
//
// ── 宿主超时到底会发生什么（2026-08-04 实测，不是推断）───────────────────────
// 造法：一个沙箱项目 `.claude/settings.json` 注册若干 SessionStart hook，`timeout: 3`，
// 其中一个先打印一份**完整合法**的 `hookSpecificOutput` 再睡 8 秒；跑真的
// `claude -p` 并读会话 transcript 与 `--output-format stream-json` 的线上报文。
//   ① **整个进程连同它的子孙一起被杀**。实测另一个 hook 先 `execFileSync` 出一个
//      「睡 8 秒后写 marker」的孙子进程 —— 宿主超时后等满 12 秒，那个 marker **从未出现**，
//      系统里也查不到残留进程 ⇒ 杀的是进程树，不是只杀父。
//      对本 hook 的含义：它是**单进程**跑完全部检查，所以「超时」= **全部检查一起消失**，
//      不是「死闸那一项没跑成」。
//   ② **已经写出去的 stdout 一并作废**。那份在睡觉前就打印好的 additionalContext，
//      宿主 debug 日志里明明白白解析出来了（`Hook … cancelled:` 后面跟着它的原文），
//      而最终注入模型的 `hook_additional_context` 里**没有它**。
//      ⇒ 「先打印再干活」不构成任何保护。
//   ③ **同一组里的兄弟 hook 照跑**，各自有各自的 timeout，互不牵连。
//   ④ **痕迹在哪、不在哪**（这一格最要紧）：
//      · 会话 transcript（`~/.claude/projects/<slug>/<id>.jsonl`）**有**一条
//        `{"type":"hook_cancelled", …, "timedOut":true, "timeoutMs":3000}`；
//        而**静默成功的 hook 在 transcript 里一条记录都不留** ⇒ 在这个载体上两者其实分得开。
//      · `--output-format stream-json` 的线上报文**有** `outcome:"cancelled"` + `exit_code:1`，
//        与静默成功的 `outcome:"success"` + `exit_code:0` 只差这两个字段。
//      · **agent 的上下文里什么都没有** —— 被杀那一路的 additionalContext 直接消失，
//        与「跑完了，什么都没发现」**逐字节相同**。而 agent 的上下文正是这个 hook 存在的唯一目的。
//      · 终端里什么都没有；`--debug` 日志只在**显式加了 `--debug`** 时才写，
//        且它那行 `cancelled:` 是把已捕获的 stdout 打出来 —— 本 hook 的 stdout 只在最末尾
//        一次性写出，被杀时压根没有 ⇒ **连 debug 日志里也不会出现**（实测：另一个
//        「被杀时尚未输出」的 hook 在 debug 日志里零行）。
//   ⇒ 结论：**对这个 hook 的消费方（agent）而言，「超时全灭」与「全绿静默」不可区分。**
//
// ── 本模块做什么 ─────────────────────────────────────────────────────────────
// 让 hook 在运行时**把外层那个数读进来**，用它算自己的墙钟预算：
//   · `resolveRegisteredTimeoutMs()` —— 从 live settings.json 里找到「我自己」那条注册，
//     取它的 `timeout`（秒）。找不到就退到保守缺省，并**如实说明是退化来的**。
//   · `createBudget()` —— 给出剩余量、能不能起下一个子进程、以及一行可打印的余量数字。
// 于是「内层常量 vs 外层注册」从**两个文件里互不知情的两个数**，
// 变成**一个运行时可核的关系**；降级路径也从「等某个子进程超时」（够不着）
// 变成「预算见底就不起下一个，并明说这一项没跑」（必然到得了）。
//
// ⚠ **为什么读的是 live `~/.claude/settings.json` 这个「投影」而不是 cc-switch DB 那个源**：
// dao.md「改配置先认源与投影」讲的是**写**的时候要认源。这里是**读**，而且问的是
// 「此刻谁会杀我」——那就是 live 那一份。读源反而会答错（源换了但还没下发时）。
//
// 真相源：windsurf-dao/ccswitch/lib/hook-budget.js

"use strict";

const fs = require("fs");
const path = require("path");

// 注册里**没写** `timeout` 时，本模块**假设**的宿主缺省值。
// ⚠️ **这个数是假设不是实测值，照直写**：2026-08-04 本机实测（Claude Code 2.1.221）
// 注册一个**不带 `timeout` 字段**、睡 70 秒的 SessionStart hook —— 它**跑完了**，
// transcript 记的是 `hook_success durationMs=70247`，没有任何 cancel。
// ⇒ 缺省值**至少 > 70 s**，也可能压根没有上限；广为流传的「缺省 60 秒」在这一版、
//    这个事件上**没有复现**（只测了 SessionStart 一个事件，别外推到 PreToolUse 等）。
// **仍然取 60000 是刻意的保守**：这个数只在「注册里没写 timeout」那一路用得上，
// 而估大会让 hook 以为还有余量、一头撞进宿主的刀口（正是本模块要治的病），
// 估小只会提前降级并明说没跑。方向不对称 ⇒ 取小的那侧。
const HOST_DEFAULT_TIMEOUT_MS = 60000;

// 连自己的注册都找不到时的假设值。**刻意取小不取大**：估大了会让 hook 以为还有余量、
// 一头撞进宿主的刀口（那正是本模块要治的病）；估小了只是提前降级并明说没跑，代价小得多。
// 取 10000 是因为本仓当前实际注册就是 10 秒 —— 找不到注册时，最可能的真相是它没变。
const FALLBACK_TIMEOUT_MS = 10000;

// 收尾余量：留给「拼报文 + 写 stdout + 宿主读走」这一段。
// 调参三问：①改小 → 报文可能写到一半被杀，而那等于整批检查白跑（见头注②）；
// ②当前值够不够 —— 本 hook 的报文是一次 `process.stdout.write`，本机实测 <5 ms，
// 1500 ms 是三个数量级的余量，够；③1500 与「够用的下界」之间那段代价是什么 ——
// 是少跑约一次 PowerShell 冷起（~600 ms）的检查，可接受，且那一项会被明说「没跑」。
const DEFAULT_RESERVE_MS = 1500;

/**
 * 从 settings.json 里找出「这个 hook 文件」自己的注册 timeout。
 *
 * 多条注册命中时取**最小值**（fail-closed）：同一个脚本可能挂在多个事件上，
 * 而杀我的是当前这一次的那个值；分不清是哪一次时，按最紧的那个活着最安全。
 *
 * @param {object} opts
 * @param {string} opts.hookFile      本 hook 的文件路径（用 basename 匹配 command 串）
 * @param {string} [opts.settingsPath] settings.json 路径；缺省按 HOME/USERPROFILE 推
 * @param {string} [opts.hookEventName] 当前事件名（如 "SessionStart"）；命中时优先取该事件下的
 * @returns {{ms:number, source:string, note:string, matched:number}}
 *   source: "registered" | "registered-default" | "fallback"
 */
function resolveRegisteredTimeoutMs(opts) {
  const o = opts || {};
  const base = path.basename(String(o.hookFile || ""));
  const baseNoExt = base.replace(/\.(js|mjs|cjs)$/, "");
  const home = o.home || process.env.HOME || process.env.USERPROFILE || "";
  const settingsPath = o.settingsPath || path.join(home, ".claude", "settings.json");

  const bail = (why) => ({
    ms: FALLBACK_TIMEOUT_MS,
    source: "fallback",
    matched: 0,
    note: "没能从注册里读出 timeout（" + why + "）⇒ 按保守缺省 " + FALLBACK_TIMEOUT_MS + " ms 算",
  });

  if (!baseNoExt) return bail("没给 hookFile");

  let raw;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (e) {
    return bail("读不到 " + settingsPath + "：" + (e && e.message ? e.message : String(e)));
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    return bail(settingsPath + " 解析失败：" + (e && e.message ? e.message : String(e)));
  }

  const hooks = cfg && cfg.hooks;
  if (!hooks || typeof hooks !== "object") return bail(settingsPath + " 里没有 hooks 段");

  // 收集所有「command 串里提到我」的注册条目，记下它挂在哪个事件上。
  const hits = [];
  for (const eventName of Object.keys(hooks)) {
    const groups = hooks[eventName];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const entries = group && Array.isArray(group.hooks) ? group.hooks : [];
      for (const entry of entries) {
        if (!entry || typeof entry.command !== "string") continue;
        if (!entry.command.includes(baseNoExt)) continue;
        const hasField = typeof entry.timeout === "number" && isFinite(entry.timeout) && entry.timeout > 0;
        hits.push({
          eventName,
          ms: hasField ? Math.round(entry.timeout * 1000) : HOST_DEFAULT_TIMEOUT_MS,
          explicit: hasField,
        });
      }
    }
  }
  if (!hits.length) return bail("settings.json 里没有提到 " + baseNoExt + " 的注册");

  // 当前事件下有命中就只看那一批；没有就看全部（跨事件复用时的兜底）。
  const scoped = o.hookEventName ? hits.filter((h) => h.eventName === o.hookEventName) : [];
  const pool = scoped.length ? scoped : hits;
  let best = pool[0];
  for (const h of pool) if (h.ms < best.ms) best = h;

  return {
    ms: best.ms,
    source: best.explicit ? "registered" : "registered-default",
    matched: pool.length,
    note: best.explicit
      ? "读自 " + settingsPath + " 的 " + best.eventName + " 注册（timeout=" + (best.ms / 1000) + "s" +
        (pool.length > 1 ? "，" + pool.length + " 条命中取最小" : "") + "）"
      : "注册里没写 timeout ⇒ 按宿主缺省 " + HOST_DEFAULT_TIMEOUT_MS + " ms 算（" + best.eventName + "）",
  };
}

/**
 * 造一个墙钟预算对象。
 *
 * @param {object} opts
 * @param {number} opts.totalMs   宿主给的总时长
 * @param {number} [opts.startedAt] 计时起点（缺省取**进程启动时刻**，不是本函数被调用时刻——
 *                                  宿主的刀从 spawn 那一刻就开始计时，node 自身的 bootstrap
 *                                  也在预算内，按调用时刻算会系统性高估余量）
 * @param {number} [opts.reserveMs] 收尾余量
 * @param {function} [opts.now]     取时函数（测试可注入）
 */
function createBudget(opts) {
  const o = opts || {};
  const now = typeof o.now === "function" ? o.now : () => Date.now();
  const totalMs = Number(o.totalMs) > 0 ? Number(o.totalMs) : FALLBACK_TIMEOUT_MS;
  const reserveMs = Number.isFinite(o.reserveMs) && o.reserveMs >= 0 ? Number(o.reserveMs) : DEFAULT_RESERVE_MS;
  const startedAt = Number.isFinite(o.startedAt)
    ? Number(o.startedAt)
    : now() - Math.round(process.uptime() * 1000);
  const deadlineAt = startedAt + totalMs - reserveMs;

  const skipped = [];
  const api = {
    totalMs,
    reserveMs,
    startedAt,
    deadlineAt,
    skipped,
    /** 距离「该收尾了」还剩多少毫秒（可为负） */
    left() { return deadlineAt - now(); },
    /** 已经花掉多少毫秒 */
    elapsed() { return now() - startedAt; },
    /** 余量够不够起一个至少要 minMs 的活 */
    canAfford(minMs) { return api.left() >= Number(minMs || 0); },
    /**
     * 把一个内层超时常量夹到剩余预算之内。
     * 这一步就是「内层永远先于外层响」的机器保证：返回值恒 <= 剩余预算。
     */
    capFor(wantMs) {
      const l = api.left();
      if (l <= 0) return 1;
      return Math.max(1, Math.min(Number(wantMs) || 0, l));
    },
    /** 记一笔「这项没跑」，并返回给用户看的那一行 */
    skip(what, minMs) {
      skipped.push(what);
      return "⏱ " + what + " **没跑**：宿主预算只剩 " + api.left() + " ms，起它至少要 " +
        minMs + " ms —— **这不是「通过」，是「没测」**（issue #127）";
    },
    /**
     * 内层常量自检：列出「比宿主总预算还大」的常量。
     * 这些常量背后的降级路径**结构上不可达** —— 宿主的刀先落下。
     * 本函数就是 issue #127 那条判据的机器化：让「两个文件里互不知情的两个数」
     * 变成每次运行都被核一遍的关系。
     */
    unreachableConstants(pairs) {
      const bad = [];
      for (const [name, ms] of pairs || []) if (Number(ms) > totalMs) bad.push(name + "=" + ms + "ms");
      return bad;
    },
  };
  return api;
}

module.exports = {
  resolveRegisteredTimeoutMs,
  createBudget,
  HOST_DEFAULT_TIMEOUT_MS,
  FALLBACK_TIMEOUT_MS,
  DEFAULT_RESERVE_MS,
};
