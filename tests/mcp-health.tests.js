// mcp-health 回归网 — config-sync/lib/mcp-health.mjs 的正控/负控 + 三态判据
//
// @dao-test-tier: env
//
// 跑法：node tests/mcp-health.tests.js          （默认层：真机自跑那一节 defer 掉）
//       node tests/mcp-health.tests.js --env    （含真机自跑，本机实测 6-15s）
//       node scripts/run-tests.mjs              （自动发现，无需登记；默认层 → exit 2）
//       node scripts/run-tests.mjs --env        （透传 --env）
//
// ── 治的是什么病（issue #92）───────────────────────────────────────────────
// 已注册的 MCP server 连不上时无人发现。**判据来源须诚实**：本文件此前三处把「判不出
// 不许被静默当可连」写成「issue 关闭条件原句/明写」——2026-08-08 对抗复核逐字核对 issue
// #92 正文与评论后证伪：那句话不存在，唯一出处是实现官自己发在该 issue 上的交付评论。
// **这是实现取的安全侧判据（AI 自定），不是用户逐字要求的关闭条件**——判据本身仍然
// 成立（对抗复核 14 组破坏性验证认可主干），只是它的作者是官不是用户，是否升格为团队
// 共识留给 issue #70（待拍板总览）。issue #92 真正的关闭条件原文是：
//   > 有一个可重复跑的检查能报出「注册了但连不上」的 MCP（正控：人为造一个坏配置 →
//   > 报红；负控：全好 → 绿），且不把开工卡住 30 秒。
// 本文件钉住四层：
//   ① parseMcpListOutput —— 对已实测的真实输出形态解析正确，且 2026-08-08 对抗复核
//      修过一次真实缺陷：旧版贪婪匹配 + `\S+` 通吃任何 token，会被状态文本里恰好出现
//      的 ` - <普通词>` 切错行（dead/degraded 误判成 unknown）、甚至被状态文本里恰好
//      嵌入的 ` - ✔ Connected` 字面构造出假绿（死连接误判成 ok）。现在改成惰性匹配 +
//      字符类只认四个已知符号，两个方向的对抗样本都钉了回归用例（见 ①）；
//   ② probeMcpHealth —— I/O 边界那层，三种失败态分类正确，且**从不**把失败悄悄读成
//      state='ok'；2026-08-08 同批修了一个诊断归零的缺陷：`shell:true` 生产路径下
//      "命令找不到"永远拿不到 `ENOENT`（被 spawn 的是 cmd.exe，它自己存在），真正原因
//      躺在被丢弃的 `e.stderr` 里，现在接住并放进 `why`；
//   ③ computeMcpUniverse —— 2026-08-08 对抗复核新增，修的是期望名单宇宙取错的真实缺陷：
//      旧版只查 cc-switch DB 的 `enabled_claude=1`，而 `claude mcp list` 会报出所有它
//      认识的 server；当天 DB 只登记 5 个，真机实报 7 个，多出的 `opendesign` 恰好是死
//      连接、且正是 issue #92 表格点名的三个死连接之一——旧版因为它不在 DB 期望集里
//      而静默跳过。现在改成「DB 期望集 ∪ 探测实见」的并集；
//   ④ evaluateMcpHealth —— 判据核心：正控/负控各一，degraded/pending 两个中间态不落
//      pass 也不落 fail，探测**整体失败**时每一个期望 server 各自出一条「判不出」而
//      不是被折进 pass——即便当下所有真实 server 都健康，探测器自己挂了也绝不能报绿。
// 另有 wiring 检查：
//   · doctor.mjs 确实调用了 checkMcpHealth() —— 2026-08-08 对抗复核证伪了旧版这条断言
//     （纯文本匹配 `/checkMcpHealth\(\)/`，连 `// checkMcpHealth();` 这种注释掉的形态
//     都能匹配上，M8 实测：注释掉调用、整套测试照样全绿）。现在改成**行为级**——真跑
//     一次 doctor.mjs，断言输出里 MCP 健康态那一节真的印出了逐条判据行，不是空节；
//   · 全部**已注册** hook 都没有引用本模块——**issue #210 弱点①（覆盖面 1/15，PR #212
//     补到 2/17 仍是手点两个文件名）本轮修完**：改为复用 `check-dead-gates.mjs` 已有的
//     结构化遍历（`--json` 子进程 + `--live` 指回 git 快照本身，100% 由仓库内容决定、
//     不碰真实机器 `~/.claude/settings.json`），扫描面变成「当前注册了什么」的派生物，
//     不再手点文件名——细节见⑥「全量注册面」那一段。
//     🔴 **射程句（2026-08-09 二轮对抗复核 C1 · issue #210）：上面那个「全部已注册 hook」
//     是哪个分母，先说清**。本条守的面 ＝ **已注册 command hook 文件本身，深度 1**，
//     **不含它们 `require` 进来的 `ccswitch/lib/*` 共享模块**。故两个分母都得报：
//       · 分母＝**已注册 command hook 文件**（issue #210 原文钉死的那个）⇒ **18/18 ＝ 100%**，
//         按 #210 自己的定义，弱点①确实修完；
//       · 分母＝**同步热路径上真正会被加载的代码**（「热路径」三个字所指的那个）⇒
//         **18/23 ＝ 78.3%**。差额是 `require` 传递闭包上的 5 个 `ccswitch/lib/*`，其中
//         `hook-selfcheck.js` 被 **7 个 hook** 引用（PostToolUse · SubagentStart · Stop ·
//         UserPromptSubmit · StopFailure · PostCompact · SessionStart 全中）——往它注入一条
//         真 require 指向本模块，**新旧两版测试均 0 红**（实测 `exit=0 PASS=95`）。
//         这一格**本轮不抢修**，跟进单见 issue #210；那边同时钉着一句防回收利用的话：
//         堵它只需**静态扫 `require` 字面、一行代码都不执行**，所以下面弱点②那套
//         「顶层副作用太贵」的成本论证**否不掉这一格**，别下次拿它把两格一起否掉。
//     顺带一格同属射程外：注册面经 `JS_HOOK_EXT`（`.mjs|.cjs|.js`）过滤 ⇒ 将来若注册
//     `.ps1`/`.cmd` 型 hook，它既不被扫、又让下面那条 floor 的计数 −1。今天实况 0 个此形态，
//     **这是结构推断不是实测**。
//     **弱点②（字符串拼接可绕过子串匹配，M10 实测坐实）本轮仍不修**：改成本项判据类
//     改动这条不是"更懒"，是`ccswitch/rules/dao-guard-writing.md` 的既有判据——
//     文本匹配型护栏对"保留字面语义但改写掉字面 token"的形态天然失明，堵它需要真
//     require 一遍每个 hook 文件看依赖图（issue 建议的另一条修法），而这批 hook 文件
//     本身就是不带 `require.main===module` 守卫、直接在顶层跑副作用的脚本（`dao-hard-
//     gates.js` 顶层同步读 stdin、`dao-codegraph-ensure.js` 顶层会真的去起/连 codegraph
//     进程）——不搭配容器级隔离（关 stdin、拦 fs/spawn、超时熔断）就 require 它们，
//     测试进程本身就会触发它要防的那类热路径副作用，或者卡死等 stdin。这份隔离的成本
//     与风险都远超「防一个至今没有真实证据发生过的 P2 缺口」——按已有判据接受这个边界，
//     不再造第三种更复杂的正则/字符串分析去堵它，跟进单见 issue #210。
//
// 🔴 **射程边界（issue #210 二轮对抗复核缺口清单⑥，2026-08-09 补）**：上面那条「改成
// 行为级」的真验证住在 **⑦（真机自跑），而 ⑦ 整节只在 `--env` 下才执行**。默认层
// （`node tests/mcp-health.tests.js` 或 `node scripts/run-tests.mjs` 不带 `--env`）只跑
// ⑥ 那条静态文本信号——它本身也只是「快速信号，非最终判据」（见⑥断言原文），对「调用被
// 注释掉」这类改坏形态的判别力有限（M8 的真正克星是⑦真跑 doctor.mjs 断言 body 非空，
// 不是⑥的正则）。**结论**：`git push` 后若只跑默认层，M8 同型的「wiring 被悄悄拆掉」
// 不保证会被默认层拦下来；要拿到这份判别力必须显式跑 `--env`（合并前 / 收官前的
// 强制项，见 CLAUDE.md 测试分层一节）。同理，F1 生产接线（`computeMcpUniverse` 是否真被
// `doctor.mjs` 消费、而不是被换回纯 DB 期望集）与 F4 假绿修复的真实端到端验证也都挂在
// ⑦ 底下，同样只在 `--env` 生效。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const DOCTOR = path.join(REPO, "config-sync", "lib", "doctor.mjs");
const DEAD_GATES_SCRIPT = path.join(REPO, "ccswitch", "scripts", "check-dead-gates.mjs");
const SNAPSHOT_SETTINGS = path.join(REPO, "config-sync", "common", "settings.json");
const JS_HOOK_EXT = /\.(mjs|cjs|js)$/i;

const ENV_TIER = process.argv.includes("--env") || process.env.DAO_TEST_ENV_TIER === "1";

let pass = 0, fail = 0, defer = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}
function deferSection(name, why) {
  defer++;
  console.log("  DEFER " + name + "  ->  " + why);
}
const DEFER_WHY = "真机自跑：依赖本机是否装了 claude CLI 且耗时 6-15s。跑它：node tests/mcp-health.tests.js --env";

// ── 全量注册面：复用 check-dead-gates.mjs 的结构化遍历（issue #210 弱点①的修法）──
// 不手点文件名——被守护对象清单必须是「当前注册了什么 hook」这件事的派生物
// （`[#守-清单派生化]`），不是写死的两个文件名。**用法刻意收窄**：这里只是把
// check-dead-gates.mjs 当一个现成的「settings.json → 已注册命令 hook 文件列表」
// 解析器来复用，不是把它的死闸判据本身接进来（那是它自己的职责，本文件不复述）。
// `--live` 也指向 git 快照文件本身（与它默认扫的 `--snapshot-dir` 是同一份内容）、
// 并加 `--no-providers`——这样整次运行 100% 由仓库内文件决定、不读真实机器的
// `~/.claude/settings.json`，避免把「这台机器上凑巧有别的坏 hook」这类机器级可变
// 状态带进本测试的红绿判断（沙盒/夹具要求，见 issue #210 派单条款）。
function runDeadGatesJson() {
  return spawnSync(process.execPath,
    [DEAD_GATES_SCRIPT, "--json", "--no-providers", "--live", SNAPSHOT_SETTINGS],
    { encoding: "utf8", cwd: REPO, timeout: 30000 });
}
function resolveRegisteredHookFiles() {
  const r = runDeadGatesJson();
  if (r.error) return { ok: false, why: "子进程起不来：" + r.error.message, files: [] };
  const stdout = String(r.stdout || "");
  // --json 模式末尾另打一行 DEAD_GATES_SUMMARY（非 JSON 文本），JSON 主体截止到
  // 最后一个 "}\n"——这是它自己的输出契约（见该脚本 `out(summaryLine())` 那一行）。
  const cut = stdout.lastIndexOf("}\n");
  if (cut < 0) {
    return { ok: false, files: [],
      why: "输出里找不到 JSON 收尾（脚本可能崩了）。stdout=" + stdout.slice(0, 300) +
        " / stderr=" + String(r.stderr || "").slice(0, 300) };
  }
  let doc;
  try { doc = JSON.parse(stdout.slice(0, cut + 1)); }
  catch (e) { return { ok: false, why: "JSON 解析失败：" + e.message, files: [] }; }
  // 只取「快照/settings.json」这一层（git 里那份、已由 --live 同源覆盖）解析出的
  // 已注册命令条目，且 token 是 .js/.cjs/.mjs 形态——permissions 面、非脚本形态、
  // 以及本次未使用的 providers 层都不在此列。
  const snapAlive = (doc.alive || []).filter((a) =>
    String(a.origin || "").startsWith("快照/settings.json") && JS_HOOK_EXT.test(String(a.token || "")));
  const files = [...new Set(snapAlive.map((a) => a.token))];
  return { ok: true, files, doc };
}

async function main() {
  const mod = await import("../config-sync/lib/mcp-health.mjs");
  const { parseMcpListOutput, probeMcpHealth, evaluateMcpHealth, computeMcpUniverse, classifyGlyph, DEFAULT_TIMEOUT_MS } = mod;

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ① parseMcpListOutput：真实形态混合夹具 + 对抗回归 ────");
  // 夹具刻意不粘贴任何真实 token——本机实测抓到过一条 penpot 的 HTTP transport 行里
  // 带一个真实 session token，这里用假值替换，只保留结构形态。
  {
    const FIXTURE = [
      "Checking MCP server health…",
      "",
      "penpot: https://design.penpot.app/mcp/stream?userToken=FAKE.TOKEN.FOR.TEST (HTTP) - ! Connected · tools fetch failed — MCP error -32001: Request timed out",
      "chrome-devtools: cmd /c npx chrome-devtools-mcp@latest --browserUrl=http://127.0.0.1:9222 - ✔ Connected",
      "context7: cmd /c npx -y @upstash/context7-mcp@latest - ✔ Connected",
      "codegraph: cmd /c C:/fake/codegraph/node.exe --liftoff-only C:/fake/codegraph/codegraph.js serve --mcp - ✔ Connected",
      "opendesign: cmd /c npx -y open-design-mcp - ✘ Failed to connect — -32000: MCP error -32000: Connection closed",
      "fetch: uvx mcp-server-fetch --ignore-robots-txt - ✘ Failed to connect — -32000: MCP error -32000: Connection closed",
      "pendingsrv: unknown - ⏸ Pending approval",
      "trickyserver: cmd --flag-a - flag-b - ✔ Connected",
      "",
    ].join("\r\n");   // CRLF 混合，顺带验证 \r?\n 分行不受影响
    const servers = parseMcpListOutput(FIXTURE);
    check("banner/空行不产出条目，共解析出 8 条", servers.length === 8, JSON.stringify(servers.map((s) => s.name)));
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
    check("penpot 判 degraded（! 符号）", byName.penpot && byName.penpot.category === "degraded", JSON.stringify(byName.penpot));
    check("penpot 状态文本带出原因", byName.penpot && /tools fetch failed/.test(byName.penpot.statusText), JSON.stringify(byName.penpot));
    check("chrome-devtools 判 ok（✔ 符号）", byName["chrome-devtools"] && byName["chrome-devtools"].category === "ok");
    check("opendesign / fetch 判 dead（✘ 符号）",
      byName.opendesign && byName.opendesign.category === "dead" && byName.fetch && byName.fetch.category === "dead");
    check("pendingsrv 判 pending（⏸ 符号，来自文档字面）", byName.pendingsrv && byName.pendingsrv.category === "pending");
    check("trickyserver：detail 内部的独立 ' - ' 不切错行（惰性匹配钉在第一个已知符号前）",
      byName.trickyserver && byName.trickyserver.detail === "cmd --flag-a - flag-b" && byName.trickyserver.category === "ok",
      JSON.stringify(byName.trickyserver));
  }
  {
    // "weird" 这类状态符号不是四个已知符号之一的行，**不再产出一个 category='unknown'
    // 的条目**——正则的字符类现在只认 [✔✘!⏸]，这种行结构上就不匹配，直接从数组里消失。
    // 这不是退步：它消失之后，下游 evaluateMcpHealth 会把该 server 判成"missing"（没找到
    // 这一行），同样落 warn/判不出，安全性不变，只是少了一个中间层类别。
    const r = parseMcpListOutput("weird: something - ? mystery status");
    check("非四个已知符号的行 → 不产出条目（正则字符类只认 ✔✘!⏸，非退步：下游 missing 分支同样安全）",
      r.length === 0, JSON.stringify(r));
  }
  {
    check("空字符串 → 空数组", parseMcpListOutput("").length === 0);
    check("null/undefined 不抛异常，按空串处理", parseMcpListOutput(null).length === 0 && parseMcpListOutput(undefined).length === 0);
    check("纯 banner+空行 → 空数组", parseMcpListOutput("Checking MCP server health…\n\n").length === 0);
    check("没有冒号的行 → 不产出条目（不是合法形态）", parseMcpListOutput("this is not a valid line at all").length === 0);
  }
  console.log("\n  —— 对抗复核 ① 的两个真实反例，钉回归用例（PR #207 评论 #issuecomment-5226827654）——");
  {
    // 假阴性：状态文本自己含 " - <普通词>"，旧版贪婪匹配会把它误当分隔点。
    const r1 = parseMcpListOutput("fetch: uvx mcp-server-fetch - ✘ Failed to connect - Connection closed");
    check("对抗样本①（假阴性）：状态文本内嵌 ' - Connection closed' 不再把 dead 误判成 unknown",
      r1.length === 1 && r1[0].category === "dead" && r1[0].statusText === "Failed to connect - Connection closed",
      JSON.stringify(r1));
    const r2 = parseMcpListOutput("penpot: https://x/y (HTTP) - ! Connected - tools fetch failed");
    check("对抗样本②（假阴性）：状态文本内嵌 ' - tools fetch failed' 不再把 degraded 误判成 unknown",
      r2.length === 1 && r2[0].category === "degraded" && r2[0].statusText === "Connected - tools fetch failed",
      JSON.stringify(r2));
    // 假阳性（更危险）：状态文本里嵌了一段看起来像"另一个已知符号"的字面，旧版贪婪匹配
    // 会挑最后一个，把死连接误判成 ok——这是对抗复核实测出的可构造假绿。
    const r3 = parseMcpListOutput("fetch: uvx x - ✘ Failed - ✔ Connected");
    check("对抗样本③（假阳性/可构造假绿）：死连接的状态文本里嵌 ' - ✔ Connected' 不再被误判成 ok",
      r3.length === 1 && r3[0].category === "dead" && r3[0].statusText === "Failed - ✔ Connected",
      JSON.stringify(r3));
  }
  console.log("\n  —— 已知弱处（issue #210 item①）：假符号前置仍可构造假绿，本批钉回归用例、不改判据 ——");
  {
    // 与上面③相反的镜像方向：③ 挡的是"假符号嵌在状态文本里、位于真符号**之后**"（右侧嵌入）；
    // 这里是"假符号嵌在连接细节字段里、位于真符号**之前**"（左侧嵌入，issue #210 给出的
    // 具体形态）。惰性匹配取"从左往右第一个"符合形态的分隔点是本文件已知的、有意为之的
    // 取舍（见 LINE_RE 上方头注「仍然不是万能解」段）——两个方向不可能同时用一遍正则完全
    // 防住，选择保护③那个方向是因为"状态文本是自由文本"比"连接细节里出现装饰性符号
    // 字面"更容易在真实场景发生。这里不改判据，只把这个已知弱处从"一句头注文字"钉成
    // 显式回归断言：改 LINE_RE 时若这条判定意外变化，会先在这里变红，而不是被悄悄放过。
    const r = parseMcpListOutput("badserver: cmd --flag - ✔ fake - ✘ Failed to connect — Connection closed");
    check("已知弱处·钉住不是修复：细节字段里前置的假 ✔ 仍会盖过更靠右的真 ✘（category='ok'）—— " +
      "这是接受的结构性限制，此断言的价值在于「改 LINE_RE 让这里变了行为时会被看见」",
      r.length === 1 && r[0].category === "ok" && r[0].detail === "cmd --flag",
      JSON.stringify(r));
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── classifyGlyph：符号→类别的单点，独立于 LINE_RE 直接测 ────");
  {
    check("已知四符号各自映射正确", classifyGlyph("✔") === "ok" && classifyGlyph("✘") === "dead"
      && classifyGlyph("!") === "degraded" && classifyGlyph("⏸") === "pending");
    check("未知符号 → 'unknown'（LINE_RE 现在的字符类已经不会喂给它已知符号之外的东西，" +
      "这条断言钉住的是这个函数自己的防御性 fallback，不是当前可达路径）",
      classifyGlyph("?") === "unknown" && classifyGlyph("") === "unknown" && classifyGlyph(undefined) === "unknown");
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ② probeMcpHealth：I/O 边界的三种失败态分类 + stderr 捕获 ────");
  {
    const ok = probeMcpHealth({ execFn: () => "solo: cmd - ✔ Connected\n", timeoutMs: 999 });
    check("execFn 正常返回 → state='ok'，servers 与 parseMcpListOutput 一致", ok.state === "ok" && ok.servers.length === 1 && ok.servers[0].name === "solo", JSON.stringify(ok));
    check("timeoutMs 透传（不是被内部覆写）", ok.timeoutMs === 999, JSON.stringify(ok));
  }
  {
    const e = Object.assign(new Error("spawnSync claude mcp list ETIMEDOUT"), { signal: "SIGTERM" });
    const r = probeMcpHealth({ execFn: () => { throw e; } });
    check("execFn 抛 signal=SIGTERM → state='timeout'（不是 'ok'）", r.state === "timeout", JSON.stringify(r));
  }
  {
    const e = Object.assign(new Error("boom"), { code: "ETIMEDOUT" });
    const r = probeMcpHealth({ execFn: () => { throw e; } });
    check("execFn 抛 code=ETIMEDOUT → state='timeout'", r.state === "timeout", JSON.stringify(r));
  }
  {
    const e = Object.assign(new Error("spawnSync claude ENOENT"), { code: "ENOENT" });
    const r = probeMcpHealth({ execFn: () => { throw e; } });
    check("execFn 抛 code=ENOENT（命令找不到，仅 shell:false 时可达）→ state='unavailable'", r.state === "unavailable", JSON.stringify(r));
  }
  {
    const r = probeMcpHealth({ execFn: () => { throw new Error("something else broke"); } });
    check("execFn 抛其它异常（无 code/signal/stderr 线索）→ state='error'（不是 timeout/unavailable）", r.state === "error", JSON.stringify(r));
  }
  console.log("\n  —— 对抗复核 ② 的真实反例：shell:true 生产路径下 ENOENT 不可达，真原因在 e.stderr ——");
  {
    // 生产路径实测形态：cmd.exe 自己报"命令不存在"，code 是 undefined、status=1，
    // 真正原因在 stderr（对抗复核原文实测："'definitely-not-a-real-exe-xyz' 不是内部或
    // 外部命令"）。修法两件事都要钉住：① 广义 notFound 判据命中这类 stderr → 'unavailable'
    // （不再必然落 'error'）；② 不论落哪个分支，stderr 原文都要出现在 why 里，不能丢。
    const e = Object.assign(new Error("Command failed: definitely-not-a-real-exe-xyz mcp list"),
      { code: undefined, status: 1, signal: null, stderr: "'definitely-not-a-real-exe-xyz' 不是内部或外部命令，也不是可运行的程序\r\n或批处理文件。" });
    const r = probeMcpHealth({ execFn: () => { throw e; } });
    check("shell:true 生产路径的'命令不存在'（中文 cmd.exe 报错，无 ENOENT）→ state='unavailable'（不再落 error）",
      r.state === "unavailable", JSON.stringify(r));
    check("stderr 原文进了 why，不再只有无信息量的 'Command failed: …' 首行",
      /不是内部或外部命令/.test(r.why), JSON.stringify(r));
  }
  {
    // 英文系统的等价形态（POSIX sh 或英文 Windows）
    const e = Object.assign(new Error("Command failed: nope mcp list"),
      { stderr: "sh: 1: nope: not found" });
    const r = probeMcpHealth({ execFn: () => { throw e; } });
    check("英文 'not found' 形态同样判 unavailable", r.state === "unavailable", JSON.stringify(r));
    check("英文 stderr 同样进 why", /not found/.test(r.why), JSON.stringify(r));
  }
  {
    // 负控：stderr 存在但不匹配"命令不存在"的任何已知文案 → 仍然落 error，但 stderr 照样
    // 要出现在 why 里（诊断信息不能因为分类不上 unavailable 就被丢弃）。
    const e = Object.assign(new Error("Command failed: claude mcp list"),
      { status: 1, stderr: "some MCP server crashed with exit code 137" });
    const r = probeMcpHealth({ execFn: () => { throw e; } });
    check("负控：stderr 不含'命令不存在'文案 → 仍落 'error'（不误判成 unavailable）", r.state === "error", JSON.stringify(r));
    check("即使落 error，stderr 原文依然进了 why（诊断信息不因分类丢失）",
      /exit code 137/.test(r.why), JSON.stringify(r));
  }
  {
    const e = Object.assign(new Error("killed"), { signal: "SIGTERM", stdout: "partial: cmd - ✔ Connected\n" });
    const r = probeMcpHealth({ execFn: () => { throw e; } });
    check("超时但子进程已吐了部分 stdout → raw 保留原文，但 servers 恒为空（不尝试解析可能被截断的半行）",
      r.raw === "partial: cmd - ✔ Connected\n" && r.servers.length === 0, JSON.stringify(r));
  }
  {
    check("DEFAULT_TIMEOUT_MS 是正数（无环境变量覆写时的缺省值）", Number(DEFAULT_TIMEOUT_MS) > 0, String(DEFAULT_TIMEOUT_MS));
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ③ computeMcpUniverse：期望集并集（对抗复核修的真实漏报）────");
  {
    // 正是对抗复核抓到的那个形态：DB 只登记一部分，探测实见更多，其中一个是死连接
    // 且不在 DB 里——issue #92 表格点名的 opendesign 就是这个形态的真实实例。
    const probe = { state: "ok", servers: [
      { name: "chrome-devtools", category: "ok" },
      { name: "fetch", category: "dead" },
      { name: "opendesign", category: "dead" },   // 不在 dbNames 里
      { name: "penpot", category: "ok" },          // 不在 dbNames 里
    ] };
    const universe = computeMcpUniverse(["chrome-devtools", "fetch"], probe);
    check("并集包含探测实见但不在 DB 里的 server（opendesign/penpot 不再被静默跳过）",
      universe.includes("opendesign") && universe.includes("penpot"), JSON.stringify(universe));
    check("并集是排序后的去重结果（DB 与探测有重叠不重复计）",
      JSON.stringify(universe) === JSON.stringify(["chrome-devtools", "fetch", "opendesign", "penpot"]),
      JSON.stringify(universe));
  }
  {
    // F1 的镜像形态（2026-08-09 二轮对抗复核 F1-b 抓到的边界缺口，PR #207 评论
    // #issuecomment-5227085300）：DB 登记了、但这次 claude mcp list 没报出来（该
    // server 可能临时消失/输出被截断/宿主这次没打印它）——探测本身是 state==='ok'，
    // 只是这一个名字不在 probe.servers 里。它必须仍然留在并集里，不然会从体检整条
    // 消失，连 evaluateMcpHealth 那句"没找到这一行（判不出，不等于健康）"都不会出现。
    // F1 治的是"实报有、DB 无 ⇒ 漏"，这一格是"DB 有、实报无 ⇒ 漏"，同一条判据的另一半。
    const probe = { state: "ok", servers: [{ name: "a", category: "ok" }] };  // 'b' 没被探测到
    const universe = computeMcpUniverse(["a", "b"], probe);
    check("DB 登记但这次探测没报出来的 server（'b'）仍留在并集里，不因为探测 state==='ok' 就被丢弃",
      universe.includes("b"), JSON.stringify(universe));
  }
  {
    // 探测失败时不能凭空"看见"更多名字——宇宙退化为纯 DB 期望集，不多不少
    const probe = { state: "timeout", timeoutMs: 60000, why: "" };
    const universe = computeMcpUniverse(["a", "b"], probe);
    check("探测失败（非 state==='ok'）时并集 = 纯 DB 期望集（不会凭空多出名字）",
      JSON.stringify(universe) === JSON.stringify(["a", "b"]), JSON.stringify(universe));
  }
  {
    check("DB 传空数组 + 探测成功 → 并集 = 纯探测实见",
      JSON.stringify(computeMcpUniverse([], { state: "ok", servers: [{ name: "x" }] })) === JSON.stringify(["x"]));
    check("两边都空 → 空数组，不抛异常", computeMcpUniverse([], { state: "ok", servers: [] }).length === 0);
    check("dbNames 传非数组（防御性）→ 视为空", computeMcpUniverse(null, { state: "ok", servers: [{ name: "x" }] }).length === 1);
    check("probe 传 null（防御性）→ 视为纯 DB 期望集", JSON.stringify(computeMcpUniverse(["a"], null)) === JSON.stringify(["a"]));
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ④ evaluateMcpHealth：判据核心（正控/负控 + 三态）────");
  {
    // 负控：全好 → 全绿，零 warn 零 fail（issue #92 关闭条件原文的负控要求）
    const probe = { state: "ok", servers: [
      { name: "a", category: "ok", statusText: "Connected" },
      { name: "b", category: "ok", statusText: "Connected" },
    ] };
    const { summary } = evaluateMcpHealth(["a", "b"], probe);
    check("负控：全好 → 全部 pass，summary.warn=0 summary.fail=0", summary.pass === 2 && summary.warn === 0 && summary.fail === 0, JSON.stringify(summary));
  }
  {
    // 正控：人为造一个坏配置 → 报红（issue #92 关闭条件原文的正控要求）
    const probe = { state: "ok", servers: [
      { name: "a", category: "ok", statusText: "Connected" },
      { name: "b", category: "dead", statusText: "Failed to connect — Connection closed" },
    ] };
    const { lines, summary } = evaluateMcpHealth(["a", "b"], probe);
    const bLine = lines.find((l) => l.name === "b");
    check("正控：坏配置 → b 那条 level='fail'", bLine && bLine.level === "fail", JSON.stringify(lines));
    check("正控：报文指名到具体 server 与原因（只报个数字等于没报）",
      bLine && /连不上/.test(bLine.message) && /Connection closed/.test(bLine.message), JSON.stringify(bLine));
    check("正控：活的那条不被牵连（a 仍是 pass）", lines.find((l) => l.name === "a").level === "pass", JSON.stringify(lines));
    check("summary.fail=1（不多不少）", summary.fail === 1, JSON.stringify(summary));
  }
  {
    // 中间态：degraded 不落 pass 也不落 fail
    const probe = { state: "ok", servers: [{ name: "p", category: "degraded", statusText: "tools fetch failed" }] };
    const { lines, summary } = evaluateMcpHealth(["p"], probe);
    check("degraded → level='warn'（不是 pass，也不是 fail——它是「连上了但不完整」）",
      lines[0].level === "warn", JSON.stringify(lines));
    check("degraded 不计入 fail（连接本身没断，判它红会制造噪音）", summary.fail === 0, JSON.stringify(summary));
    check("degraded 也不计入 pass（不完整不算过关）", summary.pass === 0, JSON.stringify(summary));
  }
  {
    // 中间态：pending（宿主自己都没探测）
    const probe = { state: "ok", servers: [{ name: "q", category: "pending", statusText: "Pending approval" }] };
    const { lines } = evaluateMcpHealth(["q"], probe);
    check("pending → level='warn'", lines[0].level === "warn", JSON.stringify(lines));
  }
  {
    // 未知符号（防御性路径，当前 LINE_RE 已不产出这类条目，这里手工构造探测结果来验证
    // evaluateMcpHealth 自己那一侧的兜底分支仍然安全）
    const probe = { state: "ok", servers: [{ name: "z", category: "unknown", statusText: "?", raw: "z: x - ? y" }] };
    const { lines } = evaluateMcpHealth(["z"], probe);
    check("unknown 符号 → level='warn'（判不出，不是 pass）", lines[0].level === "warn", JSON.stringify(lines));
  }
  {
    // dead 且 statusText 为空 → 兜底用 raw，不留一个空荡荡的破折号尾巴
    const probe = { state: "ok", servers: [{ name: "d", category: "dead", statusText: "", raw: "d: cmd - ✘" }] };
    const { lines } = evaluateMcpHealth(["d"], probe);
    check("dead 且 statusText 为空 → 报文用 raw 兜底，不留空破折号", lines[0].message === "d：连不上 —— d: cmd - ✘", JSON.stringify(lines));
  }
  {
    // ⭐ 核心断言：期望的 server 根本没出现在输出里 → 判不出，绝不静默当健康
    const probe = { state: "ok", servers: [{ name: "a", category: "ok", statusText: "Connected" }] };
    const { lines, summary } = evaluateMcpHealth(["a", "missing-one"], probe);
    const mLine = lines.find((l) => l.name === "missing-one");
    check("探测输出里找不到的 server → level='warn'（不是静默通过，也不是 pass）", mLine && mLine.level === "warn", JSON.stringify(lines));
    check("报文明说「判不出」且「不等于健康」", mLine && /判不出/.test(mLine.message) && /不等于健康/.test(mLine.message), JSON.stringify(mLine));
    check("summary.pass 只计 1（a），missing-one 没被悄悄算进 pass", summary.pass === 1, JSON.stringify(summary));
  }
  {
    // ⭐⭐ 全场最重要的一组：探测整体失败时，即便"真实情况"全是好的，也绝不能报 pass。
    const names = ["a", "b", "c"];
    for (const st of [
      { state: "timeout", timeoutMs: 60000, why: "" },
      { state: "unavailable", why: "spawnSync claude ENOENT" },
      { state: "error", why: "something else broke" },
    ]) {
      const { lines, summary } = evaluateMcpHealth(names, st);
      check(`探测态=${st.state} → 全部 ${names.length} 条都是 warn，zero pass zero fail`,
        lines.length === names.length && lines.every((l) => l.level === "warn") && summary.pass === 0 && summary.fail === 0,
        JSON.stringify({ st, lines }));
      check(`探测态=${st.state} → 每条都点名是哪个 server 判不出（不是打一条汇总就完事）`,
        names.every((n) => lines.some((l) => l.name === n && /判不出/.test(l.message))),
        JSON.stringify(lines));
    }
    // 防御性：probe 本身是 null/undefined 时同样不许报健康
    const nullProbe = evaluateMcpHealth(names, null);
    check("probe=null（异常场景）→ 同样全 warn，不抛异常也不静默报 ok", nullProbe.lines.every((l) => l.level === "warn"), JSON.stringify(nullProbe));
  }
  {
    // tally 正确性：混合场景各计数相加等于总行数
    const probe = { state: "ok", servers: [
      { name: "a", category: "ok", statusText: "Connected" },
      { name: "b", category: "ok", statusText: "Connected" },
      { name: "c", category: "dead", statusText: "Failed" },
      { name: "d", category: "degraded", statusText: "partial" },
    ] };
    const { lines, summary } = evaluateMcpHealth(["a", "b", "c", "d", "e-missing"], probe);
    check("tally 各类相加 = 总行数（2 pass + 1 fail + 2 warn(degraded+missing) = 5）",
      summary.pass + summary.warn + summary.fail === lines.length && summary.pass === 2 && summary.fail === 1 && summary.warn === 2,
      JSON.stringify(summary));
  }
  {
    check("expectedNames 传非数组（防御性）→ 不抛异常，视为空清单", evaluateMcpHealth(null, { state: "ok", servers: [] }).lines.length === 0);
  }
  {
    // name 字段：每条 line 都带，且顺序与传入的 expectedNames 一一对应
    const probe = { state: "ok", servers: [{ name: "x", category: "ok" }, { name: "y", category: "dead" }] };
    const { lines } = evaluateMcpHealth(["x", "y"], probe);
    check("每条 line 都带 name 字段，且与传入顺序一致（调用方不必靠下标隐式对应）",
      lines[0].name === "x" && lines[1].name === "y", JSON.stringify(lines));
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ⑤ 环境变量覆写超时（需另起进程，模块级常量只在 import 时读一次）────");
  {
    const r = spawnSync(process.execPath, ["-e",
      "import('./config-sync/lib/mcp-health.mjs').then(m => console.log('TIMEOUT=' + m.DEFAULT_TIMEOUT_MS))"],
      { cwd: REPO, encoding: "utf8", env: Object.assign({}, process.env, { DAO_MCP_HEALTH_TIMEOUT_MS: "1234" }), timeout: 20000 });
    check("DAO_MCP_HEALTH_TIMEOUT_MS=1234 → 模块读到 1234", /TIMEOUT=1234/.test(String(r.stdout || "")), JSON.stringify(r.stdout) + " " + JSON.stringify(r.stderr));
  }
  {
    const r = spawnSync(process.execPath, ["-e",
      "import('./config-sync/lib/mcp-health.mjs').then(m => console.log('TIMEOUT=' + m.DEFAULT_TIMEOUT_MS))"],
      { cwd: REPO, encoding: "utf8", timeout: 20000 });
    check("无环境变量覆写 → 缺省 60000", /TIMEOUT=60000/.test(String(r.stdout || "")), JSON.stringify(r.stdout));
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ⑥ wiring（静态半：快速信号；行为级验证挪到 ⑦ 真机自跑）────");
  {
    const doctorSrc = fs.readFileSync(DOCTOR, "utf8");
    check("doctor.mjs 引入了 mcp-health.mjs", /from ['"]\.\/mcp-health\.mjs['"]/.test(doctorSrc), "");
    check("doctor.mjs 里有对应的 section() 标题", /MCP 健康态/.test(doctorSrc), "");
    // 🔴 2026-08-08 对抗复核 M8：旧断言 `/checkMcpHealth\(\)/.test(doctorSrc)` 连
    // `// checkMcpHealth();`（整行注释掉）都算匹配——把调用注释掉，这条断言照样 PASS。
    // ~~这里先做一个便宜的加固（排除整行是注释的形态）~~ **订正（2026-08-09，二轮对抗
    // 复核证伪：那个"加固"结构上永远红不了）**——`function checkMcpHealth() {` 这一行
    // 定义本身也匹配 `/checkMcpHealth\(\)/` 且不是注释，把调用那一行注释掉之后
    // `callLines` 里仍留着定义行、`liveCall` 恒为 `true`，这条断言判别力恒为 0，而
    // 断言名却写着"存在非注释形态的调用"——盘上文字撒了谎。现在把 `function` 定义行也
    // 从匹配里排除，让它对"调用行"单独判别：这仍然只是默认层的快速信号，真正堵住 M8
    // 的是 ⑦ 里那条真跑 doctor.mjs 断言输出的行为级检查——静态文本判断不了"调用是否真的
    // 执行了"，只有跑一遍才知道；但现在这条至少对它自己声称的那件事有判别力。
    const callLines = doctorSrc.split(/\r?\n/)
      .filter((l) => /checkMcpHealth\(\)/.test(l) && !/^\s*function\s/.test(l));
    const liveCall = callLines.some((l) => !/^\s*\/\//.test(l));
    check("doctor.mjs 里存在非注释、非 function 定义行形态的 checkMcpHealth() 调用" +
      "（快速信号，非最终判据——见⑦）",
      liveCall, JSON.stringify(callLines));
  }
  {
    // ── 全量注册面（issue #210 弱点①的修法，取代此前手点 2 个文件名的版本）──────────
    // 被扫的文件清单不是写在这里的字面量，是 `resolveRegisteredHookFiles()` 从
    // check-dead-gates.mjs 的结构化遍历里派生出来的——明天谁给任何一个事件多挂一个
    // command 型 hook，这条测试自动跟着扫到它，不需要有人记得回来改这个文件。
    const resolved = resolveRegisteredHookFiles();
    check("check-dead-gates.mjs 结构化遍历成功产出注册面（子进程未崩 · JSON 可解析 · exit=0，" +
      "三者任一失败都说明下面的「零命中」不可信，而不是「全部干净」）",
      resolved.ok && resolved.doc && resolved.doc.exit === 0,
      resolved.ok ? "exit=" + (resolved.doc && resolved.doc.exit) : resolved.why);
    // 下限不是上限：2026-08-09 实况是 18（17 个 hook 挂载点 + 1 个 statusLine）。这里
    // 留一点余量（15）——真正要防的是「扫描面塌陷成 0 或个位数」，不是钉死一个会随
    // 正常增减 hook 而过期的精确数字（`[#守-退役触发]` 同一个道理：阈值型断言用会
    // 过期的魔数不如用「显著低于」）。当前最新数自行核对：
    // `node ccswitch/scripts/check-dead-gates.mjs --json --no-providers`。
    check("注册面扫描没有塌陷（floor=15，当前实况 18）",
      resolved.ok && resolved.files.length >= 15,
      "实得 " + (resolved.files ? resolved.files.length : 0) + " 个：" + JSON.stringify(resolved.files || []));

    if (resolved.ok) {
      for (const abs of resolved.files) {
        let src = null, readErr = null;
        try { src = fs.readFileSync(abs, "utf8"); } catch (e) { readErr = e; }
        const rel = path.relative(REPO, abs).replace(/\\/g, "/");
        check(rel + "（已注册 command hook，静态文本快速信号）没有引用 mcp-health.mjs——" +
          "防的是未来有人图省事把 6-15s 的探测塞进同步 hook（issue #92 明写的成本约束）。" +
          "**已知弱处，本轮不修，见文件头注**：子串匹配可被字符串拼接绕过" +
          "（如 `require(['../../config-sync/lib/mcp-','health.mjs'].join(''))`，M10 实测 0 红）" +
          "——按 `ccswitch/rules/dao-guard-writing.md` 既有判据（文本匹配型护栏对改写字面的形态天然失明），" +
          "接受这个边界而非造更复杂的正则去堵，跟进单 issue #210",
          readErr ? false : !/mcp-health/i.test(src),
          readErr ? "读不到文件：" + readErr.message : "");
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ⑦ 真机自跑（合成夹具证不了它在真实 claude CLI 上跑得动；也是 M8 的行为级修法）────");
  if (!ENV_TIER) {
    deferSection("真机自跑（真实 claude mcp list + 真跑 doctor.mjs）", DEFER_WHY);
  } else {
    const mod2 = await import("../config-sync/lib/mcp-health.mjs");
    const real = mod2.probeMcpHealth({});
    check("真机探测拿到明确的 state（ok/timeout/unavailable/error 之一，不是 undefined）",
      ["ok", "timeout", "unavailable", "error"].includes(real.state), JSON.stringify({ state: real.state, why: real.why }));
    if (real.state === "ok") {
      check("真机探测至少解析出 1 个 server（本机若真的零输出，说明正则彻底失配，需要人来看）",
        real.servers.length > 0, real.raw.slice(0, 500));
      console.log("        实况：" + JSON.stringify(real.servers.map((s) => ({ name: s.name, category: s.category }))));
    } else {
      console.log("        本机这次探测没拿到 state='ok'（" + real.why + "），如实记录，不强求。");
    }

    // ── 行为级 wiring 验证：真跑 doctor.mjs，断言 MCP 健康态那一节真的印出了内容 ──
    // 这是 M8（把 checkMcpHealth() 调用注释掉）的真正判据：注释掉之后 section() 标题
    // 还在（那是独立的一行调用），但下面不会再有任何 ✓/✗/! 开头的判据行——文本匹配型
    // 断言看不出这个区别，只有真跑一遍、看输出内容才看得出。
    const dr = spawnSync(process.execPath, [DOCTOR], { encoding: "utf8", cwd: REPO, timeout: 90000 });
    const dout = String(dr.stdout || "");
    const secIdx = dout.indexOf("[MCP 健康态");
    check("doctor.mjs 真跑：输出里有 MCP 健康态那个 section 标题", secIdx >= 0, dout.slice(0, 200));
    if (secIdx >= 0) {
      const rest = dout.slice(secIdx);
      const nextSecIdx = rest.indexOf("\n[", 1);
      const body = nextSecIdx >= 0 ? rest.slice(0, nextSecIdx) : rest;
      const judgmentLines = body.split(/\r?\n/).filter((l) => /^\s{2}[✓✗!]\s/.test(l));
      check("doctor.mjs 真跑：section 标题下面真的印出了至少一条判据行（✓/✗/! 开头）——" +
        "这条断言堵住 M8：若 checkMcpHealth() 被注释掉，body 会是空的",
        judgmentLines.length > 0, JSON.stringify(body.slice(0, 500)));
      // 若本机 claude CLI 装着且能连上任何 server，进一步核对 opendesign/fetch 这类
      // "issue 点名的死连接" 有没有被静默漏掉——这是 F1（期望集并集）修复的真机确认。
      const hasKnownDeadName = /opendesign|fetch/.test(body);
      console.log("        真机 body 里出现 opendesign/fetch 字样：" + hasKnownDeadName +
        "（如实记录，不同机器/不同时刻这两个 server 的健康态可能变化，不强断言）");

      // ── F1 生产接线行为级验证（2026-08-09 二轮对抗复核，PR #207 评论
      // #issuecomment-5227085300：M-F1-wire-bypass / M-F1-wire-suffix 两组 mutation 各 0 红）──
      // 上面那条只问"body 里有没有判据行"，`universe` 被静默换回纯 `dbExpected`（绕过
      // computeMcpUniverse）时那条依然为真——DB 外、探测实见的 server（本机现成有
      // opendesign/penpot）会从 body 里整条消失，那条断言看不出区别。这里用同一次真机
      // 探测独立求出的 `real.servers`（探测层，不经过 doctor.mjs 内部任何计算）与
      // doctor.mjs 子进程真跑出的 `body`（应用层）交叉核对两件事：
      //   ① 名字集合：real 探测到的每一个名字都必须出现在 body 里——挡 bypass（DB 外的
      //      名字被换回纯 dbExpected 时会整条消失，这条立刻抓到，本机对应
      //      M-F1-wire-bypass：0 红 → 现在应变红）；
      //   ② 标注文案：real 里有、cc-switch DB 里没有的那些名字（本机现成有
      //      opendesign/penpot），它们在 body 里那一行必须带着"不在 cc-switch DB 的
      //      enabled_claude 名单里"这句标注——挡 suffix-strip（universe 算对了但报文
      //      拼接时把标注文字删掉，名字还在、①测不出来，本机对应 M-F1-wire-suffix：
      //      0 红 → 现在应变红）。
      if (real.state === "ok" && real.servers.length > 0) {
        const realNames = real.servers.map((s) => s.name);
        const missingNames = realNames.filter((n) => !body.includes(n));
        check("doctor.mjs 真跑：body 覆盖了独立探测到的全部 server 名字（堵 F1 生产接线 bypass——" +
          "universe 若被换回纯 DB 期望集，DB 外的名字会整条从 body 里消失）",
          missingNames.length === 0, JSON.stringify({ missingNames, realNames }));

        let dbExpected = [];
        try {
          const dbMod = await import("../config-sync/lib/sqlite.mjs");
          dbExpected = dbMod.selectRows("mcp_servers", "WHERE enabled_claude = 1 ORDER BY name").map((r) => r.name);
        } catch (e) {
          console.log("        DB 查询失败（" + (e && e.message) + "），跳过标注文案那一半断言，如实记录。");
        }
        const dbSet = new Set(dbExpected);
        const extraNames = realNames.filter((n) => !dbSet.has(n));
        if (extraNames.length > 0) {
          const ANNOTATION = "不在 cc-switch DB 的 enabled_claude 名单里";
          const missingAnnotation = extraNames.filter((n) => {
            const lineStart = body.indexOf(n + "：");
            if (lineStart < 0) return true; // 名字都不在，上一条断言已经抓到，这里同样算漏
            const lineEnd = body.indexOf("\n", lineStart);
            const line = lineEnd >= 0 ? body.slice(lineStart, lineEnd) : body.slice(lineStart);
            return !line.includes(ANNOTATION);
          });
          check("doctor.mjs 真跑：DB 外、探测实见的 server（本机：" + extraNames.join(",") +
            "）那一行带着「不在 DB 名单里」标注——堵 F1 生产接线 suffix-strip（标注文字被删掉时" +
            "名字还在、①单独测不出来，这条单独抓到）",
            missingAnnotation.length === 0, JSON.stringify({ missingAnnotation, extraNames }));
        } else {
          console.log("        本机此刻 DB 与探测实见完全重合，没有『DB 外』样本，② 这一半断言本次零覆盖" +
            "（如实记录，不强断言——同 dao-officer-clauses.md「没样本」与「跑了全过」需分开的读法）。");
        }
      }
    }
  }
}

main().then(() => {
  console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " DEFER=" + defer + " ===");
  if (defer) {
    console.log("⚠ 本次未跑 " + defer + " 组真机自跑（默认层）—— 「没跑」不等于「跑了全过」。");
    console.log("  跑完整层：node tests/mcp-health.tests.js --env");
  }
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  fail++;
  console.log("  FAIL  测试文件自身抛异常  ->  " + (e && e.stack ? e.stack : e));
  console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " DEFER=" + defer + " ===");
  process.exit(1);
});
