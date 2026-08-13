// 共性 rule 备案清单 · 加载 + 校验 + 求值
//
// ── 为什么有这个文件 ─────────────────────────────────────────────────────────
// 「共性 rule」此前散在三处，各自有各自的失效形态：
//   ① 硬编码在 dao-scaffold-check.js 里（加一条要改代码 ⇒ 没人加）
//   ② 写成 dao.md 的「首次接触项目时静默执行」文字条款（无标记时刻的自由裁量，
//      本仓 2026-07-26 遵守率实测该形态携带率 9-24% ⇒ 注定漏做）
//   ③ 只躺在 stacks/README.md 目录表里，没有任何触发点（frontend-ui-testing.md
//      到 2026-07-27 才被发现是九个处方里唯一没有强制执行链的）
// 三者的共同解是同一个：**把「检查什么」外部化成数据清单，把「何时检查」焊死在
// SessionStart hook 上**。加共性项 = 往 JSON 加一条，不改代码、不加条款。
//
// ── 本文件不做什么（避免被误当成万能校验器）───────────────────────────────
// 判据只覆盖**文件/目录存在性、package.json 键位、行数、子串包含**这几类机器可判形态。
// 需要语义理解的检查（「这算不算前端项目」「这个 rule 写得对不对」「design/ 资产结构
// 是否自洽」）**不在此列**，仍归 dao-project-scaffold skill 的 supporting files。
// noFileMatching 这类基于子串的内容判据是**启发式近似**，两个方向都构造得出反例
// （含 `if:` 但不是收敛条件的 workflow 会被放过；把 `if:` 写在别处的会被放过），
// 故其条目一律 severity=info，不当硬判定用。
//
// ── 2026-07-27：`exempt` 字段（例外显式化 > 例外隐形）─────────────────────────
// 条目可带 `exempt: [{repo, why}]`，命中的仓库跳过该条。它替换掉的是 hook 里
// 「仓名 === windsurf-dao 就整体 done()」那个早退——那种整体豁免的后果是**检查从不
// 跑到立法者头上，所以没人发现它自己违规**（实测元仓库自身会中两条，其中一条有个
// 从未写下来的例外）。逐条 exempt 之后，「哪些规则有例外、为什么」变成清单里可读的
// 数据，下次有人想删那个文件时会先看到理由。
// **匹配判据是项目根目录的 basename，不是 remote URL**（近似）：换个目录名 clone 的
// 同一仓库匹配不上、于是照报——失败方向选的是「多报」而不是「少报」，因为漏掉一条
// 该报的缺项是静默的，多报一条只是噪音且当场可辨。两个方向都构造得出反例。
//
// ── 2026-07-27：第四类 `product-type`（用户拍板）─────────────────────────────
// 要解的中间态：像「PR 必附真机证据」这种——**对所有产品型项目合理，对内部工具/基建
// 项目不合理**。它既不是 universal（会对一堆内部仓常态误报），也不是纯个性（每个产品型
// 项目都该有，个性化的只是具体证据形式）。
// 判定**不引入需要 AI 判断的条件**：按项目 `CLAUDE.md` 里的**自我声明**识别（子串
// 「产品型项目」），即 opt-in。理由——「这算不算产品型项目」是语义判断，正是本文件
// 头注列为"不在此列"的那一类；换成一句写在 CLAUDE.md 里的自陈之后，判据退回纯子串
// 匹配，机器可判且可审（谁声明的、在哪一行，都查得到）。
// **近似与失败方向**：没写那四个字的产品型项目一律不查（漏报），写了那四个字的内部
// 工具仓会被查（误报，但那是它自己声明的）。这里选**漏报侧**，与 `exempt` 的"多报"
// 取舍相反且是有意的：exempt 漏掉一条该报的缺项是静默的，而 product-type 条目对不
// 适用的仓是纯噪音，噪音会训练人忽略整个 hook 的输出。
// product-type 条目**不得带 when**（与 universal 同规则）：类别本身即条件，再叠一层
// 自定义条件会让「为什么这条没报」变成两处判据的合取，排查成本翻倍。需要再收窄的
// 场合请写成 conditional，并把产品型指纹显式写进 when。
//
// ── 2026-08-02：负向声明也要有机器可读形态（三仓自上而下审计第 2 件）─────────
// 上面那套只定义了「是」怎么写。**「不是」原先的写法是「把那一行删掉」** ⇒ 在机器侧
// 「答了，不是」与「从没答过」**逐字节相同**，于是 ①成文于该机制之前的存量项目对那一档
// 检查结构上永不触发 ②没有任何东西能把这道题投递到它们面前（提醒谁？所有没写那五个字的
// 仓？那里面绝大多数是已经答过「不是」的）。故补一个负向串 `PRODUCT_TYPE_NEGATIVE_WHEN`，
// 与清单条目 `product-type-answered`（universal · info）配套：**两个串都不在 ⇒ 这道题没答**。
//
// **两个串必须互不为子串**，这是本设计唯一的硬约束（回归网：tests/scaffold-manifest.tests.js）。
// 反例就在眼前：「非产品型项目」「不是产品型项目」这类**自然的否定写法整段含着正向串**，
// 判据是纯子串 ⇒ 会被读成「是」。故负向串取「内部工具型项目」（与正向零重叠），并在骨架
// 与报文里明写「原样抄，别自己造否定句」。**这一向本层挡不住**：写了否定句的项目会被
// 判成产品型，而它看起来完全正常。未做检测器是有意的——全生态实测零实例，
// 不为假想敌立判据（同 mousse-cli dispatch-clauses.md 既定政策）。
//
// **为什么负向串不参与 product-type 的开关判定**（即 evaluate 里只查 PRODUCT_TYPE_WHEN）：
// 那一档的语义是「声明为产品型才查」，负向串的作用只是把「答过」这件事变得可见。
// 两个串同时在场时按「是」处理——正向优先，判据只看正向那串在不在，与本文件此前的行为一致。
//
// ── 2026-08-01：`template` 字段（缺项报文的终点不该是「AI 现场重写一份」）─────
// 审计实证：缺项报文大多以「运行 /dao-project-scaffold」「参考 stacks/xxx.md」收尾 ——
// 那个终点是**让下一个 AI 现场重新发明一份**，于是同一个共性 rule 在每个项目里长得都不一样，
// 而「文件名契约」保证的只是名字相同、内容各自漂移。更糟的一条：pr-evidence 那条报文原文写着
// 「从 mousse-cli CLAUDE.md §二.5 派生」——**真相源指向另一个项目的文件**，违 dao-first。
// 修法：条目可带 `template: {src, dest}`，src 指 ccswitch/templates/ 下的**真文件或真目录**，
// 求值命中缺项时报文自动追加一条**零编辑可执行的复制指令**（绝对路径，粘贴即可跑）。
//
// 三条机器闸（缺一，这个字段就会变成新的「指向空气的指针」）：
//   ① src 必须在 templates/ 下**真实存在** —— 在 validate() 里查，于是 load() 那一刻就报，
//      不必等到某个项目恰好缺这一项时才现形。
//   ② dest 与 require 必须**指同一个东西**：require 是简单 {file:X}/{dir:X} 时 dest 必须等于 X。
//      两者漂移的后果是「报文教你把文件复制到 A，而闸查的是 B」⇒ 照做之后闸仍然红，
//      而人会以为是闸坏了。
//   ③ src 是目录还是文件由**求值时的实际 stat** 决定，不由清单写死 —— 清单说文件而盘上是目录
//      （或反之）时，写死的那个会生成一条跑不通的指令，而跑不通的指令没人会回来改清单。
// **不做的事**：本字段只生成**指令文本**，绝不自己动手复制。SessionStart hook 静默改用户项目
// 里的文件是另一个量级的授权，不在这里开这个口子。
//
// 真相源：windsurf-dao/ccswitch/lib/scaffold-manifest.js

"use strict";

const fs = require("fs");
const path = require("path");
const { pickPwsh } = require("./pwsh.js");

const CLASSES = ["universal", "conditional", "product-type"];
const SEVERITIES = ["warn", "info"];

// canonical 模板根。唯一定义处 —— 校验（查 src 在不在）与求值（拼绝对路径）都读它。
const TEMPLATES_ROOT = path.join(__dirname, "..", "templates");

// product-type 类别的内建条件（唯一定义处，清单里不重复写）。
const PRODUCT_TYPE_WHEN = { fileContains: { path: "CLAUDE.md", text: "产品型项目" } };

// 「答了，不是」的机器可读形态（2026-08-02，判据与两个串的硬约束见头注）。
// **它不参与 product-type 的开关判定**，只让「答过」这件事在机器侧可见；
// 消费方是清单条目 `product-type-answered`（那里按值写死，本常量与它的一致性由测试钉住）。
const PRODUCT_TYPE_NEGATIVE_WHEN = { fileContains: { path: "CLAUDE.md", text: "内部工具型项目" } };

// 谓词种类。每个谓词节点是一个对象，**恰好带一个种类键**，外加可选的 "label"
// （label 用于让报文说出「是哪一路信号命中的」，如 Tauri vs Electron）。
const LEAF_KINDS = ["file", "dir", "dep", "pkgScript", "glob", "findFile", "maxLines", "fileContains", "noFileMatching"];
const COMBINATORS = ["anyOf", "allOf", "not"];
const ALL_KINDS = LEAF_KINDS.concat(COMBINATORS);

// findFile 的遍历边界：不设边界的递归扫描会在 monorepo/大仓上把 SessionStart 拖慢。
// 越界的后果是**漏报不是误报**（探不到就当没命中），这是有意选的失败方向。
const FIND_SKIP_DIRS = new Set([
  ".git", "node_modules", "target", "dist", "build", "out", "vendor",
  ".next", ".nuxt", ".venv", "venv", "__pycache__", "_tmp", ".turbo", "coverage",
]);
const FIND_MAX_DIRS = 500;

// ── 校验 ────────────────────────────────────────────────────────────────────

function predErrors(node, at) {
  const errs = [];
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return [at + " 不是谓词对象"];
  }
  const kinds = Object.keys(node).filter((k) => k !== "label");
  if (kinds.length !== 1) {
    return [at + " 必须恰好带一个谓词种类键（当前：" + (kinds.join(",") || "无") + "）"];
  }
  const kind = kinds[0];
  if (!ALL_KINDS.includes(kind)) {
    return [at + " 谓词种类 " + kind + " 非法（合法值：" + ALL_KINDS.join("/") + "）"];
  }
  if (node.label !== undefined && typeof node.label !== "string") {
    errs.push(at + ".label 必须是字符串");
  }
  const v = node[kind];
  switch (kind) {
    case "file": case "dir": case "dep": case "pkgScript": case "glob":
      if (typeof v !== "string" || !v) errs.push(at + "." + kind + " 必须是非空字符串");
      break;
    case "findFile":
      if (!v || typeof v.name !== "string" || !v.name) errs.push(at + ".findFile.name 必须是非空字符串");
      else if (v.maxDepth !== undefined && !(Number.isInteger(v.maxDepth) && v.maxDepth > 0)) errs.push(at + ".findFile.maxDepth 必须是正整数");
      break;
    case "maxLines":
      if (!v || typeof v.path !== "string" || !v.path) errs.push(at + ".maxLines.path 必须是非空字符串");
      else if (!Number.isInteger(v.n) || v.n <= 0) errs.push(at + ".maxLines.n 必须是正整数");
      break;
    case "fileContains":
      if (!v || typeof v.path !== "string" || !v.path) errs.push(at + ".fileContains.path 必须是非空字符串");
      else if (typeof v.text !== "string" || !v.text) errs.push(at + ".fileContains.text 必须是非空字符串");
      break;
    case "noFileMatching":
      if (!v || typeof v.glob !== "string" || !v.glob) errs.push(at + ".noFileMatching.glob 必须是非空字符串");
      else {
        if (v.contains !== undefined && !Array.isArray(v.contains)) errs.push(at + ".noFileMatching.contains 必须是数组");
        if (v.notContains !== undefined && !Array.isArray(v.notContains)) errs.push(at + ".noFileMatching.notContains 必须是数组");
      }
      break;
    case "anyOf": case "allOf":
      if (!Array.isArray(v) || v.length === 0) { errs.push(at + "." + kind + " 必须是非空数组"); break; }
      v.forEach((c, i) => errs.push.apply(errs, predErrors(c, at + "." + kind + "[" + i + "]")));
      break;
    case "not":
      errs.push.apply(errs, predErrors(v, at + ".not"));
      break;
  }
  return errs;
}

// require 是「简单存在性谓词」时返回它查的那个路径，否则 null。
// 只认 {file:X} / {dir:X} —— 组合谓词（anyOf/allOf/not）没有唯一的"该复制到哪"，
// 那种条目就不该带 template（校验会因 dest 对不上而报，见下）。
function simpleRequirePath(node) {
  if (!node || typeof node !== "object") return null;
  if (typeof node.file === "string") return node.file;
  if (typeof node.dir === "string") return node.dir;
  return null;
}

function templateErrors(t, req, at, templatesRoot) {
  const errs = [];
  if (!t || typeof t !== "object" || Array.isArray(t)) return [at + ".template 必须是 {src, dest} 对象"];
  if (typeof t.src !== "string" || !t.src) errs.push(at + ".template.src 必须是非空字符串（ccswitch/templates/ 下的相对路径）");
  if (typeof t.dest !== "string" || !t.dest) errs.push(at + ".template.dest 必须是非空字符串（项目根下的相对路径）");
  if (errs.length) return errs;
  if (t.src.indexOf("..") !== -1 || path.isAbsolute(t.src)) {
    // src 必须锁在 templates/ 里：允许 `..` 等于允许清单把任意路径变成"canonical 模板"。
    errs.push(at + ".template.src 不得含 `..` 或写成绝对路径（必须落在 ccswitch/templates/ 之内）");
    return errs;
  }
  // ① src 真实存在 —— 不查这一条，`template` 就成了新的「指向空气的指针」。
  let st = null;
  try { st = fs.statSync(path.join(templatesRoot, t.src)); } catch (_) { st = null; }
  if (!st) errs.push(at + ".template.src 在 ccswitch/templates/ 下不存在：" + t.src);
  // ② dest 必须与 require 查的是同一个东西（require 为简单谓词时才判得了）。
  const rp = simpleRequirePath(req);
  if (rp === null) {
    errs.push(at + ".template 只能配在 require 为简单 {file:…}/{dir:…} 的条目上" +
      "（组合谓词没有唯一的『该复制到哪』，报文会教人复制到一个闸并不检查的位置）");
  } else if (rp !== t.dest) {
    errs.push(at + ".template.dest（" + t.dest + "）与 require 查的路径（" + rp + "）不一致" +
      "：照报文复制完之后闸仍会红，而人会以为是闸坏了");
  }
  return errs;
}

function validate(m, opts) {
  const templatesRoot = (opts && opts.templatesRoot) || TEMPLATES_ROOT;
  if (!m || typeof m !== "object" || Array.isArray(m)) return ["manifest 不是对象"];
  if (!Array.isArray(m.entries)) return ["manifest.entries 不是数组"];
  const errs = [];
  const seen = new Set();
  m.entries.forEach((e, i) => {
    const at = "entries[" + i + "]" + (e && e.id ? "(" + e.id + ")" : "");
    if (!e || typeof e !== "object" || Array.isArray(e)) { errs.push(at + " 不是对象"); return; }
    if (typeof e.id !== "string" || !e.id) errs.push(at + " 缺 id");
    else if (seen.has(e.id)) errs.push(at + " id 重复"); else seen.add(e.id);

    if (!CLASSES.includes(e.class)) {
      errs.push(at + " class 非法（只允许 " + CLASSES.join("/") + "；项目特有 rule 不进本清单）");
    }
    // 四分类的机器闸：conditional 必须给 when；universal 与 product-type 必须不给 when
    // （前者对任何项目都成立，后者的条件由类别本身内建）。
    // 「无条件共性却带条件」和「条件共性却没条件」都是分类错误，不是笔误。
    if (e.class === "conditional" && !e.when) errs.push(at + " class=conditional 必须带 when（条件共性的触发指纹）");
    if (e.class === "universal" && e.when) errs.push(at + " class=universal 不得带 when（无条件共性对任何项目都成立）");
    if (e.class === "product-type" && e.when) errs.push(at + " class=product-type 不得带 when（类别本身即条件：项目 CLAUDE.md 自我声明为「产品型项目」；要再收窄请改写成 conditional 并把指纹显式写进 when）");

    if (!e.require) errs.push(at + " 缺 require");
    if (typeof e.msg !== "string" || !e.msg) errs.push(at + " 缺 msg");
    if (typeof e.why !== "string" || !e.why) errs.push(at + " 缺 why（出处/理由——无出处的条目不该进清单）");
    if (e.severity !== undefined && !SEVERITIES.includes(e.severity)) {
      errs.push(at + " severity 非法（只允许 " + SEVERITIES.join("/") + "）");
    }
    // exempt：例外必须显式且带理由。空数组视为非法（写了个空壳等于没声明例外，
    // 只会让读者以为"这条有例外"）；缺 why 同样非法——无理由的例外就是隐形例外换个写法。
    if (e.exempt !== undefined) {
      if (!Array.isArray(e.exempt) || e.exempt.length === 0) {
        errs.push(at + ".exempt 必须是非空数组（无例外就别写这个字段）");
      } else {
        e.exempt.forEach((x, j) => {
          const xat = at + ".exempt[" + j + "]";
          if (!x || typeof x !== "object" || Array.isArray(x)) { errs.push(xat + " 不是对象"); return; }
          if (typeof x.repo !== "string" || !x.repo) errs.push(xat + ".repo 必须是非空字符串（项目根目录名）");
          if (typeof x.why !== "string" || !x.why) errs.push(xat + ".why 必须是非空字符串（例外理由——无理由的例外就是隐形例外）");
        });
      }
    }
    if (e.template !== undefined) {
      errs.push.apply(errs, templateErrors(e.template, e.require, at, templatesRoot));
    }
    if (e.when) errs.push.apply(errs, predErrors(e.when, at + ".when"));
    if (e.require) errs.push.apply(errs, predErrors(e.require, at + ".require"));
  });
  return errs;
}

// ── 求值 ────────────────────────────────────────────────────────────────────

function makeCtx(root) {
  return { root: root, _pkg: undefined };
}

function pkg(ctx) {
  if (ctx._pkg === undefined) {
    try { ctx._pkg = JSON.parse(fs.readFileSync(path.join(ctx.root, "package.json"), "utf8")); }
    catch (_) { ctx._pkg = null; }
  }
  return ctx._pkg;
}

function statOf(ctx, rel) {
  try { return fs.statSync(path.join(ctx.root, rel)); } catch (_) { return null; }
}

function readOf(ctx, rel) {
  try { return fs.readFileSync(path.join(ctx.root, rel), "utf8"); } catch (_) { return null; }
}

// glob 只支持「单层目录 + basename 通配」（`.github/workflows/*.yml`），不支持 `**`。
// 需要跨层找文件用 findFile —— 两者刻意分开，免得一个 glob 语法悄悄变成递归全仓扫描。
function globFiles(ctx, glob) {
  const dir = path.dirname(glob);
  const base = path.basename(glob);
  const rx = new RegExp("^" + base.split("").map((ch) => {
    if (ch === "*") return ".*";
    if (ch === "?") return ".";
    return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("") + "$");
  let names = [];
  try { names = fs.readdirSync(path.join(ctx.root, dir === "." ? "" : dir)); } catch (_) { return []; }
  return names.filter((n) => rx.test(n)).map((n) => (dir === "." ? n : dir + "/" + n));
}

function findFile(ctx, name, maxDepth) {
  const depth = maxDepth || 4;
  let visited = 0;
  const queue = [{ rel: "", d: 0 }];
  while (queue.length) {
    const cur = queue.shift();
    if (++visited > FIND_MAX_DIRS) return null;   // 边界内没找到 ⇒ 当作没有（漏报优于拖慢）
    let ents;
    try { ents = fs.readdirSync(path.join(ctx.root, cur.rel), { withFileTypes: true }); }
    catch (_) { continue; }
    for (const ent of ents) {
      if (ent.isDirectory()) {
        if (cur.d + 1 <= depth && !FIND_SKIP_DIRS.has(ent.name) && !ent.name.startsWith(".")) {
          queue.push({ rel: cur.rel ? cur.rel + "/" + ent.name : ent.name, d: cur.d + 1 });
        }
      } else if (ent.name === name) {
        return cur.rel ? cur.rel + "/" + ent.name : ent.name;
      }
    }
  }
  return null;
}

function R(ok, label, vars) { return { ok: !!ok, label: label || null, vars: vars || {} }; }

function evalPred(node, ctx) {
  const kind = Object.keys(node).filter((k) => k !== "label")[0];
  const v = node[kind];
  const label = node.label || null;

  switch (kind) {
    case "file": {
      const st = statOf(ctx, v);
      return R(st && !st.isDirectory(), label, { path: v });
    }
    case "dir": {
      const st = statOf(ctx, v);
      return R(st && st.isDirectory(), label, { path: v });
    }
    case "dep": {
      const p = pkg(ctx);
      if (!p) return R(false, label);
      const all = Object.assign({}, p.dependencies, p.devDependencies);
      return R(Object.prototype.hasOwnProperty.call(all, v), label, { dep: v });
    }
    case "pkgScript": {
      // package.json 不存在 ⇒ false（"没有脚本"）。若某条目想表达「无 package.json 就
      // 不判」，在清单里写成 anyOf[not(file package.json), pkgScript X] —— 显式写在数据里，
      // 不在这里塞隐式豁免（隐式豁免是下一个静默失效面）。
      const p = pkg(ctx);
      if (!p || !p.scripts) return R(false, label, { script: v });
      return R(Object.prototype.hasOwnProperty.call(p.scripts, v), label, { script: v });
    }
    case "glob":
      return R(globFiles(ctx, v).length > 0, label, { glob: v });
    case "findFile": {
      const hit = findFile(ctx, v.name, v.maxDepth);
      return R(!!hit, label, hit ? { path: hit } : {});
    }
    case "maxLines": {
      // 文件不存在 ⇒ ok（"缺文件"由另一条目管，一条判据只管一件事）
      const txt = readOf(ctx, v.path);
      if (txt === null) return R(true, label);
      const n = txt.split(/\r?\n/).length;
      return R(n <= v.n, label, { n: n, path: v.path });
    }
    case "fileContains": {
      const txt = readOf(ctx, v.path);
      if (txt === null) return R(false, label, { path: v.path });
      return R(txt.indexOf(v.text) !== -1, label, { path: v.path });
    }
    case "noFileMatching": {
      // 启发式：命中 = 该文件同时含全部 contains 且不含任何 notContains。
      // 两个方向都构造得出反例，故只用于 severity=info 条目。
      const contains = v.contains || [];
      const notContains = v.notContains || [];
      for (const rel of globFiles(ctx, v.glob)) {
        const txt = readOf(ctx, rel);
        if (txt === null) continue;
        const hasAll = contains.every((s) => txt.indexOf(s) !== -1);
        const hasNone = notContains.every((s) => txt.indexOf(s) === -1);
        if (hasAll && hasNone) return R(false, label, { file: rel });
      }
      return R(true, label);
    }
    case "anyOf": {
      for (const c of v) {
        const r = evalPred(c, ctx);
        if (r.ok) return R(true, r.label || label, r.vars);
      }
      return R(false, label);
    }
    case "allOf": {
      let lbl = label, vars = {};
      for (const c of v) {
        const r = evalPred(c, ctx);
        if (!r.ok) return R(false, r.label || label, r.vars);
        if (!lbl) lbl = r.label;
        vars = Object.assign(vars, r.vars);
      }
      return R(true, lbl, vars);
    }
    case "not": {
      const r = evalPred(v, ctx);
      return R(!r.ok, label || r.label, r.vars);
    }
    default:
      return R(false, label);
  }
}

function render(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

// 项目根的 basename——`exempt` 的匹配键。近似判据，弱点见文件头注。
function repoNameOf(projectRoot) {
  return path.basename(path.resolve(String(projectRoot || "")));
}

function exemptReason(entry, repoName) {
  if (!Array.isArray(entry.exempt)) return null;
  for (const x of entry.exempt) {
    if (x && x.repo === repoName) return x.why || "（无理由，schema 本该挡下）";
  }
  return null;
}

// PowerShell 单引号字符串里，字面单引号靠**双写**转义。路径含 `'` 极少见，但不处理的话
// 生成的是一条语法错的指令——而「零编辑可执行」这个承诺一旦不成立，就比不给指令更糟
// （人会照着粘、跑不通、然后不知道该怪谁）。
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

// issue #338：优先 pwsh、缺席回退 powershell 5.1（判定只看退出码，见 ./pwsh.js 头注）。
// 复制指令是给人/AI 粘到终端跑的，解释器选生成时机在本机现查；懒 memo 避免每条缺项 spawn 一次。
let _psInterp = null;
function psInterp() {
  if (_psInterp === null) _psInterp = pickPwsh();
  return _psInterp;
}

// issue #387 挂账 4：三态探测下 psInterp() 可能返回带空格的绝对路径
// （`C:\Program Files\PowerShell\7\pwsh.exe`）。生成的指令是给人/AI 粘到 PowerShell/pwsh
// 提示符跑的（-Command 载荷用的是 PowerShell 单引号转义，不是 cmd.exe 语法）——单纯加
// 双引号不够：PowerShell 里语句开头是带空格的带引号字符串时，解析成的是字符串表达式
// 而不是命令调用（实测：不加 `&` 直接报「表达式或语句中包含意外的标记 -NoProfile」），
// 必须配调用运算符 `&` 才会被当成命令执行。只在含空格时加，避免给常见字面量
// （`pwsh`/`powershell.exe`）徒增视觉噪音——那两种本就不需要 `&` 也能正确调用。
function psExe() {
  const p = psInterp();
  return /\s/.test(p) ? '& "' + p + '"' : p;
}

// 生成**零编辑可执行**的复制指令。src 是文件还是目录由**实际 stat** 决定（见头注闸③）。
// 返回 null = 生成不了（src 不在盘上），调用方据此改写成一句显式的「模板缺失」而不是沉默。
function copyInstruction(tpl, projectRoot, templatesRoot) {
  const root = templatesRoot || TEMPLATES_ROOT;
  const srcAbs = path.join(root, tpl.src);
  const destAbs = path.resolve(projectRoot, tpl.dest);
  let st = null;
  try { st = fs.statSync(srcAbs); } catch (_) { return null; }
  if (st.isDirectory()) {
    // 目录：先建目标目录，再复制**内容**（`\*`）。不写 `Copy-Item <dir> <destParent>` ——
    // 那条的语义随目标存不存在而变（存在则复制成子目录），是经典的"第二次跑就错"。
    return psExe() + " -NoProfile -Command " + psQuote(
      "New-Item -ItemType Directory -Force -Path " + psQuote(destAbs) + " | Out-Null; " +
      "Copy-Item -Path " + psQuote(path.join(srcAbs, "*")) + " -Destination " + psQuote(destAbs) + " -Recurse -Force"
    );
  }
  return psExe() + " -NoProfile -Command " + psQuote(
    "New-Item -ItemType Directory -Force -Path " + psQuote(path.dirname(destAbs)) + " | Out-Null; " +
    "Copy-Item -LiteralPath " + psQuote(srcAbs) + " -Destination " + psQuote(destAbs) + " -Force"
  );
}

// 返回 [{ id, class, severity, message }]，只含**缺项**（require 求值为 false 的条目）。
function evaluate(manifest, projectRoot, opts) {
  const templatesRoot = (opts && opts.templatesRoot) || TEMPLATES_ROOT;
  const ctx = makeCtx(projectRoot);
  const repoName = repoNameOf(projectRoot);
  const out = [];
  for (const e of manifest.entries || []) {
    if (exemptReason(e, repoName) !== null) continue;   // 本仓已显式声明例外 ⇒ 该条不查
    // product-type：类别内建条件，项目未在 CLAUDE.md 自我声明为「产品型项目」即不适用。
    // 顺序在 exempt 之后、when 之前：exempt 是"这个仓说了不查"，优先级最高。
    if (e.class === "product-type" && !evalPred(PRODUCT_TYPE_WHEN, ctx).ok) continue;
    let label = null;
    if (e.when) {
      const w = evalPred(e.when, ctx);
      if (!w.ok) continue;          // 条件共性未命中 ⇒ 本项目不适用
      label = w.label;
    }
    const r = evalPred(e.require, ctx);
    if (r.ok) continue;             // 已齐备
    const vars = Object.assign({ label: label }, r.vars);
    let message = render(e.msg, vars);
    if (e.template) {
      const cmd = copyInstruction(e.template, projectRoot, templatesRoot);
      // 生成不了也**要说出来**：canonical 模板不在盘上是个真问题（有人删了/改名了），
      // 静默退回原报文会让这条 entry 悄悄退化成又一条「AI 自己写一份吧」。
      message += cmd
        ? "\n   ↳ 零编辑复制 canonical：" + cmd
        : "\n   ↳ ⚠ canonical 模板缺失（ccswitch/templates/" + e.template.src + " 不在盘上），本条无法给出复制指令";
    }
    out.push({
      id: e.id,
      class: e.class,
      severity: e.severity || "warn",
      message: message,
    });
  }
  return out;
}

function defaultManifestPath() {
  return process.env.DAO_SCAFFOLD_MANIFEST || path.join(__dirname, "..", "scaffold-manifest.json");
}

// 返回 { manifest, errors }。errors 非空时 manifest 可能为 null —— 调用方**必须把 errors
// 报出去**，不许静默吞（反面教材：hookify stop.py 的 finally: sys.exit(0)）。
function load(manifestPath, opts) {
  const p = manifestPath || defaultManifestPath();
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); }
  catch (e) { return { manifest: null, errors: ["共性 rule 备案清单读取失败（" + p + "）：" + (e && e.message ? e.message : String(e))] }; }
  let m;
  try { m = JSON.parse(raw); }
  catch (e) { return { manifest: null, errors: ["共性 rule 备案清单 JSON 解析失败（" + p + "）：" + (e && e.message ? e.message : String(e))] }; }
  const errs = validate(m, opts);
  return { manifest: errs.length ? null : m, errors: errs };
}

// 一步到位：加载 + 求值，把加载错误也转成可报的行（调用方只需拼进 issues）。
function check(projectRoot, manifestPath, opts) {
  const { manifest, errors } = load(manifestPath, opts);
  if (!manifest) return { findings: [], errors: errors };
  try { return { findings: evaluate(manifest, projectRoot, opts), errors: [] }; }
  catch (e) { return { findings: [], errors: ["共性 rule 备案清单求值抛错：" + (e && e.message ? e.message : String(e))] }; }
}

module.exports = {
  validate, evaluate, load, check, defaultManifestPath, repoNameOf, exemptReason,
  _internal: { evalPred, makeCtx, globFiles, findFile, render, predErrors, copyInstruction, simpleRequirePath, psQuote },
  CLASSES, SEVERITIES, LEAF_KINDS, COMBINATORS, PRODUCT_TYPE_WHEN, PRODUCT_TYPE_NEGATIVE_WHEN, TEMPLATES_ROOT,
};
