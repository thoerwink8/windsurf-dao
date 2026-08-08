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
//   · dao-scaffold-check.js（SessionStart 热路径）没有引用本模块——**已知弱处，本轮
//     只标注不修**（覆盖面只有 15 个 hook 注册里的 1 个；且可被字符串拼接绕过，
//     对抗复核 M10 实测坐实），跟进单见 issue #210，理由见该断言旁边的注释。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const DOCTOR = path.join(REPO, "config-sync", "lib", "doctor.mjs");
const SCAFFOLD_HOOK = path.join(REPO, "ccswitch", "hooks", "dao-scaffold-check.js");

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
    // 这里先做一个便宜的加固（排除整行是注释的形态），**但它不是本轮真正的修法**——
    // 真正堵住 M8 的是 ⑦ 里那条真跑 doctor.mjs 断言输出的行为级检查：静态文本判断不了
    // "调用是否真的执行了"，只有跑一遍才知道。这一条留着当默认层的快速信号，行为级
    // 验证不必每次都等 6-15s 的真机探测。
    const callLines = doctorSrc.split(/\r?\n/).filter((l) => /checkMcpHealth\(\)/.test(l));
    const liveCall = callLines.some((l) => !/^\s*\/\//.test(l));
    check("doctor.mjs 里存在非注释形态的 checkMcpHealth() 调用（快速信号，非最终判据——见⑦）",
      liveCall, JSON.stringify(callLines));
  }
  {
    const scaffoldSrc = fs.readFileSync(SCAFFOLD_HOOK, "utf8");
    // 🔴 **已知弱处，本轮只标注不修**（PR #207 对抗复核 M9/M10，跟进单 issue #210）：
    // ①这条断言只护住 dao-scaffold-check.js 一个文件，本机 hook 注册面实测有 15 个
    // （8 类事件），其中 dao-config-guard.js（SessionStart，预算 5s，比 scaffold-check
    // 还紧）完全不在覆盖范围内；②即使在 scaffold-check.js 内部，子串匹配也能被字符串
    // 拼接绕过（如 `require(['../../config-sync/lib/mcp-', 'health.mjs'].join(''))`
    // 源码里不出现 `mcp-health` 字面，M10 实测 0 红）。两条都是防御性护栏的覆盖面缺口，
    // 不是已发生的事故——按 `[#帅-撤宣称不抢修]` 不在合并压力下抢修，跟进单见 issue #210。
    check("dao-scaffold-check.js（SessionStart 热路径，10s 预算）没有引用本模块——" +
      "这条防的是未来有人图省事把 6-15s 的探测塞进同步热路径（issue #92 明写的成本约束）；" +
      "覆盖面与绕过面的已知缺口见本行上方注释与 issue #210，本轮不修",
      !/mcp-health/i.test(scaffoldSrc), "");
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
