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
// 跑法：node scripts/run-tests.mjs        （全绿 exit 0，任一红 exit 1）
//       node scripts/run-tests.mjs --list （只列清单不跑）

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TESTS_DIR = path.join(ROOT, "tests");

if (!fs.existsSync(TESTS_DIR)) {
  process.stderr.write(`[run-tests] 找不到 tests/ 目录：${TESTS_DIR}\n`);
  process.exit(2);
}

const entries = fs.readdirSync(TESTS_DIR).sort();
const jsTests = entries.filter((f) => f.endsWith(".tests.js"));
const psTests = entries.filter((f) => f.endsWith(".tests.ps1"));
// 既不是 .tests.js 也不是 .tests.ps1 的文件：可能是命名不合规的测试，宁可报出来让人看一眼
const strays = entries.filter((f) => !f.endsWith(".tests.js") && !f.endsWith(".tests.ps1"));

process.stdout.write(`[run-tests] tests/ 下发现 ${jsTests.length} 套 node 测试、${psTests.length} 套 PowerShell 测试\n`);
if (strays.length) {
  process.stdout.write(`  ⚠ 另有 ${strays.length} 个不符 *.tests.{js,ps1} 命名的文件，未纳入：${strays.join(", ")}\n`);
}

if (process.argv.includes("--list")) {
  for (const f of jsTests) process.stdout.write(`  node  tests/${f}\n`);
  for (const f of psTests) process.stdout.write(`  pwsh  tests/${f}\n`);
  process.exit(0);
}

const results = [];
for (const f of jsTests) {
  const t0 = Date.now();
  // cwd 钉在仓根，**不继承调用者的**（2026-08-04 实测：从别的仓的目录敲这个入口，
  // subagent-clauses 那套里一条依赖 process.cwd() 的断言会红，而同一份代码在仓根下全绿
  // ⇒ 红绿取决于你在哪个目录敲的命令，且失败信息里没有任何东西指向 cwd）。
  const r = spawnSync(process.execPath, [path.join(TESTS_DIR, f)], { encoding: "utf8", cwd: ROOT });
  const ms = Date.now() - t0;
  const out = String(r.stdout || "");
  // 从各测试自己的汇总行取断言数（格式统一为 `=== 汇总: PASS=n FAIL=m ===`）；
  // 取不到不当成通过，只标「未报计数」，判定仍以真退出码为准。
  const m = out.match(/PASS=(\d+)\s+FAIL=(\d+)/);
  results.push({
    file: f,
    code: r.status,
    pass: m ? Number(m[1]) : null,
    fail: m ? Number(m[2]) : null,
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
let totalPass = 0, totalFail = 0, bad = 0;
for (const r of results) {
  if (r.pass != null) { totalPass += r.pass; totalFail += r.fail; }
  if (r.code !== 0) bad++;
  const counts = r.pass != null ? `PASS=${String(r.pass).padStart(3)} FAIL=${r.fail}` : "（未报计数）";
  process.stdout.write(`  ${r.code === 0 ? "✓" : "✗"} exit=${String(r.code).padStart(2)}  ${counts}  ${String(r.ms).padStart(5)}ms  tests/${r.file}\n`);
}
process.stdout.write(`  ── ${results.length} 套 node 测试：${results.length - bad} 过 / ${bad} 红；断言合计 PASS=${totalPass} FAIL=${totalFail}\n`);
if (psTests.length) {
  process.stdout.write(`  ⓘ 另有 ${psTests.length} 套 PowerShell 测试需在 pwsh 里跑（本入口不代跑，不计入上面的过/红）：\n`);
  for (const f of psTests) process.stdout.write(`      .\\tests\\${f}\n`);
}

process.exit(bad ? 1 : 0);
