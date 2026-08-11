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
//   marker        —— 头部写不写 PS 形态的层级标记（`#` 而非 `//`），真声明位置（块注释外）
//   markerAfterBlockComment —— marker=true 时，标记之后再补一段 `<# ... #>` 块注释再继续
//               （镜像本仓真实三例的结构：先声明、后跟 help 块——验证块注释状态机不会
//               倒着把「离开块注释之后」的正文误判掉，issue #203①）
//   markerInProse —— 头部窗口内插一段 `<# ... #>` 块注释，散文里塞一个行首就是 `#` 的
//               标记字面量（模拟 PR #200 撞过的 `.NOTES` 坑：那句话被判为真声明的唯一
//               原因是旧扫描器不问「这一行是不是身处块注释内」）。正确的扫描器必须无视它，
//               **并且要出声**（PR #213 对抗官 F1：静默才是那条缺陷的要害）
//   deadZone —— 头一行就开一段**在头部窗口内不闭合**的块注释，标记落在它里面。
//               这是判词 F1a 那张死区表的合成形态（真仓 `dao-pr-merge` / `pr-body-scan`
//               第 1 行就是 `<#`）：标记确实不生效（PowerShell 认它是块注释正文），
//               但**必须打提示**，否则下一个想加标记的人得不到任何反馈
//   noise    —— 在**真标记之前**塞一批「长得像开块记号、其实不是」的行：行注释里提到它、
//               字符串字面量、here-string、孤立的闭合记号。**这四种是 PR #213 首版
//               自写记号扫描的假阴性死区**（每一种都会让其后的真标记静默失效），
//               取值 'lineComment' / 'stringLiteral' / 'hereString' / 'strayCloser'
//   bom      —— 落盘时带不带 UTF-8 BOM（真仓 7 套里 6 套带；标记在第 1 行 + BOM 是已知的
//               「标记形同没写」陷阱，这里造出来钉住 BOM 不会把标记吃掉）
//   silent   —— 一个字都不打（验「exit 0 + 零输出」那一格）
//   sleepSec —— 睡多久（验超时判红；配 DAO_PS_TIMEOUT_MS 注入短超时用。
//               ⑩ 的总预算场景也用它 —— 那边要的是「有一套真的花掉了墙钟」）
//   exitCode —— 退出码
// 正文一律 ASCII：夹具的编码不该成为被测面的一部分（真仓那几套自带 console-utf8 钉子）。
function mkPsTestFile(caseDir, name, opts) {
  const o = opts || {};
  const sentinel = path.join(caseDir, "ps-sentinel.log");
  const lines = [];
  if (o.inlineBlockThenMarker) {
    // 单行自封闭块注释（同一行内 <# ... #>）：练一遍「离开这一行后回到块注释外」这条状态
    // 转移，紧接着才是本行案例的真声明——确认这类单行块注释不会把后面的真标记也带偏。
    lines.push("<# a one-line block comment mentioning # @" + "dao-test-tier: env for illustration #>");
  }
  if (o.deadZone) {
    // 头一行就开块、且在头部窗口内**不闭合** —— 真仓 dao-pr-merge / pr-body-scan 的形态。
    // 标记落在块里 ⇒ 它不是声明（PowerShell 说了算），但入口必须为此出声。
    lines.push("<#");
    lines.push(".SYNOPSIS");
    lines.push("    " + "# @" + "dao-test-tier: env");
    for (let i = 0; i < 80; i++) lines.push("    filler prose line " + i);
    lines.push("#>");
  }
  if (o.noise) {
    // 🔴 这四行各自都是 PR #213 首版自写记号扫描的一个**死区入口**：它不认行注释、
    //   不认字符串、不认 here-string，于是把 `<#` 记号当成开块，其后的真标记全部失效。
    //   PowerShell 官方 parser 对四种一概不认为开了块（对抗官用 token 流核过）。
    const noise = {
      lineComment: ["# note: block comments start with <# and end later"],
      stringLiteral: ["$re = '<#'"],
      hereString: ["$h = @'", "<# not a comment, just text #", "'@"],
      strayCloser: ["# a stray closer follows: #>"],
    }[o.noise];
    if (!noise) throw new Error("未知的 noise 形态：" + o.noise);
    for (const l of noise) lines.push(l);
  }
  if (o.marker) lines.push("# @" + "dao-test-tier: env   # synthetic fixture");
  if (o.marker && o.markerAfterBlockComment) {
    lines.push("<#");
    lines.push(".NOTES");
    lines.push("    a help block that follows a genuine declaration line, not inside it");
    lines.push("#>");
  }
  if (o.markerInProse) {
    // 散文位：字面上「行首 # + 标记名」，但整段落在 <# ... #> 内部 —— 不是真声明。
    // 故意把它写在多行块注释里，且这段之前先有别的填充行，逼真复现 issue #203 的坑：
    // 真实事故里那句话住在 `.NOTES` 的正文段落，不是块注释起始那一行。
    lines.push("<#");
    lines.push(".NOTES");
    lines.push("    prior prose line before the trap");
    lines.push("    # @" + "dao-test-tier: env   # this is prose describing the syntax, not a real declaration");
    lines.push("    trailing prose line after the trap");
    lines.push("#>");
  }
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
console.log("\n──── ③′ JS 套不报计数 ⇒ 自检失败（issue #300 方向 4）────");
// 此前：exit 0 不打汇总行的套只被记成「未报计数」= 永久失去条数下界，
// 而汇总表那行照旧带对勾 —— 「没跑的闸」与「过了的闸」长得一样。
// 2026-08-11 起升格为 tierProblems（exit 4 通道）。PS 侧刻意不升格（现存未报计数全在 PS 侧，判红会误伤）。
{
  const c = mkCase("no-summary-gated", { "zeta.tests.js": { noSummary: true } });
  const r = runRunner(c.dir);
  check("JS 套 exit 0 但不打汇总行 → exit 4（不再带对勾放行）", r.code === 4 && r.sum && r.sum.exit === 4,
    JSON.stringify(r.sum) + "\n" + r.out.slice(-800));
  check("报文点出「条数下界」这个后果（只说「没报」等于没说）", /条数下界/.test(r.out), r.out.slice(-800));
  check("报文给出修法（补上汇总行）", /补上汇总行/.test(r.out), r.out.slice(-800));
  check("🔴 负控：red=0 且 fail=0，退出码仍是 4（这条拦阻不靠任何断言失败顶起来）",
    r.sum && r.sum.red === 0 && r.sum.fail === 0 && r.sum.exit === 4, JSON.stringify(r.sum));
}
{
  // 负控：正常报计数的套不许被误伤
  const c = mkCase("summary-counted", { "zeta.tests.js": { pass: 4 } });
  const r = runRunner(c.dir);
  check("负控：打了汇总行的套不误伤（exit 0、selfcheck=ok）",
    r.code === 0 && r.sum && r.sum.self === "ok", JSON.stringify(r.sum));
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
  //   2026-08-09 · issue #219 它第三次响：settings-drift.tests.js 新增 B3/B4（省略
  //   livePath/snapshotPath 时是否真落到生产默认值）——读的是真实 `~/.claude/settings.json`
  //   （其余官 / cc-switch GUI 随时可能改动它），与 alwayson-budget/dead-gates 同一类判据，
  //   只读不写，故本行随之扩到五套。
  // 2026-08-11 tests 终局：五套里四套已随归宿表删除（alwayson-budget/mcp-health/
  // memory-truth-source/settings-drift），仅剩 dead-gates。手维护名册对账随之退役——
  // 「名册恰恰等于这几套」不再是判据；交叉核对（独立实现 vs 生产 --list）仍在后面守着。
  check("环境敏感层只剩 dead-gates 一套（归宿表终局后的事实；多了要问为什么）",
    JSON.stringify(declared) === JSON.stringify(["dead-gates.tests.js"]),
    "实况=" + JSON.stringify(declared));
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
  // 2026-08-11：⑫①「真仓当下是绿态」那条 defer 随断言本体一起删了（外科手术：它断言
  // 本机健康度而非改动正确性，信号已由离线体检接管）——⑫ 组剩下的只有「墙钟预算跳过」
  // 那一条**条件性** defer（预算没跳过时不出现），故此处只钉 ⑪ 组的指名。
  check("dead-gates 的每组 defer 都指名（只报个数字等于没报）",
    /DEFER\s+⑪/.test(dgOut), dgOut.slice(0, 1200));
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
// 🔴 **为什么这一格此前是真空的，照直记**：`PS_BUDGET_MS` 原是硬编码 900s，而真套合计
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

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑪ PS 标记扫描：块注释外才算真声明（issue #203①）────");
// PR #200 在 `.NOTES` 散文里踩过这个坑：旧版正则只锚「行首 # + 标记名」，不问那一行是不是
// 身处 `<# ... #>` 块注释内部——散文里一句带了行首井号的完整字面量，被当成了真声明。
// 现在的扫描器边扫边跟踪块注释开合状态。本节两向都要红得出来：
//   散文位（块注释内）写完整标记 ⇒ 层归属不变（不该被判成声明）
//   真实位置（块注释外）写标记   ⇒ 照常生效（该被判成声明）
{
  // 正向①：散文位（.NOTES 段里，行首恰好是 #）—— 不该被判为声明
  const c = mkPsCase("ps-marker-prose", {
    ps: { "prose.tests.ps1": { markerInProse: true, pass: 5 } },
  });
  const r = runRunner(c.dir);
  check("⑪ 散文位（块注释内）写完整标记字面量 ⇒ 层归属不变（不是 env 层，默认层照跑）",
    r.code === 0 && r.psSum && r.psSum.psskip === 0 && r.psSum.psfiles === 1,
    JSON.stringify(r.psSum) + "\n" + r.out.slice(-1000));
  check("⑪ sentinel：它按普通套的路径真的起了进程（不是被静默判成 env 层后跳过）",
    psRan(c.psSentinel, "prose.tests.ps1"), "sentinel=" + c.psSentinel);
  const listOutP = runRunner(c.dir, ["--list"]);
  check("⑪ --list 不给它加 env 注（散文不算声明）",
    !/prose\.tests\.ps1\s+\[标了 env/.test(listOutP.out), listOutP.out.slice(-500));
}
{
  // 正向②：真实位置（块注释外的独立 # 行注释），标记之后紧跟一段 <# ... #> help 块——
  // 镜像本仓三个真实声明的结构。确保块注释状态机既不会连累「离开块注释之后」的判定，
  // 也不会因为标记本身之后还有块注释就反而漏判「标记之前」那一行。
  const c = mkPsCase("ps-marker-real", {
    ps: { "real.tests.ps1": { marker: true, markerAfterBlockComment: true, pass: 5 } },
  });
  const r = runRunner(c.dir);
  check("⑪ 真实位置（块注释外）写标记 ⇒ 照常生效（默认层整套不跑，exit 2）",
    r.code === 2 && r.psSum && r.psSum.psskip === 1 && r.psSum.psfiles === 0,
    JSON.stringify(r.psSum) + "\n" + r.out.slice(-1000));
  check("⑪ sentinel：默认层它没起过进程", !psRan(c.psSentinel, "real.tests.ps1"), "sentinel=" + c.psSentinel);
  const e = runRunner(c.dir, ["--env"]);
  check("⑪ --env 下它正常起进程（标记后面跟着的 help 块没有把标记本身也带偏）",
    e.code === 0 && psRan(c.psSentinel, "real.tests.ps1"), "sentinel=" + c.psSentinel + "\n" + e.out.slice(-800));
}
{
  // 边界：单行自封闭块注释（同一行内 <# ... #>）提到标记语法之后，紧跟真实声明——
  // 练一遍「离开这一行后状态归位」，确保它不会把后面的真声明也带偏。
  const c = mkPsCase("ps-marker-inline-block", {
    ps: { "inline.tests.ps1": { inlineBlockThenMarker: true, marker: true, pass: 5 } },
  });
  const r = runRunner(c.dir);
  check("⑪ 单行自封闭块注释之后紧跟真声明 ⇒ 真声明仍被认出",
    r.code === 2 && r.psSum && r.psSum.psskip === 1, JSON.stringify(r.psSum) + "\n" + r.out.slice(-1000));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑪′ 反方向：像开块记号、其实不是 —— 真标记不许被吃掉（PR #213 对抗官 F1）────");
// 🔴 **本节是 ⑪ 的镜像，两个方向缺一不可。** ⑪ 只钉「散文不许冒充声明」（放松侧），
//   而 PR #213 首版恰恰是在**收紧侧**翻的车：自写的 `<#`/`#>` 记号扫描不认行注释、
//   不认字符串字面量 ⇒ 一行「注释里提到开块记号」就把其后整段变成死区，死区里的真标记
//   静默失效，116 条断言一条都不红。**只往一个方向 mutation，就会漏掉这一整侧**
//   （dao 官侧条款 `[#官抗-判别力自检]` 讲的正是这个）。
//
// 语料来源照直写（`[#派-语料来源]`）：下面四个形态**不是本轮自造**，逐条取自 PR #213
//   对抗评论 F1 折叠区那 5 个边界夹具与它的 PowerShell parser token 佐证；
//   `hereString` 那一个取自同一评论「未尽处①」点名的、「剥行注释」这条替代修法自己的边界。
for (const [noise, why] of [
  ["lineComment", "行注释里提到开块记号（判词夹具 a）"],
  ["stringLiteral", "字符串字面量 $re = '<#'（判词夹具 b）"],
  ["hereString", "here-string 里出现开块记号（判词未尽处①点名的那格）"],
  ["strayCloser", "孤立的闭合记号在前（判词夹具 e）"],
]) {
  const c = mkPsCase("ps-marker-noise-" + noise, {
    ps: { "noisy.tests.ps1": { noise, marker: true, pass: 5 } },
  });
  const r = runRunner(c.dir);
  check(`⑪′ ${why} ⇒ 其后的真标记**照常生效**（默认层整套不跑，exit 2）`,
    r.code === 2 && r.psSum && r.psSum.psskip === 1 && r.psSum.psfiles === 0,
    JSON.stringify(r.psSum) + "\n" + r.out.slice(-900));
  check(`⑪′ ${why} ⇒ sentinel 证明它默认层真的没起进程（不是账面数字）`,
    !psRan(c.psSentinel, "noisy.tests.ps1"), "sentinel=" + c.psSentinel);
}
{
  // 🔴 死区形态 + **它必须出声**。这一条钉的是判词里最要紧的那句：
  //   「漏掉是无声的」。标记确实不生效（PowerShell 认它是块注释正文，这一格不改），
  //   但入口现在会打一行提示指出它不生效、该挪到哪 —— 静默才是那条缺陷的要害。
  const c = mkPsCase("ps-marker-deadzone", {
    ps: { "deadzone.tests.ps1": { deadZone: true, pass: 5 } },
  });
  const r = runRunner(c.dir);
  check("⑪′ 死区（头一行开块、窗口内不闭合）里的标记不算声明 —— 这一格照旧",
    r.code === 0 && r.psSum && r.psSum.psskip === 0 && r.psSum.psfiles === 1,
    JSON.stringify(r.psSum) + "\n" + r.out.slice(-900));
  check("⑪′ 🔴 但它**出声了**：点名文件 + 说清不生效 + 给出挪到哪（无声才是 F1 的要害）",
    /块注释内部\*\*出现了层级标记字面量/.test(r.out)
      && /· tests\/deadzone\.tests\.ps1/.test(r.out)
      && /挪到块注释\*\*之外\*\*的独立 # 行/.test(r.out),
    r.out.slice(-1200));
  const l = runRunner(c.dir, ["--list"]);
  check("⑪′ `--list` 也出这一声（人查层归属最常敲的就是它）",
    /· tests\/deadzone\.tests\.ps1/.test(l.out) && !/deadzone\.tests\.ps1\s+\[标了 env/.test(l.out),
    l.out.slice(-900));
}
{
  // 🔴 负控：**没有**块注释散文时不许打那一声。没有它，上面那条「出声了」可能只是
  //   「这行提示恒打」——同 ⑩ 那条负控的判据（比较基线必须先验证它自己是活的）。
  const c = mkPsCase("ps-marker-quiet", {
    ps: { "clean.tests.ps1": { marker: true, bom: true, pass: 5 } },
  });
  const r = runRunner(c.dir);
  check("⑪′ 🔴 负控：干净文件（标记在第 1 行 + 带 BOM）⇒ 认出声明、且**不打**块注释提示",
    r.code === 2 && r.psSum && r.psSum.psskip === 1 && !/块注释内部/.test(r.out),
    JSON.stringify(r.psSum) + "\n" + r.out.slice(-900));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑪″ 判定器自己坏掉时：fail-closed 且出声（PR #213 返工新增）────");
// 「这套没标记」与「我没看成」在退出码上分不开 —— 那正是本文件通篇在治的病，而换了
// 外部判定器之后它多了一个新入口：判定器跑不起来。故给注入口 `DAO_PS_TIER_SCANNER`
// 指一个不存在的脚本，验三件：①退出码走 4（不是悄悄 0/2）②报文说得出发生了什么
// ③**fail-closed 方向对**：一律当作「已声明」⇒ 默认层一套都不跑（当作「没标记」会把
// 带 winget install 的那几套真跑起来，那是两个方向里贵得多的那个错）。
{
  const c = mkPsCase("ps-scanner-broken", {
    ps: {
      "plain-a.tests.ps1": { pass: 3 },          // 两套都**没有**标记
      "plain-b.tests.ps1": { pass: 3 },
    },
  });
  const ghost = path.join(c.dir, "no-such-scanner.ps1");
  const r = runRunner(c.dir, [], { DAO_PS_TIER_SCANNER: ghost });
  check("⑪″ 判定器跑不起来 ⇒ exit 4（分层自检失败那一档，不是 0 也不是 2）",
    r.code === 4, "exit=" + r.code + "\n" + r.out.slice(-900));
  check("⑪″ 🔴 fail-closed 方向：两套都被当作已声明 ⇒ 默认层一套都没跑（psskip=2 / psfiles=0）",
    r.psSum && r.psSum.psskip === 2 && r.psSum.psfiles === 0,
    JSON.stringify(r.psSum) + "\n" + r.out.slice(-900));
  check("⑪″ 🔴 fail-closed 的证据不只在账面：sentinel 里两套都没有",
    !psRan(c.psSentinel, "plain-a.tests.ps1") && !psRan(c.psSentinel, "plain-b.tests.ps1"),
    (() => { try { return fs.readFileSync(c.psSentinel, "utf8"); } catch (_) { return "(无 sentinel)"; } })());
  check("⑪″ 报文说得出「判定没跑成」「按 fail-closed 处理」并点名那个判定器",
    /PS 分层标记判定没跑成/.test(r.out) && /fail-closed/.test(r.out)
      && r.out.includes("no-such-scanner.ps1"),
    r.out.slice(-1200));
  check("⑪″ 报文给的是可照做的重跑命令（不是让人自己猜怎么复现）",
    /自己重跑看原文：powershell -NoProfile -ExecutionPolicy Bypass -File /.test(r.out),
    r.out.slice(-1200));
  const l = runRunner(c.dir, ["--list"], { DAO_PS_TIER_SCANNER: ghost });
  check("⑪″ `--list` 同样不许拿 0 退出（列出来的分层是猜的，得让人知道）",
    l.code === 4 && /上面这张分层清单不可信/.test(l.out), "exit=" + l.code + "\n" + l.out.slice(-900));
  // 🔴 负控：同一组夹具、同一个入口，不注入就必须一切正常。没有它，上面每一条都可能
  //   只是「这两套本来就跑不起来」也照样绿。显式清空而不是不传（同 ⑩ 那条的判据：
  //   外层 shell 里若恰好设着这个变量，负控自己会被污染成实验组）。
  const n = runRunner(c.dir, [], { DAO_PS_TIER_SCANNER: "" });
  check("⑪″ 🔴 负控：不注入 ⇒ exit 0、两套都跑、零自检问题（红只能来自那个变量）",
    n.code === 0 && n.psSum && n.psSum.psfiles === 2 && n.psSum.psskip === 0 && n.sum.self === "ok",
    JSON.stringify(n.psSum) + "\n" + n.out.slice(-900));
  check("⑪″ 🔴 负控：不注入时正文不出现「判定没跑成」那句话（没坏就不该说话）",
    !/PS 分层标记判定没跑成/.test(n.out), n.out.slice(-800));
  check("⑪″ 🔴 负控：两侧退出码不等（只有摆在一起比，才排除两种情形恰好同码）",
    r.code !== n.code, "坏=" + r.code + " / 好=" + n.code);
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑫ 真仓自跑：PS 侧的声明集合退役触发器（issue #203②，EXPECT_DECLARED 的 PS 版）────");
// ⑧ 那份手维护枚举只扫 `.tests.js`（filter 只认 `.tests.js` 后缀）——PS 套加/摘 env 标记时，
// ⑧ 那条断言压根扫不到它，静默漂移无人知（PR #200 对抗官 F2，issue #203②）。本节补 PS 版
// 等价物：职责与 ⑧ 相同（给标记的增删造触发器，过期时变红），不是「正则本身对不对」的黑盒
// 验证——那半交给上面 ⑪ 的合成夹具（真的 spawn run-tests.mjs 观察行为）。
{
  const realPsTests = fs.readdirSync(path.join(REPO, "tests")).filter((f) => f.endsWith(".tests.ps1")).sort();
  // ── 独立判据（2026-08-09 · PR #213 返工重写这一段，原因写清楚）──────────────────
  // **原版是把生产那份自写状态机逐字复刻了一遍**，于是 PR #213 对抗官实测：往死区里加
  // 一条合法标记，两份实现一起看不见 ⇒ 交叉核对照绿。⑫ 自己的注释当时就写着「两份实现
  // 若共享同一个盲点，交叉核对本身也会一起瞎」—— 那句话被原样兑现了。
  //
  // 现在改成**问 PowerShell 自己**：另起一份查询表达式（不 spawn 生产那个
  // `scripts/scan-ps-tier-marker.ps1`，不复用它的任何代码），直接读 token 流。
  // ⚠ **照直写它能抓什么、抓不到什么**：它与生产**同底座**（都是官方 parser），
  //   所以抓不到「问题本身问错了」那一类 —— 那一半归 ⑪/⑪′ 的黑盒夹具。它抓得到的是
  //   窗口值走样、正则走样、node 侧输出解析出错、整条 node→powershell 管道断掉，
  //   以及本节真正的职责：**声明面变了没人审**（下面那份手维护枚举）。
  const psOracleQuery = (files) => {
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const script = [
      "$files=@(" + files.map((f) => q(path.join(REPO, "tests", f))).join(",") + ")",
      "$re='^[ \\t]*#[ \\t]*@' + 'dao-test-tier:[ \\t]*env\\b'",
      "foreach($f in $files){",
      "  $tk=$null;$er=$null",
      "  [void][System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$tk,[ref]$er)",
      "  foreach($t in $tk){",
      "    if($t.Kind -ne 'Comment'){continue}",
      "    if($t.Extent.StartLineNumber -gt 60){continue}",
      "    if($t.Text.StartsWith('<#')){continue}",
      "    if($t.Text -cnotmatch $re){continue}",
      "    $col=$t.Extent.StartColumnNumber",
      "    if($t.Extent.StartScriptPosition.Line.Substring(0,$col-1).Trim() -ne ''){continue}",
      "    Write-Output ('DECL ' + [IO.Path]::GetFileName($f))",
      "    break",
      "  }",
      "}",
    ].join("\n");
    const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: 60000, cwd: REPO });
    const hits = new Set(String(r.stdout || "").split(/\r?\n/)
      .map((l) => /^DECL (.+)$/.exec(l.trim())).filter(Boolean).map((m) => m[1]));
    return { list: files.filter((f) => hits.has(f)), code: r.status, out: String(r.stdout || "") };
  };
  const oracle = psOracleQuery(realPsTests);
  check("⑫ 独立判据（直接问 PowerShell 的 token 流）本身跑成了 —— 它没跑成时下面两条一律不可信",
    oracle.code === 0, "exit=" + oracle.code + " out=" + oracle.out.slice(0, 300));
  const declaredPs = oracle.list;
  // 2026-08-11 tests 终局：三套标 env 的 PS 套已随归宿表全删（clause-structure/dao-install/dao-secrets）——
  // 「手维护名册对账」这条断言随之退役（空名册对空名册是恒真闸，正是本仓在治的病）。
  // 交叉核对保留：独立实现与生产 --list 在真仓上结论必须一致（不论名单是几套）。
  // 与真实 run-tests.mjs --list 的输出交叉核对：独立判据与生产链路在真实仓上结论必须一致——
  // 不是为了替代 ⑪/⑪′ 的黑盒验证（**同底座的两份实现仍然共享「问错问题」这一类盲点**，
  // 而 PR #213 那次翻车正是这一类），而是给「这份手写枚举没有悄悄跟生产链路分叉」提供
  // 第二重证据，并顺带钉住整条 node→powershell→输出解析的管道。
  const listOut = spawnSync(process.execPath, [RUNNER, "--list"], { encoding: "utf8", timeout: 60000, cwd: REPO });
  check("⑫ 真仓 `--list` 本身 exit 0（判定 fail-closed 时它退 4，那时下面这条的比较没有意义）",
    listOut.status === 0, "exit=" + listOut.status + "\n" + String(listOut.stdout || "").slice(-600));
  const listedEnvPs = realPsTests.filter((f) =>
    new RegExp("pwsh  tests/" + f.replace(/\./g, "\\.") + "\\s+\\[标了 env").test(String(listOut.stdout || "")));
  check("独立实现与真实 run-tests.mjs --list 的输出在真仓上结论一致（交叉核对，不是同一份代码）",
    JSON.stringify(declaredPs) === JSON.stringify(listedEnvPs),
    "独立实现=" + JSON.stringify(declaredPs) + " --list=" + JSON.stringify(listedEnvPs));
}

console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " ===");
process.exit(fail ? 1 : 0);
