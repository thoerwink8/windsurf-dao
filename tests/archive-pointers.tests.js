// archive-pointers.tests.js — 档案层指针闸（ccswitch/scripts/check-archive-pointers.mjs）的自测
//
// ── 这套回归网为什么重新出现（issue #284）───────────────────────────────────
// 原回归网 tests/archive-pointers.tests.js 在 2026-08-12 前后的测试重设计批次里被删掉，
// 守卫脚本本身却继续独立存在——变成一道没人跑、没接进 dao-check 的孤儿闸（2026-08-13 侦察
// 官核实：`node scripts/dao-check.mjs` 19 项全绿，`grep archive-pointers scripts/dao-check.mjs`
// 零命中）。本文件把它接回来：dao-check.mjs 的 checkGateSelfTests() 自动发现 `tests/*.tests.js`，
// 不需要手工登记。
//
// ── 本批同时补的两个盲区（issue #284 清单第 1、2 项，六项里按价值取舍只做这两项，
//    理由见 PR 正文）───────────────────────────────────────────────────────────
//   ① 折行容错：注释续行把「路径」或「§ 锚点」拆到下一行时，原闸完全看不见。
//   ② 扫描面最小样本自检：TEXT_EXT 收窄 / SKIP_DIRS 放大 / REF_RE 收窄，会让扫描面悄悄
//      变小而闸不出声（`missfile`/`missanchor` 都是 0）。新退出码 6。
// 下面 §⑦、§⑧ 专测这两个盲区；§①–§⑥ 是从被删除版本迁回并同步锚点的既有判据（存在性/
// 锚点/塌陷/零样本/历史豁免/用法错），迁回时行为不变，只有内部实现的锚点行随源码同步更新。
//
// ── 2026-08-13 补丁（对抗审 PR #403 红项）：折行容错㈡对 CRLF 静默失效 ─────────
// 原版 §⑦ 夹具全用 LF 写，套件绿；本仓工作树 196/201 个文本文件是 CRLF，折行容错㈡在
// CRLF 上锚点续行永远追不到（`check-archive-pointers.mjs` 折行容错㈡旁头注有机制说明）。
// `foldRepo()` 加了可选 `eol` 参数（默认 "\n"，不改既有 LF 夹具的行为），§⑦ 新增一段
// CRLF 正控，钉住这个行尾态。
//
// 🔴 **本文件里的档案层路径字面一律拼出来（`EVO + "x.md"`），不写整串**：被守对象的扫描面
// 包含 tests/ 目录，写了整串会被真仓那一趟扫到、当成假样本。§⑨ 有一条断言钉住这个拼法奏效。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const GUARD = path.join(REPO, "ccswitch", "scripts", "check-archive-pointers.mjs");
const TMP = path.join(REPO, "_tmp", "archive-pointers-tests");

const EVO = "docs/" + "evolution/";

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}
function sha(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
function w(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, "utf8"); return p; }

const MARKER_RE = /ARCHIVE_POINTERS_SUMMARY exit=(\d+) scanned=(\d+) refs=(\d+) anchors=(\d+) targets=(\d+) missfile=(\d+) missanchor=(\d+) litfiles=(\d+) hist=(\d+) folded=(\d+) indeplit=(\d+) blind=(\d+)/;
function run(args, script) {
  const r = spawnSync(process.execPath, [script || GUARD, ...args], { encoding: "utf8" });
  const out = String(r.stdout || "") + String(r.stderr || "");
  const m = MARKER_RE.exec(out);
  return {
    code: r.status, out,
    marker: m ? {
      exit: +m[1], scanned: +m[2], refs: +m[3], anchors: +m[4], targets: +m[5], missfile: +m[6],
      missanchor: +m[7], litfiles: +m[8], hist: +m[9], folded: +m[10], indeplit: +m[11], blind: +m[12],
    } : null,
  };
}

const PRISTINE = sha(GUARD);

// ── 合成语料：一棵假仓，两侧样本都有 ─────────────────────────────────────────
function makeRepo(tag) {
  const root = path.join(TMP, tag);
  w(path.join(root, "docs", "evolution", "arc.md"),
    "# 假归档\n\n## C1 · 第一段\n\n正文\n\n## C2 · 第二段\n\n正文\n");
  w(path.join(root, "docs", "evolution", "lessons.csv"), "a,b\n1,2\n");
  const lines = [
    "// ① 好指针：文件在、锚点在",
    `// 见 ${EVO}arc.md §C1`,
    "// ② 好指针：一条引用后面挂两个锚点（多段形态）",
    `// 见 ${EVO}arc.md §C1/§C2`,
    "// ③ 好指针：没有锚点，只核文件在不在",
    `// 见 ${EVO}lessons.csv`,
    "// ④ 死指针 A：被指的文件根本不在盘上",
    `// 见 ${EVO}gone.md`,
    "// ⑤ 死指针 B：文件在，但锚点被撤了",
    `// 见 ${EVO}arc.md §C9`,
    "// ⑥ 负控：带通配符的写法不匹配",
    `// 见 ${EVO}arc-*.md`,
    "// ⑦ 负控：`git show <sha>:…` 是历史引用，不该判红",
    `// git show deadbee:${EVO}retired.md`,
  ];
  w(path.join(root, "src", "a.js"), lines.join("\n") + "\n");
  return root;
}

console.log("\n──── ① 正控 + 负控：存在性 / 锚点 / 历史豁免 ────");
const repoA = makeRepo("repoA");
const rA = run(["--repo", repoA]);
{
  check("末行 marker 存在且 exit 与进程退出码一致", !!rA.marker && rA.marker.exit === rA.code, JSON.stringify(rA.marker));
  check("🔴 有死指针 ⇒ exit 1（不是静默 0）", rA.code === 1, JSON.stringify(rA.marker));
  check("正控：文件缺失被点名（gone.md）", /gone\.md/.test(rA.out) && rA.marker.missfile === 1, JSON.stringify(rA.marker));
  check("正控：锚点缺失被点名（C9），与文件缺失分开计数", /C9/.test(rA.out) && rA.marker.missanchor === 1, JSON.stringify(rA.marker));
  check("正控：报文给出「文件:行号」", /src\/a\.js:\d+/.test(rA.out), rA.out.slice(0, 400));
  check("正控：多段锚点都被收（anchors = C1 + C1/C2 + C9 = 4）", rA.marker.anchors === 4, JSON.stringify(rA.marker));
  check("负控：通配符不匹配", !/arc-\*\.md/.test(rA.out), rA.out.slice(0, 500));
  check("🔴 负控：历史引用不判红，且单独计数（hist=1）", rA.marker.hist === 1 && !/retired\.md/.test(rA.out), JSON.stringify(rA.marker));
  check("负控的配对正控：不带 sha 前缀的同名死指针必须红", (() => {
    const r2 = path.join(TMP, "repoPair");
    w(path.join(r2, "docs", "evolution", "arc.md"), "# x\n");
    w(path.join(r2, "src", "b.js"), `// 见 ${EVO}retired.md\n`);
    const x = run(["--repo", r2]);
    return x.code === 1 && /retired\.md/.test(x.out);
  })());
  check("扫描面自检本身在这棵干净语料上不误报（blind=0，无 SKIP_DIRS 外/非 TEXT_EXT 文件）",
    rA.marker.blind === 0, JSON.stringify(rA.marker));
}

console.log("\n──── ② 全绿态：修好死指针 ⇒ exit 0 ────");
{
  const repoB = makeRepo("repoB");
  const p = path.join(repoB, "src", "a.js");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(`${EVO}gone.md`, `${EVO}arc.md`).replace("§C9", "§C2"), "utf8");
  const r = run(["--repo", repoB]);
  check("修好后 exit 0 / missfile=0 / missanchor=0", r.code === 0 && r.marker.missfile === 0 && r.marker.missanchor === 0, JSON.stringify(r.marker));
  check("绿态仍报扫了多少、几处引用", r.marker.refs > 0 && r.marker.scanned > 0 && /引用 \d+ 处/.test(r.out), JSON.stringify(r.marker));
}

console.log("\n──── ③ 零样本 与 扫描面塌陷 必须分得开 ────");
{
  const empty = path.join(TMP, "empty");
  w(path.join(empty, "src", "q.js"), "console.log(1);\n");
  const e = run(["--repo", empty]);
  check("零样本 ⇒ exit 0，打印「零样本」三个字", e.code === 0 && e.marker.refs === 0 && /零样本/.test(e.out), JSON.stringify(e.marker));

  const blind = path.join(TMP, "blind");
  w(path.join(blind, "src", "q.js"), `// 见 ${EVO}notes.txt 那一段\n`);
  const b = run(["--repo", blind]);
  check("🔴 塌陷 ⇒ exit 5，报文明说「瞎了」", b.code === 5 && b.marker.litfiles > 0 && b.marker.refs === 0 && /瞎了/.test(b.out) && /别把这次的 0 当通过/.test(b.out), JSON.stringify(b.marker) + b.out.slice(0, 300));
  check("负控：全是历史引用 ⇒ 不判塌陷（当前行为，理由射程见闸头注）", (() => {
    const h = path.join(TMP, "histonly");
    w(path.join(h, "src", "q.js"), `// git show deadbee:${EVO}retired.md\n`);
    const x = run(["--repo", h]);
    return x.code === 0 && x.marker.hist === 1 && x.marker.refs === 0;
  })());
}

console.log("\n──── ④ 用法错：一条都没扫时不许伪装成通过 ────");
{
  const u = run(["--repo", repoA, "--什么鬼"]);
  check("不认识的参数 ⇒ exit 3", u.code === 3, JSON.stringify(u.marker));
  check("用法错也打 marker", !!u.marker && u.marker.exit === 3 && u.marker.scanned === 0, JSON.stringify(u.marker));
  const q = run(["--repo", repoA, "--quiet"]);
  check("--quiet 只留 marker（退出码不变）", q.code === 1 && q.out.trim().split("\n").length === 1, JSON.stringify(q.out));
}

console.log("\n──── ⑤ mutation：既有四条判据的判别力（存在性/锚点/笨计数器/历史豁免）────");
{
  const src = fs.readFileSync(GUARD, "utf8");
  const EXIST_LINE = '    try { ok = fs.statSync(abs).isFile(); } catch { ok = false; }';
  const ANCHOR_LINE = '      if (!ids.has(a)) problems.push({ kind: "missanchor", ...r, anchor: a, why: `${r.target} 里没有标题 “${a}”` });';
  const DUMB_LINE = '    if (hit) hitFiles.add(path.relative(repoRoot, f).split(path.sep).join("/"));';
  const HIST_LINE = '      if (HIST_RE.test(text.slice(Math.max(0, m.index - 41), m.index))) { hist++; continue; }';
  check("靶点①：文件存在性判定唯一存在", src.split(EXIST_LINE).length === 2, String(src.split(EXIST_LINE).length - 1));
  check("靶点②：锚点缺失上报唯一存在", src.split(ANCHOR_LINE).length === 2, String(src.split(ANCHOR_LINE).length - 1));
  check("靶点③：笨计数器命中登记唯一存在", src.split(DUMB_LINE).length === 2, String(src.split(DUMB_LINE).length - 1));
  check("靶点④：历史引用豁免唯一存在", src.split(HIST_LINE).length === 2, String(src.split(HIST_LINE).length - 1));

  const mut = (tag, body) => w(path.join(TMP, "mut", tag + ".mjs"), body);
  const repoM = makeRepo("repoM");
  const base = run(["--repo", repoM]);
  check("mutation 基线：原件在这份语料上 exit 1 / missfile=1 / missanchor=1", base.code === 1 && base.marker.missfile === 1 && base.marker.missanchor === 1, JSON.stringify(base.marker));

  {
    const r = run(["--repo", repoM], mut("A1", src.split(EXIST_LINE).join("")));
    check("A1 canary：变异体仍跑得起来", r.marker && r.marker.refs > 0, JSON.stringify(r.marker));
    check("A1（移除存在性判定）⇒ 连在盘的档也报缺失，负控变红", r.marker.missfile > 1, JSON.stringify(r.marker));
  }
  {
    const r = run(["--repo", repoM], mut("A2", src.split(EXIST_LINE).join("    // " + EXIST_LINE.trim() + "\n    ok = true;")));
    check("A2 canary：变异体仍跑得起来", r.marker && r.marker.refs > 0, JSON.stringify(r.marker));
    check("🔴 A2（注释掉、恒真）⇒ gone.md 不再被发现，正控变红", r.marker.missfile === 0 && !/gone\.md/.test(r.out), JSON.stringify(r.marker));
  }
  {
    const r = run(["--repo", repoM], mut("B1", src.split(ANCHOR_LINE).join("")));
    check("B1 canary：文件那一半仍在报", r.marker && r.marker.missfile === 1, JSON.stringify(r.marker));
    check("🔴 B1（移除锚点上报）⇒ C9 死指针一声不吭", r.marker.missanchor === 0 && !/C9/.test(r.out), JSON.stringify(r.marker));
  }
  {
    const r = run(["--repo", repoM], mut("B2", src.replace("if (!ids.has(a))", "if (false && !ids.has(a))")));
    check("B2（反向·锚点判据恒真）⇒ 同样变红", r.marker && r.marker.missanchor === 0, JSON.stringify(r.marker));
  }
  {
    const r = run(["--repo", repoM], mut("B3", src.replace("if (!ids.has(a))", "if (true || !ids.has(a))")));
    check("B3（反向·锚点判据恒假）⇒ 好锚点也被报缺，负控变红", r.marker && r.marker.missanchor === 4, JSON.stringify(r.marker));
  }
  {
    // 在补扫描面自检（issue #284 第 2 项）之前，这条 mutation 的旧断言是「塌陷检测被废、
    // 退化成安静的 exit 0」——litfiles 恒 0 之后，塌陷判据 `r.litFiles > 0` 那半也不成立了。
    // 补完自检后行为变了：`indepLit` 不共用 `hitFiles`，仍会数出这份文件，于是
    // `indepLit(1) > litFiles(0)` 触发 indepShrink ⇒ exit 6，而不是原先设想的静默 0。
    // 这是「两半必须独立实现」这条判据带来的**副作用式加固**：一个原本能让 exit 5 判据失明的
    // 变异，被另一半互不相关的自检顺手接住了。断言改成新真值，把这个联动写进条款而不是删掉。
    const blind2 = path.join(TMP, "blind2");
    w(path.join(blind2, "src", "q.js"), `// 见 ${EVO}notes.txt\n`);
    const r = run(["--repo", blind2], mut("C1", src.split(DUMB_LINE).join("")));
    check("C1 canary：仍打得出 marker", !!r.marker, JSON.stringify(r.marker));
    check("🔴 C1（笨计数器恒不登记）⇒ 原塌陷判据失明，但 indepLit 独立于 hitFiles ⇒ 被 indepShrink 接住，exit 6 不是静默 0",
      r.code === 6 && r.marker.litfiles === 0 && r.marker.indeplit > 0, JSON.stringify(r.marker));
  }
  {
    const r = run(["--repo", repoM], mut("D1", src.split(HIST_LINE).join("")));
    check("D1（移除历史引用豁免）⇒ git show 那一处被误判死指针", r.marker && r.marker.hist === 0 && /retired\.md/.test(r.out), JSON.stringify(r.marker));
  }
  {
    // 同样的联动：旧断言是「HIST_RE 恒真 ⇒ 全体活指针被吞、退化成安静的 exit 0 refs=0」。
    // repoM 里大多数引用并不是真的历史引用（没有真 sha: 前缀），`hasStructuredShapedHit` 的
    // 历史豁免判据是自己独立的 `HIST_LIKE_RE`、不共用主解析的 `HIST_RE`，于是它们仍被判定
    // 「本该有结构化引用」而实际 refs 里一条都没有 ⇒ blindFiles 非空 ⇒ exit 6。
    const r = run(["--repo", repoM], mut("D2", src.replace("if (HIST_RE.test(", "if (true || HIST_RE.test(")));
    check("🔴 D2（反向·豁免恒真）⇒ 活指针全被吞成「历史」，但 blindFiles 用独立判据接住 ⇒ exit 6 不是静默 0",
      r.marker && r.code === 6 && r.marker.refs === 0 && r.marker.hist > 0 && r.marker.blind > 0, JSON.stringify(r.marker));
  }

  check("canary 恒等：mutation 过程被守对象逐字节没动过", sha(GUARD) === PRISTINE);
}

console.log("\n──── ⑥ 真仓冒烟：此刻盘上这些指针指得准不准 ────");
{
  const r = run([]);
  check("🔴 真仓 exit 0", r.code === 0, r.out.slice(0, 900));
  check("真仓不是零样本", r.marker.refs > 0 && r.marker.litfiles > 0, JSON.stringify(r.marker));
  check("真仓确实核到了锚点", r.marker.anchors > 0, JSON.stringify(r.marker));
  check("真仓扫描面自检不误报（blind=0，indeplit=litfiles）", r.marker.blind === 0 && r.marker.indeplit === r.marker.litfiles, JSON.stringify(r.marker));
  const mine = r.out.includes("archive-pointers.tests.js");
  check("🔴 本测试文件的合成语料没有漏进真仓扫描面", !mine, r.out.slice(0, 600));
}

console.log("\n──── ⑦ 折行容错：issue #284 第 1 项，先破再验的两种折行形态 ────");
{
  // eol 默认 "\n"（既有 LF 夹具，行为不变）；传 "\r\n" 造 CRLF 夹具——
  // 2026-08-13 对抗审 PR #403 实证本仓 201 个文本文件 196 个是 CRLF，回归网夹具原先全 LF、
  // 与真实工作树行尾分布失真，折行容错㈡在 CRLF 上会静默丢锚（见 check-archive-pointers.mjs
  // 折行容错㈡旁的头注）。`w()` 走 fs.writeFileSync 直接写传入的字节，不做行尾转译，
  // 故这里显式拼 "\r\n" 就是真实的 CRLF 语料，不依赖平台。
  function foldRepo(tag, prefix, eol) {
    const root = path.join(TMP, tag);
    w(path.join(root, "docs", "evolution", "arc.md"), "# 假档\n\n## C1 · 段落\n\n正文\n");
    const P = prefix; // "//" 或 "#"，模拟不同语言的注释记号
    const nl = eol || "\n";
    const lines = [
      `${P} 形态㈠：路径本身被拆两行（本行以 ${EVO} 结尾，档名在下一行）`,
      `${P} 见 ${EVO}`,
      `${P} arc.md`,
      `${P} 形态㈡：路径完整在一行，§ 锚点被拆到下一行`,
      `${P} 见 ${EVO}arc.md`,
      `${P} §C1`,
    ];
    w(path.join(root, "src", `a${prefix === "#" ? ".ps1" : ".js"}`), lines.join(nl) + nl);
    return root;
  }
  for (const prefix of ["//", "#"]) {
    const root = foldRepo(`fold-${prefix === "#" ? "hash" : "slash"}`, prefix);
    const r = run(["--repo", root]);
    check(`折行两形态都被拼回（前缀 "${prefix}"）：refs=2 anchors=1（形态㈠给出一条完整 ref，形态㈡把锚点接回另一条）`,
      r.marker && r.marker.refs === 2 && r.marker.anchors === 1, JSON.stringify(r.marker));
    check(`折行容错命中数计入 folded=（前缀 "${prefix}"）`, r.marker && r.marker.folded >= 1, JSON.stringify(r.marker));
    check(`折行修好后仍是绿灯（前缀 "${prefix}"）`, r.code === 0, r.out.slice(0, 500));
  }

  console.log("  —— 正控：CRLF 行尾下折行两形态同样被拼回（issue #284 对抗审红项，PR #403）——");
  for (const prefix of ["//", "#"]) {
    const root = foldRepo(`fold-crlf-${prefix === "#" ? "hash" : "slash"}`, prefix, "\r\n");
    const r = run(["--repo", root]);
    check(`CRLF：折行两形态都被拼回（前缀 "${prefix}"）：refs=2 anchors=1`,
      r.marker && r.marker.refs === 2 && r.marker.anchors === 1, JSON.stringify(r.marker));
    check(`CRLF：折行容错命中数计入 folded=（前缀 "${prefix}"）`, r.marker && r.marker.folded >= 1, JSON.stringify(r.marker));
    check(`CRLF：折行修好后仍是绿灯（前缀 "${prefix}"）`, r.code === 0, r.out.slice(0, 500));
  }

  console.log("  —— 折行但目标仍是死指针，必须照样判红 ——");
  {
    const root = path.join(TMP, "fold-dangling");
    w(path.join(root, "docs", "evolution", "arc.md"), "# 假档\n\n## C1 · 段落\n\n正文\n");
    const lines = [
      "# 折行但被指的档根本不在",
      `# 见 ${EVO}`,
      "# gone.md",
      "# 折行但锚点根本不在",
      `# 见 ${EVO}arc.md`,
      "# §C9",
    ];
    w(path.join(root, "src", "a.ps1"), lines.join("\n") + "\n");
    const r = run(["--repo", root]);
    check("折行拼出来的死指针（缺文件）依旧红", r.code === 1 && /gone\.md/.test(r.out), JSON.stringify(r.marker) + r.out.slice(0, 400));
    check("折行拼出来的死指针（缺锚点）依旧红", /C9/.test(r.out), r.out.slice(0, 600));
  }

  console.log("  —— mutation：两种折行判据各自的判别力 ——");
  const src = fs.readFileSync(GUARD, "utf8");
  const FOLD1_LINE = '      if (!/docs\\/evolution\\/[ \\t]*$/.test(lines[li])) continue;';
  const FOLD2_LINE = '        if (/^[ \\t]*\\r?$/.test(restOnLine) && lineNo < lines.length) {';
  check("靶点⑤：折行㈠判据唯一存在", src.split(FOLD1_LINE).length === 2, String(src.split(FOLD1_LINE).length - 1));
  check("靶点⑥：折行㈡判据唯一存在", src.split(FOLD2_LINE).length === 2, String(src.split(FOLD2_LINE).length - 1));

  const foldRoot = foldRepo("fold-mut-base", "#");
  const mut = (tag, body) => w(path.join(TMP, "mut", tag + ".mjs"), body);
  {
    // 靶点⑤永远为假 ⇒ 形态㈠再也拼不回来（continue 恒成立，循环体后半永远跑不到）
    const r = run(["--repo", foldRoot], mut("F1", src.split(FOLD1_LINE).join("      if (true) continue;")));
    check("F1 canary：变异体仍跑得起来", r.marker && r.marker.scanned > 0, JSON.stringify(r.marker));
    check("🔴 F1（折行㈠判据恒真放弃）⇒ refs 少了形态㈠那一条，folded 也跟着掉", r.marker && r.marker.refs === 1, JSON.stringify(r.marker));
  }
  {
    // 靶点⑥永远为假 ⇒ 形态㈡的锚点续行再也接不回来
    const r = run(["--repo", foldRoot], mut("F2", src.split(FOLD2_LINE).join('        if (false) {')));
    check("F2 canary：变异体仍跑得起来", r.marker && r.marker.scanned > 0, JSON.stringify(r.marker));
    check("🔴 F2（折行㈡判据恒假放弃）⇒ anchors 少了形态㈡那个锚点", r.marker && r.marker.anchors === 0, JSON.stringify(r.marker));
  }
  check("canary 恒等：折行 mutation 过程没有动过原件", sha(GUARD) === PRISTINE);
}

console.log("\n──── ⑧ 扫描面自检：issue #284 第 2 项，先破再验的两条自检轴 ────");
{
  console.log("  —— 轴㈠ indepShrink：TEXT_EXT/SKIP_DIRS 把文件排除出扫描面（不改源码，靠真实配置边界造出） ——");
  {
    // .ini 不在 TEXT_EXT 里：production walk() 找不到它，笨计数器/主解析都摸不到；
    // 独立遍历 walkAll() 没有扩展名过滤，会摸到 ⇒ 天然制造 litfiles < indeplit，不用改源码。
    const root = path.join(TMP, "shrink-ext");
    w(path.join(root, "docs", "evolution", "arc.md"), "# 假档\n\n## C1 · 段落\n\n正文\n");
    w(path.join(root, "src", "a.js"), `// 见 ${EVO}arc.md §C1\n`);
    w(path.join(root, "src", "config.ini"), `; 见 ${EVO}arc.md §C1\n`);
    const r = run(["--repo", root]);
    check("TEXT_EXT 之外的文件让独立遍历数得比主扫描面多 ⇒ exit 6", r.code === 6 && r.marker.indeplit > r.marker.litfiles, JSON.stringify(r.marker));
    check("报文点名是扫描面自检异常，不是别的错", /扫描面自检异常/.test(r.out) && /TEXT_EXT\/SKIP_DIRS/.test(r.out), r.out.slice(0, 600));
  }
  {
    // dist/ 在 SKIP_DIRS 里但不在 INDEPENDENT_SKIP 里：production walk() 跳过整个目录；
    // walkAll() 只硬排 .git/_tmp，照样会进 dist/ ⇒ 同样天然制造缩水信号。
    const root = path.join(TMP, "shrink-dir");
    w(path.join(root, "docs", "evolution", "arc.md"), "# 假档\n\n## C1 · 段落\n\n正文\n");
    w(path.join(root, "src", "a.js"), `// 见 ${EVO}arc.md §C1\n`);
    w(path.join(root, "dist", "bundled.js"), `// 见 ${EVO}arc.md §C1\n`);
    const r = run(["--repo", root]);
    check("SKIP_DIRS 排除的目录被独立遍历看见 ⇒ exit 6", r.code === 6 && r.marker.indeplit > r.marker.litfiles, JSON.stringify(r.marker));
  }
  console.log("  —— 负控：健康仓（没有射程外文件）不许被自检误报 ——");
  {
    const root = path.join(TMP, "shrink-healthy");
    w(path.join(root, "docs", "evolution", "arc.md"), "# 假档\n\n## C1 · 段落\n\n正文\n");
    w(path.join(root, "src", "a.js"), `// 见 ${EVO}arc.md §C1\n`);
    const r = run(["--repo", root]);
    check("负控：干净语料 exit 0，indeplit == litfiles，blind=0", r.code === 0 && r.marker.indeplit === r.marker.litfiles && r.marker.blind === 0, JSON.stringify(r.marker));
  }
  console.log("  —— 负控：本闸自己刻意声明过的 glob 提及不该被判成 blindFiles ——");
  {
    // 只提「EVO + *」这种目录级 glob 说法，不该被 structuredShapedHitFiles 当成
    // 「本该有结构化引用」——见闸头注「glob 形态看不见」那条既有的、刻意的不覆盖声明。
    const root = path.join(TMP, "shrink-glob-noise");
    w(path.join(root, "docs", "evolution", "arc.md"), "# 假档\n\n## C1 · 段落\n\n正文\n");
    w(path.join(root, "src", "a.js"), `// 见 ${EVO}arc.md §C1\n// 泛指整层：${EVO}*\n`);
    const r = run(["--repo", root]);
    check("glob 提及不制造 blindFiles 误报", r.code === 0 && r.marker.blind === 0, JSON.stringify(r.marker));
  }

  console.log("  —— 轴㈡ blindFiles：REF_RE 抽不出但笨计数器认得出的文件（用真实扩展名边界造，不改源码）——");
  {
    // REF_RE 只认 .md/.csv；给一个「紧跟字母、没有 *」但扩展名是 .txt 的引用——
    // 笨计数器判定「有字面」，REF_RE 却抽不出结构化引用 ⇒ 天然的 blindFiles 命中。
    // 另配一条真正结构化的引用（不同文件），让 refs.length > 0——否则全仓就这一条字面命中时
    // 会先撞上 exit 5（塌陷：refs=0 且 litfiles>0）而不是走到这里要测的 exit 6（blindFiles）；
    // 两者优先级本就是「全瞎」盖过「局部瞎」，这个安排是为了单独测出 blindFiles 那一路。
    const root = path.join(TMP, "shrink-blind");
    w(path.join(root, "docs", "evolution", "arc.md"), "# 假档\n\n## C1 · 段落\n\n正文\n");
    w(path.join(root, "src", "a.js"), `// 见 ${EVO}readme.txt 那份说明\n`);
    w(path.join(root, "src", "b.js"), `// 见 ${EVO}arc.md §C1\n`);
    const r = run(["--repo", root]);
    check("REF_RE 射程外但笨计数器认得出的文件被点名为 blindFiles ⇒ exit 6",
      r.code === 6 && r.marker.blind === 1 && r.marker.refs === 1,
      JSON.stringify(r.marker) + r.out.slice(0, 500));
    check("blindFiles 报文点名具体文件", /src\/a\.js/.test(r.out), r.out.slice(0, 600));
  }

  console.log("  —— mutation：indepShrink 判据 + 最终 exit 6 判据的判别力 ——");
  const src = fs.readFileSync(GUARD, "utf8");
  const SHRINK_GATE_LINE = "  else if (indepShrink || r.blindFiles.length) code = EXIT_SHRINK;";
  check("靶点⑦：exit 6 判据唯一存在", src.split(SHRINK_GATE_LINE).length === 2, String(src.split(SHRINK_GATE_LINE).length - 1));

  const shrinkRoot = path.join(TMP, "shrink-mut-base");
  w(path.join(shrinkRoot, "docs", "evolution", "arc.md"), "# 假档\n\n## C1 · 段落\n\n正文\n");
  w(path.join(shrinkRoot, "src", "a.js"), `// 见 ${EVO}arc.md §C1\n`);
  w(path.join(shrinkRoot, "src", "config.ini"), `; 见 ${EVO}arc.md §C1\n`);
  const mut = (tag, body) => w(path.join(TMP, "mut", tag + ".mjs"), body);
  {
    const r = run(["--repo", shrinkRoot], mut("G1", src.split(SHRINK_GATE_LINE).join("")));
    check("G1 canary：变异体仍跑得起来", r.marker && r.marker.scanned > 0, JSON.stringify(r.marker));
    check("🔴 G1（移除 exit 6 判据）⇒ 缩水语料退化成安静的 exit 0", r.code === 0, JSON.stringify(r.marker));
  }
  check("canary 恒等：缩水自检 mutation 过程没有动过原件", sha(GUARD) === PRISTINE);
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
