// guarded-files 回归网 — 清单生成器口径 + dao-glob-gate 守卫指针分支（issue #122）
//
// 跑法：node tests/guarded-files.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 这份网守着两个新判据 ─────────────────────────────────────────────────────
// ① `ccswitch/scripts/gen-guarded-files.mjs` 的**口径**：谁算「被 mutation 守护的源文件」。
// ② `ccswitch/hooks/dao-glob-gate.js` 的**守卫指针分支**：Edit/Write 命中清单即注入一行指针。
//
// ── 为什么合成语料而不是只拿真仓测 ─────────────────────────────────────────
// 口径的每一格（仓根变量 vs 夹具变量 / owned 目录 / 文件 vs 目录 / 有没有 mutation）
// 在真仓里都**只有一侧有样本**，两侧齐全的语料只能自己造。真仓那一侧另有一组冒烟断言
// （§⑤），它答的是另一个问题：「盘上那份清单此刻是不是最新的」。
//
// ── mutation 覆盖（照 dao-officer-clauses 对抗验证官节「改坏多形态」）────────
// 每个承重判据都跑**三形态 + 反向**：①移除 ②保留字面但不执行 ③保留调用但结果不被消费；
// 反向 = 把判据改**松**（恒命中 / 恒真），用来验负控断言真的会红。
// 每个变异体先跑 canary 确认「它还活着」——一个被弄死的靶会让每条断言都红，
// 而那正是「判别力满分」的表象。
//
// ── 已知不覆盖，照直写 ──────────────────────────────────────────────────────
// · 不验「宿主真的会在 Edit 之后调用这个 hook」——那是 settings.json 注册面，归
//   dead-gates / settings-drift，且注册本身是用户动作。
// · 不验「注入之后官真的照做了」——回测报告已把这一格标死（送达≠遵守）。

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const GEN = path.join(REPO, "ccswitch", "scripts", "gen-guarded-files.mjs");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-glob-gate.js");
const MANIFEST = path.join(REPO, "ccswitch", "guarded-files.json");
const TMP = path.join(REPO, "_tmp", "guarded-files-tests");

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}
function sha(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
function w(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
  return p;
}
function runGen(args, script) {
  const r = spawnSync(process.execPath, [script || GEN, ...args], { encoding: "utf8" });
  const out = String(r.stdout || "") + String(r.stderr || "");
  const m = /GUARDED_FILES_SUMMARY exit=(\d+) tests=(\d+) mutation_tests=(\d+) files=(\d+) drift=(\w+) wrote=(\d)/.exec(out);
  return { code: r.status, out, marker: m ? { exit: +m[1], tests: +m[2], mutationTests: +m[3], files: +m[4], drift: m[5], wrote: +m[6] } : null };
}

const PRISTINE_GEN = sha(GEN);
const PRISTINE_HOOK = sha(HOOK);

// ── 合成语料：一棵假仓，每一格的两侧都有样本 ─────────────────────────────────
// 造完之后**期望清单是确定的 3 个文件**，下面每条断言都是对这个期望的一个切面。
function makeRepo(tag) {
  const root = path.join(TMP, tag);
  // 被测源：三个该进清单的 + 三个不该进的
  w(path.join(root, "ccswitch", "hooks", "dao-alpha.js"), "// alpha\n");
  w(path.join(root, "ccswitch", "lib", "beta.js"), "// beta\n");
  w(path.join(root, "ccswitch", "templates", "check-gamma.mjs"), "// gamma\n");
  w(path.join(root, "ccswitch", "hooks", "dao-nomut.js"), "// 没有 mutation 测试守它\n");
  w(path.join(root, "ccswitch", "skills", "dao-thing", "SKILL.md"), "# 不在四类 owned 目录里\n");
  w(path.join(root, "ccswitch", "dao.md"), "# 不在四类 owned 目录里\n");

  const tests = path.join(root, "tests");
  // ① 含 mutation + 以仓根变量声明 ⇒ 进清单
  w(path.join(tests, "alpha.tests.js"), [
    'const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-alpha.js");',
    'const mutant = src.replace("x", "y");',
    // 夹具写入：第一个参数是 root（不是仓根变量）⇒ 这一条不该把 dao-nomut.js 拖进清单
    'w(path.join(root, "ccswitch", "hooks", "dao-nomut.js"), "stub");',
    // 目录不该进（它不是文件）
    'fs.mkdirSync(path.join(REPO, "ccswitch", "hooks"), { recursive: true });',
    // 非 owned 目录不该进
    'const S = path.join(REPO, "ccswitch", "skills", "dao-thing", "SKILL.md");',
    'const D = path.join(REPO, "ccswitch", "dao.md");',
  ].join("\n"));
  // ② path.resolve + require 两种形态（PR 前实测过：只认 path.join 会漏掉真实用法）
  w(path.join(tests, "beta.tests.js"), [
    'const B = path.resolve(__dirname, "..", "ccswitch", "lib", "beta");',
    'const lib = require("../ccswitch/lib/beta.js");',
    'const mutant = src.replace("a", "b");',
  ].join("\n"));
  // ③ PS 侧：-replace + Join-Path $repoRoot
  w(path.join(tests, "gamma.tests.ps1"), [
    "$g = Join-Path $repoRoot 'ccswitch/templates/check-gamma.mjs'",
    "$s = $t -replace 'a', 'b'",
  ].join("\n"));
  // ④ 无 mutation：声明了 dao-nomut.js，但整份文件没有任何 mutation ⇒ 不该进清单
  w(path.join(tests, "nomut.tests.js"), [
    'const N = path.join(REPO, "ccswitch", "hooks", "dao-nomut.js");',
    'console.log(N);',
  ].join("\n"));
  // ⑤ 非测试文件：同样的内容，但文件名不是 *.tests.* ⇒ 整份不该被扫
  w(path.join(tests, "helper.js"), [
    'const N = path.join(REPO, "ccswitch", "hooks", "dao-nomut.js");',
    'const mutant = src.replace("a", "b");',
  ].join("\n"));
  return root;
}

const EXPECTED = ["ccswitch/hooks/dao-alpha.js", "ccswitch/lib/beta.js", "ccswitch/templates/check-gamma.mjs"];

console.log("\n──── ① 生成器口径 · 正控（合成语料，每一格两侧都有样本）────");
const repoA = makeRepo("repoA");
{
  const r = runGen(["--repo", repoA]);
  check("生成成功 exit 0 且末行 marker 存在", r.code === 0 && !!r.marker, JSON.stringify(r.marker) + r.out.slice(0, 200));
  const doc = JSON.parse(fs.readFileSync(path.join(repoA, "ccswitch", "guarded-files.json"), "utf8"));
  const got = doc.files.map((x) => x.file);
  check("清单恰好是期望的 3 个文件", JSON.stringify(got) === JSON.stringify(EXPECTED), JSON.stringify(got));
  check("末行 files= 与正文条数一致（marker 不是另算的）", r.marker.files === got.length, JSON.stringify(r.marker));
  check("mutation_tests 计数只数含 mutation 的测试（4 份测试里 3 份含）",
    r.marker.tests === 4 && r.marker.mutationTests === 3, JSON.stringify(r.marker));
  check("guards 反向可查：dao-alpha.js 记得住是谁在守它",
    doc.files[0].guards.join(",") === "alpha.tests.js", JSON.stringify(doc.files[0]));
  check("path.resolve 形态认得出（beta 由 path.resolve + require 两路声明）",
    got.includes("ccswitch/lib/beta.js"));
  check("PS 的 Join-Path $repoRoot + -replace 认得出",
    got.includes("ccswitch/templates/check-gamma.mjs"));
  check("产物自陈是派生物（读者拿到它就知道别手改）",
    /派生物/.test(doc._generated["这是什么"]) && doc._generated["再生成"].includes("gen-guarded-files.mjs"),
    JSON.stringify(doc._generated).slice(0, 200));
}

console.log("\n──── ② 生成器口径 · 负控 / 已知边界（每条都对应上面某一格的另一侧）────");
{
  const doc = JSON.parse(fs.readFileSync(path.join(repoA, "ccswitch", "guarded-files.json"), "utf8"));
  const got = doc.files.map((x) => x.file);
  check("负控：夹具路径不进清单（path.join(root, …) 的首参不是仓根变量）",
    !got.includes("ccswitch/hooks/dao-nomut.js"), JSON.stringify(got));
  check("负控：目录不进清单（ccswitch/hooks 本身被声明过）",
    !got.includes("ccswitch/hooks"), JSON.stringify(got));
  check("负控：四类 owned 目录之外不进（skills/ 与 dao.md 都被声明过）",
    !got.some((f) => f.startsWith("ccswitch/skills")) && !got.includes("ccswitch/dao.md"), JSON.stringify(got));
  check("负控：非 *.tests.* 文件整份不扫（helper.js 里同时有声明与 mutation）",
    !got.includes("ccswitch/hooks/dao-nomut.js"));
  check("已知边界：有守卫但那份守卫不做 mutation ⇒ 不进清单（这是口径的推论，不是 bug）",
    !got.includes("ccswitch/hooks/dao-nomut.js"));
}

console.log("\n──── ③ --check 三态 + 幂等 + 行尾容忍 ────");
{
  const clean = runGen(["--repo", repoA, "--check"]);
  check("一致 ⇒ exit 0 / drift=none", clean.code === 0 && clean.marker.drift === "none", JSON.stringify(clean.marker));

  // 幂等：再生成一次，逐字节相同
  const before = fs.readFileSync(path.join(repoA, "ccswitch", "guarded-files.json"));
  runGen(["--repo", repoA, "--quiet"]);
  const after = fs.readFileSync(path.join(repoA, "ccswitch", "guarded-files.json"));
  check("幂等：连跑两次产物逐字节相同", Buffer.compare(before, after) === 0);

  // 行尾容忍：把盘上那份换成 CRLF，--check 仍须绿（core.autocrlf 的机器一 checkout 就是这样）
  const p = path.join(repoA, "ccswitch", "guarded-files.json");
  const lf = fs.readFileSync(p, "utf8");
  fs.writeFileSync(p, lf.split("\n").join("\r\n"), "utf8");
  const crlf = runGen(["--repo", repoA, "--check"]);
  check("CRLF 检出仍判一致（判据是内容不是行尾）", crlf.code === 0, JSON.stringify(crlf.marker));
  fs.writeFileSync(p, lf, "utf8");

  // 漂移①：新增一份 mutation 测试，多守一个文件 ⇒ 必须报「新进清单」
  w(path.join(repoA, "ccswitch", "scripts", "check-delta.mjs"), "// delta\n");
  w(path.join(repoA, "tests", "delta.tests.js"), [
    'const D = path.join(REPO, "ccswitch", "scripts", "check-delta.mjs");',
    'const mutant = src.replace("a", "b");',
  ].join("\n"));
  const drift = runGen(["--repo", repoA, "--check"]);
  check("测试实况变了而清单没跟上 ⇒ exit 1 / drift=content",
    drift.code === 1 && drift.marker.drift === "content", JSON.stringify(drift.marker));
  check("报文逐条点名「新进清单」是哪个文件（不是只说一句「过期了」）",
    /新进清单/.test(drift.out) && /check-delta\.mjs/.test(drift.out), drift.out.slice(0, 400));
  check("报文给出修法且明说它一定解得掉（派生物的处方是确定的）",
    /gen-guarded-files\.mjs/.test(drift.out) && /一定解得掉/.test(drift.out), drift.out.slice(-400));

  // 漂移②：反向 —— 一份测试的 mutation 没了，守护对象该**掉出**清单并被点名
  runGen(["--repo", repoA, "--quiet"]);                       // 先追平
  w(path.join(repoA, "tests", "delta.tests.js"),
    'const D = path.join(REPO, "ccswitch", "scripts", "check-delta.mjs");\nconsole.log(D);');
  const retire = runGen(["--repo", repoA, "--check"]);
  check("退役方向也报得出：mutation 没了 ⇒ 该文件掉出清单并被点名",
    retire.code === 1 && /掉出清单/.test(retire.out) && /check-delta\.mjs/.test(retire.out),
    retire.out.slice(0, 400));
  check("退役报文追问一句「是有意退役还是被顺手删了」（这是给退役造的触发器）",
    /有意退役/.test(retire.out), retire.out.slice(0, 400));

  // 漂移③：清单文件根本不存在
  const repoB = makeRepo("repoB");
  const missing = runGen(["--repo", repoB, "--check"]);
  check("清单不存在 ⇒ exit 1 / drift=missing（不是静默当成一致）",
    missing.code === 1 && missing.marker.drift === "missing", JSON.stringify(missing.marker));
}

console.log("\n──── ④ 自检：扫描面塌陷必须 exit 5，且**不写盘** ────");
{
  // 造一份「有 mutation 测试、但一个被守护源文件都算不出来」的语料：
  // 测试里的声明全部指向不存在的文件 ⇒ 主解析算出 0。
  // 这一格是「零检出 ≠ 零存在」在本脚本上的形态：0 个文件既可能是真的没有，也可能是它瞎了。
  const root = path.join(TMP, "collapse");
  w(path.join(root, "tests", "ghost.tests.js"), [
    'const G = path.join(REPO, "ccswitch", "hooks", "根本不存在.js");',
    'const mutant = src.replace("a", "b");',
  ].join("\n"));
  const r = runGen(["--repo", root]);
  check("笨计数器看得到 mutation 测试而主解析算出 0 个文件 ⇒ exit 5",
    r.code === 5 && r.marker.exit === 5, JSON.stringify(r.marker) + r.out.slice(0, 200));
  check("塌陷时**不写盘**（写一份空清单进仓 = 亲手把消费方那条分支关掉）",
    !fs.existsSync(path.join(root, "ccswitch", "guarded-files.json")));
  check("塌陷报文明说「这不是本仓很干净，是它瞎了」",
    /瞎了/.test(r.out) && /别把这次的 0 当通过/.test(r.out), r.out.slice(0, 300));

  // 负控（同伴用例）：**结构上不可能塌陷**的一格 —— 语料里连 mutation 测试都没有。
  // 它钉住的是「exit 5 的条件是两个量分岔」，不是「凡是 0 个文件就报 5」。
  const empty = path.join(TMP, "empty");
  w(path.join(empty, "tests", "quiet.tests.js"), "console.log(1);\n");
  const e = runGen(["--repo", empty]);
  check("负控：零 mutation 测试 + 零文件 ⇒ 正常 exit 0（不是 5）",
    e.code === 0 && e.marker.files === 0 && e.marker.mutationTests === 0, JSON.stringify(e.marker));

  // tests 目录不存在这一格要与上面两种都分得开
  const nodir = runGen(["--repo", path.join(TMP, "nope")]);
  check("tests 目录不存在 ⇒ exit 2（与 0 / 1 / 5 都分得开）", nodir.code === 2, JSON.stringify(nodir.marker));
}

console.log("\n──── ⑤ 真仓冒烟：盘上那份清单此刻是不是最新的 ────");
{
  const r = runGen(["--check"]);
  check("盘上 ccswitch/guarded-files.json 与本仓测试实况一致（漂了就在这里红）",
    r.code === 0, r.out.slice(0, 600));
  const doc = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const got = doc.files.map((x) => x.file);
  check("清单非空（空清单会让消费方那条分支静默永不触发）", got.length > 0, String(got.length));
  // 🔴 这一条是 issue #122 的本体：读触发那份 glob 恰好漏掉的就是它。
  check("🔴 含 issue #103 例 2 的当事文件 ccswitch/templates/check-token-drift.mjs",
    got.includes("ccswitch/templates/check-token-drift.mjs"), JSON.stringify(got));
  check("清单里的每个文件此刻真的在盘上（指向空气的条目要当场现形）",
    got.every((f) => fs.existsSync(path.join(REPO, f))), JSON.stringify(got.filter((f) => !fs.existsSync(path.join(REPO, f)))));
  check("四类 owned 目录之外的东西没有混进来",
    got.every((f) => /^ccswitch\/(hooks|scripts|lib|templates)\//.test(f)),
    JSON.stringify(got.filter((f) => !/^ccswitch\/(hooks|scripts|lib|templates)\//.test(f))));
}

// ── hook 侧：把 hook 副本连同一份清单摆进一棵假树，__dirname/../guarded-files.json 才解析得到 ──
function plantHook(tag, { hookSrc, manifest } = {}) {
  const rootDir = path.join(TMP, "hooktree", tag);
  const p = path.join(rootDir, "hooks", "dao-glob-gate.js");
  w(p, hookSrc != null ? hookSrc : fs.readFileSync(HOOK, "utf8"));
  if (manifest !== null) {
    w(path.join(rootDir, "guarded-files.json"), manifest != null ? manifest : fs.readFileSync(MANIFEST, "utf8"));
  }
  return p;
}
function fire(filePath, { tool = "Edit", script = HOOK } = {}) {
  const payload = { tool_name: tool, tool_input: filePath === null ? {} : { file_path: filePath } };
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: "utf8" });
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch (_) { /* 无输出即无提醒 */ }
  return { code: r.status, ctx: String((out.hookSpecificOutput || {}).additionalContext || ""), raw: String(r.stdout || "") };
}
const GUARD_NOTE = (c) => /【dao 守卫判据】/.test(c);
const GUARD_POINTER = (c) => /dao-guard-writing\.md/.test(c);

console.log("\n──── ⑥ dao-glob-gate 守卫指针分支 ────");
const planted = plantHook("ok");
{
  const guardedAbs = "D:/frank/windsurf-dao/ccswitch/templates/check-token-drift.mjs";
  const hit = fire(guardedAbs, { script: planted });
  check("正控：改被守护文件 ⇒ 注入守卫指针", GUARD_NOTE(hit.ctx), JSON.stringify(hit.ctx.slice(-260)));
  check("正控：指针指向判据正文 dao-guard-writing.md，且点名被命中的那个文件",
    GUARD_POINTER(hit.ctx) && /check-token-drift\.mjs/.test(hit.ctx), JSON.stringify(hit.ctx.slice(-260)));
  check("正控：指针**只给指针不复制判据正文**（长度量级 ~0.3KB，不是一段说明）",
    hit.ctx.length - fire("D:/frank/windsurf-dao/README.md", { script: planted }).ctx.length < 400,
    String(hit.ctx.length));
  check("🔴 叠加不替换：既有 windsurf-dao 同步提醒分支的话仍在同一段里",
    /仓库文件/.test(hit.ctx) && GUARD_NOTE(hit.ctx), JSON.stringify(hit.ctx.slice(0, 120)));
  check("hook 始终 exit 0（advisory，不阻断）", hit.code === 0);

  check("正控：仓相对路径形态也命中（tool_input 未必是绝对路径）",
    GUARD_NOTE(fire("ccswitch/templates/check-token-drift.mjs", { script: planted }).ctx));
  check("正控：Windows 反斜杠形态也命中",
    GUARD_NOTE(fire("D:\\frank\\windsurf-dao\\ccswitch\\hooks\\dao-hard-gates.js", { script: planted }).ctx));
  check("正控：worktree 里的同一个文件也命中（前缀不同、仓相对后缀相同）",
    GUARD_NOTE(fire("D:/frank/wd-whatever/ccswitch/hooks/dao-hard-gates.js", { script: planted }).ctx));
  check("正控：Write / MultiEdit 与 Edit 同样触发",
    GUARD_NOTE(fire("ccswitch/hooks/dao-hard-gates.js", { tool: "Write", script: planted }).ctx) &&
    GUARD_NOTE(fire("ccswitch/hooks/dao-hard-gates.js", { tool: "MultiEdit", script: planted }).ctx));

  console.log("  —— 负控 ——");
  check("负控：ccswitch 下但不在清单里的文件不注入（dao.md 不是被 mutation 守护的源）",
    !GUARD_NOTE(fire("D:/frank/windsurf-dao/ccswitch/dao.md", { script: planted }).ctx),
    JSON.stringify(fire("D:/frank/windsurf-dao/ccswitch/dao.md", { script: planted }).ctx.slice(0, 100)));
  check("负控：普通代码文件不注入（只有质量门）",
    !GUARD_NOTE(fire("D:/proj/src/app.ts", { script: planted }).ctx));
  check("负控：后缀相近但不是同一个文件不命中（xdao-hard-gates.js）",
    !GUARD_NOTE(fire("D:/frank/x/ccswitch/hooks/xdao-hard-gates.js", { script: planted }).ctx));
  check("负控：Read 等非写入工具一律不响", fire("ccswitch/hooks/dao-hard-gates.js", { tool: "Read", script: planted }).raw.trim() === "");
  check("负控：既有四条分支的文案没被这次改动波及（settings.json 分支逐字仍在）",
    /providers/.test(fire("C:/Users/t/.claude/settings.json", { script: planted }).ctx));

  console.log("  —— fail-open：清单读不到/坏了，其余分支照常 ——");
  const noManifest = plantHook("nomanifest", { manifest: null });
  check("清单不存在 ⇒ 不注入守卫指针，但**其余分支照常**（fail-open，不是整个 hook 崩）",
    !GUARD_NOTE(fire("ccswitch/hooks/dao-hard-gates.js", { script: noManifest }).ctx) &&
    /【dao-quality 质量门】/.test(fire("D:/proj/src/app.ts", { script: noManifest }).ctx));
  const badJson = plantHook("badjson", { manifest: "{ 这不是 JSON" });
  check("清单不是合法 JSON ⇒ 同样 fail-open，hook 仍 exit 0",
    !GUARD_NOTE(fire("ccswitch/hooks/dao-hard-gates.js", { script: badJson }).ctx) &&
    fire("ccswitch/hooks/dao-hard-gates.js", { script: badJson }).code === 0);
  const emptyList = plantHook("emptylist", { manifest: '{"files":[]}' });
  check("清单是空的 ⇒ 判为不可用（空清单与「本仓没有被守护文件」不可区分，不给绿灯）",
    !GUARD_NOTE(fire("ccswitch/hooks/dao-hard-gates.js", { script: emptyList }).ctx));

  console.log("  —— --selfcheck：让 fail-open 的失败态在别处看得见 ——");
  const sc = (script) => {
    const r = spawnSync(process.execPath, [script, "--selfcheck"], { encoding: "utf8" });
    return { code: r.status, out: String(r.stdout || "") };
  };
  const scOk = sc(planted);
  check("selfcheck 正态：exit 0 且末行报得出清单可用与条数",
    scOk.code === 0 && /GLOB_GATE_SELFCHECK exit=0 manifest=ok files=[1-9]/.test(scOk.out), scOk.out.slice(-200));
  const scBad = sc(noManifest);
  check("selfcheck 负态：清单不在 ⇒ exit 1 且说清后果与修法",
    scBad.code === 1 && /GLOB_GATE_SELFCHECK exit=1 manifest=bad/.test(scBad.out) &&
    /fail-open/.test(scBad.out) && /gen-guarded-files\.mjs/.test(scBad.out), scBad.out.slice(-300));
  const scEmpty = sc(emptyList);
  check("selfcheck 对空清单同样报坏（与「读得到文件」不是同一件事）",
    scEmpty.code === 1, scEmpty.out.slice(-200));
  check("selfcheck 明说它证不了什么（清单内容对不对归 --check）",
    /--check/.test(scOk.out), scOk.out.slice(-300));
}

console.log("\n──── ⑦ mutation 判别力 · 生成器（三形态 + 反向）· 每向先 canary ────");
{
  const src = fs.readFileSync(GEN, "utf8");
  // 靶点唯一性：锚点落空与「判据已经不在了」不可区分（issue #103 的病）。
  // 三个锚都是**单行**表达式，刻意不跨行 —— 跨行锚点写死 \n 在 CRLF 检出下恒不命中。
  const ROOTVAR_LINE = 'if (!ROOT_VAR.test(m[1])) continue;';
  const OWNED_LINE = 'if (!OWNED_DIRS.some((d) => rel.startsWith(d))) return null;';
  const MUT_CALL = 'if (!hasMutation(text, m[1])) continue;';
  check("靶点①：ROOT_VAR 门在源码里出现 2 次（JS 一处 + PS 一处，两处都要被验到）",
    src.split(ROOTVAR_LINE).length - 1 === 2, String(src.split(ROOTVAR_LINE).length - 1));
  check("靶点②：OWNED_DIRS 门唯一存在", src.split(OWNED_LINE).length === 2);
  check("靶点③：hasMutation 调用点唯一存在", src.split(MUT_CALL).length === 2);

  const mutGen = (tag, body) => w(path.join(TMP, "mut", tag + ".mjs"), body);
  const repoM = makeRepo("repoM");
  const filesOf = (r) => (r.marker ? r.marker.files : -1);

  // 基线：原件在这份语料上是 3 个文件
  check("mutation 基线：原件在合成语料上算出 3 个文件", filesOf(runGen(["--repo", repoM, "--quiet"])) === 3);

  // ── 判据 A：ROOT_VAR 门（夹具路径不该进清单）──────────────────────────────
  // 形态①移除
  {
    const m = mutGen("A1-remove", src.split(ROOTVAR_LINE).join(""));
    const r = runGen(["--repo", repoM, "--quiet", "--out", path.join(TMP, "mut", "A1.json")], m);
    check("A1 canary：变异体仍跑得起来、仍算得出文件（不是把靶弄死了）", filesOf(r) > 0, JSON.stringify(r.marker));
    check("A1（①移除 ROOT_VAR 门）⇒ 夹具路径混进清单，负控断言会红", filesOf(r) > 3, JSON.stringify(r.marker));
  }
  // 形态②保留字面但不执行
  {
    const m = mutGen("A2-comment", src.split(ROOTVAR_LINE).join("// " + ROOTVAR_LINE));
    const r = runGen(["--repo", repoM, "--quiet", "--out", path.join(TMP, "mut", "A2.json")], m);
    check("A2 canary：变异体仍算得出文件", filesOf(r) > 0, JSON.stringify(r.marker));
    check("A2（②注释掉，字面仍在）⇒ 同样变红（文本匹配型守护对这一形态天然失明，行为型不）",
      filesOf(r) > 3, JSON.stringify(r.marker));
  }
  // 形态③保留调用与副作用，但结果不被消费
  {
    const m = mutGen("A3-void", src.split(ROOTVAR_LINE).join('ROOT_VAR.test(m[1]);'));
    const r = runGen(["--repo", repoM, "--quiet", "--out", path.join(TMP, "mut", "A3.json")], m);
    check("A3 canary：变异体仍算得出文件", filesOf(r) > 0, JSON.stringify(r.marker));
    check("A3（③调用还在、结果没人听）⇒ 同样变红（「门的答案有没有人听」这一向）",
      filesOf(r) > 3, JSON.stringify(r.marker));
  }
  // 反向：把门改**松**（恒真）—— 与①同向但换一种写法，验负控断言不是只对「删掉」敏感
  {
    const m = mutGen("A4-loose", src.replace("const ROOT_VAR = /^(REPO|ROOT|REPO_ROOT|repoRoot|RepoRoot|__dirname|PSScriptRoot)$/;", "const ROOT_VAR = /./;"));
    const r = runGen(["--repo", repoM, "--quiet", "--out", path.join(TMP, "mut", "A4.json")], m);
    check("A4 canary：变异体仍算得出文件", filesOf(r) > 0, JSON.stringify(r.marker));
    check("A4（反向·判据放宽成恒真）⇒ 负控断言变红", filesOf(r) > 3, JSON.stringify(r.marker));
  }

  // ── 判据 B：OWNED_DIRS 门 ────────────────────────────────────────────────
  {
    const m = mutGen("B1-remove", src.split(OWNED_LINE).join(""));
    const r = runGen(["--repo", repoM, "--quiet", "--out", path.join(TMP, "mut", "B1.json")], m);
    check("B1 canary：变异体仍算得出文件", filesOf(r) > 0, JSON.stringify(r.marker));
    check("B1（移除 owned 目录门）⇒ ccswitch/dao.md 与 skills/ 混进来", filesOf(r) > 3, JSON.stringify(r.marker));
  }
  {
    // 反向：把 owned 收窄到只剩 hooks/ ⇒ 正控断言（lib/beta.js、templates/check-gamma.mjs）该红
    const m = mutGen("B2-narrow", src.replace(
      'const OWNED_DIRS = ["ccswitch/hooks/", "ccswitch/scripts/", "ccswitch/lib/", "ccswitch/templates/"];',
      'const OWNED_DIRS = ["ccswitch/hooks/"];'));
    const r = runGen(["--repo", repoM, "--quiet", "--out", path.join(TMP, "mut", "B2.json")], m);
    check("B2 canary：变异体仍算得出文件（收窄不是弄死）", filesOf(r) > 0, JSON.stringify(r.marker));
    check("B2（反向·门收窄）⇒ 正控断言变红（只剩 1 个文件）", filesOf(r) === 1, JSON.stringify(r.marker));
  }

  // ── 判据 C：hasMutation 口径 ─────────────────────────────────────────────
  {
    const m = mutGen("C1-remove", src.split(MUT_CALL).join(""));
    const r = runGen(["--repo", repoM, "--quiet", "--out", path.join(TMP, "mut", "C1.json")], m);
    check("C1 canary：变异体仍算得出文件", filesOf(r) > 0, JSON.stringify(r.marker));
    check("C1（移除 mutation 门）⇒ 没有 mutation 的测试也开始把文件拖进清单", filesOf(r) === 4, JSON.stringify(r.marker));
  }
  {
    // 反向 C2a：**只**打瞎 JS 那一支（PS 支照旧）⇒ 清单从 3 掉到 1，而自检**逮不住**。
    // 🔴 这条断言钉的是一个**已知射程缺口**，不是能力：自检的判据是「笨计数器 > 0 而主解析 == 0」，
    //    它按定义只认**整段**塌陷；部分失明（一半扫描面瞎掉）在它眼里与「本仓就这么多」一样。
    //    留着这条断言是为了让「哪天有人以为自检覆盖了部分失明」这件事被这里的措辞挡回去。
    //    这一格真正的守卫是 §⑤ 那条真仓 `--check`：条数一变它就红。
    const partial = mutGen("C2a-js-blind", src.replace('return /\\.replace\\s*\\(/.test(text);', "return false;"));
    const rp = runGen(["--repo", repoM, "--quiet", "--out", path.join(TMP, "mut", "C2a.json")], partial);
    check("C2a（反向·只瞎掉 JS 那一支）⇒ 清单从 3 掉到 1，**而自检 exit 0 —— 已知射程缺口，照直钉住**",
      rp.code === 0 && filesOf(rp) === 1, JSON.stringify(rp.marker));

    // 反向 C2b：整个 hasMutation 恒假 ⇒ 全面塌陷，自检**必须**把它逮住（exit 5）
    const m = mutGen("C2b-never", src.replace(
      "export function hasMutation(text, ext) {", "export function hasMutation(text, ext) { return false;"));
    const r = runGen(["--repo", repoM, "--quiet", "--out", path.join(TMP, "mut", "C2b.json")], m);
    check("🔴 C2b（反向·mutation 判据整段恒假）⇒ 自检 exit 5 把塌陷逮住，而不是安静地输出一份空清单",
      r.code === 5, JSON.stringify(r.marker) + r.out.slice(0, 200));
    check("C2b：塌陷时不写盘（这一条与 §④ 同判据，换个入口再验一次）",
      !fs.existsSync(path.join(TMP, "mut", "C2b.json")));
  }

  check("canary 恒等：整个 mutation 过程 gen-guarded-files.mjs 逐字节没动过", sha(GEN) === PRISTINE_GEN);
}

console.log("\n──── ⑧ mutation 判别力 · hook 守卫分支（三形态 + 反向）────");
{
  const src = fs.readFileSync(HOOK, "utf8");
  const HIT_LINE = 'const hit = g.ok ? matchGuarded(norm, g.files) : null;';
  const MATCH_LINE = 'if (normPath === rel || normPath.endsWith("/" + rel)) return rel;';
  check("靶点①：守卫分支的命中赋值行唯一存在", src.split(HIT_LINE).length === 2, String(src.split(HIT_LINE).length - 1));
  check("靶点②：matchGuarded 的判定行唯一存在", src.split(MATCH_LINE).length === 2, String(src.split(MATCH_LINE).length - 1));

  const GUARDED = "ccswitch/hooks/dao-hard-gates.js";
  const plantMut = (tag, body) => plantHook("mut-" + tag, { hookSrc: body });

  // ①移除：命中恒为 null
  {
    const p = plantMut("D1", src.split(HIT_LINE).join("const hit = null;"));
    check("D1 canary：变异体仍跑得起来、其余分支仍响", /【dao-quality 质量门】/.test(fire("D:/proj/src/app.ts", { script: p }).ctx));
    check("D1（①移除命中）⇒ 正控断言变红", !GUARD_NOTE(fire(GUARDED, { script: p }).ctx));
  }
  // ②保留字面但不执行
  {
    const p = plantMut("D2", src.split(HIT_LINE).join("// " + HIT_LINE + "\n  const hit = null;"));
    check("D2 canary：变异体仍跑得起来", /【dao-quality 质量门】/.test(fire("D:/proj/src/app.ts", { script: p }).ctx));
    check("D2（②注释掉，字面仍在）⇒ 正控断言变红", !GUARD_NOTE(fire(GUARDED, { script: p }).ctx));
  }
  // ③保留调用与副作用，但结果不被消费
  {
    const p = plantMut("D3", src.split(HIT_LINE).join(
      "const hit = null; if (g.ok) matchGuarded(norm, g.files);"));
    check("D3 canary：变异体仍跑得起来", /【dao-quality 质量门】/.test(fire("D:/proj/src/app.ts", { script: p }).ctx));
    check("D3（③调用还在、结果没人听）⇒ 正控断言变红", !GUARD_NOTE(fire(GUARDED, { script: p }).ctx));
  }
  // 反向：匹配放宽成恒真 ⇒ 负控断言必须变红（不然「凡是文件都提醒」也会全绿）
  {
    const p = plantMut("D4", src.split(MATCH_LINE).join("return rel;"));
    check("D4 canary：变异体仍跑得起来、正控仍绿", GUARD_NOTE(fire(GUARDED, { script: p }).ctx));
    check("🔴 D4（反向·匹配恒真）⇒ 负控断言变红：普通代码文件也被提醒",
      GUARD_NOTE(fire("D:/proj/src/app.ts", { script: p }).ctx));
  }
  // 反向②：把 fail-open 改成 fail-loud 之外的另一侧 —— 清单坏了却当成可用
  {
    const p = plantMut("D5", src.split('if (!files.length) return { ok: false, why: "清单里一个文件都没有(files 缺席或为空)", files: [] };').join(""));
    const empty = plantHook("mut-D5-tree", { hookSrc: fs.readFileSync(p, "utf8"), manifest: '{"files":[]}' });
    check("D5 canary：变异体仍跑得起来", /【dao-quality 质量门】/.test(fire("D:/proj/src/app.ts", { script: empty }).ctx));
    const r = spawnSync(process.execPath, [empty, "--selfcheck"], { encoding: "utf8" });
    check("🔴 D5（反向·空清单被当成可用）⇒ selfcheck 断言变红（它本该报 bad）",
      r.status === 0 && /manifest=ok files=0/.test(String(r.stdout || "")), String(r.stdout || "").slice(-160));
  }

  check("canary 恒等：整个 mutation 过程 dao-glob-gate.js 逐字节没动过", sha(HOOK) === PRISTINE_HOOK);
}

assert.ok(true);
console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
