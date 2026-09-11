// tests/commander-toplevel-refs.test.js —— commander.mjs 里引用的名字必须真有来源
//
// 起因（2026-09-11，一晚撞两次，都让 act 整个 exit 1）：
//   · `execClearExhausted` 里用了 `run(...)`，而本文件只有 `runCmd` / `runGh`
//   · 推进量仪表里用了 `policy`，那是 buildSituation 内部的局部变量，cmdAct 里没有
// 两次都是 ReferenceError，**只在运行时炸**，而测试全绿（测试只跑纯函数，不跑 cmdAct）。
// 它炸的是整轮 act——扫、判、其余动作全没跑成，报错只在 journal 里。
//
// 这道闸是静态的：把每个函数体里「裸名字当函数调用」的形状抽出来，
// 对着「模块级声明 + import + 作用域内声明 + 参数」查。查不到就红。
//
// 刻意**选窄**：只认「名字后紧跟 (」且不在属性位置（`.foo(`）的调用。
// 误报的闸最后一定被关掉（仓规），宁可漏报不误报。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'scripts', 'commander.mjs'), 'utf8');

/**
 * 把字符串 / 模板串 / 正则 / 行注释 / 块注释**遮成等长空格**，
 * 这样花括号配平和标识符抽取都不会被骗到。
 * （第一版没做这件事，结果后面的函数全继承了别人的函数体，还报出 Int32Array 这种误报。）
 */
function maskNonCode(src) {
  const out = [...src];
  let i = 0;
  const n = src.length;
  const blank = (from, to) => { for (let k = from; k < to && k < n; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') { const j = src.indexOf('\n', i); blank(i, j < 0 ? n : j); i = j < 0 ? n : j; continue; }
    if (c === '/' && c2 === '*') { const j = src.indexOf('*/', i + 2); blank(i, j < 0 ? n : j + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && !(src[j] === c && src[j - 1] !== '\\')) j += 1;
      blank(i + 1, j); i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n && !(src[j] === '`' && src[j - 1] !== '\\')) j += 1;
      // 模板串里的 ${...} 是真代码，但抽调用名时连它一起遮掉也无妨（宁可漏报）
      blank(i + 1, j); i = j + 1; continue;
    }
    i += 1;
  }
  return out.join('');
}

const MASKED = maskNonCode(SRC);

function moduleScopeNames(masked) {
  const names = new Set();
  for (const m of masked.matchAll(/^import\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.match(/^\S+\s+as\s+(\S+)$/);
      names.add(as ? as[1] : t);
    }
  }
  for (const m of masked.matchAll(/^import\s+(\w+)/gm)) names.add(m[1]);
  for (const m of masked.matchAll(/^(?:export\s+)?(?:const|let|var|function|class)\s+(\w+)/gm)) names.add(m[1]);
  return names;
}

const GLOBALS = new Set([
  'console', 'process', 'require', 'module', 'exports', 'globalThis', 'JSON', 'Math', 'Number',
  'String', 'Boolean', 'Array', 'Object', 'Set', 'Map', 'Date', 'Promise', 'Error', 'RegExp',
  'Buffer', 'URL', 'URLSearchParams', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'structuredClone', 'fetch', 'AbortController', 'Symbol', 'BigInt', 'WeakMap', 'WeakSet',
  'Int32Array', 'Uint8Array', 'Float64Array', 'ArrayBuffer', 'SharedArrayBuffer', 'atomicsWait',
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new',
  'super', 'this', 'constructor', 'get', 'set', 'do', 'else', 'case', 'delete', 'in', 'of',
  'void', 'yield', 'class', 'extends', 'import', 'export', 'default', 'try', 'finally', 'throw',
  'catch', 'with', 'instanceof',
]);

/** 顶层函数：名字 + 参数原文 + 花括号配平出来的函数体（已遮注释与字符串）。 */
function topLevelFunctions(masked) {
  const out = [];
  const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const name = m[1];
    const parenStart = masked.indexOf('(', m.index);
    let pd = 0;
    let pEnd = parenStart;
    for (; pEnd < masked.length; pEnd += 1) {
      if (masked[pEnd] === '(') pd += 1;
      else if (masked[pEnd] === ')') { pd -= 1; if (pd === 0) break; }
    }
    const paramsText = masked.slice(parenStart + 1, pEnd);
    const braceStart = masked.indexOf('{', pEnd);
    if (braceStart < 0) continue;
    let depth = 0;
    let i = braceStart;
    for (; i < masked.length; i += 1) {
      if (masked[i] === '{') depth += 1;
      else if (masked[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
    }
    out.push({ name, paramsText, body: masked.slice(braceStart, i) });
  }
  return out;
}

/** 参数表里声明的名字：按顶层逗号切开每一段，再逐段取（含解构）。
 *  不能用「第一个 { 到第一个 }」那种取法——`({a, b, run = f}, c)` 会漏掉后面的 c。 */
function paramNames(paramsText) {
  const names = new Set();
  const text = String(paramsText || '');
  // 按顶层逗号切段（避开括号/花括号内的逗号）
  const segs = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { segs.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) segs.push(cur);

  for (let seg of segs) {
    seg = seg.trim().replace(/^\.\.\./, '');
    if (!seg) continue;
    // 解构段：把所有 `名字[: 别名][= 默认]` 里的名字都收进来
    const collect = (s, sep) => {
      for (const d of s.split(sep)) {
        const t = d.trim();
        if (!t) continue;
        const k = t.split(/[:=]/)[0].trim().replace(/^\.\.\./, '');
        if (k && /^[a-zA-Z_$][\w$]*$/.test(k)) names.add(k);
      }
    };
    const obj = seg.match(/^\{([\s\S]*)\}/);
    if (obj) { collect(obj[1], ','); continue; }
    const arr = seg.match(/^\[([\s\S]*)\]/);
    if (arr) { collect(arr[1], ','); continue; }
    const k = seg.split(/[=:]/)[0].trim();
    if (k && /^[a-zA-Z_$][\w$]*$/.test(k)) names.add(k);
  }
  return names;
}

function localNames(body, paramsText) {
  const names = paramNames(paramsText);
  for (const m of body.matchAll(/(?:const|let|var|function|class)\s+(\w+)/g)) names.add(m[1]);
  for (const m of body.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const d of m[1].split(',')) {
      const k = d.trim().split(/[:=]/)[0].trim();
      if (k) names.add(k);
    }
  }
  return names;
}

describe('commander.mjs：裸名字必须有来源（防 ReferenceError 带走整轮）', () => {
  const MODULE = moduleScopeNames(MASKED);

  it('模块级名字表不是空的（否则这道闸自己失效）', () => {
    assert.ok(MODULE.size > 50, `只抽到 ${MODULE.size} 个模块级名字——抽取逻辑坏了`);
  });

  it('抽函数要抽到合理数量（配平坏了会静默变少）', () => {
    const fns = topLevelFunctions(MASKED);
    assert.ok(fns.length > 30, `只抽到 ${fns.length} 个顶层函数——花括号配平可能坏了`);
  });

  it('每个函数体里「裸名字当函数调用」的，都能在本文件或全局里找到', () => {
    const offenders = [];
    for (const { name, paramsText, body } of topLevelFunctions(MASKED)) {
      const locals = localNames(body, paramsText);
      for (const m of body.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
        const fn = m[1];
        if (GLOBALS.has(fn) || MODULE.has(fn) || locals.has(fn)) continue;
        offenders.push(`${name}() 里调用了 ${fn}( —— 本文件没有这个名字`);
      }
    }
    const uniq = [...new Set(offenders)];
    assert.deepEqual(uniq, [], `这些调用没有来源（ReferenceError 会在运行时炸掉整轮 act）：\n${uniq.join('\n')}`);
  });

  it('判别力：故意插一个不存在的调用，必须被抓到', () => {
    // 函数名与调用名都用 ASCII——抽取器只认 ASCII 标识符（故意这么选的：
    // 中文只出现在注释与字符串里，那些已经被遮掉了）。
    const withBug = `${MASKED}\nfunction injectedProbe() { return notARealName(1); }\n`;
    const fns = topLevelFunctions(withBug);
    const last = fns[fns.length - 1];
    assert.equal(last.name, 'injectedProbe', '没抽到植入的函数——抽取器坏了');
    const names = moduleScopeNames(withBug);
    const locals = localNames(last.body, last.paramsText);
    const hit = [...last.body.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)]
      .map((m) => m[1])
      .some((fn) => !GLOBALS.has(fn) && !names.has(fn) && !locals.has(fn));
    assert.equal(hit, true, '闸抓不到故意植入的违规——它没有判别力');
  });
});
