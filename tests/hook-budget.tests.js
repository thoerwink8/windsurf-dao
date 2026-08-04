// hook-budget 两态自证 · 单元级（issue #127）
//
// 跑法：node tests/hook-budget.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 验的是哪一层：**「宿主给我多少时间」这个数能不能被 hook 自己算对**，以及
// **算错时往哪一侧错**。判据正文在 ccswitch/lib/hook-budget.js 头注（唯一真相源）。
//
// 它**不证明**宿主真的会在那个时刻开刀 —— 那一格是 2026-08-04 用真的 `claude -p`
// 跑出来的实测，记在被测模块的头注里，不是这套断言能覆盖的东西。
//
// ── 为什么每条判据都要两态 ───────────────────────────────────────────────────
// 这个模块的所有输出都是**数字**，而数字类判据的单向断言几乎夹不住任何东西：
// 「余量算出来是正数」在「总预算被读成 60 秒」时同样成立。故每条都配一个反向语料：
// 判据被放宽（读到更大的预算 / 上限不夹了 / 找不到注册却当成找到了）时必须有断言变红。

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LIB = require("../ccswitch/lib/hook-budget");
const { resolveRegisteredTimeoutMs, createBudget, HOST_DEFAULT_TIMEOUT_MS, FALLBACK_TIMEOUT_MS } = LIB;

const SANDBOX = path.join(__dirname, "..", "_tmp", "hook-budget-tests");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

function writeSettings(tag, obj) {
  const dir = path.join(SANDBOX, tag, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "settings.json");
  fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2), "utf8");
  return p;
}
// 构造一份形如真实 settings.json 的注册段
function reg(eventName, entries) {
  return { hooks: { [eventName]: [{ matcher: "startup", hooks: entries }] } };
}

fs.rmSync(SANDBOX, { recursive: true, force: true });

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== resolveRegisteredTimeoutMs · 读得到注册（两态）===");
{
  const p = writeSettings("explicit", reg("SessionStart", [
    { type: "command", command: 'node "D:/x/ccswitch/hooks/dao-scaffold-check.js"', timeout: 10 },
  ]));
  const r = resolveRegisteredTimeoutMs({ hookFile: "D:/x/ccswitch/hooks/dao-scaffold-check.js", settingsPath: p });
  check("显式 timeout=10 → 10000 ms 且 source=registered",
    r.ms === 10000 && r.source === "registered", JSON.stringify(r));
  check("note 里说得出这个数是从哪读来的（读者能自己复核）",
    /settings\.json/.test(r.note) && /SessionStart/.test(r.note), r.note);
}
{
  // 反向语料①：同一份 settings，但注册的是**别的 hook** ⇒ 必须落 fallback，
  // 不许因为「文件里有 hooks 段」就当成读到了自己那条。
  const p = writeSettings("other-hook", reg("SessionStart", [
    { type: "command", command: 'node "D:/x/ccswitch/hooks/dao-rule-echo.js"', timeout: 45 },
  ]));
  const r = resolveRegisteredTimeoutMs({ hookFile: "D:/x/ccswitch/hooks/dao-scaffold-check.js", settingsPath: p });
  check("误伤负控：只注册了别的 hook → fallback，不吃别人的 45s",
    r.source === "fallback" && r.ms === FALLBACK_TIMEOUT_MS, JSON.stringify(r));
}
{
  // 反向语料②：注册里**没写** timeout ⇒ 走宿主缺省那一路，且必须与显式那一路分得开。
  const p = writeSettings("no-timeout-field", reg("SessionStart", [
    { type: "command", command: 'node "D:/x/ccswitch/hooks/dao-scaffold-check.js"' },
  ]));
  const r = resolveRegisteredTimeoutMs({ hookFile: "D:/x/ccswitch/hooks/dao-scaffold-check.js", settingsPath: p });
  check("注册没写 timeout → 宿主缺省值，且 source 与显式那一路不同",
    r.ms === HOST_DEFAULT_TIMEOUT_MS && r.source === "registered-default", JSON.stringify(r));
}
{
  // 多条命中取**最小**（fail-closed）。反向语料：把顺序颠倒过来，答案必须一样 ——
  // 只验一种顺序会让「取第一条」这种实现照样全绿。
  const entries = (a, b) => [
    { type: "command", command: 'node "…/dao-scaffold-check.js"', timeout: a },
    { type: "command", command: 'node "…/dao-scaffold-check.js"', timeout: b },
  ];
  const p1 = writeSettings("multi-asc", reg("SessionStart", entries(8, 30)));
  const p2 = writeSettings("multi-desc", reg("SessionStart", entries(30, 8)));
  const r1 = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", settingsPath: p1 });
  const r2 = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", settingsPath: p2 });
  check("两条命中 → 取最小（升序摆放）", r1.ms === 8000, JSON.stringify(r1));
  check("两条命中 → 取最小（降序摆放，钉住「不是取第一条」）", r2.ms === 8000, JSON.stringify(r2));
  check("matched 报出命中条数（读者知道这个 8s 是从几条里挑的）", r1.matched === 2, JSON.stringify(r1));
}
{
  // 事件作用域：同一个脚本挂在两个事件上，取**当前事件**那一条，不取全局最小。
  const cfg = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "node dao-scaffold-check.js", timeout: 10 }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "node dao-scaffold-check.js", timeout: 2 }] }],
    },
  };
  const p = writeSettings("scoped", cfg);
  const inSession = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", settingsPath: p, hookEventName: "SessionStart" });
  const inPre = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", settingsPath: p, hookEventName: "PreToolUse" });
  const noEvent = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", settingsPath: p });
  check("给了 hookEventName=SessionStart → 取该事件那条（10s，不是全局最小 2s）",
    inSession.ms === 10000, JSON.stringify(inSession));
  check("反向：hookEventName=PreToolUse → 取 2s（钉住作用域真的在起作用）",
    inPre.ms === 2000, JSON.stringify(inPre));
  check("没给事件名 → 跨事件取最小（兜底方向是保守侧）",
    noEvent.ms === 2000, JSON.stringify(noEvent));
}
{
  // 认得出 .mjs / .cjs：注册串里写的是带扩展名的路径，而 basename 去扩展名后仍要匹配。
  const p = writeSettings("mjs", reg("SessionStart", [
    { type: "command", command: 'node "D:/x/ccswitch/hooks/dao-probe-thing.mjs"', timeout: 7 },
  ]));
  const r = resolveRegisteredTimeoutMs({ hookFile: "D:/x/ccswitch/hooks/dao-probe-thing.mjs", settingsPath: p });
  check(".mjs 也认得出（扩展名盲区是本仓踩过的老坑）", r.ms === 7000 && r.source === "registered", JSON.stringify(r));
}

console.log("\n=== resolveRegisteredTimeoutMs · 读不到时必须落保守侧（三种坏输入）===");
{
  const missing = path.join(SANDBOX, "nope", ".claude", "settings.json");
  const r = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", settingsPath: missing });
  check("settings.json 不存在 → fallback 且 note 说清原因",
    r.source === "fallback" && r.ms === FALLBACK_TIMEOUT_MS && /读不到/.test(r.note), JSON.stringify(r));
}
{
  const p = writeSettings("badjson", "{ 这不是 JSON");
  const r = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", settingsPath: p });
  check("settings.json 解析失败 → fallback（不抛、不静默当成没超时）",
    r.source === "fallback" && /解析失败/.test(r.note), JSON.stringify(r));
}
{
  const p = writeSettings("nohooks", { permissions: { deny: [] } });
  const r = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", settingsPath: p });
  check("没有 hooks 段 → fallback", r.source === "fallback" && /没有 hooks 段/.test(r.note), JSON.stringify(r));
}
{
  // fallback 的**方向**必须是保守侧：它得小于宿主缺省值，否则「猜」会把 hook 送进刀口。
  check("fallback 值 < 宿主缺省值（猜错时往提前降级那侧错，不往撞刀那侧错）",
    FALLBACK_TIMEOUT_MS < HOST_DEFAULT_TIMEOUT_MS, FALLBACK_TIMEOUT_MS + " vs " + HOST_DEFAULT_TIMEOUT_MS);
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== createBudget · 余量算术（注入时钟，不靠真实时间）===");
{
  let t = 1000;
  const b = createBudget({ totalMs: 10000, reserveMs: 1500, startedAt: 1000, now: () => t });
  check("起点即 elapsed=0", b.elapsed() === 0, String(b.elapsed()));
  check("起点余量 = 总预算 - 收尾余量", b.left() === 8500, String(b.left()));
  t = 1000 + 4000;
  check("走了 4s → elapsed=4000", b.elapsed() === 4000, String(b.elapsed()));
  check("走了 4s → 余量 4500", b.left() === 4500, String(b.left()));
  t = 1000 + 9000;
  check("超过截止 → 余量为负（不夹成 0，负数本身是信息）", b.left() === -500, String(b.left()));
}
{
  let t = 0;
  const b = createBudget({ totalMs: 10000, reserveMs: 1500, startedAt: 0, now: () => t });
  check("canAfford 正态：余量 8500 ≥ 1200 → 真", b.canAfford(1200) === true);
  t = 8000;   // 余量 500
  check("canAfford 负态：余量 500 < 1200 → 假（钉住它真的在比，而不是恒真）",
    b.canAfford(1200) === false, "left=" + b.left());
  check("canAfford 边界：余量 500 ≥ 500 → 真（判据是 >=，两侧都夹住）", b.canAfford(500) === true);
  check("canAfford 边界：余量 500 ≥ 501 → 假", b.canAfford(501) === false);
}

console.log("\n=== createBudget · capFor 是「内层先于外层响」的机器保证 ===");
{
  let t = 0;
  const b = createBudget({ totalMs: 10000, reserveMs: 1500, startedAt: 0, now: () => t });
  check("余量充足时，capFor 返回内层常量本身（不无谓收紧）", b.capFor(3000) === 3000, String(b.capFor(3000)));
  check("内层常量比余量大 → 被夹到余量（30000 → 8500）", b.capFor(30000) === 8500, String(b.capFor(30000)));
  check("capFor 恒 ≤ 余量（这一条就是 issue #127 的核心不变式）",
    b.capFor(30000) <= b.left() && b.capFor(1) <= b.left());
  t = 9000;   // 余量 -500
  // 🔴 这一条是本文件最承重的断言：execFileSync 把 `timeout: 0` 解释成**不限时**。
  // capFor 一旦在余量耗尽时返回 0 或负数，子进程就变成**无上限**运行 —— 与本模块的目的
  // 恰好相反，而且它不会报错，只会安静地把整个 hook 送去被宿主杀掉。
  check("🔴 余量为负时 capFor 仍返回 ≥1（返回 0 会被 execFileSync 读成「不限时」）",
    b.capFor(30000) >= 1, String(b.capFor(30000)));
  check("余量为负时也不返回负数", b.capFor(30000) > 0, String(b.capFor(30000)));
}
{
  let t = 0;
  const b = createBudget({ totalMs: 10000, reserveMs: 1500, startedAt: 0, now: () => t });
  check("坏入参 capFor(0) → ≥1（0 是「不限时」，绝不能透传出去）", b.capFor(0) >= 1, String(b.capFor(0)));
  check("坏入参 capFor(NaN) → ≥1", b.capFor(NaN) >= 1, String(b.capFor(NaN)));
  check("坏入参 capFor(undefined) → ≥1", b.capFor(undefined) >= 1, String(b.capFor(undefined)));
}

console.log("\n=== createBudget · skip 记账与措辞 ===");
{
  let t = 8000;
  const b = createBudget({ totalMs: 10000, reserveMs: 1500, startedAt: 0, now: () => t });
  check("跳过前 skipped 为空", b.skipped.length === 0);
  const line = b.skip("死闸检测", 600);
  check("skip 记一笔账", b.skipped.length === 1 && b.skipped[0] === "死闸检测", JSON.stringify(b.skipped));
  check("skip 报文点名是哪一项", /死闸检测/.test(line), line);
  check("skip 报文明说「不是通过，是没测」（这句话是本批的全部意义）",
    /不是「通过」/.test(line) && /没测/.test(line), line);
  check("skip 报文带上余量与门槛两个数（读者能自己判断是不是该调）",
    /500/.test(line) && /600/.test(line), line);
}

console.log("\n=== createBudget · unreachableConstants（内层 vs 外层的可核关系）===");
{
  const b = createBudget({ totalMs: 10000, reserveMs: 1500, startedAt: 0, now: () => 0 });
  const bad = b.unreachableConstants([["A", 30000], ["B", 20000], ["C", 5000]]);
  check("比总预算大的常量被逐个点名", bad.length === 2 && /A=30000ms/.test(bad[0]), JSON.stringify(bad));
  check("负控：比总预算小的常量不点名（判据不是「凡常量都报」）",
    !bad.join("").includes("C="), JSON.stringify(bad));
  check("边界：等于总预算不算不可达（判据是 >，不是 >=）",
    b.unreachableConstants([["D", 10000]]).length === 0);
  check("边界：比总预算大 1 ms 就算", b.unreachableConstants([["E", 10001]]).length === 1);
}
{
  // 反向语料：总预算变大之后，同一批常量必须**不再**被点名 ——
  // 只验「30000 会被报」挡不住一个恒返回全部常量的实现。
  const big = createBudget({ totalMs: 60000, reserveMs: 1500, startedAt: 0, now: () => 0 });
  check("反向：总预算 60s 时，30s/20s 常量都够得着 → 零点名",
    big.unreachableConstants([["A", 30000], ["B", 20000]]).length === 0);
}

console.log("\n=== createBudget · 缺省起点取进程启动时刻，不取调用时刻 ===");
{
  // 不注入 startedAt 时，起点必须早于「现在」至少 node 自己的 bootstrap 那一段。
  // 按调用时刻算会系统性高估余量 —— 而高估余量正是本模块要治的病。
  const b = createBudget({ totalMs: 10000 });
  check("缺省起点在过去（elapsed > 0，包含了 node bootstrap）", b.elapsed() > 0, String(b.elapsed()));
  check("缺省起点合理（elapsed 小于总预算，不是个荒谬的大数）",
    b.elapsed() < 10000, String(b.elapsed()));
}
{
  const b = createBudget({ totalMs: 0 });
  check("totalMs 非法（0）→ 落 fallback 而不是变成负预算", b.totalMs === FALLBACK_TIMEOUT_MS, String(b.totalMs));
}

// ── 清理 ────────────────────────────────────────────────────────────────────
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
