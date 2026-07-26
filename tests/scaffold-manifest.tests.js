// 共性 rule 备案清单 · 两态自证（schema 校验 + 谓词求值 + 端到端缺项报出）
//
// 跑法：node tests/scaffold-manifest.tests.js   （全绿 exit 0，任一红 exit 1）
//
// 验的是哪一层：**清单本体合法 + 求值器每种谓词的两态 + 三分类的机器闸**。
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
  check("三分类：universal 与 conditional 各至少一条",
    es.some((e) => e.class === "universal") && es.some((e) => e.class === "conditional"),
    "classes=" + JSON.stringify(es.map((e) => e.class)));
  check("每条 conditional 都带机器可判的 when",
    es.filter((e) => e.class === "conditional").every((e) => !!e.when));
  check("每条 universal 都不带 when（无条件共性）",
    es.filter((e) => e.class === "universal").every((e) => !e.when));
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
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== schema 校验：合法通过 / 各类非法被挡（两态）===");
{
  check("负控：合法最小清单零错误", M.validate({ entries: [entry()] }).length === 0,
    JSON.stringify(M.validate({ entries: [entry()] })));
  check("entries 非数组 → 报错", M.validate({}).length > 0);
  check("class 非法值（如 project-specific）→ 报错",
    M.validate({ entries: [entry({ class: "project-specific" })] }).some((e) => /class 非法/.test(e)));
  check("conditional 缺 when → 报错（三分类机器闸的一侧）",
    M.validate({ entries: [entry({ class: "conditional" })] }).some((e) => /必须带 when/.test(e)));
  check("universal 带 when → 报错（三分类机器闸的另一侧）",
    M.validate({ entries: [entry({ when: { dir: "src-ui" } })] }).some((e) => /不得带 when/.test(e)));
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

// ── 清理 ────────────────────────────────────────────────────────────────────
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
