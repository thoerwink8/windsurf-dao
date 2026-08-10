// archive-pointers 回归网 — 指着档案层的指针，被指的那份还在不在（issue #262 ㈢）
//
// 跑法：node tests/archive-pointers.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 守的是什么 ──────────────────────────────────────────────────────────────
// `ccswitch/scripts/check-archive-pointers.mjs`：扫全仓形如「档案层路径」的引用，
// 逐条核 ①那个文件在不在 ②`§` 后面那个锚点在不在，缺一即 exit 1。
// 病的出处：PR #251 把四份代码文件的编年史搬进归档档，随后对抗官把那份档整个挪出工作树，
// 跑遍现有的闸 —— **一个都没红**。
//
// ── 为什么合成语料 ─────────────────────────────────────────────────────────
// 真仓只有「全都对」这一侧的样本：文件缺失、锚点缺失、扫描面塌陷、零样本这四格
// 在真仓里永远取不到。真仓那一侧另有 §⑥ 一组冒烟断言，答的是另一个问题
// （**此刻**盘上这些指针指得准不准）。
//
// 🔴 **本文件里的档案层路径字面一律拼出来（`EVO + "x.md"`），不写整串**：
// 被守对象的扫描面**包含 tests/ 目录**，写了整串 ⇒ 合成语料里那些故意造的死指针会被
// 真仓那一趟扫到并判红。这是 `[#反-写守卫]`「检查器的输出不能落在它自己的扫描面内」
// 在**测试语料**上的同一条判据。§⑥ 有一条断言专门钉住这个拼法真的奏效。
//
// ── mutation 覆盖（三形态 + 反向，每向先 canary）─────────────────────────────
// 承重判据四个：①文件存在性 ②锚点存在性 ③笨计数器（塌陷自检）④`git show <sha>:` 豁免。
//
// ── 已知不覆盖，照直写 ──────────────────────────────────────────────────────
// · 不验「归档档里那个 commit sha 解不解析得开」——被守对象自己也不验（头注写着）。
// · 不验「锚点底下那段内容还是不是原来那段」——文件在、锚点在 ≠ 内容没被换掉。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const GUARD = path.join(REPO, "ccswitch", "scripts", "check-archive-pointers.mjs");
const TMP = path.join(REPO, "_tmp", "archive-pointers-tests");

// 🔴 见头注：整串路径不许出现在本文件里
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

function run(args, script) {
  const r = spawnSync(process.execPath, [script || GUARD, ...args], { encoding: "utf8" });
  const out = String(r.stdout || "") + String(r.stderr || "");
  const m = /ARCHIVE_POINTERS_SUMMARY exit=(\d+) scanned=(\d+) refs=(\d+) anchors=(\d+) targets=(\d+) missfile=(\d+) missanchor=(\d+) litfiles=(\d+) hist=(\d+)/.exec(out);
  return {
    code: r.status, out,
    marker: m ? { exit: +m[1], scanned: +m[2], refs: +m[3], anchors: +m[4], targets: +m[5], missfile: +m[6], missanchor: +m[7], litfiles: +m[8], hist: +m[9] } : null,
  };
}

const PRISTINE = sha(GUARD);

// ── 合成语料：一棵假仓。每一格的两侧都有样本 ────────────────────────────────
// 期望：文件缺失 1 处、锚点缺失 1 处，其余全对。
function makeRepo(tag, opts) {
  const o = opts || {};
  const root = path.join(TMP, tag);
  // 被指方：一份档，带 C1 / C2 两个锚点标题（C9 刻意不存在）
  w(path.join(root, "docs", "evolution", "arc-202608.md"),
    "# 假归档\n\n## C1 · 第一段\n\n正文\n\n## C2 · 第二段\n\n正文\n");
  if (!o.dropCsv) w(path.join(root, "docs", "evolution", "lessons.csv"), "a,b\n1,2\n");

  const lines = [];
  lines.push("// ① 好指针：文件在、锚点在");
  lines.push(`// 见 ${EVO}arc-202608.md §C1`);
  lines.push("// ② 好指针：一条引用后面挂两个锚点（多段形态）");
  lines.push(`// 见 ${EVO}arc-202608.md §C1/§C2`);
  lines.push("// ③ 好指针：没有锚点，只核文件在不在（csv 没有标题行）");
  lines.push(`// 见 ${EVO}lessons.csv`);
  lines.push("// ④ **死指针 A**：被指的文件根本不在盘上");
  lines.push(`// 见 ${EVO}gone.md`);
  lines.push("// ⑤ **死指针 B**：文件在，但锚点被撤了");
  lines.push(`// 见 ${EVO}arc-202608.md §C9`);
  lines.push("// ⑥ 负控：带通配符的写法不匹配（既不检查也不误报）");
  lines.push(`// 见 ${EVO}arc-*.md`);
  lines.push("// ⑦ 负控：`git show <sha>:…` 是历史引用 —— 那份档已被有意删掉，不该判红");
  lines.push(`// git show deadbee:${EVO}retired.md`);
  w(path.join(root, "src", "a.js"), lines.join("\n") + "\n");
  return root;
}

console.log("\n──── ① 正控 + 负控：一棵语料一趟跑，逐格核 ────");
const repoA = makeRepo("repoA");
const rA = run(["--repo", repoA]);
{
  check("末行 marker 存在且 exit 与进程退出码一致",
    !!rA.marker && rA.marker.exit === rA.code, JSON.stringify(rA.marker));
  check("🔴 有死指针 ⇒ exit 1（不是静默 0）", rA.code === 1, JSON.stringify(rA.marker));
  check("正控：文件缺失那一处被点名（gone.md）", /gone\.md/.test(rA.out) && rA.marker.missfile === 1, JSON.stringify(rA.marker));
  check("正控：锚点缺失那一处被点名（C9），且与文件缺失**分开计数**",
    /C9/.test(rA.out) && rA.marker.missanchor === 1, JSON.stringify(rA.marker));
  check("正控：报文逐条给出「哪个文件第几行」，不是只说一句「有问题」",
    /src\/a\.js:\d+/.test(rA.out), rA.out.slice(0, 400));
  check("正控：一条引用后面的两个锚点都被收（anchors 计 4 = C1 + C1/C2 + C9）",
    rA.marker.anchors === 4, JSON.stringify(rA.marker));
  check("正控：csv 引用只核文件在不在（不因为没有标题行而红）",
    !/lessons\.csv/.test(rA.out.split("指向空气的指针")[1] || ""), rA.out.slice(0, 500));
  console.log("  —— 负控（形似而不该拦）——");
  check("负控：带通配符 `arc-*.md` 不匹配 ⇒ 不出现在红名单里",
    !/arc-\*\.md/.test(rA.out), rA.out.slice(0, 500));
  check("🔴 负控：`git show <sha>:…` 历史引用不判红，且**单独计数**不静默（hist=1）",
    rA.marker.hist === 1 && !/retired\.md/.test(rA.out), JSON.stringify(rA.marker));
  check("负控的配对正控：同一个不存在的文件**不带 sha 前缀**时必须红 —— 豁免不是「凡是 .md 都放行」",
    (() => {
      const r2 = makeRepo("repoPair");
      w(path.join(r2, "src", "b.js"), `// 见 ${EVO}retired.md\n`);
      const x = run(["--repo", r2]);
      return x.code === 1 && /retired\.md/.test(x.out);
    })());
  check("修法写在报文里（不是只报错不说怎么办）",
    /改名了就改指针/.test(rA.out) && /指向空气的指针比没有指针更糟/.test(rA.out), rA.out.slice(-500));
}

console.log("\n──── ② 全绿态：把两处死指针修好 ⇒ exit 0 ────");
{
  const repoB = makeRepo("repoB");
  const p = path.join(repoB, "src", "a.js");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8")
    .replace(`${EVO}gone.md`, `${EVO}arc-202608.md`)
    .replace("§C9", "§C2"), "utf8");
  const r = run(["--repo", repoB]);
  check("修好之后 exit 0 / missfile=0 / missanchor=0（两态都看到了）",
    r.code === 0 && r.marker.missfile === 0 && r.marker.missanchor === 0, JSON.stringify(r.marker));
  check("绿态仍报得出扫了多少、几处引用（不是一句「通过」）",
    r.marker.refs > 0 && r.marker.scanned > 0 && /引用 \d+ 处/.test(r.out), JSON.stringify(r.marker));
}

console.log("\n──── ③ 零样本 与 扫描面塌陷 必须分得开 ────");
{
  // 零样本：一个引用都没有，笨计数器也看不到 ⇒ 合法的 0，但要**明说**
  const empty = path.join(TMP, "empty");
  w(path.join(empty, "src", "q.js"), "console.log(1);\n");
  const e = run(["--repo", empty]);
  check("零样本 ⇒ exit 0，且**打印出「零样本」这三个字**（否则与「全都对」不可区分）",
    e.code === 0 && e.marker.refs === 0 && /零样本/.test(e.out), JSON.stringify(e.marker) + e.out.slice(0, 200));

  // 塌陷：笨计数器看得见字面，主解析一条都抽不出来（后缀不是 md/csv）
  const blind = path.join(TMP, "blind");
  w(path.join(blind, "src", "q.js"), `// 见 ${EVO}notes.txt 那一段\n`);
  const b = run(["--repo", blind]);
  check("🔴 塌陷 ⇒ exit 5（与 0 / 1 都分得开），报文明说「是它瞎了」",
    b.code === 5 && b.marker.litfiles > 0 && b.marker.refs === 0 && /瞎了/.test(b.out) && /别把这次的 0 当通过/.test(b.out),
    JSON.stringify(b.marker) + b.out.slice(0, 300));
  check("负控：全是历史引用时**不算塌陷**（主解析没瞎，只是这棵树上没有活指针）",
    (() => {
      const h = path.join(TMP, "histonly");
      w(path.join(h, "src", "q.js"), `// git show deadbee:${EVO}retired.md\n`);
      const x = run(["--repo", h]);
      return x.code === 0 && x.marker.hist === 1 && x.marker.refs === 0;
    })());
}

console.log("\n──── ④ 用法错：一条都没扫时不许伪装成通过 ────");
{
  const u = run(["--repo", repoA, "--什么鬼"]);
  check("不认识的参数 ⇒ exit 3（与 0/1/5 都分得开）", u.code === 3, JSON.stringify(u.marker));
  check("用法错也打 marker（消费方总拿得到一行机器可读的结论）",
    !!u.marker && u.marker.exit === 3 && u.marker.scanned === 0, JSON.stringify(u.marker));
  const q = run(["--repo", repoA, "--quiet"]);
  check("--quiet 只留 marker（退出码不变）", q.code === 1 && q.out.trim().split("\n").length === 1, JSON.stringify(q.out));
}

console.log("\n──── ⑤ mutation 判别力（三形态 + 反向 · 每向先 canary）────");
{
  const src = fs.readFileSync(GUARD, "utf8");
  const EXIST_LINE = '    try { ok = fs.statSync(abs).isFile(); } catch { ok = false; }';
  const ANCHOR_LINE = '      if (!ids.has(a)) problems.push({ kind: "missanchor", ...r, anchor: a, why: `${r.target} 里没有标题 “${a}”` });';
  const DUMB_LINE = '    if (hit) n++;';
  const HIST_LINE = '      if (HIST_RE.test(text.slice(Math.max(0, m.index - 41), m.index))) { hist++; continue; }';
  // 靶点唯一性：锚点落空与「判据已经不在了」在结果上不可区分（`[#守-锚点行尾]`）。
  // 四个锚都是**单行**，故行尾差异咬不到它们；下面这四条断言断的正是喂给 split() 的那个串。
  check("靶点①：文件存在性判定唯一存在", src.split(EXIST_LINE).length === 2, String(src.split(EXIST_LINE).length - 1));
  check("靶点②：锚点缺失上报唯一存在", src.split(ANCHOR_LINE).length === 2, String(src.split(ANCHOR_LINE).length - 1));
  check("靶点③：笨计数器累加唯一存在", src.split(DUMB_LINE).length === 2, String(src.split(DUMB_LINE).length - 1));
  check("靶点④：历史引用豁免唯一存在", src.split(HIST_LINE).length === 2, String(src.split(HIST_LINE).length - 1));

  const mut = (tag, body) => w(path.join(TMP, "mut", tag + ".mjs"), body);
  const repoM = makeRepo("repoM");
  const base = run(["--repo", repoM]);
  check("mutation 基线：原件在这份语料上 exit 1 / missfile=1 / missanchor=1",
    base.code === 1 && base.marker.missfile === 1 && base.marker.missanchor === 1, JSON.stringify(base.marker));

  // ── 判据 A：文件存在性 ──────────────────────────────────────────────────
  {
    // ①移除：判定整行删掉（ok 保持初值 false）⇒ **一切都报缺失**，负控该红
    const r = run(["--repo", repoM], mut("A1", src.split(EXIST_LINE).join("")));
    check("A1 canary：变异体仍跑得起来、仍抽得到引用", r.marker && r.marker.refs > 0, JSON.stringify(r.marker));
    check("A1（①移除存在性判定）⇒ 连在盘上的档也被报缺失，负控断言变红",
      r.marker.missfile > 1, JSON.stringify(r.marker));
  }
  {
    // ②保留字面但不执行 + 恒真 ⇒ **死文件不再被发现**，正控该红
    const r = run(["--repo", repoM], mut("A2", src.split(EXIST_LINE).join("    // " + EXIST_LINE.trim() + "\n    ok = true;")));
    check("A2 canary：变异体仍跑得起来", r.marker && r.marker.refs > 0, JSON.stringify(r.marker));
    check("🔴 A2（②注释掉、字面仍在）⇒ gone.md 不再被发现，正控断言变红",
      r.marker.missfile === 0 && !/gone\.md/.test(r.out), JSON.stringify(r.marker));
  }
  {
    // ③保留调用与副作用，但结果不被消费
    const r = run(["--repo", repoM], mut("A3", src.split(EXIST_LINE).join('    try { fs.statSync(abs).isFile(); ok = true; } catch { ok = true; }')));
    check("A3 canary：变异体仍跑得起来", r.marker && r.marker.refs > 0, JSON.stringify(r.marker));
    check("A3（③调用还在、答案没人听）⇒ 同样变红（「门的答案有没有人听」这一向）",
      r.marker.missfile === 0, JSON.stringify(r.marker));
  }

  // ── 判据 B：锚点存在性 ──────────────────────────────────────────────────
  {
    const r = run(["--repo", repoM], mut("B1", src.split(ANCHOR_LINE).join("")));
    check("B1 canary：变异体仍跑得起来、文件那一半仍在报", r.marker && r.marker.missfile === 1, JSON.stringify(r.marker));
    check("🔴 B1（移除锚点上报）⇒ §C9 这种「文件在、锚点没了」的死指针一声不吭",
      r.marker.missanchor === 0 && !/C9/.test(r.out), JSON.stringify(r.marker));
  }
  {
    // 反向：判据放松成恒真（任何锚点都算存在）—— 与①同向但换写法，验它不是只对「删掉」敏感
    const r = run(["--repo", repoM], mut("B2", src.replace("if (!ids.has(a))", "if (false && !ids.has(a))")));
    check("B2 canary：变异体仍跑得起来", r.marker && r.marker.refs > 0, JSON.stringify(r.marker));
    check("B2（反向·锚点判据恒真）⇒ 同样变红", r.marker.missanchor === 0, JSON.stringify(r.marker));
  }
  {
    // 反向②：判据翻成恒假（锚点一律算缺）⇒ 好指针也被报，另一侧的负控该红
    const r = run(["--repo", repoM], mut("B3", src.replace("if (!ids.has(a))", "if (true || !ids.has(a))")));
    check("B3 canary：变异体仍跑得起来", r.marker && r.marker.refs > 0, JSON.stringify(r.marker));
    check("B3（反向·锚点判据恒假）⇒ C1/C2 这些好锚点也被报缺，负控断言变红",
      r.marker.missanchor === 4 && /C1/.test(r.out), JSON.stringify(r.marker));
  }

  // ── 判据 C：笨计数器（塌陷自检）─────────────────────────────────────────
  {
    const blind = path.join(TMP, "blind2");
    w(path.join(blind, "src", "q.js"), `// 见 ${EVO}notes.txt\n`);
    const r = run(["--repo", blind], mut("C1", src.split(DUMB_LINE).join("")));
    check("C1 canary：变异体仍跑得起来、仍打得出 marker", !!r.marker, JSON.stringify(r.marker));
    check("🔴 C1（笨计数器恒 0）⇒ 塌陷不再被逮住，退化成安静的 exit 0",
      r.code === 0 && r.marker.litfiles === 0, JSON.stringify(r.marker));
  }
  {
    // 反向：笨计数器恒真（每个文件都算样本）⇒ 真·零样本那一格被误报成塌陷，负控该红
    const empty2 = path.join(TMP, "empty2");
    w(path.join(empty2, "src", "q.js"), "console.log(1);\n");
    const r = run(["--repo", empty2], mut("C2", src.split(DUMB_LINE).join("    n++;")));
    check("C2 canary：变异体仍跑得起来", !!r.marker, JSON.stringify(r.marker));
    check("C2（反向·笨计数器恒真）⇒ 零样本被误报成塌陷（exit 5），负控断言变红",
      r.code === 5, JSON.stringify(r.marker));
  }

  // ── 判据 D：`git show <sha>:` 豁免 ──────────────────────────────────────
  {
    const r = run(["--repo", repoM], mut("D1", src.split(HIST_LINE).join("")));
    check("D1 canary：变异体仍跑得起来", r.marker && r.marker.refs > 0, JSON.stringify(r.marker));
    check("D1（移除历史引用豁免）⇒ `git show <sha>:` 那一处被误判成死指针，负控断言变红",
      r.marker.hist === 0 && /retired\.md/.test(r.out), JSON.stringify(r.marker));
  }
  {
    // 反向：豁免恒真 ⇒ 所有引用都被当历史引用放走，正控全部失守
    const r = run(["--repo", repoM], mut("D2", src.replace("if (HIST_RE.test(", "if (true || HIST_RE.test(")));
    check("D2 canary：变异体仍跑得起来", !!r.marker, JSON.stringify(r.marker));
    check("🔴 D2（反向·豁免恒真）⇒ 一条活指针都不查了，正控断言变红（refs=0 而 exit 仍 0）",
      r.code === 0 && r.marker.refs === 0 && r.marker.hist > 0, JSON.stringify(r.marker));
  }

  check("canary 恒等：整个 mutation 过程被守对象逐字节没动过", sha(GUARD) === PRISTINE);
}

console.log("\n──── ⑥ 真仓冒烟：此刻盘上这些指针指得准不准 ────");
{
  const r = run([]);
  check("🔴 真仓 exit 0（有指针指向空气就在这里红）", r.code === 0, r.out.slice(0, 900));
  check("真仓不是零样本（refs / litfiles 都 > 0 —— 否则这条冒烟等于没测）",
    r.marker.refs > 0 && r.marker.litfiles > 0, JSON.stringify(r.marker));
  check("真仓确实核到了锚点（anchors > 0，不是只核了文件名）",
    r.marker.anchors > 0, JSON.stringify(r.marker));
  // 本批的当事人：归档档与它的 C 编号
  const arc = path.join(REPO, "docs", "evolution", "comment-archive-202608.md");
  const arcThere = fs.existsSync(arc);
  check("本批归档档在盘上", arcThere);
  // 🔴 档不在时**照样往下判**（读不到就当空串）：这一节存在的理由就是「档被挪走」那一态，
  //    要是这里直接抛异常，报出来的是一个堆栈而不是一句「哪条断言红了」。
  const text = arcThere ? fs.readFileSync(arc, "utf8") : "";
  const ids = new Set((text.match(/^#{1,6}\s+(\S+)/gm) || []).map((h) => h.replace(/^#+\s+/, "")));
  check("C1–C7 七个锚点齐全（少一个 ⇒ 指着它的那几处会在上面那条真仓断言里红）",
    ["C1", "C2", "C3", "C4", "C5", "C6", "C7"].every((k) => ids.has(k)), JSON.stringify([...ids]));
  check("每条都带 commit sha 坐标（issue #262 ㈣：行号必漂、sha 不漂）",
    (text.match(/迁出于 commit `[0-9a-f]{7,40}`/g) || []).length === 7,
    String((text.match(/迁出于 commit `[0-9a-f]{7,40}`/g) || []).length));
  check("归档档里不再留「原 NNN-NNN 行」这种行号坐标",
    !/原 \d+-\d+ 行/.test(text), (text.match(/原 \d+-\d+ 行/g) || []).join(","));
  // 🔴 头注那条判据的兑现：本文件自己不许在真仓那一趟里制造引用
  const mine = r.out.includes("archive-pointers.tests.js");
  check("🔴 本测试文件的合成语料没有漏进真仓扫描面（拼接手法真的奏效）", !mine, r.out.slice(0, 600));
  // 旧的日粒度档已删，任何地方都不该再当活指针指它（`git show <sha>:` 那种历史引用除外）
  check("全仓不再有活指针指着已删的日粒度归档档",
    !/comment-archive-20260809\.md 不在盘上/.test(r.out), r.out.slice(0, 600));
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
