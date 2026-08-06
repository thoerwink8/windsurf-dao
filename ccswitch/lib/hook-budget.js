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

// 注册里 `timeout` 的**上限 sanity 线**（毫秒）。超过它一律判为「写坏了」，走 FALLBACK。
//
// 🔴 **它不是性能调优参数，是防一个会让整个模块静默自杀的算术洞**（2026-08-05 对抗验证 A1）：
// `timeout: 1e308` 本身是有限数、能过 `isFinite`，而 `Math.round(1e308 * 1000)` **溢出成
// `Infinity`**（本机实测：1e308 与 1e306 都溢出，1e300 不溢出但得到 1e303）。
// 一旦 totalMs 成了 Infinity 或 1e303：`left()` 恒为天文数字 ⇒ `capFor()` **永不夹**、
// `canAfford()` **恒真**、`unreachableConstants()` **零点名** —— 这个修复会**安安静静地
// 把自己整个关掉**，而报文上看起来一切正常。校验必须在**乘完之后**做，不能只在乘之前做。
//
// 调参三问（取 3600000 = 1 小时）：
//   ① 改小会怎样 —— 合法的大注册会被误判为非法、落到 10 s，于是提前降级并出声。
//      方向是安全侧，但会制造「本可以跑却没跑」的假降级，所以不该取得太紧；
//   ② 当前值够不够 —— 本体系里最大的一条真实注册是 `dao-codegraph-ensure` 的 **120 s**
//      （本机 `~/.claude/settings.json` 实读），宿主对不写 timeout 的 hook 实测放行到 **>70 s**。
//      1 小时是前者的 30 倍；
//   ③ 1 小时到「够用下界」之间那段有没有真实需求 —— 没有。一个把会话开场挂住超过一小时的
//      SessionStart hook，问题已经不是 timeout 该设多大。这段区间只承担「非法值被当成合法」
//      的风险，不承担任何真实需求。
const MAX_PLAUSIBLE_TIMEOUT_MS = 3600000;

/**
 * 把注册里那个 `timeout`（秒）翻译成毫秒；**翻译不出来就返回 null**（= 这个字段写坏了）。
 *
 * 三处校验缺一不可，且**顺序有意义**：
 *   ① 乘之前：必须是有限正数（挡 `"10"` 字符串 / `null` / `0` / 负数 / `NaN` / `Infinity`）；
 *   ② 乘之后：结果仍须有限（挡上面那个 1e308 溢出——这一格**只有乘完才看得见**）；
 *   ③ 上限：不超过 sanity 线（挡 1e300 这种「没溢出但荒谬」的值）。
 */
function toBudgetMs(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return null;
  const ms = Math.round(sec * 1000);
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_PLAUSIBLE_TIMEOUT_MS) return null;
  return ms;
}

/** 把任意值印成一行给人看的字面（对象/循环引用都不许抛） */
function describe(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null) return "null";
  if (typeof v === "object") return Object.prototype.toString.call(v);
  return String(v);
}

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
 *   source: "registered" | "registered-default" | "registered-invalid" | "fallback"
 *
 * ⚠️ **「没写」与「写坏了」是两回事，落到两个不同的假设上**（2026-08-05 对抗验证 A2）：
 *   · **没写** `timeout` ⇒ 走宿主缺省（60000）—— 那是宿主真实行为的保守估计，有实测背书；
 *   · **写了但非法**（`0` / `-5` / `"10"` 这种手写成字符串 / `NaN` / 溢出值）⇒ 走
 *     **FALLBACK（10000）**，不是宿主缺省。原先两者合流到 60000，等于**把一个已知写坏的
 *     配置送到整组假设里最乐观的那一个上**，与本模块「猜错要往提前降级那侧错」的原则**方向相反**
 *     （60000 是 10000 的 6 倍高估）。`"10"` 尤其现实：JSON 里给数字加引号是最常见的手误之一。
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
        // 三态：没写 / 写了且合法 / 写了但坏了（判据与理由见本函数 JSDoc）
        const present = Object.prototype.hasOwnProperty.call(entry, "timeout") &&
          entry.timeout !== undefined && entry.timeout !== null;
        const parsed = present ? toBudgetMs(entry.timeout) : null;
        const kind = !present ? "absent" : (parsed === null ? "invalid" : "explicit");
        hits.push({
          eventName,
          ms: kind === "explicit" ? parsed : (kind === "absent" ? HOST_DEFAULT_TIMEOUT_MS : FALLBACK_TIMEOUT_MS),
          kind,
          raw: present ? entry.timeout : undefined,
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

  const SOURCE_BY_KIND = { explicit: "registered", absent: "registered-default", invalid: "registered-invalid" };
  const NOTE_BY_KIND = {
    explicit: () => "读自 " + settingsPath + " 的 " + best.eventName + " 注册（timeout=" + (best.ms / 1000) + "s" +
      (pool.length > 1 ? "，" + pool.length + " 条命中取最小" : "") + "）",
    absent: () => "注册里没写 timeout ⇒ 按宿主缺省 " + HOST_DEFAULT_TIMEOUT_MS + " ms 算（" + best.eventName + "）",
    invalid: () => "注册里的 timeout 写坏了（" + describe(best.raw) + "）⇒ 按**保守缺省** " +
      FALLBACK_TIMEOUT_MS + " ms 算，**不按宿主缺省 " + HOST_DEFAULT_TIMEOUT_MS +
      " ms 算**（一个已知写坏的值不该落到最乐观的假设上）（" + best.eventName + "）",
  };
  return {
    ms: best.ms,
    source: SOURCE_BY_KIND[best.kind],
    matched: pool.length,
    note: NOTE_BY_KIND[best.kind](),
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
    /**
     * `capFor()` **在任何时刻都不可能超过的那个数** = totalMs - reserveMs。
     * （`capFor` 返回 `min(want, left())`，而 `left()` 在 t=startedAt 时取最大值，恰为本数。）
     * 「够不够得着」要拿它比，不能拿 totalMs 比 —— 见 unreachableConstants。
     */
    effectiveMs: deadlineAt - startedAt,
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
     *
     * 🔴 **下界必须是 1，不能是 0**：`child_process` 把 `timeout: 0` 解释成**不限时**。
     * 余量耗尽时若返回 0，子进程反而变成无上限运行 —— 与本模块的目的恰好相反，
     * 而且它不报错，只会安静地把整个 hook 送去被宿主杀掉。
     *
     * **这里原本还有一行 `if (l <= 0) return 1;`，2026-08-04 的 mutation 把它删掉与
     * 注释掉两种改法都跑了，45 条断言一条都没红 —— 因为下面这行 `Math.max(1, …)`
     * 已经覆盖了负余量那一路，它做的是同一件事。** 删掉不是为了省一行：一段
     * 删掉之后没有任何断言变化的代码，正是这个 issue 讲的那个形态（看着在守什么，
     * 其实什么都没守），把它留在治这个病的模块里最说不过去。
     */
    capFor(wantMs) {
      return Math.max(1, Math.min(Number(wantMs) || 0, api.left()));
    },
    /** 记一笔「这项没跑」，并返回给用户看的那一行 */
    skip(what, minMs) {
      skipped.push(what);
      return "⏱ " + what + " **没跑**：宿主预算只剩 " + api.left() + " ms，起它至少要 " +
        minMs + " ms —— **这不是「通过」，是「没测」**（issue #127）";
    },
    /**
     * 内层常量自检：列出**够不着的**常量 —— 它们背后的降级路径结构上不可达。
     * 本函数就是 issue #127 那条判据的机器化：让「两个文件里互不知情的两个数」
     * 变成每次运行都被核一遍的关系。
     *
     * 🔴 **门限是 `effectiveMs` 不是 `totalMs`**（2026-08-05 对抗验证 ⑥ / A4 订正）。
     * 原先比的是 totalMs，而 `capFor()` 能给出的上限是 `totalMs - reserveMs`，两者差一个
     * 收尾余量 —— 于是**落在这条缝里的常量「报为够得着，实际够不着」**。
     *
     * **这不是一格理论边界，它正要被这个 issue 自己的处方踩上**：本 PR 建议用户把注册的
     * timeout 从 10 抬到 30，抬完之后 `DEAD_GATES_TIMEOUT_MS` 与 `PROVIDER_HOOKS_TIMEOUT_MS`
     * 这两个 30000 就**不再 `> totalMs(30000)`、于是从报文里消失**，而 capFor 实际封在
     * 28500 —— 它们仍然够不着。⇒ **旧判据下，这个 PR 推荐的动作会关掉它自己这道自检
     * 当时三分之二的发现。** 改成 effectiveMs 后，抬到 30 那两条照旧现形。
     */
    unreachableConstants(pairs) {
      const bad = [];
      for (const [name, ms] of pairs || []) if (Number(ms) > api.effectiveMs) bad.push(name + "=" + ms + "ms");
      return bad;
    },
  };
  return api;
}

/**
 * 判定一个 `child_process` 同步调用抛出的 error 是不是「**被我们自己设的 timeout 夹死的**」。
 *
 * ── 为什么它值得单独成一个导出（2026-08-06 · issue #147 账 1）─────────────────
 * 它原先是 `dao-scaffold-check.js` 里 `gitOut` 的 catch 中一句内联表达式，而 PR #130
 * 二轮对抗把**两半判据各自删掉**，两个变异体**双双存活**（B1 / B2）—— 没有任何断言在守它。
 * 根因不是漏写断言，是**端到端结构上分不开这两半**：node 因 `timeout` 选项杀子进程时
 * `code` 与 `signal` 是**同时**被设上的，任一半单独留着都能让端到端照常通过。
 * ⇒ 只有把这一判抽成纯函数、拿**合成 error 对象**逐半去喂，两半才各自可证。
 * （同一批还给它补了一条端到端正控：见那个 hook 的 `DAO_HOOK_GIT_TIMEOUT_MS` 测试缝。）
 *
 * ── 判据（本次只搬家，语义与内联版逐字相同）─────────────────────────────────
 *   · `code === "ETIMEDOUT"` —— node 因 `timeout` 杀子进程时设的错误码；
 *   · `signal === "SIGTERM"` —— 同一次杀留下的信号（`killSignal` 缺省值）。
 * **两半都留是刻意的，不是冗余**：它们由 error 上两个**互不派生**的字段承载，
 * 某个平台 / 某个 node 版本上任一字段缺席时，另一半仍认得出这一次「没跑成」。
 * 照直写它的代价：常态下两半同时为真 ⇒ **端到端观察不到二者之差**，判别力只能由
 * 下面那张合成真值表提供；真值表若被删掉，这两半就又回到零守护。
 *
 * 🔴 **必须返回 false 的那些**（本机实测的三种非超时失败态）：命令不存在
 * `code="ENOENT" signal=null`、非仓库目录 `status=128 signal=null`、以及 git 自己的
 * 业务失败。它们在常路上是**正常结果**（沙箱里的垃圾 .git、没有 origin、裸目录），
 * 报出来只会把「没跑」这个信号稀释成「git 又抱怨了」—— 一个每次都响的信号等于没有信号。
 */
function isBudgetKill(e) {
  if (!e) return false;
  return e.code === "ETIMEDOUT" || e.signal === "SIGTERM";
}

module.exports = {
  resolveRegisteredTimeoutMs,
  createBudget,
  isBudgetKill,
  toBudgetMs,
  HOST_DEFAULT_TIMEOUT_MS,
  FALLBACK_TIMEOUT_MS,
  DEFAULT_RESERVE_MS,
  MAX_PLAUSIBLE_TIMEOUT_MS,
};
