// affected-tests.tests.js — scripts/dao-affected-tests.mjs 的行为测试（2026-08-11 tests 终局）
// 形态按新范式：正控/负控/mutation 各一，不铺三层网。
const { spawnSync } = require("child_process");
const path = require("path");

const SCRIPT = path.join(__dirname, "..", "scripts", "dao-affected-tests.mjs");
let pass = 0, fail = 0;
function check(name, cond, evidence) {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (evidence ? "  ->  " + String(evidence).slice(0, 200) : "")); }
}
function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 20000 });
  return { code: r.status, out: String(r.stdout || ""), err: String(r.stderr || "") };
}

console.log("──── 正控：碰 hook 源 ⇒ 只命中它那套，别的留守套不捎上 ────");
{
  const r = run(["--files", "ccswitch/hooks/dao-glob-gate.js"]);
  check("glob-gate 源 ⇒ 恰好命中 glob-gate 一套",
    r.code === 0 && r.out.trim() === "tests/glob-gate.tests.js", r.out);
}
{
  const r = run(["--files", "scripts/dao-exit-gate.mjs", "scripts/dao-orch.mjs"]);
  check("两个流程脚本 ⇒ 恰好两套（排序稳定）",
    r.out.trim().split(/\r?\n/).join(",") === "tests/dao-orch.tests.js,tests/exit-gate.tests.js", r.out);
}

console.log("──── 负控：纯文字改动 ⇒ 零套（秒过是特性不是漏检）────");
{
  const r = run(["--files", "CLAUDE.md", "docs/ops/x.md", "ccswitch/rules/dao-dispatch.md"]);
  check("CLAUDE.md/docs/rules ⇒ 零套", r.code === 0 && r.out.trim() === "", JSON.stringify(r.out));
}

console.log("──── 共享面扇出：碰 hook 公共底座 ⇒ 全部留守套 ────");
{
  const r = run(["--files", "ccswitch/lib/hook-budget.js", "--json"]);
  let n = 0;
  try { n = JSON.parse(r.out).tests.length; } catch (_) {}
  check("hook-budget.js ⇒ 扇出到全部（≥16 套）", r.code === 0 && n >= 16, "n=" + n);
}

console.log("──── 🔴 mutation：映射表不是摆设——删掉一组映射，对应命中必须消失 ────");
{
  const fs = require("fs");
  const src = fs.readFileSync(SCRIPT, "utf8");
  const anchor = '"ccswitch/hooks/dao-glob-gate.js"';
  check("mutation 靶点在源码里恰好 1 处", src.split(anchor).length - 1 === 1, "出现 " + (src.split(anchor).length - 1) + " 次");
  const mut = src.replace(anchor, '"ccswitch/hooks/__dead__.js"');
  check("mutation 改得动（与原文不等）", mut !== src, "");
  const tmp = path.join(__dirname, "..", "_tmp", "affected-tests-mut.mjs");
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, mut, "utf8");
  const r = spawnSync(process.execPath, [tmp, "--files", "ccswitch/hooks/dao-glob-gate.js"], { encoding: "utf8", timeout: 20000 });
  check("🔴 mutation：映射摘掉后 glob-gate 源不再命中任何套（映射表真的承重）",
    String(r.stdout || "").trim() === "", String(r.stdout));
  try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  const r2 = run(["--files", "ccswitch/hooks/dao-glob-gate.js"]);
  check("反向：原件恢复后命中回来（变异体没污染真身）", r2.out.trim() === "tests/glob-gate.tests.js", r2.out);
}

console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " ===");
process.exit(fail ? 1 : 0);
