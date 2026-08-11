// tests/dao-orch.tests.js — scripts/dao-orch.mjs 的行为测试（全程 dry-run / 假 orca，不建真 task）
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const ORCH = path.join(REPO, "scripts", "dao-orch.mjs");
const TMP = path.join(REPO, "_tmp", "dao-orch");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}
function run(args, env) {
  const r = spawnSync(process.execPath, [ORCH, ...args], { encoding: "utf8", cwd: REPO, timeout: 60000, env: Object.assign({}, process.env, env || {}) });
  return { code: r.status, out: String(r.stdout || ""), err: String(r.stderr || "") };
}
function w(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, "utf8"); }

fs.mkdirSync(TMP, { recursive: true });
const SPEC = path.join(TMP, "task.md");
w(SPEC, "把某个函数的参数校验补上，配套测试。\n");

console.log("\n──── ① 拼装形态（dry-run）────");
{
  const r = run(["dispatch", "--role", "implementer", "--spec-file", SPEC, "--issue", "300", "--dry-run"]);
  check("dry-run → exit 0", r.code === 0, r.err.slice(-300));
  check("spec 含四段骨架（条款/验证/交付/任务）",
    /【条款】/.test(r.out) && /【验证】/.test(r.out) && /【交付】/.test(r.out) && /【任务】/.test(r.out), r.out.slice(-600));
  check("条款段真渲出了实现官条款（锚：gh pr create）", /gh pr create/.test(r.out), r.out.slice(-600));
  check("验证段守住「刻意不给验证命令」", /刻意不给验证命令/.test(r.out), r.out.slice(-600));
  check("交付段带交活单 schema 与 exit-gate 机核警告", /dao-exit-gate\.mjs/.test(r.out) && /guardEvidence/.test(r.out), r.out.slice(-600));
  check("--issue 300 ⇒ task 字段写着 issue #300", /issue #300/.test(r.out), r.out.slice(-600));
  check("任务正文原样进入 spec", /参数校验补上/.test(r.out), r.out.slice(-400));
  check("dry-run 不建 task（将执行的命令只打印不执行）", /DRY-RUN：将执行（未执行）/.test(r.out) && !/task_[0-9a-f]{10,}/.test(r.out), r.out.slice(-400));
  check("末行 DAO_ORCH_SUMMARY mode=dry-run", /DAO_ORCH_SUMMARY exit=0 mode=dry-run/.test(r.out), r.out.slice(-200));
}

console.log("\n──── ② 用法错（fail-fast，不碰 Orca）────");
{
  const r1 = run(["dispatch", "--role", "verifier", "--spec-file", SPEC, "--dry-run"]);
  check("非法官种 verifier（经典错词）→ exit 2", r1.code === 2 && /合法取值/.test(r1.err), r1.err.slice(-300));
  const r2 = run(["dispatch", "--role", "implementer"]);
  check("缺 --spec-file → exit 2", r2.code === 2, String(r2.code));
  const r3 = run(["dispatch", "--role", "implementer", "--spec-file", path.join(TMP, "nope.md"), "--dry-run"]);
  check("spec 文件不存在 → exit 2 且点名路径", r3.code === 2 && /nope\.md/.test(r3.err), r3.err.slice(-300));
}

console.log("\n──── ③ 真跑路径的分岔（假 orca，证明 live 模式真的会去调 CLI）────");
{
  // ORCA_BIN 指到不存在的可执行文件 + 非 dry-run ⇒ 必须在 task-create 处失败，而不是悄悄过去
  const r = run(["dispatch", "--role", "scout", "--spec-file", SPEC], { ORCA_BIN: "orca-definitely-not-exists-xyz" });
  check("live 模式调不到 orca → exit 1（不是 0）", r.code === 1, String(r.code) + " " + r.err.slice(-300));
  check("报文点名 task-create 失败", /task-create 失败|ENOENT/.test(r.err), r.err.slice(-300));
}

console.log("\n──── ④ 先破再验（换靶：模板里抽掉「验证」段 ⇒ ①的锚必红）────");
{
  const src = fs.readFileSync(ORCH, "utf8");
  const mutated = src.replace("`【验证】全套验证入口去目标仓根的 CLAUDE.md 自己查", "`【占位】（验证段被抽掉");
  check("mutation 前提：锚点还在", mutated !== src, "锚点漂移");
  if (mutated !== src) {
    const bak = ORCH + ".bak";
    fs.copyFileSync(ORCH, bak);
    try {
      fs.writeFileSync(ORCH, mutated, "utf8");
      const r = run(["dispatch", "--role", "implementer", "--spec-file", SPEC, "--dry-run"]);
      const hit = /【验证】/.test(r.out) && /刻意不给验证命令/.test(r.out);
      check("换靶：抽掉验证段 ⇒ 「四段骨架」断言在此处失效（证明①的判别力来自真段）", !hit, "模板变异后锚仍命中——①白做");
    } finally {
      fs.copyFileSync(bak, ORCH); fs.rmSync(bak, { force: true });
    }
    check("复原：字节级还原", fs.readFileSync(ORCH, "utf8") === src, "mutation 残留！");
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
