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
//   · 🔴 **两个数之间原先没有基数下界**：它们只在「恰好等于 0」那一点上对话一次，平时互不约束
//     ⇒ 覆盖面缩水而没归零时会全静默。改小 `TEXT_EXT` / 放大 `SKIP_DIRS` / 改窄 `REF_RE` /
//     走 `scan()` 里那个 fail-open 的 `catch`，四发单行改动闸与回归网全绿（实测表见 PR #278
//     对抗判词第八节）。**这与拍板第 12 件「只查非空」是同一个病**。
//     **2026-08-13 补（issue #284 第 2 项，取「独立复核」而非「派生基线文件」处方）**：
//     `独立扫描面自检`（见下方 `walkAll` / `independentLitCount`）——完全不共用 `TEXT_EXT` /
//     `SKIP_DIRS`，只硬排 `.git`/`_tmp`，独立走一遍全仓、独立数一遍字面命中的文件数
//     `indepLit`。主扫描面数出的 `litfiles` 若小于 `indepLit`（零容差：结构上 `litfiles`
//     是 `indepLit` 的子集，健康态两者应相等，见 `main()` 里 `indepShrink` 那一行）⇒ 判定为
//     **扫描面缩水**，外加 `blindFiles`（字面命中却一条结构化引用都没抽出的文件，见
//     `structuredShapedHitFiles`）任一非空，同判 exit 6，不许被「文件缺失/锚点缺失都是 0」
//     盖成绿灯。
//     ⚠ **`indepLit`/`litfiles` 这一路管不到 `REF_RE` 本身收窄**（两者都不解析引用，只数字面），
//     那一路靠 `blindFiles`（`structuredShapedHitFiles` 对拍 `refFiles`）顶上——**实测验证过**：
//     把 `REF_RE` 的 `.(?:md|csv)` 砍成 `.(?:md)`，只引用 `.csv` 的文件会整份掉进 `blindFiles`
//     （2026-08-13 实测：4 个文件、refs 从 13 跌到 3，`blind=4`，仍判 exit 6）。
//     **`blindFiles` 是文件级不是引用级**——一份文件里既有 `.md` 引用也有 `.csv` 引用时，
//     `REF_RE` narrowing 只吃掉 `.csv` 那一半，`.md` 那一半仍在，该文件仍算「有结构化引用」，
//     不会被标为 blind。**这一发仍是本闸的已知盲区**，处方是 issue #284 第 2 项原议的
//     「refs/anchors/targets 做成派生物 + `--check`」，甲/乙/丙那格用户还没拍板，
//     **本闸这次不做**（同处方与 #272 第 12 件耦合，属于会改变后续改判据成本的取舍，
//     不该由 AI 自己定）。
//
// ── 已知不覆盖，照直写（别把它读成「档案层的指针从此都有人管」）───────────────
//   · **注释续行把指针拆开**（2026-08-10 PR #278 对抗判词第六节）：主解析逐字符扫原文、
//     不折叠换行，两种形态原本都漏检：㈠ 路径本身被拆两行（本行以 `docs/evolution/` 结尾、
//     档名在下一行）⇒ 整条引用不匹配；㈡ 路径在行尾而 `§` 锚点写在下一行 ⇒ 只匹配到文件
//     那一半、锚点全丢。**2026-08-13 已补折行容错**（issue #284 第 1 项，见 `scan()` 内
//     两段并列的「折行容错 ㈠/㈡」代码块）：解析主循环里/后各补扫一遍这两种形态，剥掉续行的
//     注释前缀（`//`/`#`/`;`/`--`/`*`）后重新核一次，命中数计入 marker 的 `folded=`。
//     **这仍是近似**：只追一层折行，不递归到第三行。㈡（锚点续行）要求本行匹配点到行尾之间
//     只剩空白才追，否则不追；㈠（路径续行）不做这个限制——续行本就可能是「档名 §锚点」一起写，
//     卡死「续行只准有档名」反而会漏掉这种更常见的形态。两个方向都举得出反例：真折行但中间
//     夹了行内注释符会漏补；续行开头凑巧是「一个不相关的词 + `.md`/`.csv`」时会被误当成档名
//     （㈠ 这一路目前不会因为后面还跟着别的文字就不追）。实测坐标（2026-08-10 全仓扫，
//     `tests/dao-secrets.tests.ps1`）：
//     `:1036` 属㈠、`:131` 属㈡，当天拼回同一行后 `refs=32 anchors=10` 变成 `33` 与 `18`
//     ——那两个数是**那一天的读数不是常量**，该份文件本身此后已被这批测试重设计整体删除，
//     不再是本仓当前的实测样本，仅作为折行确曾漏检的历史出处保留。
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
//     但**独立跑这道闸的人拿到的是一个撒谎的 0**。修法（去掉那个条件或换个判据）归 issue #284，
//     **本闸这次不改这一条**（不在本批选定的两项范围内，见 PR 正文取舍说明）。
//   6 🔴 **扫描面自检异常**（2026-08-13 新增，issue #284 第 2 项，`indepShrink`/`blindFiles`
//     任一非空即判）——与 5 不同：5 是「整套都瞎了」，6 是「配置把扫描面悄悄改小了，但还没
//     瞎到抽不出任何引用」。判据两路，均不复用 `TEXT_EXT`/`SKIP_DIRS`/`REF_RE`：
//     ㈠ `indepShrink`：独立遍历（只硬排 `.git`/`_tmp`）数出的「含字面文件数」比主扫描面的
//        `litfiles` 还多 ⇒ `TEXT_EXT` 收窄或 `SKIP_DIRS` 放大，有文件掉出了扫描面。
//     ㈡ `blindFiles`：笨计数器判定「含字面」的文件里，有文件一条结构化引用都没被主解析
//        抽出来 ⇒ `REF_RE` 收窄，或 `scan()` 读那份文件时静默 `catch` 掉了。
//     二者任一非空，即使 `missfile`/`missanchor` 都是 0，也不许判绿。
//
// 末行 marker：
//   ARCHIVE_POINTERS_SUMMARY exit=<n> scanned=<扫了几个文件> refs=<几处引用>
//     anchors=<几个锚点> targets=<几个不同的被指文件> missfile=<n> missanchor=<n>
//     litfiles=<笨计数器看见的文件数> hist=<几处 git show 历史引用被豁免>
//     folded=<折行容错额外拼回的引用数> indeplit=<独立遍历看见的文件数>
//     blind=<字面命中但结构化引用为 0 的文件数>
//   🔴 **`refs` / `anchors` 数的是「主解析看得见的」，不是「仓里真有的」**：射程外的那些
//     （上面「已知不覆盖」列的 glob / 相对路径 / 非 `§` 写法，以及 `REF_RE` 本身收窄时的
//     `blindFiles` 那一发）**既不在分子也不在分母**，marker 不会因为盲区变大而变小声。
//     把 `refs`/`anchors` 读成「仓里就这么多指针」，就把盲区读没了；`indeplit`/`blind`
//     两个数就是留给这个盲区的窗口，红了看这两个不是看 `refs`。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const EXIT_OK = 0, EXIT_DANGLING = 1, EXIT_USAGE = 3, EXIT_COLLAPSE = 5, EXIT_SHRINK = 6;

// 扫描面：文本类后缀 + 排除目录。排除的都是「不是本仓源码」的地方。
const TEXT_EXT = new Set([".md", ".js", ".mjs", ".cjs", ".ps1", ".psm1", ".json", ".py", ".sh", ".yml", ".yaml", ".txt", ".bat"]);
const SKIP_DIRS = new Set([".git", "node_modules", "_tmp", ".claude", "dist", "build", ".venv", "__pycache__"]);

// 主解析：仓相对的档案层路径 + 其后连续的 § 锚点。
const REF_RE = /docs\/evolution\/([A-Za-z0-9._-]+\.(?:md|csv))/g;
const ANCHOR_RE = /^[\s/、,，]*§\s*([A-Za-z0-9._-]+)/;
// 历史引用：紧挨在路径前面的 `<sha>:`，即 `git show 6c78843:docs/evolution/x.md` 那一形态。
const HIST_RE = /\b[0-9a-f]{7,40}:$/;
// 折行容错 ㈠ 专用：只咬续行开头的「档名.扩展名」那一段（锚点交给下面的 ANCHOR_RE 续扫）。
// 跟 REF_RE 是两个独立的正则对象，字符集特意保持一致纯粹是为了方便对拍，不是共享同一实现。
const FOLD_TARGET_RE = /^([A-Za-z0-9._-]+\.(?:md|csv))/;
// 续行的注释前缀：行首空白 + 常见注释记号（可重复，如 `// //`）+ 空白，剥掉后再核折行。
const CONT_PREFIX_RE = /^[ \t]*(?:\/\/|#|;|--|\*)+[ \t]*/;

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
// 🔴 返回值带上命中文件的相对路径集合（不只是个数）：main() 拿它跟主解析抽出的 refs
// 逐文件对拍，找出「字面在、结构化引用为 0」的文件（issue #284 第 2 项 ㈡，见头注退出码 6）。
function dumbCountFiles(repoRoot, files) {
  const LIT = "docs/" + "evolution/";
  const hitFiles = new Set();
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    let i = text.indexOf(LIT), hit = false;
    while (i >= 0) {
      const c = text.charCodeAt(i + LIT.length);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { hit = true; break; }
      i = text.indexOf(LIT, i + 1);
    }
    if (hit) hitFiles.add(path.relative(repoRoot, f).split(path.sep).join("/"));
  }
  return hitFiles;
}

// 「结构化引用本该抓到」的更严格判据：字面 + 紧跟字母，且**这段字符流到下一个空白/引号/
// 反引号/括号为止不含 `*`**——含 `*` 是本闸设计上就不匹配的 glob 提及（头注「已知不覆盖」段
// 「glob 形态看不见」那一条，本文件自己的头注、README 的表格行都是这种合法噪音，不是回归）。
// 还排掉**历史引用形态**（前面紧挨着 `<sha>:`）——这跟主解析的 `HIST_RE` 语义一致但**特意用
// 自己的正则对象**，不导入/复用 `HIST_RE` 这个绑定：`HIST_RE` 本身被改坏（issue #284 头注
// 退出码 5 段已知的那个 bug）是这批不修的范围，若这里也读同一个绑定，`HIST_RE` 改坏时两半会
// 一起被带偏——这正是「自检不许复用被守对象解析逻辑」要防的耦合。
// 这两条判据只用来收窄 blindFiles（`refFiles` 对拍那一半），不改 `litFiles`/`hitFiles` 的口径——
// 后者要跟塌陷判据（exit 5）的既有语义保持不变，改口径等于动了另一道判据的行为。
const HIST_LIKE_RE = /[0-9a-f]{7,40}:$/;
function hasStructuredShapedHit(text) {
  const LIT = "docs/" + "evolution/";
  let i = text.indexOf(LIT);
  while (i >= 0) {
    const c = text.charCodeAt(i + LIT.length);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      if (!HIST_LIKE_RE.test(text.slice(Math.max(0, i - 41), i))) {
        let j = i + LIT.length, sawStar = false;
        while (j < text.length && !/[\s`"')\]]/.test(text[j])) {
          if (text[j] === "*") { sawStar = true; break; }
          j++;
        }
        if (!sawStar) return true;
      }
    }
    i = text.indexOf(LIT, i + 1);
  }
  return false;
}

function structuredShapedHitFiles(repoRoot, files) {
  const out = new Set();
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    if (hasStructuredShapedHit(text)) out.add(path.relative(repoRoot, f).split(path.sep).join("/"));
  }
  return out;
}

// ── 扫描面自检 ㈠：完全独立于主扫描面的遍历（不共用 TEXT_EXT / SKIP_DIRS）──
// 只硬排 `.git`（不是仓内容）与 `_tmp`（回归网自己的合成语料落在这，不该被算进「真实覆盖」）。
// 这两个排除是本函数自己的字面量，跟上面 SKIP_DIRS 不是同一个绑定——SKIP_DIRS 被改窄或放大，
// 这里不动分毫，这正是「自检要能在主逻辑瞎掉时仍然看得见」要的效果（[#反-写守卫]）。
const INDEPENDENT_SKIP = new Set([".git", "_tmp"]);
const MAX_INDEPENDENT_BYTES = 2 * 1024 * 1024; // 超大文件多半是二进制/生成物，跳过防拖慢

function walkAll(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!INDEPENDENT_SKIP.has(e.name)) stack.push(p); continue; }
      if (e.isFile()) out.push(p);
    }
  }
  return out;
}

// 「算不算样本」的口径要跟 dumbCountFiles 对齐（紧跟 ASCII 字母才算，裸目录名 / glob 提及
// `docs/evolution/*` 不算——那是既有设计就刻意不算的噪音，见 dumbCountFiles 头注），
// 否则这里会把「文件列表变了」跟「口径本来就不一样」混成一件事，制造假红。
// 判断逻辑允许跟 dumbCountFiles 语义相同，但**遍历面必须是独立实现**（walkAll，不共用
// walk/TEXT_EXT/SKIP_DIRS）——两套自检要独立的是「TEXT_EXT/SKIP_DIRS 有没有被改窄」这个轴，
// 不是「什么算一个样本」这个轴。
function looksLikeHit(text) {
  const LIT = "docs/" + "evolution/";
  let i = text.indexOf(LIT);
  while (i >= 0) {
    const c = text.charCodeAt(i + LIT.length);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
    i = text.indexOf(LIT, i + 1);
  }
  return false;
}

function independentLitCount(root) {
  let n = 0;
  for (const f of walkAll(root)) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.size > MAX_INDEPENDENT_BYTES) continue;
    let buf;
    try { buf = fs.readFileSync(f); } catch { continue; }
    if (buf.includes(0)) continue; // 含 NUL 字节判二进制，本闸只管文本引用
    let text;
    try { text = buf.toString("utf8"); } catch { continue; }
    if (looksLikeHit(text)) n++;
  }
  return n;
}

// ── 折行容错：剥掉续行开头的注释前缀 ─────────────────────────────────────
function stripContPrefix(line) {
  return (line || "").replace(CONT_PREFIX_RE, "");
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
  let folded = 0;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    const relFile = path.relative(repoRoot, f).split(path.sep).join("/");
    const lines = text.split(/\r?\n/);
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
      const lineNo = lineOf(text, m.index);
      // ── 折行容错 ㈡：路径完整匹配到行尾（本行再没别的），§ 锚点被拆到下一行 ──
      // 只在「同行没抽到锚点」时才追下一行，且要求本行匹配点到行尾之间只剩空白——
      // 有别的字符就不追（近似手段，见头注「已知不覆盖」段的两个反例）。
      // 🔴 `rest` 切自原始 text，CRLF 文件里行尾多一个 `\r`；字符类必须显式含 `\r?`，
      // 否则本判据在 CRLF 上恒假、锚点续行永远追不到（2026-08-13 对抗审 PR #403 实证：
      // 本仓 201 个文本文件 196 个是 CRLF，回归网夹具全 LF，套件绿但真实工作树漏检）。
      if (!anchors.length) {
        const nl = rest.indexOf("\n");
        const restOnLine = nl >= 0 ? rest.slice(0, nl) : rest;
        if (/^[ \t]*\r?$/.test(restOnLine) && lineNo < lines.length) {
          let cursor = stripContPrefix(lines[lineNo]);
          let am2;
          while ((am2 = ANCHOR_RE.exec(cursor)) !== null) {
            anchors.push(am2[1]);
            cursor = cursor.slice(am2[0].length);
          }
          if (anchors.length) folded++;
        }
      }
      refs.push({ file: relFile, line: lineNo, target: m[1], anchors });
    }
    // ── 折行容错 ㈠：路径本身被拆两行（本行以字面 docs/evolution/ 结尾，档名在下一行）──
    // REF_RE 结构上不可能匹配到这种形态（字符类不含换行），故与上面的主循环不会重叠计数。
    for (let li = 0; li < lines.length - 1; li++) {
      if (!/docs\/evolution\/[ \t]*$/.test(lines[li])) continue;
      const nextStripped = stripContPrefix(lines[li + 1]);
      const fm = FOLD_TARGET_RE.exec(nextStripped);
      if (!fm) continue;
      const litIdx = lines[li].lastIndexOf("docs/evolution/");
      const before = lines[li].slice(Math.max(0, litIdx - 41), litIdx);
      if (HIST_RE.test(before)) { hist++; continue; } // `git show <sha>:` 紧挨在同一行时同样豁免
      let restAfterName = nextStripped.slice(fm[0].length);
      const anchors = [];
      let am3;
      while ((am3 = ANCHOR_RE.exec(restAfterName)) !== null) {
        anchors.push(am3[1]);
        restAfterName = restAfterName.slice(am3[0].length);
      }
      refs.push({ file: relFile, line: li + 1, target: fm[1], anchors });
      folded++;
    }
  }

  const litHitFiles = dumbCountFiles(repoRoot, files);
  const refFiles = new Set(refs.map((r) => r.file));
  const structuredHitFiles = structuredShapedHitFiles(repoRoot, files);
  // 本闸自己的源文件豁免：它的头注拿「历史引用」`git show 6c78843:docs/evolution/x.md`
  // 当例句（供 HIST_RE 那条规则参照），例句本身就该被 HIST_RE 判成历史引用而不产生结构化
  // ref——跟头注另一处已声明的 glob 例句同一类（本文件天然是「拿自己当例子」最密集的地方）。
  // 只豁免这一个文件：其余文件仍全额受检，不因为这条豁免而缩小真实覆盖。
  const SELF_PATH = "ccswitch/scripts/check-archive-pointers.mjs";
  const blindFiles = [...structuredHitFiles].filter((f) => f !== SELF_PATH && !refFiles.has(f)).sort();
  const indepLit = independentLitCount(repoRoot);

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
    folded,
    anchors: refs.reduce((n, r) => n + r.anchors.length, 0),
    targets: new Set(refs.map((r) => r.target)).size,
    problems,
    litFiles: litHitFiles.size,
    blindFiles,
    indepLit,
  };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.bad) {
    console.error(`用法错：${o.bad}`);
    console.error("  node ccswitch/scripts/check-archive-pointers.mjs [--repo <目录>] [--quiet]");
    console.log(`ARCHIVE_POINTERS_SUMMARY exit=${EXIT_USAGE} scanned=0 refs=0 anchors=0 targets=0 missfile=0 missanchor=0 litfiles=0 hist=0 folded=0 indeplit=0 blind=0`);
    process.exit(EXIT_USAGE);
  }
  const repoRoot = path.resolve(o.repo || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", ".."));
  const r = scan(repoRoot);
  const missfile = r.problems.filter((p) => p.kind === "missfile").length;
  const missanchor = r.problems.filter((p) => p.kind === "missanchor").length;
  const indepShrink = r.indepLit > r.litFiles;

  // 塌陷的判据是「笨计数器看得见样本，而主解析一条都抽不出来」。
  // 🔴 `hist === 0` 这一格让判据在 `hist > 0` 时失效：主解析可以一边丢掉全部活指针、一边还
  // 认得出一条历史引用，那时这里给的是 0 不是 5（头注「退出码」段 5 那一条有实测）。
  // 留着它的原句理由是「全是历史引用时主解析并没有瞎」—— 那句话只在**全瞎**时成立。修法归 #284。
  let code = EXIT_OK;
  if (r.refs.length === 0 && r.hist === 0 && r.litFiles > 0) code = EXIT_COLLAPSE;
  else if (r.problems.length) code = EXIT_DANGLING;
  else if (indepShrink || r.blindFiles.length) code = EXIT_SHRINK;

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
      if (r.folded > 0) console.log(`  折行容错额外拼回 ${r.folded} 条引用（近似手段，见头注）`);
    }
    if (code === EXIT_SHRINK) {
      console.log("\n🔴 **扫描面自检异常**：");
      if (indepShrink) console.log(`  · 独立遍历看见 ${r.indepLit} 个含字面文件，主扫描面只数到 ${r.litFiles} 个 —— TEXT_EXT/SKIP_DIRS 把文件排除出去了`);
      if (r.blindFiles.length) console.log(`  · ${r.blindFiles.length} 个文件含字面却一条结构化引用都没抽出：${r.blindFiles.join(" ")}`);
      console.log("  别把这次的绿当通过——扫描面比它以为的要小，先核 TEXT_EXT / SKIP_DIRS / REF_RE 有没有被改窄。");
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
  console.log(`ARCHIVE_POINTERS_SUMMARY exit=${code} scanned=${r.scanned} refs=${r.refs.length} anchors=${r.anchors} targets=${r.targets} missfile=${missfile} missanchor=${missanchor} litfiles=${r.litFiles} hist=${r.hist} folded=${r.folded} indeplit=${r.indepLit} blind=${r.blindFiles.length}`);
  process.exit(code);
}

const invokedDirect = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() ===
  path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).toLowerCase();
if (invokedDirect) main();
