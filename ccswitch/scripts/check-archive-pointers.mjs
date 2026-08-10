// check-archive-pointers.mjs — 指着档案层的指针，被指的那份还在不在
//
// ── 治的是什么病（issue #262 ㈢，用户 2026-08-10 拍板第 4 件）─────────────────
// PR #251 把四份代码文件里的事故编年史搬进 `docs/evolution/comment-archive-*.md`，
// 于是盘上多了 5 处代码指着那一份档案。对抗官做过一个实验：**把那份档整个挪出工作树**，
// 然后跑闸 —— `dao-smoke` exit 0、`gen-clause-index --check` exit 0、
// `run-tests` 默认层 `exit=2 red=0`，**一个都没红**。
// ⇒ 那份档被误删 / 改名 / 下一批合并档时被顺手换掉，这几个指针会一起指向空气，
//   而且**没有任何东西会出声**。条款 `[#官通-同批查引用]` 那句「留一个指向空气的指针比没有
//   指针更糟」的完整形态，只不过这次是**指针方还活着、被指方会消失**。
//
// ── 射程：为什么是 `docs/evolution/` 整层，不是只护刚出事的那一份 ────────────
// `[#反-写守卫]`：建护栏前先摸全域分布。实测本仓指着 `docs/evolution/` 的引用散在
// rules / hooks / lib / tests / docs / TODO 六类文件里，被指的有归档档、事故叙事档、
// 条款论证史、两份教训 CSV —— **刚出事的那一份只是其中一层**。故扫描面是整个
// `docs/evolution/`，判据与文件名无关。
//
// ── 它查两件事 ──────────────────────────────────────────────────────────────
//   ① **那个文件在不在**：`docs/evolution/<名>.md|.csv` 形态的引用，逐条 stat。
//   ② **§ 后面那个锚点在不在**：写成 `docs/evolution/<档名>.md §C3` 时，去那份档里找
//      `## C3 · …` 这样的标题行；多段写 `§C1/§C2`，路径后**连续**的 § 锚点都算数。
//      （这一行的 `<档名>` 是刻意的：写个假文件名当例子，本闸**会当场把自己的头注判红**——
//        它不豁免自己，本文件就在它自己的扫描面里。首版写了 `x.md` 当例子，第一次跑就红了。）
//   缺任一即 exit 1，并逐条点名「哪个文件的第几行、指的是什么、缺的是文件还是锚点」。
//
// ── 自检半边：不复用主解析（`[#反-写守卫]`「数到 0 和没看到样本输出一模一样」）──
// 主解析用正则抽引用；自检用一个**笨计数器**：`indexOf` 找字面 `docs/evolution/`
// 且下一个字符是 ASCII 字母（不用正则，不共用任何一行代码）。
//   · 笨计数器 > 0、主解析抽出 0 条引用、**且历史引用 `hist` 也是 0** ⇒ **扫描面塌陷**，exit 5。
//     第三个条件是判据的一部分不是修饰，它有代价，见下面「退出码」段 5 那一条。
//   · 两边都是 0 ⇒ 合法的零样本，exit 0，**但明说「本次零样本」**——
//     零样本与"全都对"在退出码上是同一个值，不打印出来就分不开。
//   · 🔴 **两个数之间没有基数下界**：它们只在「恰好等于 0」那一点上对话一次，平时互不约束
//     ⇒ **覆盖面缩水而没归零时全静默**。改小 `TEXT_EXT` / 放大 `SKIP_DIRS` / 改窄 `REF_RE` /
//     走 `scan()` 里那个 fail-open 的 `catch`，四发单行改动闸与回归网全绿（实测表见 PR #278
//     对抗判词第八节）。**这与拍板第 12 件「只查非空」是同一个病**，修法（把 refs/anchors/
//     targets 做成派生物 + `--check`）归 issue #284，**本闸眼下不查基数**。
//
// ── 已知不覆盖，照直写（别把它读成「档案层的指针从此都有人管」）───────────────
//   · 🔴 **注释续行把指针拆开 ⇒ 整条看不见**（2026-08-10 PR #278 对抗判词第六节；本闸首版
//     就有这个洞，头注此前没声明）。主解析逐字符扫原文、**不折叠换行**，于是两种形态漏检：
//     ㈠ 路径本身被拆两行（本行以 `docs/evolution/` 结尾、档名在下一行）⇒ **整条引用不匹配**；
//     ㈡ 路径在行尾而 `§` 锚点写在下一行 ⇒ **只匹配到文件那一半，该条的锚点全丢**。
//     中文注释里折行是写长句的常态，不是边角案例。实测坐标（2026-08-10 全仓扫，两处都落在
//     `tests/dao-secrets.tests.ps1`）：`:1036` 属㈠、`:131` 属㈡；把它们拼回同一行 ⇒ 本闸
//     自报的 `refs=32 anchors=10` 变成 **33 与 18**，即**当天 8 个锚点（44%）在射程外**。
//     ⚠ 那两个数是**那一天的读数不是常量**，且扫折行本身也是近似手段、不构成穷尽证明。
//     **具体的害**：归档档下次改名时闸会点名 9 处、漏掉这 2 处，修完那 9 处闸转绿，而这 2 处
//     静静指着空气 —— 正是本闸要治的病躲在自己的绿灯后面。修法归 issue #284。
//   · **锚点集合是逐行 `^#{1,6}\s+` 扫出来的，不区分是不是在代码围栏里**：被归档的那些以 `#`
//     开头的代码注释会一并被认成锚点 ⇒ 写成 `§M1` / `§T1` 这类指针会被判「锚点存在」，而那些
//     名字恰是被归档的变体名（最可能被人当锚点写的那批字）。实测（2026-08-10，月粒度归档档）：
//     认出 118 个 id，真锚点只有 7 个 `C1`–`C7`。⇒ **锚点这一半是 false-accept 偏松的近似。**
//   · **不核 sha**：归档档里「迁出于 commit `<sha>`」那个 sha 解不解析得开，本闸不查
//     （要给它加 git 依赖）。一个打错的 sha 仍是静默的死指针。
//   · **不核内容**：文件在、锚点在，不代表锚点底下那段还是原来那段。
//   · **glob 形态看不见**：`docs/evolution/comment-archive-*.md` 这种带通配符的写法不匹配
//     （`*` 不在文件名字符集里），故它既不被检查也不会误报。本文件头注里就有一处，是刻意的。
//   · **只认仓相对写法**：`../evolution/<档名>.md` 这类相对路径不匹配。
//   · **`git show <sha>:<路径>` 形态刻意豁免**（marker 里单独计 `hist=`，不静默）：那种写法
//     指名的是**某个历史提交里的树**，不是工作树 —— 一份被有意删掉的档，正确的回查方式就是它，
//     判它红等于逼人把死掉的文件留在盘上。代价照直写：**那条路径当年存不存在，本闸不核**。
//   · **§ 后面必须紧跟锚点**：中文行文里 § 另作他用时会被当成锚点检查 —— 这是近似手段，
//     两个方向都构造得出反例（漏判：换个符号写指针；误判：§ 被挪作它用）。
//
// 跑法：
//   node ccswitch/scripts/check-archive-pointers.mjs            # 全绿 exit 0
//   node ccswitch/scripts/check-archive-pointers.mjs --repo <d> # 换一棵树扫（回归网用）
//   node ccswitch/scripts/check-archive-pointers.mjs --quiet    # 只打末行 marker
//
// 退出码（本文件头注是唯一真相源）：
//   0 全绿（含"合法零样本"，那一态另有一行显式打印）
//   1 有指针指向空气（文件不在 / 锚点不在）
//   3 用法错（不认识的参数，一条都没扫）
//   5 扫描面塌陷（笨计数器看得见样本 + 主解析抽出 0 条 + **`hist` 也是 0**，三个条件都要）
//     🔴 **`hist > 0` 时它不判 5，照直写**：那个 `&& r.hist === 0` 的行内理由（「全是历史引用
//     时主解析并没有瞎」）在主解析**部分**瞎掉时不成立 —— 它可以一边丢掉全部活指针、一边还
//     认得出一条历史引用。实测（PR #278 对抗判词第七节）：`REF_RE` 的字符类去掉一个 `-` ⇒
//     `refs=0 litfiles=19 hist=1`，**退出码是 0 不是 5**。回归网那一侧会红 6 条，所以危害有限，
//     但**独立跑这道闸的人拿到的是一个撒谎的 0**。修法（去掉那个条件或换个判据）归 issue #284。
//
// 末行 marker：
//   ARCHIVE_POINTERS_SUMMARY exit=<n> scanned=<扫了几个文件> refs=<几处引用>
//     anchors=<几个锚点> targets=<几个不同的被指文件> missfile=<n> missanchor=<n>
//     litfiles=<笨计数器看见的文件数> hist=<几处 git show 历史引用被豁免>
//   🔴 **`refs` / `anchors` 数的是「主解析看得见的」，不是「仓里真有的」**：射程外的那些
//     （上面「已知不覆盖」列的折行 / glob / 相对路径 / 非 `§` 写法）**既不在分子也不在分母**，
//     marker 不会因为盲区变大而变小声。把这两个数读成「仓里就这么多指针」，就把盲区读没了。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const EXIT_OK = 0, EXIT_DANGLING = 1, EXIT_USAGE = 3, EXIT_COLLAPSE = 5;

// 扫描面：文本类后缀 + 排除目录。排除的都是「不是本仓源码」的地方。
const TEXT_EXT = new Set([".md", ".js", ".mjs", ".cjs", ".ps1", ".psm1", ".json", ".py", ".sh", ".yml", ".yaml", ".txt", ".bat"]);
const SKIP_DIRS = new Set([".git", "node_modules", "_tmp", ".claude", "dist", "build", ".venv", "__pycache__"]);

// 主解析：仓相对的档案层路径 + 其后连续的 § 锚点。
const REF_RE = /docs\/evolution\/([A-Za-z0-9._-]+\.(?:md|csv))/g;
const ANCHOR_RE = /^[\s/、,，]*§\s*([A-Za-z0-9._-]+)/;
// 历史引用：紧挨在路径前面的 `<sha>:`，即 `git show 6c78843:docs/evolution/x.md` 那一形态。
const HIST_RE = /\b[0-9a-f]{7,40}:$/;

function parseArgs(argv) {
  const o = { repo: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--quiet") o.quiet = true;
    else if (a === "--repo") { o.repo = argv[++i]; if (!o.repo) return { bad: "--repo 后面要跟一个目录" }; }
    else if (a.startsWith("--repo=")) o.repo = a.slice(7);
    else return { bad: `不认识的参数：${a}` };
  }
  return o;
}

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(p); continue; }
      if (!e.isFile()) continue;
      if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
    }
  }
  return out.sort();
}

// 笨计数器：不共用上面任何一行解析。找字面 `docs/evolution/` 且紧跟一个 ASCII 字母。
// （紧跟字母这一条是为了不把本文件里那个正则源码 / 裸目录名算成样本。）
function dumbCountFiles(files) {
  const LIT = "docs/" + "evolution/";
  let n = 0;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    let i = text.indexOf(LIT), hit = false;
    while (i >= 0) {
      const c = text.charCodeAt(i + LIT.length);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { hit = true; break; }
      i = text.indexOf(LIT, i + 1);
    }
    if (hit) n++;
  }
  return n;
}

function lineOf(text, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function headingIds(mdText) {
  const ids = new Set();
  for (const raw of mdText.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(\S+)/.exec(raw);
    if (m) ids.add(m[1]);
  }
  return ids;
}

export function scan(repoRoot) {
  const files = walk(repoRoot);
  const refs = [];
  let hist = 0;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    REF_RE.lastIndex = 0;
    let m;
    while ((m = REF_RE.exec(text)) !== null) {
      // `git show <sha>:<路径>` ⇒ 指的是历史树，不判死指针，但单独记数不静默
      if (HIST_RE.test(text.slice(Math.max(0, m.index - 41), m.index))) { hist++; continue; }
      // 路径之后连续的 §锚点全收（`… .md §C1/§C2`）
      const anchors = [];
      let rest = text.slice(m.index + m[0].length, m.index + m[0].length + 240);
      let am;
      while ((am = ANCHOR_RE.exec(rest)) !== null) {
        anchors.push(am[1]);
        rest = rest.slice(am[0].length);
      }
      refs.push({
        file: path.relative(repoRoot, f).split(path.sep).join("/"),
        line: lineOf(text, m.index),
        target: m[1],
        anchors,
      });
    }
  }

  const anchorCache = new Map();
  const problems = [];
  for (const r of refs) {
    const abs = path.join(repoRoot, "docs", "evolution", r.target);
    let ok = false;
    try { ok = fs.statSync(abs).isFile(); } catch { ok = false; }
    if (!ok) {
      problems.push({ kind: "missfile", ...r, why: `docs/evolution/${r.target} 不在盘上` });
      continue;
    }
    if (!r.anchors.length) continue;
    if (!anchorCache.has(r.target)) {
      let ids = new Set();
      try { ids = headingIds(fs.readFileSync(abs, "utf8")); } catch { /* 读不了 ⇒ 空集，下面逐条报 */ }
      anchorCache.set(r.target, ids);
    }
    const ids = anchorCache.get(r.target);
    for (const a of r.anchors) {
      if (!ids.has(a)) problems.push({ kind: "missanchor", ...r, anchor: a, why: `${r.target} 里没有标题 “${a}”` });
    }
  }

  return {
    scanned: files.length,
    refs,
    hist,
    anchors: refs.reduce((n, r) => n + r.anchors.length, 0),
    targets: new Set(refs.map((r) => r.target)).size,
    problems,
    litFiles: dumbCountFiles(files),
  };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.bad) {
    console.error(`用法错：${o.bad}`);
    console.error("  node ccswitch/scripts/check-archive-pointers.mjs [--repo <目录>] [--quiet]");
    console.log(`ARCHIVE_POINTERS_SUMMARY exit=${EXIT_USAGE} scanned=0 refs=0 anchors=0 targets=0 missfile=0 missanchor=0 litfiles=0 hist=0`);
    process.exit(EXIT_USAGE);
  }
  const repoRoot = path.resolve(o.repo || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", ".."));
  const r = scan(repoRoot);
  const missfile = r.problems.filter((p) => p.kind === "missfile").length;
  const missanchor = r.problems.filter((p) => p.kind === "missanchor").length;

  // 塌陷的判据是「笨计数器看得见样本，而主解析一条都抽不出来」。
  // 🔴 `hist === 0` 这一格让判据在 `hist > 0` 时失效：主解析可以一边丢掉全部活指针、一边还
  // 认得出一条历史引用，那时这里给的是 0 不是 5（头注「退出码」段 5 那一条有实测）。
  // 留着它的原句理由是「全是历史引用时主解析并没有瞎」—— 那句话只在**全瞎**时成立。修法归 #284。
  let code = EXIT_OK;
  if (r.refs.length === 0 && r.hist === 0 && r.litFiles > 0) code = EXIT_COLLAPSE;
  else if (r.problems.length) code = EXIT_DANGLING;

  if (!o.quiet) {
    console.log(`── 档案层指针体检（扫 ${r.scanned} 个文本文件，扫描面 = 仓内除 ${[...SKIP_DIRS].join("/")} 之外）──`);
    if (r.refs.length === 0 && r.hist === 0 && r.litFiles === 0) {
      console.log("⚠ **本次零样本**：一个 docs/evolution/ 引用都没扫到。");
      console.log("  零样本与「全都对」在退出码上是同一个值 —— 这一行就是用来把它们分开的。");
    } else if (code === EXIT_COLLAPSE) {
      console.log(`🔴 **扫描面塌陷**：笨计数器在 ${r.litFiles} 个文件里看得见 docs/evolution/ 字面，`);
      console.log("  而主解析抽出 0 条引用 ⇒ 不是本仓很干净，是它瞎了。别把这次的 0 当通过。");
    } else {
      console.log(`  引用 ${r.refs.length} 处 · 锚点 ${r.anchors} 个 · 被指文件 ${r.targets} 份 · 笨计数器 ${r.litFiles} 个文件`);
      console.log(`  另有 ${r.hist} 处 \`git show <sha>:…\` 历史引用**未核**（指的是历史树不是工作树，见头注）`);
    }
    if (r.problems.length) {
      console.log("\n🔴 指向空气的指针：");
      for (const p of r.problems) {
        console.log(`  · ${p.file}:${p.line}  →  ${p.why}`);
      }
      console.log("\n修法二选一：把被指的东西放回去（改名了就改指针），或者把指针一起删掉。");
      console.log("**留一个指向空气的指针比没有指针更糟** —— 读者以为那里有兜底（`[#官通-同批查引用]`）。");
    }
  }
  console.log(`ARCHIVE_POINTERS_SUMMARY exit=${code} scanned=${r.scanned} refs=${r.refs.length} anchors=${r.anchors} targets=${r.targets} missfile=${missfile} missanchor=${missanchor} litfiles=${r.litFiles} hist=${r.hist}`);
  process.exit(code);
}

const invokedDirect = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() ===
  path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).toLowerCase();
if (invokedDirect) main();
