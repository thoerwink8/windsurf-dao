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
const {
  resolveRegisteredTimeoutMs, createBudget, toBudgetMs,
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

console.log("\n=== resolveRegisteredTimeoutMs · 项目级注册也要认（issue #142）===");
// 不再显式传 settingsPath：走「用户级 home + 项目级 cwd」自动双 scope 路径。
// helper 各自造一对独立目录（互不干扰），home/cwd 分开传。
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
function writeSettingsAt(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2), "utf8");
}
{
  // ① 只有用户级有注册，项目级压根没有 settings.json（今天的现实状况）。
  //    结果必须与「只读用户级」逐数值相同，但 note 现在会**如实报告**已经查过项目级。
  const home = mkHome("only-user", reg("SessionStart", [
    { type: "command", command: 'node "/x/ccswitch/hooks/dao-scaffold-check.js"', timeout: 10 },
  ]));
  const cwd = mkCwd("only-user", undefined); // 目录存在但没有 .claude/settings.json
  const r = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", home, cwd });
  check("只有用户级注册 → 10000ms（数值与旧行为一致）", r.ms === 10000 && r.source === "registered", JSON.stringify(r));
  check("note 如实报告项目级也被查过、且零命中（不是「没查」）",
    /已核对 2 处 scope/.test(r.note) && /project\(读取失败\)/.test(r.note), r.note);
}
{
  // ② issue #142 的核心场景：用户级 10s，项目级 3s（更紧）。
  //    2026-08-08 官方文档核实：两条不同（timeout 不同）⇒ 宿主两条都跑，各自独立计时。
  //    本模块的策略是「取最小」——这里断言的正是「取到项目级那个更紧的数」。
  const home = mkHome("tighter-project", reg("SessionStart", [
    { type: "command", command: 'node "/x/ccswitch/hooks/dao-scaffold-check.js"', timeout: 10 },
  ]));
  const cwd = mkCwd("tighter-project", reg("SessionStart", [
    { type: "command", command: 'node "/x/ccswitch/hooks/dao-scaffold-check.js"', timeout: 3 },
  ]));
  const r = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", home, cwd });
  check("🔴 项目级注册更紧(3s) → 取 3000ms，不是用户级的 10000ms（issue #142 的原始事故场景）",
    r.ms === 3000 && r.source === "registered", JSON.stringify(r));
  check("matched 报出两处合计命中数（2）", r.matched === 2, JSON.stringify(r));
  check("note 点名核对了两处 scope 且都报了各自命中数",
    /已核对 2 处 scope/.test(r.note) && /user\(1\)/.test(r.note) && /project\(1\)/.test(r.note), r.note);
}
{
  // ③ 反过来：用户级更紧(3s)，项目级更松(30s) —— 钉住不是「后者覆盖前者」也不是「取项目级」，
  //    而是真的在**取最小**（否则这条会把 R2 的方向读反）。
  const home = mkHome("tighter-user", reg("SessionStart", [
    { type: "command", command: 'node "/x/ccswitch/hooks/dao-scaffold-check.js"', timeout: 3 },
  ]));
  const cwd = mkCwd("tighter-user", reg("SessionStart", [
    { type: "command", command: 'node "/x/ccswitch/hooks/dao-scaffold-check.js"', timeout: 30 },
  ]));
  const r = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", home, cwd });
  check("反向：用户级更紧时取用户级的 3000ms（钉住判据是「取最小」不是「取项目级」）",
    r.ms === 3000, JSON.stringify(r));
}
{
  // ④ 项目级注册的是**别的 hook**，不该被当成我的注册（同伴用例，钉住 baseNoExt 过滤仍生效）。
  const home = mkHome("project-other-hook", reg("SessionStart", [
    { type: "command", command: 'node "/x/ccswitch/hooks/dao-scaffold-check.js"', timeout: 10 },
  ]));
  const cwd = mkCwd("project-other-hook", reg("SessionStart", [
    { type: "command", command: 'node "/x/ccswitch/hooks/dao-rule-echo.js"', timeout: 2 },
  ]));
  const r = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", home, cwd });
  check("项目级注册的是别的 hook → 不吃它的 2s，仍是用户级的 10000ms",
    r.ms === 10000, JSON.stringify(r));
  check("note 里项目级报的命中数是 0（查过、没找到我，不是没查）", /project\(0\)/.test(r.note), r.note);
}
{
  // ⑤ 两处都没有任何注册（都存在但都不提我）⇒ 必须 bail 到 fallback，且措辞体现「查了两处」，
  //    不能落回旧版单路径那句「settings.json 里没有提到」（那句话对双 scope 场景是误导性的）。
  const home = mkHome("neither-scope", reg("SessionStart", [
    { type: "command", command: 'node "/x/ccswitch/hooks/dao-rule-echo.js"', timeout: 5 },
  ]));
  const cwd = mkCwd("neither-scope", reg("SessionStart", [
    { type: "command", command: 'node "/x/ccswitch/hooks/dao-rule-echo.js"', timeout: 5 },
  ]));
  const r = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", home, cwd });
  check("两处都不提我 → fallback", r.source === "fallback" && r.ms === FALLBACK_TIMEOUT_MS, JSON.stringify(r));
  check("bail 措辞体现「已扫两处」（不是单路径那句「没有提到」的原文，两种场景的可核实信息不同）",
    /已扫 2 处/.test(r.note), r.note);
}
{
  // ⑥ 两处都读不到（用户级目录压根不存在 / 项目级目录也不存在）⇒ bail 措辞体现「已尝试」而非「已扫」。
  const home = path.join(SANDBOX, "both-missing", "nope-home");
  const cwd = path.join(SANDBOX, "both-missing", "nope-proj");
  const r = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", home, cwd });
  check("两处都读不到 → fallback", r.source === "fallback" && r.ms === FALLBACK_TIMEOUT_MS, JSON.stringify(r));
  check("bail 措辞用「已尝试」（两处全部读取失败，与⑤「已扫」区分开——一个是读到了没命中，一个是压根没读到）",
    /已尝试 2 处/.test(r.note), r.note);
}
{
  // ⑦ 显式传 settingsPath 时，行为必须与旧版逐字节相同（不叠加项目级）——
  //    即使把 cwd 也传进去，只要给了 settingsPath 就只认它一个。
  const p = writeSettings("explicit-with-cwd", reg("SessionStart", [
    { type: "command", command: 'node "D:/x/ccswitch/hooks/dao-scaffold-check.js"', timeout: 10 },
  ]));
  const decoyCwd = mkCwd("explicit-with-cwd", reg("SessionStart", [
    { type: "command", command: 'node "D:/x/ccswitch/hooks/dao-scaffold-check.js"', timeout: 2 },
  ]));
  const r = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", settingsPath: p, cwd: decoyCwd });
  check("给了 settingsPath 时 cwd 被忽略（不吃 decoy 项目级的 2s，仍是显式路径的 10000ms）",
    r.ms === 10000, JSON.stringify(r));
  check("显式路径场景 note 不带 scope 后缀（与旧版逐字节相同）", !/已核对.*scope/.test(r.note), r.note);
}
{
  // ⑧ home === cwd（罕见但结构上可能）：只应该扫一份文件，不重复计入两次。
  const shared = mkHome("same-home-and-cwd", reg("SessionStart", [
    { type: "command", command: 'node "/x/ccswitch/hooks/dao-scaffold-check.js"', timeout: 6 },
  ]));
  const r = resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", home: shared, cwd: shared });
  check("home 与 cwd 是同一份文件时不重复扫（matched=1，不是 2）", r.matched === 1, JSON.stringify(r));
  check("note 不带 scope 后缀（只有一处，不构成「已核对多处」）", !/已核对.*scope/.test(r.note), r.note);
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
console.log("\n=== toBudgetMs · 「写坏了」必须与「没写」分开，且乘完之后还要再验一次（A1/A2）===");
// 这一组治的是两个 2026-08-05 对抗验证捞出来的洞，它们**方向相同**：非法输入走到了
// 整组假设里最乐观的那一个上，而这个模块自陈的原则是「猜错要往提前降级那侧错」。
//   A1：`timeout: 1e308` 能过 `isFinite`，但 `Math.round(×1000)` **溢出成 Infinity**
//       ⇒ 预算无限 ⇒ capFor 永不夹、canAfford 恒真、unreachableConstants 零点名
//       ⇒ **这个修复会安安静静地把自己整个关掉**。
//   A2：`0` / `-5` / `"10"` 一律被当成「字段不存在」⇒ 落 60000（6 倍高估），而不是 10000。
{
  check("合法：10 秒 → 10000 ms", toBudgetMs(10) === 10000, String(toBudgetMs(10)));
  check("合法：小数 0.5 秒 → 500 ms（不因为不是整数就判非法）", toBudgetMs(0.5) === 500, String(toBudgetMs(0.5)));
  check("合法：本体系当前最大的真实注册 120 秒 → 120000 ms（别把真实值误伤成非法）",
    toBudgetMs(120) === 120000, String(toBudgetMs(120)));

  // 🔴 A1：乘之前有限、乘之后溢出。本机实测 1e308×1000 与 1e306×1000 都是 Infinity。
  check("🔴 A1：1e308 → null（乘完溢出成 Infinity，只在乘之后才看得见）",
    toBudgetMs(1e308) === null, String(toBudgetMs(1e308)));
  check("🔴 A1 同族：1e306 → null（同样溢出）", toBudgetMs(1e306) === null, String(toBudgetMs(1e306)));
  check("🔴 A1 第二格：1e300 → null（**没有溢出**，乘出来是有限的 1e303 —— 只有上限线拦得住它）",
    toBudgetMs(1e300) === null, String(toBudgetMs(1e300)));

  // A2：写了但坏了的三种现实形态。`"10"` 是 JSON 里给数字加引号，最常见的手误之一。
  check("A2：0 → null", toBudgetMs(0) === null, String(toBudgetMs(0)));
  check("A2：-5 → null", toBudgetMs(-5) === null, String(toBudgetMs(-5)));
  check('A2：字符串 "10" → null（不做隐式转换：一个类型都写错的值不该被当成可信输入）',
    toBudgetMs("10") === null, String(toBudgetMs("10")));
  check("A2：NaN → null", toBudgetMs(NaN) === null, String(toBudgetMs(NaN)));
  check("A2：Infinity → null", toBudgetMs(Infinity) === null, String(toBudgetMs(Infinity)));
  check("A2：对象 → null", toBudgetMs({}) === null, String(toBudgetMs({})));

  // 上限线的两侧都要夹住 —— 只验「大的被拦」挡不住一个恒返回 null 的实现，
  // 也挡不住一个把上限设成 1 毫秒的实现。
  check("上限边界：恰好等于上限 → 合法（判据是 >，不是 >=）",
    toBudgetMs(MAX_PLAUSIBLE_TIMEOUT_MS / 1000) === MAX_PLAUSIBLE_TIMEOUT_MS,
    String(toBudgetMs(MAX_PLAUSIBLE_TIMEOUT_MS / 1000)));
  check("上限边界：超出上限 1 秒 → null",
    toBudgetMs(MAX_PLAUSIBLE_TIMEOUT_MS / 1000 + 1) === null);
  check("上限线本身取值合理：必须远大于本体系已知最大注册 120 s（否则会误伤真实配置）",
    MAX_PLAUSIBLE_TIMEOUT_MS > 120000, String(MAX_PLAUSIBLE_TIMEOUT_MS));
}
{
  // 端到端：从 settings.json 一路读到三态。三条 payload **只差 timeout 那一个字段**，
  // 其余（command / type / 事件名 / 摆放位置）逐字相同 —— 否则就分不清判决是被哪个字段做出的。
  const mk = (tag, entry) => writeSettings(tag, reg("SessionStart", [
    Object.assign({ type: "command", command: 'node "D:/x/ccswitch/hooks/dao-scaffold-check.js"' }, entry),
  ]));
  const ask = (p) => resolveRegisteredTimeoutMs({ hookFile: "dao-scaffold-check.js", settingsPath: p });

  const good = ask(mk("kind-good", { timeout: 10 }));
  const absent = ask(mk("kind-absent", {}));
  const bad0 = ask(mk("kind-zero", { timeout: 0 }));
  const badStr = ask(mk("kind-str", { timeout: "10" }));
  const badHuge = ask(mk("kind-huge", { timeout: 1e308 }));

  check("三态①合法 → registered / 10000", good.source === "registered" && good.ms === 10000, JSON.stringify(good));
  check("三态②没写 → registered-default / 宿主缺省",
    absent.source === "registered-default" && absent.ms === HOST_DEFAULT_TIMEOUT_MS, JSON.stringify(absent));
  check("🔴 三态③写坏了(0) → registered-invalid / **保守缺省**，不是宿主缺省",
    bad0.source === "registered-invalid" && bad0.ms === FALLBACK_TIMEOUT_MS, JSON.stringify(bad0));
  check('🔴 三态③写坏了("10" 字符串) → registered-invalid / 保守缺省',
    badStr.source === "registered-invalid" && badStr.ms === FALLBACK_TIMEOUT_MS, JSON.stringify(badStr));
  check("🔴 三态③写坏了(1e308 溢出) → registered-invalid / 保守缺省（不是 Infinity 预算）",
    badHuge.source === "registered-invalid" && badHuge.ms === FALLBACK_TIMEOUT_MS &&
    Number.isFinite(badHuge.ms), JSON.stringify(badHuge));
  check("三态②与③必须在 source 上分得开（合流回同一个值 = A2 那个洞原样复现）",
    absent.source !== bad0.source && absent.ms !== bad0.ms,
    absent.source + "/" + absent.ms + " vs " + bad0.source + "/" + bad0.ms);
  check("写坏了那一路的 note 说得出「坏在哪」与「落到哪」（读者能自己复核）",
    /写坏了/.test(badStr.note) && /"10"/.test(badStr.note) && /10000/.test(badStr.note), badStr.note);

  // 同伴用例：**结构上不可能命中**的那一条 —— 同样写着非法 timeout，但 command 里
  // 没提这个 hook。它必须落 fallback（= 压根没被认领），而不是 registered-invalid。
  // 它钉住的是：上面那些判决依赖的**不只是 timeout 字段**，还有「这条注册是不是我的」，
  // 而后者是一组用例共有的隐含约束 —— 不带这个同伴，那条约束会被当成背景写进结论。
  const notMine = writeSettings("kind-notmine", reg("SessionStart", [
    { type: "command", command: 'node "D:/x/ccswitch/hooks/dao-rule-echo.js"', timeout: "10" },
  ]));
  const nm = ask(notMine);
  check("同伴（结构上不可能命中）：非法 timeout 但注册的是别的 hook → fallback，不是 registered-invalid",
    nm.source === "fallback" && nm.ms === FALLBACK_TIMEOUT_MS, JSON.stringify(nm));
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

console.log("\n=== createBudget · unreachableConstants（门限是有效截止线，不是总预算）===");
// 🔴 2026-08-05 订正（对抗验证 ⑥ / A4）：门限从 `totalMs` 改成 `effectiveMs = totalMs - reserveMs`。
// 旧判据把**落在收尾余量那条缝里**的常量报成「够得着」，而 capFor 实际给不到那么多。
// 下面「抬到 30 秒」那一组就是这条缝的真实入口——**它正是本 PR 自己推荐给用户的那个动作**。
{
  const b = createBudget({ totalMs: 10000, reserveMs: 1500, startedAt: 0, now: () => 0 });
  check("effectiveMs = 总预算 - 收尾余量（capFor 在任何时刻都到不了它以上）",
    b.effectiveMs === 8500 && b.capFor(999999) <= b.effectiveMs, String(b.effectiveMs));
  const bad = b.unreachableConstants([["A", 30000], ["B", 20000], ["C", 5000]]);
  check("够不着的常量被逐个点名", bad.length === 2 && /A=30000ms/.test(bad[0]), JSON.stringify(bad));
  check("负控：够得着的常量不点名（判据不是「凡常量都报」）",
    !bad.join("").includes("C="), JSON.stringify(bad));
  check("边界：等于有效截止线（8500）不算不可达（判据是 >，不是 >=）",
    b.unreachableConstants([["D", 8500]]).length === 0);
  check("边界：比有效截止线大 1 ms 就算", b.unreachableConstants([["E", 8501]]).length === 1);
  check("🔴 订正靶：落在「总预算与有效截止线之间」的常量必须被点名（旧判据在这一格全绿）",
    b.unreachableConstants([["F", 9000]]).length === 1 && 9000 <= b.totalMs,
    JSON.stringify(b.unreachableConstants([["F", 9000]])));

  // 这个判决**不该**依赖「现在几点」——它是一条结构关系，不是运行期余量。
  // 不夹这一条，一个把门限写成 `left()` 的实现照样全绿（而那个实现会随耗时忽报忽不报）。
  let t = 0;
  const drift = createBudget({ totalMs: 10000, reserveMs: 1500, startedAt: 0, now: () => t });
  const early = drift.unreachableConstants([["G", 9000], ["H", 5000]]).join("|");
  t = 7000;   // 余量只剩 1500
  const late = drift.unreachableConstants([["G", 9000], ["H", 5000]]).join("|");
  check("判决与「现在几点」无关（同一批常量在 t=0 与 t=7000 得到同一答案）",
    early === late && early === "G=9000ms", early + " vs " + late);
}
{
  // 🔴 本批最承重的一条：**用户照 PR §五 把注册从 10 抬到 30 之后，两个 30000 仍须现形。**
  // 旧判据下 `30000 > 30000` 为假 ⇒ 它们从报文里消失，而 capFor 实际封在 28500、仍够不着
  // ⇒ 那条建议会关掉这道自检当时三分之二的发现。这一条红了就说明订正被改回去了。
  const raised = createBudget({ totalMs: 30000, reserveMs: 1500, startedAt: 0, now: () => 0 });
  const still = raised.unreachableConstants([
    ["DEAD_GATES_TIMEOUT_MS", 30000], ["PROVIDER_HOOKS_TIMEOUT_MS", 30000],
    ["CLAUSE_CHECK_TIMEOUT_MS", 20000], ["GIT_TIMEOUT_MS", 5000],
  ]);
  check("🔴 抬到 30 s 后，两个 30000 常量仍被点名（旧判据在这里是零点名）",
    still.length === 2 && /DEAD_GATES_TIMEOUT_MS=30000ms/.test(still[0]) &&
    /PROVIDER_HOOKS_TIMEOUT_MS=30000ms/.test(still[1]), JSON.stringify(still));
  check("同一批里 20000 与 5000 在 30 s 预算下确实够得着 → 不点名（负控：不是恒报）",
    !still.join("").includes("CLAUSE_CHECK") && !still.join("").includes("GIT_TIMEOUT"), JSON.stringify(still));
}
{
  // 同伴用例：**结构上不可能存在那条缝**的一组 —— reserveMs=0 时 effectiveMs === totalMs，
  // 新旧判据在此**必然给出同一答案**。它钉住的是「门限真的是 totalMs - reserveMs」，
  // 而不是「总预算减去一个写死的 1500」，也不是「凡是等于总预算的都报」。
  const noReserve = createBudget({ totalMs: 30000, reserveMs: 0, startedAt: 0, now: () => 0 });
  check("同伴（缝在结构上不存在）：reserveMs=0 → effectiveMs === totalMs",
    noReserve.effectiveMs === noReserve.totalMs, String(noReserve.effectiveMs));
  check("同伴：reserveMs=0 时 30000 不算不可达（新旧判据在这一格必须一致）",
    noReserve.unreachableConstants([["DEAD_GATES_TIMEOUT_MS", 30000]]).length === 0);
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
  // 不注入 startedAt 时，起点必须是**进程启动时刻**，不是本函数被调用时刻。
  // 按调用时刻算会系统性高估余量 —— 而高估余量正是本模块要治的病。
  //
  // 🔴 **2026-08-05 补判别力（对抗验证 M14）**：这里原先只有 `elapsed() > 0`，而
  // 「按调用时刻算」通常也 > 0（只要中间过了 1 ms）—— 那个变异体**45 条断言零红**存活。
  // 一条守着「几乎必然为真」的断言提供的是虚假的安心。
  // 改法：直接拿 `process.uptime()` 当**独立的第二个量**去比。两者都是「进程活了多久」，
  // 但一个来自被测代码、一个来自 node 自己 —— 按调用时刻算的实现会让 elapsed 掉到
  // 接近 0，与 uptime（本机 hook 实测 ≈29 ms 起步，测试进程更大）差出量级。
  const uptimeMs = Math.round(process.uptime() * 1000);
  const b = createBudget({ totalMs: 10000 });
  check("缺省起点 = 进程启动时刻：elapsed 与 process.uptime() 同量级（差 < 50 ms）",
    Math.abs(b.elapsed() - uptimeMs) < 50, "elapsed=" + b.elapsed() + " uptime=" + uptimeMs);
  check("缺省起点确实把 node bootstrap 算进去了（elapsed 至少 10 ms —— 按调用时刻算会掉到 ~0）",
    b.elapsed() >= 10, "elapsed=" + b.elapsed() + " uptime=" + uptimeMs);
  check("缺省起点合理（elapsed 小于总预算，不是个荒谬的大数）",
    b.elapsed() < 10000, String(b.elapsed()));

  // 同伴（结构上不可能命中上面那条）：**显式注入 startedAt** 时，缺省那条路根本没走，
  // elapsed 与 uptime 必须**无关**。不带这个同伴，上面两条会被读成「elapsed 恒等于 uptime」。
  const injected = createBudget({ totalMs: 10000, startedAt: 1000, now: () => 1000 + 4000 });
  check("同伴：显式给了 startedAt → elapsed 由注入值决定，与 process.uptime() 无关",
    injected.elapsed() === 4000, String(injected.elapsed()));
}
{
  const b = createBudget({ totalMs: 0 });
  check("totalMs 非法（0）→ 落 fallback 而不是变成负预算", b.totalMs === FALLBACK_TIMEOUT_MS, String(b.totalMs));
}

console.log("\n=== isBudgetKill · 「这次是不是被我们自己的 timeout 夹死的」（两半各自可证）===");
// ── 为什么这组必须在单元级（issue #147 账 1）────────────────────────────────
// 这一判原先内联在 dao-scaffold-check.js 的 `gitOut` catch 里，PR #130 二轮对抗把
// **两半各自删掉**，两个变异体**双双存活**。根因不是漏写断言 —— 是**端到端结构上
// 分不开这两半**：node 因 timeout 杀子进程时 `code` 与 `signal` 是同时被设上的，
// 任一半单独留着都能让端到端照常通过。合成 error 对象是唯一能把它们拆开的地方。
// （端到端那一半另有正控：那个 hook 的 `DAO_HOOK_GIT_TIMEOUT_MS` 测试缝。两处都要有 ——
//  这里证「判据本身对」，那里证「这条路真的到得了」。）
const { isBudgetKill } = LIB;
{
  check("自检：isBudgetKill 真的被导出了（不是 undefined —— 否则下面全组空转）",
    typeof isBudgetKill === "function", typeof isBudgetKill);

  // 常态：node 的 timeout kill，两半同时出现
  check("常态（node timeout kill）：code=ETIMEDOUT + signal=SIGTERM → true",
    isBudgetKill({ code: "ETIMEDOUT", signal: "SIGTERM" }) === true);

  // 🔴 拆半：这两条各自钉住一半。删掉判据里的任一半，必有一条红。
  check("只剩 code 那一半：{code:ETIMEDOUT, signal:null} → true（钉住 code 半，删它即红）",
    isBudgetKill({ code: "ETIMEDOUT", signal: null }) === true);
  check("只剩 signal 那一半：{code:undefined, signal:SIGTERM} → true（钉住 signal 半，删它即红）",
    isBudgetKill({ signal: "SIGTERM" }) === true);

  // 负控组：这三种是 git 自己的正常失败态，报出来只会把「没跑」稀释成噪音。
  // 前两种的字段取值是 PR #130 两轮对抗在本机实测出来的，不是猜的。
  check("负控 · 命令不存在：{code:ENOENT, signal:null} → false",
    isBudgetKill({ code: "ENOENT", signal: null }) === false);
  check("负控 · 非仓库目录：{status:128, signal:null} → false",
    isBudgetKill({ status: 128, signal: null }) === false);
  check("负控 · git 业务失败：{status:1, stderr:...} → false",
    isBudgetKill({ status: 1, stderr: "fatal: not a git repository" }) === false);

  // 健壮性：catch 里拿到的东西未必是 Error（也可能是 undefined / 字符串）
  check("负控 · null → false（不许抛）", isBudgetKill(null) === false);
  check("负控 · undefined → false（不许抛）", isBudgetKill(undefined) === false);
  check("负控 · 空对象 → false", isBudgetKill({}) === false);
  check("负控 · 字符串 → false（不许抛）", isBudgetKill("boom") === false);

  // 反向语料（判据被**放宽**的方向）：只写上面那些正例，挡不住一个 `return true` 的实现。
  // 上面 4 条负控合起来就是那道反向闸 —— 这里再点一个「近似但不是」的形态。
  check("反向：signal=SIGKILL 而无 ETIMEDOUT → false（那是别人杀的，不是我们的 timeout）",
    isBudgetKill({ signal: "SIGKILL" }) === false);
}

// ── 清理 ────────────────────────────────────────────────────────────────────
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
