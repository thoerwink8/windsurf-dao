// dao-gates 回归网 — scripts/dao-gates.mjs（issue #70 · 三层降耗方案 · 层2 件①）
//
// 跑法：node tests/dao-gates.tests.js
//       node scripts/run-tests.mjs           （自动发现本文件，无需登记）
//
// ── 这个回归网要钉住什么 ─────────────────────────────────────────────────────
// dao-gates.mjs 是聚合器：本身不做判断，只转述 5 个既有检查器的真退出码。故本文件**不**
// 重复验证那 5 个检查器各自的判据（各有自己的回归网守着），只验证聚合器这一层：
//   ① 分类：已知退出码 → ok/red/inconclusive；不在自己声明集合里的退出码 → unknown
//   ② 优先级：聚合退出码取 unknown(4) > red(1) > inconclusive(2) > ok(0)
//   ③ 单闸失败不吞后续闸——全部闸都会被跑到，不因前面红了就短路
//   ④ --list 只列不跑（不产生任何真实执行的副作用）
//   ⑤ 用法错误 / fixture 非法 ⇒ exit 3，零道闸被执行
//   ⑥ 派单令点名的那一格：check-clauses-structure 的 exit=3「没查成」必须落进
//      inconclusive、聚合退出码是 2 不是 1 —— 不许与真违例（exit=1）混同
// 全部用 `DAO_GATES_FIXTURE` 注入口造合成夹具（node -e 单行脚本当假闸），秒级、
// 不依赖真实条款库此刻有没有违例——同 run-tests.mjs 里 DAO_PS_TIER_SCANNER 那类
// 注入口同型：给回归网用的，不是给人换真实闸清单的旋钮。
//
// ── 真实 5 道闸的接线只做静态检查，不做端到端整跑（刻意，别读成漏做）───────────
// 从 dao-gates.mjs 源码里正则抓出 5 个真实闸的脚本路径，断言文件都在盘上——catch
// 「路径打错字」这类最常见的接线错误，零运行时开销。**不**真跑一次（那需要真的起
// `check-clauses-structure.ps1` 全量模式，55-81s）——本文件最初把那个端到端整跑挂成
// `@dao-test-tier: env`，被 `tests/run-tests-tier.tests.js` 的审计断言拦下：那个标记的
// 契约是「对**别人拥有的机器级可变状态**做不变量断言」（issue #116），单纯「跑起来慢」
// 不满足这个契约（`.ps1` 侧的整套跳过型标记才接受「耗时预算不容」当理由，`.js` 侧这个
// 断言级标记不接受）。正确处理不是把理由硬凑过去，是**不做**这个断言——「5 个真实脚本
// 各自还能不能跑通」本就该由它们各自的回归网负责，本文件的职责只是聚合器这一层的逻辑。

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

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* 不存在即视为已清 */ } }
function ensureTmp() { rm(TMP); fs.mkdirSync(TMP, { recursive: true }); }

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
  const m = out.match(/DAO_GATES_SUMMARY exit=(\d+) gates=(\d+) ok=(\d+) red=(\d+) inconclusive=(\d+) unknown=(\d+)/);
  return {
    code: r.status, out, err: String(r.stderr || ""),
    summary: m ? { exit: +m[1], gates: +m[2], ok: +m[3], red: +m[4], inconclusive: +m[5], unknown: +m[6] } : null,
  };
}

function gate(exitWith, codesMap, name) {
  return { name: name || ("gate-exit-" + exitWith), cmd: NODE, args: ["-e", "process.exit(" + exitWith + ")"], codes: codesMap };
}

ensureTmp();

// ① 全 ok ---------------------------------------------------------------------
{
  const fx = writeFixture("all-ok", [
    gate(0, { 0: "ok" }, "a-ok"),
    gate(0, { 0: "ok" }, "b-ok"),
  ]);
  const r = runGates(fx);
  check("全 ok：进程退出码 0", r.code === 0, "实际 " + r.code);
  check("全 ok：末行 summary exit=0 gates=2 ok=2 red=0 inconclusive=0 unknown=0",
    !!r.summary && r.summary.exit === 0 && r.summary.gates === 2 && r.summary.ok === 2
      && r.summary.red === 0 && r.summary.inconclusive === 0 && r.summary.unknown === 0,
    JSON.stringify(r.summary));
}

// ② 单一 red --------------------------------------------------------------------
{
  const fx = writeFixture("one-red", [
    gate(0, { 0: "ok", 1: "red" }, "a-ok"),
    gate(1, { 0: "ok", 1: "red" }, "b-red"),
  ]);
  const r = runGates(fx);
  check("单一 red：进程退出码 1", r.code === 1, "实际 " + r.code);
  check("单一 red：summary red=1 exit=1", !!r.summary && r.summary.red === 1 && r.summary.exit === 1, JSON.stringify(r.summary));
  check("单一 red：闸名与判类都打进了输出", /b-red/.test(r.out) && /red/.test(r.out), r.out.slice(0, 400));
}

// ③ 派单令点名那一格：exit=3（check-clauses-structure「没查成」的语义）归 inconclusive，不归 red
{
  const fx = writeFixture("three-is-inconclusive", [
    gate(3, { 0: "ok", 1: "red", 3: "inconclusive" }, "clause-structure-like"),
  ]);
  const r = runGates(fx);
  check("exit=3 的闸按其声明表分类为 inconclusive，不是 red",
    !!r.summary && r.summary.red === 0 && r.summary.inconclusive === 1, JSON.stringify(r.summary));
  check("聚合退出码是 2 不是 1（inconclusive ≠ red，「没查成」≠「查出真问题」）", r.code === 2, "实际 " + r.code);
}

// ④ 未声明的退出码 → unknown ------------------------------------------------------
{
  const fx = writeFixture("unknown-code", [
    gate(9, { 0: "ok", 1: "red" }, "weird-exit"),
  ]);
  const r = runGates(fx);
  check("退出码 9 不在 {0,1} 声明集合里 ⇒ unknown", !!r.summary && r.summary.unknown === 1, JSON.stringify(r.summary));
  check("unknown ⇒ 聚合退出码 4", r.code === 4, "实际 " + r.code);
}

// ⑤ 优先级：unknown > red > inconclusive > ok -------------------------------------
{
  const fx = writeFixture("priority-unknown-over-red", [
    gate(1, { 0: "ok", 1: "red" }, "red-one"),
    gate(9, { 0: "ok", 1: "red" }, "unknown-one"),
  ]);
  const r = runGates(fx);
  check("同批红+unknown 并存 ⇒ 聚合取 unknown(4) 不是 red(1)", r.code === 4, "实际 " + r.code);
}
{
  const fx = writeFixture("priority-red-over-inconclusive", [
    gate(2, { 0: "ok", 1: "red", 2: "inconclusive" }, "inconclusive-one"),
    gate(1, { 0: "ok", 1: "red", 2: "inconclusive" }, "red-one"),
  ]);
  const r = runGates(fx);
  check("同批红+inconclusive 并存 ⇒ 聚合取 red(1) 不是 inconclusive(2)", r.code === 1, "实际 " + r.code);
}

// ⑥ 单闸失败不吞后续闸：3 道闸，第 1 道红，第 2/3 道也必须被真的跑到 ------------------
{
  const marker2 = path.join(TMP, "ran-2.marker");
  const marker3 = path.join(TMP, "ran-3.marker");
  rm(marker2); rm(marker3);
  const gates = [
    { name: "1-red", cmd: NODE, args: ["-e", "process.exit(1)"], codes: { 0: "ok", 1: "red" } },
    { name: "2-ok-marks", cmd: NODE, args: ["-e", "require('fs').writeFileSync(" + JSON.stringify(marker2) + ", 'ran')"], codes: { 0: "ok" } },
    { name: "3-ok-marks", cmd: NODE, args: ["-e", "require('fs').writeFileSync(" + JSON.stringify(marker3) + ", 'ran')"], codes: { 0: "ok" } },
  ];
  const fx = writeFixture("no-swallow", gates);
  const r = runGates(fx);
  check("第 1 道红之后，第 2 道仍被真的执行（marker 落盘）", fs.existsSync(marker2), "路径 " + marker2);
  check("第 1 道红之后，第 3 道仍被真的执行（marker 落盘）", fs.existsSync(marker3), "路径 " + marker3);
  check("汇总 gates=3（三道都进了汇总，不是红了就短路成 1 道）", !!r.summary && r.summary.gates === 3, JSON.stringify(r.summary));
}

// ⑦ --list 只列不跑：不产生任何真实执行的副作用 -----------------------------------
{
  const marker = path.join(TMP, "list-should-not-run.marker");
  rm(marker);
  const gates = [
    { name: "should-not-run", cmd: NODE, args: ["-e", "require('fs').writeFileSync(" + JSON.stringify(marker) + ", 'ran')"], codes: { 0: "ok" } },
  ];
  const fx = writeFixture("list-only", gates);
  const r = runGates(fx, ["--list"]);
  check("--list 退出码 0", r.code === 0, "实际 " + r.code);
  check("--list 列出了闸名", /should-not-run/.test(r.out), r.out.slice(0, 300));
  check("--list 不执行：marker 文件没有落盘", !fs.existsSync(marker), "marker 竟然存在：" + marker);
  check("--list 不打印 DAO_GATES_SUMMARY 末行（本来就没跑，没有可汇总的东西）", !/DAO_GATES_SUMMARY/.test(r.out), r.out.slice(-300));
}

// ⑧ 用法错误：不认识的参数 ⇒ exit 3，零道闸执行 ----------------------------------
{
  const marker = path.join(TMP, "badusage-should-not-run.marker");
  rm(marker);
  const gates = [
    { name: "should-not-run", cmd: NODE, args: ["-e", "require('fs').writeFileSync(" + JSON.stringify(marker) + ", 'ran')"], codes: { 0: "ok" } },
  ];
  const fx = writeFixture("bad-usage", gates);
  const r = runGates(fx, ["--not-a-real-flag"]);
  check("不认识的参数 ⇒ 进程退出码 3", r.code === 3, "实际 " + r.code);
  check("零道闸执行：marker 没有落盘", !fs.existsSync(marker), "marker 竟然存在：" + marker);
  check("末行 summary exit=3 gates=0", !!r.summary && r.summary.exit === 3 && r.summary.gates === 0, JSON.stringify(r.summary));
}

// ⑨ fixture 本身非法（不是合法 JSON / 空数组）⇒ exit 3 ---------------------------
{
  const badJsonPath = path.join(TMP, "bad.json");
  fs.writeFileSync(badJsonPath, "{ not valid json");
  const r1 = runGates(badJsonPath);
  check("DAO_GATES_FIXTURE 指向非法 JSON ⇒ exit 3", r1.code === 3, "实际 " + r1.code);

  const emptyArrPath = path.join(TMP, "empty.json");
  fs.writeFileSync(emptyArrPath, "[]");
  const r2 = runGates(emptyArrPath);
  check("DAO_GATES_FIXTURE 是空数组 ⇒ exit 3", r2.code === 3, "实际 " + r2.code);
}

// ── 静态接线检查（零运行时开销）───────────────────────────────────────────────────
// 抓真实 GATES 数组里逐条 path.join(ROOT, ...) 构造出的脚本路径，断言文件在盘上——
// catch「路径打错字」这类最常见的接线错误。**数量断言是 5 不是 >=5**：GATES 是手维护的
// 清单（见 dao-gates.mjs 头注「已知的射程缺口」㈠），改闸清单时这个数字要跟着手改——
// 这是刻意的强断言，不是遗漏加固。
{
  const joins = [...SRC.matchAll(/path\.join\(ROOT,\s*((?:"[^"]*",?\s*)+)\)/g)];
  const realPaths = joins.map((m) => {
    const parts = m[1].match(/"([^"]*)"/g).map((s) => s.slice(1, -1));
    return path.join(REPO, ...parts);
  });
  check("从源码里静态抓出的 GATES 路径数 === 5（GATES 清单当前长度；改闸数要同步改这里）",
    realPaths.length === 5, "抓到 " + realPaths.length + " 条：" + JSON.stringify(realPaths));
  for (const p of realPaths) {
    check("GATES 里引用的脚本文件在盘上：" + path.relative(REPO, p), fs.existsSync(p));
  }
}

rm(TMP);

console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " ===");
process.exit(fail ? 1 : 0);
