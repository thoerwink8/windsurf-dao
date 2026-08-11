// 断言条数基线的回归网 —— scripts/run-tests.mjs 的「本次跑了几条 vs 基线下界」那道闸
//
// 跑法：node tests/assertion-baseline.tests.js   （全绿 exit 0，任一红 exit 1）
//       node scripts/run-tests.mjs               （自动发现本文件，无需登记）
//
// ── 治的病（issue #268 · 用户 2026-08-10 拍板 issue #70 第 9 件）─────────────
// 「PASS=659 FAIL=0」这行字答不了「本该有多少条」。锚点一漂，壳里那一批断言是**消失**
// 不是变红 —— 日志上 `FAIL` 只多 1 条而 `PASS` 掉 6。那道闸的契约正文在
// `scripts/run-tests.mjs` 头注「断言条数基线」一节，本文件是它的回归网。
//
// ── 两段各管一件事，别混着读 ─────────────────────────────────────────────────
//   ① **名册对账**（读真基线 + 真 tests/ 目录，不跑任何测试）：新套没进基线、基线里留着
//      已删的套、某一层压根没有值 —— 三种都判红。**这一段是那个派生物的同步触发器**：
//      加一套测试而忘了重生成基线，它当场红，不必有人记得。
//   ② **闸的行为**（合成 tests 目录 + 注入合成基线）：跌破判红 / 基线老了只出声 /
//      读不到基线走 exit 4 / 关闸也要出声。
//
// 🔴 **① 里那条"条目数 == 套数"是基数闸，不是存在性闸**：只查 `suites` 非空的话，
//   一份只剩一个条目的基线照样全绿，而那与「每一套都守着」输出一模一样
//   （同批 issue #272 在 `tests/dao-rule-echo.tests.js` 上踩的正是这个形态）。
//
// ⚠ 本文件**刻意不复用 run-tests.mjs 的任何一行实现**（不 import 它、不共享常量）：
//   守卫的自检那一半不许复用被守对象的解析（dao `[#守-自检独立]`）。基线档的路径、
//   末行的字段名、退出码的数字，这里全部是**另写一份**的字面量 —— 两边不一致时它会红，
//   而那正是要的：契约改了就该有人来对一次。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const RUNNER = path.join(REPO, "scripts", "run-tests.mjs");
const REAL_BASELINE = path.join(REPO, "scripts", "assertion-baseline.json");
const TMP = path.join(REPO, "_tmp", "assertion-baseline");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}

// 末行解析器：**另写一份**，只取本段关心的字段（见文件头 ⚠）
const SUM_RE = /RUN_TESTS_SUMMARY exit=(\d+) tier=(\w+) files=(\d+) red=(\d+) pass=(\d+) fail=(\d+)/;
const BASE_RE = /baselow=(\d+) basegate=(\w+)/;
function parse(out) {
  const a = SUM_RE.exec(String(out));
  const b = BASE_RE.exec(String(out));
  if (!a) return null;
  return {
    exit: Number(a[1]), tier: a[2], files: Number(a[3]), red: Number(a[4]),
    pass: Number(a[5]), fail: Number(a[6]),
    baselow: b ? Number(b[1]) : null, basegate: b ? b[2] : null,
  };
}

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function w(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ① 名册对账：真基线档 vs 真 tests/ 目录（不跑任何测试）────");
{
  let raw = null, json = null, readErr = null;
  try { raw = fs.readFileSync(REAL_BASELINE, "utf8"); } catch (e) { readErr = e.message; }
  check("基线档读得到（读不到 ⇒ 那道闸每次跑都在空转）", raw !== null, `${REAL_BASELINE} · ${readErr}`);
  if (raw !== null) {
    try { json = JSON.parse(raw); } catch (e) { readErr = e.message; }
    check("基线档是合法 JSON", json !== null, readErr);
  }
  const suites = (json && json.suites && typeof json.suites === "object") ? json.suites : null;
  check("基线档有 suites 段", suites !== null, JSON.stringify(json && Object.keys(json)));

  // 盘上实况：**自己扫一次目录**，不问 run-tests 要（两套独立来源，见文件头 ⚠）
  let onDisk = [];
  try {
    onDisk = fs.readdirSync(path.join(REPO, "tests"))
      .filter((f) => f.endsWith(".tests.js") || f.endsWith(".tests.ps1")).sort();
  } catch (_) {}
  check("扫得到 tests/ 目录且不为空（扫不到 ⇒ 下面几条会退化成「零个样本全过」）",
    onDisk.length > 0, `扫到 ${onDisk.length} 个`);

  if (suites && onDisk.length) {
    const keys = Object.keys(suites).sort();
    // 🔴 基数闸：条目数必须等于盘上套数。只查非空是存在性闸，一份只剩一条的基线照样全绿。
    check("基数闸：基线条目数 == 盘上套数（夹住「基线只剩几条」这一向）",
      keys.length === onDisk.length, `基线 ${keys.length} 条 / 盘上 ${onDisk.length} 套`);
    const missing = onDisk.filter((f) => !suites[f]);
    check("双向对账·盘上有、基线里没有 ⇒ 零（有的话那几套没有条数闸）",
      missing.length === 0, `缺：${missing.join(", ")}  ⇒ 重生成：node scripts/run-tests.mjs --write-baseline（另加 --env 各写一层）`);
    const ghost = keys.filter((k) => !onDisk.includes(k));
    check("双向对账·基线里有、盘上没有 ⇒ 零（是刻意删的还是被顺手删掉的）",
      ghost.length === 0, `幽灵条目：${ghost.join(", ")}`);

    // 每层都要有值：数（有闸）或字符串说明（照直写这一层拿不到数）。**不许是 undefined/null**
    const badTier = [];
    const badKind = [];
    for (const k of keys) {
      const e = suites[k] || {};
      for (const t of ["default", "env"]) {
        const v = e[t];
        const okVal = typeof v === "number" ? Number.isFinite(v) && v >= 0
          : (typeof v === "string" && v.trim().length > 0);
        if (!okVal) badTier.push(`${k}.${t}=${JSON.stringify(v)}`);
      }
      const wantKind = k.endsWith(".tests.ps1") ? "pwsh" : "node";
      if (e.kind !== wantKind) badKind.push(`${k}.kind=${JSON.stringify(e.kind)}（应为 ${wantKind}）`);
    }
    check("每套两层都有值：数（有闸）或一句说明（拿不到数）—— 不许留空",
      badTier.length === 0, badTier.slice(0, 6).join(" · "));
    check("kind 与文件后缀相符（.tests.ps1 ⇒ pwsh，其余 ⇒ node）",
      badKind.length === 0, badKind.slice(0, 6).join(" · "));

    // 观察线（不判红）：本仓当前有几格是"没有闸"的，照直打出来 —— 别把"没报"读成"守住了"
    const blind = [];
    for (const k of keys) {
      for (const t of ["default", "env"]) {
        if (typeof (suites[k] || {})[t] !== "number") blind.push(`${k}.${t}`);
      }
    }
    console.log(`  ⓘ 当前没有条数闸的格子 ${blind.length} 个（观察线，不判红）：${blind.join(" · ") || "无"}`);
  }
}

// ══════════════════════════════════════════════════════════════
// ② 闸的行为：合成 tests 目录 + 注入合成基线（`DAO_ASSERTION_BASELINE`）
// 夹具只打一行汇总，条数由参数定；**不依赖真仓任何一套测试的条数**。
rm(TMP);
function mkFixture(name, opts) {
  const o = opts || {};
  const dir = path.join(TMP, name);
  const lines = [
    "// 合成夹具（assertion-baseline 回归网），非真测试",
    `console.log('=== 汇总: PASS=${o.pass == null ? 5 : o.pass} FAIL=${o.failN == null ? 0 : o.failN} ===');`,
    `process.exit(${o.exitCode == null ? 0 : o.exitCode});`,
  ];
  w(path.join(dir, "tests", "alpha.tests.js"), lines.join("\n") + "\n");
  return dir;
}
function mkBaseline(dir, obj) {
  const p = path.join(dir, "baseline.json");
  w(p, JSON.stringify(obj, null, 2) + "\n");
  return p;
}
function runRunner(dir, baselinePath, extraArgs) {
  const args = [RUNNER, "--tests-dir", path.join(dir, "tests")].concat(extraArgs || []);
  const env = Object.assign({}, process.env);
  if (baselinePath) env.DAO_ASSERTION_BASELINE = baselinePath;
  else delete env.DAO_ASSERTION_BASELINE;
  const r = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO, timeout: 120000, env });
  const out = String(r.stdout || "");
  return { code: r.status, out, err: String(r.stderr || ""), sum: parse(out) };
}

console.log("\n──── ② 负控：条数等于基线 → 不许被顶红 ────");
{
  const d = mkFixture("equal", { pass: 5 });
  const b = mkBaseline(d, { suites: { "alpha.tests.js": { kind: "node", default: 5, env: 5 } } });
  const r = runRunner(d, b);
  check("条数正好等于基线 → exit 0", r.code === 0 && r.sum && r.sum.exit === 0, JSON.stringify(r.sum));
  check("末行 baselow=0 basegate=on", r.sum && r.sum.baselow === 0 && r.sum.basegate === "on", JSON.stringify(r.sum));
  check("不打「跌破基线」那段喇叭", !/跌破基线/.test(r.out), r.out.slice(-400));
}
{
  // 条数**高于**基线（正常的测试增长）也不许红 —— 基线是下界不是等号
  const d = mkFixture("grow", { pass: 9 });
  const b = mkBaseline(d, { suites: { "alpha.tests.js": { kind: "node", default: 5, env: 5 } } });
  const r = runRunner(d, b);
  check("条数高于基线（正常增长）→ 仍 exit 0（基线是下界不是等号）",
    r.code === 0 && r.sum && r.sum.baselow === 0, JSON.stringify(r.sum));
}

console.log("\n──── ③ 正控：条数跌破基线 → exit 1，且这条红不靠任何断言失败顶起来 ────");
{
  const d = mkFixture("below", { pass: 5 });
  const b = mkBaseline(d, { suites: { "alpha.tests.js": { kind: "node", default: 8, env: 8 } } });
  const r = runRunner(d, b);
  check("跌破基线 → exit 1", r.code === 1 && r.sum && r.sum.exit === 1, JSON.stringify(r.sum) + "\n" + r.out.slice(-600));
  check("末行 baselow=1", r.sum && r.sum.baselow === 1, JSON.stringify(r.sum));
  // 🔴 本段的核心负控：这一跑**一条断言都没红**（red=0 fail=0），退出码却是 1 ——
  //    正是 issue #268 那个场景（FAIL 数看不出少跑了几条）。若哪天这条红要靠 FAIL 顶，
  //    这道闸就退化成了「重复报告已经红了的东西」。
  check("🔴 负控：red=0 且 fail=0，退出码仍是 1（这条红完全由条数产生，不是复述别人的红）",
    r.sum && r.sum.red === 0 && r.sum.fail === 0 && r.sum.exit === 1, JSON.stringify(r.sum));
  check("报文说出「少跑了几条」这个数（只说「跌破」等于没说）",
    /比基线少跑了 3 条/.test(r.out), r.out.slice(-800));
  check("报文点名到具体文件", /alpha\.tests\.js/.test(r.out) && /本次 5 条 \/ 基线 8 条/.test(r.out), r.out.slice(-800));
  check("报文给出重生成命令（红了得知道下一步做什么）", /--write-baseline/.test(r.out), r.out.slice(-800));
  check("报文说清最常见成因是锚点漂移", /锚点/.test(r.out), r.out.slice(-800));
}

console.log("\n──── ④ 自检：基线读不到 / 一套都对不上 → exit 4（fail-closed，不静默放行）────");
{
  const d = mkFixture("nofile", { pass: 5 });
  const r = runRunner(d, path.join(d, "does-not-exist.json"));
  check("注入的基线档不存在 → exit 4（不是 0，也不是 1）", r.code === 4 && r.sum && r.sum.exit === 4, JSON.stringify(r.sum));
  check("末行 basegate=fail（「想查却没查成」与「查了没事」分得开）",
    r.sum && r.sum.basegate === "fail", JSON.stringify(r.sum));
  check("报文明说这次一条都没查", /一条都没查/.test(r.out), r.out.slice(-700));
}
{
  const d = mkFixture("empty", { pass: 5 });
  const b = mkBaseline(d, { suites: {} });
  const r = runRunner(d, b);
  check("基线档被清空成 {suites:{}} → exit 4（零匹配 = 这道闸本次一条都没查）",
    r.code === 4 && r.sum && r.sum.exit === 4 && r.sum.basegate === "fail", JSON.stringify(r.sum) + "\n" + r.out.slice(-600));
  check("报文说出「一套都没对上」这个归因", /一套都没对上/.test(r.out), r.out.slice(-700));
}
{
  const d = mkFixture("renamed", { pass: 5 });
  const b = mkBaseline(d, { suites: { "beta.tests.js": { kind: "node", default: 5, env: 5 } } });
  const r = runRunner(d, b);
  check("基线里的键全对不上盘上文件名（改名/换目录）→ exit 4，不是绿",
    r.code === 4 && r.sum && r.sum.basegate === "fail", JSON.stringify(r.sum));
}
{
  const d = mkFixture("badjson", { pass: 5 });
  const p = path.join(d, "broken.json");
  w(p, "{ 这不是 JSON ");
  const r = runRunner(d, p);
  check("基线档不是合法 JSON → exit 4 且报文点明 JSON", r.code === 4 && /JSON/.test(r.out), JSON.stringify(r.sum));
}

console.log("\n──── ⑤ 关闸也要出声：合成目录 + 没注入基线 → basegate=off 且打一行 ────");
// 🔴 **这一段有一个前提断言，别删**：它要证的是「不归它管的那一跑，闸不装载」，
//   而首版代码把判据写在了**读失败**那一支上 —— 症状随「真基线档存不存在」变：
//   档还没生成时这一段全绿，档一生成就当场 exit 4（`tests/run-tests-tier.tests.js`
//   实测一次红 33 条，同一份代码前后两跑结论相反）。故先钉住「档此刻确实在」，
//   否则下面几条证到的只是「档不存在所以没开闸」，是一句废话。
{
  const d = mkFixture("gateoff", { pass: 5 });
  check("前提：真基线档此刻确实存在（不然下面三条退化成废话）",
    fs.existsSync(REAL_BASELINE), REAL_BASELINE);
  const r = runRunner(d, null);
  check("没注入基线 + 合成 tests 目录 → 不判红（否则 run-tests 自测全线瘫痪）",
    r.code === 0 && r.sum && r.sum.exit === 0, JSON.stringify(r.sum));
  check("末行 basegate=off（关了闸这件事进机器通道）", r.sum && r.sum.basegate === "off", JSON.stringify(r.sum));
  check("🔴 关闸不许静默：正文里有一行说清「本次不查条数」", /本次不查条数/.test(r.out), r.out.slice(-600));
}

console.log("\n──── ⑥ 观察线三格：基线老了 / 新套没进基线 / 幽灵条目 —— 出声但不判红 ────");
{
  const d = mkFixture("stale", { pass: 40 });
  const b = mkBaseline(d, { suites: { "alpha.tests.js": { kind: "node", default: 5, env: 5 } } });
  const r = runRunner(d, b);
  check("实际条数高出基线 20 条以上 → 打「基线老了」那一行", /基线老了/.test(r.out), r.out.slice(-800));
  check("说清它老到什么程度（掉多少条以内它都看不见）", /掉 35 条以内它都看不见/.test(r.out), r.out.slice(-800));
  check("🔴 但它**不进退出码**（观察线就是观察线）", r.code === 0 && r.sum.baselow === 0, JSON.stringify(r.sum));
}
{
  const d = mkFixture("unlisted", { pass: 5 });
  const b = mkBaseline(d, { suites: {
    "alpha.tests.js": { kind: "node", default: 5, env: 5 },
    "zombie.tests.js": { kind: "node", default: 3, env: 3 },
  } });
  const r = runRunner(d, b);
  check("基线里留着盘上已没有的套 → 出声并问「刻意删的还是顺手删掉的」",
    /zombie\.tests\.js/.test(r.out) && /顺手删掉/.test(r.out), r.out.slice(-800));
  check("幽灵条目不判红（判红的那道在本文件 ① 段）", r.code === 0, JSON.stringify(r.sum));
}

console.log("\n──── ⑦ --write-baseline：真写盘 / 有红时拒写 / 与 --list 互斥 ────");
{
  const d = mkFixture("write", { pass: 7 });
  const b = path.join(d, "out.json");
  const r = runRunner(d, b, ["--write-baseline"]);
  check("首次生成（档还不存在）→ 不判红、正常收尾", r.code === 0, JSON.stringify(r.sum) + r.out.slice(-500));
  let j = null;
  try { j = JSON.parse(fs.readFileSync(b, "utf8")); } catch (_) {}
  check("真的写出了基线档", j !== null && j.suites != null, String(j && Object.keys(j)));
  check("写进去的是本次这一跑的条数（PASS+FAIL）",
    j && j.suites["alpha.tests.js"] && j.suites["alpha.tests.js"].default === 7,
    JSON.stringify(j && j.suites));
  check("只写本层（--env 那一层没被这一跑顺手填上）",
    j && j.suites["alpha.tests.js"] && j.suites["alpha.tests.js"].env === undefined,
    JSON.stringify(j && j.suites));
  check("档里带 _doc（派生物要能自己说清它是什么、谁在消费它）",
    j && j._doc && typeof j._doc === "object", JSON.stringify(j && Object.keys(j || {})));
}
{
  // 🔴 红的那一套**逐套跳过**：从一次有红的跑里取那一套的条数 = 把缺陷焊进基线。
  //    颗粒度是刻意的 —— 「整跑拒写」会在首次生成那一刻自锁（本文件自己红 ⇒ 档永远写不出来），
  //    实测撞到过一次，故改成逐套。**没有旧值时写一句说明，绝不编一个数。**
  const d = mkFixture("writered", { pass: 3, failN: 2, exitCode: 1 });
  const b = path.join(d, "out.json");
  const r = runRunner(d, b, ["--write-baseline"]);
  check("这一跑确有测试红（前提断言，不然下面几条是废话）", r.sum && r.sum.red === 1, JSON.stringify(r.sum));
  let j = null;
  try { j = JSON.parse(fs.readFileSync(b, "utf8")); } catch (_) {}
  check("档照样写得出来（首次生成时本文件自己是红的 —— 整跑拒写会把自己锁死）",
    j !== null && j.suites != null, "没写出来：" + b);
  check("🔴 但红的那一套**没有拿到数字基线**（写的是一句说明，不是 5）",
    j && typeof j.suites["alpha.tests.js"].default === "string", JSON.stringify(j && j.suites));
  check("那句说明自陈「这一套当时是红的」（照直写，不留一个看不懂的空位）",
    j && /红/.test(String(j.suites["alpha.tests.js"].default)), JSON.stringify(j && j.suites));
  check("报文说清理由（把缺陷焊进去）", /焊进去/.test(r.out), r.out.slice(-800));
  check("不吞掉那个红（退出码仍是 1）", r.code === 1, JSON.stringify(r.sum));
}
{
  // 有旧值时：红的那一跑**不许把基线下调**（保留旧值）
  const d = mkFixture("writered2", { pass: 3, failN: 2, exitCode: 1 });
  const b = mkBaseline(d, { suites: { "alpha.tests.js": { kind: "node", default: 9, env: 9 } } });
  const r = runRunner(d, b, ["--write-baseline"]);
  let j = null;
  try { j = JSON.parse(fs.readFileSync(b, "utf8")); } catch (_) {}
  check("🔴 红的一跑不许把已有基线下调（9 不会被这次的 5 顶掉）",
    j && j.suites["alpha.tests.js"].default === 9, JSON.stringify(j && j.suites));
  check("报文点名说这一套的条数没被采信", /没被采信/.test(r.out) && /alpha\.tests\.js/.test(r.out), r.out.slice(-800));
}
{
  const d = mkFixture("listwrite", { pass: 5 });
  const r = runRunner(d, path.join(d, "x.json"), ["--list", "--write-baseline"]);
  check("--list 与 --write-baseline 同给 → exit 3 用法错（互斥意图不静默忽略）",
    r.code === 3, JSON.stringify(r.sum) + "\n" + r.err.slice(0, 300));
  check("用法错那条末行也带上了新字段（两处字面量不许漂）",
    /baselow=0 basegate=off/.test(r.out), r.out.slice(-300));
}

console.log("\n──── ⑦′ 单套写基线（issue #300 方向 1）：一次调用填好两格、只动那一套 ────");
// 判据来源：issue #300 评论的实测订正 —— 全量写要两遍（default/env 各一）12 分钟起步，
// 单套粒度若不解「两层各写各的」只是把 3 遍全量变成 2 遍单套。故判据是**一次调用两格齐**。
function mkSuitePair(name, alphaOpts) {
  const o = alphaOpts || {};
  const dir = path.join(TMP, name);
  const aSent = path.join(dir, "alpha-sentinel.log");
  const bSent = path.join(dir, "beta-sentinel.log");
  const mk = (file, pass, sent, extra) => w(path.join(dir, "tests", file),
    (extra || "") + "const fs=require('fs');\n"
    + "fs.appendFileSync(" + JSON.stringify(sent) + ", 'argv=' + process.argv.slice(2).join(',') + '\\n');\n"
    + (o.noSummary ? "" : "console.log('=== 汇总: PASS=" + pass + " FAIL=" + (o.failN || 0) + " ===');\n")
    + "process.exit(" + (o.exitCode || 0) + ");\n");
  mk("alpha.tests.js", 5, aSent);
  mk("beta.tests.js", 4, bSent);
  return { dir, aSent, bSent };
}
{
  const c = mkSuitePair("single");
  const bp = path.join(c.dir, "out.json");
  const r = runRunner(c.dir, bp, ["--write-baseline", "tests/alpha.tests.js"]);
  check("单套写 → exit 0", r.code === 0 && r.sum && r.sum.exit === 0, JSON.stringify(r.sum) + "\n" + r.out.slice(-600));
  let j = null;
  try { j = JSON.parse(fs.readFileSync(bp, "utf8")); } catch (_) {}
  check("🔴 核心判据：一次调用把 default 与 env 两格都填成数（不再是「两层各写各的」）",
    j && j.suites["alpha.tests.js"] && j.suites["alpha.tests.js"].default === 5 && j.suites["alpha.tests.js"].env === 5,
    JSON.stringify(j && j.suites));
  check("只动那一套：beta.tests.js 不在档里", j && !j.suites["beta.tests.js"], JSON.stringify(j && Object.keys(j.suites || {})));
  check("🔴 只跑那一套：beta 的 sentinel 不存在（「没跑」看副作用，不看汇总行）",
    !fs.existsSync(c.bSent), "beta sentinel=" + c.bSent);
  const aRuns = fs.existsSync(c.aSent) ? fs.readFileSync(c.aSent, "utf8").trim().split(/\r?\n/) : [];
  check("alpha 跑了两遍（default 一遍 + env 一遍）",
    aRuns.length === 2 && aRuns[0] === "argv=" && aRuns[1] === "argv=--env", JSON.stringify(aRuns));
  check("末行 tier=single 且带 suite= 字段（追加在尾部）",
    r.sum && r.sum.tier === "single" && /basegate=write suite=alpha\.tests\.js/.test(r.out), r.out.slice(-300));
}
{
  // 幂等：第二跑同一套 ⇒ 档里两格不变，报文说「未变」
  const c = mkSuitePair("single-idem");
  const bp = path.join(c.dir, "out.json");
  runRunner(c.dir, bp, ["--write-baseline", "tests/alpha.tests.js"]);
  const r = runRunner(c.dir, bp, ["--write-baseline", "tests/alpha.tests.js"]);
  check("幂等：同套重跑仍 exit 0 且报文说两格未变", r.code === 0 && /两格均与上一版一致/.test(r.out), r.out.slice(-500));
}
{
  // 不删别的套：基线里预置一个盘上已没有的条目，单套写**不许**顺手清掉它（那是全量写的名册清理活）
  const c = mkSuitePair("single-keep");
  const bp = mkBaseline(c.dir, { suites: { "zombie.tests.js": { kind: "node", default: 3, env: 3 } } });
  const r = runRunner(c.dir, bp, ["--write-baseline", "tests/alpha.tests.js"]);
  let j = null;
  try { j = JSON.parse(fs.readFileSync(bp, "utf8")); } catch (_) {}
  check("单套写保留其他条目（zombie 不被顺手删掉 —— 部分更新语义）",
    r.code === 0 && j && j.suites["zombie.tests.js"] && j.suites["zombie.tests.js"].default === 3,
    JSON.stringify(j && Object.keys(j.suites || {})));
}
{
  // 红的那一套：有旧值保旧值，没旧值写说明，**绝不编一个数**（与全量写同一判据，粒度细到「格」）
  const c = mkSuitePair("single-red", { exitCode: 1, failN: 2 });
  const bp = mkBaseline(c.dir, { suites: { "alpha.tests.js": { kind: "node", default: 9, env: 9 } } });
  const r = runRunner(c.dir, bp, ["--write-baseline", "tests/alpha.tests.js"]);
  let j = null;
  try { j = JSON.parse(fs.readFileSync(bp, "utf8")); } catch (_) {}
  check("前提：这一跑那一套是红的（exit 1）", r.code === 1, JSON.stringify(r.sum));
  check("🔴 红的一跑不许把已有基线下调（9 不会被顶掉）",
    j && j.suites["alpha.tests.js"].default === 9 && j.suites["alpha.tests.js"].env === 9, JSON.stringify(j && j.suites));
}
{
  // 方向 4 在单套模式同样生效：JS 套不打汇总行 ⇒ exit 4，档里只能落「未报计数」
  const c = mkSuitePair("single-nosummary", { noSummary: true });
  const bp = path.join(c.dir, "out.json");
  const r = runRunner(c.dir, bp, ["--write-baseline", "tests/alpha.tests.js"]);
  let j = null;
  try { j = JSON.parse(fs.readFileSync(bp, "utf8")); } catch (_) {}
  check("单套 + JS 套不报计数 → exit 4（不是 0）",
    r.code === 4 && r.sum && r.sum.exit === 4 && /selfcheck=fail/.test(r.out), JSON.stringify(r.sum));
  check("报文点出「永久没有条数下界」", /条数下界/.test(r.out), r.out.slice(-600));
  check("档里那两格是字符串说明，不是编的数",
    j && typeof j.suites["alpha.tests.js"].default === "string" && typeof j.suites["alpha.tests.js"].env === "string",
    JSON.stringify(j && j.suites));
}
{
  // PS 夹具：无标记 ⇒ 两层跑法字面相同（spawn 不传 --env），跑一遍两格填同一个数
  const dir = path.join(TMP, "single-ps");
  w(path.join(dir, "tests", "bravo.tests.ps1"), "Write-Output '=== SUMMARY: PASS=4 FAIL=0 ==='\nexit 0\n");
  const bp = path.join(dir, "out.json");
  const r = runRunner(dir, bp, ["--write-baseline", "tests/bravo.tests.ps1"]);
  let j = null;
  try { j = JSON.parse(fs.readFileSync(bp, "utf8")); } catch (_) {}
  check("PS 套单套写 → exit 0 且两格同数（进程拿不到 --env，两层跑法字面相同）",
    r.code === 0 && j && j.suites["bravo.tests.ps1"].default === 4 && j.suites["bravo.tests.ps1"].env === 4,
    JSON.stringify(r.sum) + " " + JSON.stringify(j && j.suites));
  check("PS 套 kind=pwsh", j && j.suites["bravo.tests.ps1"].kind === "pwsh", JSON.stringify(j && j.suites));
}
{
  // PS 夹具·标了 env：default 格写「本层不跑」，env 格填数 —— 与全量写同一形态
  const dir = path.join(TMP, "single-ps-env");
  w(path.join(dir, "tests", "charlie.tests.ps1"), "# @dao-test-tier: env\nWrite-Output '=== SUMMARY: PASS=6 FAIL=0 ==='\nexit 0\n");
  const bp = path.join(dir, "out.json");
  const r = runRunner(dir, bp, ["--write-baseline", "tests/charlie.tests.ps1"]);
  let j = null;
  try { j = JSON.parse(fs.readFileSync(bp, "utf8")); } catch (_) {}
  check("标 env 的 PS 套：default 格写「本层不跑」、env 格填真数",
    r.code === 0 && j && j.suites["charlie.tests.ps1"].default === "本层不跑" && j.suites["charlie.tests.ps1"].env === 6,
    JSON.stringify(r.sum) + " " + JSON.stringify(j && j.suites));
}
{
  // 互斥与边界：全部 exit 3，且一套都不许跑
  const c = mkSuitePair("single-usage");
  const bp = path.join(c.dir, "out.json");
  const cases = [
    [["--write-baseline", "tests/alpha.tests.js", "--env"], "--env 与单套互斥"],
    [["--write-baseline", "tests/alpha.tests.js", "--list"], "--list 与单套互斥"],
    [["tests/alpha.tests.js"], "位置参数缺 --write-baseline"],
    [["--write-baseline", "tests/alpha.tests.js", "tests/beta.tests.js"], "两个位置参数"],
    [["--write-baseline", "tests/nonexistent.tests.js"], "盘上不存在的套"],
  ];
  for (const [args, label] of cases) {
    const r = runRunner(c.dir, bp, args);
    check(`用法错（${label}）→ exit 3`, r.code === 3, label + " => " + String(r.code) + " " + r.err.slice(0, 200));
  }
  check("五种用法错一套都没跑（alpha sentinel 不存在）", !fs.existsSync(c.aSent), c.aSent);
}

console.log("\n──── ⑧ 兼容负控：新字段只追加在尾部，旧消费方的正则仍然解析得到 ────");
{
  const d = mkFixture("compat", { pass: 5 });
  const b = mkBaseline(d, { suites: { "alpha.tests.js": { kind: "node", default: 5, env: 5 } } });
  const r = runRunner(d, b);
  // issue #179 那一版的正则（到 psskip 为止，无行尾锚）—— 逐字抄，别复用上面那个
  const OLD = /RUN_TESTS_SUMMARY exit=(\d+) tier=(\w+) files=(\d+) red=(\d+) pass=(\d+) fail=(\d+) defer=(\d+) deferfiles=(\d+) declared=(\d+) selfcheck=(ok|fail|n\/a) psfiles=(\d+) psred=(\d+) psskip=(\d+)/;
  check("issue #179 那一版末行正则仍然命中（新字段追加在尾部，没插在中间）",
    OLD.test(r.out), r.out.slice(-300));
  check("新字段排在 psskip 之后", /psskip=\d+ baselow=\d+ basegate=\w+/.test(r.out), r.out.slice(-300));
}

rm(TMP);
console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
