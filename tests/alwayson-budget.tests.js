// alwayson-budget 回归网 — ccswitch/scripts/check-alwayson-budget.mjs 的双向断言
//
// @dao-test-tier: env
//
// 跑法：node tests/alwayson-budget.tests.js        （默认层：§⑩①b 那一节 defer 掉）
//       node tests/alwayson-budget.tests.js --env  （含环境敏感层；要求串行环境，见下）
//       node scripts/run-tests.mjs                 （自动发现本文件，无需登记；默认层 → exit 2）
//       node scripts/run-tests.mjs --env           （透传 --env，全绿 exit 0）
//
// ── 上面那行 `@dao-test-tier: env` 是给 run-tests.mjs 读的（2026-08-08 · issue #160）──
// 被 defer 的只有 **§⑩①b「真喂一次 SessionStart payload，看注入正文里有没有那一行」**这一节，
// 其余 90+ 条（合成夹具 + mutation + 直跑脚本）**全部照跑**，那才是本回归网的判别力所在。
//
// **为什么它是环境敏感的 —— 根因不是「git 状态」，是 hook 的墙钟预算**（本批实测归因）：
//   `dao-scaffold-check.js` 自己看表：总预算读自**用户真实** `~/.claude/settings.json` 里
//   本 hook 的注册 `timeout`（本机 10s），扣掉收尾余量后有效截止线 8500 ms。
//   预算见底时它就**不起下一个子进程**，并打一行 `⏱ … **没跑**`。
//   always-on 字节预算那一项排在第 9 位，前面有条款库结构闸（PowerShell 冷起）、死闸检测等。
//   ⇒ 三件事一起把它挤出去：①用户改注册 timeout（那是别人拥有的机器级可变状态）
//   ②机器负载（多官并行时子进程变慢）③**git 状态**——未提交改动 / 领先落后 origin
//   会让同步漂移多算几项、多起几次 git 子进程。
//   本批实测：干净树 + 1 个未提交改动，`已花 4572 ms / 有效截止线 8500 ms`（54%）⇒ 这一格
//   **没有余量可言，只是这次没撞上**。把预算压到 3000 ms（`DAO_HOOK_BUDGET_MS=3000`）
//   ⇒ 本文件当场红 **3 条**，与 issue #160 报的条数逐条吻合。
//
// 🔴 **同批修掉一个假通过，它比分层这件事更值钱**：原「调用点可达」那一条断言写的是
//   `/字节预算/.test(r.ctx)`，而**预算跳过时打的那句 `⏱ always-on 字节预算闸 **没跑**`
//   自己就含「字节预算」四个字** ⇒ 那条断言在「调用点这次压根没被跑到」时**照常 PASS**，
//   而它的名字说的正是相反的事。现在判据换成「六条返回路径的行首标记（ⓘ/✗）之一」，
//   并另立一条前置断言专门报「这次是被预算跳过的」（归因不指向被测对象）。
//
// ⚠ **跑 --env 要什么环境**：串行 —— 没有别的官在跑测试 · 没人在改 `~/.claude/settings.json`。
//   照直写它兜不住的那一格：`--env` 里这一节**仍可能因预算而红**（只是那时报文会明说是预算，
//   并给出自查命令）。要把它变成结构上不可能红，得给 hook 加一个「测试模式下放宽预算」的
//   口子，而那个口子会让被测的降级路径不再是真的 —— 本批**不做**，理由写在这里备查。
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

// 用户 2026-08-02 拍板的目标闸值。**写死在这里是刻意的**：它是这份回归网要钉住的那个
// 契约本身（用户的裁决），从被测源码里解析回来再断言等于自己，等于用被守对象证明被守
// 对象。改这个数应当同时改源码与本行 —— 改一处即红，正是想要的。
const EXPECT_TARGET = 16384;
// 过渡上限 = 2026-08-01 那版闸值，本批一个字节没改（见源码 TRANSITION_CEILING_BYTES 头注）。
const EXPECT_CEILING = 71680;

// 环境敏感层开关：命令行 `--env`，或环境变量 DAO_TEST_ENV_TIER=1（跨 shell 时后者更省事）。
// run-tests.mjs 在 `--env` 下把这个 flag 透传给每个测试文件。形态与 dead-gates 逐字一致。
const ENV_TIER = process.argv.includes("--env") || process.env.DAO_TEST_ENV_TIER === "1";

let pass = 0, fail = 0, defer = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}
// defer 不是 skip：它进汇总行的 `DEFER=n` 字段，run-tests.mjs 据此把整场退出码顶成 2。
// **报 DEFER=n 就必须打 n 行 `DEFER ` 明细**（run-tests 的笨计数器与它对拍）。
function deferSection(name, why) {
  defer++;
  console.log("  DEFER " + name + "  ->  " + why);
}
const DEFER_WHY = "环境敏感层：hook 墙钟总预算读自用户真实 ~/.claude/settings.json 的注册 timeout，"
  + "再被机器负载与 git 状态（未提交/领先落后 origin ⇒ 同步漂移项变多）一起挤 ⇒ 与被测对象无关的红（issue #160）。"
  + "跑它：node tests/alwayson-budget.tests.js --env（要求串行环境）";

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
console.log("\n──── ⑧.5 两档闸值：目标(16KiB) vs 过渡上限(70KiB) ────");
// 2026-08-02 加。这一节夹的是**新增的那半个语义**：同一份语料，过渡期 exit=0、strict 下
// exit=1，而两态的 `overtarget` 必须**完全相同**（欠账不因为你用哪种模式看它而改变）。
// 🔴 **最要紧的一条是「过渡期不许把欠账藏起来」**：过渡期的退出码是 0，若 `overtarget`
// 也一并归 0，那这一整档设计就退化成「把闸值从 70KiB 改成 70KiB」——一个字都没做。
// 这正是本文件头注说的「绿是这道闸的默认色，所以绿必须被证明」在新维度上的形态。
{
  // 造一份**介于两档之间**的语料：> 目标(16384)、< 过渡上限(71680)。
  // 这是唯一能把两档分开的区间；小于 16384 或大于 71680 的语料两档表现一致，夹不住任何东西。
  const body = "# dao\n" + "两档之间的语料。".repeat(2000);   // ≈ 48KB，稳落区间内
  const c = mkCase("two-tier", { daoMd: body, userMd: "# user\n短。\n", mkRulesDir: true });
  check("夹具确实落在两档之间（否则本节整节空转）",
    c.expectTotal > EXPECT_TARGET && c.expectTotal < EXPECT_CEILING,
    "total=" + c.expectTotal + " target=" + EXPECT_TARGET + " ceiling=" + EXPECT_CEILING);

  // 不传 --limit（它蕴含 strict），只覆写三个路径 —— 于是走的是真实的默认两档逻辑。
  function runRaw(extra, env) {
    const args = [SCRIPT,
      "--dao-md", path.join(c.dir, "dao.md"),
      "--user-claude-md", path.join(c.dir, "home", "CLAUDE.md"),
      "--rules-dir", path.join(c.dir, "rules")].concat(extra || []);
    const r = spawnSync(process.execPath, args, {
      encoding: "utf8", timeout: 60000,
      env: Object.assign({}, process.env, { DAO_ALWAYSON_STRICT: "" }, env || {}),
    });
    const o = String(r.stdout || "");
    const line = (/ALWAYSON_BUDGET_SUMMARY[^\r\n]*/.exec(o) || [""])[0];
    const g = (k) => { const m = new RegExp("\\b" + k + "=(-?\\d+|transition|strict|ok|fail)").exec(line); return m ? m[1] : null; };
    return { code: r.status, out: o, line,
      exit: +g("exit"), total: +g("total"), limit: +g("limit"), headroom: +g("headroom"),
      target: +g("target"), overtarget: +g("overtarget"), mode: g("mode"), self: g("selfcheck") };
  }

  const t = runRaw([]);                                    // 默认 = 过渡期
  const s = runRaw(["--strict"]);                          // 显式 strict
  const e = runRaw([], { DAO_ALWAYSON_STRICT: "1" });      // 环境变量 strict

  check("默认即过渡期 mode=transition", t.mode === "transition", t.line);
  check("过渡期：exit=0（不让主干长期红）", t.code === 0 && t.exit === 0, t.line);
  check("过渡期：limit 报的是过渡上限（`limit` 的语义＝退出码按哪个数判的）",
    t.limit === EXPECT_CEILING, t.line);
  check("过渡期：target 报的是用户拍板值", t.target === EXPECT_TARGET, t.line);
  // 🔴 本节最承重的一条
  check("过渡期：overtarget **不为 0**（欠账没被 exit=0 藏起来）",
    t.overtarget === t.total - EXPECT_TARGET && t.overtarget > 0,
    "overtarget=" + t.overtarget + " want=" + (t.total - EXPECT_TARGET));
  check("过渡期：报文明说是过渡期且不是回归（人读通道同样不许被读成绿灯）",
    /过渡期/.test(t.out) && /不是回归/.test(t.out), t.out.slice(-1200));
  check("过渡期：**不得**打「✓ 未超限」（那是真达标才有的对勾）",
    !/✓ 未超限/.test(t.out), t.out.slice(-1200));
  check("过渡期：仍原样给出三个出口（欠着账更需要出口）",
    /①/.test(t.out) && /②/.test(t.out) && /③/.test(t.out), t.out.slice(-1200));

  check("--strict：mode=strict 且 exit=1", s.mode === "strict" && s.code === 1 && s.exit === 1, s.line);
  check("--strict：limit 变成目标闸值", s.limit === EXPECT_TARGET, s.line);
  check("DAO_ALWAYSON_STRICT=1 与 --strict 等效（退出码+limit+mode 三格全等）",
    e.mode === s.mode && e.code === s.code && e.limit === s.limit, "env=" + e.line + " flag=" + s.line);

  // 两态一致性：同一份语料，欠账大小与总字节不因模式而变
  check("两态的 total 与 overtarget 完全相同（模式只改「按哪个数判」，不改测量）",
    t.total === s.total && t.overtarget === s.overtarget,
    "transition=" + t.line + "\n strict=" + s.line);
  check("headroom 恒 = limit - total（两态各自自洽）",
    t.headroom === t.limit - t.total && s.headroom === s.limit - s.total,
    "transition=" + t.line + "\n strict=" + s.line);

  // 负控：`--limit` 蕴含 strict —— 否则既有 §② 的「超限必红」会被过渡上限静默放宽
  {
    const l = runRaw(["--limit", "500"]);
    check("负控：给了 --limit 即 strict（不许被过渡上限悄悄放宽）",
      l.mode === "strict" && l.limit === 500 && l.exit === 1, l.line);
  }
  // 负控：低于目标的语料，两档都绿且 overtarget=0（防「过渡期恒报欠账」的反向失效）
  {
    const tiny = mkCase("two-tier-under", { daoMd: "# dao\n小。\n", userMd: "# user\n短。\n", mkRulesDir: true });
    const args = [SCRIPT, "--dao-md", path.join(tiny.dir, "dao.md"),
      "--user-claude-md", path.join(tiny.dir, "home", "CLAUDE.md"),
      "--rules-dir", path.join(tiny.dir, "rules")];
    const r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000 });
    const o = String(r.stdout || "");
    check("负控：达标语料 overtarget=0 且打「✓ 未超限」（过渡档不恒报欠账）",
      /\bovertarget=0\b/.test(o) && /✓ 未超限/.test(o) && r.status === 0, o.slice(-600));
    check("负控：达标语料**不得**出现「过渡期」措辞", !/⚠ 过渡期/.test(o), o.slice(-600));
  }
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

  // ①a **直跑脚本那一半：不经 hook，故与 hook 墙钟预算无关 ⇒ 留在默认层。**
  //     它钉的是「两档闸值那套新契约在真实语料上真的打得出末行」。
  const direct = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", timeout: 60000, cwd: REPO });
  const dline = /ALWAYSON_BUDGET_SUMMARY[^\r\n]*/.exec(String(direct.stdout || ""));
  const mOver = dline ? /\bovertarget=(\d+)/.exec(dline[0]) : null;
  check("末行带 target/overtarget/mode 三格（新契约在真实语料上真的打出来了）",
    dline !== null && /\btarget=\d+/.test(dline[0]) && mOver !== null && /\bmode=(transition|strict)/.test(dline[0]),
    dline ? dline[0] : "（没拿到末行）");

  // ①b **hook 注入那一半：环境敏感层**（为什么 —— 见文件头那段归因，根因是 hook 墙钟预算）
  if (!ENV_TIER) {
    deferSection("⑩①b 真仓 SessionStart 注入（hook 墙钟预算 = 用户 settings.json 里本 hook 的注册 timeout）", DEFER_WHY);
  } else {
    const r = runHook(REPO);

    // 🔴 **前置：这一项这次到底跑没跑。** 预算见底时 hook 打的是
    //   `⏱ always-on 字节预算闸 **没跑**：宿主预算只剩 X ms…`，而**那句话本身含「字节预算」**
    //   ⇒ 原来那条 `/字节预算/` 断言在「压根没跑到」时照常 PASS（本批实测坐实）。
    //   故这一条单独立出来：它红的时候直说「红来自预算，不来自被测对象」。
    const budgetSkipped = /⏱ always-on 字节预算闸 \*\*没跑\*\*/.test(r.ctx);
    check("⑩①b 前置：hook 没有因墙钟预算跳过 always-on 字节预算这一项（红了先看这一条）",
      !budgetSkipped,
      "**这条红说明本节下面几条不可信，且成因与被测对象无关**：hook 的墙钟预算被吃光了。"
      + "自查：① 看注入里那行 `ⓘ hook 墙钟预算：本次已花 … / 宿主给 …`"
      + " ② 收干净 git 状态（未提交 / 领先落后 origin 会让同步漂移多起几次子进程）"
      + " ③ 别和别的官同时跑测试 ④ 手跑一次：node ccswitch/scripts/check-alwayson-budget.mjs"
      + "\nctx=" + r.ctx.slice(0, 700));

    // 可达性：**六条返回路径的行首标记（ⓘ / ✗）之一**——脚本不在 / 探测失败 / 跑不起来 /
    // 契约被改坏 / FAIL / 绿，全部以那两个字符之一开头，故这条对真实语料是绿是红不敏感；
    // 而 `⏱ …没跑` 那一行**不在这两个标记里**，于是「没跑」再也不能冒充「跑到了」。
    check("真仓 SessionStart 注入里出现字节预算那一行（调用点可达；「⏱ 没跑」不算跑到）",
      /(?:ⓘ|✗) always-on 字节预算/.test(r.ctx),
      "ctx=" + r.ctx.slice(0, 500) + " [stderr]" + r.err.slice(0, 200));
    check("常路带出数字（总字节 / 闸值 / 余量），不是零输出",
      /合计 \d+ B \/ 闸值 \d+ B/.test(r.ctx) && /余量/.test(r.ctx), r.ctx.slice(0, 600));
    // 🔴 **本条 2026-08-02 换掉了原断言 `/占位待用户拍板/`，按「改既有断言必须证明新断言
    // 更难满足」逐项交代**：旧断言钉的是「闸值尚未被用户拍板」这个**当时为真、现已为假**
    // 的事实（用户 2026-08-02 拍板 16KiB）。留着它只有两条路——要么在源码里保留一句假话去
    // 喂断言，要么它变红。**这不是放松断言，是它测的那个契约不存在了。**
    // 新旧无法比通过集（对象不同），故改用更硬的判据：**新断言严格更多、且每条都钉具体数字**
    //   ① 打出目标闸值的**精确字节数**（旧断言只要五个中文字还在就绿）
    //   ② 打出**拍板日期**
    //   ③ 两态互斥且各自钉死措辞：过渡期必须报**欠账字节数** + 「不是回归」 + `--strict` 出路；
    //      已达标必须报「已达标」且**不得**出现「过渡期」
    // ⇒「目标闸值算错 / 把过渡期说成达标 / 把欠账数吞掉」这三类改动现在都会让本节红，
    //   而旧断言对它们**全部失明**。
    //
    // `EXPECT_TARGET` 刻意**写死**而不是从源码解析：本行的职责就是钉住用户拍板的那个数，
    // 从被测源码里读回来再断言等于自己（同 dao 守卫铁律「自检那一半不许复用被守对象」）。
    check("常路打出目标闸值的精确字节数 + 拍板日期（不是一句无数字的短语）",
      new RegExp("目标闸值 " + EXPECT_TARGET + " B").test(r.ctx) && /2026-08-02 拍板/.test(r.ctx),
      "want『目标闸值 " + EXPECT_TARGET + " B』+ 拍板日期; ctx=" + r.ctx.slice(0, 800));

    // 两个独立消费方（脚本末行 / hook 注入文本）必须对同一实况给出一致的读数。
    // 单看任一方都可能自洽而错；交叉核对才抓得到「hook 把过渡期渲染成达标」这类分岔。
    // ⚠ `direct` / `dline` / `mOver` 现在由 ①a 求值（那半不经 hook、留在默认层），
    //   这里只消费它们 —— **刻意不再跑第二遍**：跑两遍等于让两条断言看两份不同时刻的实况，
    //   而「两个消费方不许分岔」这条正需要它们看的是同一个瞬间。
    if (mOver) {
      const owed = mOver[1];
      console.log("        实况 overtarget=" + owed);
      if (Number(owed) > 0) {
        check("过渡期：hook 文本报出的欠账数与脚本末行逐字节一致（两个消费方不许分岔）",
          new RegExp("欠 " + owed + " B").test(r.ctx), "owed=" + owed + " ctx=" + r.ctx.slice(0, 900));
        check("过渡期：明说「不是回归」（否则会被下一个人当成新缺陷去查）",
          /不是回归/.test(r.ctx), r.ctx.slice(0, 900));
        check("过渡期：给出 --strict 出路（一笔没有出路的欠账等于无人认领）",
          /--strict/.test(r.ctx), r.ctx.slice(0, 900));
        check("过渡期**不得**渲染成「已达标」（两种绿必须分得开）",
          !/已达标/.test(r.ctx), r.ctx.slice(0, 900));
      } else {
        check("已达标态：明说已达标", /已达标/.test(r.ctx), r.ctx.slice(0, 900));
        check("已达标态**不得**渲染成过渡期", !/过渡期/.test(r.ctx), r.ctx.slice(0, 900));
      }
    }
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

console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " DEFER=" + defer + " ===");
if (defer) {
  console.log("  ⚠ 本次未跑上面 DEFER 那几节 —— **「没跑」不等于「跑了全过」**");
  console.log("  跑完整层：node tests/alwayson-budget.tests.js --env   （要求串行环境，见文件头）");
}
process.exit(fail ? 1 : 0);
