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
// 已注册的 MCP server 连不上时无人发现；issue 关闭条件明写「判不出」不许被静默当
// 「可连」（正控：人为造一个坏配置 → 报红；负控：全好 → 绿）。本文件钉住三层：
//   ① parseMcpListOutput —— 对已实测的真实输出形态（✔/✘/! 三个符号本机直接观测，
//      ⏸ 按 `claude mcp --help` 文档字面收）解析正确，且贪婪回溯不会被 detail 字段
//      内部偶然出现的 " - " 切错行；
//   ② probeMcpHealth —— I/O 边界那层，三种失败态（超时/找不到命令/其它异常）分类
//      正确，且**从不**把失败悄悄读成 state='ok'；
//   ③ evaluateMcpHealth —— 判据核心，本文件最重要的一节：正控/负控各一，degraded/
//      pending 两个中间态不落 pass 也不落 fail，探测**整体失败**时每一个期望 server
//      各自出一条「判不出」而不是被折进 pass——这条断言直接对应 issue 的关闭条件，
//      即便当下所有真实 server 都健康，探测器自己挂了也绝不能报绿。
// 另有两条结构性 wiring 检查（不整体跑 doctor.mjs——它 import 即执行 main()，会碰
// 真实 cc-switch DB / settings.json，不适合单测环境）：
//   · doctor.mjs 源码里确实调用了 checkMcpHealth()（防「函数写了但没人调」，
//     即「指向空气的指针」——机检半用文本断言，够用，不需要真的跑一遍它）；
//   · dao-scaffold-check.js 源码里**没有**引用本模块（防未来有人图省事把 6-15s 的
//     探测塞进 10s 预算的 SessionStart 热路径，违反本 issue 明写的成本约束——这是
//     给这条架构决策自己造的回归触发器）。

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
  const { parseMcpListOutput, probeMcpHealth, evaluateMcpHealth, DEFAULT_TIMEOUT_MS } = mod;

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ① parseMcpListOutput：真实形态混合夹具 ────");
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
      "weird: something - ? mystery status",
      "trickyserver: cmd --flag-a - flag-b - ✔ Connected",
      "",
    ].join("\r\n");   // CRLF 混合，顺带验证 \r?\n 分行不受影响
    const servers = parseMcpListOutput(FIXTURE);
    check("banner/空行不产出条目，共解析出 9 条", servers.length === 9, JSON.stringify(servers.map((s) => s.name)));
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
    check("penpot 判 degraded（! 符号）", byName.penpot && byName.penpot.category === "degraded", JSON.stringify(byName.penpot));
    check("penpot 状态文本带出原因", byName.penpot && /tools fetch failed/.test(byName.penpot.statusText), JSON.stringify(byName.penpot));
    check("chrome-devtools 判 ok（✔ 符号）", byName["chrome-devtools"] && byName["chrome-devtools"].category === "ok");
    check("opendesign / fetch 判 dead（✘ 符号）",
      byName.opendesign && byName.opendesign.category === "dead" && byName.fetch && byName.fetch.category === "dead");
    check("pendingsrv 判 pending（⏸ 符号，来自文档字面）", byName.pendingsrv && byName.pendingsrv.category === "pending");
    check("weird 判 unknown（? 不是已知符号，不许折进 ok）", byName.weird && byName.weird.category === "unknown", JSON.stringify(byName.weird));
    check("trickyserver：detail 内部的独立 ' - ' 不切错行（贪婪回溯钉在最后一个符号前）",
      byName.trickyserver && byName.trickyserver.detail === "cmd --flag-a - flag-b" && byName.trickyserver.category === "ok",
      JSON.stringify(byName.trickyserver));
  }
  {
    check("空字符串 → 空数组", parseMcpListOutput("").length === 0);
    check("null/undefined 不抛异常，按空串处理", parseMcpListOutput(null).length === 0 && parseMcpListOutput(undefined).length === 0);
    check("纯 banner+空行 → 空数组", parseMcpListOutput("Checking MCP server health…\n\n").length === 0);
    check("没有冒号的行 → 不产出条目（不是合法形态）", parseMcpListOutput("this is not a valid line at all").length === 0);
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ② probeMcpHealth：I/O 边界的三种失败态分类 ────");
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
    check("execFn 抛 code=ENOENT（命令找不到）→ state='unavailable'", r.state === "unavailable", JSON.stringify(r));
  }
  {
    const r = probeMcpHealth({ execFn: () => { throw new Error("something else broke"); } });
    check("execFn 抛其它异常 → state='error'（不是 timeout/unavailable）", r.state === "error", JSON.stringify(r));
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
  console.log("\n──── ③ evaluateMcpHealth：判据核心（正控/负控 + 三态）────");
  {
    // 负控：全好 → 全绿，零 warn 零 fail（issue 关闭条件原句）
    const probe = { state: "ok", servers: [
      { name: "a", category: "ok", statusText: "Connected" },
      { name: "b", category: "ok", statusText: "Connected" },
    ] };
    const { lines, summary } = evaluateMcpHealth(["a", "b"], probe);
    check("负控：全好 → 全部 pass，summary.warn=0 summary.fail=0", summary.pass === 2 && summary.warn === 0 && summary.fail === 0, JSON.stringify(summary));
  }
  {
    // 正控：人为造一个坏配置 → 报红（issue 关闭条件原句）
    const probe = { state: "ok", servers: [
      { name: "a", category: "ok", statusText: "Connected" },
      { name: "b", category: "dead", statusText: "Failed to connect — Connection closed" },
    ] };
    const { lines, summary } = evaluateMcpHealth(["a", "b"], probe);
    const bLine = lines.find((l) => l.message.startsWith("b："));
    check("正控：坏配置 → b 那条 level='fail'", bLine && bLine.level === "fail", JSON.stringify(lines));
    check("正控：报文指名到具体 server 与原因（只报个数字等于没报）",
      bLine && /连不上/.test(bLine.message) && /Connection closed/.test(bLine.message), JSON.stringify(bLine));
    check("正控：活的那条不被牵连（a 仍是 pass）", lines.find((l) => l.message.startsWith("a：")).level === "pass", JSON.stringify(lines));
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
    // 未知符号 → 判不出，不许折进 ok
    const probe = { state: "ok", servers: [{ name: "z", category: "unknown", statusText: "?", raw: "z: x - ? y" }] };
    const { lines } = evaluateMcpHealth(["z"], probe);
    check("unknown 符号 → level='warn'（判不出，不是 pass）", lines[0].level === "warn", JSON.stringify(lines));
  }
  {
    // ⭐ 核心断言：期望的 server 根本没出现在输出里 → 判不出，绝不静默当健康
    const probe = { state: "ok", servers: [{ name: "a", category: "ok", statusText: "Connected" }] };
    const { lines, summary } = evaluateMcpHealth(["a", "missing-one"], probe);
    const mLine = lines.find((l) => l.message.startsWith("missing-one："));
    check("探测输出里找不到的 server → level='warn'（不是静默通过，也不是 pass）", mLine && mLine.level === "warn", JSON.stringify(lines));
    check("报文明说「判不出」且「不等于健康」", mLine && /判不出/.test(mLine.message) && /不等于健康/.test(mLine.message), JSON.stringify(mLine));
    check("summary.pass 只计 1（a），missing-one 没被悄悄算进 pass", summary.pass === 1, JSON.stringify(summary));
  }
  {
    // ⭐⭐ 全场最重要的一组：探测整体失败时，即便"真实情况"全是好的，也绝不能报 pass。
    // 这直接对应 issue 关闭条件——「不把开工卡住 30 秒」的另一面是「判不出时不能装作没事」。
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
        names.every((n) => lines.some((l) => l.message.startsWith(n + "：") && /判不出/.test(l.message))),
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

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ④ 环境变量覆写超时（需另起进程，模块级常量只在 import 时读一次）────");
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
  console.log("\n──── ⑤ wiring：新检查真被 doctor.mjs 调用，且没被塞进 SessionStart 热路径 ────");
  {
    const doctorSrc = fs.readFileSync(DOCTOR, "utf8");
    check("doctor.mjs 引入了 mcp-health.mjs", /from ['"]\.\/mcp-health\.mjs['"]/.test(doctorSrc), "");
    check("doctor.mjs 的 main() 里真的调用了 checkMcpHealth()（不是写了没人调）",
      /checkMcpHealth\(\)/.test(doctorSrc), "");
    check("doctor.mjs 里有对应的 section() 标题", /MCP 健康态/.test(doctorSrc), "");
  }
  {
    const scaffoldSrc = fs.readFileSync(SCAFFOLD_HOOK, "utf8");
    check("dao-scaffold-check.js（SessionStart 热路径，10s 预算）没有引用本模块——" +
      "这条防的是未来有人图省事把 6-15s 的探测塞进同步热路径，违反 issue #92 明写的成本约束",
      !/mcp-health/i.test(scaffoldSrc), "");
  }

  // ══════════════════════════════════════════════════════════════
  console.log("\n──── ⑥ 真机自跑（合成夹具证不了它在真实 claude CLI 上跑得动）────");
  if (!ENV_TIER) {
    deferSection("真机自跑（真实 claude mcp list）", DEFER_WHY);
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
