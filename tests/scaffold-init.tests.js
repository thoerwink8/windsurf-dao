// 新项目 bootstrap 闭环 · 两态自证（CLAUDE.md 骨架 + dao-scaffold-report 退出码 + 触发闭环）
//
// 跑法：node tests/scaffold-init.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 验的是哪一层 ────────────────────────────────────────────────────────────
// 三件事，每件都给两态：
//   ① **骨架不许自伤**——CLAUDE.md 骨架一落地就必须过得了另外两条闸（行数预算、
//      不误触其他以 CLAUDE.md 为判据面的条目）。这是最容易在评审里被放过的一类缺陷：
//      模板本身「看起来没问题」，坏的是它与已有闸的**相互作用**。
//   ② **报告脚本的退出码三态**——0 / 1 / 2 必须两两区分得开。承重的是 `2`：
//      「没查成」与「查了没事」若在唯一的机器可读通道上长得一样，整条 `--init` 循环
//      就建立在一个分不清的信号上。
//   ③ **product-type 触发闭环真的闭上了**（B6 的承重断言）——空仓里那一档条目
//      **结构上不存在**；把骨架物化进去 ⇒ 它们出现；把声明那一行删掉 ⇒ 它们又消失。
//      三态一起看才证明「开关是那一行」，只验其中一态两个方向都夹不住。
//
// ── 它**不**证明什么（别把全绿读成「新项目接入 dao 已经没问题」）──────────
// · 不证明骨架里的话写得对——那是人的判断。
// · 不证明 `--init` 流程被执行者照做了：流程写在 SKILL.md 里，是**槽位档不是机检档**，
//   没有任何程序在核「他有没有重跑第 ④ 步」。本文件夹得住的只是那些步骤所依赖的机件。
// · 不证明报告里给出的复制指令在别的 shell / 别的平台上跑得通（指令是 PowerShell 形态，
//   由 lib 的 copyInstruction 生成，本文件只断言它被带进了报文）。

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const LIB = path.join(REPO, "ccswitch", "lib", "scaffold-manifest.js");
const SCRIPT = path.join(REPO, "ccswitch", "scripts", "dao-scaffold-report.mjs");
const TEMPLATE = path.join(REPO, "ccswitch", "templates", "CLAUDE.md.template");
const REAL_MANIFEST = path.join(REPO, "ccswitch", "scaffold-manifest.json");
const SANDBOX = path.join(REPO, "_tmp", "scaffold-init-sandbox");

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
// 让一个沙箱项目满足**全部 universal 条目**，好让后续断言只反映被测的那一维。
// 2026-08-02：CLAUDE.md 里补了**负向自我声明**——`product-type-answered` 上线后，
// 「这道必答题一个字都没答」本身就是一条 universal 缺项，不补的话这个夹具不再叫「齐备」，
// 而下面那条「未声明产品型 → exit 0」验的就不再是它本来要验的东西了。
// 判据词从 lib 实读、不硬编：写死那六个字会在负向串改动时静默过期。
function mkCleanProj(name, extra) {
  const neg = M.PRODUCT_TYPE_NEGATIVE_WHEN.fileContains.text;
  return mkproj(name, (root) => {
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
    w(root, ".gitignore", "**/_tmp/\nnode_modules/\n");
    w(root, "CLAUDE.md", `# 某项目\n\n本仓是**${neg}**。\n\n- 一条项目铁律\n`);
    if (extra) extra(root);
  });
}
function run(projectRoot, extraEnv, args) {
  const r = spawnSync(process.execPath, [SCRIPT].concat(args || []).concat(projectRoot ? [projectRoot] : []), {
    encoding: "utf8",
    env: Object.assign({}, process.env, extraEnv || {}),
  });
  const out = String(r.stdout || "");
  const m = /SCAFFOLD_REPORT_SUMMARY exit=(\d+) findings=(\d+) materialize=(\d+) assisted=(\d+) advise=(\d+) errors=(\d+)/.exec(out);
  return {
    code: r.status, out, err: String(r.stderr || ""),
    sum: m ? { exit: +m[1], findings: +m[2], materialize: +m[3], assisted: +m[4], advise: +m[5], errors: +m[6] } : null,
  };
}

const { manifest: REAL } = M.load(REAL_MANIFEST);
const REAL_ENTRIES = (REAL && REAL.entries) || [];
function entryById(id) { return REAL_ENTRIES.find((e) => e.id === id) || null; }

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== ① CLAUDE.md 骨架：不许一落地就撞别的闸 ===");
const tplRaw = fs.existsSync(TEMPLATE) ? fs.readFileSync(TEMPLATE, "utf8") : null;
check("canonical 骨架 ccswitch/templates/CLAUDE.md.template 存在", tplRaw !== null);

{
  const e = entryById("claude-md");
  check("claude-md 条目带 template 且指向该骨架",
    !!(e && e.template && e.template.src === "CLAUDE.md.template"),
    "template=" + JSON.stringify(e && e.template));
  check("template.dest 与 require 查的路径一致（否则照报文复制完闸还是红）",
    !!(e && e.template && e.template.dest === M._internal.simpleRequirePath(e.require)),
    "dest=" + (e && e.template && e.template.dest));
}

if (tplRaw !== null) {
  // 行数预算：**不写死 80**，从 claude-md-size 条目实读——写死会在预算改了之后静默过期。
  const sizeEntry = entryById("claude-md-size");
  const budget = sizeEntry && sizeEntry.require && sizeEntry.require.maxLines ? sizeEntry.require.maxLines.n : null;
  const tplLines = tplRaw.split(/\r?\n/).length;
  check("能从清单读出 CLAUDE.md 的行数预算（读不出就无从判断骨架大小）", budget !== null);
  // 硬线：**刚复制完、一个字没填**的那一刻就必须过得了行数闸。否则 `--init` 的第 ②
  // 步一落地就欠下第 ③ 条闸，而人会以为是自己写多了。
  check(`骨架原样落地即不超预算（${tplLines} 行 ≤ ${budget}）`, budget !== null && tplLines <= budget);

  // 留白：**按填完之后的体积算，不按原样算**。骨架里的 HTML 注释是"用完就删"的施工说明
  // （canonical 头注 + 必答题说明），拿它们占预算等于把脚手架算进楼的层高。
  // 20 这个数的三问：①改小 ⇒ 项目连「这是什么 + 两三条铁律 + 验证入口」都写不下；
  // ②当前值够不够 ⇒ 实测余量见 detail；③再大 ⇒ 骨架装不下必答题与归位表，而那两块是承重物。
  const tplFilled = tplRaw.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/).filter((l) => l.trim() !== "").length;
  check(`骨架给项目留够余量（删掉施工注释后 ${tplFilled} 行，余 ${budget - tplFilled} ≥ 20）`,
    budget !== null && budget - tplFilled >= 20, `filled=${tplFilled} raw=${tplLines} budget=${budget}`);

  // 自我声明恰好一次：说明文字里若把那五个字再写一遍，**注释本身就会把开关打开**，
  // 于是「删掉那一行」这个动作失效——而它看起来完全正常。判据词从 lib 实读，不硬编。
  const decl = M.PRODUCT_TYPE_WHEN.fileContains.text;
  const neg = M.PRODUCT_TYPE_NEGATIVE_WHEN.fileContains.text;
  const declCount = tplRaw.split(decl).length - 1;
  check(`骨架里自我声明「${decl}」恰好出现 1 次（说明文字里再写一遍 = 注释自己把开关打开）`,
    declCount === 1, "count=" + declCount);

  // 负向串（2026-08-02）：骨架**必须**写出它的原文——那是给人抄的答案，不给就等于没告诉人
  // 「不是」怎么答；但它只准活在注释里。两条一起才夹得住：**注释是施工说明，正文才是答案**。
  // 反向若让它落进正文，骨架就同时写了两个答案（按「是」处理，而人会以为自己答了「不是」）。
  const negCount = tplRaw.split(neg).length - 1;
  const tplLive = tplRaw.replace(/<!--[\s\S]*?-->/g, "");
  check(`骨架里负向串「${neg}」恰好出现 1 次（不给原文 = 没告诉人「不是」怎么答）`,
    negCount === 1, "count=" + negCount);
  check("负向串只出现在注释里、正向串留在正文（删掉全部注释后：正向在、负向不在）",
    tplLive.indexOf(decl) !== -1 && tplLive.indexOf(neg) === -1,
    `live 含正向=${tplLive.indexOf(decl) !== -1} live 含负向=${tplLive.indexOf(neg) !== -1}`);

  // 其余以 CLAUDE.md 为判据面的触发词：骨架里必须 0 次。
  // 清单里已有一条 dispatch-hub-playbook 用 CLAUDE.md 子串当 when —— 骨架若顺手写了那几个字，
  // 每个新项目一落地就会被报「缺 DISPATCH-HUB.md」。判据面从清单**遍历**得出，不靠人记。
  // **两个答案串按值排除**（不是按条目 id 排除）：骨架必然含它们，那是这道必答题的答案词汇本身，
  // 而不是「误触别的条目」。排除面刻意收到这两个值——按 id 排除会把该条目将来新增的其他
  // 判据面一起放过去，那是把豁免开大。
  const answerTexts = new Set([decl, neg]);
  const otherTexts = [];
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.fileContains && node.fileContains.path === "CLAUDE.md" && !answerTexts.has(node.fileContains.text)) {
      otherTexts.push(node.fileContains.text);
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  })({ entries: REAL_ENTRIES });
  const accidental = otherTexts.filter((t) => tplRaw.indexOf(t) !== -1);
  check(`骨架不误触其他以 CLAUDE.md 为判据面的条目（扫到 ${otherTexts.length} 个触发词）`,
    accidental.length === 0, "误触=" + JSON.stringify(accidental));
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== ② dao-scaffold-report 退出码三态（0 / 1 / 2 两两区分）===");
{
  const proj = mkCleanProj("clean-internal-tool");
  const r = run(proj);
  check("全部 universal 齐备且答了「内部工具」→ exit 0", r.code === 0, "code=" + r.code + " out=" + r.out.slice(-400));
  check("exit 0 也打印汇总行（缺了就没法机器判「跑过」）", !!r.sum && r.sum.exit === 0 && r.sum.findings === 0,
    "sum=" + JSON.stringify(r.sum));
}
{
  const proj = mkproj("bare-repo");   // 空目录：什么都没有
  const r = run(proj);
  check("空项目 → exit 1（有缺项，不是错误）", r.code === 1, "code=" + r.code);
  check("空项目 → 至少一条可物化（CLAUDE.md 骨架）", !!r.sum && r.sum.materialize >= 1, "sum=" + JSON.stringify(r.sum));
  check("报文带零编辑复制指令（template 字段的产出真的进了报文）",
    /零编辑复制 canonical/.test(r.out) && /Copy-Item/.test(r.out), "out=" + r.out.slice(0, 600));
  check("分档三列合计 = 缺项数（没有条目掉出分档）",
    !!r.sum && r.sum.materialize + r.sum.assisted + r.sum.advise === r.sum.findings, "sum=" + JSON.stringify(r.sum));
}
{
  const bad = path.join(SANDBOX, "broken-manifest.json");
  fs.writeFileSync(bad, "{ 这不是 JSON", "utf8");
  const r = run(mkproj("with-broken-manifest"), { DAO_SCAFFOLD_MANIFEST: bad });
  check("坏清单 → exit 2（**没查成**，与 0 必须分得开）", r.code === 2, "code=" + r.code);
  check("exit 2 路径也打印汇总行（只在成功时打摘要 = 失败态静默）",
    !!r.sum && r.sum.exit === 2 && r.sum.errors >= 1, "sum=" + JSON.stringify(r.sum));
  check("exit 2 明说「一条都没查」，不许被读成零缺项", /一条都没查/.test(r.out), "out=" + r.out.slice(0, 400));
}
{
  const r = run(path.join(SANDBOX, "does-not-exist-at-all"));
  check("项目根不存在 → exit 2 而不是 0", r.code === 2, "code=" + r.code);
}
{
  // --json 与人读输出必须给同一个判定：两条通道各说各的比只有一条更糟。
  const proj = mkproj("json-mode");
  const r = run(proj, null, ["--json"]);
  let parsed = null;
  try { parsed = JSON.parse(r.out.split("SCAFFOLD_REPORT_SUMMARY")[0]); } catch (_) {}
  check("--json → 输出可解析且 exit 与人读模式一致", r.code === 1 && !!parsed && parsed.counts.findings > 0,
    "code=" + r.code + " parsed=" + (parsed ? "ok" : "null"));
  check("--json 的每条 finding 都带档位（分档不是人读模式专属）",
    !!parsed && parsed.findings.every((f) => ["物化", "代做", "只建议"].includes(f.tier)),
    "tiers=" + JSON.stringify(parsed && parsed.findings.map((f) => f.tier)));
}

console.log("\n=== ②b 分档判据两态（甲/丙各夹一次）===");
{
  const proj = mkCleanProj("has-redundant-entry", (root) => {
    w(root, "AGENT_GUIDE.md", "冗余入口\n");
  });
  const r = run(proj, null, ["--json"]);
  let parsed = null;
  try { parsed = JSON.parse(r.out.split("SCAFFOLD_REPORT_SUMMARY")[0]); } catch (_) {}
  const f = parsed && parsed.findings.find((x) => x.id === "no-redundant-agent-guide");
  check("删除/搬移类（require 顶层 not）→ 判为「只建议」，永不代做",
    !!f && f.tier === "只建议", "finding=" + JSON.stringify(f));
}
{
  const proj = mkproj("materialize-tier");
  const r = run(proj, null, ["--json"]);
  let parsed = null;
  try { parsed = JSON.parse(r.out.split("SCAFFOLD_REPORT_SUMMARY")[0]); } catch (_) {}
  const f = parsed && parsed.findings.find((x) => x.id === "claude-md");
  check("带 template 的条目 → 判为「物化」", !!f && f.tier === "物化", "finding=" + JSON.stringify(f));
  const g = parsed && parsed.findings.find((x) => x.id === "tmp-gitignored");
  check("补一行类（fileContains）→ 判为「代做」而非「物化」（`_tmp/` 与 `**/_tmp/` 都过闸，机器判不出该写哪个）",
    !!g && g.tier === "代做", "finding=" + JSON.stringify(g));
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== ③ product-type 触发闭环：三态（不存在 → 物化后出现 → 删声明后消失）===");
// 这是 B6 的承重断言。2026-08-01 审计的原始发现是：**没有任何东西会把那句自我声明
// 写进新项目** ⇒ 那一档检查结构上永不触发。下面三态一起看才证明「开关是骨架里那一行」。
{
  const PT_IDS = REAL_ENTRIES.filter((e) => e.class === "product-type").map((e) => e.id);
  check("清单里确有 product-type 条目（否则本组三态是空转的）", PT_IDS.length >= 1, "ids=" + PT_IDS.join(","));

  const proj = mkproj("trigger-loop");
  fs.mkdirSync(path.join(proj, ".claude", "rules"), { recursive: true });
  w(proj, ".gitignore", "**/_tmp/\n");

  const before = M.evaluate(REAL, proj).map((f) => f.id);
  check("态一 · 空仓（无 CLAUDE.md）→ product-type 那一档一条都不出现（结构上不触发）",
    PT_IDS.every((id) => !before.includes(id)), "before=" + JSON.stringify(before));

  // 态二：把 canonical 骨架物化进去（等价于 `--init` 第 ② 步跑那条复制指令）
  fs.copyFileSync(TEMPLATE, path.join(proj, "CLAUDE.md"));
  const after = M.evaluate(REAL, proj).map((f) => f.id);
  check("态二 · 物化骨架（保留声明行）→ product-type 那一档全部出现（闭环闭上了）",
    PT_IDS.every((id) => after.includes(id)), "after=" + JSON.stringify(after));
  check("态二附 · 骨架落地后不再报「缺少 CLAUDE.md」，也不撞行数闸",
    !after.includes("claude-md") && !after.includes("claude-md-size"), "after=" + JSON.stringify(after));

  // 态三：答「内部工具」——把那一行**换成负向声明**（2026-08-02 起的处置方式；
  // 旧处方是删掉那一行，而删完之后「答了，不是」与「从没答过」在机器侧逐字节相同）。
  const decl = M.PRODUCT_TYPE_WHEN.fileContains.text;
  const neg = M.PRODUCT_TYPE_NEGATIVE_WHEN.fileContains.text;
  const negText = fs.readFileSync(path.join(proj, "CLAUDE.md"), "utf8")
    .split(/\r?\n/).map((l) => (l.indexOf(decl) !== -1 ? `本仓是**${neg}**。` : l))
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "");   // 骨架说「答完把注释删掉」——负向串的原文就在注释里
  fs.writeFileSync(path.join(proj, "CLAUDE.md"), negText, "utf8");
  const afterNeg = M.evaluate(REAL, proj).map((f) => f.id);
  check("态三 · 换成负向声明（答「内部工具」）→ product-type 那一档又全部消失",
    PT_IDS.every((id) => !afterNeg.includes(id)), "afterNeg=" + JSON.stringify(afterNeg));
  check("态三附 · 换的只是那一档，CLAUDE.md 本身仍算齐备（没把骨架改坏）",
    !afterNeg.includes("claude-md"), "afterNeg=" + JSON.stringify(afterNeg));
  // 承重的一条：**答了「不是」不该被当成「没答」**。删注释是骨架自己教的动作，
  // 若负向串只活在注释里，照着骨架做完的项目会被本条永久唠叨——那就是给正确答案造噪音。
  check("态三附 · 答了「不是」⇒ 必答题条目**不**报（正确答案不该被当成没答）",
    !afterNeg.includes("product-type-answered"), "afterNeg=" + JSON.stringify(afterNeg));

  // 态四：**一个都不答**（旧处方的结果，也是所有成文于该机制之前的存量项目的现状）
  // ⇒ 必答题条目必须报，且 product-type 那一档仍然不查。
  // 这一态是本批（2026-08-02 审计第 2 件）的承重断言：它与态三合起来才证明
  // 「答了，不是」与「从没答过」**分得开**——只验其中一态，两个方向都夹不住。
  const noneText = negText.split(/\r?\n/).filter((l) => l.indexOf(neg) === -1).join("\n");
  fs.writeFileSync(path.join(proj, "CLAUDE.md"), noneText, "utf8");
  const afterNone = M.evaluate(REAL, proj).map((f) => f.id);
  check("态四 · 两个串都没有（存量项目现状）→ 必答题条目报出",
    afterNone.includes("product-type-answered"), "afterNone=" + JSON.stringify(afterNone));
  check("态四附 · 没答 ⇒ product-type 那一档仍不查（必答题不改开关语义，只让「没答」可见）",
    PT_IDS.every((id) => !afterNone.includes(id)), "afterNone=" + JSON.stringify(afterNone));
  check("态二回看 · 答「是」时必答题条目也不报（三态里唯一会报的是态四）",
    !after.includes("product-type-answered"), "after=" + JSON.stringify(after));
  check("态四附 · 连 CLAUDE.md 都没有的空仓不报必答题（那由 claude-md 条目管，两条一起报是重复噪音）",
    !before.includes("product-type-answered"), "before=" + JSON.stringify(before));
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== ④ 「缺项不自动创建」那块砖不许长回来（它本来就有五处，不是一处）===");
// 2026-08-01 实测：那句话在本 skill 里有 **5 处**（SKILL.md 1 + frontend-gate 3 +
// ci-cost-gate 1 + desktop-debug-gate 1 + design-assets 1，共 7 行）。只改 SKILL.md
// 等于「补丁打在了不会被触发的地方」—— 而 SKILL.md 的 §TODO.md 存废判据 正是本 skill
// 上一次踩同一个坑的记录（补了检查清单那一条，漏了另外四处）。故这里给它一道机检。
//
// **允许引用历史原文**：判据是「这一行是不是现行指令」，不是「这几个字出现过没有」——
// 以 `>` 开头的引用块在解释「原来那句话是什么、为什么换掉」，删掉它反而销毁记录。
{
  const SKILL_DIR = path.join(REPO, "ccswitch", "skills", "dao-project-scaffold");
  const BRICK = /缺项不自动创建|建议用户创建/;
  const offenders = [];
  for (const f of fs.readdirSync(SKILL_DIR).filter((n) => n.endsWith(".md"))) {
    const lines = fs.readFileSync(path.join(SKILL_DIR, f), "utf8").split(/\r?\n/);
    lines.forEach((l, i) => {
      if (BRICK.test(l) && !l.trimStart().startsWith(">")) offenders.push(`${f}:${i + 1}`);
    });
  }
  check("本 skill 各文件不再把「缺项不自动创建/建议用户创建」当现行指令（引用块除外）",
    offenders.length === 0, "offenders=" + JSON.stringify(offenders));

  // 反向：三档判据的真相源必须真的在 SKILL.md 里，否则上面各文件的指针指向空气。
  const skill = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  check("SKILL.md 里确有 §缺项怎么处置（各 supporting file 的指针有落点）",
    /##\s*缺项怎么处置/.test(skill), "无该节 ⇒ 五处指针全指向空气");
  check("SKILL.md 里确有 §`--init` 一键物化 与 §项目类型必答题（另两处被指向的节）",
    /##\s*`--init` 一键物化/.test(skill) && /###\s*项目类型必答题/.test(skill));
}

// ── 清理 ────────────────────────────────────────────────────────────────────
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
