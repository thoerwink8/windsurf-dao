// 派活底座闸的自测 —— 守的对象：ccswitch/hooks/dao-dispatch-gate.js
//
// 闸是静默失效型部件：它挂了的样子和它放行的样子一模一样（都是 exit 0）。所以除了正负控，
// 末尾一组 mutation 逐条把闸的关键判据改坏，钉住「它明天变坏时真的会红」。
//
// 契约：hook 从 fd 0 读 JSON payload；拦下 = exit 2，放行 = exit 0；降级放行会往留痕文件 append 一行 JSON。
// 落点全部靠 DAO_ROSTER_CACHE / DAO_DEGRADE_LOG 指到临时目录，**不碰真 HOME**。
//
// 🔴 本文件里没有任何一条依赖「本闸已在 live settings.json 注册」——注册是用户动作
//    （写 cc-switch DB，AI 侧被权限分类器拦死），依赖它必红。见 issue #409 契约第六节。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import gate from "../ccswitch/hooks/dao-dispatch-gate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-dispatch-gate.js");
const ROSTER_SRC = path.join(REPO, "scripts", "dao-roster.mjs");
const AGENTS_DIR = path.join(REPO, "ccswitch", "agents");
const DISPATCH_RULES = path.join(REPO, "ccswitch", "rules", "dao-dispatch.md");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dao-dispatch-gate-"));
const CACHE = path.join(TMP, "roster.json");
const LOG = path.join(TMP, "degrade.jsonl");

/** 跑一次 hook。返回 {status, stderr}。2 = 拦下，0 = 放行。 */
function run(payload, extraEnv, hookPath) {
  const r = spawnSync(process.execPath, [hookPath || HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, DAO_ROSTER_CACHE: CACHE, DAO_DEGRADE_LOG: LOG, ...(extraEnv || {}) },
  });
  return { status: r.status, stderr: r.stderr || "", stdout: r.stdout || "" };
}

/** 造一份 roster 缓存。ageMs=0 即新鲜；available: true/false/"unknown"。 */
function writeCache({ available, ageMs = 0, reason = null, broken = null }) {
  if (broken !== null) { fs.writeFileSync(CACHE, broken, "utf8"); return null; }
  const at = new Date(Date.now() - ageMs).toISOString();
  const roster = {
    at,
    fabric: { orca: reason === null ? { available } : { available, reason } },
    agents: {},
    summary: "fabric=orca?",
  };
  fs.writeFileSync(CACHE, JSON.stringify(roster), "utf8");
  return at;
}
function clearCache() { fs.rmSync(CACHE, { force: true }); }
function clearLog() { fs.rmSync(LOG, { force: true }); }
function logLines() {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, "utf8").split(/\r?\n/).filter((l) => l.trim());
}

// 派活入参三种形态。字段名以宿主真实入参为准：`subagent_type` / `isolation` 在盘上的会话档里
// 的 Agent tool_use input 就是这两个名字（见交活单「自答一格」的取证）。
const agentCall = (extra) => ({ tool_name: "Agent", cwd: REPO, tool_input: { description: "x", prompt: "y", ...extra } });
const implementer = () => agentCall({ subagent_type: "dao-implementer" });
const scoutOnly = () => agentCall({ subagent_type: "dao-scout" });
const scoutInWorktree = () => agentCall({ subagent_type: "dao-scout", isolation: "worktree" });
const genericBase = () => agentCall({ subagent_type: "claude" });
const notAgentTool = () => ({ tool_name: "Bash", cwd: REPO, tool_input: { command: "git status" } });
// R1（W3 换家审 · 树帅 2026-08-13 裁定）：一个类型字段都不填 = 宿主按缺省全权底座起，
// 与显式 general-purpose 同一物。少填一个字段就绕过全权底座那道裁决 ⇒ 视同写盘特征。
const noTypeAgent = () => ({ tool_name: "Agent", cwd: REPO, tool_input: { description: "d", prompt: "p" } });
const noTypeTask = () => ({ tool_name: "Task", cwd: REPO, tool_input: { description: "d", prompt: "p" } });
const onlyModel = () => ({ tool_name: "Agent", cwd: REPO, tool_input: { description: "d", prompt: "p", model: "opus" } });

console.log("\n=== 正控 · Orca 活着 + 会写盘的工兵 ⇒ 必须拦 ===");
clearLog();
const freshAt = writeCache({ available: true });
const posA = run(implementer());
check("正控 A 写权官种（dao-implementer）⇒ exit 2", posA.status === 2, `status=${posA.status}`);
check("拦截消息 ①为什么拦（人话）", /为什么拦：/.test(posA.stderr) && /Orca 此刻是活的/.test(posA.stderr));
check("拦截消息 ②走 Orca 的最短命令", /orca orchestration worker-start/.test(posA.stderr));
check("拦截消息 ③确认 Orca 真死了的刷新命令", /dao-roster\.mjs/.test(posA.stderr));
check("被拦时不写降级留痕", logLines().length === 0, JSON.stringify(logLines()));

const posB = run(scoutInWorktree());
check("正控 B isolation=worktree（哪怕官种只读）⇒ exit 2", posB.status === 2, `status=${posB.status}`);
const posC = run(genericBase());
check("正控 C 全权底座（claude）⇒ exit 2", posC.status === 2, `status=${posC.status}`);

// ── R1 · 无类型字段那一整类（W3 换家审实测的漏拦面，树帅裁「视同全权底座」）──────────
const posD = run(noTypeAgent());
check("正控 D 无任何类型字段的 Agent ⇒ exit 2（隐式全权 = 显式全权）", posD.status === 2, `status=${posD.status}`);
check("正控 D 不留痕（被拦不是降级）", logLines().length === 0, JSON.stringify(logLines()));
check("正控 E 无类型字段的 Task ⇒ exit 2", run(noTypeTask()).status === 2);
check("正控 F 只带 model、无类型字段 ⇒ exit 2", run(onlyModel()).status === 2);
// 拦截消息第三段：换法必须是**显式声明只读官种**，而不是「少填字段」。
check("拦截消息 ③ 要求显式指定只读官种", /显式指定一个只读官种/.test(posD.stderr));
check("拦截消息 ③ 点名的只读官种一个不少",
  gate.READONLY_HINT_TYPES.every((t) => posD.stderr.includes(t)),
  gate.READONLY_HINT_TYPES.filter((t) => !posD.stderr.includes(t)).join(","));
check("拦截消息 ③ 明说「不填类型字段不等于只读」", /不填类型字段不等于只读/.test(posD.stderr));

console.log("\n=== 负控 · 这三格必须放行（拦住一切的闸会被当场关掉）===");
clearLog();
const deadAt = writeCache({ available: false, reason: "locator:miss" });
const negDead = run(implementer());
check("负控 1 Orca 死（available=false）⇒ exit 0", negDead.status === 0, `status=${negDead.status}`);
// 🔴 断言的是「留痕真的落了盘」的那一行 JSON 的字段，不是只断言 exit 0——
//    降级放行与「闸压根没跑」在退出码上逐字节相同，留痕是唯一的区分。
const rec = logLines().length === 1 ? JSON.parse(logLines()[0]) : null;
check("负控 1 留痕落盘且恰好一行", rec !== null, `lines=${logLines().length}`);
if (rec) {
  check("留痕字段 at 是可解析时间", typeof rec.at === "string" && Number.isFinite(Date.parse(rec.at)), rec.at);
  check("留痕字段 cwd", rec.cwd === REPO, rec.cwd);
  check("留痕字段 tool", rec.tool === "Agent", rec.tool);
  check("留痕字段 agentType", rec.agentType === "dao-implementer", String(rec.agentType));
  check("留痕字段 isolation（未传即 null）", rec.isolation === null, String(rec.isolation));
  check("留痕字段 orcaAvailable", rec.orcaAvailable === false, String(rec.orcaAvailable));
  check("留痕字段 orcaReason", rec.orcaReason === "locator:miss", String(rec.orcaReason));
  check("留痕字段 rosterAt 指回那次探测", rec.rosterAt === deadAt, `${rec.rosterAt} vs ${deadAt}`);
}

clearLog();
writeCache({ available: "unknown", reason: "threw:ETIMEDOUT" });
const negUnknown = run(implementer());
const recU = logLines().length === 1 ? JSON.parse(logLines()[0]) : null;
check('负控 1b 判不出死活（available="unknown"）⇒ 放行（取 !== true，不是 === false）',
  negUnknown.status === 0 && recU && recU.orcaAvailable === "unknown",
  `status=${negUnknown.status} rec=${JSON.stringify(recU)}`);

// R1 的另一半：无类型字段这一整类进了拦截面，就必须一起进降级面——
// 否则 Orca 真死时它变成「既不拦也不留痕」的黑洞。
clearLog();
writeCache({ available: false, reason: "locator:miss" });
const negNoType = run(noTypeAgent());
const recN = logLines().length === 1 ? JSON.parse(logLines()[0]) : null;
check("负控 1c 无类型字段 + Orca 死 ⇒ 降级放行且留痕（agentType 记 null）",
  negNoType.status === 0 && recN && recN.agentType === null && recN.tool === "Agent",
  `status=${negNoType.status} rec=${JSON.stringify(recN)}`);

clearLog();
writeCache({ available: true });
const negScout = run(scoutOnly());
check("负控 2 只读侦察（dao-scout，无 isolation）⇒ exit 0", negScout.status === 0, `status=${negScout.status}`);
check("负控 2 放行不留痕（留痕只为降级而写）", logLines().length === 0, JSON.stringify(logLines()));

const negBash = run(notAgentTool());
check("负控 3 非 Agent 类工具（Bash）⇒ exit 0", negBash.status === 0, `status=${negBash.status}`);

console.log("\n=== 缓存三格 · 缺失 / 解析坏 / 过期 ⇒ 拦，且消息给刷新命令 ===");
clearLog();
clearCache();
const missing = run(implementer());
check("缓存缺失 ⇒ exit 2", missing.status === 2, `status=${missing.status}`);
check("缓存缺失 · 消息带刷新命令", /dao-roster\.mjs/.test(missing.stderr));

writeCache({ broken: '{"at":"2026-08-13T00:00:00.000Z","fabric":{"orca":{"avai' });
const broken = run(implementer());
check("缓存半截 JSON ⇒ exit 2", broken.status === 2, `status=${broken.status}`);
check("缓存半截 JSON · 消息带刷新命令", /dao-roster\.mjs/.test(broken.stderr));

writeCache({ available: true, ageMs: 3 * 60 * 60 * 1000 });
const stale = run(implementer());
check("缓存过期（3 小时 > 2 小时 TTL）⇒ exit 2", stale.status === 2, `status=${stale.status}`);
check("缓存过期 · 消息带刷新命令", /dao-roster\.mjs/.test(stale.stderr));

// 过期胜过「Orca 死」：过期缓存说什么都不算数，否则一份陈年的「orca 死」会永久打开降级通道。
writeCache({ available: false, ageMs: 3 * 60 * 60 * 1000 });
const staleDead = run(implementer());
check("过期 + 缓存说 Orca 死 ⇒ 仍然拦（陈年缓存不得永久开降级通道）", staleDead.status === 2, `status=${staleDead.status}`);
check("过期 · 不落降级留痕", logLines().length === 0, JSON.stringify(logLines()));

// `at` 是垃圾 ⇒ 归解析坏那一格（判不出新鲜度 = 判不出，一律拦）。
writeCache({ broken: '{"at":"not-a-time","fabric":{"orca":{"available":true}}}' });
check("缓存 at 不可解析 ⇒ exit 2", run(implementer()).status === 2);

// ── R3 · 缺失/过期那两格不许指示一个多半是冗余的动作 ────────────────────────────
// W3 实测：开窗后 SessionStart 的后台探测要几十秒，期间缓存缺/旧 ⇒ 全拦；那一刻让人再手动跑
// 同一条刷新命令，是让他为一个已经在发生的事再等一轮。
for (const [label, prep] of [
  ["缓存缺失", () => clearCache()],
  ["缓存过期", () => writeCache({ available: true, ageMs: 3 * 60 * 60 * 1000 })],
]) {
  prep();
  const s = run(implementer()).stderr;
  check(`R3 ${label} · 消息先说「不用你动手 / 等一会儿重试」`, /不用你动手/.test(s) && /等一会儿直接重试/.test(s), s.slice(0, 200));
  check(`R3 ${label} · 手动刷新降格为兜底（带「等不及」限定，不是命令式）`, /等不及[^\n]*兜底|才用这条兜底/.test(s));
  check(`R3 ${label} · 兜底命令本身仍在（没把出路删掉）`, /dao-roster\.mjs/.test(s));
}
// 对照组：缓存新鲜、Orca 活着那一格没有「后台已在途」这一说，照旧给命令式刷新指引。
// 没有这一条，上面三条在「全篇统一改成等一等」时也会绿 ⇒ 分支没分也测不出来。
writeCache({ available: true });
const aliveMsg = run(implementer()).stderr;
check("R3 对照组 · Orca 活那一格仍是命令式重探（证明分支真的分了）",
  /Orca 真的死了？重探一次/.test(aliveMsg) && !/不用你动手/.test(aliveMsg));

console.log("\n=== fail-open · 闸自己出事时必须放行 + 留告警 ===");
const badStdin = spawnSync(process.execPath, [HOOK], {
  input: "{ 这不是 JSON",
  encoding: "utf8",
  env: { ...process.env, DAO_ROSTER_CACHE: CACHE, DAO_DEGRADE_LOG: LOG },
});
check("stdin 不是 JSON ⇒ 放行（exit 0）", badStdin.status === 0, `status=${badStdin.status}`);

console.log("\n=== 路径一致闸 · 两边独立算出来的缓存路径必须逐字相等 ===");
// 写了指针（闸的头注说真相源在 scripts/dao-roster.mjs）就必须配一道会红的闸——就是这一条。
let w1 = null, w1Err = null;
try { w1 = await import("../scripts/dao-roster.mjs"); } catch (e) { w1Err = e; }
if (!w1) {
  check("导入 scripts/dao-roster.mjs", false, String(w1Err && w1Err.message));
} else {
  const isFn = typeof w1.rosterCachePath === "function";
  const isConst = typeof w1.ROSTER_CACHE_PATH === "string";
  check("scripts/dao-roster.mjs 具名导出缓存路径（rosterCachePath() 或 ROSTER_CACHE_PATH）", isFn || isConst,
    "两个名字都没有 ⇒ 契约第二节那条冻结被单方面改了");
  if (isFn || isConst) {
    const w1Path = () => (isFn ? w1.rosterCachePath() : w1.ROSTER_CACHE_PATH);
    const saved = process.env.DAO_ROSTER_CACHE;
    delete process.env.DAO_ROSTER_CACHE;
    check("默认态：闸算的缓存路径 === roster 那边算的", gate.rosterCachePath() === w1Path(),
      `${gate.rosterCachePath()} vs ${w1Path()}`);
    if (isFn) {
      process.env.DAO_ROSTER_CACHE = path.join(TMP, "env-override.json");
      check("env 覆盖态：两边一起跟着 DAO_ROSTER_CACHE 走", gate.rosterCachePath() === w1Path(),
        `${gate.rosterCachePath()} vs ${w1Path()}`);
    } else {
      console.log("  NOTE  对方是常量形态（加载期求值），env 覆盖态无从比对，只比默认态");
    }
    if (saved === undefined) delete process.env.DAO_ROSTER_CACHE; else process.env.DAO_ROSTER_CACHE = saved;
  }
}
// 留痕落点没有对家可比，只能和契约第二节的字面形态对：独立再算一次，不复用闸的函数体。
{
  const saved = process.env.DAO_DEGRADE_LOG;
  delete process.env.DAO_DEGRADE_LOG;
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  check("降级留痕默认落点 = <HOME>/.claude/dao-degrade-log.jsonl",
    gate.degradeLogPath() === path.join(home, ".claude", "dao-degrade-log.jsonl"), gate.degradeLogPath());
  if (saved === undefined) delete process.env.DAO_DEGRADE_LOG; else process.env.DAO_DEGRADE_LOG = saved;
}
check("TTL 默认 2 小时（契约冻结值）", gate.ttlMs() === 2 * 60 * 60 * 1000, String(gate.ttlMs()));

console.log("\n=== 指针闸 · 拦截消息里指出去的东西必须真的在 ===");
check("刷新命令指向的 scripts/dao-roster.mjs 存在", fs.existsSync(ROSTER_SRC));
check("消息引用的 ccswitch/rules/dao-dispatch.md 存在", fs.existsSync(DISPATCH_RULES));
// 退役触发器（闸头注第 6 条）：本闸的全部输入来自 roster 的 orca 探测面。那一面没了，
// 本闸恒降级放行 = 空壳，此条会红并把「是不是该删掉它了」摆到眼前。
const rosterSrc = fs.readFileSync(ROSTER_SRC, "utf8");
check("退役触发器：roster 仍在探测 fabric.orca（没了就该问本闸是否也该退役）",
  /fabric\s*:\s*\{[^}]*orca/.test(rosterSrc));

console.log("\n=== 清单派生闸 · 写权官种表不许手写脱节 ===");
// 独立解析 ccswitch/agents/*.md 的 frontmatter（与闸零共享代码），凡声明了 Write/Edit 的官种
// 都必须在 WRITER_AGENT_TYPES 里；反过来表里的每个 dao-* 也必须在目录里且确实带写权。
function frontmatterTools(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  if (lines[0].trim() !== "---") return { name: null, tools: null };
  let name = null, tools = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") break;
    const m = lines[i].match(/^(name|tools):\s*(.*)$/);
    if (!m) continue;
    if (m[1] === "name") name = m[2].trim();
    else tools = m[2].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return { name: name || path.basename(file, ".md"), tools };
}
const declared = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"))
  .map((f) => frontmatterTools(path.join(AGENTS_DIR, f)));
check("agents 目录读到了样本（数到 0 和没看到样本输出一模一样）", declared.length > 0, `n=${declared.length}`);
// tools 缺省 = 继承全部工具 = 会写盘。
const expectedWriters = declared
  .filter((a) => a.tools === null || a.tools.some((t) => t === "Write" || t === "Edit" || t === "*"))
  .map((a) => a.name).sort();
const inGate = [...gate.WRITER_AGENT_TYPES].sort();
check("写权官种表 = agents 目录实况（双向逐字相等）", JSON.stringify(expectedWriters) === JSON.stringify(inGate),
  `目录=${JSON.stringify(expectedWriters)} 闸=${JSON.stringify(inGate)}`);
check("写权官种表与全权底座表不重叠",
  gate.WRITER_AGENT_TYPES.every((t) => !gate.FULL_ACCESS_AGENT_TYPES.includes(t)));
// 反例组：目录里声明只读的官种，一个都不许出现在拦截表里（只读侦察必须走得通）。
const readOnly = declared.filter((a) => a.tools && !a.tools.some((t) => t === "Write" || t === "Edit" || t === "*"))
  .map((a) => a.name);
check("只读官种一个都没被收进拦截表", readOnly.length > 0 && readOnly.every((n) => !inGate.includes(n)),
  `只读官种=${JSON.stringify(readOnly)}`);
// 拦截消息第三段把这几个名字当出路推给人看。哪天谁给它们开了写权、或改了名，这条会红——
// 一条指向空气的建议比没有建议更糟：照做的人会以为自己走了合法路径。
check("消息推荐的只读官种 · 每个都在 agents 目录里且确实没有写权",
  gate.READONLY_HINT_TYPES.length > 0 && gate.READONLY_HINT_TYPES.every((t) => readOnly.includes(t)),
  `推荐=${JSON.stringify(gate.READONLY_HINT_TYPES)} 目录里的只读官种=${JSON.stringify(readOnly)}`);

console.log("\n=== --selfcheck · 不许依赖注册，也不许复用主逻辑 ===");
// 🔴 注册是用户动作（写 cc-switch DB），本机此刻大概率未注册 ⇒ 只断言「它敢回答」，不断言答案。
const sc = spawnSync(process.execPath, [HOOK, "--selfcheck"], { encoding: "utf8", env: { ...process.env } });
check("--selfcheck 退出码 ∈ {0,1}（0=已注册且覆盖全，1=未注册或失覆盖）",
  sc.status === 0 || sc.status === 1, `status=${sc.status}`);
check("--selfcheck 摆出注册结论", /PreToolUse|未注册/.test(sc.stdout || ""));
check("--selfcheck 摆出本闸声明要拦的工具名", /Agent/.test(sc.stdout || "") && /Task/.test(sc.stdout || ""));
// 自检那一半要能在主逻辑瞎掉时仍然看得见：把缓存指到不存在的路径 + 塞垃圾内容，自检照答不误。
const scBlind = spawnSync(process.execPath, [HOOK, "--selfcheck"], {
  encoding: "utf8",
  env: { ...process.env, DAO_ROSTER_CACHE: path.join(TMP, "nope", "nope.json") },
});
check("主逻辑的输入全瞎时 --selfcheck 仍然作答（零共享的证据）",
  (scBlind.status === 0 || scBlind.status === 1) && /PreToolUse|未注册/.test(scBlind.stdout || ""),
  `status=${scBlind.status}`);

// ── R4 · canary：自检必须看得见「主逻辑判据死掉」──────────────────────────────
// W3 实测的洞：decide 被改成恒放行 = 生产上静默 exit 0（没抛异常就没有 fail-open 告警），
// 而只答注册面的自检照样报健康。canary 用合成缓存跑真判据，正负控各一。
check("R4 canary 正控 · 判据没被改瞎时自检报「canary 通过」",
  /主逻辑判据 canary/.test(sc.stdout || "") && !/主逻辑判据异常/.test(sc.stdout || ""), (sc.stdout || "").slice(-300));
check("R4 canary 不读真缓存 · 真缓存指到不存在的路径也照样通过",
  /主逻辑判据 canary/.test(scBlind.stdout || "") && !/主逻辑判据异常/.test(scBlind.stdout || ""),
  (scBlind.stdout || "").slice(-300));
// 🔴 断的是**退出码的构成**，不是退出码本身：本机常态是未注册 ⇒ 注册面已经贡献 1，
//    退出码永远是 1，于是「canary 的红到底计没计进去」用退出码问不出来（本轮 N5 实咬）。
//    构成行还让这套断言与注册状态解耦——注册是用户动作，测试不许依赖它。
check("R4 canary · 自检摆出退出码构成（注册面 / canary 分开记）",
  /退出码构成：注册面 \d+ \+ 主逻辑 canary \d+ ⇒ exit [01]/.test(sc.stdout || ""), (sc.stdout || "").slice(-200));
check("R4 canary 正控 · 构成行里 canary 记 0", /主逻辑 canary 0/.test(sc.stdout || ""));

console.log("\n=== 判别力 · mutation（把判据改坏，正控必须跟着掉下来）===");
const SRC = fs.readFileSync(HOOK, "utf8");
const MUT_DIR = path.join(REPO, "_tmp");
fs.mkdirSync(MUT_DIR, { recursive: true });

/**
 * 造一个变异体跑一次。
 * ① 锚点断的就是**真正喂给 replace 的那个表达式**（下面全是单行字面串，没有跨行锚点，
 *    所以不存在 CRLF 咬不到的那一格）；锚点找不到即判红，不许静默变成空操作。
 * ② 读红集之前先确认**变异体还活着**：拿一个与本判据无关的负控探一下，
 *    它要是也塌了（语法错 / fail-open 告警），那条红说明不了任何事。
 */
function mutate(name, find, replace, run1) {
  if (!SRC.includes(find)) {
    check(`mutation ${name}`, false, `锚点串在闸里找不到了：${find.slice(0, 60)}`);
    return;
  }
  const p = path.join(MUT_DIR, `dispatch-gate-mutant-${process.pid}-${Math.random().toString(36).slice(2)}.js`);
  try {
    fs.writeFileSync(p, SRC.replace(find, replace), "utf8");
    const alive = run(notAgentTool(), null, p);
    if (alive.status !== 0 || /fail-open|SyntaxError/.test(alive.stderr)) {
      check(`mutation ${name} · 变异体存活探针`, false, `变异体自己塌了：status=${alive.status} ${alive.stderr.slice(0, 120)}`);
      return;
    }
    run1(p);
  } finally {
    fs.rmSync(p, { force: true });
  }
}

writeCache({ available: true });
mutate("M1 「Orca 活着」判据被改瞎", `if (orca.available === true) {`, `if (orca.available === "__NEVER__") {`,
  (p) => check("M1 ⇒ 正控 A 从「拦」掉到「放行」", run(implementer(), null, p).status === 0));

mutate("M2 isolation=worktree 判据被改瞎", `if (ti.isolation === "worktree") {`, `if (ti.isolation === "__NEVER__") {`,
  (p) => check("M2 ⇒ 正控 B（只读官种 + worktree）从「拦」掉到「放行」", run(scoutInWorktree(), null, p).status === 0));

mutate("M3 写权官种表被改瞎", `  "dao-implementer",`, `  "__NEVER__",`,
  (p) => check("M3 ⇒ 正控 A（无 isolation，只靠官种）从「拦」掉到「放行」", run(implementer(), null, p).status === 0));

mutate("M4 全权底座表被清空", `const FULL_ACCESS_AGENT_TYPES = ["claude", "general-purpose"];`,
  `const FULL_ACCESS_AGENT_TYPES = [];`,
  (p) => check("M4 ⇒ 正控 C（claude 底座）从「拦」掉到「放行」", run(genericBase(), null, p).status === 0));

writeCache({ available: false, ageMs: 3 * 60 * 60 * 1000 });
mutate("M5 新鲜度（TTL）判据被改瞎", `  if (ageMs > ttlMs()) return { state: "stale", roster, ageMs };`,
  `  if (false) return { state: "stale", roster, ageMs };`,
  (p) => check("M5 ⇒ 过期缓存（说 Orca 死）从「拦」掉到「降级放行」", run(implementer(), null, p).status === 0));

writeCache({ available: false, reason: "locator:miss" });
mutate("M6 降级留痕的落盘动作被摘掉", `    fs.appendFileSync(p, JSON.stringify(rec) + "\\n", "utf8");`,
  `    void p;`,
  (p) => {
    clearLog();
    const r = run(implementer(), null, p);
    check("M6 ⇒ 仍放行但留痕不落盘（证明留痕断言真的在断留痕，不是断退出码）",
      r.status === 0 && logLines().length === 0, `status=${r.status} lines=${logLines().length}`);
  });

writeCache({ available: true });
mutate("M8 R1「无类型字段视同全权底座」判据被改瞎", `  if (!type) {`, `  if (false) {`,
  (p) => check("M8 ⇒ 无类型字段的 Agent 从「拦」掉到「放行」（R1 那一整类漏拦复现）",
    run(noTypeAgent(), null, p).status === 0));

// R3 的判别力：分支没了 ⇒ 缺失格回到命令式文案。
mutate("M9 R3 的「缺失/过期」消息分支被摘掉",
  `  if (d.cacheState === "missing" || d.cacheState === "stale") {`, `  if (false) {`,
  (p) => {
    clearCache();
    const s = run(implementer(), null, p).stderr;
    check("M9 ⇒ 缺失格的消息掉回命令式（R3 断言跟着掉）", !/不用你动手/.test(s));
    writeCache({ available: true });
  });

// ── R4 canary 的判别力：判据被改瞎时，--selfcheck 必须自己红 ────────────────────
// 这两条是本轮新判据里最要紧的：canary 本身要是空转，它带来的安全感全是假的。
function runSelfcheck(hookPath) {
  const r = spawnSync(process.execPath, [hookPath, "--selfcheck"], { encoding: "utf8", env: { ...process.env } });
  return { status: r.status, stdout: r.stdout || "" };
}
// canary 红了要满足两件事，缺一不可：**打出来**（人看得见）+ **计进退出码构成**（机器看得见）。
// 只断前者，把 `badCanary++` 摘掉不会有任何东西红（本轮 N5 实咬）；只断退出码，未注册的机器
// 会替它蒙混过关。所以两条一起断。
const canaryRed = (r) => /主逻辑判据异常/.test(r.stdout) && /主逻辑 canary 1/.test(r.stdout);
mutate("M10 canary 正控半 · decide 的「Orca 活着」判据被改瞎",
  `if (orca.available === true) {`, `if (orca.available === "__NEVER__") {`,
  (p) => {
    const r = runSelfcheck(p);
    check("M10 ⇒ --selfcheck 打「主逻辑判据异常」且计进退出码构成（自检看得见主逻辑死掉）",
      canaryRed(r) && r.status === 1, `status=${r.status} ${r.stdout.slice(-200)}`);
  });
// 误拦有两种失效形态，canary 都得看得见，所以钉两条：
// M11 判据变成「拦一切」（干净的误判，不抛异常）；M12 判据抛异常（canary 自己接得住，不许静默）。
mutate("M11 canary 负控半 · 写权官种表判据被改成恒真（闸变成拦一切）",
  `  if (WRITER_AGENT_TYPES.includes(type)) {`, `  if (true) {`,
  (p) => {
    const r = runSelfcheck(p);
    check("M11 ⇒ --selfcheck 报「必放样本被判成 block」且计进退出码构成",
      canaryRed(r) && /必放样本/.test(r.stdout) && r.status === 1, `status=${r.status} ${r.stdout.slice(-200)}`);
  });
mutate("M12 canary 兜底半 · decide 被改成会抛异常",
  `  if (!feature) return { action: "allow", reason: "无写盘特征（只读侦察走这一格）" };`,
  `  if (false) return { action: "allow", reason: "无写盘特征（只读侦察走这一格）" };`,
  (p) => {
    const r = runSelfcheck(p);
    check("M12 ⇒ canary 自己接住异常并判红，不静默也不砸掉注册结论",
      canaryRed(r) && /PreToolUse|未注册/.test(r.stdout) && r.status === 1, `status=${r.status}`);
  });

writeCache({ available: true });
mutate("M7 主判定抛异常（钉 fail-open 那一路真的活着）",
  `  const feature = writerFeature(input && input.tool_input);`,
  `  const feature = (() => { throw new Error("mutant-boom"); })();`,
  (p) => {
    const r = run(implementer(), null, p);
    check("M7 ⇒ 正控 A 掉到「放行」且 stderr 有 fail-open 告警",
      r.status === 0 && /fail-open/.test(r.stderr), `status=${r.status}`);
  });

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail > 0 ? 1 : 0);
