#!/usr/bin/env node
// gen-clause-index.mjs — 生成 / 校验条款机器面索引（P6 第一步）
//
// ── 三个模式 ─────────────────────────────────────────────────────────────────
//   （缺省）生成    node ccswitch/scripts/gen-clause-index.mjs
//   --check  漂移   源变了而索引没跟上 ⇒ exit 1「索引过期」。**不写盘。**
//   --reconcile 对账 与 ccswitch/scripts/check-clauses-structure.ps1（一套**独立**解析）
//                   逐文件对 `clauses` / `notrigger` / `slugs` / `maskdiv` 四个量；
//                   任一不一致 ⇒ exit 1。
//
// ── 为什么要有 --reconcile（它不是「测试的一部分」，是这套派生物的存活条件）────
// 索引是派生物，而派生物最典型的死法是**它自己变瞎了却照样输出一份看起来正常的东西**：
// 解析漏掉一整节 ⇒ 条款少了 ⇒ 索引仍然是合法 JSON、仍然能渲染、`--check` 仍然绿
// （因为它拿自己的解析结果和自己的解析结果比）。唯一能戳破这一层的是**第二套独立读法**。
// PS 那个守卫恰好就是：同一份语料、不同的扫描面走法、各自数出一个数。两个数一致，
// 才叫「我没瞎」；不一致时**不判谁对**，只报差异清单 —— 判谁对是人的活。
//
// ── 前三个量共同的盲区，和第四个量（2026-08-02，issue #91）────────────────────
// 前三个量全是「两边各数一遍再比」，它们有一个共同前提：**两边不会以同一种方式一起错**。
// 那个前提**曾经不成立** —— 反引号配对层在两侧是逐行直译（变量名/循环形状/分支顺序完全
// 对应），于是配对规则写错时两侧一起错、三个数逐字节相同、对账全绿。本批两件事一起做：
//   ㈠ 把本侧配对层重写成另一条算法路径（见 clause-parser.mjs 的 `backtickSpans` 头注）；
//   ㈡ 加第四个量 `maskdiv` —— 它**不是又一个计数**，是把对方的**第三套遮罩实现**
//      （`Get-MaskedLineAlt`，逐字符扫描，普查专用）与其主实现的逐字节互核结论带过来。
//      ㈠只解掉「照抄」这条路径，㈡才解掉「两边独立地想岔到一处」那条。
// 🕳 三套一起错仍然全绿 —— 那是算术不是疏漏，n 套互核抓不到 n 套同错。
//
// ── 三条对账时刻意做的取舍，写下来免得被读成 bug ─────────────────────────────
//   ① **对账只看数字，不看 PS 的退出码。** 零条款的源文件（ccswitch/rules/dao-powershell.md
//      等）会让 PS 守卫报 `zero-sample` 硬闸红 —— 那是它对「被检对象是条款库」这个前提的
//      合理防御，不是对账失败。故这里把 PS 退出码**原样打印在旁边**、不掺进裁定。
//   ② **但整批全零要红。** 每个文件都「0 == 0」的一致是空的一致：那正是「检测器数到 0 个
//      违例」与「检测器根本没看到样本」不可区分的形态。故总条款数为 0 ⇒ zero-sample 红。
//   ③ **PS 宿主不在 ⇒ exit 2，不是 exit 0。** 「跑不了」必须与「跑了且一致」分得开；
//      把它悄悄当成通过，等于亲手造一个死闸。
//
// ── v2（批 2 · 台账搬家）加了什么 ────────────────────────────────────────────
// 台账字段的真相源搬进 `ccswitch/clause-ledger.json`，正文只持一个行内 slug `[#<域>-<短名>]`。
// 于是本脚本多做一件事：**正文 ↔ 台账的双向孤儿检测 + 双轨值对账**（判据在 clause-parser 的
// `reconcileLedger`）。它是**硬闸**——四种命中形态全是结构错（指针指向空气 / 台账指着已删条款 /
// 条款进不了台账 / 同一个字段两边说的不一样），没有一种需要现场取舍。
//
// **台账检查按源逐份激活，不一刀切**：守卫要能跑在任意语料上（回归网夹具、别的仓的条款库），
// 而那些语料一个 slug 都没有、台账里也没有指着它们的条目 —— 此时「零 slug」是正常态不是违规。
// 判据：**这份源有 slug，或台账里有指着它的条目 ⇒ 台账检查对它生效**；两样都没有 ⇒ 打印一行
// 「不适用」（**不静默跳过**：静默跳过与「查了没事」在输出上不可区分，那正是本仓反复在治的病）。
//
// ── v4（issue #121 · 派生物在合并态过期）加了什么 ────────────────────────────
// 这份索引**在没有任何人做错事的时候也会过期**：两侧各自都跑了生成、各自都绿，
// 而合并把两份各自正确的派生物并成了一份不正确的（实测 3 例，第 3 例的官从头到尾
// 没碰过任何含条款的文件）。旧报文对此说的是「**是索引本身被手改了**」——
// **那句话在这个场景里是假的**，它会把读者支去查一件从未发生过的事。本批只改报文，
// 不动判定，三件事：
//   ① **归因分档**：`cause=` 进末行，四档（source / self-inconsistent / hand-or-generator / unreadable）。
//      🔴 **`self-inconsistent` 这一栏说的是「这份派生物的内部账目对不上」这个事实，不是凶手**
//      （2026-08-06 对抗验证订正：首版叫 `merged` 并写「没有人做错任何事」，而**手改一个计数、
//      手删数组一条、生成器 bug 算错计数**三种情形全都落进它 —— 那个判据分辨的是
//      「这次改动碰没碰到某个计数」，不是「是不是合并」。现在只陈述事实、并列三种成因）。
//   ② **处方分侧**：索引漂移跑生成器一定解得掉；**台账对不上跑生成器一个字都不会改**。
//      两侧各说各的，且**只在真的红了才打**（干净时一个字不打——不然它就是每次都出现的废话）。
//   ③ **仓态一行**：源变了那一档多问一句「是你改的，还是合并带进来的」（git 探针，fail-soft）。
// 🕳 **本批治的是第 2 点（报文不指向处方），不治第 1 点（发现得太晚）**，
//    也不治第 3 点（合并态验证被跳过时主干上没人再检它）——见 issue #121 的三点清单。
//
// ── 末行契约（机器读这一行，别去正则匹配上面的中文）──────────────────────────
//   生成/校验：CLAUSE_INDEX_SUMMARY exit=<n> sources=<n> clauses=<n> observation=<n> drift=<none|missing|content|source> wrote=<0|1> cause=<none|source|self-inconsistent|hand-or-generator|unreadable|missing>
//   台账：    CLAUSE_LEDGER_SUMMARY exit=<n> state=<ok|missing|bad|na> entries=<n> slugs=<n> missing_slug=<n> orphan_slug=<n> orphan_ledger=<n> dup_slug=<n> mismatch=<n> file_mismatch=<n> out_of_scope=<n> compared=<n> ledgeronly=<n>
//   对账：    CLAUSE_RECONCILE_SUMMARY exit=<n> host=<powershell|pwsh|none> files=<n> matched=<n> mismatched=<n> mine=<n> theirs=<n> myslugs=<n> theirslugs=<n>
//   **每条路径都打印**（含失败路径）：只在成功时打摘要，等于让「没查成」在机器通道上
//   表现为「什么都没说」。新字段一律**追加在末尾**，消费方按字段名取值（老正则照旧匹配得上）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  buildIndex,
  serializeIndex,
  defaultSources,
  DEFAULT_INDEX_REL,
  DEFAULT_LEDGER_REL,
  SELECTOR,
  PS_SELECTOR,
  parseFile,
  normalizeText,
  loadLedger,
  reconcileLedger,
  auditIndexSelfConsistency,
  REGEN_CMD,
} from "../lib/clause-parser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const PS_SCRIPT_DEFAULT = path.join(REPO_ROOT, "ccswitch", "scripts", "check-clauses-structure.ps1");
const LEDGER_DEFAULT = path.join(REPO_ROOT, DEFAULT_LEDGER_REL);

// ── 参数 ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {
    mode: "generate",
    out: null,
    sourcesJson: null,
    psScript: PS_SCRIPT_DEFAULT,
    ledger: LEDGER_DEFAULT,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") o.mode = "check";
    else if (a === "--reconcile") o.mode = "reconcile";
    else if (a === "--list-sources") o.mode = "list-sources";
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--sources-json") o.sourcesJson = argv[++i];
    else if (a === "--ps-script") o.psScript = argv[++i];
    else if (a === "--ledger") o.ledger = argv[++i];
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--help" || a === "-h") o.mode = "help";
    else {
      process.stdout.write(`未知参数：${a}\n`);
      o.mode = "help";
      o.bad = true;
    }
  }
  return o;
}

function loadSources(o) {
  if (!o.sourcesJson) return defaultSources();
  const p = path.isAbsolute(o.sourcesJson) ? o.sourcesJson : path.join(process.cwd(), o.sourcesJson);
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  const list = Array.isArray(doc) ? doc : doc.sources;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`源清单为空或格式不对：${p}（要一个数组，或 {"sources":[…]}）`);
  }
  for (const s of list) {
    if (!s.file) throw new Error(`源清单条目缺 file 字段：${JSON.stringify(s)}`);
    if (!Object.values(SELECTOR).includes(s.selector)) {
      throw new Error(`源清单条目 selector 非法：${JSON.stringify(s)}`);
    }
  }
  return list;
}

// `cause=` 是 v4 追加在末尾的第七栏（issue #121）：drift 说的是**过期了没有**，
// cause 说的是**为什么** —— 前者早就有了，而「为什么」此前只以一句写死的中文存在，
// 且那句话在合并场景里是假的。缺省 `none`，只有真过期时才有别的取值。
function summaryLine({ exit, sources, clauses, observation, drift, wrote, cause }) {
  return `CLAUSE_INDEX_SUMMARY exit=${exit} sources=${sources} clauses=${clauses} observation=${observation} drift=${drift} wrote=${wrote}` +
    ` cause=${cause || "none"}`;
}

function outPath(o) {
  if (o.out) return path.isAbsolute(o.out) ? o.out : path.join(process.cwd(), o.out);
  return path.join(REPO_ROOT, DEFAULT_INDEX_REL);
}

// ── 台账（clause-ledger.json）双向对账 ───────────────────────────────────────
function ledgerSummary(f) {
  return `CLAUSE_LEDGER_SUMMARY exit=${f.exit} state=${f.state} entries=${f.entries} slugs=${f.slugs}` +
    ` missing_slug=${f.missing_slug} orphan_slug=${f.orphan_slug} orphan_ledger=${f.orphan_ledger}` +
    ` dup_slug=${f.dup_slug} mismatch=${f.mismatch} file_mismatch=${f.file_mismatch} out_of_scope=${f.out_of_scope}` +
    // v3（批 3）追加在末尾：`compared` 是 `mismatch` 的**分母**（真正比过的字段数），
    // `ledgeronly` 是「正文没这一栏、以台账为准」的字段数。
    // `mismatch=0 compared=0` 与 `mismatch=0 compared=300` 是两件事 —— 没有分母时它们长得一样。
    ` compared=${f.compared || 0} ledgeronly=${f.ledgeronly || 0}`;
}

function runLedgerCheck(o, sources, parsedBySource) {
  // `--quiet` 只压**汇报型**输出（下面的 `note`）；违规明细与末行 marker 永远打 ——
  // 一次什么都不说的失败，正是这套东西在治的病。
  const write = (s) => process.stdout.write(s + "\n");
  const note = (s) => { if (!o.quiet) process.stdout.write(s + "\n"); };
  const scope = sources.map((s) => s.file);
  const records = [];
  for (const s of sources) {
    const p = parsedBySource.get(s.file);
    if (p) records.push(...p.clauses, ...p.observation);
  }
  const slugsInText = records.filter((r) => r.slug || (r.slugs && r.slugs.length)).length;

  const led = loadLedger(path.isAbsolute(o.ledger) ? o.ledger : path.join(process.cwd(), o.ledger));
  const entries = Object.keys(led.clauses).length;
  const pointedHere = Object.values(led.clauses).filter((e) => e && scope.includes(e.file)).length;

  // 激活判据：正文里有 slug，或台账里有指着本批源的条目。两样都没有 ⇒ 不适用（**打印，不静默**）。
  if (slugsInText === 0 && pointedHere === 0) {
    note("ⓘ 台账对账不适用：本批语料零 slug，且 " + (led.ok ? "台账里也没有指着它们的条目" : "台账不可用（" + led.why + "）") + "。");
    note("   （这一行刻意存在：静默跳过与「查了且没事」在输出上不可区分。）");
    const f = {
      exit: 0, state: "na", entries, slugs: 0, missing_slug: 0, orphan_slug: 0,
      orphan_ledger: 0, dup_slug: 0, mismatch: 0, file_mismatch: 0, out_of_scope: 0,
    };
    write(ledgerSummary(f));
    return 0;
  }
  if (!led.ok) {
    write("✗ 台账读不了：" + led.path + "（" + led.why + "）—— 而正文里有 " + slugsInText + " 个 slug 指着它。");
    write("   「读不了」不等于「没问题」：那些 slug 现在全是指向空气的指针。");
    const f = {
      exit: 1, state: led.why === "不存在" ? "missing" : "bad", entries: 0, slugs: slugsInText,
      missing_slug: 0, orphan_slug: slugsInText, orphan_ledger: 0, dup_slug: 0, mismatch: 0,
      file_mismatch: 0, out_of_scope: 0,
    };
    write(ledgerSummary(f));
    return 1;
  }

  const r = reconcileLedger(records, led, scope);
  // `out_of_scope` 的闸位取舍：跑**自带源清单**（`--sources-json`，回归网/临时语料）时它是常态，
  // 只打印；跑**默认清单**时它意味着「台账里有一条指着一份没人在扫的文件」⇒ 判红。
  const strict = !o.sourcesJson;
  const hard =
    r.missingSlug.length + r.orphanSlug.length + r.orphanLedger.length +
    r.dupSlug.length + r.mismatch.length + r.fileMismatch.length +
    (strict ? r.outOfScope.length : 0);

  const show = (label, rows, fmt) => {
    if (!rows.length) return;
    write("  ✗ " + label + "：" + rows.length + " 条");
    for (const x of rows.slice(0, 12)) write("      · " + fmt(x));
    if (rows.length > 12) write("      · …另 " + (rows.length - 12) + " 条");
  };
  note("== 条款台账双向对账（正文 slug ↔ ccswitch/clause-ledger.json）==");
  show("正文是条款却没有 slug（台账对它失明）", r.missingSlug, (x) => `${x.file}:${x.line} ${x.title}`);
  show("slug 重复 / 一行多个", r.dupSlug, (x) => `${x.file}:${x.line} [#${x.slug}] —— ${x.why}`);
  show("正文有 slug 而台账无此条（指向空气的指针）", r.orphanSlug, (x) => `${x.file}:${x.line} [#${x.slug}]`);
  show("台账有条目而正文找不到它（条款被删/改名而台账没跟上）", r.orphanLedger, (x) => `[#${x.slug}] 台账说它在 ${x.file}`);
  show("台账记的 file 与 slug 实际所在文件不符", r.fileMismatch, (x) => `[#${x.slug}] 正文在 ${x.inText}，台账写 ${x.inLedger}`);
  show("值不等（行内元字段 vs 台账；正文没写那一栏的不比，见 clause-parser v3）", r.mismatch,
    (x) => `${x.file}:${x.line} [#${x.slug}] ${x.field}：正文=${JSON.stringify(x.inText)} 台账=${JSON.stringify(x.inLedger)}`);
  if (r.outOfScope.length) {
    write((strict ? "  ✗ " : "  ⓘ ") + "台账条目指向本批扫描面之外的文件：" + r.outOfScope.length + " 条" +
      (strict ? "（跑默认源清单时这是红：那条条款没有任何守卫在看）" : "（自带源清单，属常态）"));
    for (const x of r.outOfScope.slice(0, 12)) write("      · [#" + x.slug + "] → " + x.file);
  }

  const f = {
    exit: hard > 0 ? 1 : 0, state: "ok", entries, slugs: r.checked,
    missing_slug: r.missingSlug.length, orphan_slug: r.orphanSlug.length,
    orphan_ledger: r.orphanLedger.length, dup_slug: r.dupSlug.length,
    mismatch: r.mismatch.length, file_mismatch: r.fileMismatch.length,
    out_of_scope: r.outOfScope.length, compared: r.compared, ledgeronly: r.ledgerOnly,
  };
  if (hard === 0) {
    note("  ✓ " + r.checked + " 条 slug 与台账逐条对上，零不等（台账 " + entries + " 条）。");
    note("     ⓘ 字段级：比过 " + r.compared + " 处 · 正文没这一栏、以台账为准 " + r.ledgerOnly + " 处。" +
      (r.compared === 0 ? "  ⚠ 分母为 0 —— 这一轮的「零不等」不含任何字段级证据。" : ""));
    note("     它证不了的：台账里的**数字对不对**本闸判不了（同 `触发:` 取值真伪），只保证两边说的是同一句话。");
  }
  // 台账不全（n/first_seen/trigger 为 null）是**观察线**不是闸：回填还是承认未知，是判断。
  const incomplete = Object.entries(led.clauses)
    .filter(([, e]) => e && e.status !== "retired" && (!e.n || !e.first_seen || !e.trigger));
  if (incomplete.length) {
    note("  ⓘ 台账不全 " + incomplete.length + " 条（有 slug、缺 n/首次入库/触发点）—— 观察线，不进退出码：" +
      incomplete.map(([k]) => "[#" + k + "]").join(" · "));
    note("     这几条正是 v1 选择器结构上看不见的那批（带 [基线:]/[自定@] 却无 [n= @ 触发:] 签名）。");
    note("     处置是**回填还是承认未知**——那是判断，不设闸；搬录时刻意不替未知编一个值。");
  }
  write(ledgerSummary(f));
  return f.exit;
}

// ── 仓态探针（issue #121 第 3 例）────────────────────────────────────────────
// 「源变了」这一档有两种完全不同的处境：**你改了它**，与**合并把别人的改动带了进来**。
// 报文若只说「有人改了源没重新生成」，第二种处境下的读者会去查自己改了什么，
// 而答案是「你什么都没改」—— 那句报文本身在制造一次无谓的排查。
//
// **fail-soft 是硬要求**：git 不在 / 不在仓里 / 命令报错，一律**说出来**并按「判不了」处理，
// 绝不静默当成「不是合并」——把未知说成已知正是这套东西反复在治的病。
// **近似照直写**：`HEAD^2` 只认得出「HEAD 自己就是合并提交」；合并之后又提交过几次，
// 这个探针就看不出来了。它是提示不是判定。
function gitProbe(args) {
  try {
    const r = spawnSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", timeout: 30000 });
    if (r.error) return { ok: false, why: String(r.error.message || r.error) };
    if (r.status === null) return { ok: false, why: "git 没跑到底（超时或被杀）" };
    return { ok: true, status: r.status, out: String(r.stdout || "") };
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) };
  }
}

// 🔴 **2026-08-06 重写：打事实，不打判定**（对抗验证 C1 + C3 + `#官通-禁笃定措辞`）。
// 首版是一串 `if … return` 的**判定树**，第一个命中的分支直接下结论。两个后果：
//   ㈠ **合并进行中那一支结构上不可达** —— `dirty` 排在 `isMerge` 之前且直接 return，
//      而一次合并在飞时工作树**必然**是脏的 ⇒ 它会笃定地答「就是你」，
//      **而那正是 issue #121 场景本身**。这不是「缺夹具」，是判据缺口。
//   ㈡ 三条互斥分支只能被「三者必居其一」这种断言夹住 —— 任何一支都满足它，判别力为 0。
// 现在改成**逐条报三个独立事实**（合并在飞 / HEAD 是合并提交 / 这些源脏没脏），
// 三行各自可断言；只有在**证据真的指向一边**时才多说一句，其余时候闭嘴。
function printRepoState(write, files) {
  // 先问「这儿到底是不是个 git 仓」：不问的话，非仓目录里 `rev-parse` 的失败
  // 会被读成「HEAD 不是合并提交」—— 把「查不了」悄悄变成一个确定的答案，正是本批在治的病。
  const inRepo = gitProbe(["rev-parse", "--is-inside-work-tree"]);
  if (!inRepo.ok || inRepo.status !== 0) {
    write(`   ⓘ 仓态：判不了（${inRepo.ok ? "这里不是 git 工作树" : inRepo.why}）—— 照直说，**不当成「不是合并」**。`);
    return;
  }
  const say = (label, probe, yes) => {
    if (!probe.ok) return { known: false, text: `${label}：查不了（${probe.why}）` };
    return { known: true, value: yes(probe), text: `${label}：${yes(probe) ? "是" : "否"}` };
  };
  const inFlight = say("合并进行中（MERGE_HEAD 在）", gitProbe(["rev-parse", "-q", "--verify", "MERGE_HEAD"]), (p) => p.status === 0);
  const isMerge = say("HEAD 自己是合并提交", gitProbe(["rev-parse", "-q", "--verify", "HEAD^2"]), (p) => p.status === 0);
  const rel = files.filter((f) => !path.isAbsolute(f));
  const stProbe = rel.length ? gitProbe(["status", "--porcelain", "--", ...rel]) : { ok: true, status: 0, out: "" };
  const dirtyLines = stProbe.ok ? stProbe.out.split(/\r?\n/).filter((l) => l.trim()) : [];
  const dirty = say("上面那些源改过未提交", stProbe, () => dirtyLines.length > 0);

  write("   ⓘ 仓态（git 事实三条，**不是判定**）：");
  for (const f of [inFlight, isMerge, dirty]) write(`        · ${f.text}`);
  for (const l of dirtyLines.slice(0, 6)) write(`            ${l}`);

  // 只在证据真的指向一边时才多说一句。**合并在飞优先于「脏」**：那时脏是合并自己造成的，
  // 拿它推「是你改的」是把合并的产物记到人头上（首版就是这么错的）。
  if (inFlight.known && inFlight.value) {
    write("      ⇒ 一次合并正在进行中 ⇒ 工作树是脏的属正常，**别把它读成「是你改的」**。");
  } else if (isMerge.known && isMerge.value && dirty.known && !dirty.value) {
    write("      ⇒ HEAD 是合并提交且这些源没有本地改动 ⇒ **合并带进来的可能更大**（提示，非判定）。");
  } else if (dirty.known && dirty.value) {
    write("      ⇒ 这些源此刻有本地未提交改动 ⇒ **你自己改的可能更大**（提示，非判定）。");
  }
  write("      ⚠ 三条都是近似：合并之后又提交过几次，前两条就看不出来了；rebase/cherry-pick 一概不认。");
}

// ── 生成 / 校验 ──────────────────────────────────────────────────────────────
// 索引漂移与台账对账是**两个独立信号**，各打各的末行、退出码取严的那个：
// 「索引没跟上」与「台账对不上」是两种病、两种处方，并成一个数就分不开了。
//
// v4（issue #121）在两个信号都出完之后再打一段**处方**：它必须同时知道两侧的结果才写得对
// ——「跑一次生成器」对索引漂移一定管用，对台账对不上**一个字都不管用**，
// 而单看任何一侧都给不出这句话。
function runIndex(o) {
  const indexResult = runIndexCore(o);
  const indexCode = indexResult.code;
  let ledgerCode = 0;
  try {
    const sources = loadSources(o);
    const parsed = new Map();
    for (const s of sources) {
      const abs = path.isAbsolute(s.file) ? s.file : path.join(REPO_ROOT, s.file);
      if (!fs.existsSync(abs)) continue; // 源缺席已由 runIndexCore 报过，这里不重复报
      parsed.set(s.file, parseFile(abs, { file: s.file, selector: s.selector, roleScheme: s.role_scheme }));
    }
    ledgerCode = runLedgerCheck(o, sources, parsed);
  } catch (e) {
    process.stdout.write("✗ 台账对账抛错：" + (e && e.message ? e.message : String(e)) + "\n");
    process.stdout.write(ledgerSummary({
      exit: 1, state: "bad", entries: 0, slugs: 0, missing_slug: 0, orphan_slug: 0,
      orphan_ledger: 0, dup_slug: 0, mismatch: 0, file_mismatch: 0, out_of_scope: 0,
    }) + "\n");
    ledgerCode = 1;
  }
  printPrescription(indexResult, ledgerCode);
  return Math.max(indexCode, ledgerCode);
}

// ── 处方（issue #121 方向 2 的落点）─────────────────────────────────────────
// 🔴 **第一条铁律：干净的时候一个字都不打。** 一段每次都出现的「修法」提示等于噪音，
//    而噪音会被读者训练成盲区 —— 那正是本仓「生下来就吵的检查一定会被静音」那条。
// 🔴 **第二条：两侧各说各的，且要说清哪一侧那条命令管用。**
//    索引是纯派生物 ⇒ 重跑生成器一定对齐；台账**不是**派生物 ⇒ 生成器一个字都不会改它，
//    对着台账红说「跑一次生成器」是**给错处方**，比不给更糟（照做一次、照旧红、开始不信这段话）。
function printPrescription(indexResult, ledgerCode) {
  const indexRed = indexResult.code !== 0;
  const ledgerRed = ledgerCode !== 0;
  if (!indexRed && !ledgerRed) return; // ← 负控就钉在这一行上
  const write = (s) => process.stdout.write(s + "\n");
  write("── ⇒ 修法（本段只在有东西红的时候出现）──");
  if (indexRed) {
    write(`  · 索引这一侧：${REGEN_CMD}`);
    write("    ✓ 这条命令**一定解得掉**：索引是纯派生物，重跑即与真相源逐字节对齐，且幂等。");
    write("      三种成因（你改了源 / 合并带进来的 / 手改了派生物）**修法是同一条**，不必先查清是谁。");
  } else if (ledgerRed) {
    write("  · 索引这一侧无事（与真相源一致）——**下面那个跑生成器解决不了**，别顺手跑一遍就以为完了。");
  }
  if (ledgerRed) {
    write("  · 台账这一侧：要**人手**改 ccswitch/clause-ledger.json，或把条款正文改回去（逐条明细在上面）。");
    write("    ✗ 跑生成器对它**没用** —— 台账不是派生物，生成器一个字都不会碰它。");
  } else if (indexRed) {
    write("  · 台账这一侧无事：本次的红只有索引漂移这一种，跑上面那条命令就完了。");
  }
}

function runIndexCore(o) {
  const sources = loadSources(o);
  const target = outPath(o);
  let index;
  try {
    // repoRoot 恒为本仓：源清单可以指到仓外（测试的第三语料），仓内的源记相对路径、
    // 仓外的记绝对路径并标 external —— 由 buildIndex 自己判，这里不分叉。
    index = buildIndex(sources, { repoRoot: REPO_ROOT });
  } catch (e) {
    process.stdout.write(`✗ 构建索引失败：${e && e.message ? e.message : String(e)}\n`);
    process.stdout.write(
      summaryLine({ exit: 1, sources: sources.length, clauses: 0, observation: 0, drift: "missing", wrote: 0, cause: "unreadable" }) + "\n"
    );
    return { code: 1, drift: "missing", cause: "unreadable" };
  }
  const text = serializeIndex(index);
  const g = index._generated;

  if (o.mode === "check") {
    if (!fs.existsSync(target)) {
      process.stdout.write(`✗ 索引不存在：${target}\n`);
      process.stdout.write(
        summaryLine({
          exit: 1, sources: sources.length, clauses: g.totals.clauses,
          observation: g.totals.observation, drift: "missing", wrote: 0, cause: "missing",
        }) + "\n"
      );
      return { code: 1, drift: "missing", cause: "missing" };
    }
    // 比对**归一化后**的文本：索引由本脚本以 LF 写出，而 `core.autocrlf=true` 的机器
    // 一 checkout 就把它变成 CRLF ⇒ 逐字节比会让「刚 clone 完」表现为「索引过期」。
    // 判据是内容，不是行尾。（同 sha256File 那段的理由。）
    const onDisk = normalizeText(fs.readFileSync(target, "utf8"));
    if (onDisk === normalizeText(text)) {
      if (!o.quiet) {
        process.stdout.write(`OK：索引与真相源一致（${sources.length} 源 · ${g.totals.clauses} 条款 · ${g.totals.observation} 观察区条目）\n`);
        process.stdout.write("     未覆盖面：本检查只证明「索引 == 现在的 Markdown」，**不证明 Markdown 里的条款是对的**；\n");
        process.stdout.write("     条款自身的结构完整性归 check-clauses-structure.ps1，两套解析是否一致归 --reconcile。\n");
      }
      process.stdout.write(
        summaryLine({
          exit: 0, sources: sources.length, clauses: g.totals.clauses,
          observation: g.totals.observation, drift: "none", wrote: 0, cause: "none",
        }) + "\n"
      );
      return { code: 0, drift: "none", cause: "none" };
    }
    // 漂移了：先指名**哪个源**变了（拿盘上索引记的 sha256 对现在的文件）。
    let drift = "content";
    let cause = "hand-or-generator";
    const named = [];
    const changedFiles = [];
    let onDiskDoc = null;
    try {
      onDiskDoc = JSON.parse(onDisk);
      const oldSrc = new Map((onDiskDoc._generated?.sources || []).map((s) => [s.file, s.sha256]));
      for (const s of g.sources) {
        const before = oldSrc.get(s.file);
        if (before === undefined) { named.push(`${s.file}（索引里原本没有这个源）`); changedFiles.push(s.file); }
        else if (before !== s.sha256) { named.push(`${s.file}（内容已变）`); changedFiles.push(s.file); }
      }
      for (const f of oldSrc.keys()) {
        if (!g.sources.some((s) => s.file === f)) named.push(`${f}（已从源清单移除）`);
      }
      if (named.length) { drift = "source"; cause = "source"; }
    } catch (_) {
      named.push("（盘上索引不是合法 JSON，无法逐源比对）");
      cause = "unreadable";
    }
    const write = (s) => process.stdout.write(s + "\n");
    write("✗ 索引过期：与真相源不一致");
    if (named.length) for (const n of named) write(`   · 源变动：${n}`);

    // ── 归因（issue #121）──────────────────────────────────────────────────
    // 🔴 这一段替掉的是一句**在合并场景里为假**的断言（原文：「所有源的 sha256 都没变
    //    ⇒ 是索引本身被手改了」）。实测 3 例里有 2 例没有任何人手改过它。
    //    报文说错归因的代价不是「不够详细」，是**把读者支去查一件从未发生的事**。
    if (cause === "unreadable") {
      write("   ── 归因：盘上那份索引本身读不出来 ──");
      write("     它不是合法 JSON ⇒ 逐源比对做不了，也就说不出是谁动的。");
      write("     常见成因：一次**带冲突标记的合并**被直接提交了（`<<<<<<<` 还留在文件里）。");
    } else if (cause === "source") {
      write("   ── 归因：**源变了而索引没跟上**。三种成因长得一模一样，别只往第一种上猜 ──");
      write("     ① 你改了上面那些源，却没重新生成索引");
      write("     ② **合并**把别人改的源带了进来 —— 两侧各自都跑过生成、各自都绿，**是合并本身制造的过期**");
      write("     ③ 你从头到尾没碰过任何含条款的文件 —— ②的常见形态：分支只改了别的东西，merge 主干时把新条款带了进来");
      printRepoState(write, changedFiles);
    } else {
      // 所有源的 sha 都对得上 ⇒ 动的是**派生物这一侧**。再分两支，判据是这份索引**自己跟自己**对不对得上。
      //
      // 🔴 **2026-08-06 订正：这一支报的是「事实」，不是「凶手」**（对抗验证阻断 1）。
      //    本函数首版把「自相矛盾」直接判成 `cause=merged` 并写「没有人做错任何事」。
      //    对抗验证官构造了 4 个**没有任何合并参与**的场景，全部拿到那句话：
      //      · 手改 `totals.clauses` 96→95（一个字符）· 手删 `clauses` 数组里一条
      //      · **生成器 bug 把 totals 算少 1**（首版把它整个劝退了 —— 而 `hand-or-generator`
      //        档的成因②写的正是「生成器改了」，影响计数的生成器 bug 恰好从两档之间漏了过去）
      //    ⇒ 这个判据分辨的**根本不是「合并 vs 手改」**，是「这次改动碰没碰到某个计数」。
      //    首版还比它替掉的旧句更糟：旧句「是索引本身被手改了」在前两个场景里**逐字为真**，
      //    而首版把它换成假的、还加了「别按谁手改去查」——**从指错方向升级成叫人停止调查**。
      //    现在只陈述那个**真的**事实（内部账目对不上），把三种成因并列，一个都不排除。
      const audit = auditIndexSelfConsistency(onDiskDoc);
      if (audit.readable && audit.problems.length) {
        cause = "self-inconsistent";
        write("   ── 归因：所有源的 sha256 都对得上，而盘上那份索引**自己跟自己对不上** ──");
        for (const p of audit.problems.slice(0, 6)) write(`       · ${p}`);
        write("     这只说明**这份派生物的内部账目坏了**，**说不出是谁弄坏的**。三种成因都长这样：");
        // ⚠ ① 这一句 2026-08-06 由第二轮对抗验证**实测证伪后改写**（原文写「无冲突地留下旧值」）：
        //   真合并实测是基线 6、两侧各写 7、**git 留下 7、而实际已经是 8** ——
        //   留下的是**两侧共同写下的那个值**，它既不是旧值也不是对的值。
        //   准确的那一版当时就在 `clause-parser.mjs` 的函数头注里（「留下 96，而实际已经是 97」），
        //   **对的话在注释里、压缩过的错话在报文里** —— 注释没人读，报文人人读。
        write("     ① **合并**：两侧各加一条，`clauses` 数组两条都收了，而计数那一行两侧从同一个旧值改成了同一个新值");
        write("        ⇒ git 认为双方做了相同的修改、无冲突地留下**那个共同的新值**，而实际比它还多一条");
        write("     ② **手改**：有人直接动了计数，或从数组里删掉一条（改一个字符就够）");
        // ⚠ ③ 的尾巴上原本挂着一句编辑按语「这一格最该查，别因为像合并就放过」，2026-08-06 删掉。
        //   删它的三个理由（第二轮对抗验证，逐条实测）：
        //   ㈠ 它与下一行的「本报文不替你选」**直接打架**，两句不能同时为真；
        //   ㈡ 「别因为像合并就放过」预设了一个「像合并」，而本报文自己打出来的 git 事实
        //      在那三个构造里是 否/否/否 —— **证据里没有任何东西像合并**，这半句把刚拆掉的
        //      「默认读成合并」又装了回去；在 issue #121 那个正典合并场景里，它还会与四行之下的
        //      「⇒ 合并带进来的可能更大」**同屏对冲**；
        //   ㈢ 它抬举的恰恰是这个检查器**看不见**的那一格：`--check` 比的是「现在这个生成器新造的索引」
        //      vs 盘上那份，**bug 还活着时两者逐字节相同 ⇒ drift=none ⇒ 自洽性审计压根不会被调用**
        //      （实测：bug 在时 exit=0 一声不吭，把生成器修好之后才 exit=1）⇒ ③ 唯一可达的形态是
        //      「已经被修掉的旧 bug」。给一个结构上看不见的成因加「最该查」，是拿排序换准确。
        write("     ③ **生成器 bug**：算错了计数，然后把这份错的索引写进了盘");
        write("     ⚠ 本报文**不替你选**。下面那几行 git 事实只是线索，不是判定。");
        printRepoState(write, g.sources.map((s) => s.file));
      } else {
        write("   ── 归因：动的是**派生物这一侧或生成它的代码** ──");
        write("     所有源的 sha256 都对得上，而" +
          (audit.readable ? "这份索引内部账目自洽" : `这份索引的自洽性判不了（${audit.why}）`) +
          " ⇒ 两种成因，本报文分不开：");
        write("     ① 有人**手改**了这个派生物（它是派生物，手改无效且会被下次生成覆盖）");
        write("     ② 或者**生成器 / 解析器改了**（clause-parser.mjs / gen-clause-index.mjs 的输出变了），而索引没跟着重生成");
        write("     ⚠ 内部账目自洽**不排除合并**：「两侧各改一条已有条款正文、条数不变」的合并就是自洽的。");
        printRepoState(write, g.sources.map((s) => s.file));
      }
    }
    process.stdout.write(
      summaryLine({
        exit: 1, sources: sources.length, clauses: g.totals.clauses,
        observation: g.totals.observation, drift, wrote: 0, cause,
      }) + "\n"
    );
    return { code: 1, drift, cause };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
  if (!o.quiet) {
    process.stdout.write(`✓ 已写 ${path.relative(REPO_ROOT, target) || target}\n`);
    for (const s of g.sources) {
      process.stdout.write(
        `   · ${s.file}  [${s.selector}]  条款 ${s.clauses} · 观察区 ${s.observation} · 无字段 ${s.fieldless} · 触发:无 ${s.no_trigger}\n`
      );
    }
    const roles = Object.entries(g.roles).map(([k, v]) => `${k}=${v}`).join(" · ");
    process.stdout.write(`   官种分布：${roles || "（空）"}\n`);
  }
  process.stdout.write(
    summaryLine({
      exit: 0, sources: sources.length, clauses: g.totals.clauses,
      observation: g.totals.observation, drift: "none", wrote: 1, cause: "none",
    }) + "\n"
  );
  return { code: 0, drift: "none", cause: "none" };
}

// ── 源清单的机器可读出口（2026-08-07 · issue #176 / #169③）────────────────────
// **谁在消费它**：`ccswitch/scripts/check-clauses-structure.ps1` 的缺省全量模式（它据此
// 知道「要检哪几份、每份用哪个 -ClauseSelector」）。此前那两个问题在 PowerShell 侧没有答案
// ⇒ 那道闸缺省只检 dao.md，而 CLAUDE.md 与 docs/rules/dispatch-clauses.md §三宣称的
// 「两套独立解析各查一遍」对住在 rules/ 里的 90+ 条条款**不成立**（issue #176）。
//
// **共享的是清单，不是 parser**：PS 侧照旧用它自己那套解析去读每一份文件 —— `--reconcile`
// 的判别力全部建立在「两套读法各数一遍」上，那一层一个字没动。这里递过去的只有
// 「哪几份 + 各用哪个选择器」，而那本来就该有唯一真相源（`defaultSources()`），
// 在此之前它被 PS 侧与 hook 侧各自猜了一遍。
//
// **输出契约**：stdout **只有一行 JSON**（不打任何中文说明 —— 消费方要 `ConvertFrom-Json`，
// 混一行人话进去就是让它当场解析失败）。失败时**不打 JSON、退非 0**：消费方据此 fail-closed，
// 「拿不到清单」绝不许长得像「清单是空的」。
function runListSources(o) {
  const sources = loadSources(o); // 抛错由 main 的 catch 兜，退非 0
  const doc = {
    schema: 1,
    repo_root: REPO_ROOT,
    // `file` 原样给（相对 repo_root，或自带源清单里写的绝对路径）；`abs` 是替消费方算好的
    // 绝对路径 —— 让 PowerShell 再去拼一次相对路径解析，等于把「相对谁」这个坑复制一份过去。
    sources: sources.map((s) => ({
      file: s.file,
      abs: path.isAbsolute(s.file) ? s.file : path.join(REPO_ROOT, s.file),
      exists: fs.existsSync(path.isAbsolute(s.file) ? s.file : path.join(REPO_ROOT, s.file)),
      selector: s.selector,
      ps_selector: PS_SELECTOR[s.selector] || null,
      role_scheme: s.role_scheme,
    })),
  };
  process.stdout.write(JSON.stringify(doc) + "\n");
  return 0;
}

function findPsHost() {
  for (const host of ["powershell", "pwsh"]) {
    const r = spawnSync(host, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8", timeout: 60000 });
    if (r.status === 0) return host;
  }
  return null;
}

function runPs(host, script, file, selector) {
  const r = spawnSync(
    host,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      "-TargetFile", file, "-ClauseSelector", PS_SELECTOR[selector]],
    { encoding: "utf8", timeout: 300000 }
  );
  const out = String(r.stdout || "");
  const m = /CLAUSE_STRUCTURE_SUMMARY exit=(\d+) clauses=(\d+) violations=(\d+) notrigger=(\d+)/.exec(out);
  // v2 追加字段单独取：**用独立正则、允许缺席**，这样对方是老版本时能报出「对方没有 slugs 这一栏」，
  // 而不是整条 marker 匹配失败、退化成「对方没给末行」那种什么都看不出来的状态。
  const sm = /\bslugs=(\d+)/.exec(out);
  // `maskdiv` / `maskcmp`（2026-08-02，issue #91）同样单独取、允许缺席 —— 理由同上：
  // 对方是老版本时要报得出「它没有这一栏」，而不是整条 marker 匹配失败。
  const dm = /\bmaskdiv=(\d+)/.exec(out);
  const cm = /\bmaskcmp=(\d+)/.exec(out);
  return {
    code: r.status,
    marker: m ? {
      exit: +m[1], clauses: +m[2], violations: +m[3], notrigger: +m[4],
      slugs: sm ? +sm[1] : null,
      maskdiv: dm ? +dm[1] : null,
      maskcmp: cm ? +cm[1] : null,
    } : null,
    out,
    err: String(r.stderr || ""),
  };
}

// ── 对方硬闸退出码的**归类**（issue #121 顺带一格）────────────────────────────
// 改这一格的理由是**它恒响**：默认源清单 12 份里有 6 份是零条款细则档，每一次干净的对账
// 都会在 ✓ 行里打 6 个 `对方硬闸 exit=1`。而「生下来就吵的检查一定会被静音」——
// 一旦读者学会无视 ✓ 行里的 `exit=1`，**真正的结构违例也一起被无视了**（对方的 exit=1
// 至少有两种含义，而对账既不判它、也没在别处拦它）。
// ⇒ 本批**不静音、不加闸**（加闸属判断档：谁来定哪份源该有条款），只做一件事：
//   把这个数字**分类命名**，让「预期内的零样本」与「真的结构违例」在同一行里分得开。
// 🔴 **2026-08-06 重写：判据改成「读对方报的违例类型」，不再从 `clauses===0` 推断**
//   （对抗验证 C2）。首版只看 `clauses===0` 并硬编码「减掉 1」，两个后果：
//     ㈠ 喂 `exit=4 clauses=0 violations=0` 也会得到「zero-sample，**不是失败**」——
//        把一个说不清的退出码抄进一句「这不是失败」里；
//     ㈡ 对方哪天把 `zero-sample` 移出 `$violations`（那个「减 1」的前提），
//        一处**真违例**会被这个函数静默吞掉 —— 正是这一格当初要防的病在同一个函数里复发。
//   现在从对方**完整输出**里找它自己打的 `[zero-sample]` 类型行（`  - [zero-sample] 行 0：…`），
//   与末行那几个计数是**两个独立信号**：类型行说「它认定的是什么」，计数说「有几处」。
//   ⚠ 仍是近似，照直标：类型行的格式是对方的输出约定，对方改了格式这里会退回「说不清」档
//     （退回的方向是**更保守**——不会把未知说成预期内）。
const PS_ZERO_SAMPLE_RE = /^\s*-\s*\[zero-sample\]/m;
function classifyPsExit(marker, psOut) {
  if (marker.exit === 0) return { kind: "ok", note: "对方硬闸 exit=0" };
  const declaredZero = PS_ZERO_SAMPLE_RE.test(String(psOut || ""));
  // 「预期内的零样本」要三件事同时成立：对方自己报了 zero-sample 类型、条款数确实是 0、
  // 且退出码正是它报违例时用的那个 1。少任何一件都不给「不是失败」这句话。
  if (declaredZero && marker.clauses === 0 && marker.exit === 1) {
    const extra = Math.max(0, (marker.violations || 0) - 1); // 减掉 zero-sample 自己那一处
    return {
      kind: extra > 0 ? "zero-sample-plus" : "zero-sample",
      note: `对方硬闸 exit=1（zero-sample：这份源本就零条款，是它对「被检对象是条款库」的防御，不是失败` +
        (extra > 0 ? `；**另有 ${extra} 处别的违例，那些要看**` : "") + "）",
    };
  }
  if (declaredZero) {
    // 报了 zero-sample，但另外两件对不上 ⇒ **不许说「不是失败」**，如实说哪儿对不上。
    return {
      kind: "unexplained",
      note: `对方硬闸 exit=${marker.exit}（它报了 zero-sample，但 clauses=${marker.clauses} / exit=${marker.exit} ` +
        "与「零样本 + exit 1」对不上 —— **不当成预期内**，去读它的完整输出）",
    };
  }
  if (marker.violations > 0) {
    return {
      kind: "violations",
      note: `对方硬闸 exit=${marker.exit}（**结构违例 ${marker.violations} 处** —— 对账不判它，也没有别人在这儿拦它，去读那份文件）`,
    };
  }
  return {
    kind: "unexplained",
    note: `对方硬闸 exit=${marker.exit}（既没报 zero-sample、也没报结构违例 —— 这一格没人解释得了，去读它的完整输出）`,
  };
}

function reconcileSummary({ exit, host, files, matched, mismatched, mine, theirs, myslugs, theirslugs }) {
  return `CLAUSE_RECONCILE_SUMMARY exit=${exit} host=${host} files=${files} matched=${matched}` +
    ` mismatched=${mismatched} mine=${mine} theirs=${theirs} myslugs=${myslugs || 0} theirslugs=${theirslugs || 0}`;
}

function runReconcile(o) {
  let sources;
  try {
    sources = loadSources(o);
  } catch (e) {
    process.stdout.write(`✗ 源清单读不了：${e && e.message ? e.message : String(e)}\n`);
    process.stdout.write(reconcileSummary({ exit: 1, host: "none", files: 0, matched: 0, mismatched: 0, mine: 0, theirs: 0 }) + "\n");
    return 1;
  }
  if (!fs.existsSync(o.psScript)) {
    process.stdout.write(`✗ 对账不能跑：第二套解析（PS 守卫）不在 ${o.psScript}\n`);
    process.stdout.write("   「跑不了」不等于「一致」——不给绿灯。\n");
    process.stdout.write(reconcileSummary({ exit: 2, host: "none", files: sources.length, matched: 0, mismatched: 0, mine: 0, theirs: 0 }) + "\n");
    return 2;
  }
  const host = findPsHost();
  if (!host) {
    process.stdout.write("✗ 对账不能跑：本机找不到 PowerShell 宿主（试过 powershell / pwsh）\n");
    process.stdout.write("   「跑不了」不等于「一致」——不给绿灯；把它悄悄当通过就是亲手造一个死闸。\n");
    process.stdout.write(reconcileSummary({ exit: 2, host: "none", files: sources.length, matched: 0, mismatched: 0, mine: 0, theirs: 0 }) + "\n");
    return 2;
  }

  process.stdout.write("== 条款解析交叉对账（两套独立实现对同一份语料各数一遍）==\n");
  process.stdout.write(`   我方：ccswitch/lib/clause-parser.mjs      对方：${path.basename(o.psScript)}（${host}）\n`);

  const rows = [];
  // 对方硬闸退出码按 classifyPsExit 分堆（issue #121）：让「预期内的零样本」与「真结构违例」
  // 在末尾归得了类 —— 只在每行里打一个 exit=1，等于把两件事写成同一个字。
  const psByKind = {};
  let matched = 0, mismatched = 0, mine = 0, theirs = 0, missingSrc = 0, mySlugs = 0, theirSlugs = 0;
  for (const s of sources) {
    const abs = path.isAbsolute(s.file) ? s.file : path.join(REPO_ROOT, s.file);
    if (!fs.existsSync(abs)) {
      // 语料缺席**必须出声**：静默跳过一份语料，与「这份语料一致」在输出上不可区分。
      rows.push({ file: s.file, state: "源缺席", detail: abs });
      missingSrc++;
      mismatched++;
      continue;
    }
    let parsed;
    try {
      parsed = parseFile(abs, { file: s.file, selector: s.selector, roleScheme: s.role_scheme });
    } catch (e) {
      rows.push({ file: s.file, state: "我方解析抛错", detail: e && e.message ? e.message : String(e) });
      mismatched++;
      continue;
    }
    const ps = runPs(host, o.psScript, abs, s.selector);
    if (!ps.marker) {
      rows.push({
        file: s.file, state: "对方没给末行",
        detail: `exit=${ps.code}；末行契约可能被改坏，或脚本没跑起来。stderr: ${ps.err.slice(0, 200)}`,
      });
      mismatched++;
      continue;
    }
    mine += parsed.stats.clauses;
    theirs += ps.marker.clauses;
    mySlugs += parsed.stats.slug;
    theirSlugs += ps.marker.slugs === null ? 0 : ps.marker.slugs;
    const okClauses = parsed.stats.clauses === ps.marker.clauses;
    const okNoTrig = parsed.stats.no_trigger === ps.marker.notrigger;
    // v2 第三个对账量：**slug 数**。加它是因为前两个数对 slug 这一层完全失明 ——
    // 一边把 slug 判据写坏（比如漏了代码 span 遮罩、或 slug 正则收窄），条款数与触发:无
    // 可以逐字不变，而 slug 数当场分岔。`null` = 对方是老版本、根本没这一栏，那要单独说，
    // 不能当成 0 去比（0==0 会给出一个假的一致）。
    const okSlug = ps.marker.slugs !== null && parsed.stats.slug === ps.marker.slugs;
    // ── 第四个对账量：**对方遮罩双实现的自检结论**（2026-08-02，issue #91）──────────
    // 前三个量比的都是「两边各数出来的数」，这一个不是 —— 它是**把对方第三套实现的结论
    // 带过来**。为什么非要有它：本侧的 `backtickSpans` 与对方的 `Get-BacktickSpans` 实现
    // 同一份 CommonMark 契约，**契约被同时读错时两边数出来的三个数逐字节相同**
    // （历史上这两侧是逐行直译，正是这么一起错的，而当时没有任何通道会响）。
    // 对方那套逐字符扫描的遮罩不在这条错误路径上，它一分歧就把 maskdiv 顶起来。
    // `null` ⇒ 对方末行没有这一栏 ⇒ 它是老版本、**这一层根本没人在看** ⇒ 同样判红
    //（同 slugs 那栏的既定处置，也同本文件「跑不了 ≠ 一致」的政策）。
    const okMask = ps.marker.maskdiv === 0;
    const psExit = classifyPsExit(ps.marker, ps.out);
    (psByKind[psExit.kind] || (psByKind[psExit.kind] = [])).push(s.file);
    if (okClauses && okNoTrig && okSlug && okMask) {
      matched++;
      rows.push({
        file: s.file, state: "一致",
        detail: `条款 ${parsed.stats.clauses} · 触发:无 ${parsed.stats.no_trigger} · slug ${parsed.stats.slug}` +
          ` · 对方遮罩双实现比过 ${ps.marker.maskcmp === null ? "?" : ps.marker.maskcmp} 行零分歧 · ${psExit.note}`,
      });
    } else {
      mismatched++;
      rows.push({
        file: s.file, state: "不一致",
        detail:
          `条款 我方 ${parsed.stats.clauses} vs 对方 ${ps.marker.clauses}；` +
          `触发:无 我方 ${parsed.stats.no_trigger} vs 对方 ${ps.marker.notrigger}；` +
          `slug 我方 ${parsed.stats.slug} vs 对方 ${ps.marker.slugs === null ? "（对方末行没有 slugs 栏 ⇒ 它还是 v1）" : ps.marker.slugs}；` +
          `对方遮罩双实现分歧 ${ps.marker.maskdiv === null ? "（对方末行没有 maskdiv 栏 ⇒ 它没有第三套遮罩实现，这一层无人在看）" : ps.marker.maskdiv + " 行"}` +
          `（${psExit.note}）`,
      });
    }
  }

  for (const r of rows) {
    const flag = r.state === "一致" ? "✓" : "✗";
    process.stdout.write(`  ${flag} [${r.state}] ${r.file}\n      ${r.detail}\n`);
  }

  // ── 对方硬闸退出码的归类小结（issue #121）──────────────────────────────────
  // 只在真有非零的时候打。零样本那一堆逐个列名，是为了让「第 7 份突然也变成零条款」
  // 与「一直就是这 6 份」分得开 —— 一个只报数字的小结分不开这两件事。
  {
    const zero = psByKind["zero-sample"] || [];
    const zeroPlus = psByKind["zero-sample-plus"] || [];
    const vio = psByKind.violations || [];
    const unk = psByKind.unexplained || [];
    const total = zero.length + zeroPlus.length + vio.length + unk.length;
    if (total) {
      process.stdout.write(`  ── 对方硬闸非零 ${total} 份，归类如下 ──\n`);
      if (zero.length) {
        process.stdout.write(`     ⓘ zero-sample ${zero.length} 份（本就零条款的细则档，**预期内**，不是对账失败）：${zero.join(" · ")}\n`);
      }
      if (zeroPlus.length) {
        process.stdout.write(`     ⚠ zero-sample **且另有别的违例** ${zeroPlus.length} 份 —— 那部分要看：${zeroPlus.join(" · ")}\n`);
      }
      if (vio.length) {
        process.stdout.write(`     ⚠ 结构违例 ${vio.length} 份 —— **这个要看**：${vio.join(" · ")}\n`);
      }
      if (unk.length) {
        process.stdout.write(`     ⚠ 说不清的 ${unk.length} 份（非零样本、也没报违例）：${unk.join(" · ")}\n`);
      }
      if (vio.length || zeroPlus.length || unk.length) {
        process.stdout.write("        对账只比数字、不判结构，这里既不拦也不改退出码；结构那道闸要另外跑。\n");
      }
    }
  }

  // ② 整批全零要红：每个文件都「0 == 0」的一致是空的一致。
  let exit = mismatched > 0 ? 1 : 0;
  if (exit === 0 && mine === 0) {
    process.stdout.write("✗ zero-sample：所有源加起来一条条款都没有 —— 这种「一致」与「两边都瞎了」不可区分，判红。\n");
    exit = 1;
  }
  if (exit === 0) {
    process.stdout.write(`OK：${matched} 份语料两套解析逐一对上（合计条款 ${mine}）。\n`);
    process.stdout.write("     它证明的只是「两套读法数出同一个数」，**不证明这个数是对的** —— 两边同时漏掉一整个\n");
    process.stdout.write("     没人写过的形态时，差仍然是 0。这一面靠人读 diff。\n");
  } else {
    process.stdout.write(`✗ 对账失败：${mismatched} 份语料对不上（缺席 ${missingSrc} 份）。\n`);
    process.stdout.write("   **不判谁对**：两套实现之一瞎了，判哪一套是人的活。先读上面的差异，再去看那份语料的 diff。\n");
  }
  process.stdout.write(
    reconcileSummary({ exit, host, files: sources.length, matched, mismatched, mine, theirs, myslugs: mySlugs, theirslugs: theirSlugs }) + "\n"
  );
  return exit;
}

// ── main ─────────────────────────────────────────────────────────────────────
const opts = parseArgs(process.argv.slice(2));
if (opts.mode === "help") {
  process.stdout.write(
    [
      "gen-clause-index.mjs — 条款机器面索引",
      "",
      "  node ccswitch/scripts/gen-clause-index.mjs              生成/覆写 ccswitch/clause-index.json",
      "  node ccswitch/scripts/gen-clause-index.mjs --check      漂移检查（源变了而索引没跟上 ⇒ exit 1）",
      "  node ccswitch/scripts/gen-clause-index.mjs --reconcile   与 check-clauses-structure.ps1 交叉对账",
      "  node ccswitch/scripts/gen-clause-index.mjs --list-sources 源清单的机器出口（一行 JSON，供 PS 守卫全量模式消费）",
      "",
      "  --sources-json <path>  用自带的源清单（JSON 数组或 {sources:[…]}），可指仓外语料",
      "  --out <path>           输出到别处（默认 ccswitch/clause-index.json）",
      "  --ps-script <path>     对账用的第二套解析（默认本仓 ccswitch/scripts/check-clauses-structure.ps1）",
      "  --ledger <path>        条款台账（默认 ccswitch/clause-ledger.json）；生成/校验时一并双向对账",
      "  --quiet                只打末行（违规明细仍打——一次什么都不说的失败是这套东西在治的病）",
      "",
      "索引是**派生物**：真相源是 Markdown 原文，改索引不会改变任何行为。",
    ].join("\n") + "\n"
  );
  process.exit(opts.bad ? 1 : 0);
}

try {
  process.exit(
    opts.mode === "reconcile" ? runReconcile(opts)
      : opts.mode === "list-sources" ? runListSources(opts)
        : runIndex(opts)
  );
} catch (e) {
  // `--list-sources` 的 stdout 是**给机器解析的 JSON**，任何一行人话都会让消费方当场解析失败
  // ⇒ 这一档的报错走 stderr、stdout 一个字都不写。消费方拿到「非 0 且 stdout 不是合法 JSON」
  // ⇒ fail-closed（「拿不到清单」绝不许长得像「清单是空的」）。
  if (opts.mode === "list-sources") {
    process.stderr.write(`✗ --list-sources 失败：${e && e.stack ? e.stack : String(e)}\n`);
    process.exit(1);
  }
  process.stdout.write(`✗ 未预期的失败：${e && e.stack ? e.stack : String(e)}\n`);
  process.stdout.write(
    opts.mode === "reconcile"
      ? reconcileSummary({ exit: 1, host: "none", files: 0, matched: 0, mismatched: 0, mine: 0, theirs: 0 }) + "\n"
      : summaryLine({ exit: 1, sources: 0, clauses: 0, observation: 0, drift: "missing", wrote: 0 }) + "\n"
  );
  process.exit(1);
}
