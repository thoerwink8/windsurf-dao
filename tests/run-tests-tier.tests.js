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

function mkCase(name, files) {
  const dir = path.join(TMP, name);
  rm(dir);
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  let sentinel = path.join(dir, "sentinel.log");
  for (const [fname, opts] of Object.entries(files)) sentinel = mkTestFile(dir, fname, opts);
  return { dir, sentinel };
}

function runRunner(caseDir, extraArgs) {
  const args = [RUNNER, "--tests-dir", path.join(caseDir, "tests")].concat(extraArgs || []);
  const r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 120000, cwd: REPO });
  const out = String(r.stdout || "");
  return { code: r.status, out, err: String(r.stderr || ""), sum: parseSummary(out) };
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
console.log("\n──── ⑧ 真仓自跑：本仓当下确实有且只有 dead-gates 声明了环境敏感层 ────");
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
  check("真实 tests/ 里声明了环境敏感层的文件恰是 dead-gates（多了要问为什么，少了说明标记掉了）",
    declared.length === 1 && declared[0] === "dead-gates.tests.js", JSON.stringify(declared));
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

console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " ===");
process.exit(fail ? 1 : 0);
