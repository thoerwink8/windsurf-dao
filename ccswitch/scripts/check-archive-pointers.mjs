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
//   · 笨计数器 > 0 而主解析抽出 0 条引用 ⇒ **扫描面塌陷**，exit 5，绝不静默当成"全对"。
//   · 两边都是 0 ⇒ 合法的零样本，exit 0，**但明说「本次零样本」**——
//     零样本与"全都对"在退出码上是同一个值，不打印出来就分不开。
//
// ── 已知不覆盖，照直写（别把它读成「档案层的指针从此都有人管」）───────────────
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
//   5 扫描面塌陷（笨计数器看得见样本而主解析抽出 0 条 —— 本次压根没查成）
//
// 末行 marker：
//   ARCHIVE_POINTERS_SUMMARY exit=<n> scanned=<扫了几个文件> refs=<几处引用>
//     anchors=<几个锚点> targets=<几个不同的被指文件> missfile=<n> missanchor=<n>
//     litfiles=<笨计数器看见的文件数> hist=<几处 git show 历史引用被豁免>

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
  // 历史引用（hist）算样本 —— 全是历史引用时主解析并没有瞎，只是这棵树上没有活指针。
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
