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
// 真相源：windsurf-dao/ccswitch/lib/scaffold-manifest.js

"use strict";

const fs = require("fs");
const path = require("path");

const CLASSES = ["universal", "conditional", "product-type"];
const SEVERITIES = ["warn", "info"];

// product-type 类别的内建条件（唯一定义处，清单里不重复写）。
const PRODUCT_TYPE_WHEN = { fileContains: { path: "CLAUDE.md", text: "产品型项目" } };

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

function validate(m) {
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

// 返回 [{ id, class, severity, message }]，只含**缺项**（require 求值为 false 的条目）。
function evaluate(manifest, projectRoot) {
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
    out.push({
      id: e.id,
      class: e.class,
      severity: e.severity || "warn",
      message: render(e.msg, vars),
    });
  }
  return out;
}

function defaultManifestPath() {
  return process.env.DAO_SCAFFOLD_MANIFEST || path.join(__dirname, "..", "scaffold-manifest.json");
}

// 返回 { manifest, errors }。errors 非空时 manifest 可能为 null —— 调用方**必须把 errors
// 报出去**，不许静默吞（反面教材：hookify stop.py 的 finally: sys.exit(0)）。
function load(manifestPath) {
  const p = manifestPath || defaultManifestPath();
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); }
  catch (e) { return { manifest: null, errors: ["共性 rule 备案清单读取失败（" + p + "）：" + (e && e.message ? e.message : String(e))] }; }
  let m;
  try { m = JSON.parse(raw); }
  catch (e) { return { manifest: null, errors: ["共性 rule 备案清单 JSON 解析失败（" + p + "）：" + (e && e.message ? e.message : String(e))] }; }
  const errs = validate(m);
  return { manifest: errs.length ? null : m, errors: errs };
}

// 一步到位：加载 + 求值，把加载错误也转成可报的行（调用方只需拼进 issues）。
function check(projectRoot, manifestPath) {
  const { manifest, errors } = load(manifestPath);
  if (!manifest) return { findings: [], errors: errors };
  try { return { findings: evaluate(manifest, projectRoot), errors: [] }; }
  catch (e) { return { findings: [], errors: ["共性 rule 备案清单求值抛错：" + (e && e.message ? e.message : String(e))] }; }
}

module.exports = {
  validate, evaluate, load, check, defaultManifestPath, repoNameOf, exemptReason,
  _internal: { evalPred, makeCtx, globFiles, findFile, render, predErrors },
  CLASSES, SEVERITIES, LEAF_KINDS, COMBINATORS, PRODUCT_TYPE_WHEN,
};
