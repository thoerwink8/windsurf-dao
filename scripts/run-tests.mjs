// run-tests.mjs — windsurf-dao 自有测试的聚合入口
//
// ── 为什么有这个文件 ─────────────────────────────────────────────────────────
// 本仓无 test runner 框架，测试各自 `node tests/xxx.tests.js` 独立可跑。问题在于
// **没有任何地方枚举得全**：CLAUDE.md 的「自检与测试」段长期只列了两个 .ps1 测试，
// 三套 JS 测试（dao-rule-echo / dao-compact-log / settings-drift）从未被列进去
// ⇒ 写了却没人跑，与 D5 修的那个「写了没挂」是同一个病，只是换了个身位。
//
// 故这里**不维护清单，而是扫目录**：`tests/*.tests.js` 一律纳入。手维护的清单会过期
// （本仓已被过期清单咬过两次：marshal-guard 14 天、compact-log 6 周），扫出来的不会。
//
// .ps1 测试需要 PowerShell 宿主，本入口不代跑，只如实列出并提示 —— 「跑不了」要说出来，
// 不能因为跑不了就当它不存在（那正是静默失效的定义）。
//
// ══════════════════════════════════════════════════════════════════════════
// ── 分层：默认层 / 环境敏感层（2026-08-04 · issue #116）─────────────────────
// ══════════════════════════════════════════════════════════════════════════
// 有一类断言**不制造污染，却被别人的正常活动污染**：它对**别人拥有的机器级可变状态**
// 做不变量断言（真实 `~/.claude/settings.json`、cc-switch GUI 的库、指向共享主仓的命令）。
// 前两种互染机制的修法（夹具名加唯一后缀 / 假家目录，见 PR #115）对它**结构上不适用**
// —— 它要断言的就是「真实那一份现在长什么样」，换成假的就什么都没测。
//
// 这类断言留在日常回归网里只有两个结局：偶发红（于是所有人学会「红了先重跑」，这道闸
// 从此形同虚设），或者被整体删掉（于是真退化也没人管）。故本入口把它**分层**：
//
//   默认层（`node scripts/run-tests.mjs`）
//     跑全部测试文件，但声明了环境敏感层的文件会**自己 defer 掉**那几节断言。
//   环境敏感层（`node scripts/run-tests.mjs --env`）
//     把 `--env` 透传给每个测试文件，那几节照跑。**要求串行环境**：没有别的官在跑测试、
//     cc-switch GUI 没在写库、没人在改 `~/.claude/settings.json`。
//
// 🔴 **「没跑」与「跑了全过」必须在退出码上分得开** —— 这正是被分层的那些断言自己要治的病
// （零检出 ≠ 零存在）。一个分层机制若让默认跑法照旧返回 0，等于把那个病搬到了分层机制上。
// 判据抄自 mousse-cli `scripts/lib/verify-exit.ps1` 的四态退出码（那里的 `2` 专门表示
// 「无失败但有硬闸被跳过」）。
//
// ── 退出码契约（本文件是唯一真相源）────────────────────────────────────────
//
//   | 码 | 含义                                             | 消费方该怎么读        |
//   |----|--------------------------------------------------|-----------------------|
//   | 0  | 全跑、全过：**且零 defer**（只有 --env 拿得到）    | 可以放行              |
//   | 1  | 有测试文件红                                      | 拦住，去读失败详情    |
//   | 2  | 无红，但有断言被 defer —— **本次没跑完**           | 默认跑法的正常码      |
//   | 3  | 用法错误（不认识的参数）——**一套都没跑**           | 拦住，改命令行        |
//   | 4  | 分层自检失败：静态声明与运行期 defer 计数对不上     | 拦住，先修分层机制    |
//
//   优先级：3（开跑前判） > 1 > 4 > 2。
//   ⚠ **谓词写 `=== 0`，别写 `<= 2`** —— 那个区间把 1（真失败）也放了进来。
//   ⚠ **别把 2 当成绿**。`@(0,2)` 这种放行谓词一写，分层就退化成「接受偶发红」的另一种
//     形态（issue #116 里那条最危险的路），只是危害从"无视红"变成"无视没跑"。
//     没有任何程序在核这一点 —— 这是本机制已知最弱的一环，照直写在这里。
//
// ── 自检半边：为什么不能只数运行期的 DEFER ─────────────────────────────────
// 「一个检查器数到 0 个违例，和它根本没看到样本，输出长得一模一样」（dao-guard-writing）。
// 若只靠解析各测试自报的 `DEFER=n`：解析一坏 ⇒ 全场 defer=0 ⇒ 退出码 0 ⇒ 「没跑」又变回
// 「跑了全过」，而输出看起来完全正常。
// 故这里跑**三套互不共享实现的判据**，任意两套对不上即警报（exit 4）：
//   ① 静态：扫每个测试文件**源码头部**有没有 `@dao-test-tier: env` 标记（读文件字节）
//   ② 运行期·结构化：解析该文件 stdout 汇总行里的 `DEFER=n`（读一个聚合数字）
//   ③ 运行期·笨计数器：数该文件 stdout 里有几行以 `DEFER ` 开头的明细
//      （形态照抄 `ccswitch/scripts/check-mutation-anchor.mjs` 的独立笨计数器对拍：
//       主解析瞎掉时给一个专门的非零码，而不是静默 0）
// ① 与 ②③ 的**输入源**不同（文件字节 vs 进程输出）；② 与 ③ 同源但**两套写法**——
// ② 读一个聚合数字、③ 数一堆明细行，聚合那半算错时明细那半仍是对的。
// 五种不一致都判红：标记在而没 defer（标记过期 / defer 机制坏了）· defer 了却没标记
// （标记漏加 ⇒ 静态那半从此看不见它）· 有明细行却没 DEFER= 字段（人看得见、机器看不见）·
// **②③ 两个数对不上**（聚合与明细至少有一个错了）· `--env` 下仍在 defer（`--env` 没透传到）。
//
// ⇒ **测试文件的契约**：报 `DEFER=n` 就必须同时打印 n 行 `DEFER <名字>  ->  <理由>` 明细。
//    这不只是给自检用的 ——「只报个数字等于没报」，人得知道**哪几组**没跑。
//
// ── 跑法 ────────────────────────────────────────────────────────────────────
//   node scripts/run-tests.mjs                默认层（预期 exit 2）
//   node scripts/run-tests.mjs --env          含环境敏感层（全绿 exit 0）；要求串行环境
//   node scripts/run-tests.mjs --list         只列清单不跑，带分层标注
//   node scripts/run-tests.mjs --tests-dir P  换一个测试目录（**给本入口的自测用**，
//                                             见 tests/run-tests-tier.tests.js）

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// 退出码常量：本文件与 tests/run-tests-tier.tests.js 共用语义，避免两处各写一份魔数。
const EXIT_OK = 0;
const EXIT_RED = 1;
const EXIT_DEFERRED = 2;
const EXIT_BAD_USAGE = 3;
const EXIT_SELFCHECK = 4;
const EXIT_NO_TESTS_DIR = 5;

// ── 参数解析（不认识的参数一律 fail-fast，一套都不跑）──────────────────────
// 判据同 verify-exit.ps1 边界②：`-Skip` 是显式意图，不兑现显式意图没有「大致对」的余地。
// 这里同理 —— 打错的参数若被静默忽略，你以为跑了 --env，实际跑的是默认层。
const KNOWN_FLAGS = new Set(["--list", "--env", "--all"]);
const rawArgs = process.argv.slice(2);
let testsDirArg = null;
let testsDirGivenEmpty = false;
const flags = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--tests-dir") {
    const v = rawArgs[i + 1];
    if (v == null || v.startsWith("--")) { testsDirGivenEmpty = true; } else { testsDirArg = v; i++; }
    continue;
  }
  if (a.startsWith("--tests-dir=")) {
    const v = a.slice("--tests-dir=".length);
    if (!v) { testsDirGivenEmpty = true; } else { testsDirArg = v; }
    continue;
  }
  flags.push(a);
}
const unknownFlags = flags.filter((f) => !KNOWN_FLAGS.has(f));
if (unknownFlags.length || testsDirGivenEmpty) {
  const why = unknownFlags.length
    ? "不认识的参数：" + unknownFlags.join(", ")
    : "--tests-dir 后面没给路径";
  process.stderr.write("[run-tests] 用法错误 —— " + why + "\n");
  process.stderr.write("  合法参数：--list / --env（别名 --all）/ --tests-dir <路径>\n");
  process.stderr.write("  **一套测试都没跑**（打错的参数不静默忽略，否则你以为跑了 --env，实际跑的是默认层）\n");
  process.stdout.write(`RUN_TESTS_SUMMARY exit=${EXIT_BAD_USAGE} tier=none files=0 red=0 pass=0 fail=0 defer=0 deferfiles=0 declared=0 selfcheck=n/a\n`);
  process.exit(EXIT_BAD_USAGE);
}
const ENV_TIER = flags.includes("--env") || flags.includes("--all");
const LIST_ONLY = flags.includes("--list");

const TESTS_DIR = testsDirArg ? path.resolve(testsDirArg) : path.join(ROOT, "tests");

if (!fs.existsSync(TESTS_DIR)) {
  process.stderr.write(`[run-tests] 找不到 tests/ 目录：${TESTS_DIR}\n`);
  process.exit(EXIT_NO_TESTS_DIR);
}

const entries = fs.readdirSync(TESTS_DIR).sort();
const jsTests = entries.filter((f) => f.endsWith(".tests.js"));
const psTests = entries.filter((f) => f.endsWith(".tests.ps1"));
// 既不是 .tests.js 也不是 .tests.ps1 的文件：可能是命名不合规的测试，宁可报出来让人看一眼
const strays = entries.filter((f) => !f.endsWith(".tests.js") && !f.endsWith(".tests.ps1"));

// ── 自检半边 ①：静态标记扫描（读文件字节，与运行期输出解析不共享任何实现）──────
// 只扫头部若干行：标记是「文件级声明」，写在头注里；扫全文会把正文里提到这个标记的
// 文字（比如本机制自己的回归网）也算进来 —— 检查器的输出不该落在它自己的扫描面内。
const TIER_MARKER_HEAD_LINES = 60;
const TIER_MARKER_RE = /^[ \t]*\/\/[ \t]*@dao-test-tier:[ \t]*env\b/m;
function declaresEnvTier(file) {
  try {
    const head = fs.readFileSync(path.join(TESTS_DIR, file), "utf8")
      .split(/\r?\n/).slice(0, TIER_MARKER_HEAD_LINES).join("\n");
    return TIER_MARKER_RE.test(head);
  } catch (_) {
    return false;   // 读不到就是读不到；它随后会以「跑不起来」的形态变红
  }
}
const declaredEnv = new Set(jsTests.filter(declaresEnvTier));

process.stdout.write(`[run-tests] tests/ 下发现 ${jsTests.length} 套 node 测试、${psTests.length} 套 PowerShell 测试\n`);
process.stdout.write(`[run-tests] 本次层级：${ENV_TIER ? "--env（含环境敏感断言，要求串行环境）" : "默认层（环境敏感断言不跑 → 预期 exit 2）"}`
  + `；声明了环境敏感层的文件 ${declaredEnv.size} 个\n`);
if (strays.length) {
  process.stdout.write(`  ⚠ 另有 ${strays.length} 个不符 *.tests.{js,ps1} 命名的文件，未纳入：${strays.join(", ")}\n`);
}

if (LIST_ONLY) {
  for (const f of jsTests) process.stdout.write(`  node  tests/${f}${declaredEnv.has(f) ? "   [有环境敏感层 · 默认不跑那几节]" : ""}\n`);
  for (const f of psTests) process.stdout.write(`  pwsh  tests/${f}\n`);
  process.exit(EXIT_OK);
}

const results = [];
for (const f of jsTests) {
  const t0 = Date.now();
  // cwd 钉在仓根，**不继承调用者的**（2026-08-04 实测：从别的仓的目录敲这个入口，
  // subagent-clauses 那套里一条依赖 process.cwd() 的断言会红，而同一份代码在仓根下全绿
  // ⇒ 红绿取决于你在哪个目录敲的命令，且失败信息里没有任何东西指向 cwd）。
  const argsForChild = ENV_TIER ? ["--env"] : [];
  const r = spawnSync(process.execPath, [path.join(TESTS_DIR, f), ...argsForChild], { encoding: "utf8", cwd: ROOT });
  const ms = Date.now() - t0;
  const out = String(r.stdout || "");
  // 从各测试自己的汇总行取断言数（格式统一为 `=== 汇总: PASS=n FAIL=m ===`，
  // 有环境敏感层的文件再追加 ` DEFER=k`）；取不到不当成通过，只标「未报计数」，
  // 判定仍以真退出码为准 —— 但对**声明了环境敏感层**的文件，取不到 DEFER 本身就是
  // 分层自检失败（见下面第 ② 半），不是「那一格没事」。
  const m = out.match(/PASS=(\d+)\s+FAIL=(\d+)(?:\s+DEFER=(\d+))?/);
  // ③ 笨计数器：不解析任何结构，只数「以 DEFER 开头的明细行」有几行。
  // 它与上面那个聚合字段是两套写法，对拍不上就说明至少有一半算错了（见文件头自检半边）。
  const deferLines = (out.match(/^[ \t]*DEFER[ \t]/gm) || []).length;
  results.push({
    file: f,
    code: r.status,
    pass: m ? Number(m[1]) : null,
    fail: m ? Number(m[2]) : null,
    defer: m && m[3] != null ? Number(m[3]) : null,
    deferLines,
    ms,
    out,
    err: String(r.stderr || ""),
  });
}

// 失败者的完整输出要打出来，否则「哪一条红了」得重跑一遍才知道
for (const r of results) {
  if (r.code !== 0) {
    process.stdout.write(`\n──── 失败详情 tests/${r.file}（exit ${r.code}）────\n`);
    process.stdout.write(r.out);
    if (r.err.trim()) process.stdout.write(`[stderr]\n${r.err}\n`);
  }
}

process.stdout.write("\n──── 汇总表（判定以真退出码为准）────\n");
let totalPass = 0, totalFail = 0, totalDefer = 0, bad = 0;
const deferringFiles = [];
for (const r of results) {
  if (r.pass != null) { totalPass += r.pass; totalFail += r.fail; }
  if (r.defer) { totalDefer += r.defer; deferringFiles.push(r); }
  if (r.code !== 0) bad++;
  const counts = r.pass != null ? `PASS=${String(r.pass).padStart(3)} FAIL=${r.fail}` : "（未报计数）";
  const deferTag = r.defer ? ` DEFER=${r.defer}` : "";
  const tierTag = declaredEnv.has(r.file) ? " ⚑env" : "";
  process.stdout.write(`  ${r.code === 0 ? "✓" : "✗"} exit=${String(r.code).padStart(2)}  ${counts}${deferTag}  ${String(r.ms).padStart(5)}ms  tests/${r.file}${tierTag}\n`);
}
process.stdout.write(`  ── ${results.length} 套 node 测试：${results.length - bad} 过 / ${bad} 红；断言合计 PASS=${totalPass} FAIL=${totalFail}${totalDefer ? ` DEFER=${totalDefer}` : ""}\n`);

// ── 自检半边 ②：静态声明 vs 运行期计数，差值即警报 ────────────────────────
const tierProblems = [];
for (const r of results) {
  // 红的文件另有专门通道（上面已打全量输出），不在这里重复判 —— 它可能压根没跑到汇总行。
  if (r.code !== 0) continue;
  const declared = declaredEnv.has(r.file);
  const observed = r.defer == null ? null : r.defer;
  const dumb = r.deferLines;
  if (declared && observed === null) {
    tierProblems.push(`tests/${r.file} 头部声明了 @dao-test-tier: env，运行期却没打出 DEFER= 字段 `
      + `⇒ 无从判断那几节跑没跑（「没跑」与「跑了全过」在这个文件上已经分不开了）`);
    continue;
  }
  if (!declared && observed) {
    tierProblems.push(`tests/${r.file} 运行期 DEFER=${observed}，头部却没有 @dao-test-tier: env 标记 `
      + `⇒ 静态那半从此看不见它，标记漏加`);
    continue;
  }
  if (observed === null && dumb > 0) {
    tierProblems.push(`tests/${r.file} 正文里有 ${dumb} 行 DEFER 明细，汇总行却没有 DEFER= 字段 `
      + `⇒ 人看得见它 defer 了，机器看不见（退出码照旧 0）`);
    continue;
  }
  if (observed !== null && observed !== dumb) {
    tierProblems.push(`tests/${r.file} 汇总行 DEFER=${observed}，而正文里的 DEFER 明细有 ${dumb} 行 `
      + `⇒ 两套独立计数对不上，聚合与明细至少有一半算错了（笨计数器对拍，见 run-tests.mjs 头注 ③）`);
    continue;
  }
  if (declared && !ENV_TIER && observed === 0) {
    tierProblems.push(`tests/${r.file} 声明了环境敏感层，默认层跑却 DEFER=0 `
      + `⇒ 要么标记过期（那几节已删/已不敏感，该摘标记），要么 defer 机制坏了`);
    continue;
  }
  if (declared && ENV_TIER && observed > 0) {
    tierProblems.push(`tests/${r.file} 在 --env 下仍 DEFER=${observed} `
      + `⇒ --env 没透传到它（于是你以为跑了环境敏感层，其实没跑）`);
  }
}

if (tierProblems.length) {
  process.stdout.write(`\n✗ 分层自检失败 ${tierProblems.length} 条 —— 「本次跑了什么」这个账本本身不可信了：\n`);
  for (const p of tierProblems) process.stdout.write(`    · ${p}\n`);
}

if (totalDefer && !ENV_TIER) {
  process.stdout.write(`\n⚠ 本次未跑：环境敏感断言 ${totalDefer} 条（分布 ${deferringFiles.length} 个文件）—— **「没跑」不等于「跑了全过」**\n`);
  for (const r of deferringFiles) process.stdout.write(`    · tests/${r.file}  DEFER=${r.defer}\n`);
  process.stdout.write(`  为什么摘出去：那几节对**别人拥有的机器级可变状态**做不变量断言（真 ~/.claude/settings.json、cc-switch GUI 的库），\n`);
  process.stdout.write(`  它不制造污染、只被别人的正常活动污染 ⇒ 并行期偶发红，而「红了先重跑」会训练所有人无视这道闸（issue #116）。\n`);
  process.stdout.write(`  跑完整层：node scripts/run-tests.mjs --env\n`);
  process.stdout.write(`    ⚠ 要求串行环境：没有别的官在跑测试 · cc-switch GUI 没在写库 · 没人在改 ~/.claude/settings.json\n`);
  process.stdout.write(`  退出码 ${EXIT_DEFERRED} 就是这个意思：本次没跑完。**要 0 必须带 --env。**\n`);
}

if (psTests.length) {
  process.stdout.write(`  ⓘ 另有 ${psTests.length} 套 PowerShell 测试需在 pwsh 里跑（本入口不代跑，不计入上面的过/红）：\n`);
  for (const f of psTests) process.stdout.write(`      .\\tests\\${f}\n`);
}

// ── 退出码 + 机器可读末行（照 DEAD_GATES_SUMMARY 的路数：只读末行的消费方也拿得到全貌）──
let exitCode = EXIT_OK;
if (bad) exitCode = EXIT_RED;
else if (tierProblems.length) exitCode = EXIT_SELFCHECK;
else if (totalDefer) exitCode = EXIT_DEFERRED;

process.stdout.write(`RUN_TESTS_SUMMARY exit=${exitCode} tier=${ENV_TIER ? "env" : "default"}`
  + ` files=${results.length} red=${bad} pass=${totalPass} fail=${totalFail}`
  + ` defer=${totalDefer} deferfiles=${deferringFiles.length} declared=${declaredEnv.size}`
  + ` selfcheck=${tierProblems.length ? "fail" : "ok"}\n`);
process.exit(exitCode);
