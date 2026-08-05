// ps-console-encoding 回归网 —— 「PowerShell 测试的红绿不许取决于控制台代码页」
//
// 跑法：node tests/ps-console-encoding.tests.js   （全绿 exit 0，任一红 exit 1）
//       node scripts/run-tests.mjs               （自动发现本文件，无需登记）
//
// ── 治的是什么病（issue #131）────────────────────────────────────────────────
// PS 5.1 捕获子进程 stdout 时按 `[Console]::OutputEncoding` 解码，而它跟着**控制台代码页**
// 走（中文 Windows 默认 CP936）；本仓生产侧 `check-clauses-structure.ps1` 却把自己的
// stdout **钉成 UTF-8**（为 node 消费方，2026-08-01）。两边只在控制台恰好是 65001 时对得上。
// 实测：`tests/clause-structure.tests.ps1` 在 CP936 下 51 FAIL / EXIT=1，在 65001 下
// 155 passed / EXIT=0 —— 同一份代码、同一个被测对象，**红的报文全指向被测对象，
// 没有任何东西指向控制台**。它五次被当成「这套测试无条件绿」的证据，正是因为跑它的
// 那台机器的控制台恰好是 65001。
// 处方在 `ccswitch/lib/console-utf8.ps1`（判据真相源），各套 `.ps1` dot-source 它。
//
// ── 本文件为什么不止查「那一行在不在」────────────────────────────────────────
// 只查行在不在，等于把「这行还管用吗」交给运气：dot-source 的路径写错、bootstrap 被改成
// 空操作、未来 PS 行为变化 —— 三种都让那一行**在而无效**，而静态检查看不出任何区别。
// 故本文件有**行为半边**（§③）：真起一个 decode 侧被钉成 CP936 的 PowerShell，去捕获一个
// 钉了 UTF-8 的生产者，看中文有没有活着穿过来。
// 而行为半边自己也要能自证不是在测空气 ⇒ §④ 是它的负控：**同一个探针、只摘掉 bootstrap，
// 必须变红**。两条一起才构成「测到了东西」的证据（dao-guard-writing：一个检查器数到 0 个
// 违例，和它根本没看到样本，输出长得一模一样）。
//
// ── 探针会临时动调用方的控制台，这一点必须说清楚 ────────────────────────────
// `[Console]::OutputEncoding` 的 setter 调的是 `SetConsoleOutputCP`，作用域是**整个控制台**
// 而非本进程；`chcp` 同理（本仓实测：子 cmd 里 `chcp 936` 之后，父控制台的输出当场变乱码）。
// ⇒ §③④ 的探针**会把调用方控制台的代码页临时改成 936**。两道复原：探针进程自己在
// `finally` 里改回（窗口缩到那个进程内），node 侧跑完再核一次、不一致就改回并判红（§⑤）。
//
// **本想用 `start "<title>" /wait /min` 给探针另开一个控制台，做到完全不碰调用方 —— 实测不行**：
// 从 PowerShell 手敲可用，但从 node `spawnSync`（stdio 走管道）里调，第二次探针必挂，
// 挂在 `start` 上而不是探针里（同一个 inner.cmd 直接跑 45 秒内正常完成、结果正确）。
// 那条路没走通就照直写，不留一个跑不起来的"更好方案"在注释里。
// **已知残余**：本闸若在 §③④ 之间被强杀，调用方控制台会留在 CP936 上（`chcp 65001` 改回）。
//
// ── 射程边界，照直写 ─────────────────────────────────────────────────────────
// ㈠ 静态半边只认 `tests/*.tests.ps1`。别的地方（`ccswitch/scripts/*.ps1`、各项目的
//    verify-all 适配器）同样会以 PowerShell 身份消费钉了 UTF-8 的生产者，**本闸看不见它们**。
// ㈡ 行为半边用的是一个**合成生产者**（复刻真生产者唯一相关的那个行为：钉 UTF-8 + 吐中文），
//    不是真跑 `check-clauses-structure.ps1`。代价是它证不了真生产者的其余行为；
//    补偿是 §① 把真生产者的那一行与那个标题串**锚住**，前提一变就红。
// ㈢ 它证不了「51 条断言现在测的还是原来那件事」—— 那由 `clause-structure.tests.ps1` 自带的
//    mutation/canary 组（New-MutantChecker）负责，本闸不重复。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const TESTS_DIR = __dirname;
const BOOTSTRAP = path.join(REPO, "ccswitch", "lib", "console-utf8.ps1");
const PRODUCER_REAL = path.join(REPO, "ccswitch", "scripts", "check-clauses-structure.ps1");
const WORK = path.join(REPO, "_tmp", "ps-console-encoding-test");

// 真生产者打印的那个标题串。行为半边拿它当哨兵，§① 断言它确实还在真生产者里
// —— 哨兵与被锚对象必须是同一个串，否则锚点保的是另一件事。
const SENTINEL = "条款库结构完整性硬闸";

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}

// PS 5.1 读无 BOM 的脚本本体时按本机 ANSI 解码，中文注释当场报废 ⇒ 生成的夹具必须带 BOM。
function writePs1(file, body) {
  fs.writeFileSync(file, "﻿" + body, "utf8");
}

function currentConsoleCp() {
  // chcp 的文案是本地化的，但数字恒为 ASCII；用 latin1 读，只认数字。
  const r = spawnSync("cmd", ["/c", "chcp"], { encoding: "latin1" });
  const m = /(\d{3,5})\s*$/.exec(String(r.stdout || "").trim());
  return m ? Number(m[1]) : null;
}

// ── § ① 前提锚点：生产侧还在钉 UTF-8，标题串还在 ────────────────────────────
console.log("\n① 前提锚点 —— 本闸测的那个前提还成立吗");
{
  const src = fs.readFileSync(PRODUCER_REAL, "utf8");
  // 单行锚点：不跨行，故天然不受 CRLF/LF 影响（check-mutation-anchor 只报跨行裸 \n）。
  const PIN_RE = /\[Console\]::OutputEncoding\s*=\s*\[System\.Text\.Encoding\]::UTF8/;
  check("生产侧 check-clauses-structure.ps1 仍把自己的 stdout 钉成 UTF-8", PIN_RE.test(src),
    "锚点没命中 ⇒ 前提变了，本闸下面测的不再是原来那件事");
  check("哨兵串仍是真生产者打印的那个标题", src.includes(SENTINEL),
    "SENTINEL=" + SENTINEL + " 已不在生产者源码里");
  // ⚠ 必须先剥掉注释行再判：bootstrap 的头注里**逐字引用**了这条赋值语句（讲的就是它），
  //   直接全文匹配的话，把那一行代码整个换成空操作、这条断言照样绿 ——
  //   本条初版就是这么写的，是 mutation A（把注入改成 $null = ...）当场照出来的。
  //   「判据能被散文满足」是本仓明训「检查器数到 0 与它根本没看到样本，输出一模一样」的近亲。
  const bootstrapCode = fs.existsSync(BOOTSTRAP)
    ? fs.readFileSync(BOOTSTRAP, "utf8").split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n")
    : "";
  check("bootstrap 存在，且**代码行**（非注释）里确实在设 OutputEncoding",
    /\[Console\]::OutputEncoding\s*=/.test(bootstrapCode),
    "剥掉注释后没找到赋值 ⇒ 钉子被改成了空操作，或文件没了：" + BOOTSTRAP);
}

// ── § ② 静态不变量：每套 .ps1 测试都 dot-source 了 bootstrap ────────────────
console.log("\n② 静态不变量 —— tests/*.tests.ps1 逐个都钉了解码侧");
{
  const HEAD_LINES = 80;                       // 钉子必须在任何捕获之前，写在文件头部
  // 抽取半边：认「dot-source 一个提到 console-utf8.ps1 的路径」这个形态。
  const DOTSOURCE_RE = /^[ \t]*\.[ \t]+.*console-utf8\.ps1/m;
  // 普查半边：**不用正则**，只数字面出现次数。抽取瞎掉时它仍看得见样本
  // （dao-guard-writing 第二条：自检那一半不许复用被守对象的解析逻辑）。
  const census = (t) => t.split("console-utf8").length - 1;

  const psTests = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith(".tests.ps1")).sort();
  check("自检·非零样本：tests/ 下确实有 .ps1 测试", psTests.length > 0,
    "一套都没扫到 ⇒ 此时的『零违例』不可信");

  const missing = [];
  let totalCensus = 0, totalHits = 0;
  for (const f of psTests) {
    const text = fs.readFileSync(path.join(TESTS_DIR, f), "utf8");
    const head = text.split(/\r?\n/).slice(0, HEAD_LINES).join("\n");
    totalCensus += census(text);
    if (DOTSOURCE_RE.test(head)) totalHits++;
    else missing.push(f);
  }
  check("每套 .ps1 测试都在头 " + HEAD_LINES + " 行内 dot-source 了 bootstrap",
    missing.length === 0, "缺的：" + missing.join("、"));
  check("自检·抽取没瞎：普查看得见提及时，抽取必须抽得出来",
    !(totalCensus > 0 && totalHits === 0), "census=" + totalCensus + " 而 hits=" + totalHits);
  console.log("  ⓘ 扫了 " + psTests.length + " 套 .ps1 测试，字面提及 " + totalCensus + " 处");
}

// ── § ③④ 行为半边：正控 + 负控（隔离控制台里跑）────────────────────────────
console.log("\n③④ 行为半边 —— 钉了会活，不钉会死（后者证明前者不是在测空气）");
const cpBefore = currentConsoleCp();
{
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  // 生产者：复刻真生产者唯一相关的那个行为 —— 钉 UTF-8，然后吐中文。
  const producer = path.join(WORK, "producer.ps1");
  writePs1(producer, [
    "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }",
    "Write-Output '" + SENTINEL + "'",
    "",
  ].join("\r\n"));

  // 消费者：先把 decode 侧钉成指定代码页（模拟中文 Windows 的默认控制台），
  // 再按开关决定要不要应用 bootstrap，然后捕获生产者的输出。
  // 结果用 .NET 显式 UTF-8 落盘 —— 不经任何控制台编码，读回来才是字节级可信的。
  // `finally` 里把控制台代码页改回进程启动时的值：这是两道复原中的第一道（见文件头）。
  const consumer = path.join(WORK, "consumer.ps1");
  writePs1(consumer, [
    "param([int]$DecodeCp, [string]$Producer, [string]$OutFile, [int]$UseBootstrap)",
    "$ErrorActionPreference = 'Stop'",
    "$orig = [Console]::OutputEncoding",
    "try {",
    "    [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding($DecodeCp)",
    "    if ($UseBootstrap -eq 1) { . '" + BOOTSTRAP.replace(/'/g, "''") + "' }",
    "    $captured = & powershell -NoProfile -ExecutionPolicy Bypass -File $Producer",
    "    [System.IO.File]::WriteAllText($OutFile, ($captured -join \"`n\"), (New-Object System.Text.UTF8Encoding($false)))",
    "} finally {",
    "    try { [Console]::OutputEncoding = $orig } catch { }",
    "}",
    "",
  ].join("\r\n"));

  function runProbe(tag, useBootstrap) {
    const outFile = path.join(WORK, tag + ".out");
    fs.rmSync(outFile, { force: true });
    const r = spawnSync("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", consumer,
      "-DecodeCp", "936",
      "-Producer", producer,
      "-OutFile", outFile,
      "-UseBootstrap", useBootstrap ? "1" : "0",
    ], { encoding: "latin1" });
    if (!fs.existsSync(outFile)) {
      return { ok: false, why: "探针没产出结果文件 exit=" + r.status + " stderr=" + String(r.stderr || "").slice(0, 300) };
    }
    return { ok: true, text: fs.readFileSync(outFile, "utf8") };
  }

  const withPin = runProbe("with-pin", true);
  check("③ 正控：decode 侧被钉成 UTF-8 后，中文原样穿过进程边界",
    withPin.ok && withPin.text.trim() === SENTINEL,
    withPin.ok ? JSON.stringify(withPin.text) : withPin.why);

  const noPin = runProbe("no-pin", false);
  check("④ 负控：摘掉钉子后必须坏掉（否则 ③ 是在测空气）",
    noPin.ok && noPin.text.trim() !== SENTINEL,
    noPin.ok ? "捕获=" + JSON.stringify(noPin.text) + " 竟与哨兵相同 ⇒ 本机复现不出该缺陷，"
      + "③ 的绿不构成证据" : noPin.why);
  if (noPin.ok) console.log("  ⓘ 负控实际捕获到的乱码：" + JSON.stringify(noPin.text.trim()));
}

// ── § ⑤ 复原自证：本闸没把调用方的控制台留在别的代码页上 ────────────────────
// 先读后修再判：不一致时也要把它改回去（**判红不等于可以撂着不管**），
// 但仍照实判红 —— 探针的复原路径漏了就是漏了，node 侧这道兜底不该把它盖住。
console.log("\n⑤ 复原自证 —— 本闸自己不许把调用方留在 CP936 上");
{
  const cpAfter = currentConsoleCp();
  if (cpBefore !== null && cpAfter !== cpBefore) spawnSync("cmd", ["/c", "chcp", String(cpBefore)], { encoding: "latin1" });
  check("跑完之后调用方控制台的代码页没变", cpBefore !== null && cpBefore === cpAfter,
    "before=" + cpBefore + " after=" + cpAfter + "（已兜底改回；若确非本闸所为，查有没有别的进程并发改了它）");
}

console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " ===");
process.exit(fail ? 1 : 0);
