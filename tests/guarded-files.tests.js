// guarded-files 回归网 — guarded-scan 口径 + dao-glob-gate 守卫指针分支（issue #122）
//
// 跑法：node tests/guarded-files.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 这份网守着两个判据 ──────────────────────────────────────────────────────
// ① `ccswitch/lib/guarded-scan.js` 的**口径**：谁算「被 mutation 守护的源文件」。
// ② `ccswitch/hooks/dao-glob-gate.js` 的**守卫指针分支**：Edit/Write 命中清单即注入一行指针。
//
// ── 重设计后的形态（2026-08-11）──────────────────────────────────────────────
// 清单**不再是派生物**：旧形态是 gen-guarded-files.mjs 生成 guarded-files.json +
// `--check` 同步闸守「清单与测试实况一致」。现形态是 hook 每次运行时从 tests/ 现算
// （带指纹缓存）——「清单过期」这一物种不存在了，同步闸随之删除。
// 这份网因此只守**行为**：口径（①）与 hook 分支（②）。「盘上清单新不新」不再是需要守的事。
//
// ── mutation 覆盖：三形态 + 反向（照对抗验证节「改坏多形态」）──────────────────
// ①移除 ②保留字面但不执行 ③保留调用但结果不被消费；反向 = 把判据改松。
// 每个变异体先跑 canary 确认「它还活着」——被弄死的靶会让每条断言都红，
// 而那正是「判别力满分」的表象。
//
// ── 已知不覆盖，照直写 ──────────────────────────────────────────────────────
// · 不验「宿主真的会在 Edit 之后调用这个 hook」——注册面归 settings 层，且注册是用户动作。
// · 不验「注入之后官真的照做了」——送达≠遵守。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const LIB = path.join(REPO, "ccswitch", "lib", "guarded-scan.js");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-glob-gate.js");
const TMP = path.join(REPO, "_tmp", "guarded-files-tests");

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}
function sha(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
function w(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, "utf8"); return p; }
// 变异体/副本的 require 要走全新加载（同名再 require 会吃缓存）
function freshRequire(p) { delete require.cache[require.resolve(p)]; return require(p); }
function scanWith(libPath, root) {
  const m = freshRequire(libPath);
  return m.scanGuarded({ repoRoot: root, testsDir: path.join(root, "tests") });
}

const PRISTINE_LIB = sha(LIB);
const PRISTINE_HOOK = sha(HOOK);

// ── 合成语料：一棵假仓，每一格的两侧都有样本 ─────────────────────────────────
function makeRepo(tag) {
  const root = path.join(TMP, tag);
  w(path.join(root, "ccswitch", "hooks", "dao-alpha.js"), "// alpha\n");
  w(path.join(root, "ccswitch", "lib", "beta.js"), "// beta\n");
  w(path.join(root, "ccswitch", "templates", "check-gamma.mjs"), "// gamma\n");
  w(path.join(root, "ccswitch", "hooks", "dao-nomut.js"), "// 只被一份「无 mutation」的测试声明\n");
  w(path.join(root, "ccswitch", "hooks", "dao-fixture.js"), "// 只被夹具形态 path.join(root, …) 声明\n");
  w(path.join(root, "ccswitch", "hooks", "dao-helperonly.js"), "// 只被非 *.tests.* 的 helper.js 声明\n");
  w(path.join(root, "ccswitch", "skills", "dao-thing", "SKILL.md"), "# 不在四类 owned 目录里\n");
  w(path.join(root, "ccswitch", "dao.md"), "# 不在四类 owned 目录里\n");
  // owned 目录之下的子目录：前缀过得了 OWNED_DIRS、盘上真实存在 ⇒ 只有 .isFile() 挡得住
  w(path.join(root, "ccswitch", "templates", "ISSUE_TEMPLATE", "bug.yml"), "# 子目录里的文件\n");

  const tests = path.join(root, "tests");
  w(path.join(tests, "alpha.tests.js"), [
    'const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-alpha.js");',
    'const mutant = src.replace("x", "y");',
    'w(path.join(root, "ccswitch", "hooks", "dao-fixture.js"), "stub");',   // 夹具变量 root ⇒ 不该进
    'fs.mkdirSync(path.join(REPO, "ccswitch", "hooks"), { recursive: true });', // owned 目录本身不该进
    'const T = path.join(REPO, "ccswitch", "templates", "ISSUE_TEMPLATE");',  // 子目录：.isFile() 挡
    'const S = path.join(REPO, "ccswitch", "skills", "dao-thing", "SKILL.md");',
    'const D = path.join(REPO, "ccswitch", "dao.md");',
  ].join("\n"));
  w(path.join(tests, "beta.tests.js"), [
    'const B = path.resolve(__dirname, "..", "ccswitch", "lib", "beta");',
    'const lib = require("../ccswitch/lib/beta.js");',
    'const mutant = src.replace("a", "b");',
  ].join("\n"));
  w(path.join(tests, "gamma.tests.ps1"), [
    "$g = Join-Path $repoRoot 'ccswitch/templates/check-gamma.mjs'",
    "$s = $t -replace 'a', 'b'",
  ].join("\n"));
  w(path.join(tests, "nomut.tests.js"), [
    'const N = path.join(REPO, "ccswitch", "hooks", "dao-nomut.js");',
    'console.log(N);',
  ].join("\n"));
  w(path.join(tests, "helper.js"), [
    'const N = path.join(REPO, "ccswitch", "hooks", "dao-helperonly.js");',
    'const mutant = src.replace("a", "b");',
  ].join("\n"));
  return root;
}

const EXPECTED = ["ccswitch/hooks/dao-alpha.js", "ccswitch/lib/beta.js", "ccswitch/templates/check-gamma.mjs"];

console.log("\n──── ① 口径 · 正控（合成语料，每一格两侧都有样本）────");
const repoA = makeRepo("repoA");
{
  const r = scanWith(LIB, repoA);
  const got = r.files.map((x) => x.file);
  check("清单恰好是期望的 3 个文件", JSON.stringify(got) === JSON.stringify(EXPECTED), JSON.stringify(got));
  check("计数只数含 mutation 的测试（4 份测试里 3 份含）",
    r.tests === 4 && r.mutationTests === 3, JSON.stringify({ tests: r.tests, mutationTests: r.mutationTests }));
  check("guards 反向可查：dao-alpha.js 记得住是谁在守它",
    r.files[0].guards.join(",") === "alpha.tests.js", JSON.stringify(r.files[0]));
  check("path.resolve 形态认得出（beta 由 path.resolve + require 两路声明）", got.includes("ccswitch/lib/beta.js"));
  check("PS 的 Join-Path $repoRoot + -replace 认得出", got.includes("ccswitch/templates/check-gamma.mjs"));
}

console.log("\n──── ② 口径 · 负控（每条对应上面某一格的另一侧，各用各的谓词）────");
{
  const got = scanWith(LIB, repoA).files.map((x) => x.file);
  check("负控：夹具路径不进清单（path.join(root, …) 的首参不是仓根变量）",
    !got.includes("ccswitch/hooks/dao-fixture.js"), JSON.stringify(got));
  check("负控：owned 目录**本身**不进清单 —— 挡它的是 OWNED_DIRS 的尾斜杠，不是 .isFile()",
    !got.includes("ccswitch/hooks"), JSON.stringify(got));
  check("🔴 负控：owned 目录**之下的子目录**不进清单 —— 这一格挡它的才是 .isFile()",
    !got.includes("ccswitch/templates/ISSUE_TEMPLATE"), JSON.stringify(got));
  check("负控：四类 owned 目录之外不进（skills/ 与 dao.md 都被声明过）",
    !got.some((f) => f.startsWith("ccswitch/skills")) && !got.includes("ccswitch/dao.md"), JSON.stringify(got));
  check("负控：非 *.tests.* 文件整份不扫（helper.js 里同时有声明与 mutation）",
    !got.includes("ccswitch/hooks/dao-helperonly.js"), JSON.stringify(got));
  check("已知边界：有守卫但那份守卫不做 mutation ⇒ 不进清单（口径推论，不是 bug）",
    !got.includes("ccswitch/hooks/dao-nomut.js"), JSON.stringify(got));
}

console.log("\n──── ③ 塌陷可观测：mutationTests>0 而 files==0 ⇒ 调用方必须能认出「瞎了」────");
{
  const root = path.join(TMP, "collapse");
  w(path.join(root, "tests", "ghost.tests.js"), [
    'const G = path.join(REPO, "ccswitch", "hooks", "根本不存在.js");',
    'const mutant = src.replace("a", "b");',
  ].join("\n"));
  const r = scanWith(LIB, root);
  check("有 mutation 测试却一个文件都算不出 ⇒ 返回里两个量分岔（塌陷可被调用方判出）",
    r.mutationTests > 0 && r.files.length === 0, JSON.stringify({ mutationTests: r.mutationTests, files: r.files.length }));
  // 负控：零 mutation 测试 + 零文件 = 正常，不是塌陷
  const empty = path.join(TMP, "empty");
  w(path.join(empty, "tests", "quiet.tests.js"), "console.log(1);\n");
  const e = scanWith(LIB, empty);
  check("负控：零 mutation 测试 + 零文件 ⇒ 两个量都是 0（正常，不是塌陷）",
    e.mutationTests === 0 && e.files.length === 0, JSON.stringify({ mutationTests: e.mutationTests }));
}

console.log("\n──── ④ 真仓冒烟：现算真仓 tests/，关键文件在列 ────");
{
  const r = scanWith(LIB, REPO);
  const got = r.files.map((x) => x.file);
  check("真仓现算非空（空 ⇒ 守卫分支静默永不触发）", got.length > 0, String(got.length));
  check("🔴 含 issue #103 例 2 的当事文件 ccswitch/templates/check-token-drift.mjs（#122 的本体）",
    got.includes("ccswitch/templates/check-token-drift.mjs"), JSON.stringify(got));
  check("每个文件此刻真的在盘上", got.every((f) => fs.existsSync(path.join(REPO, f))),
    JSON.stringify(got.filter((f) => !fs.existsSync(path.join(REPO, f)))));
  check("四类 owned 目录之外的东西没有混进来",
    got.every((f) => /^ccswitch\/(hooks|scripts|lib|templates)\//.test(f)),
    JSON.stringify(got.filter((f) => !/^ccswitch\/(hooks|scripts|lib|templates)\//.test(f))));
}

// ── hook 侧夹具：假树 = ccswitch/hooks/dao-glob-gate.js 副本 + ccswitch/lib/guarded-scan.js + tests/ ──
// hook 按 __dirname 算仓根（../../），故假树要摆这三层。指纹缓存在真 home 的 dao-state/，
// 不同假树指纹互不相同 ⇒ 各自真扫，不互相污染；测试结束后真 hook 重算自愈。
function plantHook(tag, opts) {
  const o = opts || {};
  const rootDir = path.join(TMP, "hooktree", tag);
  const p = path.join(rootDir, "ccswitch", "hooks", "dao-glob-gate.js");
  w(p, o.hookSrc != null ? o.hookSrc : fs.readFileSync(HOOK, "utf8"));
  if (o.lib !== null) w(path.join(rootDir, "ccswitch", "lib", "guarded-scan.js"), o.lib != null ? o.lib : fs.readFileSync(LIB, "utf8"));
  if (o.tests !== null) {
    const tdir = path.join(rootDir, "tests");
    if (o.tests) for (const [name, body] of Object.entries(o.tests)) w(path.join(tdir, name), body);
  }
  // 被测源文件：口径要求「盘上真实存在且是文件」，假树里必须真摆
  if (o.sources !== null) {
    w(path.join(rootDir, "ccswitch", "hooks", "dao-hard-gates.js"), "// stub\n");
    w(path.join(rootDir, "ccswitch", "templates", "check-token-drift.mjs"), "// stub\n");
  }
  return p;
}
// 默认假树的 tests/：含 mutation 的测试声明两个被守护源（源文件由 plantHook 默认摆上）
const DEFAULT_TESTS = {
  "hg.tests.js": 'const H = path.join(REPO, "ccswitch", "hooks", "dao-hard-gates.js");\nconst m = src.replace("a","b");\n',
  "td.tests.js": 'const T = path.join(REPO, "ccswitch", "templates", "check-token-drift.mjs");\nconst m = src.replace("a","b");\n',
};
function fire(filePath, { tool = "Edit", script = HOOK } = {}) {
  const payload = { tool_name: tool, tool_input: filePath === null ? {} : { file_path: filePath } };
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: "utf8" });
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch (_) { /* 无输出即无提醒 */ }
  return { code: r.status, ctx: String((out.hookSpecificOutput || {}).additionalContext || ""), raw: String(r.stdout || "") };
}
const GUARD_NOTE = (c) => /【dao 守卫判据】/.test(c);
const GUARD_POINTER = (c) => /dao-guard-writing\.md/.test(c);

console.log("\n──── ⑤ dao-glob-gate 守卫指针分支 ────");
const planted = plantHook("ok", { tests: DEFAULT_TESTS });
{
  const guardedAbs = "D:/frank/windsurf-dao/ccswitch/templates/check-token-drift.mjs";
  const hit = fire(guardedAbs, { script: planted });
  check("正控：改被守护文件 ⇒ 注入守卫指针", GUARD_NOTE(hit.ctx), JSON.stringify(hit.ctx.slice(-260)));
  check("正控：指针指向判据正文 dao-guard-writing.md，且点名被命中的那个文件",
    GUARD_POINTER(hit.ctx) && /check-token-drift\.mjs/.test(hit.ctx), JSON.stringify(hit.ctx.slice(-260)));
  check("正控：指针**只给指针不复制判据正文**（~0.3KB 量级）",
    hit.ctx.length - fire("D:/frank/windsurf-dao/README.md", { script: planted }).ctx.length < 400,
    String(hit.ctx.length));
  check("🔴 叠加不替换：既有 windsurf-dao 同步提醒分支的话仍在同一段里",
    /仓库文件/.test(hit.ctx) && GUARD_NOTE(hit.ctx), JSON.stringify(hit.ctx.slice(0, 120)));
  check("hook 始终 exit 0（advisory，不阻断）", hit.code === 0);
  check("正控：仓相对路径形态也命中", GUARD_NOTE(fire("ccswitch/templates/check-token-drift.mjs", { script: planted }).ctx));
  check("正控：Windows 反斜杠形态也命中",
    GUARD_NOTE(fire("D:\\frank\\windsurf-dao\\ccswitch\\hooks\\dao-hard-gates.js", { script: planted }).ctx));
  check("正控：worktree 里的同一个文件也命中（后缀匹配）",
    GUARD_NOTE(fire("D:/frank/wd-whatever/ccswitch/hooks/dao-hard-gates.js", { script: planted }).ctx));
  check("正控：Write / MultiEdit 与 Edit 同样触发",
    GUARD_NOTE(fire("ccswitch/hooks/dao-hard-gates.js", { tool: "Write", script: planted }).ctx) &&
    GUARD_NOTE(fire("ccswitch/hooks/dao-hard-gates.js", { tool: "MultiEdit", script: planted }).ctx));

  console.log("  —— 负控 ——");
  check("负控：ccswitch 下但不在清单里的文件不注入（dao.md 不是被守护的源）",
    !GUARD_NOTE(fire("D:/frank/windsurf-dao/ccswitch/dao.md", { script: planted }).ctx));
  check("负控：普通代码文件不注入（只有质量门）", !GUARD_NOTE(fire("D:/proj/src/app.ts", { script: planted }).ctx));
  check("负控：后缀相近但不是同一个文件不命中（xdao-hard-gates.js）",
    !GUARD_NOTE(fire("D:/frank/x/ccswitch/hooks/xdao-hard-gates.js", { script: planted }).ctx));
  check("负控：Read 等非写入工具一律不响", fire("ccswitch/hooks/dao-hard-gates.js", { tool: "Read", script: planted }).raw.trim() === "");
  check("负控：既有四条分支的文案没被波及（settings.json 分支逐字仍在）",
    /providers/.test(fire("C:/Users/t/.claude/settings.json", { script: planted }).ctx));

  console.log("  —— fail-open：lib 读不到/扫描零结果，其余分支照常 ——");
  const noLib = plantHook("nolib", { lib: null, tests: DEFAULT_TESTS });
  check("lib 不存在 ⇒ 不注入守卫指针，但**其余分支照常**（fail-open，不是整个 hook 崩）",
    !GUARD_NOTE(fire("ccswitch/hooks/dao-hard-gates.js", { script: noLib }).ctx) &&
    /【dao-quality 质量门】/.test(fire("D:/proj/src/app.ts", { script: noLib }).ctx));
  const badLib = plantHook("badlib", { lib: "this is not js {{{", tests: DEFAULT_TESTS });
  check("lib 语法坏 ⇒ 同样 fail-open，hook 仍 exit 0",
    !GUARD_NOTE(fire("ccswitch/hooks/dao-hard-gates.js", { script: badLib }).ctx) &&
    fire("ccswitch/hooks/dao-hard-gates.js", { script: badLib }).code === 0);
  const zeroScan = plantHook("zero", { tests: { "q.tests.js": "console.log(1)\n" } });
  check("扫描零结果（无 mutation 测试）⇒ 判为不可用（零结果与「本仓没被守护文件」不可区分，不给绿灯）",
    !GUARD_NOTE(fire("ccswitch/hooks/dao-hard-gates.js", { script: zeroScan }).ctx));

  console.log("  —— --selfcheck：让 fail-open 的失败态在别处看得见 ——");
  const sc = (script) => {
    const r = spawnSync(process.execPath, [script, "--selfcheck"], { encoding: "utf8" });
    return { code: r.status, out: String(r.stdout || "") };
  };
  const scOk = sc(planted);
  check("selfcheck 正态：exit 0 且末行报得出清单可用与条数",
    scOk.code === 0 && /GLOB_GATE_SELFCHECK exit=0 manifest=ok files=[1-9]/.test(scOk.out), scOk.out.slice(-200));
  const scBad = sc(noLib);
  check("selfcheck 负态：lib 不在 ⇒ exit 1 且说清后果",
    scBad.code === 1 && /GLOB_GATE_SELFCHECK exit=1 manifest=bad/.test(scBad.out) && /fail-open/.test(scBad.out), scBad.out.slice(-300));
  const scZero = sc(zeroScan);
  check("selfcheck 对零结果同样报坏（与「lib 读得到」不是同一件事）", scZero.code === 1, scZero.out.slice(-200));
  check("selfcheck 说清口径去处（guarded-scan lib 头注）", /guarded-scan\.js/.test(scOk.out), scOk.out.slice(-300));
}

console.log("\n──── ⑥ mutation 判别力 · guarded-scan 口径（三形态 + 反向）· 每向先 canary ────");
{
  const src = fs.readFileSync(LIB, "utf8");
  // 靶点唯一性：锚点落空与「判据已经不在了」不可区分。锚都是单行表达式，不跨行（CRLF 检出安全）。
  const ROOTVAR_LINE = 'if (!ROOT_VAR.test(m[1])) continue;';
  const OWNED_LINE = 'if (!OWNED_DIRS.some((d) => rel.startsWith(d))) return null;';
  const MUT_CALL = 'if (!hasMutation(text, m[1])) continue;';
  const ISFILE_LINE = 'if (fs.statSync(path.join(repoRoot, cand)).isFile()) return cand;';
  check("靶点①：ROOT_VAR 门在源码里出现 2 次（JS 一处 + PS 一处）", src.split(ROOTVAR_LINE).length - 1 === 2);
  check("靶点②：OWNED_DIRS 门唯一存在", src.split(OWNED_LINE).length === 2);
  check("靶点③：hasMutation 调用点唯一存在", src.split(MUT_CALL).length === 2);
  check("靶点④：.isFile() 门唯一存在", src.split(ISFILE_LINE).length === 2);

  const mutLib = (tag, body) => w(path.join(TMP, "mut", tag + ".js"), body);
  const repoM = makeRepo("repoM");
  const filesOf = (libPath) => scanWith(libPath, repoM).files.length;

  check("mutation 基线：原件在合成语料上算出 3 个文件", filesOf(LIB) === 3);

  // ── 判据 A：ROOT_VAR 门 ──
  {
    const m = mutLib("A1-remove", src.split(ROOTVAR_LINE).join(""));
    check("A1 canary：变异体仍算得出文件", filesOf(m) > 0);
    check("A1（①移除 ROOT_VAR 门）⇒ 夹具路径混进清单，负控断言会红", filesOf(m) > 3);
  }
  {
    const m = mutLib("A2-comment", src.split(ROOTVAR_LINE).join("// " + ROOTVAR_LINE));
    check("A2 canary：变异体仍算得出文件", filesOf(m) > 0);
    check("A2（②注释掉，字面仍在）⇒ 同样变红（行为型守护对这形态不失明）", filesOf(m) > 3);
  }
  {
    const m = mutLib("A3-void", src.split(ROOTVAR_LINE).join('ROOT_VAR.test(m[1]);'));
    check("A3 canary：变异体仍算得出文件", filesOf(m) > 0);
    check("A3（③调用还在、结果没人听）⇒ 同样变红", filesOf(m) > 3);
  }
  {
    const m = mutLib("A4-loose", src.replace("const ROOT_VAR = /^(REPO|ROOT|REPO_ROOT|repoRoot|RepoRoot|__dirname|PSScriptRoot)$/;", "const ROOT_VAR = /./;"));
    check("A4 canary：变异体仍算得出文件", filesOf(m) > 0);
    check("A4（反向·判据放宽成恒真）⇒ 负控断言变红", filesOf(m) > 3);
  }

  // ── 判据 B：OWNED_DIRS 门 ──
  {
    const m = mutLib("B1-remove", src.split(OWNED_LINE).join(""));
    check("B1 canary：变异体仍算得出文件", filesOf(m) > 0);
    check("B1（移除 owned 目录门）⇒ dao.md 与 skills/ 混进来", filesOf(m) > 3);
  }
  {
    const m = mutLib("B2-narrow", src.replace(
      'const OWNED_DIRS = ["ccswitch/hooks/", "ccswitch/scripts/", "ccswitch/lib/", "ccswitch/templates/"];',
      'const OWNED_DIRS = ["ccswitch/hooks/"];'));
    check("B2 canary：变异体仍算得出文件（收窄不是弄死）", filesOf(m) > 0);
    check("B2（反向·门收窄）⇒ 正控断言变红（只剩 1 个文件）", filesOf(m) === 1);
  }

  // ── 判据 C：hasMutation 口径 ──
  {
    const m = mutLib("C1-remove", src.split(MUT_CALL).join(""));
    check("C1 canary：变异体仍算得出文件", filesOf(m) > 0);
    check("C1（移除 mutation 门）⇒ 没有 mutation 的测试也把文件拖进清单", filesOf(m) === 4);
  }
  {
    // C2a：只打瞎 JS 那一支 ⇒ 清单从 3 掉到 1，而「塌陷」判据（mutationTests>0 && files==0）**逮不住**。
    // 🔴 钉的是已知射程缺口：塌陷判据只认整段塌陷，部分失明与「本仓就这么多」长得一样。
    const partial = mutLib("C2a-js-blind", src.replace('return /\\.replace\\s*\\(/.test(text);', "return false;"));
    const rp = scanWith(partial, repoM);
    check("C2a（反向·只瞎 JS 支）⇒ 清单 3→1，塌陷判据不报警 —— 已知射程缺口，照直钉住",
      rp.files.length === 1 && rp.mutationTests > 0, JSON.stringify({ files: rp.files.length, mutationTests: rp.mutationTests }));

    // C2b：整个 hasMutation 恒假 ⇒ mutationTests==0 且 files==0 —— 与「零 mutation 的正常仓」逐字节相同。
    // 照直写：lib 层面这一格**不可区分**；hook 侧把它判坏（零结果不给绿灯），坏的是「可用性」不是「塌陷归因」。
    const m = mutLib("C2b-never", src.replace("function hasMutation(text, ext) {", "function hasMutation(text, ext) { return false;"));
    const rb = scanWith(m, repoM);
    check("C2b（反向·mutation 判据整段恒假）⇒ 两个量都 0：lib 层与「正常空仓」不可区分（照直钉住）",
      rb.mutationTests === 0 && rb.files.length === 0, JSON.stringify({ mutationTests: rb.mutationTests }));
  }

  // ── 判据 D：.isFile() 门 ──
  {
    const m = mutLib("E1-remove", src.split(ISFILE_LINE).join('if (fs.statSync(path.join(repoRoot, cand))) return cand;'));
    check("E1 canary：变异体仍算得出文件", filesOf(m) > 0);
    check("🔴 E1（①移除 .isFile()）⇒ ISSUE_TEMPLATE 子目录混进清单，负控断言变红", filesOf(m) === 4);
  }
  {
    const m = mutLib("E2-comment", src.split(ISFILE_LINE).join(
      "// " + ISFILE_LINE + "\n      if (fs.existsSync(path.join(repoRoot, cand))) return cand;"));
    check("E2 canary：变异体仍算得出文件", filesOf(m) > 0);
    check("E2（②注释掉，字面仍在）⇒ 同样变红", filesOf(m) === 4);
  }
  {
    const m = mutLib("E3-void", src.split(ISFILE_LINE).join(
      'fs.statSync(path.join(repoRoot, cand)).isFile(); return cand;'));
    check("E3 canary：变异体仍算得出文件", filesOf(m) > 0);
    check("E3（③调用还在、结果没人听）⇒ 同样变红", filesOf(m) === 4);
  }
  {
    const m = mutLib("E4-flip", src.split(ISFILE_LINE).join(
      'if (fs.statSync(path.join(repoRoot, cand)).isDirectory()) return cand;'));
    check("E4 canary：变异体仍跑得起来（翻门不是弄死）", filesOf(m) === 1);
    check("E4（反向·门翻成只认目录）⇒ 三条正控断言全红", filesOf(m) === 1);
  }

  check("canary 恒等：整个 mutation 过程 guarded-scan.js 逐字节没动过", sha(LIB) === PRISTINE_LIB);
}

console.log("\n──── ⑦ mutation 判别力 · hook 守卫分支（三形态 + 反向）────");
{
  const src = fs.readFileSync(HOOK, "utf8");
  const HIT_LINE = 'const hit = g.ok ? matchGuarded(norm, g.files) : null;';
  const MATCH_LINE = 'if (normPath === rel || normPath.endsWith("/" + rel)) return rel;';
  check("靶点①：守卫分支的命中赋值行唯一存在", src.split(HIT_LINE).length === 2);
  check("靶点②：matchGuarded 的判定行唯一存在", src.split(MATCH_LINE).length === 2);

  const GUARDED = "ccswitch/hooks/dao-hard-gates.js";
  const plantMut = (tag, body) => plantHook("mut-" + tag, { hookSrc: body, tests: DEFAULT_TESTS });

  {
    const p = plantMut("D1", src.split(HIT_LINE).join("const hit = null;"));
    check("D1 canary：变异体仍跑得起来、其余分支仍响", /【dao-quality 质量门】/.test(fire("D:/proj/src/app.ts", { script: p }).ctx));
    check("D1（①移除命中）⇒ 正控断言变红", !GUARD_NOTE(fire(GUARDED, { script: p }).ctx));
  }
  {
    const p = plantMut("D2", src.split(HIT_LINE).join("// " + HIT_LINE + "\n  const hit = null;"));
    check("D2 canary：变异体仍跑得起来", /【dao-quality 质量门】/.test(fire("D:/proj/src/app.ts", { script: p }).ctx));
    check("D2（②注释掉，字面仍在）⇒ 正控断言变红", !GUARD_NOTE(fire(GUARDED, { script: p }).ctx));
  }
  {
    const p = plantMut("D3", src.split(HIT_LINE).join(
      "const hit = null; if (g.ok) matchGuarded(norm, g.files);"));
    check("D3 canary：变异体仍跑得起来", /【dao-quality 质量门】/.test(fire("D:/proj/src/app.ts", { script: p }).ctx));
    check("D3（③调用还在、结果没人听）⇒ 正控断言变红", !GUARD_NOTE(fire(GUARDED, { script: p }).ctx));
  }
  {
    const p = plantMut("D4", src.split(MATCH_LINE).join("return rel;"));
    check("D4 canary：变异体仍跑得起来、正控仍绿", GUARD_NOTE(fire(GUARDED, { script: p }).ctx));
    check("🔴 D4（反向·匹配恒真）⇒ 负控断言变红：普通代码文件也被提醒",
      GUARD_NOTE(fire("D:/proj/src/app.ts", { script: p }).ctx));
  }
  {
    // D5：零结果被当成可用 —— 删掉「零结果判坏」那行 ⇒ selfcheck 会报 ok files=0
    const ZERO_GUARD = 'if (!files.length) return { ok: false, why: "扫描零结果（tests/ 在却没算出一个被守护文件——口径塌了，不是本仓没有）", files: [] };';
    check("D5 靶点：零结果判坏行唯一存在", src.split(ZERO_GUARD).length === 2, String(src.split(ZERO_GUARD).length - 1));
    const p = src.split(ZERO_GUARD).join("");
    const mutTree = plantHook("mut-D5-tree", { hookSrc: p, tests: { "q.tests.js": "console.log(1)\n" } });
    check("D5 canary：变异体仍跑得起来", /【dao-quality 质量门】/.test(fire("D:/proj/src/app.ts", { script: mutTree }).ctx));
    const r = spawnSync(process.execPath, [mutTree, "--selfcheck"], { encoding: "utf8" });
    check("🔴 D5（反向·零结果被当成可用）⇒ selfcheck 报 ok files=0（本该报 bad——判别力在此）",
      r.status === 0 && /manifest=ok files=0/.test(String(r.stdout || "")), String(r.stdout || "").slice(-160));
  }

  check("canary 恒等：整个 mutation 过程 dao-glob-gate.js 逐字节没动过", sha(HOOK) === PRISTINE_HOOK);
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
