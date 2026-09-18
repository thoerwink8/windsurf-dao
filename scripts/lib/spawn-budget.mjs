// scripts/lib/spawn-budget.mjs —— 测试里起子进程的预算闸
//
// 来历（2026-09-06 用户拍板「两刀都要做，但后面肯定会忘记」）：
// 第二刀是把 `spawnSync(node, [CLI, ...])` 改成进程内调用。
// 防忘不靠记性，靠一条会响的闸：每个测试文件自己声明允许的调用数，超了就报。
//
// 2026-09-18 #1399：公共 `SPAWN_BUDGET` 数字 + `BUDGET_NOTE` 历史长串
// 是无关 PR 的人造冲突源（#1322 与 #1359 都把 159 改成 160，正确合计是 161）。
// 预算声明与测试文件同域（tests/<名>.spawn-budget.json），检查器运行时汇总。
// 独立模块加 spawn 只改自己那份声明，不再改公共数字/列表尾。
//
// 上限语义仍在：实际调用不得超过该文件声明；未声明、声明删了、坏 JSON、
// 扫描 0 文件都不能报绿。不把实际观测数当预算，不自动扩容，不关闸。
// 历史在 git / PR，不把流水账拼回运行时代码。
// 第二刀往下做：把对应文件的 budget 改小。目标 ≤40。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 第二刀的目标总量。不是闸，也不许拿它当「实际多少就准多少」的自动放宽。 */
export const SECOND_CUT_TARGET = 40;

export const DECL_SUFFIX = '.spawn-budget.json';

/**
 * 调用形态（标识符 + 括号）。不要拿它扫原文：注释和字符串里的同形文本不是调用。
 * 计数走 countSpawnCalls 的词法扫描。
 */
export const SPAWN_CALL_RE = /\bspawnSync\s*\(/g;

export const TEST_FILE_RE = /\.test\.(js|mjs|cjs)$/i;

const SPAWN_IDENT = 'spawnSync';

function isIdentChar(c) {
  return c != null && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '$');
}

function skipLineComment(s, i, n) {
  i += 2;
  while (i < n && s[i] !== '\n' && s[i] !== '\r') i++;
  return i;
}

function skipBlockComment(s, i, n) {
  i += 2;
  while (i + 1 < n && !(s[i] === '*' && s[i + 1] === '/')) i++;
  return i + 1 < n ? i + 2 : n;
}

function skipQuoted(s, i, n, quote) {
  i += 1;
  while (i < n) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === quote) return i + 1;
    i++;
  }
  return n;
}

/** spawnSync 与 ( 之间只允许空白和注释。 */
function skipWsComments(s, i, n) {
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      i = skipLineComment(s, i, n);
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i = skipBlockComment(s, i, n);
      continue;
    }
    break;
  }
  return i;
}

/**
 * 数的是**调用**，不是「提到」。
 * 2026-09-06 首版按 /spawnSync/ 计数，import 行和注释里的字都被算进去。
 * 2026-09-18 #1405 审官 P1：`\bspawnSync\s*\(` 扫原文，仍会把 `// spawnSync(`
 * 和 `"spawnSync("` 当成调用。词法扫描跳过注释、引号串、模板字面量；
 * 模板插值 `${...}` 里的代码照数（那是真调用）。
 */
export function countSpawnCalls(source) {
  const s = String(source);
  const n = s.length;
  let i = 0;
  let count = 0;
  const stack = [{ kind: 'code', braces: 0 }];

  while (i < n) {
    const ctx = stack[stack.length - 1];
    const c = s[i];
    const c2 = s[i + 1];

    if (ctx.kind === 'code') {
      if (c === '/' && c2 === '/') {
        i = skipLineComment(s, i, n);
        continue;
      }
      if (c === '/' && c2 === '*') {
        i = skipBlockComment(s, i, n);
        continue;
      }
      if (c === "'" || c === '"') {
        i = skipQuoted(s, i, n, c);
        continue;
      }
      if (c === '`') {
        stack.push({ kind: 'template' });
        i++;
        continue;
      }
      if (c === '{') { ctx.braces++; i++; continue; }
      if (c === '}') {
        if (ctx.braces > 0) ctx.braces--;
        else if (stack.length > 1) stack.pop();
        i++;
        continue;
      }
      if (c === 's' && s.startsWith(SPAWN_IDENT, i)) {
        const prev = i > 0 ? s[i - 1] : '';
        const afterPos = i + SPAWN_IDENT.length;
        const after = afterPos < n ? s[afterPos] : '';
        if (!isIdentChar(prev) && !isIdentChar(after)) {
          const j = skipWsComments(s, afterPos, n);
          if (j < n && s[j] === '(') count++;
        }
        i += SPAWN_IDENT.length;
        continue;
      }
      i++;
      continue;
    }

    if (c === '\\') { i += 2; continue; }
    if (c === '`') { stack.pop(); i++; continue; }
    if (c === '$' && c2 === '{') {
      stack.push({ kind: 'code', braces: 0 });
      i += 2;
      continue;
    }
    i++;
  }
  return count;
}

/** tests/land.test.js → land.test.spawn-budget.json */
export function declFileForTest(testFile) {
  return String(testFile).replace(/\.(js|mjs|cjs)$/i, DECL_SUFFIX);
}

/** foo.test.spawn-budget.json → foo.test ；对不上返回 null */
export function stemFromDeclFile(declFile) {
  const name = String(declFile);
  if (!name.endsWith(DECL_SUFFIX)) return null;
  return name.slice(0, -DECL_SUFFIX.length);
}

/** tests/land.test.js → land.test */
export function stemFromTestFile(testFile) {
  return String(testFile).replace(/\.(js|mjs|cjs)$/i, '');
}

/**
 * 解析一份声明。JSON 都读不成 → unknown（没查成）；
 * JSON 合法但字段不对 → red（坏配置，不是「按实际数放行」）。
 * @returns {{state:'ok'|'red'|'unknown', detail?:string, budget?:number, why?:string, headroom?:boolean}}
 */
export function parseBudgetDeclaration(text, file) {
  const label = file || '(声明)';
  let data;
  try {
    data = JSON.parse(String(text));
  } catch (e) {
    return { state: 'unknown', detail: `${label} JSON 解析失败：${String(e.message || e).slice(0, 160)}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { state: 'red', detail: `${label} 声明必须是对象，不能是数组/空` };
  }
  if (!Number.isInteger(data.budget) || data.budget < 0) {
    return { state: 'red', detail: `${label} budget 必须是 ≥0 的整数（不许用实际调用数顶上去）` };
  }
  if (typeof data.why !== 'string' || !data.why.trim()) {
    return { state: 'red', detail: `${label} 必须写 why：这条 CLI/进程边界为什么不能改成进程内调用` };
  }
  return {
    state: 'ok',
    budget: data.budget,
    why: data.why.trim(),
    headroom: data.headroom === true,
  };
}

/**
 * 扫描 tests/：独立数调用，再读声明。不复用被检查测试自己的计数器。
 * 读目录失败 / 0 个测试文件 / 声明 JSON 读不成 → scan=unknown。
 *
 * @param {string} dir
 * @param {{readdirSync?:Function, readFileSync?:Function}} [io]
 * @returns {{scan:'ok'|'unknown', scanDetail?:string, counts:{file:string,count:number}[], declarations:object[]}}
 */
export function collectSpawnBudgetInputs(dir, io = {}) {
  const readdir = io.readdirSync || readdirSync;
  const readFile = io.readFileSync || readFileSync;
  let names;
  try {
    names = readdir(dir);
  } catch (e) {
    return {
      scan: 'unknown',
      scanDetail: `读不到测试目录：${String(e.message || e)}`,
      counts: [],
      declarations: [],
    };
  }
  if (!Array.isArray(names)) {
    return { scan: 'unknown', scanDetail: 'readdir 结果不是数组（没查成）', counts: [], declarations: [] };
  }
  const testFiles = names.filter((f) => TEST_FILE_RE.test(f)).sort();
  if (testFiles.length === 0) {
    return {
      scan: 'unknown',
      scanDetail: '一个测试文件都没扫到——没查成，不是「没有 spawn」',
      counts: [],
      declarations: [],
    };
  }
  const counts = [];
  for (const f of testFiles) {
    let src;
    try {
      src = readFile(join(dir, f), 'utf8');
    } catch (e) {
      return {
        scan: 'unknown',
        scanDetail: `读测试文件 ${f} 失败：${String(e.message || e)}`,
        counts: [],
        declarations: [],
      };
    }
    counts.push({ file: f, count: countSpawnCalls(src) });
  }
  const declFiles = names.filter((f) => String(f).endsWith(DECL_SUFFIX)).sort();
  const declarations = [];
  for (const f of declFiles) {
    let text;
    try {
      text = readFile(join(dir, f), 'utf8');
    } catch (e) {
      return {
        scan: 'unknown',
        scanDetail: `读声明 ${f} 失败：${String(e.message || e)}`,
        counts,
        declarations: [],
      };
    }
    const parsed = parseBudgetDeclaration(text, f);
    if (parsed.state === 'unknown') {
      return { scan: 'unknown', scanDetail: parsed.detail, counts, declarations: [] };
    }
    declarations.push({
      declFile: f,
      key: stemFromDeclFile(f),
      budget: parsed.state === 'ok' ? parsed.budget : null,
      why: parsed.why || '',
      headroom: parsed.headroom === true,
      parseState: parsed.state,
      parseDetail: parsed.detail || '',
    });
  }
  return { scan: 'ok', counts, declarations };
}

function topFiles(counts) {
  return [...counts]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((c) => `${c.file}×${c.count}`)
    .join('、');
}

const HOWTO = '新增 spawn 写对应 tests/<名>.spawn-budget.json（budget + why），'
  + '或把调用改成进程内（TIA 第二刀）。不许按实际数量自动放宽，不许改一个公共数字。';

/**
 * @param {object} input collectSpawnBudgetInputs 的返回，或同形对象
 * @returns {{state:'ok'|'red'|'unknown', detail:string, actualTotal?:number, declaredTotal?:number, violations?:object[]}}
 */
export function classifySpawnBudget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      state: 'unknown',
      detail: '扫描结果不是对象（没查成）。公共总数 API 已删，不要把实际调用数当成预算。',
    };
  }
  if (input.scan === 'unknown') {
    return { state: 'unknown', detail: input.scanDetail || '没查成' };
  }
  if (!Array.isArray(input.counts)) {
    return { state: 'unknown', detail: 'counts 不是数组（没查成）' };
  }
  if (input.counts.length === 0) {
    return { state: 'unknown', detail: '一个测试文件都没扫到——没查成，不是「没有 spawn」' };
  }
  if (!Array.isArray(input.declarations)) {
    return { state: 'unknown', detail: 'declarations 不是数组（没查成）——缺声明不许拿实际数顶预算' };
  }

  const violations = [];
  for (const d of input.declarations) {
    if (d.parseState && d.parseState !== 'ok') {
      violations.push({ kind: 'bad-decl', file: d.declFile, detail: d.parseDetail || `${d.declFile} 声明不合法` });
    }
  }

  const declByKey = new Map();
  for (const d of input.declarations) {
    if (d.parseState && d.parseState !== 'ok') continue;
    if (d.headroom) continue;
    if (!d.key) {
      violations.push({ kind: 'bad-decl', file: d.declFile, detail: `${d.declFile} 文件名对不上 ${DECL_SUFFIX}` });
      continue;
    }
    if (declByKey.has(d.key)) {
      violations.push({ kind: 'dup', file: d.declFile, detail: `${d.declFile} 与另一份声明重复（同一测试只能有一份）` });
      continue;
    }
    declByKey.set(d.key, d);
  }

  const countByKey = new Map();
  for (const c of input.counts) {
    const key = stemFromTestFile(c.file);
    countByKey.set(key, c);
    const n = Number(c.count) || 0;
    if (n <= 0) continue;
    const d = declByKey.get(key);
    if (!d) {
      violations.push({
        kind: 'undeclared',
        file: c.file,
        count: n,
        detail: `${c.file} 有 ${n} 处 spawnSync，没有 ${declFileForTest(c.file)}（未声明 spawn 必须红）`,
      });
      continue;
    }
    if (n > d.budget) {
      violations.push({
        kind: 'over',
        file: c.file,
        count: n,
        budget: d.budget,
        detail: `${c.file} spawnSync ${n} 处，超本文件预算 ${d.budget}（${HOWTO}）`,
      });
    }
  }

  for (const d of input.declarations) {
    if (d.headroom) continue;
    if (d.parseState && d.parseState !== 'ok') continue;
    if (!d.key) continue;
    if (!countByKey.has(d.key)) {
      violations.push({
        kind: 'orphan',
        file: d.declFile,
        detail: `声明 ${d.declFile} 找不到对应测试文件（删测试须同时删声明，余量写 headroom:true）`,
      });
    }
  }

  const actualTotal = input.counts.reduce((s, c) => s + (Number(c.count) || 0), 0);
  const declaredTotal = input.declarations.reduce((s, d) => {
    if (d.parseState && d.parseState !== 'ok') return s;
    if (!Number.isInteger(d.budget)) return s;
    return s + d.budget;
  }, 0);

  if (violations.length) {
    const shown = violations.slice(0, 4).map((v) => v.detail).join('；');
    return {
      state: 'red',
      actualTotal,
      declaredTotal,
      violations,
      detail: `测试里 spawnSync ${actualTotal} 处 / 声明合计 ${declaredTotal}。${shown}${violations.length > 4 ? ' …' : ''}。大头：${topFiles(input.counts)}。${HOWTO}`,
    };
  }

  const slack = declaredTotal - actualTotal;
  const targetNote = `第二刀目标 ≤${SECOND_CUT_TARGET}`;
  return {
    state: 'ok',
    actualTotal,
    declaredTotal,
    violations: [],
    detail: slack === 0
      ? `spawnSync ${actualTotal} 处，正好卡在声明合计上——${targetNote}。${HOWTO}`
      : `spawnSync ${actualTotal} 处 / 声明合计 ${declaredTotal}（还差 ${slack} 到上限；${targetNote}）。${HOWTO}`,
  };
}
