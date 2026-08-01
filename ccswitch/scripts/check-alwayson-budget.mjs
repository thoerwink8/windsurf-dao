#!/usr/bin/env node
// check-alwayson-budget.mjs — always-on 注入面的字节硬闸（架构优化 P4）
//
// ── 治的是什么病 ─────────────────────────────────────────────────────────────
// always-on 面只增不减，且**增长是无声的**：每次往 dao.md 加一条条款，谁都看得见那一条，
// 没人看得见「总量又涨了 1.2KB」。这与本仓反复在治的「规则集只增不减是结构必然」同源——
// 立法有天然触发器（刚踩坑、正在写复盘），**减法没有**。
//
// 本闸不解决遵守率（arxiv 2605.10039 实证：文件大小对遵守率无可检测影响，1650 会话）。
// 它买的是另外两样：**attention budget** 与**「一进一出」自动成立**——想加新条款时，
// 先得腾出位置，而腾位置的三个出口 P2/P5 刚刚铺好（见下方「出口在哪」）。
// 先有出口再设闸，是疏不是堵；这也是 P4 被排在 P2 之后的原因。
//
// ── 扫什么（射程边界照直写）──────────────────────────────────────────────────
//   ① `ccswitch/dao.md`                —— 锚：由 `~/.claude/CLAUDE.md` 的 @import 全量注入
//   ② `~/.claude/CLAUDE.md`            —— 用户级 always-on 本体
//   ③ `~/.claude/rules/*.md` 中**无 `paths:` frontmatter** 的那些
// ③ 的判据来自 P2 的本机实测：**带 `paths:` 的是作用域档**（宿主按路径命中才注入），
// 不占 always-on 配额；**无 `paths:` 的用户级规则**三个 subagent 观察员 3/3 均未收到，
// 但主会话侧未验 ⇒ 保守当成 always-on 计入（失败方向选「多算」：多算只是让闸更紧，
// 少算会让一份真的每轮注入的文件躲开预算）。
//
// **不扫**：项目级 `CLAUDE.md` 与 `.claude/rules/`（各项目自己的预算，且本闸跑在元仓库；
// 项目侧对应物是 scaffold-manifest 的 `claude-md-size` 条目，判据是行数不是字节）、
// persona 经文注入（用户人设根基，spec 显式不覆盖）、skills（手敲加载，不是 always-on）。
//
// ── 字节怎么数 ──────────────────────────────────────────────────────────────
// **LF 规范化后的 UTF-8 字节**，BOM 不计。理由是同一份内容在不同机器/不同 checkout 下
// CRLF 与 LF 都可能（本仓 `core.autocrlf=true`），拿盘上原始字节当预算会让同一份 dao.md
// 在两台机器上差出几百字节 —— 那种「换台机器就红」的闸最终一定会被静音（同 dao-rules-deploy
// 把漂移比对从字节相等改成行尾规范化的那次教训）。
// 本机实测差额：dao.md 盘上 67884 字节、LF 规范化后 67571 字节，**差 313 字节 = 313 行**。
//
// ── 闸值 ────────────────────────────────────────────────────────────────────
// 见下方 `LIMIT_BYTES` 常量及其上方的完整交代。**它是占位不是裁决。**
//
// ── 自检半边为什么必须另起一套读取路径 ──────────────────────────────────────
// dao 守卫铁律：一个检查器若同时负责「找出违例」与「确认自己真的看到了样本」，两半
// **必须走两套独立实现**。本闸最危险的静默失效形态很具体：**`paths:` 判定若朝「什么都算
// 作用域档」的方向坏掉，所有 rules 文件被排除、总字节静默变小 ⇒ 闸转绿，而 always-on 面
// 其实在涨**。复用同一个枚举器就看不见这件事。
// 故 `censusRuleFiles()` 只做 `readdirSync` + 后缀判断：**不 stat、不读内容、不碰 frontmatter**。
// 主逻辑分出的 counted + scoped + unreadable 三桶之和必须等于普查数，不等即 `undercount`。
//
// ── 退出码 / 末行契约 ───────────────────────────────────────────────────────
//   ALWAYSON_BUDGET_SUMMARY exit=<0|1> total=<N> limit=<N> files=<N> headroom=<N> scoped=<N> missing=<N> selfcheck=<ok|fail>
//   · exit     —— 与进程退出码恒等；1 = 超限 **或** 自检半边失败
//   · total    —— 计入预算的字节合计（LF 规范化）
//   · files    —— 计入预算的文件数
//   · headroom —— limit - total（可为负；负值即超出量）
//   前四个字段是派单契约规定的，顺序不动；后四个是**刻意扩展**，理由与 check-dead-gates 同：
//   只报 `total=0 exit=0` 时，「面很小」与「一个样本都没读到」在机器通道上不可区分，
//   而消费方（SessionStart hook）只读末行。`scoped`/`missing`/`selfcheck` 就是把那三种
//   「没查成」从「查了没事」里分出来。消费方按字段名取值，勿按位置取；未来加字段追加在末尾。
//
// ── 跑法 ────────────────────────────────────────────────────────────────────
//   node ccswitch/scripts/check-alwayson-budget.mjs
//   node ccswitch/scripts/check-alwayson-budget.mjs --json
//   测试用覆写：--dao-md <file> --user-claude-md <file> --rules-dir <dir> --limit <字节数>
//
// 真相源：windsurf-dao/ccswitch/scripts/check-alwayson-budget.mjs
// 调用方：ccswitch/hooks/dao-scaffold-check.js（SessionStart 模式 A，零新增注册）
// 自证：node tests/alwayson-budget.tests.js

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();

// ── 闸值（判断档 · 用户可随时改这个数）──────────────────────────────────────
// [自定@08-01 初值待用户拍板——判断档：给自己划及格线，用户可随时改这个数]
//
// **这个数是占位，不是「合理值」的裁决。** spec（docs/specs/dao-arch-optimization-202608.md
// P4 行）明写「闸值必须用户定（AI 自划及格线命中否决项①）」，本常量只是让闸先有形态。
//
// **为什么不是派单令写的 68KiB**（派单令的依据已过期，照直记）：
//   · 派单令依据「当前 dao.md 66237B」，而 2026-08-01 实测 dao.md = **67571B**（LF 规范化）；
//   · 且本闸射程是**三面合计**不是 dao.md 单文件，实测 dao.md 67571 + 用户 CLAUDE.md 2068
//     = **69639B**，而 68KiB = 69632B ⇒ **68KiB 会出生即红 7 字节**。
//   · 「生下来就吵的检查一定会被静音」是本仓明训（check-clauses-structure 候选退役区那次），
//     而一个用户尚未拍板的数字把 SessionStart 染红，比不设闸更糟。
// 故初值取 70KiB = 71680B = 当前 +2041B（**2.9% 余量**），形态仍是「不再增长闸」：
// 余量小到加不进一条新条款，但不会开局就红。用户拍板后改这一行即可。
//
// 调参三问（dao 通用节要求，逐条答）：①改小会怎样 —— 小于 69639 即刻红，需先真的腾出位置，
// 那是本闸的**目的**而不是事故，但该由用户选时机；②当前值够不够 —— 够「不再增长」，
// 不够「主动缩」，缩要靠 P5 整编，不靠闸；③69639～71680 那段有无真实需求 —— 有一个：
// 本 PR 自身不改 dao.md，但下一个批次若要往 dao.md 加一行指针（存根化的常见形态），
// 得有几百字节的活动空间，否则每次存根化都要先动闸值。
const LIMIT_BYTES = 70 * 1024;

// ── 参数 ────────────────────────────────────────────────────────────────────
const ARGV = process.argv.slice(2);
function argOf(name, dflt) {
  const i = ARGV.indexOf(name);
  return i >= 0 && ARGV[i + 1] != null ? ARGV[i + 1] : dflt;
}
const DAO_MD = path.resolve(argOf("--dao-md", path.join(ROOT, "ccswitch", "dao.md")));
const USER_CLAUDE_MD = path.resolve(argOf("--user-claude-md", path.join(HOME, ".claude", "CLAUDE.md")));
const RULES_DIR = path.resolve(argOf("--rules-dir", path.join(HOME, ".claude", "rules")));
const AS_JSON = ARGV.includes("--json");

const limitArg = argOf("--limit", null);
// `--limit` 只收正整数字节。不支持 "68kb" 之类的人性化写法：单位换算（KB=1000 还是 1024）
// 是个没人记得住的歧义，而这个值是要被断言的。写错即报，不做「猜你想说什么」的解析。
let LIMIT = LIMIT_BYTES;
let limitArgError = null;
if (limitArg !== null) {
  if (!/^\d+$/.test(String(limitArg).trim())) limitArgError = "--limit 必须是正整数字节数（收到：" + limitArg + "）";
  else LIMIT = Number(String(limitArg).trim());
}

function out(s) { process.stdout.write(s + "\n"); }

// ── 字节计量 ────────────────────────────────────────────────────────────────
// 读成 utf8 字符串 → 去 BOM → CRLF 归一 → 再算 UTF-8 字节。理由见文件头注。
function normalizedBytes(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return Buffer.byteLength(s.replace(/\r\n/g, "\n"), "utf8");
}

function readText(file) {
  try { return { ok: true, text: fs.readFileSync(file, "utf8") }; }
  catch (e) { return { ok: false, why: e && e.message ? e.message : String(e) }; }
}

// ── `paths:` frontmatter 判定 ───────────────────────────────────────────────
// **语义与 ccswitch/scripts/dao-rules-deploy.mjs 的 validateRule 一致**，但**刻意重写一份
// 而不是 import**：那个文件是有顶层副作用的 CLI（import 它会当场跑一次部署，把源写进
// `~/.claude/rules/`）。一个只读的检查器不该有这种副作用。
// 两处若将来分岔，分岔方向是「本闸把某份文件当成 always-on 多算了」——多算让闸更紧，
// 是有意选的失败方向（见头注）。
function hasPathsFrontmatter(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return false;
  return /^\s*paths\s*:/m.test(m[1]);
}

// ── 自检那一半：独立的最小枚举路径 ──────────────────────────────────────────
// **不 stat、不读内容、不认识 frontmatter、不用 withFileTypes** —— 只 `readdirSync` 拿名字，
// 按后缀数。与主逻辑唯一的共同前提是「目录里有条目名」。
//
// 🔴 **它必须与主逻辑各自 readdir 一次，不许共用结果**（本条是本文件写完后第一次跑测试
// 才发现的自伤，照直记）：初版让主循环直接遍历 `censusRuleFiles()` 的返回值，于是每个条目
// **必然**落进 counted/scoped/unreadable 三桶之一 ⇒ 三桶之和**恒等于**普查数 ⇒ 那条集合差
// 断言是一句**永远为真的废话**，而它看起来和一道真护栏一模一样。这正是 dao 守卫铁律
// 「自检那一半要能在主逻辑瞎掉时仍然看得见」所指的复用陷阱，写它的人当场踩了一次。
//
// 分岔要真的构造得出来，两半的**过滤判据**才必须不同：普查按**名字**（`.md` 结尾即算一份），
// 主逻辑按**名字 + `isFile()`**。于是「主逻辑的过滤器变严 / 枚举早退 / 某类条目被静默跳过」
// 会让三桶之和掉到普查数以下 ⇒ `undercount` 响，而普查这一半仍然看得见样本。
// 可构造实例：一个**名叫 `x.md` 的目录** —— 普查数它一份，主逻辑的 `isFile()` 排除它。
function censusRuleFiles(dir) {
  try { return fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".md")).sort(); }
  catch (e) { return { err: e && e.message ? e.message : String(e) }; }
}

// 主逻辑自己的枚举（**刻意与上面那个函数无任何共享**）。
function mainRuleFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((ent) => ent.isFile() && ent.name.toLowerCase().endsWith(".md"))
      .map((ent) => ent.name).sort();
  } catch (e) { return { err: e && e.message ? e.message : String(e) }; }
}

// ── 主逻辑 ──────────────────────────────────────────────────────────────────
const counted = [];      // 计入预算
const scoped = [];       // 有 paths ⇒ 作用域档，不计入
const missing = [];      // 期望存在但不在（另一台机器上合法缺席，不判红，但必须出声）
const unreadable = [];   // 在盘上但读不动（真问题）

function takeAnchorOrUser(file, label, isAnchor) {
  const r = readText(file);
  if (!r.ok) {
    // 不存在 vs 读不动：两种病、两种处方，不能并成一桶。
    let exists = false;
    try { exists = fs.existsSync(file); } catch (_) { exists = false; }
    (exists ? unreadable : missing).push({ file, label, why: r.why, anchor: !!isAnchor });
    return;
  }
  counted.push({ file, label, bytes: normalizedBytes(r.text), anchor: !!isAnchor });
}

takeAnchorOrUser(DAO_MD, "dao.md（@import 全量注入的锚）", true);
takeAnchorOrUser(USER_CLAUDE_MD, "用户级 CLAUDE.md", false);

const census = censusRuleFiles(RULES_DIR);
const censusNames = Array.isArray(census) ? census : [];
const censusErr = Array.isArray(census) ? null : census.err;

const mainList = mainRuleFiles(RULES_DIR);
const mainNames = Array.isArray(mainList) ? mainList : [];
const mainErr = Array.isArray(mainList) ? null : mainList.err;

for (const name of mainNames) {
  const full = path.join(RULES_DIR, name);
  const r = readText(full);
  if (!r.ok) { unreadable.push({ file: full, label: "rules/" + name, why: r.why, anchor: false }); continue; }
  if (hasPathsFrontmatter(r.text)) {
    scoped.push({ file: full, label: "rules/" + name, bytes: normalizedBytes(r.text) });
  } else {
    counted.push({ file: full, label: "rules/" + name, bytes: normalizedBytes(r.text), anchor: false });
  }
}

const total = counted.reduce((a, c) => a + c.bytes, 0);
const headroom = LIMIT - total;

// ── 下限断言（自检半边）─────────────────────────────────────────────────────
// 形态取**集合差**不取魔数阈值：「低于 N 字节即红」要维护一个会过期的数字；
// 「比上次少 M% 即红」要持久化基线，而基线文件不在时会静默跳过 —— 正是本闸要防的病。
const selfIssues = [];

if (limitArgError) selfIssues.push("bad-limit-arg：" + limitArgError);

// ① 锚不在 = 整个预算失去意义。**这一条必须红**：dao.md 缺席会让 total 掉到 2KB 级，
//    而那个数字在闸眼里是一片安详的绿 —— 「零检出 ≠ 零存在」在本闸上的具体形态。
const anchorMissing = missing.some((m) => m.anchor) || unreadable.some((u) => u.anchor);
if (anchorMissing) {
  selfIssues.push("anchor-missing：dao.md 读不到（" + DAO_MD + "）⇒ 此时的 total 与「面很小」不可区分，闸失效");
}

// ② rules 目录三桶之和 vs 独立普查（两半各自 readdir 过一次，见 censusRuleFiles 头注）
const ruleBuckets = counted.filter((c) => /^rules\//.test(c.label)).length +
                    scoped.length +
                    unreadable.filter((u) => /^rules\//.test(u.label)).length;
if (!censusErr && ruleBuckets !== censusNames.length) {
  const unseen = censusNames.filter((n) => mainNames.indexOf(n) === -1);
  selfIssues.push("undercount@rules：主逻辑分桶合计 " + ruleBuckets +
    " 份，独立普查在同一目录数到 " + censusNames.length + " 份 ⇒ 有样本没被看见（扫描面塌陷）" +
    (unseen.length ? "；普查看得见而主逻辑没枚举到的：" + unseen.join("、") : ""));
}
// ②' 两半的**读取**能力也可能分岔（一半读得了目录、另一半读不了）。不静默。
if (!!censusErr !== !!mainErr) {
  selfIssues.push("readdir-divergence@rules：普查与主逻辑对同一目录的读取结果不一致（普查 " +
    (censusErr || "ok") + " / 主逻辑 " + (mainErr || "ok") + "）");
}

// ③ 零样本：一个都没读到。rules 目录不存在是常态（多数机器没有），故只在**连锚都没有**
//    时才由 ① 兜住；这里管的是另一种 —— 文件都在却一个字节都没算出来。
if (counted.length > 0 && total === 0) {
  selfIssues.push("zero-bytes：读到 " + counted.length + " 份文件而合计字节为 0 ⇒ 计量那一半已瞎");
}

// ④ 读不动（区别于「不存在」）：盘上有文件却读不出来，是真问题不是环境差异。
for (const u of unreadable) {
  selfIssues.push("unreadable@" + u.label + "：文件在盘上却读不出来（" + u.why + "）");
}

// ⑤ rules 目录存在但读不了（`ENOENT` 属常态，其余属真问题）
if (censusErr && !/ENOENT|no such file/i.test(censusErr)) {
  selfIssues.push("rulesdir-unreadable：" + RULES_DIR + "（" + censusErr + "）");
}

const selfOk = selfIssues.length === 0;
const overLimit = total > LIMIT;
const exitCode = (overLimit || !selfOk) ? 1 : 0;

// ── 出口在哪（超限时必须给，否则这道闸只是在骂人）───────────────────────────
// 三个出口都已铺好且各有先例，不是纸上谈兵。
const EXITS = [
  "① 细则存根化 → 正文迁进 `ccswitch/rules/*.md`，dao.md 只留存根+条款名+指针" +
    "（先例：长窗排程 / 派单契约门组 / 写守卫组三块，2026-08-01）",
  "② 条款作用域化 → 带 `paths:` 的规则进 `ccswitch/rules/scoped/*.md`，" +
    "`node ccswitch/scripts/dao-rules-deploy.mjs` 部署到 `~/.claude/rules/`" +
    "（宿主按路径命中才注入 ⇒ 不占 always-on 配额；这是 P2 铺的出口）",
  "③ 叙事外迁 → 出处/事故经过/计数进 `docs/evolution/dao-clause-rationales.md` 或 " +
    "`incident-narratives-202607.md`，dao.md 只留判据一句 + 指针",
];

function summaryLine() {
  return "ALWAYSON_BUDGET_SUMMARY exit=" + exitCode +
    " total=" + total +
    " limit=" + LIMIT +
    " files=" + counted.length +
    " headroom=" + headroom +
    " scoped=" + scoped.length +
    " missing=" + missing.length +
    " selfcheck=" + (selfOk ? "ok" : "fail");
}

if (AS_JSON) {
  out(JSON.stringify({
    exit: exitCode, total, limit: LIMIT, headroom,
    counted: counted.map((c) => ({ label: c.label, file: c.file, bytes: c.bytes, anchor: c.anchor })),
    scoped: scoped.map((s) => ({ label: s.label, file: s.file, bytes: s.bytes })),
    missing: missing.map((m) => ({ label: m.label, file: m.file, why: m.why })),
    unreadable: unreadable.map((u) => ({ label: u.label, file: u.file, why: u.why })),
    census: { dir: RULES_DIR, files: censusNames, err: censusErr },
    selfIssues, exits: EXITS,
  }, null, 2));
  out(summaryLine());
  process.exit(exitCode);
}

out("");
out("=== dao always-on 字节预算 ===");
out("  闸值 " + LIMIT + " 字节（" + (LIMIT / 1024).toFixed(1) + " KiB）· 计量口径：LF 规范化后的 UTF-8 字节，BOM 不计");
out("");
for (const c of counted) {
  out("  " + String(c.bytes).padStart(7) + " B  " + c.label.padEnd(30) + " " + c.file);
}
if (counted.length === 0) out("  （零份文件计入预算 —— 这不是「面很小」，看下面的自检半边）");
out("  " + "".padStart(7, "─") + "    合计 " + total + " B" +
    "（占闸值 " + (LIMIT > 0 ? (total * 100 / LIMIT).toFixed(1) : "n/a") + "%，" +
    (headroom >= 0 ? "余量 " + headroom + " B" : "**超出 " + (-headroom) + " B**") + "）");

if (scoped.length) {
  out("");
  out("ⓘ 作用域档 " + scoped.length + " 份**不计入**（带 `paths:` frontmatter，宿主按路径命中才注入）：");
  for (const s of scoped) out("    · " + String(s.bytes).padStart(6) + " B  " + s.label);
}
if (missing.length) {
  out("");
  out("ⓘ 期望位置无文件 " + missing.length + " 份（换台机器合法缺席，**不判红**，但不静默）：");
  for (const m of missing) out("    · " + m.label + "：" + m.file);
}

out("");
if (overLimit) {
  out("✗ 超限 " + (-headroom) + " 字节 —— always-on 面每轮注入给包括 subagent 在内的所有人，");
  out("  它涨的不是磁盘而是**每一次推理的 attention budget**。三个出口（都已铺好，各有先例）：");
  for (const e of EXITS) out("    " + e);
  out("  想加新条款先腾位置 —— 「一进一出」正是本闸唯一要买的东西。");
} else {
  out("✓ 未超限：合计 " + total + " B ≤ 闸值 " + LIMIT + " B（余量 " + headroom + " B）");
}

out("");
if (selfOk) {
  out("✓ 自检半边：主逻辑分桶 " + ruleBuckets + " 份 = 独立普查 " + censusNames.length +
      " 份（rules 扫描面没塌）· 锚在场 · 计量非零");
} else {
  out("✗ 自检半边失败 " + selfIssues.length + " 条 —— **此时「未超限」不可信，先修检测器**：");
  for (const i of selfIssues) out("    · " + i);
}

out("");
out("── 合计 " + total + " B / 闸值 " + LIMIT + " B · 计入 " + counted.length + " 份 · 作用域档 " +
    scoped.length + " 份 · 缺席 " + missing.length + " 份 · 自检 " + (selfOk ? "ok" : "fail"));
out(summaryLine());
process.exit(exitCode);
