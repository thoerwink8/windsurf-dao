#!/usr/bin/env node
// render-clauses.mjs — 按官种渲染条款集（运行时现算，无派生物）
//
// 「渲染出只给你这一份」是调研里唯一带量化的杠杆（Quote 条件把遵守率从 17-40% 推到
// 76-77%）。本文件从条款库 Markdown **现切现渲**：通用节 + 你那一节。
//
// ── 重设计后的形态（2026-08-11）──────────────────────────────────────────────
// 此前经 `ccswitch/clause-index.json`（机器面索引派生物）拿行号，另有 `--check` 闸守
// 「索引新不新鲜」。现改为直接调 lib/clause-parser.mjs 现算——索引、新鲜度、
// 「源变了行号没跟上切出隔壁条款的半截话」那一整族病，都随派生物一起消失。
// 末行契约保留 `stale=` 字段但**恒为 0**（现算无新鲜度问题）；字段留着只是
// 不让消费方的解析失锚。
//
// ── 三个 fail-closed（「空过」的反面）────────────────────────────────────────
//   ① **源读不到就不渲染**，并点名是哪份（零命中与没扫过必须分得开）。
//   ② **官种名不认识就报错**，并列出合法取值。
//   ③ **认识但语料里一条都没有 ⇒ 也报错**——「这个官种没有专属条款」与
//      「这份语料里没有官种分节」是两件事，渲染个空节是最坏的输出。
//
// ── 末行契约 ─────────────────────────────────────────────────────────────────
//   CLAUSE_RENDER_SUMMARY exit=<n> role=<name> general=<n> role_clauses=<n> stale=0 unclassified=<n>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultSources,
  parseFile,
  ROLE_TABLE,
  ROLE_OBSERVATION,
  ROLE_UNCLASSIFIED,
  ZONE,
} from "../lib/clause-parser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

// 合法官种取值来自**词表**（ROLE_TABLE）而不是「这份语料里恰好有的那些」：
// 后者会让「语料清单漏了一份」表现为「没有这个官种」——又一次把两种 0 混成一种。
const VALID_ROLES = ROLE_TABLE.map(([, r]) => r);

function parseArgs(argv) {
  const o = { role: null, sourcesJson: null, format: "md", listRoles: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--role") o.role = argv[++i];
    else if (a === "--sources-json") o.sourcesJson = argv[++i];
    else if (a === "--format") o.format = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--list-roles") o.listRoles = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else { o.help = true; o.bad = `未知参数：${a}`; }
  }
  return o;
}

function marker({ exit, role, general, roleClauses, unclassified }) {
  return `CLAUSE_RENDER_SUMMARY exit=${exit} role=${role} general=${general} role_clauses=${roleClauses} stale=0 unclassified=${unclassified}`;
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
      "render-clauses.mjs — 按官种渲染条款集（运行时现算，无派生物）",
      "",
      "  node ccswitch/scripts/render-clauses.mjs --role <官种>",
      "",
      "  --role <name>          合法取值：" + VALID_ROLES.join(" / "),
      "  --sources-json <path>  用别的语料清单（[{file,selector,role_scheme}]；默认仓内清单）",
      "  --format md|json       默认 md",
      "  --out <path>           写文件（默认打到 stdout）",
      "  --list-roles           只列这份语料里各官种的条款数",
      "",
      "正文从 Markdown 原文现切现算 —— 没有索引文件，没有「过期」这一物种。",
    ].join("\n") + "\n"
  );
  process.exit(o.bad ? 1 : 0);
}

// ── 语料清单：默认仓内（defaultSources），或 --sources-json 指定 ──────────────
let sources;
if (o.sourcesJson) {
  const p = path.isAbsolute(o.sourcesJson) ? o.sourcesJson : path.join(process.cwd(), o.sourcesJson);
  try {
    sources = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!Array.isArray(sources) || !sources.length) throw new Error("清单为空或不是数组");
  } catch (e) {
    die(`✗ 语料清单读不到：${p}\n   ${e && e.message}\n`,
      { exit: 1, role: o.role || "-", general: 0, roleClauses: 0, unclassified: 0 });
  }
} else {
  sources = defaultSources();
}

// ── 现算：逐份解析（读不到的源点名，不静默跳过）──────────────────────────────
const all = [];
const unreadable = [];
const sourceLines = new Map(); // file → string[]（现切正文用）
for (const s of sources) {
  const abs = s.external ? s.file : (path.isAbsolute(s.file) ? s.file : path.join(REPO_ROOT, s.file));
  if (!fs.existsSync(abs)) { unreadable.push(`${s.file}：源文件不在`); continue; }
  try {
    const text = fs.readFileSync(abs, "utf8");
    sourceLines.set(s.file, text.replace(/^﻿/, "").split(/\r\n|\n|\r/));
    const parsed = parseFile(abs, { file: s.file, selector: s.selector, roleScheme: s.role_scheme });
    all.push(...parsed.clauses, ...parsed.observation);
  } catch (e) {
    unreadable.push(`${s.file}：解析失败（${e && e.message}）`);
  }
}

if (o.listRoles) {
  const byRole = {};
  for (const c of all) byRole[c.role] = (byRole[c.role] || 0) + 1;
  process.stdout.write(`语料：${o.sourcesJson || "（仓内默认清单）"}\n`);
  process.stdout.write(`词表里的合法官种：${VALID_ROLES.join(" / ")}\n`);
  process.stdout.write("这份语料里的分布：\n");
  for (const r of [...VALID_ROLES, ROLE_OBSERVATION, ROLE_UNCLASSIFIED]) {
    process.stdout.write(`  ${String(r).padEnd(14)} ${byRole[r] || 0}\n`);
  }
  if (unreadable.length) process.stdout.write(`⚠ 有源读不到：${unreadable.join("；")}\n`);
  process.stdout.write(marker({
    exit: 0, role: "-", general: byRole.general || 0, roleClauses: 0,
    unclassified: byRole[ROLE_UNCLASSIFIED] || 0,
  }) + "\n");
  process.exit(0);
}

if (!o.role) {
  die(`✗ 缺 --role。合法取值：${VALID_ROLES.join(" / ")}\n   （不给缺省值是刻意的：默认渲染成通用节，会让「忘了传官种」表现为一份看起来正常的输出。）\n`,
    { exit: 1, role: "-", general: 0, roleClauses: 0, unclassified: 0 });
}

if (!VALID_ROLES.includes(o.role)) {
  const extra = o.role === ROLE_OBSERVATION
    ? "\n   （`observation` 是观察区候选，按协议它们**还不是条款**、派单时不摘，故不可渲染。）"
    : "";
  die(`✗ 不认识的官种：${o.role}\n   合法取值：${VALID_ROLES.join(" / ")}${extra}\n`,
    { exit: 1, role: o.role, general: 0, roleClauses: 0, unclassified: 0 });
}

// 有源读不到 ⇒ 拒渲染（渲染出来的东西可能缺了整整一份文件，而它看起来完全正常）
if (unreadable.length) {
  die(
    "✗ 有语料读不到，拒绝渲染：\n" + unreadable.map((r) => `   · ${r}\n`).join("") +
      "   ⇒ 核语料清单（--sources-json 指向的那几份，或仓内默认清单）。\n",
    { exit: 1, role: o.role, general: 0, roleClauses: 0, unclassified: 0 }
  );
}

// ── 挑条款（观察区一律不摘——协议里它们不是条款）────────────────────────────
const clauses = all.filter((c) => c.zone === ZONE.CLAUSE);
const generalOnes = clauses.filter((c) => c.role === "general");
const roleOnes = o.role === "general" ? [] : clauses.filter((c) => c.role === o.role);
const unclassified = clauses.filter((c) => c.role === ROLE_UNCLASSIFIED);

if (o.role !== "general" && roleOnes.length === 0) {
  die(
    `✗ 官种「${o.role}」在这份语料里 0 条 —— 不渲染。\n` +
      "   零条与零存在必须分得开：多半是这份语料里没有带官种分节的文件。\n" +
      `   ⇒ 用 --sources-json 指一份含官种节的语料；默认清单分布：--list-roles。\n`,
    { exit: 1, role: o.role, general: generalOnes.length, roleClauses: 0, unclassified: unclassified.length }
  );
}
if (generalOnes.length === 0 && roleOnes.length === 0) {
  die("✗ 通用节与官种节都是 0 条 —— 这份语料渲染不出任何东西，不给一份空文件。\n",
    { exit: 1, role: o.role, general: 0, roleClauses: 0, unclassified: unclassified.length });
}

// ── 正文现切 ─────────────────────────────────────────────────────────────────
function bodyOf(c) {
  const lines = sourceLines.get(c.file);
  if (!lines) return `（正文取不到：源文件 ${c.file} 读不了）`;
  return lines.slice(c.line - 1, c.line_end).join("\n").trimEnd();
}

function renderMd() {
  const out = [];
  out.push(`# 派单条款渲染 · 官种「${o.role}」`);
  out.push("");
  out.push("> 正文按行号从下列 Markdown 现切现算（无索引派生物）：");
  for (const s of sources) out.push(`> · \`${s.file}\``);
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
        这是什么: "按官种渲染的条款集（运行时现算）",
        role: o.role,
        真相源: sources.map((s) => s.file),
        再生成: `node ccswitch/scripts/render-clauses.mjs --role ${o.role} --format json`,
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
  marker({ exit: 0, role: o.role, general: generalOnes.length, roleClauses: roleOnes.length, unclassified: unclassified.length }) + "\n"
);
