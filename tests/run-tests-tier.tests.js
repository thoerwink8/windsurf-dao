// run-tests 分层机制的回归网 — scripts/run-tests.mjs 的退出码契约与自检半边
//
// 跑法：node tests/run-tests-tier.tests.js   （全绿 exit 0，任一红 exit 1）
//       node scripts/run-tests.mjs           （自动发现本文件，无需登记）
//
// ── 为什么需要这个文件（issue #116）─────────────────────────────────────────
// run-tests.mjs 现在承担一个**判据**：哪些断言算「本次没跑」，以及「没跑」要在退出码上
// 怎么表达。判据类的东西一旦自己坏掉，症状恰恰是「一切看起来正常」——
// defer 计数解析一失灵 ⇒ 全场 defer=0 ⇒ exit 0 ⇒ 「没跑」又变回「跑了全过」。
// 故这里对它做双向断言：
//   正控 —— 该 2 的时候必须 2、该 4 的时候必须 4、该 3 的时候**一套都不许跑**
//   负控 —— 全绿零 defer 的场子不许被顶成 2；头部没标记的普通测试不许被误判
//
// ── 夹具形态 ────────────────────────────────────────────────────────────────
// 每例一个 `_tmp/run-tests-tier/<case>/tests/` 目录，里面是合成的 `*.tests.js`：
// 它们只打一行汇总、按参数决定 DEFER 值、并往 sentinel 文件里记一笔「我被跑到了」。
// sentinel 是「一套都没跑」那条断言的唯一证据 —— 只看退出码分不出「跑完了都过」与
// 「压根没起跑」，这正是本机制自己要治的病。
//
// ⚠ 本文件**刻意不在头部写出层级标记的字面量**：run-tests 的标记扫描面就是
//   `<tests 目录>/*.tests.js` 的头部若干行，而本文件正住在那个面里。标记由下面
//   `TIER_MARKER` 拼接而成（同 dead-gates 里 `PH` 那一手），且位置在头部窗口之外——
//   「检查器的输出不能落在它自己的扫描面内」的同一条判据，换个身位。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const RUNNER = path.join(REPO, "scripts", "run-tests.mjs");
const TMP = path.join(REPO, "_tmp", "run-tests-tier");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}

// 拼接而成，故本文件源码里不存在能被标记扫描命中的那种行（见文件头 ⚠）
const TIER_MARKER = "// @" + "dao-test-tier: env";

const SUMMARY_RE = /RUN_TESTS_SUMMARY exit=(\d+) tier=(\w+) files=(\d+) red=(\d+) pass=(\d+) fail=(\d+) defer=(\d+) deferfiles=(\d+) declared=(\d+) selfcheck=(ok|fail|n\/a)/;
function parseSummary(out) {
  const m = SUMMARY_RE.exec(String(out));
  return m ? {
    exit: Number(m[1]), tier: m[2], files: Number(m[3]), red: Number(m[4]),
    pass: Number(m[5]), fail: Number(m[6]), defer: Number(m[7]),
    deferfiles: Number(m[8]), declared: Number(m[9]), self: m[10],
  } : null;
}

// 末行的**全形**解析器（含 issue #179 追加的 psfiles/psred/psskip）。
// 刻意与上面那条 SUMMARY_RE **分开写**：那条是「旧消费方」的原样副本，本节 ㈥ 拿它当负控 ——
// 一个正则同时充当「被测形状」与「兼容性证据」，就没有兼容性证据可言了。
const PS_SUMMARY_RE = new RegExp(
  SUMMARY_RE.source + " psfiles=(\\d+) psred=(\\d+) psskip=(\\d+)");
function parsePsSummary(out) {
  const m = PS_SUMMARY_RE.exec(String(out));
  if (!m) return null;
  const base = parseSummary(out);
  return Object.assign({}, base, {
    psfiles: Number(m[11]), psred: Number(m[12]), psskip: Number(m[13]),
  });
}

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function w(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

// 造一个合成测试文件。
//   marker      —— 头部写不写层级标记
//   markerLate  —— 把标记写到头部窗口**之外**（负控：不该被算作声明）
//   pass/failN  —— 汇总行里的两个数
//   deferDefault—— 默认层下 DEFER 的值；--env 下恒 0（模拟正常的 defer 行为）
//   deferAlways —— 不管有没有 --env 都报这个 DEFER 值（模拟 --env 没透传到）
//   noSummary   —— 压根不打汇总行
//   exitCode    —— 进程退出码
function mkTestFile(caseDir, name, opts) {
  const o = opts || {};
  const sentinel = path.join(caseDir, "sentinel.log");
  const lines = [];
  if (o.marker) lines.push(TIER_MARKER);
  lines.push("// 合成夹具（run-tests-tier 回归网），非真测试");
  lines.push("const fs = require('fs');");
  lines.push("fs.appendFileSync(" + JSON.stringify(sentinel) + ", " +
    JSON.stringify(name) + " + ' argv=' + process.argv.slice(2).join(',') + '\\n');");
  if (o.markerLate) {
    // 头部窗口之外才出现标记：正确的扫描器不该把它算成声明
    for (let i = 0; i < 70; i++) lines.push("// 填充行 " + i);
    lines.push(TIER_MARKER);
  }
  if (!o.noSummary) {
    if (o.deferAlways != null) {
      lines.push("const D = " + o.deferAlways + ";");
    } else if (o.deferDefault != null) {
      lines.push("const D = process.argv.includes('--env') ? 0 : " + o.deferDefault + ";");
    } else {
      lines.push("const D = null;");
    }
    // 契约：报 DEFER=n 就得打 n 行明细（笨计数器对拍的另一半）。
    // noDeferLines 刻意违约，用来验对拍真的会响。
    if (!o.noDeferLines) {
      lines.push("for (let i = 0; i < (D || 0); i++) console.log('  DEFER 合成第 ' + i + ' 组  ->  夹具');");
    }
    lines.push("const tail = (D === null) ? '' : (' DEFER=' + D);");
    lines.push("console.log('=== 汇总: PASS=" + (o.pass == null ? 3 : o.pass) +
      " FAIL=" + (o.failN == null ? 0 : o.failN) + "' + tail + ' ===');");
  } else if (o.deferLinesOnly) {
    // 只打明细、不打汇总行：人看得见「有东西没跑」，机器通道上却是零
    lines.push("for (let i = 0; i < " + o.deferLinesOnly + "; i++) console.log('  DEFER 孤儿明细 ' + i + '  ->  夹具');");
  }
  lines.push("process.exit(" + (o.exitCode == null ? 0 : o.exitCode) + ");");
  w(path.join(caseDir, "tests", name), lines.join("\n") + "\n");
  return sentinel;
}

// 造一个合成的 **PowerShell** 夹具（issue #179：PS 层由 run-tests.mjs 代跑之后才需要它）。
//   marker   —— 头部写不写 PS 形态的层级标记（`#` 而非 `//`）
//   bom      —— 落盘时带不带 UTF-8 BOM（真仓 6 套里 5 套带；标记在第 1 行 + BOM 是已知的
//               「标记形同没写」陷阱，这里造出来钉住扫描器确实剥了 BOM）
//   silent   —— 一个字都不打（验「exit 0 + 零输出」那一格）
//   sleepSec —— 睡多久（验超时判红；配 DAO_PS_TIMEOUT_MS 注入短超时用。
//               ⑩ 的总预算场景也用它 —— 那边要的是「有一套真的花掉了墙钟」）
//   exitCode —— 退出码
// 正文一律 ASCII：夹具的编码不该成为被测面的一部分（真仓那 6 套自带 console-utf8 钉子）。
function mkPsTestFile(caseDir, name, opts) {
  const o = opts || {};
  const sentinel = path.join(caseDir, "ps-sentinel.log");
  const lines = [];
  if (o.marker) lines.push("# @" + "dao-test-tier: env   # synthetic fixture");
  lines.push("# synthetic pwsh fixture (run-tests-tier), not a real test");
  // sentinel：唯一能证明「这一套真的起了进程」的证据 —— 只看退出码分不出「跑了都过」与「压根没起跑」
  lines.push("Add-Content -LiteralPath " + JSON.stringify(sentinel) + " -Value " + JSON.stringify(name));
  if (o.sleepSec) lines.push("Start-Sleep -Seconds " + o.sleepSec);
  if (!o.silent) lines.push("Write-Output '=== SUMMARY: PASS=" + (o.pass == null ? 4 : o.pass) +
    " FAIL=" + (o.failN == null ? 0 : o.failN) + " ==='");
  lines.push("exit " + (o.exitCode == null ? 0 : o.exitCode));
  const text = lines.join("\r\n") + "\r\n";
  const file = path.join(caseDir, "tests", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (o.bom ? "\uFEFF" : "") + text, "utf8");
  return sentinel;
}

function mkCase(name, files) {
  const dir = path.join(TMP, name);
  rm(dir);
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  let sentinel = path.join(dir, "sentinel.log");
  for (const [fname, opts] of Object.entries(files)) sentinel = mkTestFile(dir, fname, opts);
  return { dir, sentinel };
}

// PS 夹具的场子：`js` 那格给的是 .tests.js 夹具（PS 场景仍需要至少一个 JS 套，否则
// 「JS 侧一套没有」会成为另一个变量），`ps` 那格给的是 .tests.ps1 夹具。
function mkPsCase(name, spec) {
  const dir = path.join(TMP, name);
  rm(dir);
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  for (const [fname, opts] of Object.entries(spec.js || { "alpha.tests.js": { pass: 2 } })) mkTestFile(dir, fname, opts);
  let psSentinel = path.join(dir, "ps-sentinel.log");
  for (const [fname, opts] of Object.entries(spec.ps || {})) psSentinel = mkPsTestFile(dir, fname, opts);
  return { dir, psSentinel };
}
function psRan(sentinel, name) {
  try { return new RegExp(name.replace(/\./g, "\\.")).test(fs.readFileSync(sentinel, "utf8")); }
  catch (_) { return false; }
}

function runRunner(caseDir, extraArgs, extraEnv) {
  const args = [RUNNER, "--tests-dir", path.join(caseDir, "tests")].concat(extraArgs || []);
  const r = spawnSync(process.execPath, args, {
    encoding: "utf8", timeout: 120000, cwd: REPO,
    env: extraEnv ? Object.assign({}, process.env, extraEnv) : process.env,
  });
  const out = String(r.stdout || "");
  return { code: r.status, out, err: String(r.stderr || ""), sum: parseSummary(out), psSum: parsePsSummary(out) };
}

rm(TMP);

// ══════════════════════════════════════════════════════════════
console.log("\n──── ① 负控：没有任何环境敏感层 → exit 0（不许被顶成 2）────");
{
  const c = mkCase("plain", {
    "alpha.tests.js": { pass: 5 },
    "beta.tests.js": { pass: 7 },
  });
  const r = runRunner(c.dir);
  check("exit 0", r.code === 0 && r.sum && r.sum.exit === 0, JSON.stringify(r.sum) + "\n" + r.out.slice(-500));
  check("末行 defer=0 declared=0 selfcheck=ok", r.sum && r.sum.defer === 0 && r.sum.declared === 0 && r.sum.self === "ok", JSON.stringify(r.sum));
  check("断言合计照旧加总（PASS=12）", r.sum && r.sum.pass === 12, JSON.stringify(r.sum));
  check("没有 defer 时不打那段「本次未跑」的喇叭", !/本次未跑/.test(r.out), r.out.slice(-600));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ② 正控：有环境敏感层 → 默认层 exit 2，且「没跑」看得见 ────");
{
  const c = mkCase("tiered", {
    "alpha.tests.js": { pass: 5 },
    "zeta.tests.js": { marker: true, pass: 9, deferDefault: 3 },
  });
  const r = runRunner(c.dir);
  check("默认层 exit 2（不是 0 —— 「没跑」与「跑了全过」分得开）",
    r.code === 2 && r.sum && r.sum.exit === 2, JSON.stringify(r.sum) + "\n" + r.out.slice(-700));
  check("末行 defer=3 deferfiles=1 declared=1", r.sum && r.sum.defer === 3 && r.sum.deferfiles === 1 && r.sum.declared === 1, JSON.stringify(r.sum));
  check("自检 ok（这是预期的 defer，不是机制坏了）", r.sum && r.sum.self === "ok", JSON.stringify(r.sum));
  check("正文点名到具体文件（只报个数字等于没报）", /zeta\.tests\.js\s+DEFER=3/.test(r.out), r.out.slice(-900));
  check("正文明说「没跑」不等于「跑了全过」", /不等于/.test(r.out) && /本次未跑/.test(r.out), r.out.slice(-900));
  check("正文给出跑完整层的命令", /--env/.test(r.out), r.out.slice(-900));
  check("正文写明要串行环境（不写清楚，跑了也不作数）", /串行/.test(r.out), r.out.slice(-900));
  check("汇总表给声明了环境敏感层的文件打标", /zeta\.tests\.js ⚑env/.test(r.out), r.out.slice(-900));

  // ── 同一组夹具走 --env：应当全跑、零 defer、exit 0 ──
  const e = runRunner(c.dir, ["--env"]);
  check("--env → exit 0 且 tier=env", e.code === 0 && e.sum && e.sum.exit === 0 && e.sum.tier === "env", JSON.stringify(e.sum) + "\n" + e.out.slice(-500));
  check("--env → defer=0（那几节真跑了）", e.sum && e.sum.defer === 0, JSON.stringify(e.sum));
  check("--env → declared 仍为 1（声明面不随层级变）", e.sum && e.sum.declared === 1, JSON.stringify(e.sum));

  // 🔴 本机制的**核心负控**，派单令点名要的那一条 —— 同一组夹具、同一个入口，
  // 「那一层被跳过」与「那一层跑了全过」的退出码**必须不相等**。
  // 上面两条各自断言了 2 和 0，但那是两个独立的正控；只有把它们摆在一起比，
  // 才排除掉「两种情形恰好落到同一个码」这个失效模式 —— 而那正是这次改造要治的病本身
  // （改造前 `-Skip` 全部硬闸后的退出码与全绿逐字节相同，见 mousse-cli verify-exit.ps1 头注）。
  check("🔴 负控：跳过那一层的退出码 ≠ 跑完那一层的退出码（否则本改造制造了它要治的病）",
    r.code !== e.code, "默认层=" + r.code + " / --env=" + e.code);
  check("🔴 负控：且「跑完」那一侧才是 0（不是反过来）", e.code === 0 && r.code !== 0,
    "默认层=" + r.code + " / --env=" + e.code);
  check("🔴 负控：两侧的机器可读末行也分得开（不只是退出码这一个通道）",
    r.sum && e.sum && r.sum.tier !== e.sum.tier && r.sum.defer !== e.sum.defer,
    JSON.stringify(r.sum) + " vs " + JSON.stringify(e.sum));
  // --env 是不是真的透传到了子进程：sentinel 里记着每个夹具收到的 argv
  const sent = fs.readFileSync(c.sentinel, "utf8");
  check("--env 真的透传给了每个测试文件（不是只改了自己的判定）",
    /alpha\.tests\.js argv=--env/.test(sent) && /zeta\.tests\.js argv=--env/.test(sent), sent.slice(0, 400));
  check("默认层那一跑给子进程的 argv 是空的", /alpha\.tests\.js argv=\s*$/m.test(sent), sent.slice(0, 400));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ③ 自检半边：静态声明与运行期计数对不上 → exit 4 ────");
// 这一节钉的是「数 defer 的那一半自己瞎了」时会怎样。五种不一致各一条。
{
  // ㈠ 标记在，却从不 defer —— 标记过期，或 defer 机制坏了
  const c = mkCase("stale-marker", {
    "zeta.tests.js": { marker: true, pass: 9 },   // 有标记、无 DEFER 字段…
  });
  const r = runRunner(c.dir);
  check("㈠ 声明了却没打 DEFER 字段 → exit 4 / selfcheck=fail",
    r.code === 4 && r.sum && r.sum.exit === 4 && r.sum.self === "fail", JSON.stringify(r.sum) + "\n" + r.out.slice(-800));
  check("㈠ 报文说清是「无从判断那几节跑没跑」", /无从判断/.test(r.out), r.out.slice(-900));
}
{
  // ㈠′ 标记在、DEFER 字段也在，但值恒 0 —— 标记过期的另一种形态
  const c = mkCase("stale-marker-zero", {
    "zeta.tests.js": { marker: true, pass: 9, deferAlways: 0 },
  });
  const r = runRunner(c.dir);
  check("㈠′ 声明了却 DEFER=0 → exit 4", r.code === 4 && r.sum && r.sum.self === "fail", JSON.stringify(r.sum) + "\n" + r.out.slice(-800));
  check("㈠′ 报文给出两种可能（标记过期 / 机制坏了），不替人下结论",
    /标记过期/.test(r.out) && /机制坏了/.test(r.out), r.out.slice(-900));
}
{
  // ㈡ defer 了却没标记 —— 静态那半从此看不见它
  const c = mkCase("unmarked-defer", {
    "zeta.tests.js": { pass: 9, deferDefault: 2 },
  });
  const r = runRunner(c.dir);
  check("㈡ 没标记却 DEFER=2 → exit 4", r.code === 4 && r.sum && r.sum.exit === 4 && r.sum.self === "fail", JSON.stringify(r.sum) + "\n" + r.out.slice(-800));
  check("㈡ 报文点出「标记漏加」", /标记漏加/.test(r.out), r.out.slice(-900));
}
{
  // ㈢ --env 下仍在 defer —— 说明 --env 没透传到（你以为跑了，其实没跑）
  const c = mkCase("env-not-passed", {
    "zeta.tests.js": { marker: true, pass: 9, deferAlways: 4 },
  });
  const r = runRunner(c.dir, ["--env"]);
  check("㈢ --env 下仍 DEFER=4 → exit 4", r.code === 4 && r.sum && r.sum.exit === 4, JSON.stringify(r.sum) + "\n" + r.out.slice(-800));
  check("㈢ 报文点出「--env 没透传到」", /没透传到/.test(r.out), r.out.slice(-900));
}
{
  // ㈣ **笨计数器对拍**：汇总行说 DEFER=3，正文里一行明细都没有 ⇒ 两个数对不上。
  //    这一档防的是「聚合字段算错了而明细是对的」（或反过来）—— 只有一套计数时，
  //    错了也没人知道，输出照样体面。形态照抄 check-mutation-anchor.mjs 的独立笨计数器。
  const c = mkCase("defer-count-mismatch", {
    "zeta.tests.js": { marker: true, pass: 9, deferDefault: 3, noDeferLines: true },
  });
  const r = runRunner(c.dir);
  check("㈣ 汇总说 DEFER=3 而明细 0 行 → exit 4", r.code === 4 && r.sum && r.sum.exit === 4 && r.sum.self === "fail",
    JSON.stringify(r.sum) + "\n" + r.out.slice(-800));
  check("㈣ 报文把两个数都摆出来（人得知道是哪一半错了）",
    /DEFER=3/.test(r.out) && /明细有 0 行/.test(r.out), r.out.slice(-900));
  check("㈣ 报文点出这是「两套独立计数对不上」", /两套独立计数对不上/.test(r.out), r.out.slice(-900));
}
{
  // ㈤ 只有明细行、没有汇总字段 —— 人眼看得见「有东西没跑」，机器通道上却是零。
  //    这正是本机制要防的那个病的**镜像**：不是「没报」，是「只报给人看」。
  const c = mkCase("defer-lines-no-field", {
    "zeta.tests.js": { noSummary: true, deferLinesOnly: 2 },
  });
  const r = runRunner(c.dir);
  check("㈤ 有 2 行 DEFER 明细却无 DEFER= 字段 → exit 4", r.code === 4 && r.sum && r.sum.exit === 4,
    JSON.stringify(r.sum) + "\n" + r.out.slice(-800));
  check("㈤ 报文点出「人看得见，机器看不见」", /机器看不见/.test(r.out), r.out.slice(-900));
}
{
  // 负控：明细与字段对得上时不许报（对拍不能恒红）
  const c = mkCase("defer-count-match", {
    "zeta.tests.js": { marker: true, pass: 9, deferDefault: 5 },
  });
  const r = runRunner(c.dir);
  check("负控：DEFER=5 且明细 5 行 → 只是 exit 2，不报自检失败",
    r.code === 2 && r.sum && r.sum.self === "ok" && r.sum.defer === 5, JSON.stringify(r.sum) + "\n" + r.out.slice(-800));
}
{
  // 负控：自检半边不许恒红 —— 正常的分层场子必须 ok（②已验，这里再钉一个纯净样本）
  const c = mkCase("selfcheck-negative", {
    "zeta.tests.js": { marker: true, pass: 9, deferDefault: 1 },
  });
  const r = runRunner(c.dir);
  check("负控：正常分层样本 selfcheck=ok（自检不恒红）", r.sum && r.sum.self === "ok" && r.code === 2, JSON.stringify(r.sum));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ④ 标记扫描只看头部（负控：正文里提到它不算声明）────");
{
  const c = mkCase("marker-late", {
    "zeta.tests.js": { markerLate: true, pass: 9 },
  });
  const r = runRunner(c.dir);
  check("头部窗口之外出现的标记不算声明（declared=0）", r.sum && r.sum.declared === 0, JSON.stringify(r.sum) + "\n" + r.out.slice(-600));
  check("于是它是个普通测试：exit 0", r.code === 0 && r.sum && r.sum.exit === 0, JSON.stringify(r.sum));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑤ 优先级：红 > 自检失败 > defer ────");
{
  const c = mkCase("red-wins", {
    "alpha.tests.js": { pass: 1, failN: 1, exitCode: 1 },
    "zeta.tests.js": { marker: true, pass: 9, deferDefault: 3 },
  });
  const r = runRunner(c.dir);
  check("有红时 exit 1（真失败比没跑完更急）", r.code === 1 && r.sum && r.sum.exit === 1, JSON.stringify(r.sum) + "\n" + r.out.slice(-800));
  check("末行仍如实报 red=1 与 defer=3（退出码取一个，账本不许丢另一个）",
    r.sum && r.sum.red === 1 && r.sum.defer === 3, JSON.stringify(r.sum));
  check("失败详情照旧打印", /失败详情 tests\/alpha\.tests\.js/.test(r.out), r.out.slice(0, 900));
}
{
  const c = mkCase("selfcheck-over-defer", {
    "yankee.tests.js": { marker: true, pass: 9, deferDefault: 3 },   // 正常 defer
    "zulu.tests.js": { pass: 9, deferDefault: 2 },                   // 没标记却 defer
  });
  const r = runRunner(c.dir);
  check("自检失败盖过 defer（exit 4 而不是 2）", r.code === 4 && r.sum && r.sum.exit === 4, JSON.stringify(r.sum) + "\n" + r.out.slice(-800));
}
{
  // 红的文件不参与分层记账：它可能压根没跑到汇总行，拿它算 defer 只会制造第二条噪音
  const c = mkCase("red-declared", {
    "zeta.tests.js": { marker: true, noSummary: true, exitCode: 1 },
  });
  const r = runRunner(c.dir);
  check("声明了环境敏感层的文件红掉 → 报 exit 1，不额外报分层自检失败",
    r.code === 1 && r.sum && r.sum.self === "ok", JSON.stringify(r.sum) + "\n" + r.out.slice(-800));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑥ 用法错误 → exit 3，且**一套都不许跑** ────");
// 判据抄自 mousse-cli verify-exit.ps1 边界②：显式意图不兑现没有「大致对」的余地。
// 打错的 `--env` 若被静默忽略，你以为跑了环境敏感层，实际跑的是默认层。
{
  const c = mkCase("bad-usage", { "alpha.tests.js": { pass: 3 } });
  const r = runRunner(c.dir, ["--enviroment"]);   // 少个 n 的真实手误
  check("不认识的参数 → exit 3", r.code === 3, String(r.code) + " " + r.err.slice(0, 300));
  check("stderr 点名是哪个参数不认识", /--enviroment/.test(r.err), r.err.slice(0, 400));
  check("stderr 列出合法参数（报错要能直接改命令行）", /--env/.test(r.err) && /--list/.test(r.err), r.err.slice(0, 400));
  // 唯一能证明「一套都没跑」的证据：夹具的 sentinel 压根没被建出来
  check("**一套测试都没跑**（sentinel 不存在 —— 只看退出码分不出「都过了」与「没起跑」）",
    !fs.existsSync(c.sentinel), "sentinel=" + c.sentinel);
  check("末行仍打得出（用法错误也不许表现为「什么都没说」）", r.sum !== null && r.sum.exit === 3, r.out.slice(-300));
}
{
  const c = mkCase("bad-usage-2", { "alpha.tests.js": { pass: 3 } });
  const r = spawnSync(process.execPath, [RUNNER, "--tests-dir"], { encoding: "utf8", timeout: 60000, cwd: REPO });
  check("--tests-dir 后面没给路径 → exit 3", r.status === 3, String(r.status) + " " + String(r.stderr || "").slice(0, 300));
  check("不存在的夹具没被跑（sentinel 不存在）", !fs.existsSync(c.sentinel), c.sentinel);
}
{
  // 「测试目录不存在」原先退 2 —— 而 2 现在是「有 defer」。**两件事不许共用一个码**，
  // 否则「本次没跑完」与「压根没有测试目录」在唯一的机器通道上又合流了。现改退 5。
  const ghost = path.join(TMP, "no-such-dir", "tests");
  const r = spawnSync(process.execPath, [RUNNER, "--tests-dir", ghost], { encoding: "utf8", timeout: 60000, cwd: REPO });
  check("测试目录不存在 → exit 5（**不是 2** —— 别和「有 defer」共用一个码）",
    r.status === 5, String(r.status) + " " + String(r.stderr || "").slice(0, 300));
  check("报文给出那个找不到的路径", /no-such-dir/.test(String(r.stderr || "")), String(r.stderr || "").slice(0, 300));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑦ --list：只列不跑，且标注分层 ────");
{
  const c = mkCase("list", {
    "alpha.tests.js": { pass: 3 },
    "zeta.tests.js": { marker: true, pass: 9, deferDefault: 3 },
  });
  const r = runRunner(c.dir, ["--list"]);
  check("--list exit 0", r.code === 0, String(r.code) + " " + r.out.slice(-300));
  check("--list 给声明了环境敏感层的文件加注（不看源码也知道有一层默认不跑）",
    /zeta\.tests\.js\s+\[有环境敏感层/.test(r.out), r.out.slice(-600));
  check("--list 不给普通文件乱加注", !/alpha\.tests\.js\s+\[有环境敏感层/.test(r.out), r.out.slice(-600));
  check("--list 一套都不跑（sentinel 不存在）", !fs.existsSync(c.sentinel), c.sentinel);
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑧ 真仓自跑：本仓当下哪几套声明了环境敏感层 ────");
// 合成夹具证不了「它在真实 tests/ 目录上跑得动」（本仓有过实证：47 条合成断言全绿、
// 真实语料一份都没扫成）。这一条只做**静态**核对，不重跑整套 —— 重跑要两分半，
// 而分层这件事的判据是静态可查的。
{
  const realTests = fs.readdirSync(path.join(REPO, "tests")).filter((f) => f.endsWith(".tests.js")).sort();
  const MARK_RE = new RegExp("^[ \\t]*//[ \\t]*@" + "dao-test-tier:[ \\t]*env\\b", "m");
  const declared = realTests.filter((f) => {
    const head = fs.readFileSync(path.join(REPO, "tests", f), "utf8").split(/\r?\n/).slice(0, 60).join("\n");
    return MARK_RE.test(head);
  });
  // 🔴 **这是一条刻意手维护的枚举，与本仓「手维护的清单会过期」那条教训不矛盾**：
  //   它的职责就是**过期时变红**（多一个要问为什么、少一个说明标记掉了），
  //   即「给标记的增删造一个触发器」（dao-guard-writing `[#守-退役触发]` 同一路数）。
  //   2026-08-08 · issue #160 它按设计响了一次：alwayson-budget 与 memory-truth-source
  //   各摘出一节 hook 注入断言进 env 层，本行随之从「恰是 dead-gates 一套」扩到三套。
  //   ⚠ **改这一行之前先答一句**：新加的那套，它 defer 掉的是不是真的「对别人拥有的机器级
  //   可变状态做不变量断言」？不是的话，正路是修那几条断言，不是往这个集合里加名字。
  //   2026-08-08 · issue #92 它又响了一次：mcp-health.tests.js 新增一节「真机自跑」，
  //   实打一次真实 `claude mcp list`——本机是否装了 claude CLI、当下哪些 MCP server 连得上，
  //   同样是「别人（或此刻的外部世界）拥有的机器级可变状态」（本机实测同一台机器换一次
  //   跑就从 `! Connected · tools fetch failed` 变回 `✔ Connected`），故本行随之扩到四套。
  const EXPECT_DECLARED = [
    "alwayson-budget.tests.js",     // §⑩①b：hook 墙钟预算读自用户真实 settings.json 的注册值
    "dead-gates.tests.js",          // ⑪ / ⑪.5 / ⑫①：真 live settings + 真 cc-switch DB
    "mcp-health.tests.js",          // ⑥：真跑一次 claude mcp list，依赖本机 CLI + 当下 server 健康态
    "memory-truth-source.tests.js", // 末节：同 alwayson-budget，且 memory 扫描排在全表最后一项
  ];
  check("真实 tests/ 里声明了环境敏感层的文件恰是那四套（多了要问为什么，少了说明标记掉了）",
    JSON.stringify(declared) === JSON.stringify(EXPECT_DECLARED),
    "实况=" + JSON.stringify(declared) + " 期望=" + JSON.stringify(EXPECT_DECLARED));
  check("本文件自己不在声明面里（否则说明标记字面量泄进了头部窗口）",
    !declared.includes("run-tests-tier.tests.js"), JSON.stringify(declared));
  // dead-gates 默认层真跑一次：它是本机制唯一的真实消费方
  const dg = spawnSync(process.execPath, [path.join(REPO, "tests", "dead-gates.tests.js")], { encoding: "utf8", timeout: 180000, cwd: REPO });
  const dgOut = String(dg.stdout || "");
  const dgm = /PASS=(\d+)\s+FAIL=(\d+)\s+DEFER=(\d+)/.exec(dgOut);
  check("dead-gates 默认层：exit 0 且 DEFER>0（真实消费方确实在 defer）",
    dg.status === 0 && dgm && Number(dgm[3]) > 0, String(dg.status) + " " + dgOut.slice(-400));
  check("dead-gates 默认层自己也把「没跑」写在人眼可见处", /本次未跑/.test(dgOut), dgOut.slice(-400));
  // 真语料上的笨计数器对拍：明细行数必须等于汇总字段（合成夹具证不了真消费方守约）
  const dgLines = (dgOut.match(/^[ \t]*DEFER[ \t]/gm) || []).length;
  check("dead-gates 真语料：DEFER 明细行数 == 汇总行 DEFER 字段（笨计数器对拍）",
    dgm && dgLines === Number(dgm[3]), "明细=" + dgLines + " 字段=" + (dgm ? dgm[3] : "无"));
  check("dead-gates 的每组 defer 都指名（只报个数字等于没报）",
    /DEFER\s+⑪/.test(dgOut) && /DEFER\s+⑫/.test(dgOut), dgOut.slice(0, 1200));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑨ PowerShell 层：代跑 / 自声明标记 / 红 / 零输出 / 超时（issue #179）────");
// 这一节钉的是「.ps1 从此由本入口代跑」之后新增的那半判据。**每一条都用 sentinel 佐证
// 「起没起进程」** —— 退出码分不出「跑了都过」与「压根没起跑」，那是本文件通篇的判据。
{
  // ㈠ 无标记的 PS 套：默认层就跑，计入 psfiles，不把全场顶成 2
  const c = mkPsCase("ps-plain", { ps: { "green.tests.ps1": { bom: true, pass: 6 } } });
  const r = runRunner(c.dir);
  check("㈠ 无标记 PS 套默认层被跑 → exit 0", r.code === 0 && r.psSum && r.psSum.psfiles === 1,
    JSON.stringify(r.psSum) + "\n" + r.out.slice(-800));
  check("㈠ sentinel 佐证它真的起了进程（不是只在账面上算跑了）",
    psRan(c.psSentinel, "green.tests.ps1"), "sentinel=" + c.psSentinel);
  check("㈠ 末行 psfiles=1 psred=0 psskip=0",
    r.psSum && r.psSum.psfiles === 1 && r.psSum.psred === 0 && r.psSum.psskip === 0, JSON.stringify(r.psSum));
  check("㈠ 汇总表里有它那一行（前缀 pwsh）", /pwsh tests\/green\.tests\.ps1/.test(r.out), r.out.slice(-900));
  check("㈠ 计数解析沿用 PASS=/FAIL=（打了汇总行的套要报出来）", /PASS=\s*6 FAIL=0/.test(r.out), r.out.slice(-900));
  check("㈠ 不再打「本入口不代跑」那句旧话", !/本入口不代跑/.test(r.out), r.out.slice(-900));
}
{
  // ㈡ 红的 PS 套 ⇒ 全场 exit 1（PS 的红与 node 的红同权）
  const c = mkPsCase("ps-red", { ps: { "boom.tests.ps1": { exitCode: 1, failN: 2, pass: 1 } } });
  const r = runRunner(c.dir);
  check("㈡ PS 套 exit 1 → 全场 exit 1", r.code === 1 && r.psSum && r.psSum.exit === 1 && r.psSum.psred === 1,
    JSON.stringify(r.psSum) + "\n" + r.out.slice(-900));
  check("㈡ 打了失败详情（哪一套红了不该要重跑才知道）",
    /失败详情 tests\/boom\.tests\.ps1（pwsh/.test(r.out), r.out.slice(0, 1500));
  check("㈡ node 侧 red 字段不被 PS 的红污染（两侧账各归各）",
    r.psSum && r.psSum.red === 0 && r.psSum.psred === 1, JSON.stringify(r.psSum));
}
{
  // ㈢ 标了 env 的 PS 套：默认层整套不起进程（psskip、exit≥2），--env 才跑。
  //    夹具刻意带 BOM 且标记在第 1 行 —— 那正是「标记形同没写」的已知陷阱。
  const c = mkPsCase("ps-marked", {
    ps: {
      "fast.tests.ps1": { bom: true, pass: 3 },
      "slow.tests.ps1": { bom: true, marker: true, pass: 9 },
    },
  });
  const r = runRunner(c.dir);
  check("㈢ 默认层：标了 env 的那套不跑 → exit 2", r.code === 2 && r.psSum && r.psSum.exit === 2,
    JSON.stringify(r.psSum) + "\n" + r.out.slice(-1000));
  check("㈢ 默认层末行 psfiles=1 psskip=1（跑了一套、跳了一套）",
    r.psSum && r.psSum.psfiles === 1 && r.psSum.psskip === 1, JSON.stringify(r.psSum));
  check("㈢ 🔴 BOM + 第 1 行标记确实被认出来了（扫描器剥了 BOM，否则这一格恒 0）",
    r.psSum && r.psSum.psskip === 1, JSON.stringify(r.psSum));
  check("㈢ sentinel：slow 没起过进程，fast 起了",
    !psRan(c.psSentinel, "slow.tests.ps1") && psRan(c.psSentinel, "fast.tests.ps1"),
    (() => { try { return fs.readFileSync(c.psSentinel, "utf8"); } catch (_) { return "(无 sentinel)"; } })());
  check("㈢ 逐套打明细：哪套没跑、为什么（不再只有一句散文 ⓘ）",
    /slow\.tests\.ps1.*@dao-test-tier/s.test(r.out) || /slow\.tests\.ps1/.test(r.out), r.out.slice(-1200));
  check("㈢ 正文明说「没跑」不等于「跑了全过」", /本次未跑：PowerShell/.test(r.out), r.out.slice(-1200));

  const e = runRunner(c.dir, ["--env"]);
  check("㈢ --env：两套都跑 → exit 0，psfiles=2 psskip=0",
    e.code === 0 && e.psSum && e.psSum.psfiles === 2 && e.psSum.psskip === 0,
    JSON.stringify(e.psSum) + "\n" + e.out.slice(-1000));
  check("㈢ --env sentinel：slow 这回真起了进程", psRan(c.psSentinel, "slow.tests.ps1"),
    (() => { try { return fs.readFileSync(c.psSentinel, "utf8"); } catch (_) { return "(无 sentinel)"; } })());
  // 🔴 与 JS 侧同型的核心负控：同一组夹具，「那套被跳过」与「那套跑了全过」的退出码必须不等
  check("㈢ 🔴 负控：跳过那一套的退出码 ≠ 跑了那一套的退出码",
    r.code !== e.code, "默认层=" + r.code + " / --env=" + e.code);
  check("㈢ 🔴 负控：且「跑完」那一侧才是 0", e.code === 0 && r.code !== 0,
    "默认层=" + r.code + " / --env=" + e.code);
}
{
  // ㈣ exit 0 + 零输出 ⇒ exit 4（F4）。「没有断言」与「断言全过」必须分得开。
  const c = mkPsCase("ps-silent", { ps: { "mute.tests.ps1": { silent: true } } });
  const r = runRunner(c.dir);
  check("㈣ PS 套 exit 0 却零输出 → exit 4（不是 0）", r.code === 4 && r.psSum && r.psSum.exit === 4,
    JSON.stringify(r.psSum) + "\n" + r.out.slice(-1000));
  check("㈣ 报文点出「exit 0 + 零输出」与「全过」分不开",
    /零输出/.test(r.out) && /mute\.tests\.ps1/.test(r.out), r.out.slice(-1000));
  check("㈣ 它走自检通道而不是红通道（psred 仍为 0）", r.psSum && r.psSum.psred === 0, JSON.stringify(r.psSum));
}
{
  // ㈤ 超时判红（F2）。DAO_PS_TIMEOUT_MS 注入 2s，夹具睡 30s。
  //    这一格是「超时=红」这条契约的唯一实测证据 —— 不注入短超时就只能读代码相信它。
  const c = mkPsCase("ps-timeout", { ps: { "sleeper.tests.ps1": { sleepSec: 30 } } });
  const t0 = Date.now();
  const r = runRunner(c.dir, [], { DAO_PS_TIMEOUT_MS: "2000" });
  const elapsed = Date.now() - t0;
  check("㈤ 超时 → 判红（exit 1），不判「跳过」也不判过",
    r.code === 1 && r.psSum && r.psSum.psred === 1 && r.psSum.psskip === 0,
    JSON.stringify(r.psSum) + "\n" + r.out.slice(-1200));
  check("㈤ DAO_PS_TIMEOUT_MS 真的生效了（整跑远快于夹具的 30s）", elapsed < 25000, "elapsed=" + elapsed + "ms");
  check("㈤ 打出孤儿进程/半写沙盒的警告（下一次跑的红可能出在这一次）",
    /不杀进程树/.test(r.out) && /_tmp/.test(r.out), r.out.slice(-1200));
  check("㈤ 汇总表给它打 ⏱超时 标", /⏱超时/.test(r.out), r.out.slice(-1200));
}
{
  // ㈥ 末行三个新字段：可解析、且**旧正则仍匹配**（追加式改动的负控）。
  //    旧 SUMMARY_RE 没有行尾锚，尾部追加字段不该让任何既有消费方瞎掉。
  const c = mkPsCase("ps-summary-shape", { ps: { "green.tests.ps1": { pass: 2 } } });
  const r = runRunner(c.dir);
  check("㈥ 负控：旧 SUMMARY_RE（不含 ps* 字段）仍然匹配得上", r.sum !== null, r.out.slice(-400));
  check("㈥ 旧字段的值一个没变形（files/red/defer/declared/selfcheck 照旧）",
    r.sum && r.sum.files === 1 && r.sum.red === 0 && r.sum.defer === 0 && r.sum.declared === 0 && r.sum.self === "ok",
    JSON.stringify(r.sum));
  check("㈥ 三个新字段可解析且顺序在尾部", /selfcheck=(?:ok|fail|n\/a) psfiles=\d+ psred=\d+ psskip=\d+/.test(r.out),
    r.out.slice(-400));
  // 用法错误那条独立字面量：两处末行形状必须一致，否则只读末行的消费方会在 exit 3 时解析不到新字段
  const bad = runRunner(c.dir, ["--enviroment"]);
  check("㈥ 用法错误（exit 3）那条末行也带三个新字段（两处字面量同形）",
    /exit=3 .*psfiles=0 psred=0 psskip=0/.test(bad.out), bad.out.slice(-400));
}
{
  // ㈦ --list：PS 套也要标出「整套默认不跑」，且一套都不许起进程
  const c = mkPsCase("ps-list", {
    ps: { "fast.tests.ps1": {}, "slow.tests.ps1": { marker: true } },
  });
  const r = runRunner(c.dir, ["--list"]);
  check("㈦ --list exit 0", r.code === 0, String(r.code) + " " + r.out.slice(-400));
  check("㈦ --list 给标了 env 的 PS 套加注", /slow\.tests\.ps1\s+\[标了 env/.test(r.out), r.out.slice(-600));
  check("㈦ --list 不给无标记的 PS 套乱加注", !/fast\.tests\.ps1\s+\[标了 env/.test(r.out), r.out.slice(-600));
  check("㈦ --list 一套 PS 都没起进程（sentinel 不存在）", !fs.existsSync(c.psSentinel), c.psSentinel);
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑩ PS 层总预算闸（issue #186：这一格此前零断言）────");
// 契约在 run-tests.mjs 头注 ⑤：串行累计墙钟超过 `PS_BUDGET_MS` ⇒ **剩余套判「未跑」**
// （不是排队等、不是判红），退出码至少 2。它兜的是「某套卡住把整个入口拖死」。
//
// 🔴 **为什么这一格此前是真空的，照直记**：`PS_BUDGET_MS` 原是硬编码 900s，而真 6 套合计
//   才 ≈100-150s ⇒ 回归网**结构上**造不出「预算耗尽」。PR #185 对抗官把闸整个关掉
//   （`if (false && spent >= PS_BUDGET_MS)`），全场 `PASS=95 FAIL=0` **一条都没红** ——
//   而「闸在且没触发」与「闸压根不在」在那份输出里逐字节相同。本节靠新增的注入口
//   `DAO_PS_BUDGET_MS` 把 900s 压到毫秒级，把那个场景造出来。
//
// ⚠ **注入口本身的射程照直写**：`DAO_PS_BUDGET_MS` 是「直接取环境值」，**没有** min 夹紧
//   （理由写在 run-tests.mjs 那个常量的头注：min 那个分支只在注入值 > 900s 时才起作用，
//   而要观察到差别就得造一个真花掉 900s 的夹具 —— 那正是造不出来的东西）。
//   ⇒ 「调大这个值等于把兜底关掉」这句话**只有头注在守，没有断言在守**，别读成有闸。
{
  // 三套：第一套真花掉墙钟，后两套必须都判「未跑」。
  // **两套而不是一套**：契约要求「逐套打明细」，一套证不了「逐」。
  const c = mkPsCase("ps-budget", {
    ps: {
      "a-slow.tests.ps1": { sleepSec: 2, pass: 1 },
      "b-rest.tests.ps1": { pass: 2 },
      "c-rest.tests.ps1": { pass: 3 },
    },
  });
  const r = runRunner(c.dir, [], { DAO_PS_BUDGET_MS: "500" });
  check("⑩ 预算用尽 → exit 2（未跑走 defer 通道，不是红）",
    r.code === 2 && r.psSum && r.psSum.exit === 2, JSON.stringify(r.psSum) + "\n" + r.out.slice(-1400));
  check("⑩ 末行 psfiles=1 psred=0 psskip=2（跑了一套、剩下两套判未跑，且一套都没红）",
    r.psSum && r.psSum.psfiles === 1 && r.psSum.psred === 0 && r.psSum.psskip === 2,
    JSON.stringify(r.psSum));
  // sentinel 是唯一能分开「跑了都过」与「压根没起跑」的证据 —— 全文件同一判据
  check("⑩ sentinel：a-slow 起了进程，b/c 一个都没起（不是只在账面上算跳过）",
    psRan(c.psSentinel, "a-slow.tests.ps1") &&
    !psRan(c.psSentinel, "b-rest.tests.ps1") && !psRan(c.psSentinel, "c-rest.tests.ps1"),
    (() => { try { return fs.readFileSync(c.psSentinel, "utf8"); } catch (_) { return "(无 sentinel)"; } })());
  // 🔴 **这一条 2026-08-08 由接手官按四向 mutation 的实测红集收紧**（issue #186 的
  //   「mutation 复验」那一格）。原判据是 `/b-rest\.tests\.ps1/` —— 只问「这个名字在正文里
  //   出现过吗」，而**闸被关掉时那两套照常跑、名字照常出现在汇总表里** ⇒ 它恒绿，
  //   可它的名字说的是「它们各有一行未跑明细」。这正是 `[#官抗-断言名实核对]` 的形态：
  //   名实不符只在交叉核对红集时现形（本节别的断言全红、独它绿），代码读不出来。
  //   收紧后判据 = 未跑明细那一行 **与预算那个理由同时在场**（`—— PS 层总预算 <注入值>ms`），
  //   而那句理由只有预算这条路打得出来（标记跳过那条路打的是另一句）。
  //
  // ── 四向 mutation 的红集（2026-08-08 实测，`scripts/run-tests.mjs` 那道闸）───────────
  //   ①删整段         ⇒ 本节 7 红（收紧后 8）· 别处 0 红 · canary：其余 100 条照绿
  //   ②`if (false &&…)`⇒ 与 ① **逐条相同**（那正是 PR #185 对抗官用过的形态）
  //   ③摘掉 `continue`（判定照做、结果不被消费）⇒ **只有 2 红**：`psfiles` 那条 + sentinel
  //     那条。⇒ **承担这一向的就是 sentinel**；「exit 2」那条在 ③ 下照绿（psskip 仍算得出 2），
  //     故它证不了「闸的答案有没有人听」。别把它读成冗余覆盖。
  //   ④`if (spent >= 0)`（恒真 · 反向）⇒ 26 红，其中本节 **5 条 🔴 负控里红了 4 条** ——
  //     ①②③ 全在「让闸变松」这一侧，不跑反向就不知道那几条负控会不会红。
  //     ⚠ **原文写的是「4 条负控全部变红」，那是笃定措辞且不实**（订正 2026-08-08 ·
  //     PR #200 对抗官 F4）：本节的 🔴 负控是 **5** 条，第 5 条「预算跳过不打失败详情」
  //     在 ④ 下**照绿** —— 恒真闸让每一套都判未跑，两侧都没有失败详情可打，那条断言
  //     结构上就不会被这一向碰到。⇒ **④ 验到的是 4/5，不是 5/5**；剩下那一条要另找方向。
  const detailLine = (name) =>
    new RegExp("· tests/" + name.replace(/\./g, "\\.") + "\\s+—— PS 层总预算 500ms 已用尽");
  check("⑩ 逐套打明细：剩下的**每一套**都有自己那一行「未跑 + 预算归因」（只报个数字等于没报）",
    detailLine("b-rest.tests.ps1").test(r.out) && detailLine("c-rest.tests.ps1").test(r.out),
    r.out.slice(-1400));
  check("⑩ 报文点名是「总预算」用尽，并把两个数都摆出来（预算值 + 已花）",
    /PS 层总预算 500ms 已用尽（已花 \d+ms）/.test(r.out), r.out.slice(-1400));
  // 🔴 归因：汇总表上「标记跳过」与「预算跳过」都只是一行 `⊘ 未跑`，而处置完全不同
  //   （前者去跑 --env，后者去查谁把预算吃光了）。混成一句话等于让人每次重新排查一遍。
  check("⑩ 🔴 归因：预算跳过的报文显式否认「标记跳过」，两种未跑分得开",
    /不是标记跳过/.test(r.out) && !/@dao-test-tier: env ⇒ 只在 --env 跑/.test(r.out),
    r.out.slice(-1400));
  check("⑩ 未跑那一段仍走「本次未跑：PowerShell」这条人眼通道", /本次未跑：PowerShell/.test(r.out),
    r.out.slice(-1400));

  // 🔴 **本节的核心负控**：同一组夹具、同一个入口，不注入短预算就必须三套全跑。
  //   没有它，上面每一条都可能只是「这三套在这个夹具上本来就跑不起来」也照样绿
  //   —— 那正是「比较基线必须先验证它自己是活的」在这一格的形态。
  // 显式把注入口清空，不只是「不传」：外层 shell 里若恰好设着这个变量，`process.env`
  // 会被原样继承下去，于是负控自己被污染成实验组（`Number("")` 是 0 ⇒ 走默认 900s）。
  const n = runRunner(c.dir, [], { DAO_PS_BUDGET_MS: "" });
  check("⑩ 🔴 负控：不注入 ⇒ 三套全跑、exit 0、psskip=0（红只能来自预算这个变量）",
    n.code === 0 && n.psSum && n.psSum.psfiles === 3 && n.psSum.psskip === 0,
    JSON.stringify(n.psSum) + "\n" + n.out.slice(-1200));
  check("⑩ 🔴 负控：不注入时 sentinel 里三套都在（「全跑」不是账面数字）",
    psRan(c.psSentinel, "b-rest.tests.ps1") && psRan(c.psSentinel, "c-rest.tests.ps1"),
    (() => { try { return fs.readFileSync(c.psSentinel, "utf8"); } catch (_) { return "(无 sentinel)"; } })());
  check("⑩ 🔴 负控：不注入时正文不出现总预算那句话（闸没触发就不该说话）",
    !/PS 层总预算/.test(n.out), n.out.slice(-800));
  // 两侧退出码必须不等 —— 与 ②/㈢ 同型：只有摆在一起比，才排除「两种情形恰好落到同一个码」
  check("⑩ 🔴 负控：预算用尽的退出码 ≠ 全跑的退出码", r.code !== n.code,
    "预算用尽=" + r.code + " / 全跑=" + n.code);

  // 负控：预算跳过**不是**红 —— 它与「某套真的失败」必须分得开（psred 那一格已断言 0，
  // 这里再钉一条报文层：不许打印失败详情，否则人会去查一个没跑过的套。
  check("⑩ 🔴 负控：预算跳过不打「失败详情」（没跑过的套不许长得像红了）",
    !/失败详情 tests\/b-rest\.tests\.ps1/.test(r.out) && !/失败详情 tests\/c-rest\.tests\.ps1/.test(r.out),
    r.out.slice(-1400));
}

console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " ===");
process.exit(fail ? 1 : 0);
