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
//      argv 变量（含 let argv; argv = [...] 赋值，不限声明初始化）、模板动词、
//      exec 命令字符串、dispatch-exec、计算属性 cp["spawnSync"]、拼接动词 "dis"+"patch"。
//      别名解析收到固定点，一层赋值再转一层不许 scanned:0。
//      --dry-run 只认解析后的子进程 argv（input / env 字段里的字面量不算）。
//      解析不了的 child_process 计算属性调用 fail-closed——不许 scanned:0 静默放行。
//      未知计算属性结果经别名转发仍保留不透明标记（const run = cp[unknownKey]; run(...)）。
//      argv 变量解析不了且调用像在跑 node/dao → 保守判红，不许留下变量名当 scanned:0。
//      argv 是函数调用 / 未知 spread / 数组里的动态表达式：Node/dao 候选无法证明安全 → fail-closed。
//      argv 只认调用前最后一次赋值：调用后才补 --dry-run 不许拼进来误放行。
//      process.execPath 的命令别名要跟（const nodePath = process.execPath; spawn(nodePath, argv)）。
//      node 绝对/相对路径（/usr/bin/node、node.exe）也是 JS 执行体，不许当 git 放过。
//      对象字面量 / 成员赋值上的 child_process 别名（{ run: cp.spawnSync }; box.run(...)）要跟。
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
 * 未知 child_process 计算属性（`const run = cp[unknownKey]`）也收成别名，并标不透明。
 * 对象字面量 / 成员赋值（`{ run: cp.spawnSync }` / `box.run = cp.spawnSync`）也收成别名，
 * 并把承载对象记成 holder，`box.run(...)` 不许 scanned:0。
 */
export function collectSpawnAliases(src) {
  return [...collectSpawnAliasSets(src).names];
}

function eachObjectSpawnProp(text, fns, onMatch) {
  const re = new RegExp(
    String.raw`\b([A-Za-z_][\w]*)\s*:\s*(?:[A-Za-z_][\w]*\s*\.\s*)?(?:${fns})\s*(?![(\w])`,
    'g',
  );
  let m;
  while ((m = re.exec(text))) onMatch(m[1]);
}

function collectSpawnAliasSets(src) {
  const names = new Set(SPAWN_FNS);
  const opaque = new Set();
  const holders = new Set();
  const text = String(src || '');
  const cpNames = collectChildProcessReceivers(text);
  const addOpaque = (id) => {
    if (!id) return;
    names.add(id);
    opaque.add(id);
  };
  for (let n = 0; n < 32; n++) {
    const before = names.size + opaque.size + holders.size;
    const fns = [...names].map(escapeIdent).join('|');
    const dest = new RegExp(String.raw`(?<!-)\b(?:${fns})\s*:\s*([A-Za-z_][\w]*)\s*[,}]`, 'g');
    let m;
    while ((m = dest.exec(text))) names.add(m[1]);
    const imp = new RegExp(String.raw`(?<!-)\b(?:${fns})\s+as\s+([A-Za-z_][\w]*)\b`, 'g');
    while ((m = imp.exec(text))) names.add(m[1]);
    const asg = new RegExp(
      String.raw`\b(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*[^\n;]*(?<!-)\b(?:${fns})\s*(?![(\w])`,
      'g',
    );
    while ((m = asg.exec(text))) names.add(m[1]);
    const bare = new RegExp(
      String.raw`(?:^|[;\n])\s*([A-Za-z_][\w]*)\s*=\s*[^\n;]*(?<!-)\b(?:${fns})\s*(?![(\w])`,
      'g',
    );
    while ((m = bare.exec(text))) names.add(m[1]);
    eachObjectSpawnProp(text, fns, (id) => names.add(id));
    const asgObj = /\b(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*\{/g;
    while ((m = asgObj.exec(text))) {
      const openIdx = text.indexOf('{', m.index + m[0].length - 1);
      if (openIdx < 0) continue;
      const end = matchBalanced(text, openIdx);
      if (end < 0) continue;
      let has = false;
      eachObjectSpawnProp(text.slice(openIdx, end + 1), fns, () => { has = true; });
      if (has) holders.add(m[1]);
    }
    const mem = new RegExp(
      String.raw`\b([A-Za-z_][\w]*)\s*\.\s*([A-Za-z_][\w]*)\s*=\s*(?:[A-Za-z_][\w]*\s*\.\s*)?(?:${fns})\s*(?![(\w])`,
      'g',
    );
    while ((m = mem.exec(text))) {
      holders.add(m[1]);
      names.add(m[2]);
    }
    if (holders.size) {
      const hs = [...holders].map(escapeIdent).join('|');
      const asgH = new RegExp(
        String.raw`\b(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*(?:${hs})\s*(?![(\w.])`,
        'g',
      );
      while ((m = asgH.exec(text))) holders.add(m[1]);
      const bareH = new RegExp(
        String.raw`(?:^|[;\n])\s*([A-Za-z_][\w]*)\s*=\s*(?:${hs})\s*(?![(\w.])`,
        'g',
      );
      while ((m = bareH.exec(text))) holders.add(m[1]);
    }
    scanComputedAliases(text, cpNames, (id, info) => {
      if (isSpawnName(info.resolved, [...names])) names.add(id);
      else if (info.opaque) addOpaque(id);
    });
    if (opaque.size) {
      const op = [...opaque].map(escapeIdent).join('|');
      const asgOp = new RegExp(
        String.raw`\b(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*(?:${op})\s*(?![(\w])`,
        'g',
      );
      while ((m = asgOp.exec(text))) addOpaque(m[1]);
      const bareOp = new RegExp(
        String.raw`(?:^|[;\n])\s*([A-Za-z_][\w]*)\s*=\s*(?:${op})\s*(?![(\w])`,
        'g',
      );
      while ((m = bareOp.exec(text))) addOpaque(m[1]);
    }
    if (names.size + opaque.size + holders.size === before) break;
  }
  return { names, opaque, holders };
}

/** `const run = cp[unknownKey]`：赋值不是调用。解析不了的 key 标不透明。 */
function scanComputedAliases(text, cpNames, onAlias) {
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
    if (/^\s*\(/.test(text.slice(keyEnd + 1))) continue;
    const recv = receiverBefore(text, i, cpNames);
    if (!recv.isCp) continue;
    const before = text.slice(0, recv.start);
    const am = before.match(/([A-Za-z_][\w]*)\s*=\s*$/);
    if (!am) continue;
    const { resolved, opaque } = resolveComputedKey(text, text.slice(i + 1, keyEnd));
    onAlias(am[1], { resolved, opaque });
    i = keyEnd;
  }
}

function calleeName(span) {
  const open = String(span || '').indexOf('(');
  if (open < 0) return '';
  const before = span.slice(0, open).trim();
  const whole = before.match(/^([A-Za-z_][\w]*)$/);
  if (whole) return whole[1];
  const m = before.match(/[^.\w]([A-Za-z_][\w]*)$/);
  return m ? m[1] : '';
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
    onSpan(text.slice(recv.start, callEnd + 1), recv.start);
    i = callEnd;
  }
}

export function extractCallSpans(src, names) {
  const holders = collectSpawnAliasSets(src).holders;
  return extractCallSites(src, names, holders).map((s) => s.span);
}

function extractCallSites(src, names, holders) {
  const text = String(src || '');
  const list = (Array.isArray(names) ? names : [names]).map(String).filter(Boolean);
  const alts = list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const sites = [];
  const seen = new Set();
  const push = (span, index) => {
    if (!span) return;
    const key = `${index}:${span}`;
    if (seen.has(key)) return;
    seen.add(key);
    sites.push({ span, index });
  };
  const cpNames = collectChildProcessReceivers(text);
  for (const h of holders || []) cpNames.add(h);
  if (alts.length) {
    const re = new RegExp(String.raw`\b(?:${alts.join('|')})\s*\(`, 'g');
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      if (/\bfunction\s+$/.test(before)) continue;
      if (/\.\s*$/.test(before)) {
        const window = text.slice(Math.max(0, m.index - 96), m.index);
        const req = /require\s*\(\s*['"](?:node:)?child_process['"]\s*\)\s*\.\s*$/.test(window);
        const recv = window.match(/([A-Za-z_][\w]*)\s*\.\s*$/);
        if (!req && !(recv && cpNames.has(recv[1]))) continue;
      }
      const openIdx = text.indexOf('(', m.index);
      if (openIdx < 0) continue;
      const end = matchBalanced(text, openIdx);
      if (end < 0) continue;
      push(text.slice(m.index, end + 1), m.index);
    }
  }
  const spawnNames = new Set([...list, ...SPAWN_FNS]);
  scanComputedCalls(text, spawnNames, cpNames, push);
  return sites;
}

function scanRhsEnd(text, start) {
  let depthParen = 0;
  let depthBrack = 0;
  let depthBrace = 0;
  let inStr = null;
  let esc = false;
  const src = String(text || '');
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(') depthParen++;
    else if (c === ')') { if (depthParen) depthParen--; }
    else if (c === '[') depthBrack++;
    else if (c === ']') { if (depthBrack) depthBrack--; }
    else if (c === '{') depthBrace++;
    else if (c === '}') { if (depthBrace) depthBrace--; }
    else if (depthParen === 0 && depthBrack === 0 && depthBrace === 0) {
      if (c === ';' || c === '\n') return i;
    }
  }
  return src.length;
}

/** 调用前最后一次 `name = rhs`。赋值必须在 beforeIdx 前结束。 */
function findLastAssignment(src, name, beforeIdx = Infinity) {
  const text = String(src || '');
  const re = new RegExp(String.raw`(?:^|[^\w.])${escapeIdent(name)}\s*=(?![=>])\s*`, 'g');
  let last = null;
  let m;
  while ((m = re.exec(text))) {
    const rhsStart = m.index + m[0].length;
    if (rhsStart >= beforeIdx) continue;
    const rhsEnd = scanRhsEnd(text, rhsStart);
    if (rhsEnd < 0 || rhsEnd > beforeIdx) continue;
    last = { rhs: text.slice(rhsStart, rhsEnd).trim(), start: m.index, end: rhsEnd };
  }
  return last;
}

function findArrayLiteral(src, name, beforeIdx = Infinity) {
  const asg = findLastAssignment(src, name, beforeIdx);
  if (!asg) return '';
  const rhs = asg.rhs.trim();
  if (!rhs.startsWith('[')) return '';
  const end = matchBalanced(rhs, 0);
  if (end < 0) return '';
  return rhs.slice(0, end + 1);
}

function findStringLiteral(src, name, beforeIdx = Infinity) {
  const asg = findLastAssignment(src, name, beforeIdx);
  if (!asg) return '';
  const folded = foldStringConcat(asg.rhs);
  const t = folded.trim();
  if (!t) return '';
  if (t[0] !== '"' && t[0] !== "'" && t[0] !== '`') return '';
  return folded;
}

/** /usr/bin/node、./node、node.exe 都是 Node 可执行文件。 */
function isNodeExecutableName(v) {
  const s = String(v || '').trim().replace(/\\/g, '/');
  if (!s) return false;
  const parts = s.split('/').filter(Boolean);
  const base = parts.length ? parts[parts.length - 1] : s;
  const name = base.replace(/\.exe$/i, '');
  return name === 'node' || name === 'nodejs';
}

/** process.execPath / node / *.js 才可能跑 dao；git 等字面量命令不当 dispatch 候选。 */
function isJsRunnerCommand(src, cmd, beforeIdx = Infinity, seen = new Set()) {
  const t = String(cmd || '').trim();
  if (!t) return true;
  if (/\bprocess\.execPath\b/.test(t)) return true;
  if (/^process\s*\[\s*(['"`])execPath\1\s*\]$/.test(t)) return true;
  if (/^[A-Za-z_][\w]*$/.test(t)) {
    if (seen.has(t)) return true;
    seen.add(t);
    const asg = findLastAssignment(src, t, beforeIdx);
    if (asg) return isJsRunnerCommand(src, asg.rhs, asg.start, seen);
    const str = findStringLiteral(src, t, beforeIdx);
    if (str) return isJsRunnerCommand(src, str, beforeIdx, seen);
    return false;
  }
  const folded = foldStringConcat(t);
  if (hasLit(folded, 'node') || hasLit(folded, 'nodejs')) return true;
  const lit = folded.match(/^(['"`])([^'"`]*)\1$/);
  if (lit) {
    const v = lit[2];
    if (v === 'node' || v === 'nodejs') return true;
    if (isNodeExecutableName(v)) return true;
    if (/\.(?:m?js|cjs)$/.test(v)) return true;
    return false;
  }
  if (/\.(?:m?js|cjs)\b/.test(folded)) return true;
  return true;
}

function collectStringLits(text) {
  const out = [];
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const lit = readStringLit(s, i);
    if (!lit) continue;
    if (s[i] === '`' && lit.body.includes('${')) {
      i = lit.end - 1;
      continue;
    }
    out.push(lit.body);
    i = lit.end - 1;
  }
  return out;
}

function isDaoMjs(s) {
  const v = String(s || '').replace(/\\/g, '/');
  return /(?:^|\/)dao\.mjs$/.test(v);
}

function isPathBuilderCall(t) {
  return /^(?:path\s*\.\s*)?(?:join|resolve)\s*\(/.test(String(t || '').trim());
}

function flattenArgvSlots(src, expr, beforeIdx, depth = 0) {
  if (depth > 8) return [{ kind: 'unknown' }];
  const t = String(expr || '').trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    const end = matchBalanced(t, 0);
    if (end < 0) return [{ kind: 'unknown' }];
    const inner = t.slice(1, end);
    const rest = t.slice(end + 1).trim();
    const slots = [];
    for (const raw of splitTopLevelArgs(inner)) {
      const piece = raw.trim();
      if (!piece) continue;
      slots.push(...flattenArgvSlots(src, piece, beforeIdx, depth + 1));
    }
    if (rest) slots.push({ kind: 'unknown' });
    return slots;
  }
  const sp = t.match(/^\.\.\.\s*([\s\S]*)$/);
  if (sp) {
    const inner = sp[1].trim();
    const arr = /^[A-Za-z_][\w]*$/.test(inner) ? findArrayLiteral(src, inner, beforeIdx) : '';
    if (arr) return flattenArgvSlots(src, arr, beforeIdx, depth + 1);
    return [{ kind: 'unknown' }];
  }
  const folded = foldStringConcat(t).trim();
  const lit = folded.match(/^(['"`])([\s\S]*)\1$/);
  if (lit && !(lit[1] === '`' && lit[2].includes('${'))) {
    return [{ kind: 'lit', value: lit[2] }];
  }
  if (/^[A-Za-z_][\w]*$/.test(t)) {
    const arr = findArrayLiteral(src, t, beforeIdx);
    if (arr) return flattenArgvSlots(src, arr, beforeIdx, depth + 1);
    const str = findStringLiteral(src, t, beforeIdx);
    if (str) return flattenArgvSlots(src, str, beforeIdx, depth + 1);
    const asg = findLastAssignment(src, t, beforeIdx);
    if (asg) return flattenArgvSlots(src, asg.rhs, asg.start, depth + 1);
    return [{ kind: 'unknown' }];
  }
  if (isPathBuilderCall(t)) return [{ kind: 'path', strings: collectStringLits(t) }];
  return [{ kind: 'unknown' }];
}

function slotIsDaoScript(slot) {
  if (!slot) return false;
  if (slot.kind === 'lit') return isDaoMjs(slot.value);
  if (slot.kind === 'path') return (slot.strings || []).some(isDaoMjs);
  return false;
}

function isCallExpr(t) {
  const s = String(t || '').trim();
  if (!s || s.startsWith('[') || s.startsWith('{')) return false;
  if (s.includes('?') && s.includes(':')) return false;
  if (isPathBuilderCall(s)) return false;
  return /^[A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_][\w]*)*\s*\(/.test(s) && /\)$/.test(s);
}

function isUnknownSpreadArray(t) {
  return /^\[[\s]*\.\.\.\s*[A-Za-z_][\w]*\s*\]/.test(String(t || '').trim());
}

function slotIsNonDaoScript(slot) {
  if (!slot) return false;
  if (slot.kind === 'lit') {
    const v = String(slot.value || '').replace(/\\/g, '/');
    if (isDaoMjs(v)) return false;
    if (/\.(?:m?js|cjs)$/.test(v)) return true;
    if (/^-/.test(v)) return true;
    return false;
  }
  if (slot.kind === 'path') {
    const js = (slot.strings || []).filter((s) => /\.(?:m?js|cjs)$/.test(s) || isDaoMjs(s));
    if (js.some(isDaoMjs)) return false;
    return js.length > 0;
  }
  return false;
}

function slotIsDispatchVerb(slot) {
  if (!slot || slot.kind !== 'lit') return false;
  return slot.value === 'dispatch' || slot.value === 'dispatch-exec';
}

function slotIsKnownOtherVerb(slot) {
  if (!slot || slot.kind !== 'lit') return false;
  if (slotIsDispatchVerb(slot)) return false;
  if (/^-/.test(slot.value)) return false;
  return true;
}

/** Node/dao 候选的 argv 无法证明不是「dao dispatch 且无 --dry-run」→ fail-closed。 */
function daoArgvUnproven(src, expr, beforeIdx) {
  const t = String(expr || '').trim();
  if (!t) return true;
  if (isCallExpr(t)) return true;
  const slots = flattenArgvSlots(src, expr, beforeIdx);
  if (slots.some((s) => s.kind === 'lit' && s.value === '--dry-run')) return false;
  if (slotIsNonDaoScript(slots[0])) return false;
  const rest = slots.slice(1);
  const verb = rest.find((s) => s.kind === 'lit' && !/^-/.test(s.value)) || rest[0];
  if (slotIsKnownOtherVerb(verb)) return false;
  if (slotIsDispatchVerb(verb)) return false;
  if (slotIsDaoScript(slots[0]) && slots.some((s) => s.kind === 'unknown')) return true;
  if (isUnknownSpreadArray(t)) return true;
  return false;
}

function expandArgvSpreads(src, span, beforeIdx) {
  let out = span;
  for (const m of span.matchAll(/\.\.\.\s*([A-Za-z_][\w]*)/g)) {
    if (m[1] === 'process' || m[1] === 'env') continue;
    const lit = findArrayLiteral(src, m[1], beforeIdx);
    if (lit) out += `\n${lit}`;
  }
  return out;
}

/** 子进程 argv / exec 命令字符串，不含 options 对象。--dry-run 只在这里算数。 */
function argvTextForCall(src, span, callIndex = Infinity) {
  const open = span.indexOf('(');
  if (open < 0) return { text: '', unresolved: false };
  const close = matchBalanced(span, open);
  if (close < 0) return { text: '', unresolved: false };
  const args = splitTopLevelArgs(span.slice(open + 1, close));
  const pieces = [];
  let unresolved = false;
  let command = '';
  const argvExprs = [];
  const callee = calleeName(span);
  const execString = callee === 'exec' || callee === 'execSync';
  const addArray = (piece) => {
    const expanded = expandArgvSpreads(src, piece, callIndex);
    pieces.push(expanded);
    for (const idm of expanded.matchAll(/\b([A-Za-z_][\w]*)\b/g)) {
      const id = idm[1];
      if (SPAWN_FNS.includes(id) || id === 'process' || id === 'execPath') continue;
      const str = findStringLiteral(src, id, callIndex);
      const arr = findArrayLiteral(src, id, callIndex);
      if (str) pieces.push(str);
      if (arr) pieces.push(arr);
    }
  };
  for (const raw of args) {
    const t = raw.trim();
    if (!t || t.startsWith('{')) continue;
    if (/^(?:function\b|[A-Za-z_][\w]*\s*=>)/.test(t)) continue;
    if (!command) command = t;
    // spawn/execFile 的第一参是命令路径，不是 argv；exec 的第一参才是命令字符串。
    const treatingAsCommand = !execString && t === command;
    if (!treatingAsCommand) argvExprs.push(t);
    if (t.startsWith('[')) { addArray(t); continue; }
    if (/^[A-Za-z_][\w]*$/.test(t)) {
      const arr = findArrayLiteral(src, t, callIndex);
      const str = findStringLiteral(src, t, callIndex);
      if (arr) addArray(arr);
      if (str) pieces.push(str);
      if (!arr && !str) {
        pieces.push(t);
        if (!treatingAsCommand && isJsRunnerCommand(src, command, callIndex)) unresolved = true;
      }
      continue;
    }
    pieces.push(t);
  }
  if (isJsRunnerCommand(src, command, callIndex)) {
    for (const expr of argvExprs) {
      if (daoArgvUnproven(src, expr, callIndex)) unresolved = true;
    }
  }
  return { text: pieces.join('\n'), unresolved };
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
  const { names, opaque: opaqueAliases, holders } = collectSpawnAliasSets(text);
  const nameList = [...names];
  const sites = extractCallSites(text, nameList, holders);
  const violations = [];
  let scanned = 0;
  for (const { span, index } of sites) {
    const argvInfo = argvTextForCall(text, span, index);
    const argvText = foldStringConcat(argvInfo.text);
    const opaque = isOpaqueComputedSpan(span, nameList, text)
      || opaqueAliases.has(calleeName(span));
    const unresolvedArgv = argvInfo.unresolved;
    const dispatch = hasDispatchVerb(argvText);
    if (!dispatch && !opaque && !unresolvedArgv) continue;
    scanned += 1;
    if (dispatch && hasDryRun(argvText) && !unresolvedArgv) continue;
    const lost = isEnvLost(span);
    const execVerb = hasLit(argvText, 'dispatch-exec') || /dispatch-exec/.test(argvText);
    violations.push({
      kind: lost ? 'env-lost' : 'live-dispatch',
      why: unresolvedArgv && !dispatch
        ? '无法解析的 argv 变量：fail-closed，不许 scanned:0 静默放行'
        : lost
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

/** 调用前 argv 无 --dry-run，调用后同名变量才补上。拼全部赋值会误放行。 */
function fixtureHasArgvMutatedAfterCall(src) {
  const text = String(src || '');
  const spawnAt = text.search(/\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(/);
  if (spawnAt < 0) return false;
  const before = text.slice(0, spawnAt);
  const after = text.slice(spawnAt);
  const assignRe = /(?:^|[^\w.])([A-Za-z_][\w]*)\s*=\s*\[/g;
  const beforeNames = new Map();
  let m;
  while ((m = assignRe.exec(before))) {
    const openIdx = before.indexOf('[', m.index + m[0].length - 1);
    if (openIdx < 0) continue;
    const end = matchBalanced(before, openIdx);
    if (end < 0) continue;
    beforeNames.set(m[1], before.slice(openIdx, end + 1));
  }
  assignRe.lastIndex = 0;
  while ((m = assignRe.exec(after))) {
    const name = m[1];
    if (!beforeNames.has(name)) continue;
    const openIdx = after.indexOf('[', m.index + m[0].length - 1);
    if (openIdx < 0) continue;
    const end = matchBalanced(after, openIdx);
    if (end < 0) continue;
    const later = after.slice(openIdx, end + 1);
    if (!hasLit(beforeNames.get(name), '--dry-run') && hasLit(later, '--dry-run')) return true;
  }
  return false;
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
      let assignedArgv = false;
      let unresolvedArgv = false;
      let opaqueAlias = false;
      let laterArgvDryRun = false;
      let execPathAlias = false;
      let argvCall = false;
      let unknownSpread = false;
      let dynamicArgvElem = false;
      let absNodePath = false;
      let objPropAlias = false;
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
        if (
          /(?:const|let|var)\s+[A-Za-z_][\w]*\s*;/.test(src)
          && /[A-Za-z_][\w]*\s*=\s*\[/.test(src)
          && r.scanned > 0 && !r.ok
        ) assignedArgv = true;
        if ((r.violations || []).some((v) => /无法解析的 argv/.test(v.why))) unresolvedArgv = true;
        if (
          /(?:const|let|var)\s+[A-Za-z_][\w]*\s*=\s*[A-Za-z_][\w]*\s*\[/.test(src)
          && r.scanned > 0 && !r.ok
        ) opaqueAlias = true;
        if (fixtureHasArgvMutatedAfterCall(src) && r.scanned > 0 && !r.ok) laterArgvDryRun = true;
        if (
          /[A-Za-z_][\w]*\s*=\s*process\.execPath/.test(src)
          && r.scanned > 0 && !r.ok
        ) execPathAlias = true;
        if (
          /execPath\s*,\s*[A-Za-z_][\w]*\s*\(/.test(src)
          && r.scanned > 0 && !r.ok
        ) argvCall = true;
        if (
          /\[\s*\.\.\.\s*[A-Za-z_][\w]*\s*\]/.test(src)
          && r.scanned > 0 && !r.ok
        ) unknownSpread = true;
        if (
          /\[[^\]]*[A-Za-z_][\w]*\s*\(/.test(src)
          && r.scanned > 0 && !r.ok
        ) dynamicArgvElem = true;
        if (
          /(?:\/usr\/bin\/node|node\.exe)/.test(src)
          && r.scanned > 0 && !r.ok
        ) absNodePath = true;
        if (
          /\{\s*[A-Za-z_][\w]*\s*:\s*[A-Za-z_][\w]*\s*\.\s*spawnSync/.test(src)
          && r.scanned > 0 && !r.ok
        ) objPropAlias = true;
      }
      if (!envLost) problems.push('red/ 没点出执行体 env 丢失');
      if (!dryRunNotInArgv) problems.push('red/ 没点出非 argv 的 --dry-run（input/env 冒充放行）');
      if (!computedSpawn) problems.push('red/ 没点出计算属性 child_process 调用');
      if (!concatVerb) problems.push('red/ 没点出拼接动词 dis+patch');
      if (!aliasChain) problems.push('red/ 没点出别名再赋值（run → actual）');
      if (!assignedArgv) problems.push('red/ 没点出 argv 先声明再赋值');
      if (!unresolvedArgv) problems.push('red/ 没点出解析不了的 argv 变量');
      if (!opaqueAlias) problems.push('red/ 没点出计算属性别名转发');
      if (!laterArgvDryRun) problems.push('red/ 没点出调用后才赋 --dry-run 的 argv');
      if (!execPathAlias) problems.push('red/ 没点出 process.execPath 命令别名');
      if (!argvCall) problems.push('red/ 没点出 argv 函数调用（makeArgv()）');
      if (!unknownSpread) problems.push('red/ 没点出未知 spread argv');
      if (!dynamicArgvElem) problems.push('red/ 没点出数组里的动态 argv 表达式');
      if (!absNodePath) problems.push('red/ 没点出 node 绝对路径');
      if (!objPropAlias) problems.push('red/ 没点出对象属性转发的 child_process 别名');
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
