// dao-scaffold-check 两态自证 · 单元级（喂 SessionStart 形态 JSON → 断言 stdout）
//
// 跑法：node tests/dao-scaffold-check.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 验的是哪一层：**双模式分派 + 各条结构判据的两态 + hook 注册检测器的扩展名盲区**。
// 它证明「有缺陷即报出对应条目 / 缺陷补齐即不再报 / 非 git 目录完全静默」，
// **不证明** 注入的提醒真被宿主投递给模型。
//
// ── 隔离手法（不许污染真实仓库状态）─────────────────────────────────────────
// 这个 hook 会跑 git 子进程、读 live settings.json、并 require 真实的 settings-drift。
// 三处都做了隔离，逐条说明为什么这样做：
//
// ① **cwd 全部指向 <repo>/_tmp/ 下的沙箱项目**（cwd 是 payload 字段，天然可注入）。
//    模式判定看 `path.basename(cwd) === "windsurf-dao"`，故元仓库模式的沙箱就叫
//    windsurf-dao，普通项目模式的另起名字。
//
// ② **沙箱里的 `.git` 是一个内容为垃圾的普通文件，不是目录**。这一手同时解两个问题：
//    · 模式 A（普通项目）要求 `fs.existsSync(<cwd>/.git)` 为真才不跳过 —— 文件也满足；
//    · 元仓库模式会跑 `git -C <cwd> status`。**若沙箱里没有 .git，git 会向上层目录
//      一路找，最终命中真实的 D:/frank/windsurf-dao 仓库**，于是把真仓库的未提交改动
//      报成沙箱的漂移（实测确认：无 .git 时输出真仓库的 `?? tests/...`）。垃圾 .git 文件
//      让 git 以 `fatal: invalid gitfile format` 立即失败 → 被 hook 的 try/catch 兜住
//      → git 类漂移行为确定性地为空。**测试断言不该依赖真仓库此刻脏不脏。**
//
// ③ **HOME 指向沙箱假家目录**，内含一份受控的 `.claude/settings.json`。hook 用
//    `process.env.HOME || process.env.USERPROFILE` 定位 settings，故只改 HOME 即可让
//    「hook 文件 vs 注册」这一检查读受控数据 —— 断言因此不随用户真实配置变化而红。
//    （settings-drift 内部用的是 `USERPROFILE || HOME`，优先级相反 ⇒ 它仍读真实 live
//     settings。那是只读的，且下面 ④ 已挡掉它的写入面，故有意不动。）
//
// ④ **settings-drift 的心跳重定向到沙箱 + 强制 synthetic**：
//    `DAO_SETTINGS_DRIFT_STATE_DIR` 改写留痕目录，`DAO_SETTINGS_DRIFT_SELFTEST=1` 强制
//    把心跳标 synthetic。不做这两件事，测试就会往真实 `_tmp/settings-drift/fired.log`
//    写**非 synthetic** 记录 —— 那等于测试自己给「接线已生效」发假证明，正是该检测器
//    点名要防的病（它自己的头注就写着「自测心跳不予采信，防自我染绿」）。
//
// ── 断言为何多为「含/不含某子串」而非「输出完全等于」───────────────────────
// 普通项目模式里 `checkDaoDrift()` 会把**真实 windsurf-dao 仓库**的 git 状态与配置
// 自检结果并入 issues（这是它的正当职责，从任意项目都要能查到 dao 仓库漂移）。
// 那部分输出随真仓库当下状态浮动，不可能也不应该被冻成期望值。故除「非 git 目录 →
// 完全静默」这一条真能断言全空之外，其余用定向子串断言，并对每条判据同时给出
// 命中态与不命中态 —— 单向断言夹不住「判据被放宽」那个方向。

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-scaffold-check.js");
const SANDBOX = path.join(REPO, "_tmp", "knifeF-scaffold-sandbox");

// 假家目录里的受控 settings.json：只需让 `settingsRaw.includes(name)` 有确定答案
const REGISTERED = "dao-registered-probe";
const FAKE_HOME = path.join(SANDBOX, "fakehome");
const FAKE_SETTINGS = path.join(FAKE_HOME, ".claude", "settings.json");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

function resetSandbox() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(FAKE_SETTINGS), { recursive: true });
  fs.writeFileSync(FAKE_SETTINGS, JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: "startup",
        hooks: [{ type: "command", command: `node "\${PROJECT_ROOT}/ccswitch/hooks/${REGISTERED}.js"`, timeout: 5 }],
      }],
    },
  }, null, 2), "utf8");
}

// 垃圾 .git 文件：满足 existsSync，同时让 git 立即失败而不向上找到真仓库（见头注②）
function putFakeGit(dir) {
  fs.writeFileSync(path.join(dir, ".git"), "not a valid gitfile", "utf8");
}

function mkproj(name, build) {
  const root = path.join(SANDBOX, "projects", name);
  fs.mkdirSync(root, { recursive: true });
  putFakeGit(root);
  if (build) build(root);
  return root;
}

function mkMetaRepo(tag, hookFileNames) {
  const root = path.join(SANDBOX, "meta", tag, "windsurf-dao");
  const hooksDir = path.join(root, "ccswitch", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  putFakeGit(root);
  for (const f of hookFileNames) fs.writeFileSync(path.join(hooksDir, f), "// fixture\n", "utf8");
  return root;
}

function run(cwd) {
  const payload = JSON.stringify({
    session_id: "knifeF-scaffold",
    transcript_path: "C:/fake/transcript.jsonl",
    cwd,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  const r = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      HOME: FAKE_HOME,                                              // ③ 受控 settings
      DAO_SETTINGS_DRIFT_STATE_DIR: path.join(SANDBOX, "drift-state"), // ④ 心跳重定向
      DAO_SETTINGS_DRIFT_SELFTEST: "1",                             // ④ 强制 synthetic
    }),
  });
  let json = null;
  if (r.stdout && r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch (_) {} }
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", json };
}
function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || "";
}

resetSandbox();

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 模式 A · 元仓库：hook 文件 vs settings 注册（含 D5 扩展名盲区）===");
// 这一组是 fortify2-20260726 D5 修复的守卫：原判据 `.filter(f => f.endsWith(".js"))`
// 让 .mjs / 无扩展名文件永远进不了 hookFiles ⇒ 「写了没挂」两案（marshal-guard.mjs
// 14 天、compact-log 6 周）才能长期存活。若哪天有人把判据改回只认 .js，下面
// 「.mjs 未注册」与「无扩展名未注册」两条会立刻变红。
{
  const cwd = mkMetaRepo("drift", [
    `${REGISTERED}.js`,          // 已注册 → 不该报
    `${REGISTERED}.mjs`,         // 已注册（同名不同扩展）→ 不该报
    "dao-knifef-mjs-probe.mjs",  // 未注册 .mjs → 必须报（D5 守卫）
    "dao-knifef-noext",          // 未注册无扩展名 → 必须报（D5 守卫）
    "dao-knifef-js-probe.js",    // 未注册 .js → 必须报
    "helper.js",                 // 非 dao- 前缀 → 不该进检测面
    "README.md",                 // 非 dao- 前缀 → 不该进检测面
  ]);
  const r = run(cwd);
  const c = ctx(r);
  check("元仓库模式 → 注入且 hookEventName=SessionStart",
    r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.hookEventName === "SessionStart");
  check("报出「Hook 未注册」条目", /Hook 未注册/.test(c), "ctx=" + c.slice(0, 200));
  check("D5 守卫：未注册 .mjs 被报出（改回只认 .js 即变红）",
    /dao-knifef-mjs-probe/.test(c), "ctx=" + c.slice(0, 300));
  check("D5 守卫：未注册无扩展名文件被报出",
    /dao-knifef-noext/.test(c), "ctx=" + c.slice(0, 300));
  check("未注册 .js 被报出", /dao-knifef-js-probe/.test(c));
  check("负控：已注册的 .js 不报", !new RegExp(REGISTERED + "\\.js").test(c) && !/dao-registered-probe(?![-\w])/.test(c.replace(/dao-registered-probe\.mjs/g, "")), "ctx=" + c.slice(0, 300));
  check("负控：非 dao- 前缀的 helper.js 不进检测面", !/helper/.test(c), "ctx=" + c.slice(0, 300));
  check("负控：非 dao- 前缀的 README.md 不进检测面", !/README/.test(c));
  check("负控：垃圾 .git 让 git 类漂移确定性为空（不误报真仓库状态）",
    !/未提交改动/.test(c) && !/落后 origin/.test(c) && !/领先 origin/.test(c), "ctx=" + c.slice(0, 300));
}
{
  const cwd = mkMetaRepo("clean", [`${REGISTERED}.js`, "helper.js"]);
  const r = run(cwd);
  const c = ctx(r);
  check("负控：hooks 全已注册 → 不含「Hook 未注册」", !/Hook 未注册/.test(c), "ctx=" + c.slice(0, 300));
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 模式 B · 普通项目：非 git 目录必须完全静默 ===");
{
  const root = path.join(SANDBOX, "projects", "not-a-git-repo");
  fs.mkdirSync(root, { recursive: true });   // 故意不放 .git
  const r = run(root);
  check("非 git 目录 → stdout 全空（唯一可断言「全静默」的路径）",
    r.out === "", "out=" + JSON.stringify(r.out.slice(0, 200)));
  check("非 git 目录 → exit 0", r.code === 0, "code=" + r.code);
}

console.log("\n=== 模式 B · CLAUDE.md 判据两态 ===");
{
  const cwd = mkproj("missing-claude", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
  });
  check("缺 CLAUDE.md → 报出", /缺少 CLAUDE\.md/.test(ctx(run(cwd))));
}
{
  const cwd = mkproj("good-claude", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n\n- 一条铁律\n", "utf8");
  });
  const c = ctx(run(cwd));
  check("负控：有短 CLAUDE.md → 不报「缺少」", !/缺少 CLAUDE\.md/.test(c), "ctx=" + c.slice(0, 200));
  check("负控：有 .claude/rules/ → 不报「缺少 .claude/rules/」", !/缺少 \.claude\/rules\//.test(c));
}
{
  const cwd = mkproj("long-claude", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    const lines = [];
    for (let i = 1; i <= 100; i++) lines.push("行 " + i);
    fs.writeFileSync(path.join(root, "CLAUDE.md"), lines.join("\n"), "utf8"); // 无尾换行 ⇒ 恰 100 行
  });
  const c = ctx(run(cwd));
  check("CLAUDE.md 超 80 行 → 报出且行数准确（当前 100 行）",
    /超过 80 行（当前 100 行）/.test(c), "ctx=" + c.slice(0, 300));
}
{
  const cwd = mkproj("boundary-80", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    const lines = [];
    for (let i = 1; i <= 80; i++) lines.push("行 " + i);
    fs.writeFileSync(path.join(root, "CLAUDE.md"), lines.join("\n"), "utf8"); // 恰 80 行 = 边界内
  });
  check("边界：恰 80 行 → 不报（判据是 >80，两侧都夹住）",
    !/超过 80 行/.test(ctx(run(cwd))));
}

console.log("\n=== 模式 B · 其余结构判据两态 ===");
{
  const cwd = mkproj("missing-rules", (root) => {
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
  });
  check("缺 .claude/rules/ → 报出", /缺少 \.claude\/rules\//.test(ctx(run(cwd))));
}
{
  const cwd = mkproj("redundant-entry", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
    fs.writeFileSync(path.join(root, "AGENT_GUIDE.md"), "冗余入口\n", "utf8");
  });
  check("根目录有 AGENT_GUIDE.md → 报冗余入口",
    /冗余 AI 入口 AGENT_GUIDE\.md/.test(ctx(run(cwd))));
}
{
  const cwd = mkproj("prd-root", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
    fs.writeFileSync(path.join(root, "PRD.md"), "# PRD\n", "utf8");
  });
  check("PRD.md 在根目录 → 报出", /PRD\.md 在根目录/.test(ctx(run(cwd))));
}
{
  const cwd = mkproj("docs-split", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs", "superpowers"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
  });
  check("docs/superpowers/ → 报分裂目录", /分裂目录/.test(ctx(run(cwd))));
}
{
  const cwd = mkproj("docs-specs-ok", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs", "specs"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
  });
  check("负控：docs/specs/ 是 dao-loop 正规结构 → 不报分裂",
    !/分裂目录/.test(ctx(run(cwd))));
}

console.log("\n=== 模式 B · 桌面端基建判据两态 ===");
{
  const cwd = mkproj("tauri-nodebug", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.mkdirSync(path.join(root, "src-tauri"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }), "utf8");
  });
  const c = ctx(run(cwd));
  check("Tauri 项目缺 desktop-debugging.md → 报出", /desktop-debugging\.md/.test(c), "ctx=" + c.slice(0, 300));
  check("Tauri 项目缺 dev:debug 脚本 → 报出", /dev:debug 脚本/.test(c));
  check("报文标明框架为 Tauri", /Tauri/.test(c));
}
{
  const cwd = mkproj("tauri-ok", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.mkdirSync(path.join(root, "src-tauri"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
    fs.writeFileSync(path.join(root, ".claude", "rules", "desktop-debugging.md"), "# 调试规则\n", "utf8");
    fs.writeFileSync(path.join(root, "package.json"),
      JSON.stringify({ scripts: { "dev:debug": "tauri dev" } }), "utf8");
  });
  const c = ctx(run(cwd));
  check("负控：Tauri 基建齐备 → 不报 desktop-debugging.md", !/desktop-debugging\.md/.test(c), "ctx=" + c.slice(0, 300));
  check("负控：有 dev:debug → 不报缺脚本", !/dev:debug 脚本/.test(c));
}
{
  const cwd = mkproj("plain-web", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "19" } }), "utf8");
  });
  check("负控：非桌面端项目 → 不触发桌面端判据",
    !/desktop-debugging\.md/.test(ctx(run(cwd))));
}

console.log("\n=== 模式 B · 活跃 loop / plan 两态 ===");
{
  const cwd = mkproj("active-loop", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
    const d = path.join(root, "docs", "specs", "topic-x");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "STATUS.json"),
      JSON.stringify({ mode: "building", summary: "示例主题", thread: "造" }), "utf8");
  });
  const c = ctx(run(cwd));
  check("活跃 loop（mode=building）→ 报出", /Loop \[topic-x\]/.test(c), "ctx=" + c.slice(0, 300));
  check("loop 报文含 mode 与线程", /mode: building/.test(c) && /（造线）/.test(c));
}
{
  const cwd = mkproj("done-loop", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
    const d = path.join(root, "docs", "specs", "topic-done");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "STATUS.json"), JSON.stringify({ mode: "done", summary: "已完成" }), "utf8");
  });
  check("负控：mode=done → 不报活跃 loop", !/Loop \[/.test(ctx(run(cwd))));
}
{
  const cwd = mkproj("underscore-loop", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
    const d = path.join(root, "docs", "specs", "_archive");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "STATUS.json"), JSON.stringify({ mode: "building", summary: "归档件" }), "utf8");
  });
  check("负控：下划线开头目录（归档）→ 跳过", !/Loop \[_archive\]/.test(ctx(run(cwd))));
}
{
  const cwd = mkproj("active-plan", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
    const d = path.join(root, "docs", "plans");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "p1.md"), "# 某实施计划\n\n**状态**：待实施\n", "utf8");
  });
  const c = ctx(run(cwd));
  check("活跃 plan（状态：待实施）→ 报出", /Plan \[p1\.md\]/.test(c), "ctx=" + c.slice(0, 300));
  check("plan 报文取 markdown 标题", /某实施计划/.test(c));
}
{
  const cwd = mkproj("done-plan", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
    const d = path.join(root, "docs", "plans");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "p2.md"), "# 已完成计划\n\n**状态**：已完成\n", "utf8");
  });
  check("负控：状态=已完成 → 不报活跃 plan", !/Plan \[/.test(ctx(run(cwd))));
}

console.log("\n=== 健壮性：坏 stdin 不许崩 ===");
{
  const r = spawnSync(process.execPath, [HOOK], {
    input: "这不是 JSON{{{",
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      HOME: FAKE_HOME,
      DAO_SETTINGS_DRIFT_STATE_DIR: path.join(SANDBOX, "drift-state"),
      DAO_SETTINGS_DRIFT_SELFTEST: "1",
    }),
  });
  // 坏 stdin ⇒ input={} ⇒ cwd 落回 process.cwd()（本仓），走元仓库或普通项目分支皆可，
  // 唯一硬要求是不崩、退出码 0（SessionStart 只增不阻）
  check("坏 stdin → exit 0 不崩", r.status === 0, "code=" + r.status + " err=" + (r.stderr || "").slice(0, 200));
}

// ── 清理 ────────────────────────────────────────────────────────────────────
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
