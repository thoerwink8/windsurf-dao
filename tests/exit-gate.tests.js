// tests/exit-gate.tests.js — scripts/dao-exit-gate.mjs 的行为测试（先破再验：每道门都有换靶 mutation）
// 跑法：node tests/exit-gate.tests.js（全绿 exit 0）
// 夹具：_tmp/exit-gate/ 下造合成 git 仓（真 commit、真 diff），交活单为合成 JSON。
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const GATE = path.join(REPO, "scripts", "dao-exit-gate.mjs");
const TMP = path.join(REPO, "_tmp", "exit-gate");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error("git " + args.join(" ") + " => " + r.status + " " + String(r.stderr).slice(0, 200));
  return String(r.stdout || "").trim();
}
function w(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, "utf8"); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// 造一个合成仓：base 分支一个 commit，feature 分支若干 commit；返回 { dir, base, head }
function mkRepo(name, featureFiles) {
  const dir = path.join(TMP, name);
  rm(dir);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "base"]);
  git(dir, ["config", "user.email", "t@t"]); git(dir, ["config", "user.name", "t"]);
  w(path.join(dir, "seed.txt"), "seed\n");
  git(dir, ["add", "."]); git(dir, ["commit", "-qm", "seed"]);
  git(dir, ["branch", "origin/master"]);   // 以本地分支冒充 base ref
  for (const [f, content] of Object.entries(featureFiles)) w(path.join(dir, f), content);
  git(dir, ["add", "."]); git(dir, ["commit", "-qm", "feat"]);
  const head = git(dir, ["rev-parse", "--short", "HEAD"]);
  return { dir, head };
}
function runGate(dir, reportObj, base) {
  const rp = path.join(dir, "report.json");
  if (reportObj !== null) w(rp, JSON.stringify(reportObj));
  const r = spawnSync(process.execPath, [GATE, "--worktree", dir, "--report", rp, "--base", base || "origin/master"], { encoding: "utf8", timeout: 60000 });
  return { code: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
}
const okReport = (head, files) => ({
  task: "合成任务", commits: [head], verify: [{ cmd: "node --version", exit: 0, seconds: 0.1 }], files,
});

console.log("\n──── ① 全绿形态（正控）────");
{
  const c = mkRepo("green", { "src/a.js": "console.log(1)\n" });
  const r = runGate(c.dir, okReport(c.head, ["src/a.js"]));
  check("干净交付 → exit 0", r.code === 0, r.out.slice(-400));
  check("末行 EXIT_GATE_SUMMARY exit=0", /EXIT_GATE_SUMMARY exit=0/.test(r.out), r.out.slice(-200));
}

console.log("\n──── ② 门 1 格式（负控逐个缺字段）────");
{
  const c = mkRepo("shape", { "src/a.js": "x\n" });
  for (const [label, mutate] of [
    ["缺 task", (r) => { delete r.task; }],
    ["commits 空数组", (r) => { r.commits = []; }],
    ["verify 缺 exit", (r) => { delete r.verify[0].exit; }],
    ["files 带反斜杠", (r) => { r.files = ["src\\a.js"]; }],
  ]) {
    const rep = okReport(c.head, ["src/a.js"]); mutate(rep);
    const r = runGate(c.dir, rep);
    check(`门1：${label} → exit 1`, r.code === 1, r.out.slice(-300));
  }
  const r0 = runGate(c.dir, null);
  // null 会写出 "null" 文本——不是合法交活单对象
  check("门1：单内容不是对象 → exit 1 或 3（红/没交单，绝不 0）", r0.code === 1 || r0.code === 3, String(r0.code));
}
{
  // 没交单：路径指向不存在的文件 → exit 3（与「交了红单」分得开）
  const c = mkRepo("noreport", { "src/a.js": "x\n" });
  const r = spawnSync(process.execPath, [GATE, "--worktree", c.dir, "--report", path.join(c.dir, "nope.json")], { encoding: "utf8" });
  check("交不出单 → exit 3（不是 1）", r.status === 3, String(r.status));
  check("末行说清这是「没交单」", /没交单/.test(String(r.stdout)), String(r.stdout).slice(-300));
}

console.log("\n──── ③ 门 2 凭据（commit 与文件清单对账）────");
{
  const c = mkRepo("cred", { "src/a.js": "x\n", "src/b.js": "y\n" });
  const r1 = runGate(c.dir, okReport("deadbeef", ["src/a.js", "src/b.js"]));
  check("门2：commit 不存在 → 红", r1.code === 1 && /commit 不存在/.test(r1.out), r1.out.slice(-300));
  const r2 = runGate(c.dir, okReport(c.head, ["src/a.js"]));
  check("门2：盘上改了 b.js 而单上漏报 → 红", r2.code === 1 && /没报：src\/b\.js/.test(r2.out), r2.out.slice(-300));
  const r3 = runGate(c.dir, okReport(c.head, ["src/a.js", "src/b.js", "src/extra.js"]));
  check("门2：多报不判红、但出声", r3.code === 0 && /多报不判红/.test(r3.out), r3.out.slice(-400));
}

console.log("\n──── ④ 门 3 边界 + 门 4 卫生 + 护栏证据格 ────");
{
  const c = mkRepo("forbidden", { "config-sync/common-secrets.json": "{}\n" });
  const r = runGate(c.dir, okReport(c.head, ["config-sync/common-secrets.json"]));
  check("门3：禁区路径（secrets）→ 红", r.code === 1 && /禁区/.test(r.out), r.out.slice(-300));
}
{
  const c = mkRepo("hygiene", { "src/a.js": "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n" });
  const r = runGate(c.dir, okReport(c.head, ["src/a.js"]));
  check("门4：冲突标记 → 红", r.code === 1 && /冲突标记/.test(r.out), r.out.slice(-300));
}
{
  const c = mkRepo("leakkey", { "src/a.js": 'const k = "sk-1234567890abcdefghijklmnop"\n' });
  const r = runGate(c.dir, okReport(c.head, ["src/a.js"]));
  check("门4：疑似真实密钥形态 → 红", r.code === 1 && /密钥/.test(r.out), r.out.slice(-300));
}
{
  const c = mkRepo("guard", { "ccswitch/hooks/dao-x.js": "module.exports=1\n" });
  const noEv = runGate(c.dir, okReport(c.head, ["ccswitch/hooks/dao-x.js"]));
  check("护栏：触及 hooks/ 缺 guardEvidence → 红", noEv.code === 1 && /guardEvidence/.test(noEv.out), noEv.out.slice(-300));
  const withEv = runGate(c.dir, Object.assign(okReport(c.head, ["ccswitch/hooks/dao-x.js"]), { guardEvidence: "改坏→红，复原→绿，两态都见过" }));
  check("护栏：带证据格 → 过（内容归终审读，门只查存在）", withEv.code === 0, withEv.out.slice(-300));
}

console.log("\n──── ⑤ 门 5 限时重放（白名单/复现红/未验不红）────");
{
  const c = mkRepo("replay", { "src/a.js": "x\n", "tests/tiny.tests.js": "console.log('=== 汇总: PASS=1 FAIL=0 ===');\n" });
  const good = okReport(c.head, ["src/a.js", "tests/tiny.tests.js"]);
  good.verify = [{ cmd: "node tests/tiny.tests.js", exit: 0, seconds: 0.2 }];
  const r1 = runGate(c.dir, good);
  check("白名单命令复现绿 → 过", r1.code === 0, r1.out.slice(-300));
  const bad = okReport(c.head, ["src/a.js", "tests/tiny.tests.js"]);
  bad.verify = [{ cmd: "node tests/tiny.tests.js", exit: 1, seconds: 0.2 }];  // 谎报：盘上其实 exit 0
  const r2 = runGate(c.dir, bad);
  check("单上 exit 与盘上复现不符 → 红（工兵的话一概不信）", r2.code === 1 && /复现 exit=0/.test(r2.out), r2.out.slice(-300));
  const slow = okReport(c.head, ["src/a.js", "tests/tiny.tests.js"]);
  slow.verify = [{ cmd: "node scripts/run-tests.mjs", exit: 0, seconds: 300 }];
  const r3 = runGate(c.dir, slow);
  check("非白名单命令 → 记「未验」不记红", r3.code === 0 && /未验/.test(r3.out), r3.out.slice(-300));
}

console.log("\n──── ⑥ 先破再验（换靶 mutation：每道门关掉一次，对应负控必须变绿）────");
{
  // 把禁区表清空 ⇒ 「禁区路径」负控应变绿（守的是门 3 真的有判别力）
  const src = fs.readFileSync(GATE, "utf8");
  const mutated = src.replace(/const FORBIDDEN = \[[^\]]*\];/, "const FORBIDDEN = [];");
  check("mutation 前提：源码锚点还在（FORBIDDEN 表声明）", mutated !== src, "锚点漂移——本段mutation失效");
  if (mutated !== src) {
    const bak = GATE + ".bak";
    fs.copyFileSync(GATE, bak);
    try {
      fs.writeFileSync(GATE, mutated, "utf8");
      const c = mkRepo("mut-forbidden", { "config-sync/common-secrets.json": "{}\n" });
      const r = runGate(c.dir, okReport(c.head, ["config-sync/common-secrets.json"]));
      check("换靶：禁区表清空后，secrets 文件不再红（证明门 3 是它在拦）", r.code === 0, r.out.slice(-300));
    } finally {
      fs.copyFileSync(bak, GATE); fs.rmSync(bak, { force: true });
    }
    const verify = fs.readFileSync(GATE, "utf8");
    check("复原：字节级还原（diff 干净）", verify === src, "mutation 残留！");
  }
}

rm(TMP);
console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
