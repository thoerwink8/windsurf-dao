// 概念归属表闸（dao-check）。
//
// 病：本仓有「家目录落点」的归属表（host/machine/INDEX.md），却没有「概念/任务类型 →
//     哪个仓 → 哪份文档」的表。于是「接渠道」这类活，知识主体在他仓，本仓这边没有任何
//     指针——grep 零命中，而现场分不清「本仓真没有」和「答案在别的仓」（2026-09-19 实咬）。
// 闸：docs/ownership.json 每条「看哪」必须在他仓真实存在；他仓不在本机 = unscanned
//     （没查成 ≠ 绿，也不许判红）；常驻面（AGENTS.md——CLAUDE.md 已退成一行 @AGENTS.md 桥）
//     必须有一行指向本表。
//
// 两套独立逻辑，禁止互相调用：
//   parseTable      —— 只解析表本身。
//   inspectOwnership—— 只对账（表 × 他仓文件系统 × 常驻面），不复用表的解析去查文件。
// 零样本：一条他仓指针都没查成 = 没查成（unscanned），不是绿。
//
// 搬到别的仓（自上而下复用）：把本文件与 docs/ownership.json 一起拷过去，在 dao-check 里
// 调 inspectOwnership 即可——表里「归仓」写仓名，「看哪」写该仓相对路径，本机没有那个仓就自动
// 记 unscanned。

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const TABLE_REL = 'docs/ownership.json';
export const POINTER_REL = 'AGENTS.md';
export const POINTER_NEEDLE = 'docs/ownership.json';

const REQUIRED_FIELDS = ['概念', '归仓', '看哪', '本仓只写'];

function isEmptyField(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === '';
}

/** 只解析表，不碰文件系统。 */
export function parseTable(text) {
  if (text == null) return { missing: true };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { bad: `JSON 解析不了: ${e.message}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { bad: '表不是对象' };
  if (!Array.isArray(data.entries)) return { bad: '缺 entries 数组' };
  return { entries: data.entries };
}

/** 表里声明过的他仓名（去重）。 */
export function collectRepos(text) {
  const p = parseTable(text);
  if (!p.entries) return [];
  const out = new Set();
  for (const e of p.entries) {
    const repo = e && e['归仓'];
    if (typeof repo === 'string' && repo.trim()) out.add(repo.trim());
  }
  return [...out];
}

/**
 * @param {object} o
 * @param {string|null} o.tableText   docs/ownership.json 正文
 * @param {string|null} o.pointerText 常驻面（AGENTS.md）正文
 * @param {Map|object} o.repoRoots    他仓名 → 本机绝对路径（不在本机的仓不出现）
 */
export function inspectOwnership({ tableText, pointerText, repoRoots } = {}) {
  const parsed = parseTable(tableText);
  if (parsed.missing) return { kind: 'unscanned', problems: [`归属表不在：${TABLE_REL}`], checked: 0, unscannedEntries: [] };
  if (parsed.bad) return { kind: 'red', problems: [parsed.bad], checked: 0, unscannedEntries: [] };

  const entries = parsed.entries;
  if (entries.length === 0) {
    return { kind: 'unscanned', problems: ['归属表 0 条——本次没查成，不是「0 条漏」'], checked: 0, unscannedEntries: [] };
  }

  const roots = repoRoots instanceof Map ? repoRoots : new Map(Object.entries(repoRoots || {}));
  const problems = [];
  const unscannedEntries = [];
  let checked = 0;

  entries.forEach((e, i) => {
    const label = e && e['概念'] ? String(e['概念']) : `#${i}`;
    for (const field of REQUIRED_FIELDS) {
      if (isEmptyField(e ? e[field] : null)) problems.push(`条目「${label}」缺字段 ${field}`);
    }
    const repo = e && e['归仓'];
    if (typeof repo !== 'string' || !repo.trim()) return;
    const root = roots.get(repo.trim());
    if (!root) {
      unscannedEntries.push(label);
      return;
    }
    const look = Array.isArray(e['看哪']) ? e['看哪'] : [];
    for (const rel of look) {
      const p = join(root, String(rel).replace(/\\/g, '/'));
      if (!existsSync(p)) problems.push(`条目「${label}」的「看哪」指向空气: ${repo.trim()}/${rel}`);
      else checked += 1;
    }
  });

  if (pointerText == null) problems.push(`常驻面读不到：${POINTER_REL}`);
  else if (!String(pointerText).includes(POINTER_NEEDLE)) problems.push(`常驻面 ${POINTER_REL} 没有一行指向 ${POINTER_NEEDLE}`);

  if (problems.length) return { kind: 'red', problems, checked, unscannedEntries };
  if (checked === 0) {
    return { kind: 'unscanned', problems: ['他仓都不在本机——一条指针都没查成'], checked, unscannedEntries };
  }
  return { kind: 'ok', checked, unscannedEntries };
}
