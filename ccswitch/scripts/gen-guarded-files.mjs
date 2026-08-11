#!/usr/bin/env node
// gen-guarded-files.mjs — 「被 mutation 守护的源文件」清单的生成 / 漂移校验
//
// ── 两个模式 ─────────────────────────────────────────────────────────────────
//   （缺省）生成    node ccswitch/scripts/gen-guarded-files.mjs
//   --check  漂移   测试实况变了而清单没跟上 ⇒ exit 1「清单过期」。**不写盘。**
//
// ── 治的是什么（issue #122 · 用户 2026-08-07 拍板的三件套之①）───────────────
// 「改守卫前先读写守卫判据」这条规则此前**只有一条读触发通道**（`ccswitch/rules/scoped/`
// 的 `paths:` glob，宿主在 **Read** 到匹配文件时注入）。回测实测两件事：
//   ㈠ 那份 glob 只覆盖被 mutation 守护文件的一小部分，**且恰好漏掉 issue #103 例 2
//      的当事文件** `ccswitch/templates/check-token-drift.mjs`；
//   ㈡ 那个文件近 11 天 **Read 0 次 / Edit·Write 7 次** —— 读触发对它**结构性失明**。
// ⇒ 主力通道改挂 **Edit/Write**（`dao-glob-gate.js` 的新分支），而这份清单是那个分支的判据。
//
// 🔴 **清单必须是派生物，这是本件的全部意义。** 手维护的清单会滞后，而 #122 的病根
// 正是「人工清单滞后且恰好漏掉事故文件」。做成派生物之后：
//   · 新守卫一进 mutation 测试网 ⇒ 下次生成即自动进清单（**不必有人记得**）；
//   · 一份测试的 mutation 被删掉 ⇒ 它守的文件自动**掉出**清单
//     （这就是 dao-guard-writing.md 第 4 条要的「给退役造触发器」——**这里是免费的**，
//      因为判据本身就是从测试实况算出来的，不是一份需要有人去删的名单）。
//
// ── 口径（照直写它是近似，两个方向都构造得出反例）─────────────────────────────
// 一个源文件进清单，要同时满足两件事：
//   ① **有一份含 mutation 的测试**：`tests/*.tests.{js,mjs}` 里出现 `.replace(`，
//      或 `tests/*.tests.ps1` 里出现 `-replace` / `.Replace(`。
//      ⚠ 这是**粗判**：`filePath.replace(/\\/g, "/")` 这种与 mutation 无关的用法同样命中
//      （偏松），而用别的手段做 mutation 的测试（整段重写文件、`splice` 行数组）判不出来
//      （偏紧）。回测报告 B.0 用的就是这个口径，本脚本沿用，**不自行收紧**——换口径会让
//      本清单与那份基线数据不可比。
//   ② **那份测试以仓根为基点声明了它**：`path.join|resolve(<仓根变量>, "ccswitch", …)`、
//      `require("../ccswitch/…")`、PS 的 `Join-Path $repoRoot 'ccswitch/…'`，
//      且落在 `ccswitch/{hooks,scripts,lib,templates}/` 之下、盘上真实存在、是文件不是目录。
//      **「以仓根为基点」这一条是刻意的**：测试里大量出现 `path.join(root, "ccswitch", …)`
//      形态的**夹具**写入（临时目录里造一棵假仓），把它们算进来会把一批只是被当作
//      注册串提到的 hook 也拖进清单 —— 实测两种口径差 **30 vs 33**。
//      判据是「首个参数是不是仓根变量」，见 ROOT_VAR。
//
// ── 已知漏报面（别把这份清单读成「被守护文件的全集」）───────────────────────
//   ㈠ 经 helper 传参、或用变量拼出来的路径追不到（同 check-mutation-anchor.mjs 头注 ㈡）。
//   ㈡ `ccswitch/` 之外的守卫（`scripts/`、`config-sync/`）不在扫描面内 —— 本批刻意只覆盖
//      dao 自有的 hook/script/lib/template 四类，那是 hybrid 通道当前的射程。
//   ㈢ 一个文件**有守卫但那份守卫不做 mutation**（如 `tests/dao-compact-log.tests.js`）
//      ⇒ 不进清单。这是口径的直接推论，不是 bug：本清单答的是「谁被 mutation 守着」。
//
// ── 自检：我是不是瞎了（dao-guard-writing.md 第 2 条）──────────────────────────
// 主解析读到 0 个源文件时，「本仓真的没有被 mutation 守护的文件」与「解析整个瞎掉」
// 输出一模一样。故另有一个**独立的、笨的**计数器 `countMutationTestsDumb()`：
// 纯子串计数，**刻意不复用主解析的任何一行**（不共享正则、不共享文件读取、不共享过滤）。
// 笨计数器看到 mutation 测试 > 0 而主解析一个源文件都没算出来 ⇒ exit 5，**不给绿灯**。
//
// 🔴 **它按定义只认「整段塌陷」，逮不住「部分失明」**（照直写，回归网 C2a 钉着这一格）：
// 把 JS 那一支打瞎、PS 支照旧 ⇒ 清单从 30 掉到几个，两个量都 > 0 ⇒ 自检 exit 0。
// 这一层真正的守卫是 `--check` 跑在**真仓**上：条数一变它就红。
// 别把「有自检」读成「扫描面这一层现在有人管了」——它管的是**全瞎**，不是**半瞎**。
//
// ── 输出落在自己的扫描面外（同上，第 3 条）────────────────────────────────────
// 扫描面是 `tests/`，产物是 `ccswitch/guarded-files.json` —— 两者不相交，
// 本脚本改不动自己的输入。（本脚本**自己**会出现在产物里，那是对的：
// `tests/guarded-files.tests.js` 对它做 mutation，它确实是被守护文件之一。）
//
// ── 产物不记「扫了几份测试」的计数（2026-08-11 · issue #300 方向 3）────────────
// `_generated.totals` 曾把 tests/mutation_tests/files 三个数写进产物 ⇒ 加一套**不含** mutation
// 的测试也让产物漂移（`--check` 红），而清单的实质内容（哪些源文件被守）根本没变 —— 收费点与
// 改动量无关，正是 issue #300 通篇在治的形态。现三个计数只在**末行**（每次跑都打，信息不丢），
// 产物只随实质内容变。判据：漂移 ⇔ 该有人看一眼；「多了套无关测试」不该有人看一眼。
//
// ── 末行契约（机器读这一行，别去正则匹配上面的中文）──────────────────────────
//   GUARDED_FILES_SUMMARY exit=<n> tests=<n> mutation_tests=<n> files=<n> drift=<none|missing|content> wrote=<0|1>
//   **每条路径都打印**（含失败路径）：只在成功时打摘要，等于让「没查成」在机器通道上
//   表现为「什么都没说」。新字段一律追加在末尾，消费方按字段名取值。
//
// 参数：--repo <根>（一次挪走扫描面/产物/路径解析三个默认值，回归网喂合成语料用）
//       --dir <tests 目录> · --out <产物路径> · --quiet（只打末行与违规明细）
// 退出码：0 干净 · 1 清单过期（--check）· 2 tests 目录不存在 · 5 扫描面塌陷（自检失败）
//
// 消费方：ccswitch/hooks/dao-glob-gate.js（Edit/Write 命中即注入一行指针）
// 回归网：tests/guarded-files.tests.js

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const TESTS_DIR = path.join(REPO_ROOT, "tests");
const DEFAULT_OUT_REL = "ccswitch/guarded-files.json";
export const REGEN_CMD = "node ccswitch/scripts/gen-guarded-files.mjs";

// 被覆盖的四类 dao 自有源目录（清单只收这些）。
const OWNED_DIRS = ["ccswitch/hooks/", "ccswitch/scripts/", "ccswitch/lib/", "ccswitch/templates/"];

// 「仓根变量」白名单：测试里用来指代仓库根的那些名字。夹具用的是 root / TmpRoot /
// REPO_A 之类，刻意不在表内 —— 这一格就是 30 与 33 的差别所在。
const ROOT_VAR = /^(REPO|ROOT|REPO_ROOT|repoRoot|RepoRoot|__dirname|PSScriptRoot)$/;

// ── 口径①：这份测试含 mutation 吗 ───────────────────────────────────────────
export function hasMutation(text, ext) {
  if (ext === "ps1") return /-replace/i.test(text) || /\.Replace\s*\(/.test(text);
  return /\.replace\s*\(/.test(text);
}

// ── 口径②：从测试正文里抽「以仓根为基点声明的被测对象路径」───────────────────
// 三种形态各写一个抽取器，**不合并成一个大正则**：合并之后任一形态写坏时，
// 症状是「清单少了几个文件」，而少几个与「本来就没有」不可区分。
function fromPathCall(text) {
  const out = [];
  for (const m of text.matchAll(/path\.(?:join|resolve)\(\s*([A-Za-z_$][\w$]*)\s*((?:,\s*["'][^"']*["']\s*)+)\)/g)) {
    if (!ROOT_VAR.test(m[1])) continue;
    const segs = [...m[2].matchAll(/["']([^"']*)["']/g)].map((x) => x[1]).filter((s) => s !== "..");
    if (segs[0] !== "ccswitch") continue;
    out.push(segs.join("/"));
  }
  return out;
}
function fromRequire(text) {
  const out = [];
  for (const m of text.matchAll(/(?:require|from)\s*\(?\s*["']([^"']*ccswitch\/[^"']*)["']/g)) {
    out.push(m[1].slice(m[1].indexOf("ccswitch/")));
  }
  return out;
}
function fromJoinPath(text) {
  const out = [];
  for (const m of text.matchAll(/Join-Path\s+\$(\w+)\s+["']([^"']*ccswitch[/\\][^"']*)["']/g)) {
    if (!ROOT_VAR.test(m[1])) continue;
    const s = m[2].split("\\").join("/");
    out.push(s.slice(s.indexOf("ccswitch/")));
  }
  return out;
}

// require("../ccswitch/lib/hook-budget") 不带扩展名 ⇒ 按 node 的解析顺序补一次。
// 两道门，**别把它们的功劳记混**（2026-08-07 订正：此处原举 `path.join(root, "ccswitch", "hooks")`
// 为 `.isFile()` 的例子，那是错的 —— 那个串挡在**上一行**的 OWNED_DIRS 上，因为
// `"ccswitch/hooks"` 不以 `"ccswitch/hooks/"`（带尾斜杠）开头，`.isFile()` 根本没轮到）：
//   · OWNED_DIRS 挡的是**四类目录本身与它们之外的一切**；
//   · `.isFile()` 挡的是**四类目录之下的子目录** —— 前缀过得了、盘上也 stat 得到，
//     只有「是文件吗」这一问拦得住它。真仓里这一格由 `ccswitch/templates/ISSUE_TEMPLATE`
//     兜着，回归网 §②/§⑦-E 另造了同形的合成样本（真仓那一侧是偶然，不该当判别力来源）。
function resolveOwnedFile(repoRoot, rel) {
  if (!OWNED_DIRS.some((d) => rel.startsWith(d))) return null;
  for (const cand of [rel, rel + ".js", rel + ".mjs", rel + ".cjs"]) {
    try {
      if (fs.statSync(path.join(repoRoot, cand)).isFile()) return cand;
    } catch (_) { /* 不存在就试下一个 */ }
  }
  return null;
}

/**
 * 扫一个 tests 目录，算出「被 mutation 守护的源文件 → 守它的测试」映射。
 * 导出是为了让回归网能直接喂合成语料（不必造一整棵仓）。
 */
export function scanGuarded({ repoRoot = REPO_ROOT, testsDir = TESTS_DIR } = {}) {
  const entries = fs.readdirSync(testsDir).sort();
  const map = new Map();
  let tests = 0;
  let mutationTests = 0;
  for (const f of entries) {
    const m = /\.tests\.(js|mjs|ps1)$/.exec(f);
    if (!m) continue;
    tests++;
    const text = fs.readFileSync(path.join(testsDir, f), "utf8");
    if (!hasMutation(text, m[1])) continue;
    mutationTests++;
    const cands = m[1] === "ps1"
      ? fromJoinPath(text)
      : [...fromPathCall(text), ...fromRequire(text)];
    for (const c of new Set(cands)) {
      const rel = resolveOwnedFile(repoRoot, c);
      if (!rel) continue;
      if (!map.has(rel)) map.set(rel, new Set());
      map.get(rel).add(f);
    }
  }
  const files = [...map.keys()].sort().map((file) => ({
    file,
    guards: [...map.get(file)].sort(),
  }));
  return { files, tests, mutationTests };
}

// ── 自检计数器：**刻意用最笨的方式**，不复用上面任何一行 ─────────────────────
// 整份文本里 `.replace(` / `-replace` 的**子串**出现次数（不走正则、不走扩展名分派、
// 自己 readdir）。主解析若整段瞎掉（正则写坏、readdir 过滤写反、抽取器全抛异常吞掉），
// 两个数会分岔，而只看主解析看不出任何异常。
function countMutationTestsDumb(testsDir) {
  let n = 0;
  for (const f of fs.readdirSync(testsDir)) {
    if (f.indexOf(".tests.") < 0) continue;
    let t;
    try { t = fs.readFileSync(path.join(testsDir, f), "utf8"); } catch (_) { continue; }
    if (t.indexOf(".replace(") >= 0 || t.indexOf("-replace") >= 0 || t.indexOf(".Replace(") >= 0) n++;
  }
  return n;
}

// ── 序列化 ───────────────────────────────────────────────────────────────────
export function serializeGuarded(scan) {
  const doc = {
    _generated: {
      这是什么: "被 mutation 测试守护的 dao 源文件清单。**派生物，不是真相源** —— 改这个文件不会改变任何行为。",
      真相源: "tests/ 下含 mutation 的那些测试所声明的被测对象路径（口径见生成器头注）。",
      谁在消费它: "ccswitch/hooks/dao-glob-gate.js —— Edit/Write 命中清单即注入一行「先读写守卫判据」的指针。",
      再生成: REGEN_CMD,
      漂移检查: REGEN_CMD + " --check（测试实况变了而清单没跟上 ⇒ exit 1）",
      生成器: "ccswitch/scripts/gen-guarded-files.mjs",
      回归网: "tests/guarded-files.tests.js",
      口径是近似的: "两个方向都构造得出反例（`.replace(` 粗判偏松、非字符串替换型 mutation 判不出偏紧、helper 传参的路径追不到）——细则见生成器头注。",
      为什么不记条数: "tests/mutation_tests/files 三个计数刻意不进产物（2026-08-11 · issue #300 方向 3）——它们是「扫了几份测试」的元信息，与清单的实质内容（哪些源文件被守）无关；记进来会让「加一套不含 mutation 的测试」也造成清单漂移（guarded-files --check 变红），而实质什么都没变。要看计数 ⇒ 每次运行的末行 GUARDED_FILES_SUMMARY 都带。",
    },
    files: scan.files,
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

// 比对**归一化后**的文本：本脚本以 LF 写出，而 `core.autocrlf=true` 的机器一 checkout
// 就把它变成 CRLF ⇒ 逐字节比会让「刚 clone 完」表现为「清单过期」。判据是内容，不是行尾。
function normalizeText(s) {
  return (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function summaryLine({ exit, tests, mutationTests, files, drift, wrote }) {
  return `GUARDED_FILES_SUMMARY exit=${exit} tests=${tests} mutation_tests=${mutationTests}` +
    ` files=${files} drift=${drift} wrote=${wrote}`;
}

// ── main ─────────────────────────────────────────────────────────────────────
function main(argv) {
  const write = (s) => process.stdout.write(s + "\n");
  const check = argv.includes("--check");
  const quiet = argv.includes("--quiet");
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? path.resolve(argv[i + 1]) : null;
  };
  // `--repo` 一个开关同时挪三个默认值（扫描面 / 产物 / 路径解析基点）——回归网喂合成语料
  // 时必须三者同时挪，只挪其中一个会让「盘上有没有这个文件」拿真仓去答，
  // 于是合成语料里的文件永远解析不出来、而症状是「清单是空的」。
  const repoRoot = arg("--repo") || REPO_ROOT;
  const testsDir = arg("--dir") || path.join(repoRoot, "tests");
  const target = arg("--out") || path.join(repoRoot, DEFAULT_OUT_REL);

  if (!fs.existsSync(testsDir)) {
    write(`✗ 扫描目录不存在：${testsDir}`);
    write(summaryLine({ exit: 2, tests: 0, mutationTests: 0, files: 0, drift: "missing", wrote: 0 }));
    return 2;
  }

  const scan = scanGuarded({ repoRoot, testsDir });
  const dumb = countMutationTestsDumb(testsDir);

  // 自检先于一切结论：塌陷时**不写盘也不给绿灯**（写盘会把一份空清单钉进仓里，
  // 而空清单会让消费方那条分支静默永不触发 —— 那正是本件在治的病的镜像）。
  if (dumb > 0 && scan.files.length === 0) {
    write(`✗ 扫描面塌陷：笨计数器看到 ${dumb} 份含 mutation 的测试，主解析一个被守护源文件都没算出来。`);
    write("  这不是「本仓没有被 mutation 守护的文件」，是本脚本瞎了。别把这次的 0 当通过。");
    write(summaryLine({ exit: 5, tests: scan.tests, mutationTests: scan.mutationTests, files: 0, drift: "missing", wrote: 0 }));
    return 5;
  }

  const text = serializeGuarded(scan);

  if (check) {
    if (!fs.existsSync(target)) {
      write(`✗ 清单不存在：${target}`);
      write(`  ⇒ 修法：${REGEN_CMD}`);
      write(summaryLine({ exit: 1, tests: scan.tests, mutationTests: scan.mutationTests, files: scan.files.length, drift: "missing", wrote: 0 }));
      return 1;
    }
    const onDisk = normalizeText(fs.readFileSync(target, "utf8"));
    if (onDisk === normalizeText(text)) {
      if (!quiet) {
        write(`OK：清单与测试实况一致（${scan.mutationTests}/${scan.tests} 份测试含 mutation · 守护 ${scan.files.length} 个源文件）`);
        write("     它证不了的：清单**里**的那些 mutation 有没有判别力（那是对抗验证官的活），");
        write("     也证不了口径外的守卫（helper 传参 / 非字符串替换型 mutation）—— 见生成器头注「已知漏报面」。");
      }
      write(summaryLine({ exit: 0, tests: scan.tests, mutationTests: scan.mutationTests, files: scan.files.length, drift: "none", wrote: 0 }));
      return 0;
    }
    // 漂移了：**逐条报出差在哪**。只说「过期了」会让读者去 diff 一份 JSON，
    // 而这份 JSON 的每一行都是机器算出来的 —— 人该看的是「哪个文件进/出了清单」。
    let before = { files: [] };
    try { before = JSON.parse(onDisk); } catch (_) { /* 盘上那份坏了，下面按空清单报 */ }
    const oldSet = new Set((before.files || []).map((x) => x.file));
    const newSet = new Set(scan.files.map((x) => x.file));
    const added = [...newSet].filter((f) => !oldSet.has(f));
    const removed = [...oldSet].filter((f) => !newSet.has(f));
    write("✗ 清单过期：与测试实况不一致");
    for (const f of added) write(`   · 新进清单：${f}（有测试开始对它做 mutation 了）`);
    for (const f of removed) write(`   · 掉出清单：${f}（守它的 mutation 没了 —— 是有意退役，还是被顺手删掉了？）`);
    if (!added.length && !removed.length) {
      write("   · 文件集合没变，变的是每个文件**由哪些测试守着**（或元信息）——差异在 guards 列表里。");
    }
    write(`   ⇒ 修法：${REGEN_CMD}`);
    write("     ✓ 这条命令一定解得掉：清单是纯派生物，重跑即与测试实况对齐，且幂等。");
    write(summaryLine({ exit: 1, tests: scan.tests, mutationTests: scan.mutationTests, files: scan.files.length, drift: "content", wrote: 0 }));
    return 1;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
  if (!quiet) {
    write(`✓ 已写 ${path.relative(repoRoot, target).split(path.sep).join("/") || target}`);
    write(`   扫 ${scan.tests} 份测试 · 其中 ${scan.mutationTests} 份含 mutation · 守护 ${scan.files.length} 个源文件`);
    for (const e of scan.files) write(`   · ${e.file}  ←  ${e.guards.join(" / ")}`);
  }
  write(summaryLine({ exit: 0, tests: scan.tests, mutationTests: scan.mutationTests, files: scan.files.length, drift: "none", wrote: 1 }));
  return 0;
}

// 被 import 时不跑 main（回归网要直接调 scanGuarded / hasMutation）。
const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stdout.write(`✗ 未预期的失败：${e && e.stack ? e.stack : String(e)}\n`);
    process.stdout.write(summaryLine({ exit: 1, tests: 0, mutationTests: 0, files: 0, drift: "missing", wrote: 0 }) + "\n");
    process.exit(1);
  }
}
