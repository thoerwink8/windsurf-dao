// repro-fixture-isolation.mjs — issue #82 的复现脚本 + 常驻回归网
//
// ── 它证明什么、不证明什么 ───────────────────────────────────────────────────
// 证明：**同一份测试在多个「工作树」里并行跑时，会不会因为共用机器级固定名夹具而互染**。
// 不证明：那份测试本身的判据对不对（那是它自己的事），也不证明串行跑得过——
//         串行跑得过是本脚本的**前置条件**，见下面的对照组 A。
//
// ── 为什么要造沙箱，而不是直接并行跑 tests/dao-rule-echo.tests.js ────────────
// 直接在同一个目录里并行起 N 份，会同时撞上两条互染通道：
//   ① 机器级：`~/.claude/rules/zz-test-fixture-*.md`（issue #82 报的那条，跨 worktree 也撞）
//   ② 仓内级：`tests/.fixtures-scope/`（同一棵树内并行才撞，换棵树就各是各的）
// 两条一起响，红了也说不清是哪条。故本脚本给每个子进程造一个**独立沙箱**（各有自己的
// `__dirname`），把 ② 天然隔开，**只留 ① 共用** —— 这正是「多棵 worktree 并行」的真实形态。
//
// ── 沙箱怎么造（刻意不拷贝被测对象）──────────────────────────────────────────
//   <sandbox>/tests/<被测文件>            ← 每次运行从真文件重新拷贝（不会变成悄悄过期的旧代码）
//   <sandbox>/ccswitch/hooks/*.js         ← **两行 shim**，转调真文件绝对路径
//   <sandbox>/ccswitch/lib/*.js           ← 同上
// 被测的 hook 一个字节都没复制 ⇒ 不存在「沙箱里跑的是旧 hook」这种静默失效。
// shim 是**双模**的：被 `node <shim>` 直接跑时用 `Module._load(real, null, true)` 把真文件
// 装成 main（`require.main === module` 在真文件里仍为真），被 `require` 时才走 `module.exports`。
// 单模 shim（只 `require`）会悄悄改掉带入口守卫的模块的行为 —— 本仓 `ccswitch/lib/` 下现有
// 2 个文件正是这种（首版脚本用静态正则拦它们，实测那是**误伤**：rule-echo 压根不跑 lib，
// 静态判据答不了「这次会不会真的被当入口跑」，故改判为下面的经验判据 A′）。
//
// ── 四个对照组（缺一个，红/绿都读不出意思）──────────────────────────────────
//   A′ 沙箱等价：**真位置串行跑一次** vs **沙箱内串行跑一次**，退出码与 PASS/FAIL 计数必须
//      逐字相同。这条替代了首版那个静态正则守卫 —— 它直接量「沙箱里跑的和真的是不是同一件事」，
//      而不是猜；shim 若哪天不成立，这里当场红（出处：守卫节「自检那一半要能在主逻辑瞎掉时
//      仍然看得见」——它走的是另一次独立执行，不复用 shim 的任何判断）。
//   A  基线是活的：A′ 的两次都必须全绿。红了 ⇒ exit 2「无从归因」，不许读成「互染」
//      （出处：官抗节「比较基线必须先验证其本身是活的」）。
//   B  检测器不是瞎的：`--selfcheck` 喂一个必然失败的合成子进程，确认聚合器真会判红。
//      只会报绿的检测器和「没有互染」长得一模一样。
//   C  残留检查：跑前跑后各扫一次 `~/.claude/rules/` 的文件名集合，**只报不删**。
//
// ── 本脚本自己的输出落在哪（防自指）────────────────────────────────────────
// 沙箱一律落 `<repo>/tests/.repro-sandboxes/`（已 gitignore），**不落 `~/.claude/rules/`**
// ——那是它的扫描面，报告落进扫描面会让「跑一次多命中一批」看起来像问题在恶化。
// 为什么不是 dao 默认的 `_tmp/`：见下方 SANDBOX_BASE 处的说明（被测 hook 把 `_tmp` 判为排除面）。
//
// ── 已知射程边界，照直写 ─────────────────────────────────────────────────────
//   · 它只能证明「这一次并行跑撞上了」。并行 bug 是概率性的，**绿一次不等于没有**；
//     issue #82 的关闭条件因此写的是「并行双进程同跑 20 次零互染」，不是跑一次。
//   · 它测不到「测试之间的互染」（A 测试写的东西影响 B 测试）——本脚本每轮只跑同一个文件。
//   · shim 只铺 `ccswitch/hooks` 与 `ccswitch/lib` 两层。被测文件若引用 `ccswitch` 下别的
//     子目录（rules/ scripts/ templates/ …），沙箱里会找不到 —— 那时对照组 A′ 会红，于是
//     exit 2「无从归因」，**不会被误报成互染**。实测例：`tests/dead-gates.tests.js`
//     （真位置 PASS=116 vs 沙箱 PASS=20/FAIL=63，它要 `ccswitch/scripts/check-dead-gates.mjs`）
//     ⇒ **这一类测试本网给不出裁决，别把 exit 2 读成「查过了，没问题」。**
//   · 它只覆盖**「写共享位置」**这一种互染。**还有一种它结构上看不见**：测试自己什么都不写，
//     却对**别人拥有的**机器级可变状态做不变量断言（dead-gates 的「cc-switch DB 跑前跑后
//     mtime/size 不变」「live settings 里零死闸」都是）。那种红由第三方（GUI 应用、主仓里
//     另一个官的写入）触发，跟本网并发几路毫无关系 —— 调高并发数一辈子也复现不出来。
//
// 跑法：
//   node scripts/repro-fixture-isolation.mjs -t tests/xxx.tests.js   # `-t` 必填：原默认目标
//                                                                   # tests/dao-rule-echo.tests.js
//                                                                   # 已随 PR #307（归宿表类 C）退役
//   node scripts/repro-fixture-isolation.mjs -c 2 -r 20 -t tests/xxx.tests.js  # issue #82 的关闭条件
//   node scripts/repro-fixture-isolation.mjs --selfcheck            # 对照组 B（不需 -t）
//
// 🔴 2026-08-11（PR #307 之后）：「灭提示型/辅助类测试」把本脚本的唯一原生目标
//   tests/dao-rule-echo.tests.js 整套删掉（归宿表类 C）。实测留守 16+2 套里没有一个能被
//   本沙箱（hooks+lib 两层）装载——A′ 等价对照组全部 exit 2「无从归因」。本脚本因此从
//   「常驻回归网」退化为 **opt-in 谐架**：默认目标已不存在，`-t` 改为必填；将来若有新的
//   夹具互染型测试，用它重挂。
//
// 退出码：0 零互染 · 1 检测到互染（或有残留） · 2 基线不活/无从归因 · 3 用法或环境错误

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const RULES_DIR = path.join(os.homedir(), ".claude", "rules");

// 下面那条诊断提示要报「哪些目录名会让被测 hook 静默」。**刻意不在这里抄一份清单**：
// 这个列表在本仓已经有两份（hook 的 `EXCLUDE` + 测试自己那份独立副本，两份由测试里的
// 字面对账夹住），再抄第三份就是纯漂移源——PR #263 对抗实测点名了这一处散文副本。
// 改为运行时从 hook 源码里把那条字面**读出来**：读不到就指路，绝不猜也绝不留旧值。
// 这里只读文本、只打印，不把它 new RegExp 回去当判据使（那才是复用被守对象的解析）。
function excludeLiteralOfHook() {
  try {
    const src = fs.readFileSync(path.join(REPO, "ccswitch", "hooks", "dao-rule-echo.js"), "utf8");
    const m = /^const EXCLUDE = (\/.*\/[a-z]*);\s*$/m.exec(src);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

// ── 参数 ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  // `-t` 必填（原默认目标 tests/dao-rule-echo.tests.js 已随 PR #307 归宿表类 C 退役，
  // 默认指向一个不存在的文件比没有默认更糟）。--selfcheck 例外，见下面校验顺序。
  const o = { concurrency: 6, rounds: 3, test: null, keep: false, selfcheck: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-c" || a === "--concurrency") o.concurrency = Number(argv[++i]);
    else if (a === "-r" || a === "--rounds") o.rounds = Number(argv[++i]);
    else if (a === "-t" || a === "--test") o.test = argv[++i];
    else if (a === "--keep") o.keep = true;
    else if (a === "--selfcheck") o.selfcheck = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else { o.bad = a; }
  }
  return o;
}
const opts = parseArgs(process.argv.slice(2));
if (opts.help) { process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n") + "\n"); process.exit(0); }
if (opts.bad) { process.stderr.write(`[repro] 不认识的参数：${opts.bad}\n`); process.exit(3); }
if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) { process.stderr.write("[repro] --concurrency 需 >=1 的整数\n"); process.exit(3); }
if (!Number.isInteger(opts.rounds) || opts.rounds < 1) { process.stderr.write("[repro] --rounds 需 >=1 的整数\n"); process.exit(3); }

if (!opts.test && !opts.selfcheck) {
  process.stderr.write("[repro] 需要 -t <tests/xxx.tests.js>：原默认目标 tests/dao-rule-echo.tests.js 已随 PR #307（归宿表类 C）退役，不再有默认。\n");
  process.exit(3);
}
const TEST_ABS = opts.test ? path.resolve(REPO, opts.test) : null;
if (TEST_ABS && !fs.existsSync(TEST_ABS)) { process.stderr.write(`[repro] 找不到被测文件：${TEST_ABS}\n`); process.exit(3); }

// ── 对照组 B：检测器不是瞎的 ────────────────────────────────────────────────
// 喂一个必然失败的合成子进程，确认「聚合器判红」这条路真的通。
// 只会报绿的检测器与「没有互染」在输出上完全不可区分 —— 这一步就是把二者分开。
if (opts.selfcheck) {
  const tmp = path.join(REPO, "_tmp", `repro-selfcheck-${process.pid}.js`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, 'console.log("  FAIL  合成失败项（对照组 B）");\nconsole.log("\\n=== 汇总: PASS=0 FAIL=1 ===");\nprocess.exit(1);\n', "utf8");
  const r = spawnSync(process.execPath, [tmp], { encoding: "utf8" });
  fs.rmSync(tmp, { force: true });
  const red = r.status !== 0;
  const namedFails = collectFails(r.stdout || "");
  const ok = red && namedFails.length === 1 && namedFails[0].includes("合成失败项");
  process.stdout.write(`[repro --selfcheck] 合成红子进程 exit=${r.status}，捞到 FAIL 行 ${namedFails.length} 条：${JSON.stringify(namedFails)}\n`);
  process.stdout.write(ok ? "[repro --selfcheck] ✓ 聚合器能判红，检测器不是瞎的\n" : "[repro --selfcheck] ✗ 聚合器没能判红 —— 本脚本此刻的任何「绿」都不可信\n");
  process.exit(ok ? 0 : 1);
}

// ── 沙箱 ────────────────────────────────────────────────────────────────────
const RUN_ID = `${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
// 🔴 沙箱**不能**放 `_tmp/`（dao 默认的临时产物位置），也不能放 `_scratch/`：
// 被测 hook 的 EXCLUDE 正则把这两个前缀连同 node_modules/dist/build/… 一并判为「不是生效中的
// 规则文件」⇒ 放进去，被测路径会一律不命中，测试退化成一句永远为真的废话（这正是
// dao-rule-echo.tests.js 自己在 P2 段注释里写过的坑，本脚本首版原样重演了一遍，
// 由对照组 A′ 当场量出「真位置 PASS=65 vs 沙箱 PASS=55」才发现）。
// 故落 `tests/` 下（与该测试自己的 `.fixtures-scope` 同一层级，已 gitignore）。
//
// ⚠️ 2026-08-10（issue #253）分工订正 —— **别把这一行读成「排除面问题由这里挡着」**：
// 它只管**相对**落点。`REPO` 本身是从 `import.meta.url` 长出来的，**整棵树坐落在哪，沙箱
// 就坐落在哪** ⇒ 把树 checkout 到 `<x>/_tmp/wt/` 之下，沙箱照样落进排除面，这一行拦不住。
// 那一格曾由**被测文件自己**兜（`dao-rule-echo.tests.js` 的 `pickFixtureRoot()`：夹具落点
// 命中排除面就退到系统临时目录；该测试文件已于 2026-08-11 随 PR #307 归宿表类 C 退役）。
// 本脚本这一侧**刻意不再复制那份判据**——两份会漂移，而
// 兜底本来就在下面的对照组 A/A′：树摆错地方时它给的是 exit 2「无从归因」，不是假绿。
// 实测（2026-08-10，树 = `<repo>/_tmp/verify253-excluded`）：修被测文件之前 exit 2
//（真位置与沙箱同为 PASS=55 FAIL=10）；修好之后 exit 0，A′ 两侧同为 PASS=70 FAIL=0。
const SANDBOX_BASE = path.join(REPO, "tests", ".repro-sandboxes", RUN_ID);

const SHIM_DIRS = [["ccswitch", "hooks"], ["ccswitch", "lib"]];

function realJsFiles() {
  const out = [];
  for (const seg of SHIM_DIRS) {
    const d = path.join(REPO, ...seg);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith(".js") || f.endsWith(".mjs")) out.push([seg, f, path.join(d, f)]);
  }
  return out;
}

function makeSandbox(tag) {
  const root = path.join(SANDBOX_BASE, tag);
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  const testCopy = path.join(root, "tests", path.basename(TEST_ABS));
  fs.copyFileSync(TEST_ABS, testCopy); // 每次重拷，副本不会悄悄过期
  for (const [seg, f, abs] of realJsFiles()) {
    const dir = path.join(root, ...seg);
    fs.mkdirSync(dir, { recursive: true });
    // 双模 shim：当入口跑时把真文件装成 main（保住 `require.main === module` 语义），
    // 被 require 时才导出。单模（只 require）会静默改掉带入口守卫的模块的行为。
    const shim =
      `const R = ${JSON.stringify(abs)};\n` +
      `if (require.main === module) { process.argv[1] = R; require("module")._load(R, null, true); }\n` +
      `else { module.exports = require(R); }\n`;
    fs.writeFileSync(path.join(dir, f), shim, "utf8");
  }
  return { root, testCopy };
}

// ── 子进程执行与结果解析 ────────────────────────────────────────────────────
function collectFails(out) {
  const names = [];
  for (const line of String(out).split(/\r?\n/)) {
    // 分隔符是「两空格 + → + 两空格」（各测试的 check() 统一这么打）。
    // 用 `\s+→\s+` 会把断言名自己带的单空格「→」当成分隔符，把名字截半 —— 实测踩过。
    const m = line.match(/^\s*FAIL\s{2}(.+?)(?:\s{2}→\s{2}|$)/);
    if (m) names.push(m[1].trim());
  }
  return names;
}

function runChild(testPath) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [testPath], { encoding: "utf8" });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => {
      const m = out.match(/PASS=(\d+)\s+FAIL=(\d+)/);
      resolve({ code, ms: Date.now() - t0, out, err, pass: m ? Number(m[1]) : null, fail: m ? Number(m[2]) : null, fails: collectFails(out) });
    });
  });
}

function snapshotRules() {
  if (!fs.existsSync(RULES_DIR)) return [];
  return fs.readdirSync(RULES_DIR).sort();
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
process.stdout.write(`[repro] issue #82 夹具互染复现网\n`);
process.stdout.write(`  被测文件   ${path.relative(REPO, TEST_ABS).replace(/\\/g, "/")}\n`);
process.stdout.write(`  并发 × 轮次 ${opts.concurrency} × ${opts.rounds}（共 ${opts.concurrency * opts.rounds} 次子进程执行）\n`);
process.stdout.write(`  沙箱根     ${SANDBOX_BASE}\n`);
process.stdout.write(`  共用面     ${RULES_DIR}（机器级，这是唯一刻意不隔离的东西）\n\n`);

const before = snapshotRules();
process.stdout.write(`[repro] 跑前 ~/.claude/rules/ 有 ${before.length} 个文件：${before.join(", ") || "（空）"}\n\n`);

let exitCode = 0;
try {
  // ── 对照组 A / A′：基线是活的 + 沙箱与真位置等价 ──────────────────────────
  // 两次都串行、互不重叠，任何一次红或两次不一致 ⇒ exit 2「无从归因」，不许读成「互染」。
  const real = await runChild(TEST_ABS);
  const ctl = makeSandbox("control-serial");
  const box = await runChild(ctl.testCopy);
  process.stdout.write(`[repro] 对照组 A（串行基线，各 1 次）\n`);
  process.stdout.write(`        真位置  exit=${real.code} PASS=${real.pass} FAIL=${real.fail} ${real.ms}ms\n`);
  process.stdout.write(`        沙箱内  exit=${box.code} PASS=${box.pass} FAIL=${box.fail} ${box.ms}ms\n`);
  if (real.code !== 0 || box.code !== 0) {
    process.stdout.write(`\n${(real.code !== 0 ? real : box).out}\n${(real.code !== 0 ? real : box).err}\n`);
    process.stdout.write("[repro] ✗ 串行基线就红了 ⇒ 无从归因：并行红也可能只是这个测试本身坏了。\n");
    process.stdout.write("[repro]   （出处：官抗节「比较基线必须先验证其本身是活的」——假基线比没有基线更危险）\n");
    // 已知会走到这一支的一类原因，写出来省下一次从零诊断（前两任各在这里丢过一次会话）：
    process.stdout.write(`[repro]   本次这棵树：${REPO}\n`);
    process.stdout.write("[repro]   已知诱因之一（issue #253）：这棵树若坐落在被 dao-rule-echo hook 判为排除面的\n" +
                         "[repro]   目录名**下面**，被测 hook 会把夹具判成「非规则文件」而静默 ⇒ 真位置与沙箱一起\n" +
                         "[repro]   红同样的条数。\n" +
                         `[repro]   那份目录名清单（本次现读自源码，不在这里抄第二遍）：${excludeLiteralOfHook() || "读不出来 ⇒ 见 ccswitch/hooks/dao-rule-echo.js 的 EXCLUDE"}\n` +
                         "[repro]   分辨法：把同一份代码 checkout 到一个不含这些目录名的路径再跑一次，绿了就是它。\n");
    process.exit(2);
  }
  if (real.pass !== box.pass || real.fail !== box.fail) {
    process.stdout.write("[repro] ✗ 对照组 A′ 不等价：沙箱跑出的断言数与真位置不同 ⇒ 沙箱没在测同一件事。\n");
    process.stdout.write(`[repro]   真位置 PASS=${real.pass}/FAIL=${real.fail} vs 沙箱 PASS=${box.pass}/FAIL=${box.fail}\n`);
    process.exit(2);
  }
  process.stdout.write(`[repro] ✓ A 基线是活的，A′ 沙箱与真位置等价（同为 PASS=${real.pass} FAIL=${real.fail}）\n\n`);

  // ── 并行 ────────────────────────────────────────────────────────────────
  let totalRuns = 0, redRuns = 0;
  const failTally = new Map();
  for (let r = 1; r <= opts.rounds; r++) {
    const boxes = [];
    for (let i = 0; i < opts.concurrency; i++) boxes.push(makeSandbox(`r${r}-wt${i}`));
    const results = await Promise.all(boxes.map((b) => runChild(b.testCopy)));
    const reds = results.filter((x) => x.code !== 0);
    totalRuns += results.length;
    redRuns += reds.length;
    for (const x of reds) for (const n of x.fails) failTally.set(n, (failTally.get(n) || 0) + 1);
    const codes = results.map((x) => x.code).join(",");
    process.stdout.write(`  轮 ${String(r).padStart(2)}/${opts.rounds}  ${reds.length ? "✗" : "✓"}  ${results.length - reds.length}/${results.length} 绿   exit=[${codes}]\n`);
    if (reds.length) {
      for (const x of reds) {
        process.stdout.write(`        └ exit=${x.code} PASS=${x.pass} FAIL=${x.fail} —— ${x.fails.join(" | ") || "（无 FAIL 行，见 stderr）"}\n`);
        if (x.fails.length === 0 && x.err.trim()) process.stdout.write(`          stderr: ${x.err.trim().slice(0, 400)}\n`);
      }
    }
  }

  process.stdout.write(`\n[repro] 并行合计 ${totalRuns} 次，红 ${redRuns} 次（${((redRuns / totalRuns) * 100).toFixed(1)}%）\n`);
  if (failTally.size) {
    process.stdout.write("[repro] 被染红的断言（按次数）：\n");
    for (const [n, k] of [...failTally.entries()].sort((a, b) => b[1] - a[1])) process.stdout.write(`        ${String(k).padStart(3)}×  ${n}\n`);
  }
  if (redRuns > 0) exitCode = 1;

  // ── 对照组 C：残留 ──────────────────────────────────────────────────────
  const after = snapshotRules();
  const added = after.filter((f) => !before.includes(f));
  const removed = before.filter((f) => !after.includes(f));
  process.stdout.write(`\n[repro] 跑后 ~/.claude/rules/ 有 ${after.length} 个文件\n`);
  if (added.length) { process.stdout.write(`  ✗ 多出 ${added.length} 个（本脚本只报不删，请人工确认）：${added.join(", ")}\n`); exitCode = 1; }
  if (removed.length) { process.stdout.write(`  ✗ 少了 ${removed.length} 个（有测试删了不属于自己的东西）：${removed.join(", ")}\n`); exitCode = 1; }
  if (!added.length && !removed.length) process.stdout.write("  ✓ 文件名集合与跑前逐字相同\n");

  process.stdout.write(
    exitCode === 0
      ? `\n[repro] ✓ 零互染（${totalRuns} 次并行全绿 + 无残留）。注意：并行 bug 是概率性的，绿一次不等于没有。\n`
      : `\n[repro] ✗ 检测到互染 —— 见上面被染红的断言 / 残留清单。\n`
  );
} finally {
  if (!opts.keep) {
    try { fs.rmSync(SANDBOX_BASE, { recursive: true, force: true }); } catch (_) {}
    // 连空的父目录一起收走：`tests/` 下任何非 `*.tests.{js,ps1}` 的条目都会被
    // run-tests.mjs 报成「不符命名的文件」。留个空壳等于给每次全量跑加一行噪音。
    // rmdir 而非 rmSync：**别人还在跑时目录非空，此处必须失败** —— 那正是我们要的。
    try { fs.rmdirSync(path.dirname(SANDBOX_BASE)); } catch (_) {}
  }
  else process.stdout.write(`\n[repro] --keep：沙箱保留在 ${SANDBOX_BASE}\n`);
}
process.exit(exitCode);
