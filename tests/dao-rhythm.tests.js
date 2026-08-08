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
// 跨文件判据一致性那一组要用到签名侧的闸（见本文件末尾）。dao-hard-gates.js 只读、无副作用，
// 不写任何状态文件 ⇒ 不需要沙箱，直接跑真文件（沙箱是为 rhythm 的三处状态文件准备的）。
const REAL_GATES = path.join(REPO, "ccswitch", "hooks", "dao-hard-gates.js");
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

console.log("\n=== 正态 · WAKEUP：心跳唤醒轮 → 留守四句 + Read §心跳对账节 ===");
{
  const r = run(HOOK, "[dao-heartbeat] 高性能目标窗心跳（不限时）。对账：① 三路在途……", SID_BASE + "-wake1");
  const c = ctx(r);
  check("签名开头 → 注入 WAKEUP", /dao 节律·WAKEUP/.test(c), "ctx=" + c.slice(0, 120));
  check("注入带取证签名 [dao-rhythm WAKEUP v1]（可达性矩阵靠 Grep 它取证，不问 agent 本人）",
    /\[dao-rhythm WAKEUP v1\]/.test(c));
  check("注入含「醒来第一动作 Read dao-longwindow.md §心跳对账节」",
    /dao-longwindow\.md/.test(c) && /心跳对账节/.test(c));
  check("留守四句四句都在（㈠防停摆 ㈡简报铁序 ㈢在途水位 ㈣自主边界）",
    /㈠/.test(c) && /㈡/.test(c) && /㈢/.test(c) && /㈣/.test(c), "ctx=" + c.slice(0, 200));
  check("㈡ 写明 ScheduleWakeup 不得作本轮最后一个工具调用（铁序里最易漏的那半）",
    /永不作本轮最后一个工具调用/.test(c));
  check("㈢ 写明补水位排在本轮第一个工具段（次序上唯一的硬规）",
    /第一个工具段/.test(c));
  check("声明本文件是压缩投影、冲突以 dao-longwindow.md 为准（防两份正文各自漂移）",
    /冲突一律以该文件为准/.test(c));
  check("hookEventName = UserPromptSubmit",
    r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.hookEventName === "UserPromptSubmit");
  check("exit 0", r.code === 0, "code=" + r.code);
}
{
  // 与 SCAFFOLD/CLOSING 相反：WAKEUP **不做 per-session 去重**。留守四句要的就是每一轮都到，
  // 心跳轮之间隔着 900-1800 秒和一整批工具调用，去重＝第二轮之后全部裸奔。
  const sid = SID_BASE + "-wake-repeat";
  const r1 = run(HOOK, "[dao-heartbeat] 第一轮心跳", sid);
  const r2 = run(HOOK, "[dao-heartbeat] 第二轮心跳", sid);
  const r3 = run(HOOK, "[dao-heartbeat] 第三轮心跳", sid);
  check("同会话连续三轮心跳 → 三轮都注入（刻意不去重）",
    /dao 节律·WAKEUP/.test(ctx(r1)) && /dao 节律·WAKEUP/.test(ctx(r2)) && /dao 节律·WAKEUP/.test(ctx(r3)),
    "r2=" + ctx(r2).slice(0, 60) + " r3=" + ctx(r3).slice(0, 60));
}
{
  // 优先级最高：即便 READY armed（12 条埋点 + 未播报标记）也让 WAKEUP 先出。
  // 同时断言 **READY 的一次性标记没被烧掉** —— 被挤掉的是「这一轮」，不是「这条播报」。
  const readyHook = makeSandbox("wakeup-vs-ready", { armReady: true, closingLogLines: 12 });
  const r = run(readyHook, "[dao-heartbeat] 心跳轮，顺带对账", SID_BASE + "-wake-vs-ready");
  const c = ctx(r);
  check("WAKEUP 优先于 READY（≤1 指针/回合）",
    /dao 节律·WAKEUP/.test(c) && !/v2 验证就绪/.test(c), "ctx=" + c.slice(0, 120));
  const mark = path.join(SANDBOX_BASE, "wakeup-vs-ready", "_tmp", ".rhythm-v2-announced");
  check("被挤掉的 READY 标记未被烧 ⇒ 推迟不是丢失（下一个非心跳轮仍会播报）",
    !fs.existsSync(mark));
  const r2 = run(readyHook, "随便说点什么都行", SID_BASE + "-wake-vs-ready-2");
  check("下一个非心跳轮 READY 果然补上了（把上一条从「标记还在」升成「真的还会播」）",
    /v2 验证就绪/.test(ctx(r2)), "ctx=" + ctx(r2).slice(0, 120));
}
{
  const r = run(HOOK, "[dao-heartbeat] 我们之前遇到过这个问题吗", SID_BASE + "-wake-vs-recall");
  const c = ctx(r);
  check("WAKEUP 优先于 RECALL（确定性签名不给启发式正则让路）",
    /dao 节律·WAKEUP/.test(c) && !/dao 节律·回顾/.test(c), "ctx=" + c.slice(0, 120));
}

console.log("\n=== 负态 · WAKEUP：只认「trim 之后以签名开头」，别的一概不认 ===");
{
  const NEG_WAKE = [
    ["普通消息无签名", "帮我看看这个函数的实现"],
    ["真实历史心跳形态（没签名的那种，正是 G6 要拦的）", "高性能目标窗心跳（不限时）。对账：① 三路在途……"],
    ["签名不在开头", "对账：① 两路在途 [dao-heartbeat]"],
    ["大小写不符", "[DAO-HEARTBEAT] 心跳"],
    ["方括号不闭合", "[dao-heartbeat 心跳"],
    ["下划线/空格变体", "[dao heartbeat] 心跳"],
    ["只是提到这个签名（散文里引用）", "G6 要求 prompt 以 [dao-heartbeat] 开头，你记住"],
  ];
  for (const [name, prompt] of NEG_WAKE) {
    const r = run(HOOK, prompt, SID_BASE + "-negwake-" + Buffer.from(name).toString("hex").slice(0, 10));
    check("负控：" + name + " → 不注入 WAKEUP", !/dao 节律·WAKEUP/.test(ctx(r)), "ctx=" + ctx(r).slice(0, 100));
  }
  // 前导空白**要**认（两边都先 trim），单列一条正控免得上面那批被读成「凡不完全一致都不认」
  const r = run(HOOK, "  \n[dao-heartbeat] 心跳", SID_BASE + "-wake-leadws");
  check("正控（配对项）：签名前有空白仍认（判据是 trim 之后的前缀）",
    /dao 节律·WAKEUP/.test(ctx(r)), "ctx=" + ctx(r).slice(0, 100));
}

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

console.log("\n=== mutation · WAKEUP 判别力（两个方向，改坏一处对应那组必须翻面）===");
{
  // 「测试存在」≠「测试有判别力」。上面 WAKEUP 的正控与负控**各自**都可能是永真的：
  // 判据恒真时负控全瞎，判据恒假时正控全瞎，而两种瞎法在全绿输出里都看不出来。
  // 故这里两个方向各改坏一次，断言对应那一组**真的翻面**。
  // ⚠ 刻意两个方向都跑：只往「放松」一侧 mutate 会让负控一次都没被验到
  //   （dispatch-clauses 对抗验证官节点名的第四件事：改法方向单一 ⇒ 某类断言结构上永远验不到）。
  const src = fs.readFileSync(REAL_HOOK, "utf8");
  const REAL_SHA_BEFORE = require("crypto").createHash("sha256").update(src).digest("hex");

  function mutantHook(tag, from, to) {
    check(`mutation 靶点在源码里唯一存在（${tag}）`, src.split(from).length === 2,
      `出现 ${src.split(from).length - 1} 次`);
    const root = path.join(SANDBOX_BASE, "mut-" + tag);
    fs.rmSync(root, { recursive: true, force: true });
    const hooksDir = path.join(root, "ccswitch", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.mkdirSync(path.join(root, "_tmp"), { recursive: true });
    fs.writeFileSync(path.join(root, "_tmp", ".rhythm-v2-announced"), "test");
    fs.writeFileSync(path.join(hooksDir, "dao-rhythm.js"), src.replace(from, to), "utf8");
    sandboxes.push(root);
    return path.join(hooksDir, "dao-rhythm.js");
  }

  // 方向①「放松」：判据恒真 ⇒ 本不该注入的普通消息开始注入 ⇒ 证明负控那一组真的在测判据
  {
    const h = mutantHook("loosen", "const HEARTBEAT_SIG = /^\\[dao-heartbeat\\]/;",
      "const HEARTBEAT_SIG = /^/;");
    const before = ctx(run(HOOK, "帮我看看这个函数的实现", SID_BASE + "-mutL-a"));
    const after = ctx(run(h, "帮我看看这个函数的实现", SID_BASE + "-mutL-b"));
    check("放松方向：真文件不注入，判据改恒真后注入 ⇒ 负控组有判别力",
      !/dao 节律·WAKEUP/.test(before) && /dao 节律·WAKEUP/.test(after),
      `before=${before.slice(0, 40)} after=${after.slice(0, 40)}`);
  }
  // 方向②「关掉」：保留字面但使其不执行（`if (false)`）⇒ 正控停止注入
  //   刻意取这一形态而不是整段删除：整段删除 code review 一眼看得见，「留着但不执行」才是
  //   真正骗得过人眼的那种（dispatch-clauses 对抗验证官节 ②）。
  {
    const h = mutantHook("disable", "if (HEARTBEAT_SIG.test(String(prompt).trim())) {",
      "if (false && HEARTBEAT_SIG.test(String(prompt).trim())) {");
    const before = ctx(run(HOOK, "[dao-heartbeat] 心跳", SID_BASE + "-mutD-a"));
    const after = ctx(run(h, "[dao-heartbeat] 心跳", SID_BASE + "-mutD-b"));
    check("关掉方向：真文件注入，判据被架空后不注入 ⇒ 正控组有判别力",
      /dao 节律·WAKEUP/.test(before) && !/dao 节律·WAKEUP/.test(after),
      `before=${before.slice(0, 40)} after=${after.slice(0, 40)}`);
    check("变异体还活着（canary）：架空 WAKEUP 后 RECALL 仍然照常注入，证明不是整个 hook 崩了",
      /dao 节律·回顾/.test(ctx(run(h, "我们之前遇到过这个问题吗", SID_BASE + "-mutD-c"))));
  }

  check("canary 恒等：真 hook 文件全程未被改动",
    require("crypto").createHash("sha256").update(fs.readFileSync(REAL_HOOK)).digest("hex") === REAL_SHA_BEFORE);
}

console.log("\n=== 跨文件一致性：G6 放行 ⇔ rhythm 注入 WAKEUP（判据有两份实现）===");
{
  // ── 这一组防的是什么 ──────────────────────────────────────────────────────
  // 心跳签名这一条判据**同时活在两个文件里**：dao-hard-gates.js 的 G6（拦未签名的
  // ScheduleWakeup）与 dao-rhythm.js 的 WAKEUP（认出签名后注入留守四句）。两边任一侧
  // 单独改动，都会造出一种**双绿的静默失败**：
  //   · 闸放宽而 rhythm 没跟 ⇒ prompt 过了闸却收不到注入（「过闸即安全」是错觉）
  //   · rhythm 放宽而闸没跟 ⇒ 明明认得出的形态被闸拦下，人被教去改一个本就对的 prompt
  // 两种都不会让任何单侧测试变红 —— 各自的正负控在各自的判据下全都成立。
  // 故这里把**同一批 prompt 同时喂给两个 hook**，钉死双向等价：拦 ⇔ 不注入。
  //
  // ⚠ 它证的是「两边此刻同判」，**不证**「这条判据本身选得对」。选得对不对由 G6 头注里
  // 那份真实语料普查（993 次 ScheduleWakeup 调用）承担，不由本组承担。
  const CORPUS = [
    "[dao-heartbeat] 高性能目标窗心跳。对账：① 三路在途",
    "[dao-heartbeat]",
    "[dao-heartbeat]无空格紧跟",
    "  \n[dao-heartbeat] 前导空白",
    "高性能自主窗心跳。第一动作：回看上一轮是否真有面向用户的最终文本发出",
    "【8h 高性能自主窗 · 心跳】第一动作：回看上一轮",
    "[DAO-HEARTBEAT] 大小写不符",
    "对账：① 两路在途 [dao-heartbeat]",
    "[dao-heartbeat 方括号不闭合",
    "帮我看看这个函数的实现",
    "",
    "/dao-verify",
  ];
  // ── 逃生阀隔离（issue #188 同批扫出的同型）────────────────────────────────
  // 这一处与 `tests/hard-gates.tests.js` 的 `gate()` 同病：spawn 真闸却整份继承父进程环境。
  // 敲命令的人开着 G6 那把阀（`DAO_WAKEUP_UNSIGNED_OK=1`）时，闸这一侧**恒放行** ⇒ 本组
  // 就从「两份判据此刻同不同判」退化成「rhythm 注不注入」，而红报文照旧指向判据。
  // 清单由**独立正则读 hook 源码**得来（不调 hook、不复用它的解析）；空集即红 ——
  // 「读不出清单」与「一个逃生阀都没有」在剥离行为上逐字节相同。
  const GATE_ESCAPE_ENVS = [...fs.readFileSync(REAL_GATES, "utf8")
    .matchAll(/escapeEnv:\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  check(`逃生阀隔离：从 dao-hard-gates.js 读得出逃生阀清单（${GATE_ESCAPE_ENVS.length} 个；空集 = 本次一个都没剥掉）`,
    GATE_ESCAPE_ENVS.length > 0, GATE_ESCAPE_ENVS.join(","));
  const GATE_ENV = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!GATE_ESCAPE_ENVS.some((e) => e.toUpperCase() === k.toUpperCase())) GATE_ENV[k] = v;
  }

  let agree = 0;
  for (const prompt of CORPUS) {
    const g = spawnSync(process.execPath, [REAL_GATES], {
      input: JSON.stringify({ tool_name: "ScheduleWakeup", tool_input: { delaySeconds: 900, prompt } }),
      encoding: "utf8",
      env: GATE_ENV,
    });
    const blocked = g.status === 2;
    const r = run(HOOK, prompt, SID_BASE + "-xcheck-" + Buffer.from(prompt).toString("hex").slice(0, 12));
    const injected = /dao 节律·WAKEUP/.test(ctx(r));
    const ok = blocked === !injected;
    if (ok) agree++;
    check(`一致：${JSON.stringify(prompt.slice(0, 28))} → 闸${blocked ? "拦" : "放"} / rhythm${injected ? "注入" : "不注入"}`,
      ok, `blocked=${blocked} injected=${injected}`);
  }
  check(`语料全体双向一致（${agree}/${CORPUS.length}）`, agree === CORPUS.length);
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
