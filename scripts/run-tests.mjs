// run-tests.mjs — windsurf-dao 自有测试的聚合入口
//
// ── 为什么有这个文件 ─────────────────────────────────────────────────────────
// 本仓无 test runner 框架，测试各自 `node tests/xxx.tests.js` 独立可跑。问题在于
// **没有任何地方枚举得全**：手维护的清单会过期（本仓已被过期清单咬过两次）。
// 故这里**不维护清单，而是扫目录**：`tests/*.tests.js` 一律纳入，扫出来的不会过期。
// **`.ps1` 测试也由本入口代跑**（不只列出来提醒）：合并链的 `-VerifyCommand` 拿 exit 0 就
// 放行，而列而不跑的那几套**一套都没进那个 0**。跑不了的部分上退出码通道（见下）。
//
// ══════════════════════════════════════════════════════════════════════════
// ── 分层：默认层 / 环境敏感层 ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// 有一类断言**不制造污染，却被别人的正常活动污染**：它对**别人拥有的机器级可变状态**
// 做不变量断言（真实 `~/.claude/settings.json`、cc-switch GUI 的库、指向共享主仓的命令）。
// 把它留在日常回归网里只有两个结局：偶发红（于是所有人学会「红了先重跑」，这道闸从此
// 形同虚设），或者被整体删掉（于是真退化也没人管）。故本入口把它**分层**：
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
//   **六态**（此前头注与 CLAUDE.md 都漏记态 5，代码里从第一天就有它——头注是唯一真相源
//   却漏记了一态，故「六态」只有读代码的人知道，本批补记。）
//
//   | 码 | 含义                                             | 消费方该怎么读        |
//   |----|--------------------------------------------------|-----------------------|
//   | 0  | 全跑、全过：**且零 defer、零未跑 PS 套**（只有 --env 拿得到） | 可以放行     |
//   | 1  | 有测试文件红（node 侧或 PowerShell 侧），**或某套断言条数跌破基线** | 拦住，去读失败详情 |
//   | 2  | 无红，但有断言被 defer / 有 PS 套没跑 —— **本次没跑完** | 默认跑法的正常码 |
//   | 3  | 用法错误（不认识的参数）——**一套都没跑**           | 拦住，改命令行        |
//   | 4  | 分层自检失败：静态声明与运行期 defer 计数对不上，或某 PS 套 exit 0 却零输出 | 拦住，先修分层机制 |
//   | 5  | 找不到 tests/ 目录（**一套都没跑**，与「有 defer」刻意不共用 2） | 拦住，核 --tests-dir |
//
//   优先级：3 / 5（开跑前判） > 1 > 4 > 2。
//   ⚠ **1 多一个来源**：「一条断言都没红，但这一套比基线少跑了 N 条」也走 1——那种情形下
//     **没有任何断言失败**，不并进 1 它会掉进 0 或 2 里，与「全跑全过」不可区分。
//   ⚠ **谓词写 `=== 0`，别写 `<= 2`** —— 那个区间把 1（真失败）也放了进来。
//   ⚠ **别把 2 当成绿**。`@(0,2)` 这种放行谓词一写，分层就退化成「接受偶发红」的另一种
//     形态，只是危害从"无视红"变成"无视没跑"。没有任何程序在核这一点 ——
//     这是本机制已知最弱的一环，照直写在这里。
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
// ══════════════════════════════════════════════════════════════════════════
// ── PowerShell 层的契约 ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// ① **自声明标记，不是入口硬编码清单**：`.tests.ps1` 头部 60 行内出现
//    `# @dao-test-tier: env` ⇒ 该套**整套只在 `--env` 跑**；无标记者默认层也跑。
//    刻意不在本文件里写「哪几套算慢」的清单 —— 本仓的手维护枚举被咬过三次。
//
//    🔴 **PS 标记与 JS 标记的语义不同，别当同一个东西读**（故判定也**另起一份**，不共用）：
//      · JS 侧 `// @dao-test-tier: env` = 「这个文件**内部有几节断言**在默认层自己 defer 掉」
//        —— 文件照跑，跑完报 `DEFER=n`，粒度是**断言组**。
//      · PS 侧 `# @dao-test-tier: env` = 「**整套**在默认层压根不起进程」
//        —— 粒度是**整个文件**，它不产生也不可能产生 `DEFER=n`。
//    为什么 PS 侧只能做到整套粒度：那几套是独立可直跑的 PowerShell 脚本，没有共同的
//    「defer 某几节」协议，也不该为了这个去改它们的正文。
//    ⇒ 两侧的计数**各走各的字段**：JS 的进 `defer=/deferfiles=/declared=`，
//      PS 的进 `psfiles=/psred=/psskip=`。混在一起会让「哪一半没跑」重新变得看不出来。
//
//    ①′ **「块注释外才算声明」这一判据的底座是 PowerShell 官方 parser**：判定外包给
//    `scripts/scan-ps-tier-marker.ps1`（`Parser::ParseFile` 的 token 流）。
//    **两次翻车才走到这一步，两次都是近似判据，方向相反**：旧版只锚「行首 # + 标记名」
//    会把块注释里的散文误当真声明（整套被静默判成 env 层、全仓零红）；自写开合记号扫描
//    不认行注释与字符串字面量（一行「注释里提到开块记号」就把它后整段变成死区）。
//    ⇒ **补漏—再漏的解法是换底座，不是把近似补得更细**——本文件不许再长出第三版自写扫描。
//    ⚠ 换底座没有把「标记落在块注释里」变成合法声明；它改的是那件事**从此会出声**：
//      判定器另报 `prose` 位，入口据此打一行提示「这条标记不生效，想生效就挪出块注释」。
//    ⚠ **JS 侧未同步换底座，这是刻意留白不是漏做**：JS 侧仍是一条裸正则，块注释里的散文
//    照样能冒充声明（今天零活口是普查结论，不是护栏）；若未来出现同型事故，处方是同一个
//    （找 JS 那侧的权威解析），不是重新发明一版记号扫描。
//
// ② **没跑的 PS 套上退出码通道**：`psskip > 0` ⇒ 最终退出码**至少 2**。
//    此前默认层那个恒 2 是**挂在 dead-gates 一个文件的 DEFER 上**的偶然——现在两条路各自
//    都能把 2 顶起来。
//
// ③ **spawn 形态**：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File <绝对路径>`，
//    cwd 钉仓根。每套超时 `PS_TIMEOUT_MS`（默认 300s，可用环境变量 `DAO_PS_TIMEOUT_MS`
//    覆盖 —— 那个口子是**给回归网注入短超时用的**，不是给人调松的）。
//    ⚠ **「真套超时会怎样」只有合成夹具的证据，显式接受为已知缺口**：回归网用 `Start-Sleep`
//    夹具 + 注入短超时验到了三条（超时判红 · 打孤儿进程/半写沙盒警告 · 汇总表打 `⏱超时` 标），
//    但那是**造出来的**超时；真套里没有一套会自然超时（最慢那套与 300s 闸之间有余量）。
//    ⇒ 要真语料就得往一套真测试里塞死循环 —— 那是把生产测试改坏去喂闸，不做。
//
// ④ **红判据**：`status !== 0 || error || signal` ⇒ 红。超时走 `error`/`signal` 那一格，
//    **判红不判跳过**，并额外打一句警告：`spawnSync` 不杀进程树 ⇒ 可能残留孤儿 powershell
//    进程与半写的 `_tmp` 沙盒，**下一次跑同一套可能因此失败**（那个红的成因在上一次跑里）。
//    ⚠ **「不杀进程树」是显式接受，不做 `taskkill /T`**：收拾它要拿 `spawnSync` 返回的 pid
//    去杀整棵树，而那一刻 node 已经 SIGTERM 过它、pid 可能已被系统回收并复用 ⇒ 一条「清理」
//    命令有概率杀掉无关进程，代价方向比它治的病更差。现状是 fail-loud（判红 + 指名 `_tmp`
//    沙盒与残留进程），接受的是「留下垃圾要人收」，没有接受「静默」。
//
// ⑤ **PS 层总预算 900s**：串行累计墙钟超过它 ⇒ 剩余套判「未跑」（逐套打明细）、退出码至少 2。
//    预算是给「某套卡住把整个入口拖死」兜底的，不是性能指标。
//    注入口 `DAO_PS_BUDGET_MS`（形态同 ③ 的 `DAO_PS_TIMEOUT_MS`，**给回归网注入短预算用**）。
//    **它补的是一格真空**：这个数此前是硬编码常量、没有任何注入口，回归网**结构上**造不出
//    「预算耗尽」场景 —— 有人把这道闸整个关掉，全场 `PASS=95 FAIL=0` **一条都没红**。
//    有了注入口，「预算闸被改坏」才必红。
//
// ⑥ **零输出自检**：某套 `status === 0` 而 stdout 去空白后为空 ⇒ 计入 `tierProblems`
//    （exit 4 通道）。「exit 0 + 零输出」与「绿」必须分得开 —— 一个没跑到任何断言就返回 0 的
//    脚本（被 `-ExecutionPolicy` 挡掉、头部就 return、文件被清空）在退出码上与全过一模一样。
//
// ⑦ **计数解析**：沿用既有的 `PASS=(\d+)\s+FAIL=(\d+)`；取不到只标「未报计数」，
//    判定以真退出码为准。**多数套不打这个汇总行** —— 具体哪几套以汇总表里那几行
//    「（未报计数）」为准，此处刻意不写数字（写死数字被咬过：套数一变两处一起过期）。
//
// ── 断言条数基线：已于重设计时删除（拷问局定案③「文字一致性检查全灭」）──────────
// 它治的病（绿灯可能只是「有几条根本没跑」）是真的，但药方是又一个要人同步的派生物，
// 且「基线对账」本身就是文字一致性检查。判据史见 git 历史。
// 「JS 套必须打汇总行」那条判据独立于基线档，仍保留在自检半边。
//
// ── 跑法 ────────────────────────────────────────────────────────────────────
//   node scripts/run-tests.mjs                默认层（预期 exit 2）：JS 全跑 + 无标记 PS 套跑
//   node scripts/run-tests.mjs --env          含环境敏感层 + 全部 PS 套（全绿 exit 0）；要求串行环境
//   node scripts/run-tests.mjs --list         只列清单不跑，带分层标注（js/ps 两侧都标）
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

// ── PowerShell 层的两个时间闸（见文件头 PS 契约 ③⑤）────────────────────────
// 单套超时：默认 300s ≈ 本仓最慢那套（clause-structure 实测 55-81s，同机不同次波动）的 3.7-5.5 倍余量。
// `DAO_PS_TIMEOUT_MS` 这个口子是**给回归网注入短超时用的**（造一个必然超时的夹具，
// 否则「超时判红」这条只能靠读代码相信）——不是给人把闸调松的旋钮。
const PS_TIMEOUT_MS = (() => {
  const raw = process.env.DAO_PS_TIMEOUT_MS;
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 300_000;
})();
// PS 层总预算：串行累计墙钟超过它，剩余套判「未跑」。兜的是「某套卡住把整个入口拖死」，
// 不是性能指标 —— 实测合计 ≈100-150s（同机不同次波动：选型批 149s、落地批 101s、对抗批三采 100.8-104.1s；三次采样时都是 6 套），900s 至少 6 倍余量。
// `DAO_PS_BUDGET_MS` 与上面那个口子同型、同理由：**给回归网注入一个毫秒级预算用的**，
// 因为真 6 套合计离 900s 差一个数量级 ⇒ 「预算耗尽」这个场景**结构上**造不出来。
// 🔴 **它有意做成「直接取环境值」而不是 `Math.min(env, 900_000)`（只减不增），照直写为什么**：
//   min 那一版更好听（「不是调松旋钮」这句话就落到机器上了），但它**加进来的那个分支
//   结构上无法端到端验证** —— 它只在注入值 > 900s 时才起作用，而要观察到差别就得造一个
//   真的花掉 900s 以上的夹具，那正是本注入口存在的理由所在（造不出来）。
//   一个没有断言守着的分支，与它想防的那句自陈是同一个东西（dao-guard-writing：数到 0
//   和没看到样本，输出一模一样）⇒ 与其加一个自己也没人验的闸，不如**把话说清楚**：
//   **调大这个值等于把「某套卡住拖死入口」的兜底关掉**，它不是给「闸太紧」用的。
//   形态与 `DAO_PS_TIMEOUT_MS` 保持逐字一致，也是刻意的：两个口子一个语义，别让读者
//   以为其中一个「更安全」。
const PS_BUDGET_MS = (() => {
  const raw = process.env.DAO_PS_BUDGET_MS;
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 900_000;
})();

// ── 参数解析（不认识的参数一律 fail-fast，一套都不跑）──────────────────────
// 判据同 verify-exit.ps1 边界②：`-Skip` 是显式意图，不兑现显式意图没有「大致对」的余地。
// 这里同理 —— 打错的参数若被静默忽略，你以为跑了 --env，实际跑的是默认层。
const KNOWN_FLAGS = new Set(["--list", "--env", "--all"]);
const rawArgs = process.argv.slice(2);
let testsDirArg = null;
let testsDirGivenEmpty = false;
const flags = [];
const positional = [];
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
  if (a.startsWith("--")) { flags.push(a); continue; }
  positional.push(a);
}
const unknownFlags = flags.filter((f) => !KNOWN_FLAGS.has(f));
const positionalBad = positional.length > 0;
if (unknownFlags.length || testsDirGivenEmpty || positionalBad) {
  const why = unknownFlags.length
    ? "不认识的参数：" + unknownFlags.join(", ")
    : (testsDirGivenEmpty
      ? "--tests-dir 后面没给路径"
      : "不认识的位置参数：" + positional.join(", "));
  process.stderr.write("[run-tests] 用法错误 —— " + why + "\n");
  process.stderr.write("  合法参数：--list / --env（别名 --all）/ --tests-dir <路径>\n");
  process.stderr.write("  **一套测试都没跑**（打错的参数不静默忽略，否则你以为跑了 --env，实际跑的是默认层）\n");
  process.stdout.write(`RUN_TESTS_SUMMARY exit=${EXIT_BAD_USAGE} tier=none files=0 red=0 pass=0 fail=0 defer=0 deferfiles=0 declared=0 selfcheck=n/a psfiles=0 psred=0 psskip=0\n`);
  process.exit(EXIT_BAD_USAGE);
}
const ENV_TIER = flags.includes("--env") || flags.includes("--all");
const LIST_ONLY = flags.includes("--list");

const DEFAULT_TESTS_DIR = path.join(ROOT, "tests");
const TESTS_DIR = testsDirArg ? path.resolve(testsDirArg) : DEFAULT_TESTS_DIR;

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

// ── PowerShell 侧的标记扫描：**外包给 PowerShell 官方 parser，不在这里自写** ──────
// 判据与两次翻车的完整因果在 `scripts/scan-ps-tier-marker.ps1` 头注（唯一真相源），
// 这里只留 node 侧要知道的三件：
//   ① **两侧刻意各写一份**：JS 标记 = 「文件内部分断言 defer」，文件照跑；
//      PS 标记 = 「整套只在 --env 起进程」。语义不同（见文件头 PS 契约 ①），共用一份会
//      诱使后来者把两侧的计数也并进一个字段，那正好把「哪一半没跑」重新弄没。
//   ② **BOM 不再由这边操心**：`Parser::ParseFile` 自己按 BOM 定编码。此前这里手剥 U+FEFF，
//      是因为 `readFileSync(...,"utf8")` 会把它留成首字符、让行首锚**当场落空而毫无症状**
//      （本仓 .ps1 里除 `link-codex` 外均带 UTF-8 BOM——刻意不写套数：写死的数字已过期两次，以 `--list` 实扫为准）。
//   ③ **判定跑不起来 ⇒ fail-closed 且出声**（见下面 `scanPsTier()` 里的 `bad()`）：
//      「这套没标记」与「我没看成」在退出码上分不开，那正是本文件通篇在治的病。
const PS_TIER_SCANNER = process.env.DAO_PS_TIER_SCANNER
  || path.join(HERE, "scan-ps-tier-marker.ps1");
// 那个注入口同 `DAO_PS_TIMEOUT_MS` 那两个的形态与理由：**给回归网用的**（把它指到一个
// 不存在或必崩的脚本，才验得到「判定器自己坏掉」那条路），不是给人换实现的旋钮。
const PS_SCAN_TIMEOUT_MS = 60_000;

// 分层自检的问题清单：**在这里就建好**，因为标记判定失败是第一个可能往里写的东西
// （它原先建在下面运行期那一段，而那时判定早已发生过了）。
const tierProblems = [];

// 一次 spawn 判定全部 PS 套（真仓实测 ≈0.3s，含 powershell 启动；套数以 `--list` 实扫为准），
// 返回 { declared:Set<file>, prose:string[] }。判定不可信时改判 fail-closed 并往
// tierProblems 里写一条 ⇒ 退出码走 4 那一档，而不是悄悄把 env 套拉回默认层跑。
function scanPsTier(files) {
  if (!files.length) return { declared: new Set(), prose: [] };   // 没有 PS 套就不起进程
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_TIER_SCANNER,
    "-HeadLines", String(TIER_MARKER_HEAD_LINES), ...files.map((f) => path.join(TESTS_DIR, f))];
  const r = spawnSync("powershell.exe", args,
    { encoding: "utf8", cwd: ROOT, timeout: PS_SCAN_TIMEOUT_MS });
  const out = String(r.stdout || "");
  const lines = out.split(/\r?\n/);
  const head = /^PSTIER_SCAN v1 head=(\d+) files=(\d+)$/.exec(lines[0] || "");
  const declared = new Set();
  const prose = [];
  const bad = (why) => {
    tierProblems.push(`PS 分层标记判定没跑成（${why}）⇒ 「哪几套算 env 层」这次是不可信的。`
      + `按 fail-closed 处理：${files.length} 套 PS 测试一律当作**已声明**（默认层一套都不跑），`
      + `不是当作没标记 —— 后者会把带 winget install / 动真 %USERPROFILE% 的那几套悄悄跑起来。`
      + `${r.error ? ` spawn 错误：${r.error.message || r.error.code}；` : ""}`
      + `${r.status != null && r.status !== 0 ? ` 判定器 exit ${r.status}；` : ""}`
      // ⚠ **刻意不往这里贴子进程的 stderr 原文**：PS 5.1 写 stderr 按 `[Console]::OutputEncoding`
      //   （跟控制台代码页走），node 这边按 utf8 解 ⇒ 中文当场成乱码，贴出来只会让人去查
      //   一个不存在的编码问题（`ccswitch/rules/dao-powershell.md` 第三条记的正是这个坑）。
      //   改为给一条**自己重跑**的命令，原文去那里看。
      + `${String(r.stderr || "").trim() ? " 它写了 stderr（内容按控制台代码页编码，这里读不准）；" : ""}`
      + ` 自己重跑看原文：powershell -NoProfile -ExecutionPolicy Bypass -File ${PS_TIER_SCANNER}`
      + ` -HeadLines ${TIER_MARKER_HEAD_LINES} ${path.join(TESTS_DIR, files[0])}`);
    return { declared: new Set(files), prose: [] };
  };
  if (r.error || r.status !== 0) return bad("判定器进程没能正常退出");
  if (!head || Number(head[2]) !== files.length) return bad("输出的表头对不上（文件数或格式不符）");
  if (Number(head[1]) !== TIER_MARKER_HEAD_LINES) return bad("判定器用的扫描窗口与本入口不一致");
  if (!lines.includes("PSTIER_SCAN_END")) return bad("输出没有收尾标记 —— 它多半跑到一半断了");
  let seen = 0;
  for (const line of lines) {
    const m = /^(\d+) decl=([01]) prose=([01]) perr=(-?\d+)$/.exec(line);
    if (!m) continue;
    const idx = Number(m[1]);
    if (idx >= files.length) return bad("输出里的下标越界");
    seen++;
    if (m[2] === "1") declared.add(files[idx]);
    if (m[3] === "1") prose.push(files[idx]);
    if (Number(m[4]) !== 0) {
      // 语法有错 / 文件没读成：**不吞**。它不改判定（token 流是尽力而为的），但要让人看见——
      // 一个读不成的文件被判「无声明」，与它真的没标记长得一样。
      process.stdout.write(`  ⚠ tests/${files[idx]}：PowerShell parser 报`
        + `${Number(m[4]) < 0 ? "这份文件没读成" : ` ${m[4]} 条语法错误`}（本次按判定结果`
        + `${m[2] === "1" ? "已声明" : "无声明"}处理，但这份文件本身先得能跑起来）\n`);
    }
  }
  if (seen !== files.length) return bad(`只解析出 ${seen} 行结果，少于 ${files.length} 个文件`);
  return { declared, prose };
}
const psTierScan = scanPsTier(psTests);
const declaredEnvPs = psTierScan.declared;

process.stdout.write(`[run-tests] tests/ 下发现 ${jsTests.length} 套 node 测试、${psTests.length} 套 PowerShell 测试\n`);
process.stdout.write(`[run-tests] 本次层级：${ENV_TIER ? "--env（含环境敏感断言 + 全部 PS 套，要求串行环境）" : "默认层（环境敏感断言不跑、标了 env 的 PS 套不跑 → 预期 exit 2）"}`
  + `；声明了环境敏感层的文件 ${declaredEnv.size} 个（node）/ ${declaredEnvPs.size} 个（pwsh）\n`);
if (strays.length) {
  process.stdout.write(`  ⚠ 另有 ${strays.length} 个不符 *.tests.{js,ps1} 命名的文件，未纳入：${strays.join(", ")}\n`);
}

// ── 「标记写进了块注释里」的可见提示（fail-loud 半边）─────────────────────────
// PowerShell 认块注释正文是散文，那里的标记**不生效** —— 而「想标 env 却标进了块注释」
// 与「随口写了一句散文」在盘上长得一模一样。差别只在代价：前者会让一套本该摘出去的测试
// 被真的跑起来。故这里**只出声、不判红**（`[#官通-闸位判断]`：这是「人该判断一件事」，
// 不是「代码错了」—— 文档里正当地引用这个语法也会落在这个形态上）。
// 🔴 它不是散文，回归网 ⑪ 有断言钉着它出声；那条断言就是它的退役触发器。
if (psTierScan.prose.length) {
  process.stdout.write(`  ⚠ 有 ${psTierScan.prose.length} 份 .tests.ps1 在头 ${TIER_MARKER_HEAD_LINES} 行的`
    + `**块注释内部**出现了层级标记字面量 —— PowerShell 认为那是散文，**它不生效**：\n`);
  for (const f of psTierScan.prose) {
    process.stdout.write(`    · tests/${f}  ⇒ 若本意是声明，把它挪到块注释**之外**的独立 # 行`
      + `（通常是文件第一个 <# 之前）；若本意就是散文，忽略本行\n`);
  }
}

if (LIST_ONLY) {
  for (const f of jsTests) process.stdout.write(`  node  tests/${f}${declaredEnv.has(f) ? "   [有环境敏感层 · 默认不跑那几节]" : ""}\n`);
  for (const f of psTests) process.stdout.write(`  pwsh  tests/${f}${declaredEnvPs.has(f) ? "   [标了 env · 整套默认层不跑]" : ""}\n`);
  // 判定跑不成时这张清单是**猜的**（fail-closed 把每一套都标成 env）——不许拿 0 退出去，
  // 否则「列不出来」与「列出来了」在退出码上又分不开（本文件通篇治的就是这个）。
  if (tierProblems.length) {
    process.stdout.write(`\n✗ 分层自检失败 ${tierProblems.length} 条 —— 上面这张分层清单不可信：\n`);
    for (const p of tierProblems) process.stdout.write(`    · ${p}\n`);
    process.exit(EXIT_SELFCHECK);
  }
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

// ── PowerShell 层：串行代跑（见文件头 PS 契约）──────────────────────────────
// 串行是硬要求，不是保守。**理由换了一个，别读成原来那个**：
// 原文写的是「本仓有两套用**固定** `_tmp/` 路径当沙盒（dao-pr-merge / pr-body-scan），
// 并行跑必互踩」——那两套已随机化并回到默认层，那条理由对它们不再成立。
// ⚠ 而**同一句话原本就是不完整的**：`dao-secrets` 也用固定 `_tmp/dao-secrets-test`，
// 它是第三套（它另有更硬的 env 理由：对真 `%USERPROFILE%`/`%APPDATA%` 做机器级断言，
// 那一格随机化治不了）。「两套」那个数字从写下那天起就漏了一个。
// ⇒ 现在的理由：①`dao-secrets` 仍是固定沙盒 + 真机器级状态 ②各套都起真 `powershell.exe`
// 与真 `git` 子进程，并行只是把墙钟换成 CPU 争抢 ③总预算（下面 ㈡）是按串行累计算的。
// **刻意不在这里列「哪几套是固定沙盒」的清单** —— 本仓手维护的枚举被咬过三次，
// 而这一句自己就是刚被咬的那一次。
const psResults = [];
{
  const psT0 = Date.now();
  for (const f of psTests) {
    // ㈠ 标记跳过：整套不起进程（默认层 + 有标记）
    if (!ENV_TIER && declaredEnvPs.has(f)) {
      psResults.push({ file: f, ranAt: false, why: "头部标了 @dao-test-tier: env ⇒ 只在 --env 跑" });
      continue;
    }
    // ㈡ 预算跳过：串行累计墙钟已超总预算，剩下的一律判「未跑」而不是排队等
    const spent = Date.now() - psT0;
    if (spent >= PS_BUDGET_MS) {
      // 报文里必须**带得出归因**：「标记跳过」与「预算跳过」在汇总表上都是一行 `⊘ 未跑`，
      // 而处置完全不同（前者去跑 --env，后者去查是谁把预算吃光了）。故这一行显式否认前者。
      psResults.push({ file: f, ranAt: false,
        why: `PS 层总预算 ${PS_BUDGET_MS}ms 已用尽（已花 ${spent}ms）⇒ 本次未跑 `
          + `—— **不是标记跳过**，是排在前面的某套吃掉了预算（多半有一套卡住了）` });
      continue;
    }
    const t0 = Date.now();
    const r = spawnSync("powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(TESTS_DIR, f)],
      { encoding: "utf8", cwd: ROOT, timeout: PS_TIMEOUT_MS });
    const ms = Date.now() - t0;
    const out = String(r.stdout || "");
    // 红判据（F2）：三条通道任一命中即红。`status` 单看不够 —— 超时与被信号打断时
    // `status` 是 null，而 `null !== 0` 虽然也为真，但把 error/signal 显式写出来是为了
    // **报文能说清是哪一种**（超时要额外警告孤儿进程，普通红不需要）。
    const timedOut = !!(r.error && String(r.error.code || r.error.message).includes("ETIMEDOUT")) || r.signal === "SIGTERM";
    const red = r.status !== 0 || !!r.error || !!r.signal;
    // 计数解析沿用现状：多数套不打这个汇总行，取不到标「未报计数」、判定看退出码（见头注 ⑦）。
    const m = out.match(/PASS=(\d+)\s+FAIL=(\d+)/);
    psResults.push({
      file: f, ranAt: true, code: r.status, red, timedOut,
      signal: r.signal || null,
      errMsg: r.error ? String(r.error.message || r.error.code) : null,
      pass: m ? Number(m[1]) : null,
      fail: m ? Number(m[2]) : null,
      emptyOut: !red && out.trim() === "",
      ms, out, err: String(r.stderr || ""),
    });
  }
}

// 失败者的完整输出要打出来，否则「哪一条红了」得重跑一遍才知道
for (const r of results) {
  if (r.code !== 0) {
    process.stdout.write(`\n──── 失败详情 tests/${r.file}（exit ${r.code}）────\n`);
    process.stdout.write(r.out);
    if (r.err.trim()) process.stdout.write(`[stderr]\n${r.err}\n`);
  }
}
for (const r of psResults) {
  if (!r.ranAt || !r.red) continue;
  process.stdout.write(`\n──── 失败详情 tests/${r.file}（pwsh · exit ${r.code}${r.signal ? ` signal=${r.signal}` : ""}）────\n`);
  process.stdout.write(r.out);
  if (r.err.trim()) process.stdout.write(`[stderr]\n${r.err}\n`);
  if (r.errMsg) process.stdout.write(`[spawn error] ${r.errMsg}\n`);
  if (r.timedOut) {
    process.stdout.write(`  ⚠ 这一套是**超时**被打断的（上限 ${PS_TIMEOUT_MS}ms），判红不判跳过。\n`);
    process.stdout.write(`    ⚠ **spawnSync 不杀进程树**：被 kill 的只是 powershell.exe 本身，它起的子进程可能还活着，\n`);
    process.stdout.write(`      而这套测试的 _tmp 沙盒此刻多半是半写状态 ⇒ **下一次跑同一套可能因此失败，成因在这一次**。\n`);
    process.stdout.write(`      收拾干净再重跑：核一遍残留的 powershell 进程，并清掉该套用的 _tmp 目录。\n`);
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

// ── PowerShell 层进同一张汇总表（前缀 pwsh）──────────────────────────────────
// 刻意与 node 那几行同表：分两张表的话，「PS 那半这次跑没跑」又变成得往下翻才看得到的事。
let psRed = 0, psRan = 0, psNotRun = 0, psPass = 0, psFail = 0;
const psSkipped = [];
for (const r of psResults) {
  const tierTag = declaredEnvPs.has(r.file) ? " ⚑env" : "";
  if (!r.ranAt) {
    psNotRun++; psSkipped.push(r);
    process.stdout.write(`  ⊘ 未跑            （${r.why}）        tests/${r.file}${tierTag}\n`);
    continue;
  }
  psRan++;
  if (r.red) psRed++;
  if (r.pass != null) { psPass += r.pass; psFail += r.fail; }
  const counts = r.pass != null ? `PASS=${String(r.pass).padStart(3)} FAIL=${r.fail}` : "（未报计数）";
  const timeoutTag = r.timedOut ? " ⏱超时" : "";
  process.stdout.write(`  ${r.red ? "✗" : "✓"} exit=${String(r.code == null ? "?" : r.code).padStart(2)}  ${counts}${timeoutTag}  ${String(r.ms).padStart(5)}ms  pwsh tests/${r.file}${tierTag}\n`);
}
if (psTests.length) {
  process.stdout.write(`  ── ${psTests.length} 套 PowerShell 测试：${psRan - psRed} 过 / ${psRed} 红 / ${psNotRun} 未跑`
    + `${psPass || psFail ? `；断言合计 PASS=${psPass} FAIL=${psFail}（只统计打了汇总行的那几套）` : ""}\n`);
}

// ── 自检半边 ②：静态声明 vs 运行期计数，差值即警报 ────────────────────────
// （`tierProblems` 建在文件上方 —— PS 标记判定失败会比这里更早往里写。）
for (const r of results) {
  // 红的文件另有专门通道（上面已打全量输出），不在这里重复判 —— 它可能压根没跑到汇总行。
  if (r.code !== 0) continue;
  // 🔴 issue #300 方向 4：JS 套 exit 0 却没报计数 ⇒ 自检失败（不再只是「带对勾的未报计数」）。
  //    独立判断、不进下面那条 if-continue 链：它与「有 DEFER 明细却没 DEFER= 字段」可以同时成立
  //    （一套什么都没打的套，两种病都有），互斥会吃掉其中一条的归因。
  //    PS 侧刻意不同步升格（现存「未报计数」全在 PS 侧，判红会误伤）——理由见头注。
  if (r.pass == null) {
    tierProblems.push(`tests/${r.file} exit 0 但没打出可解析的汇总行（=== 汇总: PASS=n FAIL=m ===）`
      + ` ⇒ 它在断言条数基线里永远只能记「未报计数」= **永久没有条数下界**，而汇总表那行照旧带对勾`
      + `（「没跑的闸」与「过了的闸」长得一样）。给它补上汇总行；契约见 run-tests.mjs 头注。`);
  }
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

// ── 自检半边 ②′：PowerShell 侧的「exit 0 + 零输出」（F4）────────────────────
// 一个**跑到了断言**的 PS 套必然吐东西（各套都打进度/汇总行）。exit 0 而 stdout 全空，
// 说明它多半根本没跑到断言：被执行策略挡掉、头部就 return、文件被清空、dot-source 的
// 依赖抛在最前面又被吞。**这与「全过」在退出码上一模一样** —— 正是本文件通篇在治的那个病
// （「一个检查器数到 0 个违例，和它根本没看到样本，输出长得一样」）。故它走 exit 4 通道，
// 不走红：红的语义是「有断言失败」，而这里的问题是「没有断言」。
for (const r of psResults) {
  if (r.ranAt && r.emptyOut) {
    tierProblems.push(`tests/${r.file}（pwsh）exit 0 但 stdout 是空的 `
      + `⇒ 它多半没跑到任何断言（「exit 0 + 零输出」与「全过」在退出码上分不开），先查它到底起没起来`);
  }
}

// ── 断言条数基线已删（重设计，拷问局定案③）——此处原先是基线比对与写档逻辑。

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

if (psNotRun) {
  // F1：**不再只靠这段散文**。它下面的退出码那一格会把 psNotRun 顶到至少 2 ——
  // 「有 PS 套没跑」从此走机器通道，而不是指望人读到这几行。
  process.stdout.write(`\n⚠ 本次未跑：PowerShell 测试 ${psNotRun} 套（共 ${psTests.length} 套）—— **「没跑」不等于「跑了全过」**\n`);
  for (const r of psSkipped) process.stdout.write(`    · tests/${r.file}  —— ${r.why}\n`);
  process.stdout.write(`  跑全部 PS 套：node scripts/run-tests.mjs --env\n`);
  process.stdout.write(`    ⚠ 要求串行环境：仍有套用固定 _tmp 沙盒 + 对真 %USERPROFILE%/%APPDATA% 做机器级断言\n`);
  process.stdout.write(`  退出码至少 ${EXIT_DEFERRED} 就是这个意思：本次没跑完。**要 0 必须带 --env。**\n`);
}

// ── 退出码 + 机器可读末行（照 DEAD_GATES_SUMMARY 的路数：只读末行的消费方也拿得到全貌）──
// 优先级 1 > 4 > 2 不变；本批只是把 PS 侧的红并进 1、把 PS 侧的未跑并进 2。
let exitCode = EXIT_OK;
if (bad || psRed) exitCode = EXIT_RED;
else if (tierProblems.length) exitCode = EXIT_SELFCHECK;
else if (totalDefer || psNotRun) exitCode = EXIT_DEFERRED;

// 末行三个新字段（psfiles/psred/psskip）**追加在尾部**，既有字段顺序一字未动 ——
// 现有消费方的正则没有行尾锚，追加不破坏它们（回归网里有一条负控专门钉这一点）。
// psfiles = 本次**真的跑了**几套（不是发现了几套）；psskip = 没跑几套（标记跳过 + 预算跳过）。
process.stdout.write(`RUN_TESTS_SUMMARY exit=${exitCode} tier=${ENV_TIER ? "env" : "default"}`
  + ` files=${results.length} red=${bad} pass=${totalPass} fail=${totalFail}`
  + ` defer=${totalDefer} deferfiles=${deferringFiles.length} declared=${declaredEnv.size}`
  + ` selfcheck=${tierProblems.length ? "fail" : "ok"}`
  + ` psfiles=${psRan} psred=${psRed} psskip=${psNotRun}\n`);
process.exit(exitCode);
