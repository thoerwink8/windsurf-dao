// hook-budget 两态自证 · 单元级（每个行为分支留正控 + 负控/反向）
//
// 验的是「宿主给我多少时间」这个数能不能被 hook 自己算对，以及算错时往哪一侧错。
// 判据正文在 ccswitch/lib/hook-budget.js 头注（唯一真相源）。
// 所有输出都是数字，数字类判据的单向断言几乎夹不住任何东西 ⇒ 每条配反向语料：
// 判据被放宽（读到更大预算 / 上限不夹 / 找不到注册却当成找到）时必须有断言红。

const fs = require("fs");
const path = require("path");

const LIB = require("../ccswitch/lib/hook-budget");
const {
  resolveRegisteredTimeoutMs, createBudget, toBudgetMs, isBudgetKill,
  HOST_DEFAULT_TIMEOUT_MS, FALLBACK_TIMEOUT_MS, MAX_PLAUSIBLE_TIMEOUT_MS,
} = LIB;

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
function reg(eventName, entries) {
  return { hooks: { [eventName]: [{ matcher: "startup", hooks: entries }] } };
}
function writeSettingsAt(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2), "utf8");
}
function mkHome(tag, cfg) {
  const dir = path.join(SANDBOX, tag, "home");
  fs.mkdirSync(dir, { recursive: true });
  writeSettingsAt(path.join(dir, ".claude", "settings.json"), cfg);
  return dir;
}
function mkCwd(tag, cfg) {
  const dir = path.join(SANDBOX, tag, "proj");
  fs.mkdirSync(dir, { recursive: true });
  if (cfg !== undefined) writeSettingsAt(path.join(dir, ".claude", "settings.json"), cfg);
  return dir;
}
const HOOK_FILE = 'node "D:/x/ccswitch/hooks/dao-scaffold-check.js"';
const ask = (p) => resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", settingsPath: p });

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log("\n=== resolveRegisteredTimeoutMs · 读得到注册（含反向）===");
{
  const r = ask(writeSettings("explicit", reg("SessionStart", [{ type: "command", command: HOOK_FILE, timeout: 10 }])));
  check("显式 timeout=10 → 10000ms source=registered，note 说得出从哪读来",
    r.ms === 10000 && r.source === "registered" && /settings\.json/.test(r.note), JSON.stringify(r));
  const other = ask(writeSettings("other-hook", reg("SessionStart", [{ type: "command", command: 'node "…/dao-rule-echo.js"', timeout: 45 }])));
  check("反向：只注册了别的 hook → fallback，不吃别人的 45s", other.source === "fallback" && other.ms === FALLBACK_TIMEOUT_MS);
  const noT = ask(writeSettings("no-timeout", reg("SessionStart", [{ type: "command", command: HOOK_FILE }])));
  check("反向：注册没写 timeout → 宿主缺省且 source 与显式那一路分开",
    noT.ms === HOST_DEFAULT_TIMEOUT_MS && noT.source === "registered-default");
}
{
  // 多条命中取最小；顺序颠倒答案必须一样（只验一种顺序会让「取第一条」也全绿）。
  const mk = (a, b) => ask(writeSettings("multi" + a + b, reg("SessionStart", [
    { type: "command", command: HOOK_FILE, timeout: a }, { type: "command", command: HOOK_FILE, timeout: b },
  ])));
  check("两条命中 → 取最小，与摆放顺序无关", mk(8, 30).ms === 8000 && mk(30, 8).ms === 8000);
}
{
  // 事件作用域：取当前事件那条，不取全局最小；没给事件名 → 跨事件取最小（保守侧）
  const p = writeSettings("scoped", {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "node dao-scaffold-check.js", timeout: 10 }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "node dao-scaffold-check.js", timeout: 2 }] }],
    },
  });
  const ask2 = (ev) => resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", settingsPath: p, hookEventName: ev });
  check("事件作用域：SessionStart 取 10s、PreToolUse 取 2s、没给事件名取 2s（保守）",
    ask2("SessionStart").ms === 10000 && ask2("PreToolUse").ms === 2000 && ask2(undefined).ms === 2000);
}

console.log("\n=== resolveRegisteredTimeoutMs · 项目级注册（issue #142 场景）===");
{
  const home = mkHome("tighter-project", reg("SessionStart", [{ type: "command", command: 'node "/x/…/dao-scaffold-check.js"', timeout: 10 }]));
  const cwd = mkCwd("tighter-project", reg("SessionStart", [{ type: "command", command: 'node "/x/…/dao-scaffold-check.js"', timeout: 3 }]));
  const r = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", home, cwd });
  check("🔴 项目级更紧(3s) → 取 3000ms，matched=2，note 报两处各自命中数",
    r.ms === 3000 && r.matched === 2 && /user\(1\)/.test(r.note) && /project\(1\)/.test(r.note), JSON.stringify(r));
  const home2 = mkHome("tighter-user", reg("SessionStart", [{ type: "command", command: 'node "/x/…/dao-scaffold-check.js"', timeout: 3 }]));
  const cwd2 = mkCwd("tighter-user", reg("SessionStart", [{ type: "command", command: 'node "/x/…/dao-scaffold-check.js"', timeout: 30 }]));
  const r2 = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", home: home2, cwd: cwd2 });
  check("反向：用户级更紧时取用户级 3000ms（判据是「取最小」不是「取项目级」）", r2.ms === 3000, JSON.stringify(r2));
  const home3 = mkHome("other-project", reg("SessionStart", [{ type: "command", command: 'node "/x/…/dao-scaffold-check.js"', timeout: 10 }]));
  const cwd3 = mkCwd("other-project", reg("SessionStart", [{ type: "command", command: 'node "/x/…/dao-rule-echo.js"', timeout: 2 }]));
  const r3 = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", home: home3, cwd: cwd3 });
  check("反向：项目级注册的是别的 hook → 不吃它的 2s，仍 10000ms",
    r3.ms === 10000 && /project\(0\)/.test(r3.note));
}
{
  // 两处都不提我 → fallback，措辞体现「已扫 2 处」；两处都读不到 → fallback，措辞用「已尝试」
  const home = mkHome("neither", reg("SessionStart", [{ type: "command", command: 'node "…/dao-rule-echo.js"', timeout: 5 }]));
  const cwd = mkCwd("neither", reg("SessionStart", [{ type: "command", command: 'node "…/dao-rule-echo.js"', timeout: 5 }]));
  const r = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", home, cwd });
  check("两处都不提我 → fallback，措辞「已扫 2 处」", r.source === "fallback" && /已扫 2 处/.test(r.note));
  const r2 = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", home: path.join(SANDBOX, "nope1"), cwd: path.join(SANDBOX, "nope2") });
  check("两处都读不到 → fallback，措辞「已尝试 2 处」（读到了没命中 vs 压根没读到要分得开）",
    r2.source === "fallback" && /已尝试 2 处/.test(r2.note));
  const r3 = ask(writeSettings("badjson", "{ 这不是 JSON"));
  check("读不到/解析失败/无 hooks 段 → fallback（不抛、不静默当成没超时）",
    ask(path.join(SANDBOX, "nope", ".claude", "settings.json")).source === "fallback" &&
    r3.source === "fallback" && /解析失败/.test(r3.note) &&
    ask(writeSettings("nohooks", { permissions: { deny: [] } })).source === "fallback");
  check("fallback < 宿主缺省（猜错往提前降级那侧错，不往撞刀那侧错）",
    FALLBACK_TIMEOUT_MS < HOST_DEFAULT_TIMEOUT_MS);
}

console.log("\n=== toBudgetMs（A1 溢出 / A2 写坏 / 上限线）===");
{
  check("合法：10s→10000；小数 0.5→500；最大真实注册 120s→120000", 
    toBudgetMs(10) === 10000 && toBudgetMs(0.5) === 500 && toBudgetMs(120) === 120000);
  // A1：乘之前有限、乘之后溢出 ⇒ 预算无限 ⇒ 修复会安静地把自己整个关掉
  check("🔴 A1：1e308 → null（乘完溢出）；1e300 → null（没溢出，只有上限线拦得住）",
    toBudgetMs(1e308) === null && toBudgetMs(1e300) === null);
  // A2：写了但坏了的形态被当成「字段不存在」⇒ 落 6 倍高估
  check("A2：0 / -5 / 字符串 / NaN / 对象 → null（一个类型都写错的值不该被当可信输入）",
    [0, -5, "10", NaN, {}, Infinity].every((v) => toBudgetMs(v) === null));
  check("上限线两侧都夹：恰好等于上限合法（判据是 >）、超 1s null、上限远大于 120s",
    toBudgetMs(MAX_PLAUSIBLE_TIMEOUT_MS / 1000) === MAX_PLAUSIBLE_TIMEOUT_MS &&
    toBudgetMs(MAX_PLAUSIBLE_TIMEOUT_MS / 1000 + 1) === null && MAX_PLAUSIBLE_TIMEOUT_MS > 120000);
}
{
  // 端到端三态：三条 payload 只差 timeout 字段（其余逐字相同，否则分不清判决是被哪个字段做出的）
  const mk = (tag, entry) => ask(writeSettings(tag, reg("SessionStart", [Object.assign({ type: "command", command: HOOK_FILE }, entry)])));
  check("三态①合法 → registered/10000", mk("good", { timeout: 10 }).source === "registered");
  check("三态②没写 → registered-default/宿主缺省",
    mk("absent", {}).source === "registered-default" && mk("absent", {}).ms === HOST_DEFAULT_TIMEOUT_MS);
  check("🔴 三态③写坏(0/字符串/1e308) → registered-invalid/保守缺省，且 ②③ 在 source 上分得开",
    mk("zero", { timeout: 0 }).source === "registered-invalid" && mk("zero", { timeout: 0 }).ms === FALLBACK_TIMEOUT_MS &&
    mk("str", { timeout: "10" }).source === "registered-invalid" && mk("str", { timeout: "10" }).ms === FALLBACK_TIMEOUT_MS &&
    mk("huge", { timeout: 1e308 }).source === "registered-invalid" && Number.isFinite(mk("huge", { timeout: 1e308 }).ms));
  const nm = mk("notmine", { type: "command", command: 'node "…/dao-rule-echo.js"', timeout: "10" });
  check("同伴：非法 timeout 但注册的是别的 hook → fallback（不是 registered-invalid；判决依赖「这条是不是我的」）",
    nm.source === "fallback");
}

console.log("\n=== createBudget · 余量算术与 capFor（内层先于外层响）===");
{
  let t = 1000;
  const b = createBudget({ totalMs: 10000, reserveMs: 1500, startedAt: 1000, now: () => t });
  check("起点 elapsed=0、余量=总预算-收尾余量；走 4s 后 elapsed=4000 余量 4500",
    b.elapsed() === 0 && b.left() === 8500 && (t = 5000, true) && b.elapsed() === 4000 && b.left() === 4500);
  let t2 = 0;
  const c = createBudget({ totalMs: 10000, reserveMs: 1500, startedAt: 0, now: () => t2 });
  check("canAfford 正/负/边界（判据是 >=）：余量 8500≥1200 真；走 8s 后 500<1200 假、≥500 真、≥501 假",
    c.canAfford(1200) === true && (t2 = 8000, true) && c.canAfford(1200) === false &&
    c.canAfford(500) === true && c.canAfford(501) === false);
  check("🔴 余量为负时 capFor 仍 ≥1（返回 0 会被 execFileSync 读成「不限时」，与本模块目的相反）",
    (t2 = 9000, c.capFor(30000) >= 1 && c.capFor(NaN) >= 1 && c.capFor(undefined) >= 1 && c.capFor(0) >= 1));
  check("capFor 恒 ≤ 余量（issue #127 的核心不变式）；余量充足时返回内层常量本身",
    (() => { const f = createBudget({ totalMs: 10000, reserveMs: 1500, startedAt: 0, now: () => 0 });
      return f.capFor(3000) === 3000 && f.capFor(30000) === 8500 && f.capFor(30000) <= f.left(); })());
}

console.log("\n=== createBudget · skip 记账 / unreachableConstants / 缺省起点 ===");
{
  let t = 8000;
  const b = createBudget({ totalMs: 10000, reserveMs: 1500, startedAt: 0, now: () => t });
  const line = b.skip("死闸检测", 600);
  check("skip 记一笔账 + 报文明说「不是通过，是没测」+ 带余量与门槛两个数",
    b.skipped.length === 1 && /不是「通过」/.test(line) && /没测/.test(line) && /500/.test(line) && /600/.test(line), line);
}
{
  // 门限是 effectiveMs = totalMs - reserveMs，不是 totalMs——旧判据把落在收尾余量缝里的
  // 常量报成「够得着」，而 capFor 实际给不到那么多。
  const b = createBudget({ totalMs: 10000, reserveMs: 1500, startedAt: 0, now: () => 0 });
  check("🔴 订正靶：落在总预算与有效截止线之间（9000）的常量必须被点名，够得着的（5000）不点名",
    b.effectiveMs === 8500 && b.unreachableConstants([["F", 9000]]).length === 1 &&
    b.unreachableConstants([["C", 5000]]).length === 0);
  const raised = createBudget({ totalMs: 30000, reserveMs: 1500, startedAt: 0, now: () => 0 });
  check("🔴 抬到 30s 后两个 30000 常量仍被点名（旧判据这里零点名——那条建议会关掉自检 2/3 的发现）",
    raised.unreachableConstants([["DEAD_GATES_TIMEOUT_MS", 30000], ["PROVIDER_HOOKS_TIMEOUT_MS", 30000]]).length === 2);
  check("反向：总预算 60s 时 30s/20s 常量够得着 → 零点名（挡恒报实现）",
    createBudget({ totalMs: 60000, reserveMs: 1500, startedAt: 0, now: () => 0 }).unreachableConstants([["A", 30000], ["B", 20000]]).length === 0);
}
{
  // 缺省起点 = 进程启动时刻，不是调用时刻（按调用时刻算会系统性高估余量）。
  // 判别力：直接拿 process.uptime() 当独立的第二个量去比（按调用时刻算会掉到 ~0，差出量级）。
  const uptimeMs = Math.round(process.uptime() * 1000);
  const b = createBudget({ totalMs: 10000 });
  check("缺省起点 = 进程启动时刻：elapsed 与 uptime 同量级且 ≥10ms",
    Math.abs(b.elapsed() - uptimeMs) < 50 && b.elapsed() >= 10, `elapsed=${b.elapsed()} uptime=${uptimeMs}`);
  check("同伴：显式给 startedAt → elapsed 由注入值决定，与 uptime 无关",
    createBudget({ totalMs: 10000, startedAt: 1000, now: () => 5000 }).elapsed() === 4000);
  check("totalMs 非法（0）→ 落 fallback 而不是负预算",
    createBudget({ totalMs: 0 }).totalMs === FALLBACK_TIMEOUT_MS);
}

console.log("\n=== isBudgetKill（两半各自可证）===");
{
  // 端到端分不开这两半（node 杀子进程时 code 与 signal 同时被设上），合成 error 是唯一能拆开的地方。
  check("自检：isBudgetKill 真的被导出（否则全组空转）", typeof isBudgetKill === "function");
  check("常态：code=ETIMEDOUT + signal=SIGTERM → true",
    isBudgetKill({ code: "ETIMEDOUT", signal: "SIGTERM" }) === true);
  check("🔴 拆半：只剩 code 半（signal:null）→ true；只剩 signal 半（code:undefined）→ true（删判据任一半必红）",
    isBudgetKill({ code: "ETIMEDOUT", signal: null }) === true && isBudgetKill({ signal: "SIGTERM" }) === true);
  check("负控：git 自己的正常失败态（ENOENT / status 128 / status 1）→ false",
    isBudgetKill({ code: "ENOENT", signal: null }) === false &&
    isBudgetKill({ status: 128, signal: null }) === false &&
    isBudgetKill({ status: 1, stderr: "fatal: not a git repository" }) === false);
  check("健壮性：null/undefined/空对象/字符串 → false 不抛；SIGKILL 无 ETIMEDOUT → false（那是别人杀的）",
    isBudgetKill(null) === false && isBudgetKill(undefined) === false && isBudgetKill({}) === false &&
    isBudgetKill("boom") === false && isBudgetKill({ signal: "SIGKILL" }) === false);
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
