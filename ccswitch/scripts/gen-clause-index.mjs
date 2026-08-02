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
// ── 末行契约（机器读这一行，别去正则匹配上面的中文）──────────────────────────
//   生成/校验：CLAUSE_INDEX_SUMMARY exit=<n> sources=<n> clauses=<n> observation=<n> drift=<none|missing|content|source> wrote=<0|1>
//   台账：    CLAUSE_LEDGER_SUMMARY exit=<n> state=<ok|missing|bad|na> entries=<n> slugs=<n> missing_slug=<n> orphan_slug=<n> orphan_ledger=<n> dup_slug=<n> mismatch=<n> file_mismatch=<n> out_of_scope=<n>
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
  parseFile,
  normalizeText,
  loadLedger,
  reconcileLedger,
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

function summaryLine({ exit, sources, clauses, observation, drift, wrote }) {
  return `CLAUSE_INDEX_SUMMARY exit=${exit} sources=${sources} clauses=${clauses} observation=${observation} drift=${drift} wrote=${wrote}`;
}

function outPath(o) {
  if (o.out) return path.isAbsolute(o.out) ? o.out : path.join(process.cwd(), o.out);
  return path.join(REPO_ROOT, DEFAULT_INDEX_REL);
}

// ── 台账（clause-ledger.json）双向对账 ───────────────────────────────────────
function ledgerSummary(f) {
  return `CLAUSE_LEDGER_SUMMARY exit=${f.exit} state=${f.state} entries=${f.entries} slugs=${f.slugs}` +
    ` missing_slug=${f.missing_slug} orphan_slug=${f.orphan_slug} orphan_ledger=${f.orphan_ledger}` +
    ` dup_slug=${f.dup_slug} mismatch=${f.mismatch} file_mismatch=${f.file_mismatch} out_of_scope=${f.out_of_scope}`;
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
  show("双轨值不等（行内元字段 vs 台账）", r.mismatch,
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
    out_of_scope: r.outOfScope.length,
  };
  if (hard === 0) {
    note("  ✓ " + r.checked + " 条 slug 与台账逐条对上，双轨零不等（台账 " + entries + " 条）。");
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

// ── 生成 / 校验 ──────────────────────────────────────────────────────────────
// 索引漂移与台账对账是**两个独立信号**，各打各的末行、退出码取严的那个：
// 「索引没跟上」与「台账对不上」是两种病、两种处方，并成一个数就分不开了。
function runIndex(o) {
  const indexCode = runIndexCore(o);
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
  return Math.max(indexCode, ledgerCode);
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
      summaryLine({ exit: 1, sources: sources.length, clauses: 0, observation: 0, drift: "missing", wrote: 0 }) + "\n"
    );
    return 1;
  }
  const text = serializeIndex(index);
  const g = index._generated;

  if (o.mode === "check") {
    if (!fs.existsSync(target)) {
      process.stdout.write(`✗ 索引不存在：${target}\n   ⇒ 跑一次 ${g.再生成}\n`);
      process.stdout.write(
        summaryLine({
          exit: 1, sources: sources.length, clauses: g.totals.clauses,
          observation: g.totals.observation, drift: "missing", wrote: 0,
        }) + "\n"
      );
      return 1;
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
          observation: g.totals.observation, drift: "none", wrote: 0,
        }) + "\n"
      );
      return 0;
    }
    // 漂移了：先指名**哪个源**变了（拿盘上索引记的 sha256 对现在的文件），
    // 都没变则说明有人手改了索引本身 —— 两种病、两种处方，别混成一句「过期了」。
    let drift = "content";
    const named = [];
    try {
      const old = JSON.parse(onDisk);
      const oldSrc = new Map((old._generated?.sources || []).map((s) => [s.file, s.sha256]));
      for (const s of g.sources) {
        const before = oldSrc.get(s.file);
        if (before === undefined) named.push(`${s.file}（索引里原本没有这个源）`);
        else if (before !== s.sha256) named.push(`${s.file}（内容已变）`);
      }
      for (const f of oldSrc.keys()) {
        if (!g.sources.some((s) => s.file === f)) named.push(`${f}（已从源清单移除）`);
      }
      if (named.length) drift = "source";
    } catch (_) {
      named.push("（盘上索引不是合法 JSON，无法逐源比对）");
    }
    process.stdout.write("✗ 索引过期：与真相源不一致\n");
    if (named.length) for (const n of named) process.stdout.write(`   · 源变动：${n}\n`);
    else process.stdout.write("   · 所有源的 sha256 都没变 ⇒ 是**索引本身**被手改了（它是派生物，手改无效且会被下次生成覆盖）\n");
    process.stdout.write(`   ⇒ 跑一次 ${g.再生成}\n`);
    process.stdout.write(
      summaryLine({
        exit: 1, sources: sources.length, clauses: g.totals.clauses,
        observation: g.totals.observation, drift, wrote: 0,
      }) + "\n"
    );
    return 1;
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
      observation: g.totals.observation, drift: "none", wrote: 1,
    }) + "\n"
  );
  return 0;
}

// ── 交叉对账 ─────────────────────────────────────────────────────────────────
const PS_SELECTOR = {
  [SELECTOR.MARKED]: "Marked",
  [SELECTOR.ALL_TOP_LEVEL]: "AllTopLevel",
};

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
    if (okClauses && okNoTrig && okSlug && okMask) {
      matched++;
      rows.push({
        file: s.file, state: "一致",
        detail: `条款 ${parsed.stats.clauses} · 触发:无 ${parsed.stats.no_trigger} · slug ${parsed.stats.slug}` +
          ` · 对方遮罩双实现比过 ${ps.marker.maskcmp === null ? "?" : ps.marker.maskcmp} 行零分歧 · 对方硬闸 exit=${ps.marker.exit}`,
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
          `（对方硬闸 exit=${ps.marker.exit}）`,
      });
    }
  }

  for (const r of rows) {
    const flag = r.state === "一致" ? "✓" : "✗";
    process.stdout.write(`  ${flag} [${r.state}] ${r.file}\n      ${r.detail}\n`);
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
    process.stdout.write("     另：对方对零条款文件会报 zero-sample 硬闸红（上面的 exit=1），那是它的防御不是对账失败。\n");
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
  process.exit(opts.mode === "reconcile" ? runReconcile(opts) : runIndex(opts));
} catch (e) {
  process.stdout.write(`✗ 未预期的失败：${e && e.stack ? e.stack : String(e)}\n`);
  process.stdout.write(
    opts.mode === "reconcile"
      ? reconcileSummary({ exit: 1, host: "none", files: 0, matched: 0, mismatched: 0, mine: 0, theirs: 0 }) + "\n"
      : summaryLine({ exit: 1, sources: 0, clauses: 0, observation: 0, drift: "missing", wrote: 0 }) + "\n"
  );
  process.exit(1);
}
