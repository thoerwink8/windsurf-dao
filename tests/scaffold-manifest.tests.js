// 共性 rule 备案清单 · 两态自证（schema 校验 + 谓词求值 + 端到端缺项报出）
//
// 跑法：node tests/scaffold-manifest.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 验的是哪一层：**清单本体合法 + 求值器每种谓词的两态 + 四分类的机器闸**。
// 它证明「非法清单会被挡下 / 谓词判据两个方向都夹得住 / 缺项报出且齐备不报」，
// **不证明** 清单收录的条目是否"该收"——那是人的判断，由 manifest 里每条的 why 字段承载。
//
// ── 断言策略 ────────────────────────────────────────────────────────────────
// 对**真实清单**只断言结构性质（分类合法、id 唯一、why 非空、conditional 必有 when），
// **不断言条目数量或具体 id**——那样每加一条共性 rule 就要改测试，会把"加一条很便宜"
// 这个本次改造的核心目标重新变贵。条目内容的两态验证一律走**构造的假清单**。
//
// 谓词逐个给正反两例：单向断言夹不住"判据被放宽"那个方向（出处：dispatch-clauses
// 对抗验证官节「判别力缝的自检问句」）。

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const LIB = path.join(REPO, "ccswitch", "lib", "scaffold-manifest.js");
const REAL_MANIFEST = path.join(REPO, "ccswitch", "scaffold-manifest.json");
const SANDBOX = path.join(REPO, "_tmp", "scaffold-manifest-sandbox");

const M = require(LIB);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });

function mkproj(name, build) {
  const root = path.join(SANDBOX, name);
  fs.mkdirSync(root, { recursive: true });
  if (build) build(root);
  return root;
}
function w(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}
function entry(over) {
  return Object.assign({
    id: "probe", class: "universal", require: { file: "X.md" },
    msg: "缺 X.md", why: "测试夹具",
  }, over);
}
function ids(findings) { return findings.map((f) => f.id); }

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 真实清单：结构性质（不断言条目数，见头注）===");
{
  const { manifest, errors } = M.load(REAL_MANIFEST);
  check("真实 scaffold-manifest.json 通过 schema 校验", errors.length === 0 && !!manifest,
    "errors=" + JSON.stringify(errors).slice(0, 400));
  const es = (manifest && manifest.entries) || [];
  check("清单非空", es.length > 0, "len=" + es.length);
  // 2026-07-27 由「universal 与 conditional 各至少一条」改为三类各至少一条。
  // 断言跟随契约（加了第四类 product-type），且**新断言的通过集是旧断言通过集的真子集**
  // ——原断言放行「没有任何 product-type 条目」的清单，新断言不放行。改断言的合法性判据
  // 见 mousse-cli dispatch-clauses.md 对抗验证官节「改既有断言必须证明新断言更难满足」。
  check("四分类：universal / conditional / product-type 各至少一条",
    es.some((e) => e.class === "universal") && es.some((e) => e.class === "conditional") &&
    es.some((e) => e.class === "product-type"),
    "classes=" + JSON.stringify(es.map((e) => e.class)));
  check("每条 conditional 都带机器可判的 when",
    es.filter((e) => e.class === "conditional").every((e) => !!e.when));
  check("每条 universal 都不带 when（无条件共性）",
    es.filter((e) => e.class === "universal").every((e) => !e.when));
  check("每条 product-type 都不带 when（条件由类别内建）",
    es.filter((e) => e.class === "product-type").every((e) => !e.when),
    "offenders=" + es.filter((e) => e.class === "product-type" && e.when).map((e) => e.id).join(","));
  check("清单带「四分类」说明段且含 product-type 定义（改名后不留两处各说一半的分类定义）",
    !!(manifest && manifest._doc && manifest._doc["四分类"] && manifest._doc["四分类"]["product-type"]));
  check("旧的「三分类」键已不存在（避免同一定义存两份、改一处忘一处）",
    !!(manifest && manifest._doc && manifest._doc["三分类"] === undefined));
  check("每条都带 why（出处/理由）", es.every((e) => typeof e.why === "string" && e.why.length > 0));
  check("id 全局唯一", new Set(es.map((e) => e.id)).size === es.length);
  check("msg 不自带「（建议）」前缀（该前缀由 hook 按 severity 加，写进 msg 会重复）",
    es.every((e) => e.msg.indexOf("（建议）") === -1),
    "offenders=" + es.filter((e) => e.msg.indexOf("（建议）") !== -1).map((e) => e.id).join(","));
  check("近似/启发式判据（noFileMatching）一律 severity=info",
    es.filter((e) => JSON.stringify(e.require).indexOf("noFileMatching") !== -1)
      .every((e) => e.severity === "info"));
  check("清单带「什么不该进」说明段（个性 rule 边界）",
    !!(manifest && manifest._doc && manifest._doc["什么不该进本清单"]));
  check("清单带「文件名契约」原则声明（裁定 A：跨项目核对的前提）",
    !!(manifest && manifest._doc && manifest._doc["文件名契约（原则声明，不是检查项）"]));
  // 每条 exempt 都必须带非空 why：无理由的例外就是隐形例外换了个写法，
  // 而本字段存在的全部理由是「例外显式化 > 例外隐形」。
  check("每条 exempt 的每个例外都带非空 why",
    es.filter((e) => e.exempt).every((e) => e.exempt.every((x) => typeof x.why === "string" && x.why.length > 0)),
    "offenders=" + es.filter((e) => e.exempt && !e.exempt.every((x) => x.why)).map((e) => e.id).join(","));
  // 元仓库不再整体豁免（hook 侧取消早退），故它对 AGENT_GUIDE.md 那条的例外
  // **必须**以数据形式在场——否则元仓库每次 SessionStart 都会被报一条刻意保留的文件。
  const ag = es.find((e) => e.id === "no-redundant-agent-guide");
  check("no-redundant-agent-guide 为 windsurf-dao 显式声明例外（取消整体豁免的配套）",
    !!(ag && Array.isArray(ag.exempt) && ag.exempt.some((x) => x.repo === "windsurf-dao")),
    "exempt=" + JSON.stringify(ag && ag.exempt));
  check("该例外的 why 说明了它为何刻意保留（提到 dao.md 引用它）",
    !!(ag && ag.exempt && ag.exempt.some((x) => x.repo === "windsurf-dao" && /dao\.md/.test(x.why))));
  check("rejected 段记下裁定 C（rule frontmatter 挂账不立）且写明解冻条件",
    !!(manifest && manifest._doc && (manifest._doc.rejected || []).some(
      (r) => /frontmatter/.test(r["候选"] || "") && /解冻条件/.test(r["不收原因"] || ""))));
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== schema 校验：合法通过 / 各类非法被挡（两态）===");
{
  check("负控：合法最小清单零错误", M.validate({ entries: [entry()] }).length === 0,
    JSON.stringify(M.validate({ entries: [entry()] })));
  check("entries 非数组 → 报错", M.validate({}).length > 0);
  check("class 非法值（如 project-specific）→ 报错",
    M.validate({ entries: [entry({ class: "project-specific" })] }).some((e) => /class 非法/.test(e)));
  check("conditional 缺 when → 报错（分类机器闸的一侧）",
    M.validate({ entries: [entry({ class: "conditional" })] }).some((e) => /必须带 when/.test(e)));
  check("universal 带 when → 报错（分类机器闸的另一侧）",
    M.validate({ entries: [entry({ when: { dir: "src-ui" } })] }).some((e) => /不得带 when/.test(e)));
  check("负控：合法 product-type（不带 when）零错误",
    M.validate({ entries: [entry({ class: "product-type" })] }).length === 0,
    JSON.stringify(M.validate({ entries: [entry({ class: "product-type" })] })));
  check("product-type 带 when → 报错（条件由类别内建，叠第二层条件会让「为什么没报」变成两处判据的合取）",
    M.validate({ entries: [entry({ class: "product-type", when: { dir: "src-ui" } })] })
      .some((e) => /class=product-type 不得带 when/.test(e)));
  check("id 重复 → 报错",
    M.validate({ entries: [entry(), entry()] }).some((e) => /id 重复/.test(e)));
  check("缺 why → 报错（无出处的条目不该进清单）",
    M.validate({ entries: [entry({ why: undefined })] }).some((e) => /缺 why/.test(e)));
  check("缺 require → 报错", M.validate({ entries: [entry({ require: undefined })] }).some((e) => /缺 require/.test(e)));
  check("缺 msg → 报错", M.validate({ entries: [entry({ msg: undefined })] }).some((e) => /缺 msg/.test(e)));
  check("severity 非法 → 报错",
    M.validate({ entries: [entry({ severity: "fatal" })] }).some((e) => /severity 非法/.test(e)));
  check("谓词种类非法 → 报错",
    M.validate({ entries: [entry({ require: { existsMaybe: "x" } })] }).some((e) => /谓词种类 existsMaybe 非法/.test(e)));
  check("谓词带两个种类键 → 报错（歧义不放行）",
    M.validate({ entries: [entry({ require: { file: "a", dir: "b" } })] }).some((e) => /恰好带一个谓词种类键/.test(e)));
  check("谓词零种类键 → 报错",
    M.validate({ entries: [entry({ require: {} })] }).some((e) => /恰好带一个谓词种类键/.test(e)));
  check("嵌套谓词的错误能定位到路径",
    M.validate({ entries: [entry({ require: { anyOf: [{ file: "a" }, { nope: 1 }] } })] })
      .some((e) => /require\.anyOf\[1\]/.test(e)));
  check("anyOf 空数组 → 报错",
    M.validate({ entries: [entry({ require: { anyOf: [] } })] }).some((e) => /必须是非空数组/.test(e)));
  check("maxLines.n 非正整数 → 报错",
    M.validate({ entries: [entry({ require: { maxLines: { path: "a", n: 0 } } })] }).some((e) => /maxLines\.n/.test(e)));
  check("label 非字符串 → 报错",
    M.validate({ entries: [entry({ require: { file: "a", label: 7 } })] }).some((e) => /label 必须是字符串/.test(e)));

  // exempt 的 schema 两态。空数组也判非法：写个空壳等于没声明例外，
  // 却会让读者以为「这条有例外」——比不写更糟。
  check("负控：合法 exempt 零错误",
    M.validate({ entries: [entry({ exempt: [{ repo: "some-repo", why: "理由" }] })] }).length === 0,
    JSON.stringify(M.validate({ entries: [entry({ exempt: [{ repo: "some-repo", why: "理由" }] })] })));
  check("exempt 非数组 → 报错",
    M.validate({ entries: [entry({ exempt: { repo: "x", why: "y" } })] }).some((e) => /exempt 必须是非空数组/.test(e)));
  check("exempt 空数组 → 报错（空壳例外比不写更糟）",
    M.validate({ entries: [entry({ exempt: [] })] }).some((e) => /exempt 必须是非空数组/.test(e)));
  check("exempt 缺 repo → 报错",
    M.validate({ entries: [entry({ exempt: [{ why: "理由" }] })] }).some((e) => /exempt\[0\]\.repo/.test(e)));
  check("exempt 缺 why → 报错（无理由的例外就是隐形例外）",
    M.validate({ entries: [entry({ exempt: [{ repo: "x" }] })] }).some((e) => /exempt\[0\]\.why/.test(e)));
  check("exempt 元素非对象 → 报错",
    M.validate({ entries: [entry({ exempt: ["windsurf-dao"] })] }).some((e) => /exempt\[0\] 不是对象/.test(e)));
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 谓词求值：每种两态 ===");
{
  const root = mkproj("preds", (r) => {
    w(r, "CLAUDE.md", Array.from({ length: 5 }, (_, i) => "行" + i).join("\n"));
    fs.mkdirSync(path.join(r, ".claude", "rules"), { recursive: true });
    w(r, ".gitignore", "node_modules/\n**/_tmp/\n");
    w(r, "package.json", JSON.stringify({
      dependencies: { react: "19" }, devDependencies: { vitest: "4" }, scripts: { "dev:debug": "x" },
    }));
    w(r, "crates/app/tauri.conf.json", "{}");
    w(r, ".github/workflows/ci.yml", "on:\n  pull_request:\njobs:\n  a:\n    strategy:\n      matrix:\n        os: [macos-latest]\n");
    // 只存在于 node_modules 里的文件名：findFile 必须找不到它（否则跳过目录形同虚设）
    w(r, "node_modules/deep/only-in-node-modules.json", "{}");
  });
  const ctx = M._internal.makeCtx(root);
  const ev = (node) => M._internal.evalPred(node, ctx);

  check("file 命中", ev({ file: "CLAUDE.md" }).ok);
  check("file 不命中（不存在）", !ev({ file: "NOPE.md" }).ok);
  check("file 不命中（是目录不是文件）", !ev({ file: ".claude" }).ok);
  check("dir 命中", ev({ dir: ".claude/rules" }).ok);
  check("dir 不命中（是文件不是目录）", !ev({ dir: "CLAUDE.md" }).ok);
  check("dep 命中 dependencies", ev({ dep: "react" }).ok);
  check("dep 命中 devDependencies", ev({ dep: "vitest" }).ok);
  check("dep 不命中", !ev({ dep: "svelte" }).ok);
  check("pkgScript 命中", ev({ pkgScript: "dev:debug" }).ok);
  check("pkgScript 不命中", !ev({ pkgScript: "test" }).ok);
  check("glob 命中", ev({ glob: ".github/workflows/*.yml" }).ok);
  check("glob 不命中（扩展名不符）", !ev({ glob: ".github/workflows/*.yaml" }).ok);
  check("glob 不命中（目录不存在）", !ev({ glob: "nope/dir/*.yml" }).ok);
  check("findFile 跨层命中（crates/app/tauri.conf.json）", ev({ findFile: { name: "tauri.conf.json", maxDepth: 4 } }).ok);
  check("findFile 回传命中路径", /crates\/app\/tauri\.conf\.json/.test(ev({ findFile: { name: "tauri.conf.json" } }).vars.path || ""));
  check("findFile 深度不足即不命中（maxDepth=1）", !ev({ findFile: { name: "tauri.conf.json", maxDepth: 1 } }).ok);
  check("findFile 不进 node_modules（跳过目录生效——该文件只存在于 node_modules 里）",
    !ev({ findFile: { name: "only-in-node-modules.json", maxDepth: 4 } }).ok);
  check("findFile 找不存在的名字 → 不命中", !ev({ findFile: { name: "nothing.here" } }).ok);
  check("maxLines 未超 → ok", ev({ maxLines: { path: "CLAUDE.md", n: 80 } }).ok);
  check("maxLines 超 → 不 ok 且回传真实行数", (() => {
    const r = ev({ maxLines: { path: "CLAUDE.md", n: 3 } });
    return !r.ok && r.vars.n === 5;
  })());
  check("maxLines 文件不存在 → ok（缺文件由另一条目管）", ev({ maxLines: { path: "NOPE.md", n: 1 } }).ok);
  check("fileContains 命中", ev({ fileContains: { path: ".gitignore", text: "_tmp/" } }).ok);
  check("fileContains 不命中（无该子串）", !ev({ fileContains: { path: ".gitignore", text: "coverage/" } }).ok);
  check("fileContains 不命中（文件不存在）", !ev({ fileContains: { path: ".nope", text: "x" } }).ok);
  check("noFileMatching 有违规文件 → 不 ok 且回传文件名", (() => {
    const r = ev({ noFileMatching: { glob: ".github/workflows/*.yml", contains: ["pull_request", "macos-"], notContains: ["if:"] } });
    return !r.ok && /ci\.yml/.test(r.vars.file || "");
  })());
  check("noFileMatching 负控：notContains 命中即放过", (() => {
    w(root, ".github/workflows/ci.yml", "on:\n  pull_request:\njobs:\n  a:\n    if: github.event_name == 'push'\n    strategy:\n      matrix:\n        os: [macos-latest]\n");
    const c2 = M._internal.makeCtx(root);
    return M._internal.evalPred({ noFileMatching: { glob: ".github/workflows/*.yml", contains: ["pull_request", "macos-"], notContains: ["if:"] } }, c2).ok;
  })());
  check("anyOf 有一真即真", ev({ anyOf: [{ file: "NOPE" }, { file: "CLAUDE.md" }] }).ok);
  check("anyOf 全假即假", !ev({ anyOf: [{ file: "NOPE" }, { dir: "NOPE" }] }).ok);
  check("allOf 全真即真", ev({ allOf: [{ file: "CLAUDE.md" }, { dir: ".claude/rules" }] }).ok);
  check("allOf 一假即假", !ev({ allOf: [{ file: "CLAUDE.md" }, { file: "NOPE" }] }).ok);
  check("not 取反（真→假）", !ev({ not: { file: "CLAUDE.md" } }).ok);
  check("not 取反（假→真）", ev({ not: { file: "NOPE" } }).ok);
  check("anyOf 回传命中分支的 label", ev({ anyOf: [{ dir: "NOPE", label: "A" }, { dir: ".claude", label: "B" }] }).label === "B");
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== evaluate 端到端：缺项报出 / 齐备不报 / 条件不命中即跳过 ===");
{
  const bare = mkproj("bare");
  const full = mkproj("full", (r) => {
    w(r, "CLAUDE.md", "# 项目\n");
    fs.mkdirSync(path.join(r, ".claude", "rules"), { recursive: true });
    w(r, ".claude/rules/frontend-style.md", "# 样式\n");
    w(r, "package.json", JSON.stringify({ dependencies: { react: "19" }, scripts: { test: "vitest" } }));
  });
  const manifest = {
    entries: [
      entry({ id: "u-claude", require: { file: "CLAUDE.md" }, msg: "缺 CLAUDE.md" }),
      entry({
        id: "c-frontend", class: "conditional",
        when: { anyOf: [{ dep: "react" }, { dir: "src-ui" }] },
        require: { file: ".claude/rules/frontend-style.md" },
        msg: "前端缺样式 rule",
      }),
    ],
  };
  const rBare = M.evaluate(manifest, bare);
  check("空项目 → universal 条目报出", ids(rBare).indexOf("u-claude") !== -1, JSON.stringify(rBare));
  check("空项目 → conditional 条件未命中即跳过（不误报前端项）",
    ids(rBare).indexOf("c-frontend") === -1, JSON.stringify(rBare));

  const rFull = M.evaluate(manifest, full);
  check("齐备项目 → 零缺项", rFull.length === 0, JSON.stringify(rFull));

  const noRule = mkproj("react-no-rule", (r) => {
    w(r, "CLAUDE.md", "# 项目\n");
    w(r, "package.json", JSON.stringify({ dependencies: { react: "19" } }));
  });
  check("有 react 依赖但缺 frontend-style.md → conditional 条目报出",
    ids(M.evaluate(manifest, noRule)).indexOf("c-frontend") !== -1);
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== exempt 求值：命中仓跳过 / 别的仓照报（两态 + 范围不越界）===");
// 为什么这一组必须两态：只验「被豁免的仓不报」挡不住 exempt 写错范围——
// 一个匹配过宽的 exempt（或求值器忽略 repo 直接跳过）同样让那一条「不报」，
// 于是该规则对所有项目静默失效，而输出看起来完全正常。
{
  const manifest = {
    entries: [
      entry({
        id: "no-agent-guide", require: { not: { file: "AGENT_GUIDE.md" } },
        msg: "根目录存在冗余 AI 入口 AGENT_GUIDE.md",
        exempt: [{ repo: "meta-repo-probe", why: "夹具：该仓刻意保留此文件" }],
      }),
      entry({ id: "u-claude", require: { file: "CLAUDE.md" }, msg: "缺 CLAUDE.md" }),
    ],
  };
  const build = (r) => { w(r, "AGENT_GUIDE.md", "冗余入口\n"); };   // 两个项目都违规
  const exempted = mkproj("meta-repo-probe", build);
  const other = mkproj("ordinary-repo-probe", build);

  const rEx = M.evaluate(manifest, exempted);
  const rOther = M.evaluate(manifest, other);
  check("exempt 命中（basename 相符）→ 该条跳过", ids(rEx).indexOf("no-agent-guide") === -1, JSON.stringify(rEx));
  check("同一违规、仓名不符 → 照报（exempt 不越界）",
    ids(rOther).indexOf("no-agent-guide") !== -1, JSON.stringify(rOther));
  check("exempt 只豁免它自己那一条，同项目其他缺项照报",
    ids(rEx).indexOf("u-claude") !== -1, JSON.stringify(rEx));
  check("删掉 exempt 声明 → 原本被豁免的仓重新被报（mutation 方向）", (() => {
    const noEx = JSON.parse(JSON.stringify(manifest));
    delete noEx.entries[0].exempt;
    return ids(M.evaluate(noEx, exempted)).indexOf("no-agent-guide") !== -1;
  })());
  check("repoNameOf 取项目根 basename（exempt 的匹配键，近似判据见 lib 头注）",
    M.repoNameOf(exempted) === "meta-repo-probe", "got=" + M.repoNameOf(exempted));
  check("exemptReason 命中回传理由、不命中回 null",
    /夹具/.test(M.exemptReason(manifest.entries[0], "meta-repo-probe") || "") &&
    M.exemptReason(manifest.entries[0], "ordinary-repo-probe") === null);
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== product-type 求值：自我声明才查 / 未声明即跳过（两态 + 判别力）===");
// 为什么这一组必须两态：只验「声明了就报」挡不住判据被放宽——一个忽略自我声明、
// 对所有仓一律查的实现同样能让"声明了的仓被报"，而那恰是本类别要避免的后果
// （对内部工具仓常态误报 ⇒ 噪音训练人忽略整个 hook 的输出）。
{
  const manifest = {
    entries: [
      entry({
        id: "pt-evidence", class: "product-type",
        require: { file: ".claude/rules/pr-evidence.md" }, msg: "缺 pr-evidence.md",
      }),
      entry({ id: "u-claude", require: { file: "CLAUDE.md" }, msg: "缺 CLAUDE.md" }),
    ],
  };
  const declared = mkproj("pt-declared", (r) => { w(r, "CLAUDE.md", "# 某产品\n\n产品型项目，代码改动一律走 PR。\n"); });
  const silent = mkproj("pt-silent", (r) => { w(r, "CLAUDE.md", "# 某内部工具\n\n随手改随手推。\n"); });
  const noClaude = mkproj("pt-no-claude");

  check("自我声明为「产品型项目」→ product-type 条目照查并报出缺项",
    ids(M.evaluate(manifest, declared)).indexOf("pt-evidence") !== -1,
    JSON.stringify(M.evaluate(manifest, declared)));
  check("未自我声明 → product-type 条目跳过（内部工具仓不被这类报文淹没）",
    ids(M.evaluate(manifest, silent)).indexOf("pt-evidence") === -1,
    JSON.stringify(M.evaluate(manifest, silent)));
  check("连 CLAUDE.md 都没有 → product-type 条目同样跳过（fileContains 读不到文件即 false）",
    ids(M.evaluate(manifest, noClaude)).indexOf("pt-evidence") === -1,
    JSON.stringify(M.evaluate(manifest, noClaude)));
  check("product-type 的门只管自己那一类：同项目的 universal 条目照常判定",
    ids(M.evaluate(manifest, silent)).indexOf("u-claude") === -1 &&
    ids(M.evaluate(manifest, noClaude)).indexOf("u-claude") !== -1);
  check("mutation 方向：把自我声明从 CLAUDE.md 里删掉 → 原本被报的仓不再被报", (() => {
    w(declared, "CLAUDE.md", "# 某产品\n\n（声明已删）\n");
    return ids(M.evaluate(manifest, declared)).indexOf("pt-evidence") === -1;
  })());
  check("mutation 复原：声明写回 → 重新被报（两态都看到才算验过）", (() => {
    w(declared, "CLAUDE.md", "# 某产品\n\n产品型项目，代码改动一律走 PR。\n");
    return ids(M.evaluate(manifest, declared)).indexOf("pt-evidence") !== -1;
  })());
  check("PRODUCT_TYPE_WHEN 是条件的唯一定义处且判据为 CLAUDE.md 子串（清单里不重复写条件）",
    !!(M.PRODUCT_TYPE_WHEN && M.PRODUCT_TYPE_WHEN.fileContains &&
       M.PRODUCT_TYPE_WHEN.fileContains.path === "CLAUDE.md" &&
       M.PRODUCT_TYPE_WHEN.fileContains.text === "产品型项目"),
    "got=" + JSON.stringify(M.PRODUCT_TYPE_WHEN));
  check("CLASSES 恰为三类（个性 rule 不进清单这条边界没被第四类冲掉）",
    M.CLASSES.length === 3 && M.CLASSES.indexOf("product-type") !== -1,
    "CLASSES=" + JSON.stringify(M.CLASSES));
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 报文渲染：{n} / {label} / {file} 占位符 ===");
{
  const root = mkproj("render", (r) => {
    w(r, "CLAUDE.md", Array.from({ length: 100 }, (_, i) => "行" + i).join("\n"));
    fs.mkdirSync(path.join(r, "src-tauri"), { recursive: true });
  });
  const out = M.evaluate({
    entries: [
      entry({ id: "size", require: { maxLines: { path: "CLAUDE.md", n: 80 } }, msg: "CLAUDE.md 超过 80 行（当前 {n} 行）" }),
      entry({
        id: "desktop", class: "conditional",
        when: { anyOf: [{ dir: "src-tauri", label: "Tauri" }, { dep: "electron", label: "Electron" }] },
        require: { file: ".claude/rules/desktop-debugging.md" },
        msg: "{label} 桌面端项目缺少调试规则",
      }),
    ],
  }, root);
  const byId = Object.fromEntries(out.map((o) => [o.id, o.message]));
  check("{n} 被真实行数替换", byId.size === "CLAUDE.md 超过 80 行（当前 100 行）", "got=" + byId.size);
  check("{label} 被命中分支的 label 替换", byId.desktop === "Tauri 桌面端项目缺少调试规则", "got=" + byId.desktop);
  check("未提供的占位符原样保留（不渲染成 undefined）",
    M.evaluate({ entries: [entry({ id: "x", require: { file: "NOPE" }, msg: "缺 {whoknows}" })] }, root)[0].message === "缺 {whoknows}");
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== 加载失败必须响（不许静默吞）===");
{
  const badJson = path.join(SANDBOX, "bad.json");
  fs.writeFileSync(badJson, "{ 这不是 JSON", "utf8");
  const r1 = M.check(SANDBOX, badJson);
  check("坏 JSON → 返回错误行而非静默零发现",
    r1.errors.length > 0 && /JSON 解析失败/.test(r1.errors[0]), JSON.stringify(r1).slice(0, 200));

  const missing = path.join(SANDBOX, "not-here.json");
  const r2 = M.check(SANDBOX, missing);
  check("清单文件不存在 → 返回错误行", r2.errors.length > 0 && /读取失败/.test(r2.errors[0]));

  const invalid = path.join(SANDBOX, "invalid.json");
  fs.writeFileSync(invalid, JSON.stringify({ entries: [{ id: "x", class: "nope" }] }), "utf8");
  const r3 = M.check(SANDBOX, invalid);
  check("schema 非法 → 返回校验错误且不产出发现（宁可全响不许半哑）",
    r3.errors.length > 0 && r3.findings.length === 0, JSON.stringify(r3).slice(0, 300));

  const good = path.join(SANDBOX, "good.json");
  fs.writeFileSync(good, JSON.stringify({ entries: [entry({ id: "g", require: { file: "NOPE.md" } })] }), "utf8");
  const r4 = M.check(SANDBOX, good);
  check("负控：合法清单 → 零错误且有发现", r4.errors.length === 0 && r4.findings.length === 1);
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== template 字段：三条机器闸 + 零编辑复制指令端到端 ===");
{
  // 合成 templates 根：**不拿真实 ccswitch/templates/ 当夹具**，否则真模板一改名，
  // 这些断言的含义就跟着变（同「拿被测对象自己当基线」）。
  const TR = path.join(SANDBOX, "_templates");
  fs.mkdirSync(path.join(TR, "kit"), { recursive: true });
  fs.writeFileSync(path.join(TR, "one.md"), "canonical 正文\n", "utf8");
  fs.writeFileSync(path.join(TR, "kit", "a.yml"), "a\n", "utf8");
  fs.writeFileSync(path.join(TR, "kit", "b.yml"), "b\n", "utf8");
  const opts = { templatesRoot: TR };
  const tEntry = (over) => entry(Object.assign({
    require: { file: "X.md" }, template: { src: "one.md", dest: "X.md" },
  }, over));

  check("负控：合法 template 零错误", M.validate({ entries: [tEntry()] }, opts).length === 0,
    JSON.stringify(M.validate({ entries: [tEntry()] }, opts)));

  // 闸①：src 必须真实存在 —— 不查它，template 就是新的「指向空气的指针」
  check("闸①：src 不在 templates/ 下 → 报错（load 时就现形，不等某个项目恰好缺这项）",
    M.validate({ entries: [tEntry({ template: { src: "nope.md", dest: "X.md" } })] }, opts)
      .some((e) => /template\.src .*不存在/.test(e)));
  check("闸①附：src 含 `..` / 绝对路径 → 报错（不许把任意路径变成 canonical）",
    M.validate({ entries: [tEntry({ template: { src: "../dao.md", dest: "X.md" } })] }, opts)
      .some((e) => /不得含/.test(e)));

  // 闸②：dest 必须与 require 查的路径相等 —— 否则报文教人复制到 A、闸查的是 B
  check("闸②：dest 与 require 路径不一致 → 报错",
    M.validate({ entries: [tEntry({ template: { src: "one.md", dest: "Y.md" } })] }, opts)
      .some((e) => /与 require 查的路径.*不一致/.test(e)));
  check("闸②附：require 是组合谓词时不许带 template（没有唯一的『该复制到哪』）",
    M.validate({ entries: [tEntry({ require: { anyOf: [{ file: "X.md" }, { file: "Z.md" }] } })] }, opts)
      .some((e) => /只能配在 require 为简单/.test(e)));
  check("负控：dir 型 require + 目录型 src 合法",
    M.validate({ entries: [tEntry({ require: { dir: "kit" }, template: { src: "kit", dest: "kit" } })] }, opts).length === 0);

  // 闸③：文件 / 目录由**实际 stat** 决定，不由清单写死
  const proj = mkproj("tpl-target");
  const fileCmd = M._internal.copyInstruction({ src: "one.md", dest: "X.md" }, proj, TR);
  const dirCmd = M._internal.copyInstruction({ src: "kit", dest: "kit" }, proj, TR);
  check("闸③：文件型 src → 生成 Copy-Item -LiteralPath（单文件语义）",
    /Copy-Item -LiteralPath/.test(fileCmd) && !/-Recurse/.test(fileCmd), fileCmd);
  check("闸③：目录型 src → 生成 `\\*` + -Recurse（复制内容，不是复制成子目录）",
    /-Recurse/.test(dirCmd) && dirCmd.indexOf("*") !== -1, dirCmd);
  check("指令用绝对路径（零编辑的前提：粘到任何 cwd 都成立）",
    fileCmd.indexOf(path.resolve(proj)) !== -1 && fileCmd.indexOf(path.resolve(TR)) !== -1, fileCmd);
  check("src 不在盘上 → copyInstruction 返回 null（由调用方改写成显式『模板缺失』，不静默）",
    M._internal.copyInstruction({ src: "gone.md", dest: "X.md" }, proj, TR) === null);
  // 引号转义：路径含单引号时仍须是一条**语法合法**的 PowerShell 命令 ——
  // 「零编辑可执行」一旦不成立，比不给指令更糟（人照着粘、跑不通、不知道怪谁）。
  check("psQuote 双写单引号", M._internal.psQuote("a'b") === "'a''b'", M._internal.psQuote("a'b"));

  // 端到端：缺项报文真的带上那一行；齐备则整条不报
  const man = { entries: [tEntry({ id: "tpl" })] };
  const f1 = M.evaluate(man, proj, opts);
  check("缺项报文追加「零编辑复制 canonical：」一行",
    f1.length === 1 && /零编辑复制 canonical：powershell/.test(f1[0].message), JSON.stringify(f1));
  w(proj, "X.md", "已有");
  check("齐备后不报（template 不改变 require 的判定）", M.evaluate(man, proj, opts).length === 0);

  // src 缺失时的报文：**要说出来**，不许静默退回原文
  const proj2 = mkproj("tpl-missing-src");
  const f2 = M.evaluate({ entries: [tEntry({ id: "tpl2", template: { src: "gone.md", dest: "X.md" } })] }, proj2, opts);
  check("canonical 模板缺失 → 报文显式说明（不静默退化成「AI 自己写一份」）",
    f2.length === 1 && /canonical 模板缺失/.test(f2[0].message), JSON.stringify(f2));

  // 真实清单侧：每条带 template 的条目，其 src 都真的在真实 templates/ 下
  // （上面用的是合成根，这一条才是对真清单的断言）
  const { manifest: realM } = M.load(REAL_MANIFEST);
  const withTpl = ((realM && realM.entries) || []).filter((e) => e.template);
  check("真实清单里带 template 的条目 ≥1（否则这套机器闸是空转的）", withTpl.length >= 1,
    "count=" + withTpl.length);
  check("真实清单每条 template.src 都在 ccswitch/templates/ 下真实存在",
    withTpl.every((e) => fs.existsSync(path.join(M.TEMPLATES_ROOT, e.template.src))),
    "missing=" + withTpl.filter((e) => !fs.existsSync(path.join(M.TEMPLATES_ROOT, e.template.src)))
      .map((e) => e.id).join(","));
  check("真实清单 pr-evidence-rule 的报文不再把真相源指向别的项目（dao-first）",
    (() => { const e = (realM.entries || []).find((x) => x.id === "pr-evidence-rule");
             return !!e && !/mousse-cli/.test(e.msg); })(),
    JSON.stringify((realM.entries || []).find((x) => x.id === "pr-evidence-rule") || {}).slice(0, 200));
}

// ── 清理 ────────────────────────────────────────────────────────────────────
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
