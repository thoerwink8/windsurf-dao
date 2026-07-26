// dao-rhythm 两态自证 · 单元级（喂 UserPromptSubmit 形态 JSON → 断言 stdout）
//
// 跑法：node tests/dao-rhythm.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 验的是哪一层：**四套正则分类器的两态判定 + 三个去重状态文件的一次性语义**。
// 它证明「命中信号即注入对应指针 / 不命中即零输出 / 同会话只注入一次 / 优先级正确」，
// **不证明**注入真的改变了模型行为——那取决于宿主投递，不在单元测试射程内。
//
// ── 为什么跑沙箱副本，而不是直接跑 ccswitch/hooks/dao-rhythm.js ───────────────
// 该 hook 的三处状态文件里有两处按 `path.resolve(__dirname,"..","..")` 定位：
//   · <ROOT>/_tmp/rhythm-closing.log      —— CLOSING 埋点（耐久观测数据，真实样本）
//   · <ROOT>/_tmp/.rhythm-v2-announced    —— READY 一次性播报标记
// 路径不可注入 ⇒ 直接跑真文件会把测试样本混进**真实的 CLOSING 埋点日志**（那份日志
// 是将来复盘误触率、决定 CLOSING 转正/回退的依据，掺入假样本等于污染结论），并可能
// 把 READY 的一次性标记提前烧掉、让真实的「可验证调参」播报永不出现。
// 故把 hook 复制到 <repo>/_tmp/ 下的沙箱、保持 `ccswitch/hooks/` 同样深度，令 ROOT
// 落在沙箱内。副本每次运行都从真文件重新拷贝 ⇒ 不会变成一份悄悄过期的旧代码。
//
// 第三处状态文件在 os.tmpdir()/dao-rhythm/ 下、按 session_id 命名（SCAFFOLD/CLOSING
// 的 per-session 去重）。它不受 ROOT 影响，故测试用带随机后缀的 session_id，跑完删除。
//
// ── 沙箱副本的已知脆弱点（显式挂账）─────────────────────────────────────────
// 副本只拷单文件。若将来 dao-rhythm.js 新增了对同仓文件的 require（如改薄封装到
// ccswitch/lib/），副本会因找不到依赖而崩，测试会**看起来仍在跑**却测了个残废。
// 故下方有一条守卫断言：hook 源码不得出现相对路径 require——真加了依赖就当场变红，
// 逼人来改这份测试的拷贝逻辑，而不是静默失效（本仓反复被「静默失效」咬过）。

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const REAL_HOOK = path.join(REPO, "ccswitch", "hooks", "dao-rhythm.js");
const SANDBOX_BASE = path.join(REPO, "_tmp", "knifeF-rhythm-sandbox");
const SID_BASE = "knifeF-rhythm-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
const SESSION_MARK_DIR = path.join(os.tmpdir(), "dao-rhythm");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// ── 沙箱：<base>/<tag>/ccswitch/hooks/dao-rhythm.js，ROOT 落在 <base>/<tag> ──
const sandboxes = [];
function makeSandbox(tag, opts) {
  const o = opts || {};
  const root = path.join(SANDBOX_BASE, tag);
  fs.rmSync(root, { recursive: true, force: true });
  const hooksDir = path.join(root, "ccswitch", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(REAL_HOOK, path.join(hooksDir, "dao-rhythm.js"));
  const tmpDir = path.join(root, "_tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  // 除 READY 专用沙箱外，一律预先烧掉 READY 标记 —— 把 READY 关掉，才能干净地
  // 单验其余三套分类器（否则攒够 12 条埋点后 READY 会抢走注入，症状像是分类器失灵）
  if (!o.armReady) fs.writeFileSync(path.join(tmpDir, ".rhythm-v2-announced"), "test");
  if (o.closingLogLines) {
    const lines = [];
    for (let i = 0; i < o.closingLogLines; i++) lines.push(`2026-07-26T00:00:0${i % 10}.000Z\tseed-${i}\t预置样本 ${i}`);
    fs.writeFileSync(path.join(tmpDir, "rhythm-closing.log"), lines.join("\n") + "\n");
  }
  sandboxes.push(root);
  return path.join(hooksDir, "dao-rhythm.js");
}

function run(hookPath, prompt, sessionId) {
  const payload = JSON.stringify({
    session_id: sessionId,
    transcript_path: "C:/fake/transcript.jsonl",
    cwd: REPO,
    hook_event_name: "UserPromptSubmit",
    prompt,
  });
  const r = spawnSync(process.execPath, [hookPath], { input: payload, encoding: "utf8" });
  let json = null;
  if (r.stdout && r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch (_) {} }
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", json };
}
function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || "";
}

// ── 守卫：副本策略的前提（无相对依赖）必须仍然成立 ──────────────────────────
console.log("\n=== 守卫：沙箱副本的前提 ===");
{
  const src = fs.readFileSync(REAL_HOOK, "utf8");
  const relReq = src.match(/require\(\s*["']\.{1,2}\//g) || [];
  check("hook 无相对路径 require（否则单文件副本会残废，需改本测试的拷贝逻辑）",
    relReq.length === 0, "发现 " + relReq.length + " 处相对 require");
}

const HOOK = makeSandbox("main");

console.log("\n=== 正态 · RECALL：回顾类提问 → 先搜 memory/evolution ===");
{
  const r = run(HOOK, "我们之前遇到过这个问题吗", SID_BASE + "-recall1");
  check("中文回顾（之前+吗）→ 注入回顾指针", /dao 节律·回顾/.test(ctx(r)));
  check("回顾指针指向 memory 索引与 evolution", /MEMORY\.md/.test(ctx(r)) && /evolution/.test(ctx(r)));
  check("hookEventName = UserPromptSubmit",
    r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.hookEventName === "UserPromptSubmit");
  check("exit 0", r.code === 0, "code=" + r.code);
}
{
  const r = run(HOOK, "did we hit this bug before?", SID_BASE + "-recall2");
  check("英文回顾（did we）→ 注入回顾指针", /dao 节律·回顾/.test(ctx(r)));
}
{
  const r = run(HOOK, "当时怎么解决的", SID_BASE + "-recall3");
  check("RECALL_STRONG 短语（当时怎么/怎么解决的）→ 注入，无需疑问词", /dao 节律·回顾/.test(ctx(r)));
}

console.log("\n=== 正态 · SCAFFOLD：新建项目意图 → 先过 /dao-project-scaffold ===");
{
  const r = run(HOOK, "帮我新建一个项目", SID_BASE + "-scaf1");
  check("STRONG（动词+项目级宾语）→ 注入新建项目指针", /dao 节律·新建项目/.test(ctx(r)));
  check("指针指向 /dao-project-scaffold", /\/dao-project-scaffold/.test(ctx(r)));
  check("声明每会话仅一次", /每会话仅一次/.test(ctx(r)));
}
{
  const r = run(HOOK, "帮我新起一个", SID_BASE + "-scaf2");
  check("VERB-only（动词即够，无宾语）→ 仍注入", /dao 节律·新建项目/.test(ctx(r)));
}
{
  const r = run(HOOK, "初始化一个新仓库", SID_BASE + "-scaf3");
  check("初始化+仓库 → 注入", /dao 节律·新建项目/.test(ctx(r)));
}

console.log("\n=== 正态 · CLOSING：强收尾信号 → 提醒 distill + 埋点 ===");
{
  const sid = SID_BASE + "-close1";
  const r = run(HOOK, "今天到这吧，收工", sid);
  check("强收尾短语 → 注入收尾指针", /dao 节律·收尾/.test(ctx(r)));
  check("收尾指针指向 dao-evolution", /dao-evolution/.test(ctx(r)));
  const log = path.join(SANDBOX_BASE, "main", "_tmp", "rhythm-closing.log");
  const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean) : [];
  check("CLOSING 落埋点一行（供日后复盘误触率）", lines.length >= 1, "lines=" + lines.length);
  check("埋点行含 session_id 与原文片段",
    lines.some((l) => l.includes(sid) && l.includes("收工")), "last=" + (lines[lines.length - 1] || ""));
}

console.log("\n=== 正态 · READY：收尾样本攒够阈值 → 一次性自报告，且优先级最高 ===");
{
  // 预置 12 条埋点（阈值 CLOSING_THRESHOLD=12）且不烧 READY 标记
  const readyHook = makeSandbox("ready", { armReady: true, closingLogLines: 12 });
  const r = run(readyHook, "随便说点什么都行", SID_BASE + "-ready1");
  check("攒够 12 条 → 注入 v2 验证就绪播报", /v2 验证就绪/.test(ctx(r)), "ctx=" + ctx(r).slice(0, 120));
  check("播报含真实样本数 12", /12 条样本/.test(ctx(r)));
  const mark = path.join(SANDBOX_BASE, "ready", "_tmp", ".rhythm-v2-announced");
  check("播报后落一次性标记", fs.existsSync(mark));
  const r2 = run(readyHook, "再随便说点什么都行", SID_BASE + "-ready2");
  check("二次调用 → 不再重复播报（一次性语义）", !/v2 验证就绪/.test(ctx(r2)), "ctx=" + ctx(r2).slice(0, 120));
}
{
  // READY armed 且同时命中 RECALL：READY 在代码里排在最前且 inject 即 exit ⇒ READY 赢
  const readyHook = makeSandbox("ready-prio", { armReady: true, closingLogLines: 12 });
  const r = run(readyHook, "我们之前遇到过这个问题吗", SID_BASE + "-readyprio");
  check("READY 优先于 RECALL（≤1 指针/回合）",
    /v2 验证就绪/.test(ctx(r)) && !/dao 节律·回顾/.test(ctx(r)), "ctx=" + ctx(r).slice(0, 120));
}
{
  // 阈值下方不许播报：11 条 < 12
  const belowHook = makeSandbox("ready-below", { armReady: true, closingLogLines: 11 });
  const r = run(belowHook, "随便说点什么都行", SID_BASE + "-below");
  check("11 条（阈值下方）→ 不播报（阈值两侧都夹住，不只验能触发）",
    !/v2 验证就绪/.test(ctx(r)) && r.out === "", "out=" + JSON.stringify(r.out.slice(0, 120)));
}

console.log("\n=== 优先级 · RECALL > SCAFFOLD（同时命中时只出一个指针）===");
{
  const r = run(HOOK, "我们之前搭建过项目吗", SID_BASE + "-prio1");
  const c = ctx(r);
  check("同时命中 RECALL 与 SCAFFOLD → 只注入 RECALL",
    /dao 节律·回顾/.test(c) && !/dao 节律·新建项目/.test(c), "ctx=" + c.slice(0, 120));
}

console.log("\n=== per-session 去重：同会话只提醒一次 ===");
{
  const sid = SID_BASE + "-dedup-scaffold";
  const r1 = run(HOOK, "帮我新建一个项目", sid);
  const r2 = run(HOOK, "再帮我新建一个项目", sid);
  check("SCAFFOLD 首次注入", /dao 节律·新建项目/.test(ctx(r1)));
  check("SCAFFOLD 同会话二次 → 静默（长自主窗高频动词不许每回合刷屏）",
    r2.out === "", "out=" + JSON.stringify(r2.out.slice(0, 120)));
}
{
  const sid = SID_BASE + "-dedup-closing";
  const r1 = run(HOOK, "今天到这吧，收工", sid);
  const r2 = run(HOOK, "收工了，晚安", sid);
  check("CLOSING 首次注入", /dao 节律·收尾/.test(ctx(r1)));
  check("CLOSING 同会话二次 → 静默", r2.out === "", "out=" + JSON.stringify(r2.out.slice(0, 120)));
}
{
  // 去重是 per-session 而非 per-machine：换 session 必须重新提醒
  const r = run(HOOK, "帮我新建一个项目", SID_BASE + "-dedup-newsession");
  check("换 session → SCAFFOLD 重新注入（去重粒度是会话，不是全局）",
    /dao 节律·新建项目/.test(ctx(r)));
}

console.log("\n=== 负态：无信号一个字都不许输出（宁可漏报不可滥报）===");
const NEG = [
  ["过短输入（<4 字符）", "ok"],
  ["纯 slash 命令无实质内容", "/dao-verify"],
  ["普通技术提问（含 INTERNAL 词，无动词）", "帮我看看这个函数的实现"],
  ["SCAFFOLD 黑名单：动词+项目内部产物", "新建一个组件"],
  ["SCAFFOLD 黑名单：hook 属内部产物", "顺手加一个 hook"],
  ["高歧义词显式不收（好了/可以了）", "好了，可以了"],
  ["普通陈述句", "这段代码的性能还不错"],
  ["空 prompt", ""],
];
for (const [name, prompt] of NEG) {
  const r = run(HOOK, prompt, SID_BASE + "-neg-" + Buffer.from(name).toString("hex").slice(0, 10));
  check(name + " → stdout 全空", r.out === "", "out=" + JSON.stringify(r.out.slice(0, 160)));
  check(name + " → exit 0（优雅降级，只增不阻）", r.code === 0, "code=" + r.code);
}

console.log("\n=== 健壮性：坏输入不许崩（只增不阻）===");
{
  const r = spawnSync(process.execPath, [HOOK], { input: "这不是 JSON{{{", encoding: "utf8" });
  check("坏 stdin → exit 0 且静默", r.status === 0 && (r.stdout || "") === "",
    "code=" + r.status + " out=" + JSON.stringify((r.stdout || "").slice(0, 120)));
}
{
  const r = run(HOOK, "[Image #1] 我们之前遇到过这个问题吗", SID_BASE + "-strip1");
  check("strip 掉 [Image #N] 后仍命中 RECALL", /dao 节律·回顾/.test(ctx(r)));
}
{
  const r = run(HOOK, "<thinking>噪音</thinking> 帮我新建一个项目", SID_BASE + "-strip2");
  check("strip 掉 <tag> 后仍命中 SCAFFOLD", /dao 节律·新建项目/.test(ctx(r)));
}
{
  const r = run(HOOK, "/dao-loop 我们之前遇到过这个问题吗", SID_BASE + "-slash2");
  check("slash 命令带实质内容 → 仍参与判定", /dao 节律·回顾/.test(ctx(r)));
}

// ── 清理：沙箱 + 本次用到的 per-session 标记 ────────────────────────────────
for (const s of sandboxes) { try { fs.rmSync(s, { recursive: true, force: true }); } catch (_) {} }
try {
  if (fs.existsSync(SESSION_MARK_DIR)) {
    for (const f of fs.readdirSync(SESSION_MARK_DIR)) {
      if (f.startsWith(SID_BASE)) { try { fs.rmSync(path.join(SESSION_MARK_DIR, f), { force: true }); } catch (_) {} }
    }
  }
} catch (_) {}
try { fs.rmSync(SANDBOX_BASE, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
