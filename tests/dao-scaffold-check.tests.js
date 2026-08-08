// dao-scaffold-check 两态自证 · 单元级（喂 SessionStart 形态 JSON → 断言 stdout）
//
// 跑法：node tests/dao-scaffold-check.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 验的是哪一层：**双模式分派 + 各条结构判据的两态 + hook 注册检测器的扩展名盲区
// + 共性 rule 备案清单真的在驱动 hook（换清单即换行为）**。
// 它证明「有缺陷即报出对应条目 / 缺陷补齐即不再报 / 非 git 目录完全静默」，
// **不证明** 注入的提醒真被宿主投递给模型。
//
// ⚠ 模式 B 的结构判据断言（CLAUDE.md/rules 目录/冗余入口/桌面端基建…）现在验的是
// **真实 ccswitch/scaffold-manifest.json 的内容**——那些检查项 2026-07-27 已从本 hook
// 的代码里搬进清单。清单删条目会让对应断言变红，这是有意的：清单是承重件，不是配置糖。
// 清单本身的 schema 校验与谓词求值两态另见 tests/scaffold-manifest.tests.js。
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
// ── 行尾：本文件里的 mutation 锚点为什么写 `\r?\n`（2026-08-06 订正一处实证）──────
// **结论不变，但 PR #130 给的那条实证是假的**，别再照它推。那份 PR body 写着
// 「本仓两个文件行尾不同：hook 是 CRLF、lib 是 LF」——本机复测（数字节，不看工具报告）：
//   工作树  dao-scaffold-check.js CRLF=1095 bareLF=0 ；hook-budget.js CRLF=325 bareLF=0
//   对象库  两份都是 bareLF（`core.autocrlf=true`，签出时统一转 CRLF）
// ⇒ **两份工作树都是 CRLF，不存在「两个文件不同」这回事。**
// 写 `\r?\n` 的真理由是**跨检出可移植**：同一个 commit 在 autocrlf 关掉的机器上签出即是 LF，
// 锚点写死任一种都会在另一种检出上恒不命中 —— 而「锚点没命中所以变异体==原文所以守卫绿」
// 与「守卫真的没塌陷」逐字节相同（dao-guard-writing #守-锚点行尾）。
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
// issue #140 的自适应预算校准要用到收尾余量常量——从真模块读，不在本文件另写一份
// （另写一份就是「两个文件里互不知情的两个数」，issue #127 那个病本身）。
const { DEFAULT_RESERVE_MS } = require("../ccswitch/lib/hook-budget");

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

// 元仓库识别的**第二个信号**（2026-08-01）：内容签名 ccswitch/dao.md + ccswitch/scaffold-manifest.json。
// 造一个**目录名故意不叫 windsurf-dao** 的沙箱，用来钉住「worktree 里模式 A 也要跑」。
// `withSignature=false` 即误伤负控：同样的怪名字、但没有签名文件 ⇒ 必须仍判为普通项目。
function mkMetaWorktree(tag, withSignature) {
  const root = path.join(SANDBOX, "meta", tag, "windsurf-dao-wt-" + tag);
  fs.mkdirSync(path.join(root, "ccswitch", "hooks"), { recursive: true });
  putFakeGit(root);
  if (withSignature) {
    fs.writeFileSync(path.join(root, "ccswitch", "dao.md"), "# fixture dao\n", "utf8");
    fs.writeFileSync(path.join(root, "ccswitch", "scaffold-manifest.json"), '{"entries":[]}', "utf8");
  }
  return root;
}

// 造一棵「lib 坏掉」的 hook 树：把 hook 与 ccswitch/lib/*.js 原样拷进沙箱，再对
// 沙箱那份 hook-budget.js 下手（删掉 / 写成语法错）。**不碰真仓库任何文件。**
// 拷 lib 整目录是因为那几个 lib 只 require node 内置模块（实测：fs/os/path/child_process），
// 拷过去即可独立跑；hook 里的 `require("../lib/…")` 按**文件所在目录**解析，故这份副本生效。
// `mutateHook`（2026-08-06 · issue #147 账 3）：同一手法也用来动**沙箱那份 hook 副本**
// —— 验「未预期崩溃」那张网时要往 hook 里注入一个 throw，而它必须落在副本上，
// 真仓库那份一个字节都不许动。
function mkBrokenLibTree(tag, mutate, mutateHook) {
  const root = path.join(SANDBOX, "brokenlib", tag);
  const hooksDir = path.join(root, "ccswitch", "hooks");
  const libDir = path.join(root, "ccswitch", "lib");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  const hookCopy = path.join(hooksDir, path.basename(HOOK));
  fs.copyFileSync(HOOK, hookCopy);
  const realLib = path.join(REPO, "ccswitch", "lib");
  for (const f of fs.readdirSync(realLib).filter((n) => n.endsWith(".js"))) {
    fs.copyFileSync(path.join(realLib, f), path.join(libDir, f));
  }
  if (mutate) mutate(path.join(libDir, "hook-budget.js"));
  if (mutateHook) mutateHook(hookCopy);
  return hookCopy;
}

// 造一棵「hook 副本，lib 完整可用，且不制造额外 I/O 噪音」的树（issue #140 用）。
// 与 `mkBrokenLibTree` 的差别：那个helper 只拷 `ccswitch/lib/*.js`，够用于「lib 坏了」
// 那组测试，但 `settings-drift.js` 会用 `__dirname` 反推出「仓根」再去读
// `config-sync/{common/settings.json,lib/{paths,secrets}.mjs}`——那棵树上这三个文件
// 不存在时它会走**真实的** ENOENT 分支（多次 fs 调用 + 失败），吃掉一截真实时间，
// 对本组「预算是否精确卡在阈值附近」的断言是噪音。这里额外把那三个小文件也搬过去，
// 让 settings-drift 在这棵沙箱树上和在真实仓库里一样快地"查到"（内容是真仓库当下的快照，
// 谁的快照不重要——这组测试不断言 settings-drift 那几行的内容）。
function mkTimingCleanHookCopy(tag, mutateHook) {
  const root = path.join(SANDBOX, "timingclean", tag);
  const hooksDir = path.join(root, "ccswitch", "hooks");
  const libDir = path.join(root, "ccswitch", "lib");
  const csCommonDir = path.join(root, "config-sync", "common");
  const csLibDir = path.join(root, "config-sync", "lib");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(csCommonDir, { recursive: true });
  fs.mkdirSync(csLibDir, { recursive: true });
  const hookCopy = path.join(hooksDir, path.basename(HOOK));
  fs.copyFileSync(HOOK, hookCopy);
  const realLib = path.join(REPO, "ccswitch", "lib");
  for (const f of fs.readdirSync(realLib).filter((n) => n.endsWith(".js"))) {
    fs.copyFileSync(path.join(realLib, f), path.join(libDir, f));
  }
  fs.copyFileSync(path.join(REPO, "config-sync", "common", "settings.json"), path.join(csCommonDir, "settings.json"));
  fs.copyFileSync(path.join(REPO, "config-sync", "lib", "paths.mjs"), path.join(csLibDir, "paths.mjs"));
  fs.copyFileSync(path.join(REPO, "config-sync", "lib", "secrets.mjs"), path.join(csLibDir, "secrets.mjs"));
  if (mutateHook) mutateHook(hookCopy);
  return hookCopy;
}

function run(cwd, extraEnv, hookPath) {
  const payload = JSON.stringify({
    session_id: "knifeF-scaffold",
    transcript_path: "C:/fake/transcript.jsonl",
    cwd,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  const r = spawnSync(process.execPath, [hookPath || HOOK], {
    input: payload,
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      HOME: FAKE_HOME,                                              // ③ 受控 settings
      DAO_SETTINGS_DRIFT_STATE_DIR: path.join(SANDBOX, "drift-state"), // ④ 心跳重定向
      DAO_SETTINGS_DRIFT_SELFTEST: "1",                             // ④ 强制 synthetic
    }, extraEnv || {}),
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
console.log("\n=== 元仓库不再整体豁免：A 段 + B 段同时跑，例外走 exempt（两态）===");
// 2026-07-27 裁定 B。原行为：仓名 === windsurf-dao ⇒ 跑完同步漂移就 done()，
// 清单一条不查 ⇒ 检查从不跑到立法者头上。若哪天有人把早退加回来，下面
// 「元仓库也报清单缺项」会立刻变红。
// exempt 那两条用的是**真实清单**：它同时证明 ①元仓库确实在跑 B 段
// ②AGENT_GUIDE.md 这条被数据层的 exempt 挡住，而不是被整体豁免挡住。
{
  // 这个沙箱刻意同时具备两段的素材：①一个未注册 hook ⇒ A 段有内容
  // ②只有 ccswitch/hooks/* ⇒ 必然缺 CLAUDE.md 与 .claude/rules/ ⇒ B 段有内容。
  // 两段必须出现在**同一次注入**里——原实现的 A 段是 inject()+exit(0)，
  // 有漂移时 B 段永远到不了；这条断言正是那个早退的守卫。
  const cwd = mkMetaRepo("also-runs-manifest", [`${REGISTERED}.js`, "dao-knifef-unregistered.js"]);
  const c = ctx(run(cwd));
  check("元仓库也跑清单：缺 CLAUDE.md 被报出（早退加回来即变红）",
    /缺少 CLAUDE\.md/.test(c), "ctx=" + c.slice(0, 400));
  check("元仓库也跑清单：缺 .claude/rules/ 被报出", /缺少 \.claude\/rules\//.test(c));
  check("A 段与 B 段并存于同一次注入（有漂移时 B 段不再被 A 段的 inject+exit 抢走）",
    /Hook 未注册/.test(c) && /dao 同步漂移检测/.test(c) && /dao 脚手架检查/.test(c),
    "ctx=" + c.slice(0, 500));
}
{
  const cwd = mkMetaRepo("exempt-agent-guide", [`${REGISTERED}.js`]);
  fs.writeFileSync(path.join(cwd, "AGENT_GUIDE.md"), "元仓库刻意保留\n", "utf8");
  const c = ctx(run(cwd));
  check("元仓库有 AGENT_GUIDE.md → 被 exempt 挡住，不报冗余入口",
    !/冗余 AI 入口 AGENT_GUIDE/.test(c), "ctx=" + c.slice(0, 400));
  check("负控（同一次运行）：exempt 只豁免那一条，缺 CLAUDE.md 照报",
    /缺少 CLAUDE\.md/.test(c), "ctx=" + c.slice(0, 400));
}
{
  // exempt 的范围两态：同样叫别的名字的仓库放同一个文件 → 必须照报。
  // 只验「元仓库不报」挡不住 exempt 写错范围（那会让该规则对所有项目静默失效）。
  const cwd = mkproj("not-the-meta-repo", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
    fs.writeFileSync(path.join(root, "AGENT_GUIDE.md"), "冗余入口\n", "utf8");
  });
  check("普通仓有 AGENT_GUIDE.md → 照报（exempt 不越界到别的仓）",
    /冗余 AI 入口 AGENT_GUIDE/.test(ctx(run(cwd))));
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 模式 A · worktree 也必须被认成元仓库（内容签名，两态）===");
// 2026-08-01 修的漏判：原判据只有 `path.basename(cwd) === "windsurf-dao"`，
// 于是 **任何 worktree**（windsurf-dao-wt-xxx）都判不出元仓库 ⇒ 模式 A 整块静默跳过，
// 而输出与「跑了且没问题」一模一样。判别锚点取「条款库结构闸」那一行：沙箱里没有
// ccswitch/scripts/check-clauses-structure.ps1，模式 A 必然报「脚本不在」，模式 B 必然不报。
{
  const withSig = mkMetaWorktree("sig", true);
  check("worktree 名（非 windsurf-dao）+ 内容签名 → 走模式 A（报出条款闸缺脚本）",
    /条款库结构闸脚本不在/.test(ctx(run(withSig))));

  const noSig = mkMetaWorktree("nosig", false);
  const noSigCtx = ctx(run(noSig));
  check("误伤负控：同样的怪目录名、但无签名文件 → 仍是普通项目（不报条款闸）",
    !/条款库结构闸/.test(noSigCtx));

  // 正向保底：老判据没被换掉（取或不是取代）——目录名叫 windsurf-dao 的仍走模式 A。
  check("回归：目录名 windsurf-dao 但无签名文件 → 仍走模式 A",
    /条款库结构闸脚本不在/.test(ctx(run(mkMetaRepo("orsignal", [])))));
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

// ── Wails 指纹（2026-08-02 补）· 三态 ───────────────────────────────────────
// 为什么必须三态而不是一态：只验「有 wails 就报」挡不住判据被放宽——一个忽略 go.mod
// 内容、见 go.mod 就当桌面端的实现同样能让第一条通过，而那会把每个 Go 后端仓都报一遍
// （噪音训练人忽略整个 hook 的输出，正是本清单头注点名要避免的失败方向）。
// 第三态钉 label：报文得说得出「是哪一路信号命中的」，否则人拿到报文不知道该去查什么。
{
  const cwd = mkproj("wails-app", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
    fs.writeFileSync(path.join(root, "go.mod"),
      "module example.com/app\n\ngo 1.22\n\nrequire github.com/wailsapp/wails/v2 v2.9.1\n", "utf8");
    // 刻意不给 package.json：Wails 的前端 package.json 在 frontend/ 而非仓根，
    // 这也顺带钉住 desktop-dev-debug-script 的 not(file package.json) 那一路会放行。
  });
  const c = ctx(run(cwd));
  check("Wails 项目（go.mod 含 wailsapp/wails）缺 desktop-debugging.md → 报出",
    /desktop-debugging\.md/.test(c), "ctx=" + c.slice(0, 400));
  check("报文标明框架为 Wails（label 走的是 go.mod 那一路，不是 Tauri/Electron）",
    /Wails 桌面端项目/.test(c), "ctx=" + c.slice(0, 400));
  check("Wails 仓无仓根 package.json → 不报缺 dev:debug 脚本（刻意的漏报侧：无 npm 脚本面）",
    !/dev:debug 脚本/.test(c), "ctx=" + c.slice(0, 400));
}
{
  const cwd = mkproj("plain-go", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
    fs.writeFileSync(path.join(root, "go.mod"),
      "module example.com/svc\n\ngo 1.22\n\nrequire github.com/go-chi/chi/v5 v5.0.0\n", "utf8");
  });
  check("负控：普通 Go 仓（go.mod 无 wails）→ 不触发桌面端判据（判据不是「有 go.mod」）",
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

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 模式 B · 清单真的在驱动 hook（换清单即换行为）===");
// 上面所有模式 B 断言用的都是**真实** ccswitch/scaffold-manifest.json。这一组换成
// 构造的假清单（DAO_SCAFFOLD_MANIFEST 指路），证明 hook 报什么完全由清单决定——
// 同一个项目目录，清单里有该条目就报、删掉就不报。这是「清单驱动」这句话的机器证据；
// 若哪天有人把检查项写回 hook 代码里，本组会立刻变红。
{
  const proj = mkproj("manifest-driven", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
    fs.mkdirSync(path.join(root, "src-ui"), { recursive: true });
  });
  const withEntry = path.join(SANDBOX, "mf-with.json");
  const withoutEntry = path.join(SANDBOX, "mf-without.json");
  const probeEntry = {
    id: "probe-frontend", class: "conditional",
    when: { anyOf: [{ dir: "src-ui", label: "前端" }] },
    require: { file: ".claude/rules/probe-style.md" },
    msg: "{label}项目缺少探针 rule PROBE-MARKER",
    why: "测试夹具", severity: "warn",
  };
  const infoEntry = {
    id: "probe-info", class: "universal",
    require: { file: "NOPE-INFO.md" },
    msg: "INFO-MARKER 这是近似判据",
    why: "测试夹具", severity: "info",
  };
  fs.writeFileSync(withEntry, JSON.stringify({ entries: [probeEntry, infoEntry] }), "utf8");
  fs.writeFileSync(withoutEntry, JSON.stringify({ entries: [infoEntry] }), "utf8");

  const cWith = ctx(run(proj, { DAO_SCAFFOLD_MANIFEST: withEntry }));
  const cWithout = ctx(run(proj, { DAO_SCAFFOLD_MANIFEST: withoutEntry }));
  check("清单含该条目 → 报出（含 {label} 渲染）",
    /前端项目缺少探针 rule PROBE-MARKER/.test(cWith), "ctx=" + cWith.slice(0, 300));
  check("同一项目、清单删掉该条目 → 不报（证明检查项来自清单不是代码）",
    !/PROBE-MARKER/.test(cWithout), "ctx=" + cWithout.slice(0, 300));
  check("severity=info → 报文带「（建议）」前缀",
    /（建议）INFO-MARKER/.test(cWith), "ctx=" + cWith.slice(0, 300));
  check("severity=warn → 报文不带「（建议）」前缀",
    !/（建议）前端项目缺少探针/.test(cWith), "ctx=" + cWith.slice(0, 300));
  check("负控：真实清单下不出现测试探针条目",
    !/PROBE-MARKER/.test(ctx(run(proj))), "ctx=" + ctx(run(proj)).slice(0, 300));
}
{
  // 加载失败必须响：坏清单不能让 hook 静默变成"什么都不查"
  const proj = mkproj("manifest-broken", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
  });
  const bad = path.join(SANDBOX, "mf-bad.json");
  fs.writeFileSync(bad, "{ 这不是 JSON", "utf8");
  const c = ctx(run(proj, { DAO_SCAFFOLD_MANIFEST: bad }));
  check("坏清单 → 报出加载失败行（不静默吞成零缺项）",
    /共性 rule 备案清单/.test(c) && /解析失败/.test(c), "ctx=" + c.slice(0, 300));

  const invalid = path.join(SANDBOX, "mf-invalid.json");
  fs.writeFileSync(invalid, JSON.stringify({ entries: [{ id: "x", class: "个性", require: { file: "a" }, msg: "m", why: "w" }] }), "utf8");
  const c2 = ctx(run(proj, { DAO_SCAFFOLD_MANIFEST: invalid }));
  check("清单 class 非法（个性 rule 混进来）→ 报出校验错误",
    /class 非法/.test(c2), "ctx=" + c2.slice(0, 300));
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== per-provider 漂移那一行的措辞（末行 → 提醒行，issue #50 / #56）===");
// **为什么用 stub 而不是让它跑真的检查器**：`providerHookLines(daoRoot)` 里的 daoRoot
// 就是 payload 的 cwd ⇒ 元仓库沙箱里放一份假的 `ccswitch/lib/settings-drift.js`，
// 整条路径（spawn → 末行正则 → 措辞拼装）都被真的走了一遍，而结果**与本机 cc-switch DB
// 此刻的状态无关**。真 DB 那一路由 tests/provider-hooks-drift.tests.js 的端到端层负责。
//
// **为什么这一组非有不可**：hook 侧那个末行正则是**独立于 settings-drift 的第二份实现**
//（刻意的：契约被改坏时它要能报出来，共用解析就一起瞎）。独立的代价是它自己没人验——
// 2026-08-02 一次 mutation 实测：把 deny 分支整个删掉（`if (false)`），
// provider-hooks-drift 那套 54 条断言**一条都没红**。这一组补的就是那个洞。
{
  const mkStub = (tag, stdout, exitCode) => {
    const root = path.join(SANDBOX, "meta", tag, "windsurf-dao");
    fs.mkdirSync(path.join(root, "ccswitch", "hooks"), { recursive: true });
    fs.mkdirSync(path.join(root, "ccswitch", "lib"), { recursive: true });
    putFakeGit(root);
    // stub：把预设文本原样吐出来再按预设码退出。刻意不 require 任何东西。
    fs.writeFileSync(path.join(root, "ccswitch", "lib", "settings-drift.js"),
      "process.stdout.write(" + JSON.stringify(stdout) + ");\nprocess.exit(" + exitCode + ");\n", "utf8");
    return root;
  };
  const SUM = (o) => "PROVIDER_HOOKS_SUMMARY exit=" + o.exit + " providers=13 scoped=2 drift=" + o.drift +
    " cross=" + o.cross + " selfcheck=" + (o.self || "ok") + " uncheckable=" + (o.unch || 0) +
    " denyDrift=" + o.denyDrift + " denyCross=" + o.denyCross + " denySampled=" + o.sampled + "\n";

  // ① 全绿：两个面都要在那一行里各说一句（deny 面绿了却不出声＝那一面在报文里不存在）
  {
    const c = ctx(run(mkStub("pp-green", SUM({ exit: 0, drift: 0, cross: 0, denyDrift: 0, denyCross: 0, sampled: 1 }), 0)));
    check("绿·一行里同时报出 hooks 面与 deny 面（不许 deny 绿了却只字不提）",
      /per-provider 漂移检查绿/.test(c) && /deny 规则逐条一致/.test(c), "ctx=" + c.slice(0, 400));
  }
  // ② **只有 deny 漂了**：这是 M9 mutation 抓出来的那一格。措辞必须点 permissions.deny，
  //    且**不许**说「hooks 段已经不一致了」——那是一句错话，会把人支去查错的东西。
  {
    const c = ctx(run(mkStub("pp-deny", "    · [Beta [p2]] ⬇ canonical 有 / provider 无：permissions.deny 少 Bash(grep:*)\n" +
      SUM({ exit: 1, drift: 0, cross: 0, denyDrift: 1, denyCross: 1, sampled: 1 }), 1)));
    check("只有 deny 漂移 → 点名 permissions.deny 且说出后果（护栏放行）",
      /permissions\.deny/.test(c) && /放行/.test(c), "ctx=" + c.slice(0, 500));
    check("只有 deny 漂移 → **不许**说成「hooks 段不一致」（分面陈述，不说错话）",
      !/hooks\*{0,2} 段已经不一致/.test(c), "ctx=" + c.slice(0, 500));
    check("只有 deny 漂移 → 明细行仍被带出来（不只报计数）",
      /Bash\(grep:\*\)/.test(c), "ctx=" + c.slice(0, 500));
  }
  // ③ 反向：只有 hooks 漂了 ⇒ 不许把 deny 也说成漂了
  {
    const c = ctx(run(mkStub("pp-hooks", SUM({ exit: 1, drift: 2, cross: 1, denyDrift: 0, denyCross: 0, sampled: 1 }), 1)));
    check("只有 hooks 漂移 → 说 hooks，且**不许**顺带说 permissions.deny 也漂了",
      /hooks/.test(c) && !/permissions\.deny/.test(c), "ctx=" + c.slice(0, 500));
  }
  // ④ 末行没有 deny 三字段（lib 比本 hook 旧）⇒ 如实说「那一面没被报出来」，
  //    **不许**报成「契约被改坏了」（那是假的红），也不许静默当成绿。
  {
    const old = "PROVIDER_HOOKS_SUMMARY exit=0 providers=13 scoped=2 drift=0 cross=0 selfcheck=ok uncheckable=0\n";
    const c = ctx(run(mkStub("pp-old", old, 0)));
    check("末行缺 deny 字段 → 出声「那一面本次没被报出来」，不假报契约损坏、也不静默",
      /没有 deny 面字段|没被报出来/.test(c) && !/契约可能被改坏/.test(c), "ctx=" + c.slice(0, 400));
  }
  // ⑤ deny 面零样本 ⇒ 绿行里必须点出「什么都没比到」，不许读成「已对齐」
  {
    const c = ctx(run(mkStub("pp-nosample", SUM({ exit: 0, drift: 0, cross: 0, denyDrift: 0, denyCross: 0, sampled: 0 }), 0)));
    check("deny 零样本 → 绿行里点出「什么都没比到（不是已对齐）」",
      /零样本/.test(c) && /不是「已对齐」/.test(c), "ctx=" + c.slice(0, 400));
  }
  // ⑥ 没查成（exit 2）⇒ 必须说两个面都没查成，而不是只提 hooks
  {
    const c = ctx(run(mkStub("pp-unch", SUM({ exit: 2, drift: 0, cross: 0, denyDrift: 0, denyCross: 0, sampled: 1, unch: 1 }), 2)));
    check("exit 2 没查成 → 明说 hooks 与 permissions.deny 两面都没查成",
      /没查成/.test(c) && /permissions\.deny/.test(c), "ctx=" + c.slice(0, 400));
  }
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 墙钟预算：预算见底时明说「没跑」，而不是被宿主静默杀掉（issue #127）===");
// **这一组验的是端到端那一半**：hook-budget 模块自己的算术由 tests/hook-budget.tests.js
// 夹住，这里只夹「接线真的接上了」——预算收窄之后，报文里必须出现具名的「没跑」行，
// 且进程必须**自己走完并退出 0**（而不是拖到宿主开刀）。
//
// 为什么非有这一组不可：模块单测全绿完全兼容「hook 压根没 require 它」。
// 2026-08-02 本仓刚有过同型实证（hook 侧那个末行正则是独立第二实现，把 deny 分支
// 整个删掉、provider-hooks-drift 那 54 条断言一条都没红）。
{
  const cwd = mkMetaRepo("budget-tight", [`${REGISTERED}.js`]);
  // 条款闸那一路会**先查脚本在不在**，不在就走「脚本不在」那条早退路径、根本到不了预算判断。
  // 所以这里放一个存在但永不被执行的空脚本 —— 要验的是预算把它拦在起跑前，
  // 不是「文件缺失」这个另一件事。（若不放，本组会以「passed for the wrong reason」全绿。）
  fs.mkdirSync(path.join(cwd, "ccswitch", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "ccswitch", "scripts", "check-clauses-structure.ps1"),
    "# 夹具：预算够的话才会跑到这里\n", "utf8");

  // ① 收窄到 1600 ms（扣掉 1500 ms 收尾余量后余量已 ≈0）⇒ 五道 spawn 类检查全部该被跳过
  const tight = run(cwd, { DAO_HOOK_BUDGET_MS: "1600" });
  const ct = ctx(tight);
  check("预算收窄 → 报出具名的「没跑」行（不是静默少几行）",
    /\*\*没跑\*\*/.test(ct), "ctx=" + ct.slice(0, 500));
  check("「没跑」行明说这不是通过（本批全部意义所在）",
    /不是「通过」/.test(ct) && /没测/.test(ct), "ctx=" + ct.slice(0, 500));
  check("五道 spawn 类检查逐项点名（条款闸/死闸/字节预算/per-provider/memory）",
    /条款库结构闸的 \d+\/\d+ 个被检文件[^\n]*\*\*没跑\*\*/.test(ct) && /死闸检测 \*\*没跑\*\*/.test(ct) &&
    /always-on 字节预算闸 \*\*没跑\*\*/.test(ct) && /per-provider 漂移检查 \*\*没跑\*\*/.test(ct) &&
    /memory 指针扫描 \*\*没跑\*\*/.test(ct), "ctx=" + ct.slice(0, 900));
  check("预算收窄下仍自己退出 0（降级不是崩溃）", tight.code === 0, "code=" + tight.code);
  // issue #140：本轮一份都没跑成时，跳过行必须**明说零样本**，不能含糊带过
  // （零样本时「假降级/真降级」这个问题本来就答不出，明说比模糊更诚实）。
  check("🔴 issue #140：条款闸零样本时明说「本次零样本」，不假装能判断真假降级",
    /条款库结构闸的[^\n]*本次零样本：一次都没跑成，无从判断真假/.test(ct), "ctx=" + ct.slice(0, 700));
  // 🔴 2026-08-05：5 → 6，多出来的那一项是 git（对抗验证 A3）。
  // 原先 5 处 git 调用各自 `catch (_) {}`：预算见底时它们被 capFor 夹成 1 ms、当场 SIGTERM，
  // 而异常被吞 ⇒ 报文里那几行（「⬆ 领先 origin N 个提交」之类）**整行消失，全文没有一处
  // 说 git 没跑**。五道 spawn 检查会喊，那五处不会 —— 本批自己新开的静默面，与本 issue 同型。
  check("汇总行报出跳过项数（6 = 五道 spawn 检查 + git 那一笔）",
    /本次跳过 6 项/.test(ct), "ctx=" + ct.slice(0, 600));
  check("🔴 A3：git 也被点名「没跑」，不再静默少几行",
    /git 状态查询/.test(ct) && /\*\*没跑\*\*/.test(ct), "ctx=" + ct.slice(0, 900));
  check("🔴 A3：点名点到具体是哪几次 git 查询（不是一句笼统的「git 没跑」）",
    /未提交改动/.test(ct) && /落后 origin/.test(ct) && /领先 origin/.test(ct), "ctx=" + ct.slice(0, 900));

  // ② 反向语料：不收窄（走 fallback 的 10 s）⇒ 一条「没跑」都不许有。
  //    只验①挡不住一个**恒报没跑**的实现，而那种实现会把每次会话的检查全废掉。
  const loose = run(cwd);
  const cl = ctx(loose);
  check("反向：预算充足 → 零「没跑」行（钉住它真的在比余量，不是恒跳过）",
    !/\*\*没跑\*\*/.test(cl), "ctx=" + cl.slice(0, 600));
  check("反向：预算充足 → 汇总行报「跳过 0 项」", /本次跳过 0 项/.test(cl), "ctx=" + cl.slice(0, 600));
  // 🔴 A3 的负控，也是那个「只报被预算夹死的」判据的判别力所在：
  // 这个沙箱的 `.git` 是一个垃圾文件，所以**这三次 git 是真的失败了**（fatal，status=128，
  // 本机实测 signal=null、code=undefined），只是**不是被预算夹死的**。
  // 它一行都不许报 —— 否则每个没有 origin / 不是仓库的项目都会被这道播报刷屏，
  // 而噪音会训练人忽略整个 hook 的输出。
  check("🔴 A3 负控：git 真失败但不是预算致死（垃圾 .git）→ 零「git 状态查询…没跑」行",
    !/git 状态查询/.test(cl), "ctx=" + cl.slice(0, 700));
  check("汇总行每次都打印余量数字（成本只增不减，增长必须看得见）",
    /hook 墙钟预算/.test(cl) && /余量 -?\d+ ms/.test(cl), "ctx=" + cl.slice(0, 600));

  // ③ 找不到自己的注册时必须**说出来**：假家目录里注册的是别的 hook 名。
  //    「猜了一个总预算」与「读到了真的总预算」在报文上必须分得开。
  check("注册读不到 → 报文明说「这个总预算是猜的」",
    /总预算是猜的/.test(cl), "ctx=" + cl.slice(0, 700));

  // 🔴 ⑥/A4：内层常量自检的门限是**有效截止线**，报文必须把那个数原样打出来 ——
  // 否则读者复核不了「为什么 30000 在 30 秒预算下仍算够不着」。
  // 这一路的总预算是 fallback 10000，扣 1500 收尾余量 ⇒ 有效截止线 8500。
  check("🔴 内层常量自检报「有效截止线」而不是「总预算」，且把 8500 这个数打出来",
    /有效截止线 8500 ms/.test(cl) && /总预算 10000 - 收尾余量 1500/.test(cl), "ctx=" + cl.slice(0, 900));
  check("🔴 五个够不着的内层常量逐个点名（20000/30000 那五个）",
    /CLAUSE_CHECK_TIMEOUT_MS=20000ms/.test(cl) && /DEAD_GATES_TIMEOUT_MS=30000ms/.test(cl) &&
    /BUDGET_TIMEOUT_MS=20000ms/.test(cl) && /PROVIDER_HOOKS_TIMEOUT_MS=30000ms/.test(cl) &&
    /MEMORY_REFS_TIMEOUT_MS=20000ms/.test(cl), "ctx=" + cl.slice(0, 900));
  check("🔴 活的负控：GIT_TIMEOUT_MS=5000 够得着（5000 < 8500）⇒ 永远不该出现在那一行里",
    !/GIT_TIMEOUT_MS=5000ms/.test(cl), "ctx=" + cl.slice(0, 900));

  // ④ 收窄阀只准调小：给一个比真实注册大得多的值，不许把预算撑大。
  //    否则这个环境变量就成了「让 hook 谎报余量」的后门，而谎报余量正是本批要治的病。
  const huge = run(cwd, { DAO_HOOK_BUDGET_MS: "999000" });
  const chu = ctx(huge);
  check("DAO_HOOK_BUDGET_MS 只准调小：给 999000 仍按 10000 算（不是后门）",
    /宿主给 10000 ms/.test(chu) && !/宿主给 999000 ms/.test(chu), "ctx=" + chu.slice(0, 600));
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 降级排序：便宜的原子项排在贵的条款闸之前（issue #141）===");
{
  // 对抗验证官量过：条款闸一份文件 ~600ms，后四道原子项合计 ~368ms（139+48+116+65）。
  // 旧顺序把条款闸排第一，预算见底时它先吃掉大头，逼得后四道一起被拦下 ⇒ 用 368ms
  // 换 600ms，换掉的是「四项检查全部消失」。这里只钉住**结构性事实**（谁的调用点在源码里
  // 排在谁前面），不去踩「预算收窄到某个中间值时具体谁被跳过」那个中间态——
  // 那个中间态强依赖真实 PowerShell 冷启动耗时，本文件其它地方的注释也点过这个坑，
  // 换成源码位置断言就不随机器速度飘。
  const src = fs.readFileSync(HOOK, "utf8");
  const posClause = src.indexOf("for (const line of clauseStructureLines(daoRoot)) drifts.push(line);");
  const posDead = src.indexOf('runWithinBudget("死闸检测"');
  const posBudget = src.indexOf('runWithinBudget("always-on 字节预算闸"');
  const posProvider = src.indexOf('runWithinBudget("per-provider 漂移检查"');
  const posMemory = src.indexOf('runWithinBudget("memory 指针扫描"');
  check("五个锚点都找到了（找不到就是本条自己失效，不是「通过」）",
    posClause > -1 && posDead > -1 && posBudget > -1 && posProvider > -1 && posMemory > -1,
    JSON.stringify({ posClause, posDead, posBudget, posProvider, posMemory }));
  check("🔴 issue #141：死闸检测排在条款闸之前", posDead < posClause, `dead=${posDead} clause=${posClause}`);
  check("🔴 issue #141：always-on 字节预算闸排在条款闸之前", posBudget < posClause, `budget=${posBudget} clause=${posClause}`);
  check("🔴 issue #141：per-provider 漂移检查排在条款闸之前", posProvider < posClause, `provider=${posProvider} clause=${posClause}`);
  check("🔴 issue #141：memory 指针扫描排在条款闸之前", posMemory < posClause, `memory=${posMemory} clause=${posClause}`);
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 条款闸降级报文带「本次实测单次耗时」（issue #140 · 有样本一侧）===");
{
  // 这一组是端到端的，真的会起 powershell.exe——耗时数字本身不可预测（冷启动随机器浮动，
  // 且**同一台机器在同一个会话里也会漂**：本条早期版本写死过一个"历史实测 350–770ms"
  // 推出来的预算值，连续 4 次通过后、系统负载一变就连续落空——这正是本条自己想避免的
  // 那类"写死窗口迟早被撞穿"）。改法：**先自适应校准**，用这台机器、这一刻的真实耗时
  // 推算预算，不用任何写死的历史数字。下面只断言**格式**与**内部逻辑一致性**
  // （判断结论与它自己报出的两个数字是否吻合），不断言具体毫秒数。
  const N_RULES = 6;
  const TOTAL_TARGETS = N_RULES + 1; // + dao.md 本身
  const cwd = mkMetaRepo("clause-sample", [`${REGISTERED}.js`]);
  fs.mkdirSync(path.join(cwd, "ccswitch", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "ccswitch", "scripts", "check-clauses-structure.ps1"), [
    "param([string]$TargetFile, [string]$ClauseSelector)",
    'Write-Output "CLAUSE_STRUCTURE_SUMMARY exit=0 clauses=1 violations=0 notrigger=0 retire=0 promote=0"',
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(cwd, "ccswitch", "dao.md"), "# fixture dao.md（桩脚本不读它，内容无所谓）\n", "utf8");
  fs.mkdirSync(path.join(cwd, "ccswitch", "rules"), { recursive: true });
  for (let i = 0; i < N_RULES; i++) {
    fs.writeFileSync(path.join(cwd, "ccswitch", "rules", `dao-fixture-${i}.md`),
      `- 夹具占位条款 ${i}，供 clauseTargets 判定命中。 [n=1 @08-08 触发:无] [#测试-占位${i}]\n`, "utf8");
  }

  // 全程走 mkTimingCleanHookCopy 的「原样副本」（不是裸用 HOOK）：下面探测出来的
  // `probeBudget` 之后要原样喂给同一手法拷出来的**变异**副本（见本节末尾的 mutation），
  // 两次调用的目录深度、require 解析路径、config-sync 文件是否命中都必须逐字相同，
  // 否则「同一个预算」在两棵不同形状的树上就是两个不同的东西——探测出来的窗口对不上。
  const intactPath = mkTimingCleanHookCopy("clause-sample-intact", null);

  // 校准跑：给一个足够宽松的预算（60s，远超本机任何合理耗时），量出**这次调用**的
  // 真实总耗时。用测试进程自己的 Date.now() 量墙钟时间，不用被测代码自报的
  // `BUDGET.elapsed()`——用被测对象自己算出来的数去校准同一个被测对象的判据，
  // 等于拿同一把尺子量自己（与「守卫自检不能复用被守对象的解析」同一道理）。
  const t0 = Date.now();
  const baseline = run(cwd, { DAO_HOOK_BUDGET_MS: "60000" }, intactPath);
  const baselineWallMs = Date.now() - t0;
  const baselineCtx = ctx(baseline);
  check("校准跑：本机条件下条款闸这次全部跑完（否则下面的预算换算失去基准，且本次机器状态不适合这组测试）",
    baseline.code === 0 && !/条款库结构闸的[^\n]*没跑/.test(baselineCtx),
    "code=" + baseline.code + " ctx=" + baselineCtx.slice(0, 500));

  // 每份文件均摊到的真实成本；下限 50ms 只是防御除出 0 或负数这类荒谬值，不是业务判据。
  const perFileMs = Math.max(50, Math.round(baselineWallMs / TOTAL_TARGETS));

  // 「跑成 1 份、剩下跳过」的那个预算窗口**很窄**（宽度约等于一份文件的真实耗时），
  // 而单次测量分不清「固定开销」与「单份边际成本」各占多少——公式换算实测撞过两次窗口
  // （连续几次通过后，系统负载一变就连续落空）。改法：从「理论上连第一份都起不了步」
  // 的起点开始，以半份文件耗时为步长向上探测，每步都真的跑一次，直到真的落进
  // 「有跑成、也有跳过」的中间态——用真实结果找窗口，不用公式猜窗口。
  const STEP = Math.max(80, Math.round(perFileMs / 2));
  const MAX_PROBES = 14;
  let sample = null, cs = "", m = null, probeBudget = DEFAULT_RESERVE_MS + 1200 - STEP;
  for (let i = 0; i < MAX_PROBES; i++) {
    probeBudget += STEP;
    sample = run(cwd, { DAO_HOOK_BUDGET_MS: String(probeBudget) }, intactPath);
    cs = ctx(sample);
    const probeM = /条款库结构闸的 (\d+)\/(\d+) 个被检文件[^⟨\n]*⟨([^⟩]*)⟩/.exec(cs);
    if (probeM && Number(probeM[1]) > 0 && Number(probeM[1]) < Number(probeM[2])) { m = probeM; break; }
  }
  if (process.env.DAO_DEBUG_DUMP) {
    console.error("DEBUG baselineWallMs=" + baselineWallMs + " perFileMs=" + perFileMs +
      " STEP=" + STEP + " 命中预算=" + probeBudget + (m ? "" : "（未命中）"));
    fs.writeFileSync(path.join(REPO, "_tmp", "debug-cs.txt"), cs, "utf8");
  }
  check("端到端仍能自己退出 0", sample.code === 0, "code=" + sample.code);

  if (!m) {
    // 探测 MAX_PROBES 步仍未落进「部分完成」区间——理论上不该发生（探测步长与探测轮数
    // 是按 perFileMs 换算的，覆盖的预算跨度远超一份文件的耗时波动）。**不静默通过**：
    // 显式报出来，而不是让 check() 悄悄跳过这一组。
    check("🔴 issue #140：探测后仍落在预期的『部分完成』区间内（有样本、也有跳过）",
      false, `探测 ${MAX_PROBES} 步未命中（perFileMs=${perFileMs} STEP=${STEP} 最终预算=${probeBudget}）——` +
      "可能本机条件跳变超出探测范围，可重跑一次——ctx=" + cs.slice(0, 900));
  } else {
    const [, skippedN, totalN, detail] = m;
    check("确有跳过、也确有跑成（否则不会走到「有样本」这条分支）",
      Number(skippedN) > 0 && Number(skippedN) < Number(totalN), `skipped=${skippedN} total=${totalN}`);
    check("🔴 issue #140：详情带「本次实测单次」与样本数（不再只有余量/门槛两个旧数字）",
      /本次实测单次 \d+(?:–\d+)? ms ×\d+/.test(detail), detail);
    const sampleMatch = /本次实测单次 (\d+)(?:–(\d+))? ms ×(\d+)/.exec(detail);
    const leftMatch = /余量 (-?\d+) ms/.exec(cs);
    check("样本区间与余量两个数字都拿到了（判断结论要靠它们对齐）",
      !!sampleMatch && !!leftMatch, JSON.stringify({ sampleMatch, leftMatch }));
    if (sampleMatch && leftMatch) {
      const maxD = Number(sampleMatch[2] || sampleMatch[1]);
      const leftMs = Number(leftMatch[1]);
      const claimsFalse = /假降级/.test(detail);
      const claimsReal = /无法排除真降级/.test(detail);
      check("判断结论恰好二选一（假降级 xor 无法排除真降级），不含糊两可",
        claimsFalse !== claimsReal, detail);
      check("🔴 issue #140：判断结论与它自己报的两个数字逻辑自洽（余量>实测最坏值 ⇔ 断言假降级）",
        claimsFalse === (leftMs > maxD), `left=${leftMs} maxD=${maxD} claimsFalse=${claimsFalse}`);

      // mutation：把「余量 > 实测最坏值 ⇒ 假降级」的判据反过来，确认上面那条「逻辑自洽」
      // 断言真的在验这段判据，不是凑巧算对——沿用同一份夹具与同一个校准出来的预算，
      // 不重新计算（同一时刻的两次调用，机器条件最接近）。
      // 走 mkTimingCleanHookCopy（不是 mkBrokenLibTree）：hook 里 `require("../lib/…")`
      // 按**文件所在目录**解析，裸拷到 SANDBOX 根下会让那些 require 全指向空气；
      // 而 mkBrokenLibTree 虽然拷了 lib，却不带 config-sync/ 三个小文件——settings-drift.js
      // 用 __dirname 反推仓根后找不到它们，会走真实 ENOENT 分支吃掉一截时间，
      // 在这组「预算精确卡阈值」的断言里是噪音（曾实测坑过一版：2/2 全退化成零样本）。
      let anchorHit = false;
      const ANCHOR = "leftMs > maxD";
      const mutantPath = mkTimingCleanHookCopy("clause-sample-invert", (p) => {
        const s = fs.readFileSync(p, "utf8");
        anchorHit = s.split(ANCHOR).length === 2;
        fs.writeFileSync(p, s.replace(ANCHOR, "!(" + ANCHOR + ")"), "utf8");
      });
      check("mutation 锚点在源码里唯一存在", anchorHit, ANCHOR);
      // 变异体是一棵**新**目录树，哪怕手法与 intact 那棵逐字相同，文件系统冷热、
      // 目录项缓存这类噪音仍可能让同一个 probeBudget 在这棵树上刚好落到窗口外一格——
      // 故这里也做小范围重试，而不是只信任 intact 那棵探出来的单一数值。
      let mutSample = null, mutCtx = "", mutDetailMatch = null, mutBudget = probeBudget - STEP;
      for (let i = 0; i < 4; i++) {
        mutBudget += STEP;
        mutSample = run(cwd, { DAO_HOOK_BUDGET_MS: String(mutBudget) }, mutantPath);
        mutCtx = ctx(mutSample);
        const cand = /条款库结构闸的 (\d+)\/(\d+) 个被检文件[^⟨\n]*⟨([^⟩]*)⟩/.exec(mutCtx);
        if (cand && Number(cand[1]) > 0 && Number(cand[1]) < Number(cand[2])) { mutDetailMatch = cand; break; }
      }
      // 捕获组：[0]=全匹配 [1]=跳过数 [2]=总数 [3]=⟨…⟩ 里的详情文本——上一版这里错取了
      // 组[1]（跳过数的字符串）当详情文本用，导致断言永远读不到"无法排除真降级"这几个字，
      // 恒红，且恒红的理由与判据本身对不对无关（是数组下标错位）。
      const mutDetail = mutDetailMatch ? mutDetailMatch[3] : "";
      check("mutation：判据反过来后，同一场景下结论真的翻面了（假降级 ↔ 无法排除真降级）",
        !!mutDetailMatch && /无法排除真降级/.test(mutDetail) && !/假降级/.test(mutDetail),
        "mutBudget=" + mutBudget + " mutCtx=" + mutCtx.slice(0, 900));
      check("mutation：改坏这一处之后仍自己退出 0（不是整个 hook 崩了）",
        mutSample.code === 0, "code=" + mutSample.code);
    }
  }
}
{
  // ⑤ 源码级：**每一处**给子进程设 timeout 的地方都必须走 capFor。
  //
  // 为什么不得不退到读源码：2026-08-04 的 M10 mutation 实测——把其中一处 spawn 的
  // `BUDGET.capFor(DEAD_GATES_TIMEOUT_MS)` 退回裸常量，**一条断言都没红**。
  // 原因是结构性的：预算充足时，夹与不夹跑出来的行为**完全一样**（子进程 139 ms 就回来了），
  // 而要让行为断言看见差别，就得构造一个「子进程恰好跑到预算边界」的环境——那种断言
  // 本身会随机器速度飘。⇒ 行为断言在这一格**结构上失明**，只能扫源码。
  //
  // 它防的是**真实的复发形态**：将来有人加第六道检查、忘了夹（本文件的检查项从 2026-08-01
  // 到 08-02 就长了三道），而那一道会在预算之外静静地跑，把整个 hook 拖过宿主的线。
  //
  // 照直写它的弱处：文本匹配型守护对「注释掉」这类改法天然失明（dao-guard-writing.md
  // 那条讲的就是这个），且它只认 `timeout:` 这个写法——有人换成 `opts.timeout = x` 就绕过去了。
  //
  // 🔴 **2026-08-05 订正自检那一半（对抗验证阻断 2 / dao-guard-writing.md ②）**：
  // 这里原先写的是 `timeoutSites.length > 0`，括号里承诺「扫描面塌陷时这一条先红」——
  // **实测不成立**。对抗验证两臂：A（真违例、扫描正则不动）红 ✓；
  // **B（同样的真违例 + 把扫描正则收窄成只认已夹站点）全绿**，连那条 `> 0` 也 PASS ——
  // 因为剩下的已夹站点仍然满足 `> 0`。**自检那一半复用了被守对象的同一次解析，于是两半一起瞎。**
  //
  // 改法：**分母换成一个独立的第二次普查** —— 用另一个 token、另一条正则去数
  // 「这个文件到底起了几个子进程」（`execFileSync(`），再要求 timeout 站点数不少于它。
  // 这两个数天然应该相等（每个 spawn 恰好带一个 timeout），而**它们错不到一块去**：
  // 收窄 `timeout:` 那条正则不会同时收窄 `execFileSync(` 那条，差额立刻现形。
  const hookSrc = fs.readFileSync(HOOK, "utf8");
  const timeoutSites = hookSrc.match(/timeout:\s*[^,\n\r]+/g) || [];
  const spawnSites = hookSrc.match(/execFileSync\(/g) || [];      // ← 独立分母
  const uncapped = timeoutSites.filter((s) => !/BUDGET\.capFor\(/.test(s));
  check("源码级·自检：独立分母本身没塌（execFileSync( 站点 ≥ 2，本文件不可能只剩一个子进程）",
    spawnSites.length >= 2, "spawn=" + spawnSites.length);
  check("源码级·自检：timeout: 站点数 ≥ 独立数出来的子进程数（扫描面塌陷时这一条先红）",
    timeoutSites.length >= spawnSites.length,
    "timeout=" + timeoutSites.length + " spawn=" + spawnSites.length);
  check("源码级：每一处子进程 timeout 都走 BUDGET.capFor（加新检查忘了夹即变红）",
    uncapped.length === 0, "未夹的：" + JSON.stringify(uncapped));
}
{
  // ⑥ 作用域负控：普通项目（模式 B）不跑那五道 spawn 检查，也就不该出现预算汇总行。
  //    把它印到每个项目里只是噪音，而噪音会训练人忽略整个 hook 的输出。
  const cwd = mkproj("budget-scope", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
  });
  check("负控：普通项目不打印墙钟预算行（只在模式 A 播报）",
    !/hook 墙钟预算/.test(ctx(run(cwd))));
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 🔴 lib 坏掉时不许整批静默消失（issue #127 的病，差点被本批自己复现）===");
// 这一组是 2026-08-05 对抗验证**阻断 1** 的回归网。当时 `require("../lib/hook-budget")`
// 是全文件第一个、且是唯一一个**裸** require（另外两个本地 require 都包着 try/catch，
// 旁边写着「加载失败必须响，不许静默吞」）。同目录、同故障、一带保护一不带的两臂实测：
//   · settings-drift.js 缺失（**有** try/catch）→ exit 0，送出 2208 字，另外六项照跑；
//   · hook-budget.js 缺失或语法错（**没有**）  → exit 1，**stdout 0 字节，七项一起消失**。
// 后者逐字就是这个 issue 的原话。下面三臂 = 两个故障 + 一个活的对照组。
{
  const cwd = mkMetaRepo("brokenlib-meta", [`${REGISTERED}.js`, "dao-brokenlib-probe.js"]);
  const env = { DAO_SCAFFOLD_MANIFEST: path.join(REPO, "ccswitch", "scaffold-manifest.json") };
  // 放一个存在但永不被执行的条款闸脚本：**不放的话，那道检查会走「脚本不在」的早退路径、
  // 根本到不了预算判断** —— 于是「退化预算还在守门吗」这一问会以 passed for the wrong reason
  // 全绿（2026-08-05 mutation 实测：把退化 canAfford 改恒真，断言照样 PASS）。
  fs.mkdirSync(path.join(cwd, "ccswitch", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "ccswitch", "scripts", "check-clauses-structure.ps1"),
    "# 夹具：预算够的话才会跑到这里\n", "utf8");

  // 断言一律钉 `✗ 墙钟预算模块加载失败：` **带 ✗ 前缀的那一行**，不是光秃秃的关键词 ——
  // 关键词在退化预算的 note 里也出现过一次，夹关键词等于什么都没夹（同上，mutation 实测）。
  const LOADFAIL = /✗ 墙钟预算模块加载失败：/;

  // 臂①：模块文件不存在
  const missing = run(cwd, env, mkBrokenLibTree("missing", (p) => fs.rmSync(p)));
  const cm = ctx(missing);
  check("🔴 lib 缺失 → 仍 exit 0（不是 exit 1 + 零输出）", missing.code === 0,
    "code=" + missing.code + " stderr=" + missing.err.slice(0, 200));
  check("🔴 lib 缺失 → 报文非空（agent 拿得到东西，这正是当时炸掉的那一格）",
    cm.length > 0, "len=" + cm.length);
  check("🔴 lib 缺失 → **明说**加载失败了（退化跑与正常跑必须分得开）",
    LOADFAIL.test(cm), "ctx=" + cm.slice(0, 400));
  check("🔴 lib 缺失 → 那一行说得出是哪个模块、退化成了什么（读者能自己复核）",
    /ccswitch\/lib\/hook-budget\.js/.test(cm) && /已退化为保守内置预算/.test(cm), "ctx=" + cm.slice(0, 600));
  check("🔴 lib 缺失 → 其余检查照跑（拿「Hook 未注册」当证据：它与预算模块无关）",
    /dao-brokenlib-probe/.test(cm), "ctx=" + cm.slice(0, 500));

  // 臂②：模块文件在，但是语法错（同步中途、编辑写坏一个括号）
  const broken = run(cwd, env, mkBrokenLibTree("syntax", (p) =>
    fs.writeFileSync(p, "module.exports = {  // 故意不闭合\n", "utf8")));
  const cb = ctx(broken);
  check("🔴 lib 语法错 → 仍 exit 0", broken.code === 0, "code=" + broken.code);
  check("🔴 lib 语法错 → 明说加载失败 + 其余检查照跑",
    LOADFAIL.test(cb) && /dao-brokenlib-probe/.test(cb), "ctx=" + cb.slice(0, 500));

  // 臂③（活的对照组 · 结构上不可能命中上面那条）：同一棵沙箱树，**不动** hook-budget.js。
  // 不带这一臂，上面三条会被一个「恒报加载失败」的实现全绿糊过去。
  const ok = run(cwd, env, mkBrokenLibTree("intact", null));
  const co = ctx(ok);
  check("对照组：沙箱树未动 lib → exit 0 且**零**「加载失败」行（钉住不是恒报）",
    ok.code === 0 && !LOADFAIL.test(co), "code=" + ok.code + " ctx=" + co.slice(0, 300));
  check("对照组：同一棵树上其余检查同样跑得出来（证明这棵沙箱树本身是活的）",
    /dao-brokenlib-probe/.test(co), "ctx=" + co.slice(0, 400));

  // 退化预算必须仍是**保守**的，不是「没有预算」——否则这条退化路就等于把 issue #127
  // 原样放回来。判据：退化态下把预算收窄，**条款闸那一路**（唯一被夹具喂了脚本、
  // 因而真的走到预算判断的那一路）必须被明说跳过。
  // ⚠ 刻意不拿泛泛的 `**没跑**` 当判据：git 那条路会经由**另一个分支**（子进程被
  // SIGTERM 后的 catch）产生同样的字样 ⇒ 一个把 canAfford 改恒真的实现照样能让它出现。
  const degradedTight = run(cwd, Object.assign({ DAO_HOOK_BUDGET_MS: "1600" }, env),
    mkBrokenLibTree("missing-tight", (p) => fs.rmSync(p)));
  const cdt = ctx(degradedTight);
  check("🔴 退化预算仍在真的守门（条款闸被逐文件拦在起跑前，不是放任裸跑）",
    /条款库结构闸的 \d+\/\d+ 个被检文件[^\n]*\*\*没跑\*\*/.test(cdt) && /不是「通过」/.test(cdt),
    "ctx=" + cdt.slice(0, 800));

  // 退化副本的三条承重不变式 —— **源码级**，理由与上面⑤那道守卫逐条相同：
  // 这份副本只在真模块已经坏掉时才走，而「它是不是仍然保守」在报文上观察不到
  // （capFor 的返回值不出现在任何输出里）。弱处照直写：文本匹配对「注释掉」失明。
  const degradedBlock = (() => {
    const src = fs.readFileSync(HOOK, "utf8");
    const a = src.indexOf("function degradedBudgetLib()");
    const b = src.indexOf("let budgetLib, BUDGET_LIB_ERROR");
    return a >= 0 && b > a ? src.slice(a, b) : "";
  })();
  check("源码级·自检：退化块被切出来了（切不出来时下面三条一律先红，而不是空扫全绿）",
    degradedBlock.length > 200 && degradedBlock.includes("capFor"), "len=" + degradedBlock.length);
  check("🔴 退化副本 capFor 下界仍是 1（0 会被 child_process 读成「不限时」，方向与目的相反）",
    /capFor\(wantMs\) \{ return Math\.max\(1,/.test(degradedBlock));
  check("🔴 退化副本 canAfford 仍在真的比余量（恒真 = 把 issue #127 原样放回来）",
    /canAfford\(minMs\) \{ return api\.left\(\) >= /.test(degradedBlock));
  check("🔴 退化副本的内层常量自检也用 effectiveMs（与真模块同一次订正，别只改一边）",
    /Number\(ms\) > api\.effectiveMs/.test(degradedBlock));

  // ── 行为级对照：退化副本 ≡ 真模块（2026-08-06 · issue #147 账 2）─────────────
  // 上面四条是**源码级文本匹配**，它们对「注释掉」天然失明 —— 这一点上面已经照直写了。
  // 这一组走**另一条路**：把 `degradedBudgetLib` 从源码里取出来**真的执行**，再与真模块
  // 逐项比。执行的东西被注释掉就不存在了，故这一半对「注释掉」不失明。
  // 两种一起放着是有意的：文本匹配夹得住「值被改了但形态还在」，行为对照夹得住「形态没了」。
  //
  // 治的是什么：PR #130 二轮对抗有两个变异体存活 —— `FALLBACK_MS 10000→60000`（A4，
  // 往乐观侧错 6 倍）与「起点改成函数被调用时刻」（A6，系统性高估余量）。**真模块的同一个
  // 不变式是夹住的**（D6 被杀），副本上却是零覆盖。同族的 A5（RESERVE 1500→0）当时被杀，
  // 但对抗官照直写了「杀它的是巧合」（夹具预算恰好 1600，reserve 一归零就跨过 1200 门限），
  // **没有任何断言在看 reserve 这个取值本身** ⇒ 这里一并补成真断言。
  const degradedLib = (() => {
    try { return new Function(degradedBlock + "\nreturn degradedBudgetLib();")(); }
    catch (e) { return null; }
  })();
  check("自检：退化块能被取出来执行（取不出来时下面几条一律先红，而不是空扫全绿）",
    !!degradedLib && typeof degradedLib.createBudget === "function",
    degradedLib ? Object.keys(degradedLib).join(",") : "eval 失败");

  if (degradedLib) {
    const realLib = require("../ccswitch/lib/hook-budget");

    // 🔴 A4：副本的 FALLBACK 必须**等于**真模块的 FALLBACK，不是「大致差不多」。
    // 拿真模块的导出当期望值（而不是写死 10000）是刻意的：两边任一侧改了而另一侧没跟上，
    // 这条都红 —— 而「两个文件里互不知情的两个数」正是 issue #127 本身。
    check("🔴 退化副本 FALLBACK ≡ 真模块 FALLBACK_TIMEOUT_MS（A4：改成 60000 即红）",
      degradedLib.resolveRegisteredTimeoutMs().ms === realLib.FALLBACK_TIMEOUT_MS,
      "degraded=" + degradedLib.resolveRegisteredTimeoutMs().ms + " real=" + realLib.FALLBACK_TIMEOUT_MS);
    check("🔴 副本 createBudget 收到非法 totalMs 时也落同一个 FALLBACK（同一旋钮的第二条路）",
      degradedLib.createBudget({ totalMs: 0 }).totalMs === realLib.FALLBACK_TIMEOUT_MS,
      String(degradedLib.createBudget({ totalMs: 0 }).totalMs));

    // 🔴 A5：reserve 的取值本身要有人看着（此前只有那个巧合在挡）
    check("🔴 退化副本 RESERVE ≡ 真模块 DEFAULT_RESERVE_MS（A5：归零即红，不再靠巧合）",
      degradedLib.createBudget({ totalMs: 10000 }).reserveMs === realLib.DEFAULT_RESERVE_MS,
      "degraded=" + degradedLib.createBudget({ totalMs: 10000 }).reserveMs + " real=" + realLib.DEFAULT_RESERVE_MS);

    // 🔴 A6：起点必须是**进程启动时刻**，不是本函数被调用时刻。
    // 判别力靠 `process.uptime()` 这个**独立的第二个量**（同真模块那组的手法）：
    // 按调用时刻算的实现会让 elapsed 掉到接近 0，与 uptime 差出量级。
    const uptimeMs = Math.round(process.uptime() * 1000);
    check("自检：本测试进程已经跑了足够久（uptime > 300 ms），下面那条才有判别力",
      uptimeMs > 300, "uptime=" + uptimeMs);
    const dB = degradedLib.createBudget({ totalMs: 10000 });
    check("🔴 退化副本起点 = 进程启动时刻（A6：改成调用时刻即红）",
      Math.abs(dB.elapsed() - uptimeMs) < 50, "elapsed=" + dB.elapsed() + " uptime=" + uptimeMs);
    check("同伴（负控）：真模块在同一问题上给同一个答案（否则上一条可能是在夹别的东西）",
      Math.abs(realLib.createBudget({ totalMs: 10000 }).elapsed() - uptimeMs) < 50);

    // 派生量的一致性：这一条会在真模块长出**第四条**不变式而副本没跟上时红 ——
    // PR #130 未尽处 2 点名的正是这个缺口（「副本与真模块的漂移只被那三条覆盖」）。
    for (const total of [3000, 10000, 30000]) {
      const d = degradedLib.createBudget({ totalMs: total });
      const r = realLib.createBudget({ totalMs: total });
      check("effectiveMs 一致（totalMs=" + total + "）", d.effectiveMs === r.effectiveMs,
        "degraded=" + d.effectiveMs + " real=" + r.effectiveMs);
      const pairs = [["X", 30000], ["Y", 1000]];
      check("unreachableConstants 结论一致（totalMs=" + total + "）",
        JSON.stringify(d.unreachableConstants(pairs)) === JSON.stringify(r.unreachableConstants(pairs)),
        JSON.stringify(d.unreachableConstants(pairs)) + " vs " + JSON.stringify(r.unreachableConstants(pairs)));
    }

    // ── 方法面齐不齐（2026-08-06 · issue #147 账 3 的同族）────────────────────
    // **独立的第二遍普查**：不复用上面那个 degradedBlock 切片，而是从 hook 源码里数出
    // 所有 `budgetLib.<name>(` 与 `BUDGET.<name>` 的用法，逐个要求副本也有。
    // 少一个 = lib 坏掉时直接 `TypeError`，而那一抛正好落在「lib 已经坏了」的路上。
    // 判据独立于被守对象的解析：那边切的是一段源码区间，这边数的是调用点。
    // ⚠ 两种调用形态都要数：hook 里既有 `budgetLib.isBudgetKill(...)`（模块级那个绑定），
    //   也有 `initBudget(lib)` 里的 `lib.resolveRegisteredTimeoutMs(...)` / `lib.createBudget(...)`
    //   （那个函数拿 lib 当参数，正因为它要被真模块与退化副本各调一次）。
    //   只数前一种会让分母塌到 1 —— 而分母塌了与「副本什么都不缺」输出一模一样。
    const hookSrc = fs.readFileSync(HOOK, "utf8");
    const calledOnLib = [...new Set([...hookSrc.matchAll(/\b(?:budgetLib|lib)\.(\w+)\(/g)].map((m) => m[1]))];
    check("自检：普查真的数出了 budgetLib 的调用（少于 3 个说明普查瞎了）",
      calledOnLib.length >= 3, calledOnLib.join(","));
    for (const name of calledOnLib) {
      check("退化副本提供 budgetLib." + name + "（缺一个 = lib 坏掉时 TypeError）",
        typeof degradedLib[name] === "function", "有的是：" + Object.keys(degradedLib).join(","));
    }
    const usedOnBudget = [...new Set([...hookSrc.matchAll(/\bBUDGET\.(\w+)/g)].map((m) => m[1]))];
    check("自检：普查真的数出了 BUDGET 的成员（数到 0 说明普查瞎了）",
      usedOnBudget.length >= 5, usedOnBudget.join(","));
    const dApi = degradedLib.createBudget({ totalMs: 10000 });
    const rApi = realLib.createBudget({ totalMs: 10000 });
    for (const name of usedOnBudget) {
      check("退化副本的预算对象有 BUDGET." + name + "（真模块有它，副本就得有）",
        dApi[name] !== undefined && typeof dApi[name] === typeof rApi[name],
        "degraded=" + typeof dApi[name] + " real=" + typeof rApi[name]);
    }
  }

  // ── 账 3：require 之后那两句顶层调用也得受保护 ─────────────────────────────
  // PR #130 的阻断 1 只包住了 `require`；紧跟着的 `resolveRegisteredTimeoutMs()` /
  // `createBudget()` 落在 catch 之外 ⇒ 注入 throw 即 **exit 1 + stdout 0 字节**，
  // 与那次阻断的现象逐格相同。下面两臂是它的回归网。
  const stubLib = (which) => (p) => fs.writeFileSync(p,
    "module.exports = {\n" +
    "  resolveRegisteredTimeoutMs() {\n" +
    (which === "resolve"
      ? "    throw new Error('注入：resolveRegisteredTimeoutMs 抛错');\n"
      : "    return { ms: 10000, source: 'fallback', matched: 0, note: '桩：不走真解析' };\n") +
    "  },\n" +
    "  createBudget() {\n" +
    (which === "create"
      ? "    throw new Error('注入：createBudget 抛错');\n"
      : "    throw new Error('桩：本臂不该走到这里');\n") +
    "  },\n" +
    "  isBudgetKill() { return false; },\n" +
    "};\n", "utf8");
  const INITFAIL = /✗ 墙钟预算初始化抛错：/;
  for (const [which, tag] of [["resolve", "resolveRegisteredTimeoutMs"], ["create", "createBudget"]]) {
    const r = run(cwd, env, mkBrokenLibTree("initthrow-" + which, stubLib(which)));
    const c = ctx(r);
    check("🔴 " + tag + " 抛错 → 仍 exit 0（不是 exit 1 + 零输出）",
      r.code === 0, "code=" + r.code + " stderr=" + r.err.slice(0, 200));
    check("🔴 " + tag + " 抛错 → 报文非空（agent 拿得到东西）", c.length > 0, "len=" + c.length);
    check("🔴 " + tag + " 抛错 → **明说**初始化抛错了（与「加载失败」是两行、两种处置）",
      INITFAIL.test(c), "ctx=" + c.slice(0, 400));
    check("🔴 " + tag + " 抛错 → 其余检查照跑", /dao-brokenlib-probe/.test(c), "ctx=" + c.slice(0, 400));
  }
  check("对照组：lib 完好时**零**「初始化抛错」行（钉住不是恒报）",
    !INITFAIL.test(ctx(run(cwd, env, mkBrokenLibTree("initthrow-control", null)))));

  // ── 账 3 的另一半：未预期崩溃的兜底网 ──────────────────────────────────────
  // 往沙箱那份 hook 副本里注入一个 throw（真仓库那份一个字节都不动）。
  // 锚点单行、换行位写 `\r?\n`；**前置断言与 replace 共用同一个 RegExp 对象**
  // （dao-guard-writing ③：守着近似物的锚点断言提供的是虚假的安心）。
  const THROW_ANCHOR = /(const gitSkips = \[\];)(\r?\n)/;
  let anchorHit = false;
  const crashed = run(cwd, env, mkBrokenLibTree("uncaught", null, (p) => {
    const src = fs.readFileSync(p, "utf8");
    anchorHit = THROW_ANCHOR.test(src);
    fs.writeFileSync(p, src.replace(THROW_ANCHOR, '$1$2throw new Error("注入：模拟未预期崩溃");$2'), "utf8");
  }));
  check("mutation 锚点仍在（锚失效则下面三条空转）", anchorHit, String(THROW_ANCHOR));
  const cc = ctx(crashed);
  check("🔴 未预期崩溃 → 仍 exit 0（不是 exit 1 + 零字节）",
    crashed.code === 0, "code=" + crashed.code + " stderr=" + crashed.err.slice(0, 200));
  check("🔴 未预期崩溃 → stdout 是**合法 JSON**（双写守卫：拼出两段就等于什么都没有）",
    crashed.json !== null, "out=" + crashed.out.slice(0, 200));
  check("🔴 未预期崩溃 → 报文明说崩了、且明说「这不是全部通过」",
    /未预期崩溃/.test(cc) && /不是「全部通过」/.test(cc), "ctx=" + cc.slice(0, 400));
  check("对照组：同一棵树不注入 throw → **零**「未预期崩溃」行（钉住不是恒报）",
    !/未预期崩溃/.test(ctx(run(cwd, env, mkBrokenLibTree("uncaught-control", null)))));

  // ── issue #152 账 1（PR #150 对抗带账）：那张网新长出的**更静默**的一条路 ─────────
  //
  // `emitOnce` 先置 `emitted = true` 再写 stdout。**写自己抛出**时异常冒到 uncaughtException，
  // 网调 `emitOnce` ⇒ 撞上 `if (emitted) return;` ⇒ 原先 `exit(0)`。
  // 2026-08-08 实测（考古复核，issue 快照今天仍成立）：
  //     stdout.write 抛出 ⇒ exit=0 · stdout **0 字节** · segs=0
  //     合法的「无事可报」 ⇒ exit=0 · stdout **0 字节** · segs=0     ← **逐字节不可区分**
  // 而 master（没有这张网）那一态是 exit 1 + 一段栈。⇒ 这条路上网让消费方看到的**更少**。
  // 修法：写失败 ⇒ stderr 出一行 + 退出码非 0（**不是 2**：2 是 block 语义）。
  const STDOUT_THROW_ANCHOR = /(let emitted = false;)(\r?\n)/;
  const NOTHING_ANCHOR = /(function inject\(context\) \{\r?\n)  emitOnce\(context\);\r?\n/;
  let anchorThrow = false, anchorNothing = false;

  const wThrow = run(cwd, env, mkBrokenLibTree("stdout-throw", null, (p) => {
    const src = fs.readFileSync(p, "utf8");
    anchorThrow = STDOUT_THROW_ANCHOR.test(src);
    fs.writeFileSync(p, src.replace(STDOUT_THROW_ANCHOR,
      '$1$2process.stdout.write = function () { throw new Error("注入：stdout 写入失败(EPIPE 模拟)"); };$2'), "utf8");
  }));
  // 「合法的无事可报」对照：把 inject 的那次 emitOnce 拿掉 ⇒ 什么都不写、正常退出。
  const nothing = run(cwd, env, mkBrokenLibTree("nothing-to-say", null, (p) => {
    const src = fs.readFileSync(p, "utf8");
    anchorNothing = NOTHING_ANCHOR.test(src);
    fs.writeFileSync(p, src.replace(NOTHING_ANCHOR, "$1  void context;\n"), "utf8");
  }));
  check("mutation 锚点仍在（stdout 抛出 / 无事可报，锚失效则下面几条空转）",
    anchorThrow && anchorNothing, `throw=${anchorThrow} nothing=${anchorNothing}`);
  check("前提：对照臂真的什么都没写（否则「不可区分」这件事就无从谈起）",
    nothing.code === 0 && nothing.out.length === 0, `code=${nothing.code} bytes=${nothing.out.length}`);
  check("🔴 #152 账 1：stdout.write 抛出 → 退出码**非 0**（否则与「无事可报」逐字节不可区分）",
    wThrow.code !== 0, `code=${wThrow.code}`);
  check("🔴 #152 账 1：那个非 0 **不是 2**（2 是 block 语义，自检没资格拦会话）",
    wThrow.code !== 2, `code=${wThrow.code}`);
  check("🔴 #152 账 1：stdout 这条路断了 ⇒ stderr 上必须留下**说得清是怎么回事**的一行",
    /stdout 写不出去/.test(wThrow.err) && /不是「全部通过」/.test(wThrow.err),
    "stderr=" + wThrow.err.slice(0, 400));
  // issue #152 账 1 描述的那个组合态：**先有一个真崩溃，再撞上写不出去**。
  // 这一臂才是网自己那条路（uncaughtException → emitOnce → 写抛出），上一臂走的是常路。
  const both = run(cwd, env, mkBrokenLibTree("stdout-throw-and-crash", null, (p) => {
    let src = fs.readFileSync(p, "utf8");
    src = src.replace(STDOUT_THROW_ANCHOR,
      '$1$2process.stdout.write = function () { throw new Error("注入：stdout 写入失败(EPIPE 模拟)"); };$2');
    src = src.replace(THROW_ANCHOR, '$1$2throw new Error("注入：模拟未预期崩溃");$2');
    fs.writeFileSync(p, src, "utf8");
  }));
  check("🔴 #152 账 1（组合态）：真崩溃 + 写不出去 ⇒ 退出码非 0、stdout 仍 0 字节",
    both.code !== 0 && both.code !== 2 && both.out.length === 0,
    `code=${both.code} bytes=${both.out.length}`);
  check("🔴 #152 账 1（组合态）：崩溃原文补进 stderr（报文没送出去 ⇒ 原因不许跟着一起没）",
    /未预期崩溃（报文送不出去/.test(both.err) && /stdout 写不出去/.test(both.err),
    "stderr=" + both.err.slice(-400));
  check("🔴 #152 账 1：与「无事可报」现在**分得开**（退出码这一位不同；stdout 两边都是 0 字节）",
    wThrow.out.length === 0 && nothing.out.length === 0 && wThrow.code !== nothing.code,
    `throw=(code=${wThrow.code},bytes=${wThrow.out.length}) nothing=(code=${nothing.code},bytes=${nothing.out.length})`);
  check("活的负控：同一棵树不注入 ⇒ 退出码回到 0（钉住不是恒非 0）",
    run(cwd, env, mkBrokenLibTree("stdout-throw-control", null)).code === 0);

  // ── #152 账 1 的第二半：`if (emitted) return;` 这条**承重行**此前零断言 ──────────
  // PR #150 对抗 M1 实测它零覆盖，而恰恰是它把上面那条路从「响」变成「静默」。
  // 两态（守卫在 / 摘掉守卫）在**写完之后才崩**这个态上可观测地不同：
  //   守卫在 ⇒ 一段合法 JSON（实测 2184 B）；摘掉 ⇒ **两段拼在一起、非法 JSON**（2844 B）。
  const LATE_THROW_ANCHOR = /(function inject\(context\) \{\r?\n  emitOnce\(context\);\r?\n)/;
  const GUARD_ANCHOR = /  if \(emitted\) return;\r?\n/;
  let anchorLate = false, anchorGuard = false;
  const lateThrow = (tag, dropGuard) => run(cwd, env, mkBrokenLibTree(tag, null, (p) => {
    let src = fs.readFileSync(p, "utf8");
    anchorLate = LATE_THROW_ANCHOR.test(src);
    anchorGuard = GUARD_ANCHOR.test(src);
    src = src.replace(LATE_THROW_ANCHOR, '$1  throw new Error("注入：写完之后才崩");\n');
    if (dropGuard) src = src.replace(GUARD_ANCHOR, "");
    fs.writeFileSync(p, src, "utf8");
  }));
  const guarded = lateThrow("late-throw-guarded", false);
  const unguarded = lateThrow("late-throw-unguarded", true);
  const segs = (r) => (r.out.match(/\{"hookSpecificOutput"/g) || []).length;
  check("mutation 锚点仍在（写后崩 / 双写守卫）", anchorLate && anchorGuard,
    `late=${anchorLate} guard=${anchorGuard}`);
  check("🔴 双写守卫在 → 写完之后才崩，stdout 仍是**一段合法 JSON**",
    guarded.json !== null && segs(guarded) === 1, `segs=${segs(guarded)} out=${guarded.out.slice(0, 120)}`);
  check("🔴 mutation：摘掉 `if (emitted) return;` → 同一个态拼出**两段、非法 JSON**（承重行坐实）",
    unguarded.json === null && segs(unguarded) === 2,
    `segs=${segs(unguarded)} parsed=${unguarded.json !== null} bytes=${unguarded.out.length}`);
  check("mutation canary：摘守卫那一版没崩死（照样写得出东西，红的是形状不是进程）",
    unguarded.code === 0 && unguarded.out.length > guarded.out.length,
    `code=${unguarded.code} 摘=${unguarded.out.length}B 守=${guarded.out.length}B`);
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 🔴 git 被预算夹死时必须出声（issue #147 账 1 · A3 的 catch 那一半）===");
// 这一组是 PR #130 二轮对抗**账 1** 的回归网：把 `gitOut` 的 catch 分支整个改成 `if (false)`
// （= 回到本 PR 之前那个 `catch (_) {}` 的静默态）**mutation 存活**，两半判据各自删掉也存活，
// 模式 B 的镜像行删掉也存活 —— 三处都没有任何断言。
//
// **端到端造不出来这件事，二轮对抗已经量死了**：真条件是 `left() >= 200` 且 git 自己比
// `min(GIT_TIMEOUT_MS, left())` 还慢（本机 git ≈28 ms），**靠调预算旋钮永远造不出来**
// （6 档实测：1750 走前置守门，1800–2600 全部正常跑完）。故这里用 hook 自带的测试缝
// `DAO_HOOK_GIT_TIMEOUT_MS`（**只准调小**）把上限压到 1 ms —— 喂给 catch 的 error 对象
// 与「真有一个慢 git」时是同一个（都是 node 按 timeout 杀子进程），被测路径逐字相同。
{
  const env = { DAO_SCAFFOLD_MANIFEST: path.join(REPO, "ccswitch", "scaffold-manifest.json") };
  const KILLED = /git 状态查询（[^）]*） \*\*没跑\*\*：子进程起来了/;

  // 模式 A（元仓库那三处 gitOut）
  const metaCwd = mkMetaRepo("git-killed", [`${REGISTERED}.js`]);
  const aTight = run(metaCwd, Object.assign({ DAO_HOOK_GIT_TIMEOUT_MS: "1" }, env));
  const ca = ctx(aTight);
  check("🔴 模式 A · git 被夹死 → 报文里有那一行（catch 分支改 if(false) 即红）",
    KILLED.test(ca), "ctx=" + ca.slice(0, 900));
  check("🔴 模式 A · 那一行说得清是「起来了又被杀」，不是「余量不够没起」",
    /比我们夹给它的上限还慢/.test(ca) && /这不是「通过」，是「没测」/.test(ca), "ctx=" + ca.slice(0, 900));
  check("🔴 模式 A · 汇总行的「跳过 N 项」把这一路算进去了（不是只印一行就完）",
    /本次跳过 [1-9]\d* 项/.test(ca), (ca.match(/[^\n]*本次跳过[^\n]*/) || [""])[0]);
  check("活的负控 · 模式 A · 不设那个环境变量 → **零**这一行（钉住不是恒报）",
    !KILLED.test(ctx(run(metaCwd, env))));

  // 模式 B（普通项目里的镜像行 —— 二轮对抗第 27 个变异体删掉它也存活）
  const plainCwd = mkproj("git-killed-b", (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# 项目\n", "utf8");
  });
  const bTight = run(plainCwd, Object.assign({ DAO_HOOK_GIT_TIMEOUT_MS: "1" }, env));
  const cb2 = ctx(bTight);
  check("🔴 模式 B · 同样出声（镜像行 `for (const line of gitSkipLines())` 删掉即红）",
    KILLED.test(cb2), "ctx=" + cb2.slice(0, 900));
  check("活的负控 · 模式 B · 不设那个环境变量 → **零**这一行",
    !KILLED.test(ctx(run(plainCwd, env))));

  // 测试缝本身的方向性：它**只准调小**（与 DAO_HOOK_BUDGET_MS 同一条理由 —— 能调大就是
  // 一个让 hook 谎报余量的后门）。
  // ⚠ **这一条自己证不了「不是后门」，照直写**：`Math.min` 换成 `Math.max` 时它照样 PASS ——
  //   因为 `capFor()` 已经把上限夹在剩余预算之内，把 GIT_TIMEOUT 抬到 999999 在行为上
  //   观察不到。真正夹住 min↔max 那个方向的是上面几条 TIGHT 正控（换成 max 后 1 ms 变成
  //   5000 ms，git 正常跑完 ⇒ 那几条全红；本批 mutation 实测 A1-seam-min-to-max 就是这样被杀的）。
  //   本条只证一件小事：**给一个大值不会反而把 git 夹死**（不是「反向也生效」）。
  check("给测试缝一个大值（999999）不会反而把 git 夹死",
    !KILLED.test(ctx(run(plainCwd, Object.assign({ DAO_HOOK_GIT_TIMEOUT_MS: "999999" }, env)))));
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

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 模式 A · 条款筛选器：提及 ≠ 使用（clauseTargets v3 两态）===");
// 2026-08-07 修的假阳性：筛选正则 `\[自定@` 会命中**谈论**这个语法的散文引用
// （dao-change-batch.md 仅因一句「与 `[自定@]` 回溯面同构」被拉进扫描面，
// Marked 下零选中 ⇒ zero-sample 恒红）。v3 收紧为 `\[自定@\d`（真标记必带月日）。
// 两态断言的判别锚点是**普查行的两个计数**（绿路不点名文件，实测确认）：
// `含条款的 M/N 个 .md，合计 C 条` —— 负控进没进看 M（mention-only 进了则 M=2），
// 正控进没进看 C（real-mark 的那条被数到才是 2；被丢则 M=0、C=1）。
// 文件名子串只用于负控（红/err 路才带路径，负控文件任何一路都不该留名）。
// 本组要真跑 check-clauses-structure.ps1（win32 专属），非 Windows 记名跳过不静默。
if (process.platform !== "win32") {
  console.log("  SKIP  非 Windows：本组要真跑 PowerShell 条款闸，此平台不适用（记名跳过，非通过）");
} else {
  const root = path.join(SANDBOX, "meta", "clausefilter", "windsurf-dao");
  const rulesDir = path.join(root, "ccswitch", "rules");
  const scriptsDir = path.join(root, "ccswitch", "scripts");
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  putFakeGit(root);
  // 真 PS 闸副本（不是空壳）：本组测的就是「谁被送进它嘴里」
  fs.copyFileSync(path.join(REPO, "ccswitch", "scripts", "check-clauses-structure.ps1"),
    path.join(scriptsDir, "check-clauses-structure.ps1"));
  // dao.md 造一条元字段合法的条款，让缺省目标自身不搅局（zero-sample 不红）
  fs.writeFileSync(path.join(root, "ccswitch", "dao.md"),
    "# fixture dao\n\n- **甲条**：合法条款。 [n=1 @08-07 触发:PR流程] [基线:合成]\n", "utf8");
  // 负控：纯流程文件，正文只**引用** `[自定@]` 语法（无日期）——v2 会误纳，v3 不纳
  fs.writeFileSync(path.join(rulesDir, "mention-only.md"),
    "# 流程细则\n\n- 双向门项走预授权（与「照做档/判断档」+`[自定@]` 回溯面同构）。\n", "utf8");
  // 正控：真标记 `[自定@08-07]`（@ 后带数字）——v3 必须仍纳入扫描面
  fs.writeFileSync(path.join(rulesDir, "real-mark.md"),
    "# 含真标记\n\n- **乙条**：AI 自定的一条。 [n=1 @08-07 触发:PR流程] [基线:合成] [自定@08-07]\n", "utf8");
  // ⚠ FAIL 明细**只取条款闸那几行**（2026-08-08 · issue #169④ 清偿）：原先写的是
  // `ct.slice(0, 600)`，而 additionalContext 的头 600 字符**恒被 settings-drift 段占满**
  // ⇒ 三种坏法（负控误纳 / 正控被丢 / 走了红路）的 FAIL 详情**逐字相同**，红了读不出是哪种。
  // 断言本身当时是对的，只是诊断信息为零 —— 「红了但看不出为什么」离没有测试不远。
  const clauseCtx = (t) => (t.split(/\r?\n/).filter((l) => /条款库|条款筛选器|条款文件/.test(l)).join("\n") ||
    "（ctx 里一行条款闸相关输出都没有 —— 那本身就是坏法之一）");
  const ct = ctx(run(root));
  check("负控：仅引用 [自定@]（无日期）的纯流程文件不进扫描面（M=1，且全程零留名）",
    /1\/2 个 \.md/.test(ct) && !/mention-only\.md/.test(ct), "条款闸相关行=\n" + clauseCtx(ct));
  check("正控：带真标记 [自定@08-07] 的文件仍被扫（它那条被数进合计 ⇒ C=2）",
    /合计 2 条/.test(ct), "条款闸相关行=\n" + clauseCtx(ct));
  check("自检：走的是绿普查行（上两条的锚点在这行里，行没了先红这条）",
    /条款库结构闸绿/.test(ct), "条款闸相关行=\n" + clauseCtx(ct));

  // ── v4 两态（2026-08-08 · issue #169① 判据归一后新增）──────────────────────
  // 判据从裸正则换成 clause-parser 的**遮罩**判据之后，#169② 记的那个「v3 关不掉的形态」
  // 必须也被关掉：**行内代码里举一个带日期的例子**（`` `[自定@08-02]` ``）——
  // v3 正则在它上面必然误纳（`[自定@08-02]` 逐字命中 `\[自定@\d`），遮罩判据不会。
  // 这一条是**新旧判据的判别点**：把 hook 改回旧正则，它当场红。
  fs.writeFileSync(path.join(rulesDir, "mention-dated.md"),
    "# 流程细则\n\n- 举个例子：真标记长这样 `[自定@08-02]`，本文件自己没打任何标记。\n", "utf8");
  const ct2 = ctx(run(root));
  check("负控②（#169② 那个洞）：行内代码里举带日期的例子不进扫描面（M 仍是 1，分母涨到 3）",
    /1\/3 个 \.md/.test(ct2) && !/mention-dated\.md/.test(ct2), "条款闸相关行=\n" + clauseCtx(ct2));
  check("自检②：本轮判据没降级（降级行一出现，上一条就只代表近似正则的结论）",
    !/条款筛选器降级/.test(ct2), "条款闸相关行=\n" + clauseCtx(ct2));
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 🔴 选择器清单取不到时必须出声（PR #183 对抗🟡① · 最后一条静默降级路）===");
// 病：`parser` **加载成功**、但 `defaultPsSelectorMap` 取不到时 `selectorMap` 为空 ⇒
// `mk()` 里那句 `&& Object.keys(selectorMap).length` 让 **ⓘ 一行都不打**，而
// `CLAUSE_PARSER_WHY` 只在 `hasClauseSignature` 缺失时才被设 ⇒ **⚠ 降级行也不打**，
// 全部悄悄回落 Marked。对抗实测（把那句 `typeof` 的名字改成一个不存在的导出）：真仓
// additionalContext 与基线**逐字相同**、本套 152/0 全绿 —— 「没查」与「查了且干净」
// 又一次不可区分，而那正是这道闸自己在治的病。
//
// 造法：拷一份 hook 到沙箱，旁边放一个**自造的** clause-parser.mjs 替身（hook 里
// `require("../lib/clause-parser.mjs")` 按**文件所在目录**解析，故这份替身生效，
// 真仓库一个字节都不动）。两臂只差一个导出，**判据独立写死在本文件里**、不从 hook
// 源码反推。本组要真跑 check-clauses-structure.ps1（win32 专属），非 Windows 记名跳过。
if (process.platform !== "win32") {
  console.log("  SKIP  非 Windows：本组要真跑 PowerShell 条款闸，此平台不适用（记名跳过，非通过）");
} else {
  // 替身的 `hasClauseSignature` 两臂**逐字相同** —— 保证「⚠ 条款筛选器降级」那条**老路**
  // 在两臂都不响，于是新那条路一响就只可能是它自己（独立归因）。
  const SIG = 'export function hasClauseSignature(text) { return /\\[n=/.test(String(text)); }\n';
  const MAP = 'export function defaultPsSelectorMap() { return { "ccswitch/dao.md": "Marked" }; }\n';
  const mkStubParserTree = (tag, parserSrc) => {
    const hooksDir = path.join(SANDBOX, "selmap", tag, "ccswitch", "hooks");
    const libDir = path.join(SANDBOX, "selmap", tag, "ccswitch", "lib");
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.mkdirSync(libDir, { recursive: true });
    const hookCopy = path.join(hooksDir, path.basename(HOOK));
    fs.copyFileSync(HOOK, hookCopy);
    const realLib = path.join(REPO, "ccswitch", "lib");
    for (const f of fs.readdirSync(realLib).filter((n) => n.endsWith(".js"))) {
      fs.copyFileSync(path.join(realLib, f), path.join(libDir, f));
    }
    fs.writeFileSync(path.join(libDir, "clause-parser.mjs"), parserSrc, "utf8");
    return hookCopy;
  };
  // 被检夹具：一份元字段合法的 dao.md（zero-sample 不红）+ 真 PS 闸副本（不是空壳）。
  // 刻意**不建** ccswitch/rules/ —— 本组测的是「清单取不到」那一格，扫描面越小跑得越快。
  const selRoot = path.join(SANDBOX, "meta", "selmap", "windsurf-dao");
  fs.mkdirSync(path.join(selRoot, "ccswitch", "scripts"), { recursive: true });
  putFakeGit(selRoot);
  fs.copyFileSync(path.join(REPO, "ccswitch", "scripts", "check-clauses-structure.ps1"),
    path.join(selRoot, "ccswitch", "scripts", "check-clauses-structure.ps1"));
  fs.writeFileSync(path.join(selRoot, "ccswitch", "dao.md"),
    "# fixture dao\n\n- **甲条**：合法条款。 [n=1 @08-08 触发:PR流程] [基线:合成]\n", "utf8");

  // FAIL 明细只取条款闸那几行（理由同上一组：头 N 字符恒被 settings-drift 段占满）
  const selCtx = (t) => (t.split(/\r?\n/).filter((l) => /条款库|条款筛选器|条款文件|选择器清单/.test(l)).join("\n") ||
    "（ctx 里一行条款闸相关输出都没有 —— 那本身就是坏法之一）");
  const SELMAP_DEGRADED = /⚠ 选择器清单降级/;
  const PARSER_DEGRADED = /条款筛选器降级/;

  // 正控：parser 加载成功（hasClauseSignature 在），但 defaultPsSelectorMap 不在
  const cNoMap = ctx(run(selRoot, null, mkStubParserTree("no-map", SIG)));
  check("🔴 parser 在、defaultPsSelectorMap 不在 → **出声**（这条路此前全程静默）",
    SELMAP_DEGRADED.test(cNoMap), "条款闸相关行=\n" + selCtx(cNoMap));
  check("🔴 响的是**新**那条路，不是 require 失败那条老路（措辞不重叠 ⇒ 归因分得开）",
    SELMAP_DEGRADED.test(cNoMap) && !PARSER_DEGRADED.test(cNoMap), "条款闸相关行=\n" + selCtx(cNoMap));
  check("🔴 那一行说得出后果（本轮按缺省 Marked 检、ⓘ 结构上出不来 ⇒ 读者不会读成「都登记好了」）",
    /Marked/.test(cNoMap) && /没查/.test(cNoMap), "条款闸相关行=\n" + selCtx(cNoMap));
  check("自检：这棵沙箱树上条款闸真的跑到了（跑不到则上三条是空扫，不是通过）",
    /条款库结构闸绿/.test(cNoMap), "条款闸相关行=\n" + selCtx(cNoMap));

  // 对照组（结构上不可能命中上面那条）：同一棵夹具、同一份 hook，替身只多一个导出。
  // 不带这一臂，上面几条会被一个「恒报降级」的实现全绿糊过去。
  const cWithMap = ctx(run(selRoot, null, mkStubParserTree("with-map", SIG + MAP)));
  check("对照组：替身把 defaultPsSelectorMap 补上 → **零**降级行（钉住不是恒报）",
    !SELMAP_DEGRADED.test(cWithMap) && !PARSER_DEGRADED.test(cWithMap), "条款闸相关行=\n" + selCtx(cWithMap));
  check("对照组：同一棵树上条款闸同样跑得出来（证明这棵夹具本身是活的）",
    /条款库结构闸绿/.test(cWithMap), "条款闸相关行=\n" + selCtx(cWithMap));
}

// ── 清理 ────────────────────────────────────────────────────────────────────
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
