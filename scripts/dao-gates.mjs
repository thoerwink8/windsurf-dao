#!/usr/bin/env node
// dao-gates.mjs — 交付前「派生物 / 完整性闸」聚合入口（issue #70 · 三层降耗方案 · 层2 件①）
//
// ── 治的是什么病 ─────────────────────────────────────────────────────────────
// 交付前每个官各自手跑那几道闸（dao-smoke / check-mutation-anchor /
// check-clauses-structure 全量），各自复制粘贴每段输出、
// 各自心算「这算不算过」。机械、零判断、且极易漏跑一道——本文件把它收成一条命令。
// **本文件通篇刻意不写「几道闸」这个数**（2026-08-10 起）：当前有几道以下面 GATES 数组为准、
// 对外以 `--list` 的打印为准。写死的数字在加第 6 道闸那天会集体过期，而本仓的手维护枚举
// 已经被咬过三次。唯一一处刻意留着数字的是回归网里那条 `=== 3` 强断言——它的职责正是
// 「改了闸数就得有人来改我」，那是特意要它过期的。
//
// ── 为什么是独立薄脚本，不是 `run-tests.mjs --gates`（为道日损下的取舍，照直写）──
// 派单令给了两个选项，本批选了后者，理由三条：
//   ① **扫描面不同源**：`run-tests.mjs` 的整份契约建立在「`tests/*.tests.{js,ps1}` 是一个
//      同构、自描述的文件族，可以扫目录发现」——这正是它反复强调「不手维护清单」的前提。
//      这里的每道闸都是一个**异构**入口（不同脚本、不同 flag 约定、不同退出码词汇表），
//      压根不是目录扫得出来的东西；硬塞进去等于在一个「靠扫描过活」的文件里长出第二套
//      手维护枚举——那正是 `run-tests.mjs` 自己通篇在治的病。
//   ② **退出码契约不同构**：`run-tests.mjs` 的 0-5 六态是已被 CLAUDE.md / dispatch-clauses.md
//      奉为「唯一真相源」、被 `dao-pr-merge.ps1 -VerifyCommand` 依赖的成熟契约。闸门这边的
//      语义是三分类（ok / red / **inconclusive**——`check-clauses-structure` 的 exit=3 就是
//      这一类，见下），和「测试红几个」不是同一个量纲。混进同一份退出码里，要么改写既有
//      契约（破坏 dao-pr-merge.ps1 已经在依赖的东西），要么在同一个文件里又长出一套平行
//      契约——后者比单开一个文件更难读。
//   ③ **职责不同**：「测试」断言行为、报 PASS/FAIL 计数；「闸」只是**转述**已经独立存在的
//      检查器的真退出码，没有计数可言。复用 run-tests.mjs 的**模式**（spawnSync + 真退出码
//      + 汇总表 + 末行机器可读行）比复用它的**文件**更符合「并」的精神。
//
// ── 退出码契约（五态；本文件是唯一真相源）───────────────────────────────────────
//   0  全部闸 exit=0（真绿）
//   1  至少一道闸命中**真违例**（red：`--check` 报漂移 / dao-smoke FAIL>0 /
//      check-clauses-structure exit=1）
//   2  无 red，但至少一道**没查成**（inconclusive：check-clauses-structure exit=3「源清单
//      拿不到」、gen-*-files 的运行环境缺口 exit=2、自检塌陷 exit=5 等）——
//      **这正是派单令点名的那一格**：check-clauses-structure 的 0/1/3 三态里，3 归这一档
//      不归 1，聚合退出码因此是 2 不是 1。「没查成」与「查出真问题」不许长得一样。
//   3  用法错误（不认识的参数）——一道闸都没跑
//   4  某道闸给出的退出码**不在它自己声明的已知集合里**——契约本身对不上了，比
//      「没查成」更严重（那说明这份分类表可能已经过期），不许悄悄并进 inconclusive
//   优先级（同一批结果里可能同时出现多类，取最严重的那个）：unknown(4) > red(1) >
//   inconclusive(2) > ok(0)。**判「通过」写 `=== 0`**，别写 `<= 2`——那会把 1 也放行。
//
// ── 单闸失败不吞后续闸 ───────────────────────────────────────────────────────
// 下面是一个不做提前退出的普通 for 循环：某道闸红了，后面的闸照样跑，全跑完才汇总。
// 这是派单令的明确要求——一次交付前检查若因为闸①红了就看不到闸②③④⑤的状态，
// 官会被迫「修一道、重跑一整条命令」式地来回，机械开销原样还在。
//
// ── 测试注入口（`DAO_GATES_FIXTURE`）────────────────────────────────────────
// 同 `run-tests.mjs` 里 `DAO_PS_TIER_SCANNER` / `DAO_PS_TIMEOUT_MS` 那两个口子同型：
// **给回归网用的，不是给人换真实闸清单的旋钮**。指向一份 JSON（数组，元素形状与下面
// `GATES` 里每一项相同：`{name, cmd, args, codes, note}`），本次运行改用那份清单而不是
// 真实 3 道闸——这样才能用秒级的合成夹具脚本覆盖到「red / inconclusive / unknown 三类都
// 出现」「某道红不影响后面继续跑」这些分支，而不必真的去踩坏条款库。
//
// ── 已知的射程缺口，照直写 ───────────────────────────────────────────────────
//   ㈠ **GATES 清单是手写的，不是派生物**——与 `tests/*.tests.{js,ps1}` 那种「扫目录」
//      不同，这 5 个入口没有共同的文件名后缀或目录可供机械发现（不同语言、不同 flag
//      约定），没有「唯一真相源」可供反算。新增第 6 道闸时必须手改这个数组——这是本文件
//      唯一没有做成「自己会更新」的地方，若未来这 5 个入口都收敛成统一的 `--check` 协议，
//      才具备改写成扫描式的前提，本批不做那件事（为道日损：先解决「复制粘贴 5 段」，
//      不顺带发明一个新协议）。
//   ㈡ **串行执行，不是为了性能**：各闸依次跑，总墙钟≈各道之和（`check-clauses-structure`
//      全量模式是这里边最慢的一道，本机同机三次独立测量 8.1s / 9.6s / 9.4s）。选串行是为了
//      和 `run-tests.mjs` 的既有先例一致（避免多个 powershell/node 子进程互抢 CPU 导致耗时
//      判断失真），且这本来就是「交付前跑一次」的场景，不是热路径。
//      🔴 **这一行原写「55-81s」，错了约 7 倍**（2026-08-10 订正，出处 PR #252 对抗验证判词）：
//      那个区间属于 `tests/clause-structure.tests.ps1`（**那套测试**，它自己头注写着 67-81s），
//      不是被测脚本本体。**这个错数不只是错了一个数字**——它当时被当成「端到端整跑负担不起」
//      的论据用掉了（见 `tests/dao-gates.tests.js` 头注同批订正），而按真实耗时那条路走得通。
//      ⚠ 耗时数字按体系惯例本不该写进条款/注释（换台机器差数倍），这里保留是因为它是**一句
//      已经发出去的假宣称**的订正记录；判断快慢一律以你自己那次 `DAO_GATES_SUMMARY` 上面那张
//      汇总表的逐闸 ms 为准，不以本行为准。
//
// ── 跑法 ────────────────────────────────────────────────────────────────────
//   node scripts/dao-gates.mjs          跑全部闸，输出汇总表 + 末行 DAO_GATES_SUMMARY
//   node scripts/dao-gates.mjs --list   只列各道闸的名字与 note，不执行（自更新：新增/改闸
//                                       改这个文件的 GATES 数组即可，`--list` 的输出跟着变，
//                                       消费方——包括 CLAUDE.md 里那一行指针——不需要另外维护）

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const EXIT_OK = 0;
const EXIT_RED = 1;
const EXIT_INCONCLUSIVE = 2;
const EXIT_BAD_USAGE = 3;
const EXIT_UNKNOWN = 4;

// ── 真实闸清单（唯一真相源；改闸清单改这里，不改 CLAUDE.md）──────────────────────
// `codes` 是「该闸自己声明的退出码 → 分类」映射，来源逐条见各脚本头注/正文：
// （2026-08-11 重设计：gen-clause-index / gen-guarded-files 两道随派生物消灭退役）
//   dao-smoke.mjs          `process.exit(failed > 0 ? 1 : 0)`
//   check-mutation-anchor.mjs 头注「退出码：0 干净 · 1 发现违例 · 2 目录不存在 · 5 扫描面塌陷」
//   check-clauses-structure.ps1 .NOTES「退出码 0=结构完整；非 0=命中已知失效形态；
//                                       全量模式另有退出码 3=这次压根没查成」
const GATES = [
  {
    name: "dao-smoke",
    cmd: process.execPath,
    args: [path.join(ROOT, "scripts", "dao-smoke.mjs")],
    codes: { 0: "ok", 1: "red" },
    note: "ccswitch skills frontmatter / 交叉引用自检",
  },
  {
    name: "check-mutation-anchor",
    cmd: process.execPath,
    args: [path.join(ROOT, "ccswitch", "scripts", "check-mutation-anchor.mjs")],
    codes: { 0: "ok", 1: "red", 2: "inconclusive", 5: "inconclusive" },
    note: "mutation 锚点跨行裸 \\n 检查（缺省扫 tests/）；2=目录不在，5=自检塌陷",
  },
  {
    name: "check-clauses-structure（全量）",
    cmd: "powershell.exe",
    args: [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(ROOT, "ccswitch", "scripts", "check-clauses-structure.ps1"),
    ],
    codes: { 0: "ok", 1: "red", 3: "inconclusive" },
    note: "条款库结构 + 正文↔台账双向对账（不传 -TargetFile ⇒ 全量）；" +
      "3=源清单拿不到、这次压根没查成，**不是** 1（派单令点名的那一格）",
  },
];

// ── 参数解析 ─────────────────────────────────────────────────────────────────
const KNOWN_FLAGS = new Set(["--list"]);
const rawArgs = process.argv.slice(2);
const unknownFlags = rawArgs.filter((f) => !KNOWN_FLAGS.has(f));
if (unknownFlags.length) {
  process.stderr.write("[dao-gates] 用法错误 —— 不认识的参数：" + unknownFlags.join(", ") + "\n");
  process.stderr.write("  合法参数：--list\n");
  process.stderr.write("  **一道闸都没跑**（打错的参数不静默忽略）\n");
  process.stdout.write(`DAO_GATES_SUMMARY exit=${EXIT_BAD_USAGE} gates=0 ok=0 red=0 inconclusive=0 unknown=0` + (process.env.DAO_GATES_FIXTURE ? " fixture=1" : " fixture=0") + "\n");
  process.exit(EXIT_BAD_USAGE);
}
const LIST_ONLY = rawArgs.includes("--list");

// ── 装载闸清单：测试注入口优先于真实清单（见头注「测试注入口」）──────────────────
let gates = GATES;
const fixturePath = process.env.DAO_GATES_FIXTURE;
if (fixturePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  } catch (e) {
    process.stderr.write(`[dao-gates] DAO_GATES_FIXTURE 指向的文件读不成或不是合法 JSON：${fixturePath}\n  ${e.message}\n`);
    process.exit(EXIT_BAD_USAGE);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    process.stderr.write(`[dao-gates] DAO_GATES_FIXTURE 必须是非空数组：${fixturePath}\n`);
    process.exit(EXIT_BAD_USAGE);
  }
  gates = parsed.map((g) => ({
    name: g.name, cmd: g.cmd, args: g.args || [], codes: g.codes || {}, note: g.note || "",
  }));
}

if (LIST_ONLY) {
  process.stdout.write(`[dao-gates] 共 ${gates.length} 道闸${fixturePath ? "（来自 DAO_GATES_FIXTURE，非真实清单）" : ""}：\n`);
  for (const g of gates) {
    process.stdout.write(`  · ${g.name}\n`);
    if (g.note) process.stdout.write(`      ${g.note}\n`);
  }
  process.exit(EXIT_OK);
}

// ── 依次跑（不提前退出：单闸失败不吞后续闸，全跑完再汇总）────────────────────────
const results = [];
for (const g of gates) {
  const t0 = Date.now();
  const r = spawnSync(g.cmd, g.args, { encoding: "utf8", cwd: ROOT });
  const ms = Date.now() - t0;
  let category;
  let spawnErr = null;
  if (r.error) {
    category = "unknown";
    spawnErr = String(r.error.message || r.error.code || r.error);
  } else if (r.status == null) {
    category = "unknown"; // 被信号打断等
  } else {
    category = g.codes[r.status] || g.codes[String(r.status)] || "unknown";
  }
  results.push({
    name: g.name, note: g.note, code: r.status, ms, category, spawnErr,
    out: String(r.stdout || ""), err: String(r.stderr || ""),
  });
}

// ── 非 ok 的闸打全量输出——否则「哪道闸出了什么」得重跑一遍才知道 ─────────────────
for (const res of results) {
  if (res.category === "ok") continue;
  process.stdout.write(`\n──── 闸详情：${res.name}（exit ${res.code == null ? "?" : res.code}，判为 ${res.category}）────\n`);
  if (res.spawnErr) process.stdout.write(`[spawn 错误] ${res.spawnErr}\n`);
  process.stdout.write(res.out);
  if (res.err.trim()) process.stdout.write(`[stderr]\n${res.err}\n`);
}

// ── 汇总表 ───────────────────────────────────────────────────────────────────
const ICON = { ok: "✓", red: "✗", inconclusive: "⊘", unknown: "?" };
process.stdout.write("\n──── 闸门汇总表（判定以真退出码为准）────\n");
let okN = 0, redN = 0, inconclusiveN = 0, unknownN = 0;
for (const res of results) {
  if (res.category === "ok") okN++;
  else if (res.category === "red") redN++;
  else if (res.category === "inconclusive") inconclusiveN++;
  else unknownN++;
  const icon = ICON[res.category] || "?";
  process.stdout.write(`  ${icon} exit=${String(res.code == null ? "?" : res.code).padStart(2)}  ${String(res.category).padEnd(12)}  ${String(res.ms).padStart(6)}ms  ${res.name}\n`);
}
process.stdout.write(`  ── ${results.length} 道闸：${okN} ok / ${redN} red / ${inconclusiveN} inconclusive / ${unknownN} unknown\n`);
if (inconclusiveN) {
  process.stdout.write("  ⚠ inconclusive ≠ 通过：那几道闸「没查成」，不是「查过没事」——去读上面的闸详情。\n");
}
if (unknownN) {
  process.stdout.write("  ⚠ unknown：该闸的退出码不在它自己声明的已知集合里——分类表本身可能已经过期，先去核实。\n");
}

// ── 优先级：unknown(4) > red(1) > inconclusive(2) > ok(0) ───────────────────
let exitCode = EXIT_OK;
if (inconclusiveN > 0) exitCode = EXIT_INCONCLUSIVE;
if (redN > 0) exitCode = EXIT_RED;
if (unknownN > 0) exitCode = EXIT_UNKNOWN;

// 末行的 `fixture=` 字段（#260 件5）：注入口跑出来的那一行必须带 fixture=1、真跑 fixture=0——
// 否则「贴出来当证据」的汇总行分不出真跑还是假跑（几个无脑返回成功的假闸经注入口跑一遍，
// 那一行与真跑逐字节相同，证明不了自己是真跑）。
process.stdout.write(`DAO_GATES_SUMMARY exit=${exitCode} gates=${results.length} ok=${okN} red=${redN} inconclusive=${inconclusiveN} unknown=${unknownN}` + (fixturePath ? " fixture=1" : " fixture=0") + "\n");
process.exit(exitCode);
