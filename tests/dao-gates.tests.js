// dao-gates 回归网 — scripts/dao-gates.mjs 聚合器层（不重复各闸自己的判据）
//
// 跑法：node tests/dao-gates.tests.js
//
// 聚合器本身不做判断，只转述各检查器的真退出码，故这里只验聚合器这一层：
// ① 已知退出码按各自声明表分类（ok/red/inconclusive），未声明 → unknown
// ② 聚合优先级 unknown(4) > red(1) > inconclusive(2) > ok(0)
// ③ 单闸失败不吞后续闸（全部被跑到，不短路）
// ④ --list 只列不跑；⑤ 用法错误/fixture 非法 ⇒ exit 3 零道闸执行
// ⑥ check-clauses-structure 的 exit=3「没查成」归 inconclusive、聚合退 2 不是 1（派单令点名那一格）
// 全部用 DAO_GATES_FIXTURE 注入口造合成夹具（node -e 当假闸），不依赖真实条款库此刻状态。
//
// ⚠ 已知缺口照直写：真实 GATES 表的「退出码→类别」映射 / args / cmd 此前 0 守护（判词实测
// A1–A6/F1 七个变体全绿），2026-08-11 重设计（5 道→3 道）后由本批补上（#260 件1，见下方
// 「真实 GATES 表的静态守护」段）；脚本路径在盘上的静态检查照旧。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "dao-gates.mjs");
const SRC = fs.readFileSync(SCRIPT, "utf8");
const TMP = path.join(REPO, "_tmp", "dao-gates-tests");
const NODE = process.execPath;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function writeFixture(name, gates) {
  const p = path.join(TMP, name + ".json");
  fs.writeFileSync(p, JSON.stringify(gates));
  return p;
}
function runGates(fixturePath, extraArgs) {
  const env = Object.assign({}, process.env);
  if (fixturePath) env.DAO_GATES_FIXTURE = fixturePath; else delete env.DAO_GATES_FIXTURE;
  const r = spawnSync(NODE, [SCRIPT, ...(extraArgs || [])], { encoding: "utf8", cwd: REPO, env });
  const out = String(r.stdout || "");
  const m = out.match(/DAO_GATES_SUMMARY exit=(\d+) gates=(\d+) ok=(\d+) red=(\d+) inconclusive=(\d+) unknown=(\d+)(?: fixture=([01]))?/);
  return {
    code: r.status, out,
    summary: m ? { exit: +m[1], gates: +m[2], ok: +m[3], red: +m[4], inconclusive: +m[5], unknown: +m[6], fixture: m[7] } : null,
  };
}
function gate(exitWith, codesMap, name) {
  return { name: name || ("gate-exit-" + exitWith), cmd: NODE, args: ["-e", "process.exit(" + exitWith + ")"], codes: codesMap };
}

rm(TMP); fs.mkdirSync(TMP, { recursive: true });

{
  const r = runGates(writeFixture("all-ok", [gate(0, { 0: "ok" }), gate(0, { 0: "ok" })]));
  check("① 全 ok：进程退出码 0，summary gates=2 ok=2", r.code === 0 && r.summary && r.summary.gates === 2 && r.summary.ok === 2, JSON.stringify(r.summary));
}
{
  const r = runGates(writeFixture("mix", [
    gate(3, { 0: "ok", 1: "red", 3: "inconclusive" }, "clause-structure-like"),
    gate(9, { 0: "ok", 1: "red" }, "weird-exit"),
    gate(1, { 0: "ok", 1: "red" }, "red-one"),
  ]));
  check("⑥+④ 分类：exit=3 归 inconclusive 不归 red；未声明 9 → unknown；聚合取 unknown(4)",
    r.summary && r.summary.red === 1 && r.summary.inconclusive === 1 && r.summary.unknown === 1 &&
    r.code === 4, JSON.stringify(r.summary));
}
{
  const r = runGates(writeFixture("priority-red-over-inc", [
    gate(2, { 0: "ok", 1: "red", 2: "inconclusive" }),
    gate(1, { 0: "ok", 1: "red", 2: "inconclusive" }),
  ]));
  check("⑤ 优先级：红+inconclusive 并存 ⇒ 聚合取 red(1) 不是 2", r.code === 1 && r.summary && r.summary.red === 1, JSON.stringify(r.summary));
  const r2 = runGates(writeFixture("only-inc", [gate(3, { 0: "ok", 1: "red", 3: "inconclusive" })]));
  check("⑥' 单独 exit=3 ⇒ 聚合退 2 不是 1（「没查成」≠「查出真问题」）",
    r2.code === 2 && r2.summary && r2.summary.inconclusive === 1 && r2.summary.red === 0, JSON.stringify(r2.summary));
}
{
  // ③ 不短路：第 1 道红，第 2/3 道仍被真的执行
  const m2 = path.join(TMP, "ran-2.marker");
  const m3 = path.join(TMP, "ran-3.marker");
  rm(m2); rm(m3);
  const fx = writeFixture("no-swallow", [
    { name: "1-red", cmd: NODE, args: ["-e", "process.exit(1)"], codes: { 0: "ok", 1: "red" } },
    { name: "2-marks", cmd: NODE, args: ["-e", "require('fs').writeFileSync(" + JSON.stringify(m2) + ",'ran')"], codes: { 0: "ok" } },
    { name: "3-marks", cmd: NODE, args: ["-e", "require('fs').writeFileSync(" + JSON.stringify(m3) + ",'ran')"], codes: { 0: "ok" } },
  ]);
  const r = runGates(fx);
  check("③ 单闸失败不吞后续闸：红后 2/3 道仍真执行，汇总 gates=3",
    fs.existsSync(m2) && fs.existsSync(m3) && r.summary && r.summary.gates === 3, JSON.stringify(r.summary));
}
{
  // ④ --list 只列不跑
  const marker = path.join(TMP, "list-not-run.marker");
  rm(marker);
  const fx = writeFixture("list-only", [{ name: "should-not-run", cmd: NODE, args: ["-e", "require('fs').writeFileSync(" + JSON.stringify(marker) + ",'ran')"], codes: { 0: "ok" } }]);
  const r = runGates(fx, ["--list"]);
  check("④ --list：exit 0、列出闸名、marker 未落盘、无 summary 末行",
    r.code === 0 && /should-not-run/.test(r.out) && !fs.existsSync(marker) && !/DAO_GATES_SUMMARY/.test(r.out));
}
{
  // ⑤ 用法错误 / fixture 非法 ⇒ exit 3 零道闸执行
  const marker = path.join(TMP, "badusage-not-run.marker");
  rm(marker);
  const fx = writeFixture("bad-usage", [{ name: "should-not-run", cmd: NODE, args: ["-e", "require('fs').writeFileSync(" + JSON.stringify(marker) + ",'ran')"], codes: { 0: "ok" } }]);
  const r1 = runGates(fx, ["--not-a-real-flag"]);
  const badJson = path.join(TMP, "bad.json");
  fs.writeFileSync(badJson, "{ not valid json");
  const r2 = runGates(badJson);
  check("⑤ 用法错与非法 fixture ⇒ exit 3、零道闸执行、summary gates=0",
    r1.code === 3 && !fs.existsSync(marker) && r1.summary && r1.summary.gates === 0 && r2.code === 3);
  fs.writeFileSync(path.join(TMP, "empty.json"), "[]");
  check("⑤' 空数组 fixture ⇒ exit 3", runGates(path.join(TMP, "empty.json")).code === 3);
}
{
  // 静态接线：从源码抓出的 GATES 脚本路径全在盘上。数量断言是 ===3（GATES 手维护清单，
  // 改闸数要同步改这里——刻意强断言）。2026-08-11 重设计后 5→3。
  const joins = [...SRC.matchAll(/path\.join\(ROOT,\s*((?:"[^"]*",?\s*)+)\)/g)];
  const realPaths = joins.map((m) => {
    const parts = m[1].match(/"([^"]*)"/g).map((s) => s.slice(1, -1));
    return path.join(REPO, ...parts);
  });
  check("静态：GATES 路径数 === 3 且全部在盘上", realPaths.length === 3 && realPaths.every((p) => fs.existsSync(p)),
    JSON.stringify(realPaths));
}
{
  // ── 真实 GATES 表的静态守护（#260 件1）────────────────────────────────────────
  // 判词 A1–A6/F1 七个变体全绿的病根：codes 映射 / args / cmd 三个字段零断言（改动没人红）。
  // 修法照关闭条件：与既有路径断言同型，从源码静态抓取 GATES 数组逐字段与期望字面比对，
  // 零运行时开销。
  const gatesSrc = SRC.match(/const GATES = (\[[\s\S]*?\r?\n\]);\r?\n\r?\n\/\/ ── 参数解析/);
  if (!gatesSrc) { check("件1 前置：能从源码抓到 GATES 数组字面量", false); }
  else {
    const realGates = eval(`(function () { const ROOT = REPO; return (${gatesSrc[1]}); })()`);
    const EXPECTED = [
      {
        name: "dao-smoke",
        cmd: process.execPath,
        args: [path.join(REPO, "scripts", "dao-smoke.mjs")],
        codes: { 0: "ok", 1: "red" },
      },
      {
        name: "check-mutation-anchor",
        cmd: process.execPath,
        args: [path.join(REPO, "ccswitch", "scripts", "check-mutation-anchor.mjs")],
        codes: { 0: "ok", 1: "red", 2: "inconclusive", 5: "inconclusive" },
      },
      {
        name: "check-clauses-structure（全量）",
        cmd: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(REPO, "ccswitch", "scripts", "check-clauses-structure.ps1")],
        codes: { 0: "ok", 1: "red", 3: "inconclusive" },
      },
    ];
    const deepEq = (a, b) => {
      if (a === b) return true;
      if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
      const ka = Object.keys(a), kb = Object.keys(b);
      return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k]));
    };
    check("件1 真实 GATES：共 3 道闸且与期望同名同序", realGates.length === 3 && realGates.every((g, i) => g.name === EXPECTED[i].name),
      JSON.stringify(realGates.map((g) => g.name)));
    check("件1 真实 GATES：cmd 逐条一致", realGates.every((g, i) => g.cmd === EXPECTED[i].cmd));
    check("件1 真实 GATES：args 逐条一致（deep equal，F1 去掉 -File 会红）", realGates.every((g, i) => deepEq(g.args, EXPECTED[i].args)),
      JSON.stringify(realGates.map((g) => g.args)));
    check("件1 真实 GATES：codes 退出码→类别映射逐条一致（deep equal，A1–A4/A6 会红）",
      realGates.every((g, i) => deepEq(g.codes, EXPECTED[i].codes)), JSON.stringify(realGates.map((g) => g.codes)));
  }
}
{
  // ── 末行 fixture= 字段（#260 件5）─────────────────────────────────────────────
  // 注入口跑出来的那一行必须带 fixture=1、真跑不带（fixture=0）——否则那行「贴出来当证据」
  // 的汇总行分不出真跑还是假跑（假闸经注入口跑一遍与真跑逐字节相同）。
  const fxAllOk = writeFixture("fixture-marker", [gate(0, { 0: "ok" })]);
  const rFx = runGates(fxAllOk);
  check("件5 注入口跑出来的 summary 行必须带 fixture=1", rFx.summary && rFx.summary.fixture === "1", String(rFx.summary && rFx.summary.fixture));
  const rReal = runGates(null);
  check("件5 真跑（无 DAO_GATES_FIXTURE）summary 行 fixture=0", rReal.summary && rReal.summary.fixture === "0", String(rReal.summary && rReal.summary.fixture));
  const rUsage = runGates(fxAllOk, ["--not-a-real-flag"]);
  check("件5 用法错误那一行也带 fixture 标记（fixture=1）", rUsage.summary && rUsage.summary.fixture === "1", String(rUsage.summary && rUsage.summary.fixture));
}

rm(TMP);

console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " ===");
process.exit(fail ? 1 : 0);
