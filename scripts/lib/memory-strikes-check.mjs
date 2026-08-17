// scripts/lib/memory-strikes-check.mjs —— 次数机械闸（#588）
//
// 判据：基准之后的条目，strikes >= 2 且 gate 为空 → 红。
// 「数到 2 却没配闸」本身变成会报警的状态，而不是又一条要人记得的规矩。
//
// 检查器自己拆 frontmatter（按行抽 key），不走 yaml-min、不走 memory 仓 gen-index
// ——检查逻辑不得复用被检查对象自己的解析。
//
// 基准线（与 #581 同一坑）：存量按文件名豁免，避免上线即长红。
// 新文件（不在名单）立刻纳入；存量若 metadata.modified 晚于 baselineAt，也纳入
// （用条目自己声明的时间，不读 Date.now）。
//
// 本检查是 local-only：读本机 memory Junction。CI / 未接的 worktree → SKIP，不是绿。

import { existsSync, readdirSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encodeProjectDir } from './dao-memory-link-check.mjs';

export const STRIKES_THRESHOLD = 2;
export const STRIKES_SKIP_NAMES = new Set(['MEMORY.md', 'README.md']);

export function parseMemoryFrontmatter(text) {
  const src = String(text || '');
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { ok: false, error: '无 frontmatter' };
  const fields = {};
  let prefix = '';
  for (const raw of m[1].split(/\r?\n/)) {
    if (!String(raw).trim()) continue;
    const nest = raw.match(/^( {2})([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nest) {
      const key = prefix ? `${prefix}.${nest[2]}` : nest[2];
      fields[key] = unquote(nest[3]);
      continue;
    }
    const top = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (top) {
      prefix = top[1];
      fields[top[1]] = unquote(top[2]);
    }
  }
  return { ok: true, fields };
}

function unquote(s) {
  const t = String(s ?? '').trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

export function normalizeGate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '' || s === 'null' || s === '~' || s === 'undefined') return null;
  return s;
}

export function readStrikesFields(fields) {
  const src = fields && typeof fields === 'object' ? fields : {};
  const strikesRaw = Object.prototype.hasOwnProperty.call(src, 'metadata.strikes')
    ? src['metadata.strikes']
    : src.strikes;
  const gateRaw = Object.prototype.hasOwnProperty.call(src, 'metadata.gate')
    ? src['metadata.gate']
    : src.gate;
  const hasStrikesKey = Object.prototype.hasOwnProperty.call(src, 'metadata.strikes')
    || Object.prototype.hasOwnProperty.call(src, 'strikes');
  const hasGateKey = Object.prototype.hasOwnProperty.call(src, 'metadata.gate')
    || Object.prototype.hasOwnProperty.call(src, 'gate');
  let strikes = null;
  if (hasStrikesKey && strikesRaw !== '' && strikesRaw != null) {
    const n = Number(strikesRaw);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: `strikes 不是非负整数: ${strikesRaw}` };
    }
    strikes = n;
  }
  return {
    ok: true,
    name: src.name || '',
    strikes,
    gate: normalizeGate(gateRaw),
    hasStrikesKey,
    hasGateKey,
    modified: src['metadata.modified'] || '',
  };
}

export function isModifiedAfter(modified, baselineAt) {
  if (!modified || !baselineAt) return false;
  const a = Date.parse(modified);
  const b = Date.parse(baselineAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a > b;
}

/**
 * @returns {{
 *   kind: 'unscanned'|'red'|'ok',
 *   error?: string,
 *   violations: string[],
 *   notes: string[],
 *   scanned: number,
 *   line: string
 * }}
 */
export function inspectStrikes({ entries, baselineNames, baselineAt } = {}) {
  if (!Array.isArray(entries)) {
    return {
      kind: 'unscanned', error: '没给 entries 数组',
      violations: [], notes: [], scanned: 0,
      line: 'strikes 闸：没查成（没给条目）',
    };
  }
  if (entries.length === 0) {
    return {
      kind: 'unscanned', error: '一套 memory 都没扫到',
      violations: [], notes: [], scanned: 0,
      line: 'strikes 闸：扫到 0 条——没查成，不是绿',
    };
  }
  const base = new Set(baselineNames || []);
  const violations = [];
  const notes = [];
  const bad = [];
  for (const e of entries) {
    const parsed = parseMemoryFrontmatter(e && e.text);
    if (!parsed.ok) {
      bad.push(`${e && e.name}: ${parsed.error}`);
      continue;
    }
    const f = readStrikesFields(parsed.fields);
    if (!f.ok) {
      bad.push(`${e && e.name}: ${f.error}`);
      continue;
    }
    const grandfathered = base.has(e.name);
    const inScope = !grandfathered || isModifiedAfter(f.modified, baselineAt);
    if (inScope) {
      if (!f.hasStrikesKey || !f.hasGateKey) {
        violations.push(`${e.name}: 基准后条目缺 strikes/gate 字段`);
        continue;
      }
      if (f.strikes >= STRIKES_THRESHOLD && !f.gate) {
        violations.push(`${e.name}: strikes=${f.strikes} 但 gate 空`);
      }
    } else if (f.strikes != null && f.strikes >= STRIKES_THRESHOLD && !f.gate) {
      notes.push(`${e.name}: 存量 strikes=${f.strikes} 待补闸`);
    }
  }
  if (bad.length) {
    return {
      kind: 'unscanned',
      error: `frontmatter 读失败 ${bad.length} 处：${bad.slice(0, 3).join('；')}`,
      violations, notes, scanned: entries.length,
      line: `strikes 闸：没查成（${bad[0]}）`,
    };
  }
  if (violations.length) {
    return {
      kind: 'red', violations, notes, scanned: entries.length,
      line: `strikes 闸：${violations.length} 条未配闸（${violations.join('；')}）`,
    };
  }
  const noteBit = notes.length ? `，存量待补闸 ${notes.length}` : '';
  return {
    kind: 'ok', violations, notes, scanned: entries.length,
    line: `strikes 闸：对照 ${entries.length} 条，基准后无「≥${STRIKES_THRESHOLD} 且无闸」${noteBit}`,
  };
}

export function listMemoryEntries(dir) {
  if (!dir || !existsSync(dir)) {
    return { unscanned: true, error: `memory 目录不在：${dir}`, entries: [] };
  }
  let names;
  try {
    names = readdirSync(dir).filter(f => f.endsWith('.md') && !STRIKES_SKIP_NAMES.has(f)).sort();
  } catch (e) {
    return { unscanned: true, error: `memory 目录读不了：${String(e.message || e).slice(0, 120)}`, entries: [] };
  }
  const entries = [];
  const bad = [];
  for (const name of names) {
    try {
      entries.push({ name, text: readFileSync(join(dir, name), 'utf8') });
    } catch (e) {
      bad.push(`${name}: ${String(e.message || e).slice(0, 80)}`);
    }
  }
  if (bad.length) {
    return { unscanned: true, error: `有文件读失败：${bad.slice(0, 3).join('；')}`, entries };
  }
  return { unscanned: false, entries };
}

export function loadStrikesBaseline(file) {
  if (!file || !existsSync(file)) {
    return { unscanned: true, error: `基准文件不在：${file}`, files: [], baselineAt: '' };
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { unscanned: true, error: `基准文件不是 JSON：${String(e.message || e).slice(0, 80)}`, files: [], baselineAt: '' };
  }
  if (!doc || !Array.isArray(doc.files) || !doc.baselineAt) {
    return { unscanned: true, error: '基准文件缺 files[] / baselineAt', files: [], baselineAt: '' };
  }
  return { unscanned: false, files: doc.files, baselineAt: doc.baselineAt };
}

/** 本机 memory 目录：与 memory-link 同一套编码，不硬编码任何本机路径。 */
export function resolveMemoryDir({ root, home } = {}) {
  if (!root || !home) return { skip: true, error: '没给 root/home' };
  const encoded = encodeProjectDir(resolve(root));
  const local = join(home, '.claude', 'projects', encoded, 'memory');
  try {
    const st = lstatSync(local);
    if (st.isSymbolicLink()) {
      try {
        return { skip: false, dir: realpathSync(local), local };
      } catch (e) {
        return { skip: true, error: `memory 链接悬空：${String(e.message || e).slice(0, 80)}` };
      }
    }
    if (st.isDirectory()) return { skip: false, dir: local, local };
    return { skip: true, error: `memory 既不是链接也不是目录` };
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { skip: true, error: `本机无该项目 memory 目录（${local}）` };
    }
    return { skip: true, error: `memory 目录探测不了：${String(e.message || e).slice(0, 80)}` };
  }
}
