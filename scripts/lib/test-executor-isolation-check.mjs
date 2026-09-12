// dao-check ㉠：测试结构性够不着真执行体（#1152）
//
// 来历（2026-09-08 实咬）：tests/dispatch-launch.test.js 与 dao-dispatch-gate.test.js
// 对 `dao.mjs dispatch --issue 565` 真 spawn，靠「拒派闸 / DAO_DISPATCH_NO_SPAWN」当安全网。
// NO_SPAWN 从未被生产代码读取；空账本 + 已消歧 → 同步 ensureWorkspace + startSession，
// 会话名单冒出 14+ 个 `短摘要 #565`，树嵌套建在工人树里（dao-1121/dao-565）。
//
// 闸失手 = 烧钱且静默。所以检查两面：
//   1. 测试源码不许 spawn/exec 调 dao dispatch / dispatch-exec 还不带 --dry-run
//      （子进程 env 丢失时 NODE_TEST_CONTEXT 也丢，运行时闸够不着）。
//      认别名（spawnSync: run / const run = cp.spawnSync / const actual = run 链式赋值）、
//      argv 变量、模板动词、exec 命令字符串、dispatch-exec、计算属性 cp["spawnSync"]、
//      拼接动词 "dis"+"patch"。别名解析收到固定点，一层赋值再转一层不许 scanned:0。
//      --dry-run 只认解析后的子进程 argv（input / env 字段里的字面量不算）。
//      解析不了的 child_process 计算属性调用 fail-closed——不许 scanned:0 静默放行。
//      只钉调用名 spawnSync + 单双引号字面量会让审官给的对抗样本 scanned:0 静默漏检。
//   2. 生产接线：ensureWorkspace / startSession / cmdDispatchMirasim 都要过隔离判官
//
// 检查器自持正则与括号匹配，不 import 被测测试、不 import mirasim-runtime 的解析。
// 扫完 0 个测试文件 = 没查成，不是「没有真派工」。
// 故意样本必须是 .txt / .fixture：任何 *.js 都会被 node --test 当模块加载并执行。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SPAWN_FNS = ['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec', 'fork'];
const FIXTURE_FILE = /\.(?:fixture|txt)$/;
const EXECUTABLE_TEST = /\.test\.(js|mjs|cjs)$/;
const JS_FILE = /\.(js|mjs|cjs)$/;

function hasLit(s, lit) {
  const esc = String(lit || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('[' + '\'"`' + ']' + esc + '[' + '\'"`' + ']').test(String(s || ''));
}

function readStringLit(s, i) {
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  let esc = false;
  for (let k = i + 1; k < s.length; k++) {
    const c = s[k];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === q) return { body: s.slice(i + 1, k), end: k + 1 };
  }
  return null;
}

/** "dis" + "patch" → "dispatch"。带 ${} 的模板不折。 */
function foldStringConcat(text) {
  let s = String(text || '');
  for (let n = 0; n < 32; n++) {
    let found = false;
    for (let i = 0; i < s.length; i++) {
      const a = readStringLit(s, i);
      if (!a) continue;
      if (s[i] === '`' && a.body.includes('${')) continue;
      let j = a.end;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] !== '+') continue;
      j += 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      const b = readStringLit(s, j);
      if (!b) continue;
      if (s[j] === '`' && b.body.includes('${')) continue;
      s = s.slice(0, i) + s[i] + a.body + b.body + s[i] + s.slice(b.end);
      found = true;
      break;
    }
    if (!found) break;
  }
  return s;
}

/** 引号/`dispatch`，以及 exec("node dao.mjs dispatch ...") 这种命令字符串里的裸动词。 */
function hasDispatchVerb(text) {
  const s = foldStringConcat(String(text || ''));
  if (hasLit(s, 'dispatch') || hasLit(s, 'dispatch-exec')) return true;
  return /(?:^|[\s"'`=/,\[\]])dispatch(?:-exec)?(?=[\s"'`,\]]|$)/.test(s);
}

function escapeIdent(name) {
  return String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 openIdx 处的 '(' 或 '[' 起，匹配到成对关闭。字符串内的括号不算。 */
function matchBalanced(src, openIdx) {
  const open = src[openIdx];
  const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : '';
  if (!close) return -1;
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelArgs(inner) {
  const args = [];
  let start = 0;
  let depthParen = 0;
  let depthBrack = 0;
  let depthBrace = 0;
  let inStr = null;
  let esc = false;
  const text = String(inner || '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(') depthParen++;
    else if (c === ')') depthParen--;
    else if (c === '[') depthBrack++;
    else if (c === ']') depthBrack--;
    else if (c === '{') depthBrace++;
    else if (c === '}') depthBrace--;
    else if (c === ',' && depthParen === 0 && depthBrack === 0 && depthBrace === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  args.push(text.slice(start));
  return args;
}

/**
 * 收集 spawn/exec 调用名：原名 + 解构/import as/赋值别名。
 * `{ spawnSync: require(...) }` 的 require 不当别名（后面是 '(' 不是 ',' / '}'）。
 * 别名会再赋一次（`const run = cp.spawnSync; const actual = run`），收到固定点。
 */
export function collectSpawnAliases(src) {
  const names = new Set(SPAWN_FNS);
  const text = String(src || '');
  for (let n = 0; n < 32; n++) {
    const before = names.size;
    const fns = [...names].map(escapeIdent).join('|');
    const dest = new RegExp(String.raw`\b(?:${fns})\s*:\s*([A-Za-z_][\w]*)\s*[,}]`, 'g');
    let m;
    while ((m = dest.exec(text))) names.add(m[1]);
    const imp = new RegExp(String.raw`\b(?:${fns})\s+as\s+([A-Za-z_][\w]*)\b`, 'g');
    while ((m = imp.exec(text))) names.add(m[1]);
    const asg = new RegExp(
      String.raw`\b(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*[^\n;]*\b(?:${fns})\s*(?![(\w])`,
      'g',
    );
    while ((m = asg.exec(text))) names.add(m[1]);
    const bare = new RegExp(
      String.raw`(?:^|[;\n])\s*([A-Za-z_][\w]*)\s*=\s*[^\n;]*\b(?:${fns})\s*(?![(\w])`,
      'g',
    );
    while ((m = bare.exec(text))) names.add(m[1]);
    if (names.size === before) break;
  }
  return [...names];
}

function collectChildProcessReceivers(src) {
  const names = new Set();
  const text = String(src || '');
  const patterns = [
    /(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g,
    /import\s+\*\s+as\s+([A-Za-z_][\w]*)\s+from\s+['"](?:node:)?child_process['"]/g,
    /import\s+([A-Za-z_][\w]*)\s+from\s+['"](?:node:)?child_process['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) names.add(m[1]);
  }
  return names;
}

function receiverBefore(text, bracketIdx, cpNames) {
  const before = text.slice(Math.max(0, bracketIdx - 96), bracketIdx);
  const req = before.match(/require\s*\(\s*['"](?:node:)?child_process['"]\s*\)\s*$/);
  if (req) return { isCp: true, start: bracketIdx - req[0].length };
  const id = before.match(/([A-Za-z_][\w]*)\s*$/);
  if (id) return { isCp: cpNames.has(id[1]), start: bracketIdx - id[0].length };
  return { isCp: false, start: bracketIdx };
}

function resolveComputedKey(src, keySrc) {
  const folded = foldStringConcat(String(keySrc || '')).trim();
  const lit = folded.match(/^(['"`])([\s\S]*)\1$/);
  if (lit && !(lit[1] === '`' && lit[2].includes('${'))) return { resolved: lit[2], opaque: false };
  if (/^[A-Za-z_][\w]*$/.test(folded)) {
    const str = findStringLiteral(src, folded);
    const sm = String(str || '').match(/^(['"`])([\s\S]*)\1$/);
    if (sm && !(sm[1] === '`' && sm[2].includes('${'))) return { resolved: sm[2], opaque: false };
    return { resolved: '', opaque: true };
  }
  return { resolved: '', opaque: true };
}

function isSpawnName(name, names) {
  const n = String(name || '');
  if (!n) return false;
  if (SPAWN_FNS.includes(n)) return true;
  return Array.isArray(names) && names.includes(n);
}

function isOpaqueComputedSpan(span, names, src) {
  const open = String(span || '').indexOf('(');
  if (open < 0) return false;
  const before = span.slice(0, open);
  const rb = before.lastIndexOf(']');
  if (rb < 0) return false;
  const lb = before.lastIndexOf('[');
  if (lb < 0 || lb > rb) return false;
  const { resolved, opaque } = resolveComputedKey(src || span, before.slice(lb + 1, rb));
  if (isSpawnName(resolved, names)) return false;
  return opaque || !isSpawnName(resolved, names);
}

function scanComputedCalls(text, spawnNames, cpNames, onSpan) {
  let inStr = null;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c !== '[') continue;
    const keyEnd = matchBalanced(text, i);
    if (keyEnd < 0) continue;
    const after = text.slice(keyEnd + 1).match(/^\s*\(/);
    if (!after) continue;
    const openIdx = text.indexOf('(', keyEnd + 1);
    if (openIdx < 0) continue;
    const callEnd = matchBalanced(text, openIdx);
    if (callEnd < 0) continue;
    const { resolved, opaque } = resolveComputedKey(text, text.slice(i + 1, keyEnd));
    const recv = receiverBefore(text, i, cpNames);
    if (!isSpawnName(resolved, [...spawnNames]) && !(opaque && recv.isCp)) continue;
    onSpan(text.slice(recv.start, callEnd + 1));
    i = callEnd;
  }
}

export function extractCallSpans(src, names) {
  const text = String(src || '');
  const list = (Array.isArray(names) ? names : [names]).map(String).filter(Boolean);
  const alts = list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const spans = [];
  const seen = new Set();
  const push = (span) => {
    if (!span || seen.has(span)) return;
    seen.add(span);
    spans.push(span);
  };
  if (alts.length) {
    const re = new RegExp(String.raw`\b(?:${alts.join('|')})\s*\(`, 'g');
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      if (/\bfunction\s+$/.test(before)) continue;
      const openIdx = text.indexOf('(', m.index);
      if (openIdx < 0) continue;
      const end = matchBalanced(text, openIdx);
      if (end < 0) continue;
      push(text.slice(m.index, end + 1));
    }
  }
  const spawnNames = new Set([...list, ...SPAWN_FNS]);
  scanComputedCalls(text, spawnNames, collectChildProcessReceivers(text), push);
  return spans;
}

function findArrayLiteral(src, name) {
  const re = new RegExp(String.raw`(?:const|let|var)\s+${escapeIdent(name)}\s*=\s*\[`);
  const m = re.exec(src);
  if (!m) return '';
  const openIdx = src.indexOf('[', m.index + m[0].length - 1);
  if (openIdx < 0) return '';
  const end = matchBalanced(src, openIdx);
  if (end < 0) return '';
  return src.slice(openIdx, end + 1);
}

function findStringLiteral(src, name) {
  const re = new RegExp(String.raw`(?:const|let|var)\s+${escapeIdent(name)}\s*=\s*`);
  const m = re.exec(src);
  if (!m) return '';
  const start = m.index + m[0].length;
  const first = readStringLit(src, start);
  if (!first) return '';
  let end = first.end;
  while (true) {
    let j = end;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== '+') break;
    j += 1;
    while (j < src.length && /\s/.test(src[j])) j++;
    const next = readStringLit(src, j);
    if (!next) break;
    end = next.end;
  }
  return foldStringConcat(src.slice(start, end));
}

function expandArgvSpreads(src, span) {
  let out = span;
  for (const m of span.matchAll(/\.\.\.\s*([A-Za-z_][\w]*)/g)) {
    if (m[1] === 'process' || m[1] === 'env') continue;
    const lit = findArrayLiteral(src, m[1]);
    if (lit) out += `\n${lit}`;
  }
  return out;
}

/** 子进程 argv / exec 命令字符串，不含 options 对象。--dry-run 只在这里算数。 */
function argvTextForCall(src, span) {
  const open = span.indexOf('(');
  if (open < 0) return '';
  const close = matchBalanced(span, open);
  if (close < 0) return '';
  const args = splitTopLevelArgs(span.slice(open + 1, close));
  const pieces = [];
  const addArray = (piece) => {
    const expanded = expandArgvSpreads(src, piece);
    pieces.push(expanded);
    for (const idm of expanded.matchAll(/\b([A-Za-z_][\w]*)\b/g)) {
      const id = idm[1];
      if (SPAWN_FNS.includes(id) || id === 'process' || id === 'execPath') continue;
      const str = findStringLiteral(src, id);
      const arr = findArrayLiteral(src, id);
      if (str) pieces.push(str);
      if (arr) pieces.push(arr);
    }
  };
  for (const raw of args) {
    const t = raw.trim();
    if (!t || t.startsWith('{')) continue;
    if (/^(?:function\b|[A-Za-z_][\w]*\s*=>)/.test(t)) continue;
    if (t.startsWith('[')) { addArray(t); continue; }
    if (/^[A-Za-z_][\w]*$/.test(t)) {
      const arr = findArrayLiteral(src, t);
      const str = findStringLiteral(src, t);
      if (arr) addArray(arr);
      if (str) pieces.push(str);
      continue;
    }
    pieces.push(t);
  }
  return pieces.join('\n');
}

function hasDryRun(text) {
  const s = foldStringConcat(String(text || ''));
  if (hasLit(s, '--dry-run')) return true;
  return /(?:^|[\s"'`=/,\[\]])--dry-run(?=[\s"'`,\]]|$)/.test(s);
}

/** 显式 env: { ... } 对象字面量里既没有 process.env 也没有隔离信号。 */
export function isEnvLost(span) {
  const text = String(span || '');
  const m = text.match(/\benv\s*:\s*\{/);
  if (!m) return false;
  const openIdx = text.indexOf('{', m.index);
  const end = matchBalanced(text, openIdx);
  const obj = end < 0 ? text.slice(openIdx) : text.slice(openIdx, end + 1);
  if (/\.\.\.\s*process\.env\b/.test(obj)) return false;
  if (/NODE_TEST_CONTEXT|DAO_DISPATCH_NO_SPAWN|DAO_ALLOW_REAL_EXECUTOR/.test(obj)) return false;
  return true;
}

/**
 * 纯判官：一段测试正文里有没有「真 spawn dao dispatch/dispatch-exec 且无 --dry-run」。
 * src == null → 没查成；空字符串是查成了的 0 条。
 */
export function classifyTestDispatchSpawns(src) {
  if (src == null) {
    return { ok: false, unscanned: true, error: '没给测试正文（没查成）', scanned: 0, violations: [] };
  }
  const text = String(src);
  const names = collectSpawnAliases(text);
  const spans = extractCallSpans(text, names);
  const violations = [];
  let scanned = 0;
  for (const span of spans) {
    const argvText = foldStringConcat(argvTextForCall(text, span));
    const opaque = isOpaqueComputedSpan(span, names, text);
    const dispatch = hasDispatchVerb(argvText);
    if (!dispatch && !opaque) continue;
    scanned += 1;
    if (dispatch && hasDryRun(argvText)) continue;
    const lost = isEnvLost(span);
    const execVerb = hasLit(argvText, 'dispatch-exec') || /dispatch-exec/.test(argvText);
    violations.push({
      kind: lost ? 'env-lost' : 'live-dispatch',
      why: lost
        ? '执行体 env 丢失：spawn dispatch 的 env 没继承 process.env、也没带隔离信号，子进程会读真账本真派工'
        : opaque && !dispatch
          ? '无法可靠解析的 child_process 计算属性调用：fail-closed，不许 scanned:0 静默放行'
          : execVerb
            ? '真 spawn dao dispatch-exec 且无 --dry-run：测试结构性够得着真执行体'
            : '真 spawn dao dispatch 且无 --dry-run：测试结构性够得着真执行体',
      excerpt: span.replace(/\s+/g, ' ').slice(0, 240),
    });
  }
  return { ok: violations.length === 0, unscanned: false, scanned, violations };
}

function sliceFn(src, startMark, endMark) {
  const a = String(src || '').indexOf(startMark);
  if (a < 0) return '';
  const b = String(src || '').indexOf(endMark, a + startMark.length);
  return b < 0 ? src.slice(a) : src.slice(a, b);
}

/**
 * 生产接线：隔离判官必须在真 IO 之前。
 * 不 import mirasim-runtime——自己切函数块、自己数调用。
 */
export function inspectIsolationWiring({ runtimeSrc, daoSrc } = {}) {
  if (runtimeSrc == null && daoSrc == null) {
    return { ok: false, unscanned: true, error: '没给 runtime/dao 正文（没查成）', problems: [] };
  }
  const problems = [];
  if (runtimeSrc == null) problems.push('没给 mirasim-runtime.mjs 正文（没查成函数块）');
  else {
    if (!/export function judgeTestExecutorIsolation\(/.test(runtimeSrc)) {
      problems.push('mirasim-runtime 缺导出 judgeTestExecutorIsolation');
    }
    if (!/DAO_DISPATCH_NO_SPAWN/.test(runtimeSrc)) {
      problems.push('隔离判官没读 DAO_DISPATCH_NO_SPAWN（测试设了它等于没设）');
    }
    if (!/NODE_TEST_CONTEXT/.test(runtimeSrc)) {
      problems.push('隔离判官没读 NODE_TEST_CONTEXT');
    }
    const ensure = sliceFn(runtimeSrc, 'async function ensureWorkspace(', 'async function startSession(');
    const start = sliceFn(runtimeSrc, 'async function startSession(', 'async function readSession(');
    if (!ensure) problems.push('找不到 ensureWorkspace（没查成函数块）');
    else {
      const iso = ensure.indexOf('judgeTestExecutorIsolation(');
      const open = ensure.indexOf('await open()');
      if (iso < 0) problems.push('ensureWorkspace 没过隔离闸');
      else if (open >= 0 && iso > open) problems.push('ensureWorkspace 隔离闸必须在 open() 前');
    }
    if (!start) problems.push('找不到 startSession（没查成函数块）');
    else {
      const iso = start.indexOf('judgeTestExecutorIsolation(');
      const open = start.indexOf('await open()');
      if (iso < 0) problems.push('startSession 没过隔离闸');
      else if (open >= 0 && iso > open) problems.push('startSession 隔离闸必须在 open() 前');
    }
  }
  if (daoSrc == null) problems.push('没给 dao.mjs 正文（没查成函数块）');
  else {
    const mira = sliceFn(daoSrc, 'async function cmdDispatchMirasim(', 'async function cmdDispatch(');
    if (!mira) problems.push('找不到 cmdDispatchMirasim（没查成函数块）');
    else {
      const iso = mira.indexOf('judgeTestExecutorIsolation(');
      const ens = mira.indexOf('ensureWorkspace(');
      if (iso < 0) problems.push('cmdDispatchMirasim 没过隔离闸');
      else if (ens < 0) problems.push('cmdDispatchMirasim 找不到 ensureWorkspace');
      else if (iso > ens) problems.push('cmdDispatchMirasim 隔离闸必须在 ensureWorkspace 前');
    }
  }
  return { ok: problems.length === 0, unscanned: false, problems };
}

function listKindFiles(dir) {
  try { return readdirSync(dir).filter((f) => !f.startsWith('.')); }
  catch { return []; }
}

export function inspectTestExecutorIsolationFixtures(root) {
  if (!root) return { ok: false, unscanned: true, error: '没给样本根目录' };
  if (!existsSync(root)) return { ok: false, unscanned: true, error: `样本目录不在：${root}` };
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];

  for (const kind of ['red', 'ok', 'empty']) {
    const dir = join(root, kind);
    if (!existsSync(dir)) {
      problems.push(`缺 ${kind}/`);
      continue;
    }
    const names = listKindFiles(dir);
    const executable = names.filter((f) => JS_FILE.test(f) || EXECUTABLE_TEST.test(f));
    if (executable.length) {
      problems.push(`${kind}/ 有可执行 JS ${executable.join('、')}：故意样本必须是 .txt / .fixture（node --test 显式路径也会跑 *.js）`);
      continue;
    }
    if (kind === 'empty') {
      const r = classifyTestDispatchSpawns(null);
      if (!r.unscanned) problems.push('empty 没标没查成');
      else kinds.empty += 1;
      continue;
    }
    const files = names.filter((f) => FIXTURE_FILE.test(f));
    if (files.length === 0) {
      problems.push(`${kind}: 0 个样本——没查成`);
      continue;
    }
    if (kind === 'red') {
      let envLost = false;
      let dryRunNotInArgv = false;
      let computedSpawn = false;
      let concatVerb = false;
      let aliasChain = false;
      for (const f of files) {
        const src = readFileSync(join(dir, f), 'utf8');
        const r = classifyTestDispatchSpawns(src);
        if (r.unscanned || r.ok || r.scanned === 0) {
          problems.push(`red/${f} 自称该红但没抓到真 dispatch spawn（scanned=${r.scanned}）`);
        }
        if ((r.violations || []).some((v) => v.kind === 'env-lost')) envLost = true;
        if (hasLit(src, '--dry-run') && r.scanned > 0 && !r.ok) dryRunNotInArgv = true;
        if (src.includes('["' + 'spawnSync' + '"]') && r.scanned > 0 && !r.ok) computedSpawn = true;
        if (/"dis"\s*\+\s*"patch"/.test(src) && r.scanned > 0 && !r.ok) concatVerb = true;
        if (
          /(?:const|let|var)\s+[A-Za-z_][\w]*\s*=\s*[A-Za-z_][\w]*\s*;/.test(src)
          && r.scanned > 0 && !r.ok
        ) aliasChain = true;
      }
      if (!envLost) problems.push('red/ 没点出执行体 env 丢失');
      if (!dryRunNotInArgv) problems.push('red/ 没点出非 argv 的 --dry-run（input/env 冒充放行）');
      if (!computedSpawn) problems.push('red/ 没点出计算属性 child_process 调用');
      if (!concatVerb) problems.push('red/ 没点出拼接动词 dis+patch');
      if (!aliasChain) problems.push('red/ 没点出别名再赋值（run → actual）');
      if (!problems.some((p) => p.startsWith('red/'))) kinds.red += 1;
    }
    if (kind === 'ok') {
      for (const f of files) {
        const r = classifyTestDispatchSpawns(readFileSync(join(dir, f), 'utf8'));
        if (r.unscanned) problems.push(`ok/${f} 没查成`);
        else if (!r.ok) problems.push(`ok/${f} 自称该绿但扫到：${r.violations.map((v) => v.why).join('；')}`);
      }
      if (!problems.some((p) => p.startsWith('ok/'))) kinds.ok += 1;
    }
  }

  if (kinds.red === 0 || kinds.ok === 0 || kinds.empty === 0) {
    return {
      ok: false,
      unscanned: true,
      error: problems.length
        ? problems.join('；')
        : `样本种类不够 red=${kinds.red} ok=${kinds.ok} empty=${kinds.empty}`,
      kinds,
      problems,
    };
  }
  if (problems.length) {
    return { ok: false, unscanned: false, error: problems.join('；'), kinds, problems };
  }
  return { ok: true, unscanned: false, kinds, problems };
}

export function inspectTestExecutorIsolationLive({ dir, readdir, readFile, join: joinFn = join } = {}) {
  if (!dir) return { ok: false, unscanned: true, error: '没给 tests 目录（没查成）', violations: [] };
  if (typeof readdir !== 'function' || typeof readFile !== 'function') {
    return { ok: false, unscanned: true, error: '没给 readdir/readFile 探头（没查成）', violations: [] };
  }
  let names;
  try { names = readdir(dir); }
  catch (e) {
    return { ok: false, unscanned: true, error: `tests 目录读不了：${e && e.message ? e.message : e}`, violations: [] };
  }
  const files = (names || []).filter((f) => EXECUTABLE_TEST.test(f));
  if (files.length === 0) {
    return { ok: false, unscanned: true, error: '扫到 0 个测试文件（没查成，不是没有真派工）', violations: [] };
  }
  const violations = [];
  let scanned = 0;
  for (const f of files) {
    let src;
    try { src = readFile(joinFn(dir, f)); }
    catch (e) {
      return { ok: false, unscanned: true, error: `读 ${f} 失败：${e && e.message ? e.message : e}`, violations };
    }
    const r = classifyTestDispatchSpawns(src);
    scanned += 1;
    for (const v of r.violations) violations.push({ file: f, ...v });
  }
  return { ok: violations.length === 0, unscanned: false, scanned, violations };
}
