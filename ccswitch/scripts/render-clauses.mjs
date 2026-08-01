#!/usr/bin/env node
// render-clauses.mjs — 按官种渲染条款集（P6 第一步的**原型**）
//
// ── 它要证明什么 ─────────────────────────────────────────────────────────────
// 「渲染出只给你这一份」是调研里唯一带量化的杠杆（Quote 条件把遵守率从 17-40% 推到
// 76-77%）。今天的做法是让每个官把整份条款库读完（派单必带首行），本文件是那条路的
// 下一格：**从机器面索引里挑出「通用节 + 你那一节」，正文回原 Markdown 取**。
//
// ── 本批**不接进派单流程**（范围铁律）────────────────────────────────────────
// 第一步只要「原型能跑 + 输出正确」。接线（派单令改成引用渲染产物）是下一批的事，
// 因为那一步会改变**每一个 subagent 实际读到什么**，属用户可见面 ⇒ 判断档 ⇒ 要用户拍板。
//
// ── 三个 fail-closed 的地方（都是「空过」的反面）─────────────────────────────
//   ① **索引过期就不渲染。** 渲染的正文是按 line/line_end 从 Markdown 现切的；源变了而
//      索引没跟上时，切出来的可能是**隔壁那条条款的半截话**，而它看起来完全正常。
//      这正是派单必带首行当初要解掉的「投递延迟」——新形态、同一个病。`--allow-stale` 可
//      强行渲染，但会在正文顶部和末行 marker 两处留痕。
//   ② **官种名不认识就报错**，并列出合法取值；不静默渲染一份只有通用节的东西。
//   ③ **认识但这份索引里一条都没有 ⇒ 也报错。** 这一条最容易被写成「渲染个空节算了」，
//      而那恰恰是最坏的输出：读的人会以为「这个官种确实没有专属条款」，而真相是
//      **这份索引的源清单里压根没有带官种分节的语料**。零条与零存在必须分得开。
//
// ── 末行契约 ─────────────────────────────────────────────────────────────────
//   CLAUSE_RENDER_SUMMARY exit=<n> role=<name> general=<n> role_clauses=<n> stale=<0|1> unclassified=<n>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_INDEX_REL,
  ROLE_TABLE,
  ROLE_OBSERVATION,
  ROLE_UNCLASSIFIED,
  ZONE,
  sha256File,
} from "../lib/clause-parser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

// 合法官种取值来自**词表**（ROLE_TABLE）而不是「这份索引里恰好有的那些」：
// 后者会让「你把语料从清单里漏了」表现为「没有这个官种」——又一次把两种 0 混成一种。
const VALID_ROLES = ROLE_TABLE.map(([, r]) => r);

function parseArgs(argv) {
  const o = { role: null, index: null, format: "md", allowStale: false, listRoles: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--role") o.role = argv[++i];
    else if (a === "--index") o.index = argv[++i];
    else if (a === "--format") o.format = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--allow-stale") o.allowStale = true;
    else if (a === "--list-roles") o.listRoles = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else { o.help = true; o.bad = `未知参数：${a}`; }
  }
  return o;
}

function marker({ exit, role, general, roleClauses, stale, unclassified }) {
  return `CLAUSE_RENDER_SUMMARY exit=${exit} role=${role} general=${general} role_clauses=${roleClauses} stale=${stale} unclassified=${unclassified}`;
}

function die(msg, m) {
  process.stdout.write(msg);
  process.stdout.write(marker(m) + "\n");
  process.exit(m.exit);
}

const o = parseArgs(process.argv.slice(2));

if (o.help) {
  if (o.bad) process.stdout.write(o.bad + "\n");
  process.stdout.write(
    [
      "render-clauses.mjs — 按官种渲染条款集（原型，本批不接进派单流程）",
      "",
      "  node ccswitch/scripts/render-clauses.mjs --role <官种>",
      "",
      "  --role <name>     合法取值：" + VALID_ROLES.join(" / "),
      "  --index <path>    用别的索引（默认 " + DEFAULT_INDEX_REL + "）",
      "  --format md|json  默认 md",
      "  --out <path>      写文件（默认打到 stdout）",
      "  --allow-stale     索引过期时仍渲染（会在正文与末行两处留痕）",
      "  --list-roles      只列这份索引里各官种的条款数",
      "",
      "正文从 Markdown 原文现切 —— 索引只存行号，不存全文（双写必漂移）。",
    ].join("\n") + "\n"
  );
  process.exit(o.bad ? 1 : 0);
}

const indexPath = o.index
  ? (path.isAbsolute(o.index) ? o.index : path.join(process.cwd(), o.index))
  : path.join(REPO_ROOT, DEFAULT_INDEX_REL);

if (!fs.existsSync(indexPath)) {
  die(
    `✗ 索引不存在：${indexPath}\n   ⇒ 先跑 node ccswitch/scripts/gen-clause-index.mjs\n`,
    { exit: 1, role: o.role || "-", general: 0, roleClauses: 0, stale: 1, unclassified: 0 }
  );
}

let index;
try {
  index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
} catch (e) {
  die(`✗ 索引不是合法 JSON：${indexPath}\n   ${e && e.message}\n`,
    { exit: 1, role: o.role || "-", general: 0, roleClauses: 0, stale: 1, unclassified: 0 });
}

const gen = index._generated || {};
const all = Array.isArray(index.clauses) ? index.clauses : [];

// ── ① 新鲜度：索引与 Markdown 现况一致吗 ─────────────────────────────────────
const staleReasons = [];
const sourceLines = new Map(); // file → string[]（现切正文用）
for (const s of gen.sources || []) {
  const abs = s.external ? s.file : path.join(REPO_ROOT, s.file);
  if (!fs.existsSync(abs)) { staleReasons.push(`${s.file}：源文件不在了`); continue; }
  try {
    if (sha256File(abs) !== s.sha256) staleReasons.push(`${s.file}：内容已变（索引记的 sha256 对不上）`);
  } catch (e) {
    staleReasons.push(`${s.file}：读不了（${e && e.message}）`);
    continue;
  }
  sourceLines.set(s.file, fs.readFileSync(abs, "utf8").replace(/^\uFEFF/, "").split(/\r\n|\n|\r/));
}
const stale = staleReasons.length > 0;

if (o.listRoles) {
  const byRole = {};
  for (const c of all) byRole[c.role] = (byRole[c.role] || 0) + 1;
  process.stdout.write(`索引：${indexPath}\n`);
  process.stdout.write(`词表里的合法官种：${VALID_ROLES.join(" / ")}\n`);
  process.stdout.write("这份索引里的分布：\n");
  for (const r of [...VALID_ROLES, ROLE_OBSERVATION, ROLE_UNCLASSIFIED]) {
    process.stdout.write(`  ${String(r).padEnd(14)} ${byRole[r] || 0}\n`);
  }
  if (stale) process.stdout.write(`⚠ 索引已过期：${staleReasons.join("；")}\n`);
  process.stdout.write(marker({
    exit: 0, role: "-", general: byRole.general || 0, roleClauses: 0,
    stale: stale ? 1 : 0, unclassified: byRole[ROLE_UNCLASSIFIED] || 0,
  }) + "\n");
  process.exit(0);
}

if (!o.role) {
  die(`✗ 缺 --role。合法取值：${VALID_ROLES.join(" / ")}\n   （不给缺省值是刻意的：默认渲染成通用节，会让「忘了传官种」表现为一份看起来正常的输出。）\n`,
    { exit: 1, role: "-", general: 0, roleClauses: 0, stale: stale ? 1 : 0, unclassified: 0 });
}

// ── ② 官种名不认识 ⇒ 报错不空过 ──────────────────────────────────────────────
if (!VALID_ROLES.includes(o.role)) {
  const extra = o.role === ROLE_OBSERVATION
    ? "\n   （`observation` 是观察区候选，按协议它们**还不是条款**、派单时不摘，故不可渲染。）"
    : "";
  die(
    `✗ 不认识的官种：${o.role}\n   合法取值：${VALID_ROLES.join(" / ")}${extra}\n`,
    { exit: 1, role: o.role, general: 0, roleClauses: 0, stale: stale ? 1 : 0, unclassified: 0 }
  );
}

if (stale && !o.allowStale) {
  die(
    "✗ 索引已过期，拒绝渲染：\n" +
      staleReasons.map((r) => `   · ${r}\n`).join("") +
      "   ⇒ 先跑 node ccswitch/scripts/gen-clause-index.mjs\n" +
      "   （正文是按行号从 Markdown 现切的：源动了而行号没动时，切出来的可能是隔壁条款的半截话，\n" +
      "    而它看起来完全正常。要强行渲染：--allow-stale，两处留痕。）\n",
    { exit: 1, role: o.role, general: 0, roleClauses: 0, stale: 1, unclassified: 0 }
  );
}

// ── 挑条款 ───────────────────────────────────────────────────────────────────
// 观察区（zone=observation）**一律不摘** —— 协议里它们不是条款。
const clauses = all.filter((c) => c.zone === ZONE.CLAUSE);
const generalOnes = clauses.filter((c) => c.role === "general");
const roleOnes = o.role === "general" ? [] : clauses.filter((c) => c.role === o.role);
const unclassified = clauses.filter((c) => c.role === ROLE_UNCLASSIFIED);

// ── ③ 认识但一条都没有 ⇒ 也报错（零条 ≠ 零存在）──────────────────────────────
if (o.role !== "general" && roleOnes.length === 0) {
  die(
    `✗ 官种「${o.role}」在这份索引里 0 条 —— 不渲染。\n` +
      "   为什么这是错误而不是「渲染个空节」：读渲染产物的人会据此认为**这个官种确实没有专属条款**，\n" +
      "   而真相多半是这份索引的源清单里没有带官种分节的语料（默认清单只含仓内文件，\n" +
      "   而带官种节的条款库住在各项目仓，如 mousse-cli 的 docs/rules/dispatch-clauses.md）。\n" +
      `   ⇒ 用 --index 指一份含该语料的索引，或先 gen-clause-index.mjs --sources-json <含它的清单>。\n` +
      `   本索引各官种条数：node ccswitch/scripts/render-clauses.mjs --list-roles\n`,
    { exit: 1, role: o.role, general: generalOnes.length, roleClauses: 0, stale: stale ? 1 : 0, unclassified: unclassified.length }
  );
}
if (generalOnes.length === 0 && roleOnes.length === 0) {
  die(
    "✗ 通用节与官种节都是 0 条 —— 这份索引渲染不出任何东西，不给一份空文件。\n",
    { exit: 1, role: o.role, general: 0, roleClauses: 0, stale: stale ? 1 : 0, unclassified: unclassified.length }
  );
}

// ── 正文现切 ─────────────────────────────────────────────────────────────────
function bodyOf(c) {
  const lines = sourceLines.get(c.file);
  if (!lines) return `（正文取不到：源文件 ${c.file} 读不了 —— 索引只存行号，正文在原文里）`;
  return lines.slice(c.line - 1, c.line_end).join("\n").trimEnd();
}

function renderMd() {
  const out = [];
  out.push(`# 派单条款渲染 · 官种「${o.role}」`);
  out.push("");
  out.push("> **派生物，不是真相源。** 正文按行号从下列 Markdown 现切，改这份渲染没有任何效果：");
  for (const s of gen.sources || []) out.push(`> · \`${s.file}\``);
  out.push(`> 再生成：\`node ccswitch/scripts/render-clauses.mjs --role ${o.role}\``);
  out.push(
    `> 本次：通用节 ${generalOnes.length} 条 + ${o.role} 节 ${roleOnes.length} 条；` +
      `观察区条目不摘（协议：它们还不是条款）。`
  );
  if (unclassified.length) {
    out.push(
      `> ⚠ 另有 **${unclassified.length} 条未归类**条款（落在任何已知官种节之外）：本次渲染**未包含**。` +
        `它们要么该补一个官种节，要么该并进通用节 —— 别让它们靠"混进每一份"存活。`
    );
  }
  if (stale) out.push(`> 🔴 **索引已过期而你用了 --allow-stale**：${staleReasons.join("；")}。下面的正文可能切错行。`);
  out.push("");
  const section = (title, list) => {
    if (!list.length) return;
    out.push(`## ${title}`);
    out.push("");
    for (const c of list) {
      out.push(bodyOf(c));
      out.push(`  <!-- id=${c.id} · 出处 ${c.file}:${c.line} · 触发:${c.trigger} · n=${c.n} · @${c.first_seen}` +
        `${c.self_declared ? ` · 自定@${c.self_declared}` : ""} -->`);
      out.push("");
    }
  };
  section("通用节（任意官种都应带）", generalOnes);
  if (o.role !== "general") section(`${o.role} 节`, roleOnes);
  return out.join("\n") + "\n";
}

function renderJson() {
  return JSON.stringify(
    {
      _generated: {
        这是什么: "按官种渲染的条款集（派生物）",
        role: o.role,
        真相源: (gen.sources || []).map((s) => s.file),
        再生成: `node ccswitch/scripts/render-clauses.mjs --role ${o.role} --format json`,
        stale,
        stale_reasons: staleReasons,
        unclassified_excluded: unclassified.length,
      },
      general: generalOnes.map((c) => ({ ...c, body: bodyOf(c) })),
      role_clauses: roleOnes.map((c) => ({ ...c, body: bodyOf(c) })),
    },
    null,
    2
  ) + "\n";
}

const text = o.format === "json" ? renderJson() : renderMd();
if (o.out) {
  const target = path.isAbsolute(o.out) ? o.out : path.join(process.cwd(), o.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
  process.stdout.write(`✓ 已写 ${target}\n`);
} else {
  process.stdout.write(text);
}
process.stdout.write(
  marker({
    exit: 0, role: o.role, general: generalOnes.length, roleClauses: roleOnes.length,
    stale: stale ? 1 : 0, unclassified: unclassified.length,
  }) + "\n"
);
