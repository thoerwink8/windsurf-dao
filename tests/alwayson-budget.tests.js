// alwayson-budget 回归网 — ccswitch/scripts/check-alwayson-budget.mjs 的双向断言
//
// 跑法：node tests/alwayson-budget.tests.js     （全绿 exit 0，任一红 exit 1）
//       node scripts/run-tests.mjs              （自动发现本文件，无需登记）
//
// ── 这个回归网要钉住什么 ─────────────────────────────────────────────────────
// 被测对象是一道**预算闸**，它最危险的失效形态不是「误报超限」而是**静默变绿**：
// 只要「哪些文件算 always-on」这个判定朝「什么都不算」的方向坏掉，总字节就会变小、
// 闸转绿，而 always-on 面其实在涨。**绿是这道闸的默认色**，所以绿必须被证明。
// 故断言分三类，缺一不可：
//   正控 —— 超限必须红，且**必须给出出口**（一道只会骂人的闸必被静音）
//   负控 —— 未超限不许红；带 `paths:` 的作用域档不许被算进预算
//   自检半边 —— 锚缺失 / 扫描面塌陷 / 计量归零，三者都必须把「绿」变成「红」
//
// ── mutation 半边（本文件与别处不同的那一格）─────────────────────────────────
// 上面那些断言证明的是「当前实现在这些样本上行为正确」，证不了「断言真的夹得住」。
// 故 §⑦ **真的把被测判定改坏**，跑变异体、看断言是否变红。四个变异体覆盖三个方向：
//   A 恒 false（移除语义）· B 恒 true（反转）· C **注释掉**（文本匹配型守护对此天然失明）
//   D 改**早退分支**（主判定那一行原封不动，code review 一眼看不出 —— 三向里最阴的一个）
//
// 每个变异体要过**两道**前置，两道都是被本文件自己的失败逼出来的（详见 §⑦ 内注）：
//   ① **改到了没有** —— 靶点显式传入并断言文本真的变了。初版把靶点焊死，
//      变异体 D 实际改的是另一行，产出一个「活着、被判红、但测的不是它名字说的那件事」的四不像。
//   ② **canary：还跑得起来没有** —— 末行契约仍在。出处：dao 对抗验证官节
//      「mutation 之前先验『变异体还活着』」：一个把靶弄死的 mutation 会让每条断言都红，
//      而那正是「判别力满分」的表象。
// **①② 都过仍不够**：变异体 B 初版两道全过却与基线逐字节相同 —— 因为夹具里没有任何一份
// 语料**走得到**被改的那一行。⇒ 第三问：**这份语料执行到那一行了吗**（§⑦ 的三形态夹具）。
//
// ── 夹具形态 ────────────────────────────────────────────────────────────────
// 全部落 `<repo>/_tmp/alwayson-budget-tests/<case>/`（已 gitignore），每例一套：
//   dao.md          —— 锚
//   home/CLAUDE.md  —— 用户级 always-on
//   rules/*.md      —— 有 `paths:` 的（作用域档）与没有的（计入）各若干
// 夹具正文**一律只用 `\n`**，于是「盘上原始字节 == LF 规范化字节」，期望值可以精确算；
// 只有 §④ 那一例故意写 CRLF，专门钉住规范化本身。
//
// ── 最后两例是真实语料 / 真 hook，刻意留着 ───────────────────────────────────
// 合成夹具证明不了「它在真数据上跑得动」（本仓实证：某检测器 47 条合成断言全绿，
// 拿 16 份真实正文一跑一份都没扫成，而它照报「均零命中」）；
// 「源码里有调用点」也证不了调用点可达（`isMetaRepo` 那次静默了整块模式 A）。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "ccswitch", "scripts", "check-alwayson-budget.mjs");
const TMP = path.join(REPO, "_tmp", "alwayson-budget-tests");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}

// ── 夹具 ────────────────────────────────────────────────────────────────────
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function w(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}
const B = (s) => Buffer.byteLength(s, "utf8");

// 带 `paths:` 的作用域规则（与 dao-rules-deploy.mjs 认的形态一致）
function scopedRule(body) {
  return '---\npaths:\n  - "**/check-*.ps1"\n---\n\n' + body + "\n";
}
// 无 frontmatter 的用户级规则 ⇒ 保守当 always-on 计入
function plainRule(body) { return "# 无 frontmatter\n\n" + body + "\n"; }
// 有 frontmatter 但**没有 paths 键** ⇒ 同样计入（负控：不许「只要有 `---` 就当作用域档」）
function descOnlyRule(body) { return "---\ndescription: 只有描述没有 paths\n---\n\n" + body + "\n"; }

// 建一个用例目录，返回 { dir, expect }。expect 是按同一口径独立算出的期望字节数。
function mkCase(name, opts) {
  const dir = path.join(TMP, name);
  rm(dir);
  const files = { counted: [], scoped: [] };

  if (opts.daoMd !== null) {
    w(path.join(dir, "dao.md"), opts.daoMd);
    files.counted.push(B(opts.daoMd));
  }
  if (opts.userMd != null) {
    w(path.join(dir, "home", "CLAUDE.md"), opts.userMd);
    files.counted.push(B(opts.userMd));
  }
  for (const [n, body] of Object.entries(opts.rules || {})) {
    w(path.join(dir, "rules", n), body);
    (/^\s*paths\s*:/m.test((body.match(/^---\r?\n([\s\S]*?)\r?\n---/) || ["", ""])[1])
      ? files.scoped : files.counted).push(B(body));
  }
  if (opts.mkRulesDir && !fs.existsSync(path.join(dir, "rules"))) {
    fs.mkdirSync(path.join(dir, "rules"), { recursive: true });
  }
  return {
    dir,
    expectTotal: files.counted.reduce((a, b) => a + b, 0),
    expectFiles: files.counted.length,
    expectScoped: files.scoped.length,
  };
}

function run(dir, opts) {
  const o = opts || {};
  const args = [o.script || SCRIPT,
    "--dao-md", path.join(dir, "dao.md"),
    "--user-claude-md", path.join(dir, "home", "CLAUDE.md"),
    "--rules-dir", path.join(dir, "rules"),
    "--limit", String(o.limit == null ? 1000000 : o.limit)].concat(o.extra || []);
  const r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000 });
  const out = String(r.stdout || "");
  const m = /ALWAYSON_BUDGET_SUMMARY exit=(\d+) total=(\d+) limit=(\d+) files=(\d+) headroom=(-?\d+) scoped=(\d+) missing=(\d+) selfcheck=(ok|fail)/.exec(out);
  return {
    code: r.status, out, stderr: String(r.stderr || ""),
    sum: m ? {
      exit: +m[1], total: +m[2], limit: +m[3], files: +m[4],
      headroom: +m[5], scoped: +m[6], missing: +m[7], self: m[8],
    } : null,
  };
}

rm(TMP);

// ══════════════════════════════════════════════════════════════
console.log("\n──── ① 未超限（负控：绿态不许红，自检不许恒红）────");
{
  const c = mkCase("under-limit", {
    daoMd: "# dao\n" + "条款一二三四五。\n".repeat(20),
    userMd: "# user\n短。\n",
  });
  const r = run(c.dir, { limit: 1000000 });
  check("exit 0", r.code === 0 && r.sum && r.sum.exit === 0, JSON.stringify(r.sum) + r.out.slice(-300));
  check("total 与独立算出的期望逐字节相等", r.sum && r.sum.total === c.expectTotal,
    "got=" + (r.sum && r.sum.total) + " want=" + c.expectTotal);
  check("files=2（dao.md + 用户 CLAUDE.md）", r.sum && r.sum.files === 2, JSON.stringify(r.sum));
  check("headroom = limit - total", r.sum && r.sum.headroom === r.sum.limit - r.sum.total, JSON.stringify(r.sum));
  check("自检 ok（负控：自检半边不恒红）", r.sum && r.sum.self === "ok", JSON.stringify(r.sum));
  check("绿态报文说清是「未超限」而非沉默", /未超限/.test(r.out), r.out.slice(-400));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ② 超限 → 红，且必须给出口 ────");
{
  const c = mkCase("over-limit", {
    daoMd: "# dao\n" + "很长很长的条款正文。\n".repeat(200),
    userMd: "# user\n短。\n",
  });
  const r = run(c.dir, { limit: 500 });
  check("exit 1", r.code === 1 && r.sum && r.sum.exit === 1, JSON.stringify(r.sum));
  check("headroom 为负且等于超出量", r.sum && r.sum.headroom === 500 - c.expectTotal, JSON.stringify(r.sum));
  check("自检仍 ok（这是真发现，不是扫描面塌）", r.sum && r.sum.self === "ok", JSON.stringify(r.sum));
  check("报文说出超了多少字节", /超出 \d+ B|超限 \d+ 字节/.test(r.out), r.out.slice(-800));
  // 一道只会骂人、不给出口的闸必被静音 —— 三个出口必须原样在报文里
  check("出口①：细则存根化 ccswitch/rules/", /①.*ccswitch\/rules\//.test(r.out), r.out.slice(-900));
  check("出口②：作用域化 paths + dao-rules-deploy", /②.*paths.*dao-rules-deploy/s.test(r.out), r.out.slice(-900));
  check("出口③：叙事外迁 docs/evolution/", /③.*docs\/evolution\//.test(r.out), r.out.slice(-900));
  check("逐文件明细可见（只报个总数等于没报）", /dao\.md/.test(r.out) && /用户级 CLAUDE\.md/.test(r.out), r.out.slice(0, 700));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ③ `paths:` 豁免：作用域档不占 always-on 配额 ────");
// **本节是 §⑦ mutation 的靶**：三份 rules 刻意给成互不相同的长度，于是
// 「算错哪一份」都会让 total 变成一个别的数字，而不只是让某个布尔翻转。
{
  const scopedBody = scopedRule("作用域档：只在读到 check-*.ps1 时注入，不占 always-on。" + "填充".repeat(40));
  const plainBody = plainRule("无 frontmatter：保守当 always-on 计入。" + "填充".repeat(10));
  const descBody = descOnlyRule("有 frontmatter 但没有 paths 键 ⇒ 仍是 always-on。" + "填充".repeat(25));
  const c = mkCase("paths-exempt", {
    daoMd: "# dao\n锚。\n",
    userMd: "# user\n短。\n",
    rules: {
      "dao-scope-x.md": scopedBody,
      "plain-y.md": plainBody,
      "desc-only-z.md": descBody,
    },
  });
  const r = run(c.dir, { limit: 1000000 });
  check("exit 0", r.code === 0 && r.sum && r.sum.exit === 0, JSON.stringify(r.sum) + r.out.slice(-400));
  check("scoped=1（只有带 paths 的那份被排除）", r.sum && r.sum.scoped === 1, JSON.stringify(r.sum));
  check("files=4（dao + user + 无 frontmatter + 只有 description）", r.sum && r.sum.files === 4, JSON.stringify(r.sum));
  check("total 精确 = 四份计入文件之和", r.sum && r.sum.total === c.expectTotal,
    "got=" + (r.sum && r.sum.total) + " want=" + c.expectTotal);
  // 这一条是上一条的**反向表述**：作用域档那份的字节数必须完全不在 total 里。
  // 分开写是因为两者夹的方向不同：上一条防少算，这一条防多算。
  check("作用域档字节不在 total 里（多算方向的负控）",
    r.sum && r.sum.total + B(scopedBody) !== r.sum.total && !(r.sum.total >= c.expectTotal + B(scopedBody)),
    "total=" + (r.sum && r.sum.total) + " scopedBytes=" + B(scopedBody));
  check("报文点名作用域档且说明它为什么不计", /作用域档/.test(r.out) && /不计入/.test(r.out), r.out.slice(-600));
  check("`---` 但无 paths 键的不许被当作用域档（近似判据的负控）",
    r.sum && r.sum.scoped === 1, JSON.stringify(r.sum));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ④ 计量口径：CRLF 与 BOM 不许改变预算 ────");
// 换台机器 checkout 一次就变红的闸最终一定会被静音（dao-rules-deploy 那次教训）。
{
  const lf = "# dao\n一二三\n四五六\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  const bomLf = "﻿" + lf;

  const a = path.join(TMP, "eol-lf");
  w(path.join(a, "dao.md"), lf); w(path.join(a, "home", "CLAUDE.md"), "x\n");
  fs.mkdirSync(path.join(a, "rules"), { recursive: true });
  const b = path.join(TMP, "eol-crlf");
  w(path.join(b, "dao.md"), crlf); w(path.join(b, "home", "CLAUDE.md"), "x\n");
  fs.mkdirSync(path.join(b, "rules"), { recursive: true });
  const d = path.join(TMP, "eol-bom");
  w(path.join(d, "dao.md"), bomLf); w(path.join(d, "home", "CLAUDE.md"), "x\n");
  fs.mkdirSync(path.join(d, "rules"), { recursive: true });

  const ra = run(a), rb = run(b), rd = run(d);
  check("CRLF 与 LF 同一份内容 → total 相同", ra.sum && rb.sum && ra.sum.total === rb.sum.total,
    "lf=" + (ra.sum && ra.sum.total) + " crlf=" + (rb.sum && rb.sum.total));
  check("盘上字节确实不同（否则上一条是空断言）", fs.statSync(path.join(b, "dao.md")).size >
    fs.statSync(path.join(a, "dao.md")).size,
    "lf=" + fs.statSync(path.join(a, "dao.md")).size + " crlf=" + fs.statSync(path.join(b, "dao.md")).size);
  check("BOM 不计入预算", rd.sum && ra.sum && rd.sum.total === ra.sum.total,
    "bom=" + (rd.sum && rd.sum.total) + " plain=" + (ra.sum && ra.sum.total));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑤ 自检半边：锚缺失必须红（否则「面很小」= 一片安详的绿）────");
{
  const c = mkCase("anchor-missing", { daoMd: null, userMd: "# user\n短。\n" });
  const r = run(c.dir, { limit: 1000000 });
  check("exit 1（total 很小也不许报绿）", r.code === 1 && r.sum && r.sum.exit === 1, JSON.stringify(r.sum));
  check("selfcheck=fail", r.sum && r.sum.self === "fail", JSON.stringify(r.sum));
  check("报文点出 anchor-missing", /anchor-missing/.test(r.out), r.out.slice(-700));
  check("明说此时「未超限」不可信", /不可信/.test(r.out), r.out.slice(-700));
  check("**没有超限**却 exit=1 —— 两种红在机器通道上分得开",
    r.sum && r.sum.headroom > 0 && r.sum.exit === 1, JSON.stringify(r.sum));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑥ 自检半边：rules 扫描面塌陷（普查看得见、主逻辑看不见）────");
// 造一个**名叫 `x.md` 的目录**：独立普查按**名字**数它一份，主逻辑的 `isFile()` 排除它
// ⇒ 三桶之和 < 普查数 ⇒ undercount 响。
// 它模拟的是「主逻辑的过滤器变严 / 枚举早退 / 某类条目被静默跳过」之后的形态：
// 样本数与分桶数**不再一起变化**，差值就是警报。
//
// 🔴 **这一节本身钉住了一次真自伤**：脚本初版让主循环直接遍历普查函数的返回值，于是
// 每个条目必然落进三桶之一、和恒等于普查数 ⇒ 那条集合差断言是**永远为真的废话**。
// 本节第一次跑出来的是 `unreadable@…EISDIR` 而不是 undercount，才把它揪出来。
// 所以下面这条断言**必须点名 undercount**，不能放宽成「只要 selfcheck=fail 就算过」——
// 放宽之后，这道自检退回废话状态时本节照样绿。
{
  const c = mkCase("selfcheck-undercount", {
    daoMd: "# dao\n锚。\n", userMd: "# user\n短。\n",
    rules: { "real.md": plainRule("正常一份") },
  });
  fs.mkdirSync(path.join(c.dir, "rules", "trap.md"), { recursive: true });
  const r = run(c.dir, { limit: 1000000 });
  check("exit 1（有样本没被看见 ⇒ 不许报绿）", r.code === 1 && r.sum && r.sum.exit === 1, JSON.stringify(r.sum));
  check("selfcheck=fail", r.sum && r.sum.self === "fail", JSON.stringify(r.sum));
  check("报文点名 undercount@rules（不是任何一种 fail 都算数）",
    /undercount@rules/.test(r.out), r.out.slice(-800));
  check("报文给出两个数 + 点名没被枚举到的那一份",
    /独立普查/.test(r.out) && /trap\.md/.test(r.out), r.out.slice(-800));
  check("真正被计入预算的仍只有 3 份（塌陷不影响已看见的那些）",
    r.sum && r.sum.files === 3, JSON.stringify(r.sum));
}
{
  // 负控：rules 目录不存在是常态（多数机器没有），不许因此变红
  const c = mkCase("no-rules-dir", { daoMd: "# dao\n锚。\n", userMd: "# user\n短。\n" });
  const r = run(c.dir, { limit: 1000000 });
  check("负控：rules 目录不存在 → 仍 exit 0 且 selfcheck=ok",
    r.code === 0 && r.sum && r.sum.self === "ok", JSON.stringify(r.sum) + r.out.slice(-500));
}
{
  // 负控：用户级 CLAUDE.md 缺席（另一台机器的合法形态）→ 出声但不判红
  const c = mkCase("user-md-missing", { daoMd: "# dao\n锚。\n", userMd: null, mkRulesDir: true });
  const r = run(c.dir, { limit: 1000000 });
  check("用户级 CLAUDE.md 缺席 → 不判红", r.code === 0 && r.sum && r.sum.exit === 0, JSON.stringify(r.sum));
  check("但 missing 计数进末行契约（缺席 != 没这回事）", r.sum && r.sum.missing === 1, JSON.stringify(r.sum));
  check("报文点名缺席的那一份（不静默）", /期望位置无文件/.test(r.out), r.out.slice(-600));
}
{
  // 负控 + 参数校验：--limit 写错不许被当成 0 或被静默忽略
  const c = mkCase("bad-limit", { daoMd: "# dao\n锚。\n", userMd: "# user\n短。\n" });
  const r = run(c.dir, { extra: [], limit: "68kb" });
  check("--limit 非整数 → selfcheck=fail 且红（不猜你想说什么）",
    r.code === 1 && r.sum && r.sum.self === "fail", JSON.stringify(r.sum));
  check("报文点出 bad-limit-arg", /bad-limit-arg/.test(r.out), r.out.slice(-600));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑦ mutation：把「无 paths 才计入」判定改坏，看断言真的变红 ────");
// 每个变异体**先过 canary**：确认它还跑得起来（末行契约仍在）。
// 一个把靶弄死的 mutation 会让每条断言都红，而那与「判别力满分」不可区分。
{
  const SRC = fs.readFileSync(SCRIPT, "utf8");
  const ORIG = "  return /^\\s*paths\\s*:/m.test(m[1]);";
  check("mutation 靶点在源码里唯一存在（找不到就说明本节在空转）",
    SRC.split(ORIG).length === 2, "occurrences=" + (SRC.split(ORIG).length - 1));

  const mutDir = path.join(TMP, "_mutants");
  fs.mkdirSync(mutDir, { recursive: true });
  // 靶点**显式传入**，不写死成 ORIG。
  // 🔴 初版把 ORIG 焊死在这里，于是变异体 D（本该改早退分支）实际改的是主判定行，
  // 产出一个 `hasPathsFrontmatter` 掉进函数末尾返回 undefined 的**四不像**——
  // 它照样「活着」（末行契约在）、照样被断言判红，看起来一切正常，
  // 而**那个变异体测的根本不是它名字说的那件事**。
  // ⇒ 变异体必须**当场验它真的改到了那一行**（下面的 `changed` 断言），
  //   否则「跑了 N 个 mutation」这个数字里可以掺进任意多个假的。
  function mutant(tag, target, replacement) {
    const body = SRC.replace(target, replacement);
    check("mutation·" + tag + " 真的改到了预期那一行（变异体不是四不像）", body !== SRC,
      "target=" + JSON.stringify(target));
    const p = path.join(mutDir, "mut-" + tag + ".mjs");
    fs.writeFileSync(p, body, "utf8");
    return p;
  }

  const EARLY = "  if (!m) return false;";
  check("早退分支也在源码里唯一存在（变异体 D 的靶）",
    SRC.split(EARLY).length === 2, "occurrences=" + (SRC.split(EARLY).length - 1));

  // 基线夹具**必须含三种 frontmatter 形态**，否则 mutation 打不到靶：
  //   dao-scope-x.md —— 有 frontmatter 且有 `paths:`  ⇒ 作用域档
  //   plain-y.md     —— 完全没有 frontmatter          ⇒ 走**早退分支**，主判定根本不执行
  //   desc-only-z.md —— 有 frontmatter 但**没有 paths 键** ⇒ 唯一能让「恒 true」现形的语料
  //
  // 🔴 **这三种形态是被一次失败的 mutation 逼出来的**，照直记：初版夹具只有前两种，
  // 于是「判定恒 true」这个变异体跑出来与基线**逐字节相同** —— 因为 `plain-y.md` 在
  // `if (!m) return false` 就返回了，被改坏的那一行**从未被执行**。
  // canary 说变异体活着（末行契约在），而它**根本没打到靶**。
  // ⇒ 「变异体还活着」是必要条件不是充分条件；还要问**这份语料走不走到那一行**。
  const scopedBody = scopedRule("作用域档正文。" + "填充".repeat(40));
  const plainBody = plainRule("无 frontmatter 正文。" + "填充".repeat(10));
  const descBody = descOnlyRule("有 frontmatter 无 paths 键。" + "填充".repeat(25));
  const c = mkCase("mutation-target", {
    daoMd: "# dao\n锚。\n", userMd: "# user\n短。\n",
    rules: { "dao-scope-x.md": scopedBody, "plain-y.md": plainBody, "desc-only-z.md": descBody },
  });
  const base = run(c.dir, { limit: 1000000 });
  check("基线：scoped=1 files=4", base.sum && base.sum.scoped === 1 && base.sum.files === 4, JSON.stringify(base.sum));

  // 变异体 A：判定恒 false ⇒ 作用域档被误算进预算（闸变**紧**：会误报超限）
  {
    const p = mutant("always-false", ORIG, "  return false;");
    const r = run(c.dir, { limit: 1000000, script: p });
    check("canary·A：变异体还跑得起来（末行契约在）", r.sum !== null, r.out.slice(-300) + r.stderr.slice(0, 200));
    check("A 被夹住：scoped 从 1 变 0", r.sum && r.sum.scoped === 0, JSON.stringify(r.sum));
    check("A 被夹住：total 变大了作用域档那么多",
      r.sum && base.sum && r.sum.total === base.sum.total + B(scopedBody),
      "mut=" + (r.sum && r.sum.total) + " base=" + (base.sum && base.sum.total) + " delta=" + B(scopedBody));
  }
  // 变异体 B：判定恒 true ⇒ 有 frontmatter 的一律当作用域档排除
  // （**这是真正危险的方向**：always-on 面在涨而闸静默转绿）
  {
    const p = mutant("always-true", ORIG, "  return true;");
    const r = run(c.dir, { limit: 1000000, script: p });
    check("canary·B：变异体还跑得起来（末行契约在）", r.sum !== null, r.out.slice(-300) + r.stderr.slice(0, 200));
    check("B 被夹住：scoped 从 1 变 2（desc-only 被误判成作用域档）",
      r.sum && r.sum.scoped === 2, JSON.stringify(r.sum));
    check("B 被夹住：total 变小了 desc-only 那份那么多（静默变绿的形态）",
      r.sum && base.sum && r.sum.total === base.sum.total - B(descBody),
      "mut=" + (r.sum && r.sum.total) + " base=" + (base.sum && base.sum.total) + " delta=" + B(descBody));
    check("B 下自检半边**仍然 ok** —— 照直记：分桶总数守恒，集合差结构上看不见这种病，"
      + "夹住它的是 §③ 的精确计数断言而不是自检",
      r.sum && r.sum.self === "ok", JSON.stringify(r.sum));
  }
  // 变异体 C：整段判定被**注释掉**而非删除。文本匹配型守护对这一向天然失明，
  // 故必须单独验（对抗验证官节「改坏本身要试不止一种形态」的 ② 向）。
  {
    const p = mutant("commented-out", ORIG, "  // return /^\\s*paths\\s*:/m.test(m[1]);\n  return false;");
    const r = run(c.dir, { limit: 1000000, script: p });
    check("canary·C：变异体还跑得起来", r.sum !== null, r.out.slice(-300) + r.stderr.slice(0, 200));
    check("C 被夹住（与 A 同效：scoped 归 0）", r.sum && r.sum.scoped === 0, JSON.stringify(r.sum));
  }
  // 变异体 D：改**早退分支**（`if (!m) return false` → `true`）⇒ 无 frontmatter 的
  // 用户级规则被整批当成作用域档剔出预算。**这是三向里最阴的一个**：
  // 主判定那一行原封不动、code review 一眼看不出，而 always-on 面静默缩水。
  {
    const p = mutant("early-return-true", EARLY, "  if (!m) return true;");
    const r = run(c.dir, { limit: 1000000, script: p });
    check("canary·D：变异体还跑得起来", r.sum !== null, r.out.slice(-300) + r.stderr.slice(0, 200));
    check("D 被夹住：scoped 从 1 变 2（无 frontmatter 那份被剔出）",
      r.sum && r.sum.scoped === 2, JSON.stringify(r.sum));
    check("D 被夹住：total 变小了无 frontmatter 那份那么多",
      r.sum && base.sum && r.sum.total === base.sum.total - B(plainBody),
      "mut=" + (r.sum && r.sum.total) + " base=" + (base.sum && base.sum.total) + " delta=" + B(plainBody));
  }
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑧ 末行契约 + --json ────");
{
  const c = mkCase("json-mode", { daoMd: "# dao\n锚。\n", userMd: "# user\n短。\n", mkRulesDir: true });
  const r = run(c.dir, { limit: 1000000, extra: ["--json"] });
  check("--json 也打末行", r.sum !== null, r.out.slice(-300));
  let doc = null;
  try { doc = JSON.parse(r.out.slice(0, r.out.lastIndexOf("ALWAYSON_BUDGET_SUMMARY"))); } catch (_) { doc = null; }
  check("--json 正文可解析", doc !== null, r.out.slice(0, 200));
  check("--json 带逐文件明细（不是只给个数）",
    doc && Array.isArray(doc.counted) && doc.counted.length === 2 && doc.counted.every((x) => typeof x.bytes === "number"),
    JSON.stringify(doc && doc.counted));
  check("--json 带出口清单（红态时报文要用它）", doc && Array.isArray(doc.exits) && doc.exits.length === 3,
    JSON.stringify(doc && doc.exits));
  check("末行前四字段顺序符合派单契约 exit/total/limit/files",
    /ALWAYSON_BUDGET_SUMMARY exit=\d+ total=\d+ limit=\d+ files=\d+/.test(r.out), r.out.slice(-300));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑨ 真实语料自跑（合成夹具证明不了它在真数据上跑得动）────");
{
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", timeout: 60000, cwd: REPO });
  const out = String(r.stdout || "");
  const m = /ALWAYSON_BUDGET_SUMMARY exit=(\d+) total=(\d+) limit=(\d+) files=(\d+) headroom=(-?\d+) scoped=(\d+) missing=(\d+) selfcheck=(ok|fail)/.exec(out);
  check("真仓自跑打得出末行", m !== null, out.slice(-400) + " [stderr] " + String(r.stderr || "").slice(0, 300));
  if (m) {
    const sum = { exit: +m[1], total: +m[2], limit: +m[3], files: +m[4], headroom: +m[5], self: m[8] };
    console.log("        实况：" + JSON.stringify(sum));
    check("真实 dao.md 被量到（零字节就是塌陷）", sum.total > 10000, JSON.stringify(sum));
    check("真实语料上自检 ok", sum.self === "ok", JSON.stringify(sum) + "\n" + out.slice(-900));
    // **刻意不断言 exit=0**：闸值是占位、待用户拍板，用户随时可能把它调到当前值以下，
    // 那时这道回归网不该跟着红——它测的是检测器，不是 dao.md 该多大。
    check("真实语料上 exit 与 headroom 符号一致（契约自洽，而非断言「必须没超」）",
      (sum.exit === 0) === (sum.headroom >= 0) || sum.self === "fail", JSON.stringify(sum));
  }
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑩ 挂载可达性（「源码里有调用点」是弱判据，只有真跑过才算数）────");
// 静态核对证不了调用点可达——它可能被提前 return 跳过、可能落在一个从不进入的分支里
// （`isMetaRepo` 那次就是这么静默了整块模式 A）。故本节全走「真喂一次 SessionStart
// payload，看注入的正文里有没有那一行」。
{
  const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-scaffold-check.js");
  const DRIFT_STATE = path.join(TMP, "drift-state");

  function runHook(cwd) {
    const payload = JSON.stringify({
      session_id: "alwayson-budget-tests", cwd, hook_event_name: "SessionStart", source: "startup",
    });
    const r = spawnSync(process.execPath, [HOOK], {
      input: payload, encoding: "utf8", timeout: 120000,
      env: Object.assign({}, process.env, {
        DAO_SETTINGS_DRIFT_STATE_DIR: DRIFT_STATE,
        DAO_SETTINGS_DRIFT_SELFTEST: "1",
      }),
    });
    let json = null;
    if (r.stdout && r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch (_) {} }
    const ctx = (json && json.hookSpecificOutput && json.hookSpecificOutput.additionalContext) || "";
    return { code: r.status, ctx, out: String(r.stdout || ""), err: String(r.stderr || "") };
  }

  // 假元仓库：内容签名（ccswitch/dao.md + scaffold-manifest.json）让模式 A 生效；
  // `.git` 写成一个内容为垃圾的**文件** —— 沙箱里没有 .git 时 git 会一路向上找到真仓库，
  // 把真仓库的状态报成沙箱的。
  function mkFakeMeta(tag, stubBody) {
    const root = path.join(TMP, "hookwire", tag);
    rm(root);
    fs.mkdirSync(path.join(root, "ccswitch", "hooks"), { recursive: true });
    w(path.join(root, ".git"), "not a real gitfile\n");
    w(path.join(root, "ccswitch", "dao.md"), "# fixture dao\n");
    w(path.join(root, "ccswitch", "scaffold-manifest.json"), '{"entries":[]}');
    if (stubBody != null) w(path.join(root, "ccswitch", "scripts", "check-alwayson-budget.mjs"), stubBody);
    return root;
  }

  // ① 真仓可达性：唯一能证明「调用点真的跑到了」的断言
  {
    const r = runHook(REPO);
    check("真仓 SessionStart 注入里出现字节预算那一行（调用点可达）", /字节预算/.test(r.ctx),
      "ctx=" + r.ctx.slice(0, 500) + " [stderr]" + r.err.slice(0, 200));
    check("常路带出数字（总字节 / 闸值 / 余量），不是零输出",
      /合计 \d+ B \/ 闸值 \d+ B/.test(r.ctx) && /余量/.test(r.ctx), r.ctx.slice(0, 600));
    check("常路明说闸值是占位待用户拍板（不让读者以为这是裁决）",
      /占位待用户拍板/.test(r.ctx), r.ctx.slice(0, 600));
  }
  // ② 自指：量预算的东西自己不在了 —— 必须响，不许静默跳过
  {
    const r = runHook(mkFakeMeta("no-script", null));
    check("检测脚本不在 → hook 报红（不静默）", /字节预算闸脚本不在/.test(r.ctx), r.ctx.slice(0, 500));
  }
  // ③ 末行契约被改坏 → 「跑完但没拿到摘要」必须与「跑了没事」区分开
  {
    const r = runHook(mkFakeMeta("bad-contract", 'process.stdout.write("我把末行改成了别的样子\\n");\n'));
    check("拿不到末行契约 → 报红并点出契约可能被改坏",
      /没拿到 ALWAYSON_BUDGET_SUMMARY/.test(r.ctx), r.ctx.slice(0, 500));
  }
  // ④ 红态传导：超限时要把**出口**也带出来（只报个数字，人无从下手）
  {
    const stub = [
      'process.stdout.write("✗ 超限 1234 字节 —— always-on 面每轮注入\\n");',
      'process.stdout.write("    ① 细则存根化 → 正文迁进 `ccswitch/rules/*.md`\\n");',
      'process.stdout.write("    ② 条款作用域化 → `paths:` + dao-rules-deploy.mjs\\n");',
      'process.stdout.write("    ③ 叙事外迁 → docs/evolution/\\n");',
      'process.stdout.write("ALWAYSON_BUDGET_SUMMARY exit=1 total=72914 limit=71680 files=2 headroom=-1234 scoped=2 missing=0 selfcheck=ok\\n");',
      "process.exit(1);",
    ].join("\n");
    const r = runHook(mkFakeMeta("red", stub));
    check("超限红态传导到 SessionStart 提醒", /字节预算闸 FAIL/.test(r.ctx), r.ctx.slice(0, 700));
    check("红态带出超出量", /超 1234 B/.test(r.ctx), r.ctx.slice(0, 700));
    check("红态原样带出三个出口（不给出口的闸必被静音）",
      /①/.test(r.ctx) && /②/.test(r.ctx) && /③/.test(r.ctx), r.ctx.slice(0, 700));
  }
  // ⑤ 自检失败态（未超限但 exit=1）→ 措辞必须说「不可信」，不能说「超限了」
  {
    const stub = [
      'process.stdout.write("✗ 自检半边失败 1 条\\n");',
      'process.stdout.write("ALWAYSON_BUDGET_SUMMARY exit=1 total=2068 limit=71680 files=1 headroom=69612 scoped=0 missing=0 selfcheck=fail\\n");',
      "process.exit(1);",
    ].join("\n");
    const r = runHook(mkFakeMeta("selffail", stub));
    check("自检失败态：报「未超限不可信」而不是报超限",
      /不可信/.test(r.ctx) && /selfcheck=fail/.test(r.ctx) && !/超出闸值/.test(r.ctx), r.ctx.slice(0, 700));
  }
}

console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " ===");
process.exit(fail ? 1 : 0);
