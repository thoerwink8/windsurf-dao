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
//      可选链（cp?.spawnSync / spawnSync?.(...)）、逗号间接调用（(0, spawnSync)(...)）、
//      计算属性键（{ ['run']: cp.spawnSync }）、展开 child_process（{ ...cp }; box.spawnSync(...)）、
//      解构 process.execPath（const { execPath: nodePath } = process）都要跟。
//      函数适配：.call / .apply / 立刻 .bind()() / Reflect.apply / Function.prototype.call.call；
//      计算属性/可选链同类（spawnSync["call"] / Reflect["apply"]）；解析不了的适配实参 fail-closed。
//      child_process 接收器：声明时 require/import、赋值 require、动态 import() / import().then；
//      跟踪 .default / .promises（含变量转发、解构 default、解构赋值
//      `({ default: cp } = await import(...))` / `({ default: cp } = mod)`；
//      解析不了的 default 绑定 fail-closed）。
//      process.execPath 别名覆盖赋值解构、默认值、字符串键、计算键；无法证明时
//      对 Node/dao 候选 fail-closed。
//      对象 holder 的属性键走 resolveComputedKey（含 `["r"+"un"]`），值走别名解析
//      （括号 RHS、计算属性 RHS）；解析不了的 child_process 属性转发保守判红。
//      argv 调用前的 push / 索引赋值要跟；跟丢或变更无法证明 → fail-closed。
//      带真实 --dry-run 的样本不误红。
//      数组解构覆盖声明、赋值、for-of（`for (const [run] of [[cp.exec]])`）。
//      exec 动态模板/未知命令：静态部分同时有 Node + dao.mjs 且不能证明 --dry-run → fail-closed。
//      别名必须保留 exec / execSync 的命令字符串语义（{ exec: run }; run(`…${getVerb()}`)
//      不许按 spawn 第一参路径解析后 scanned:0）。第一参本身含 Node + dao.mjs 且动态、
//      不能证明 --dry-run 也统一 fail-closed（不依赖调用名恰好是 exec）。
//      解构默认值（{ exec: run = fallback }）、计算键解构（{ ["exec"]: run }）、
//      字符串键（{ "exec": run }）、注释（{ exec /* comment */: run }）、
//      解构赋值（({ ["exec"]: run } = cp)）、数组解构（const [run] = [cp.exec]）、
//      数组别名链（const fn = cp.exec; const [run] = [fn]）、括号（[(cp.exec)]）、
//      数组赋值（([run] = [cp.exec])）产生的 child_process 别名要跟；跟丢 = scanned:0。
//      解析不了的 child_process 解构 fail-closed——不许 scanned:0 静默放行。
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
 * `{ spawnSync: require(...) }` 的 require 不当别名（后面是 '(' 不是 ',' / '}' / '='）。
 * 解构默认值 `{ exec: run = fallback }`、计算键 `{ ["exec"]: run }`、
 * 字符串键 `{ "exec": run }`、注释夹在 ident 与冒号之间、
 * 解构赋值 `({ ["exec"]: run } = cp)`、数组解构 `const [run] = [cp.exec]`、
 * 数组别名链 `[fn]`、括号 `[(cp.exec)]`、数组赋值 `([run] = [cp.exec])`
 * 都要收成别名（并保留 exec 命令字符串语义）。解析不了的 child_process 解构标不透明。
 * 别名会再赋一次（`const run = cp.spawnSync; const actual = run`），收到固定点。
 * 未知 child_process 计算属性（`const run = cp[unknownKey]`）也收成别名，并标不透明。
 * 对象字面量 / 成员赋值（`{ run: cp.spawnSync }` / `box.run = cp.spawnSync`）也收成别名，
 * 并把承载对象记成 holder，`box.run(...)` 不许 scanned:0。
 */
export function collectSpawnAliases(src) {
  return [...collectSpawnAliasSets(src).names];
}

function eachObjectSpawnProp(text, fns, onMatch) {
  const recv = String.raw`(?:[A-Za-z_][\w]*\s*\??\.\s*)?`;
  const re = new RegExp(
    String.raw`\b([A-Za-z_][\w]*)\s*:\s*${recv}(${fns})\s*(?![(\w])`,
    'g',
  );
  let m;
  while ((m = re.exec(text))) onMatch(m[1], m[2]);
  const computed = new RegExp(
    String.raw`\[\s*(['"\`])([^'"\`]+)\1\s*\]\s*:\s*${recv}(${fns})\s*(?![(\w])`,
    'g',
  );
  while ((m = computed.exec(text))) {
    if (/^[A-Za-z_][\w]*$/.test(m[2])) onMatch(m[2], m[3]);
  }
}

function indexOfTopLevelColon(s) {
  let depthParen = 0;
  let depthBrack = 0;
  let depthBrace = 0;
  let inStr = null;
  let esc = false;
  const text = String(s || '');
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
    else if (c === ')') { if (depthParen) depthParen--; }
    else if (c === '[') depthBrack++;
    else if (c === ']') { if (depthBrack) depthBrack--; }
    else if (c === '{') depthBrace++;
    else if (c === '}') { if (depthBrace) depthBrace--; }
    else if (c === ':' && depthParen === 0 && depthBrack === 0 && depthBrace === 0) return i;
  }
  return -1;
}

function objectInner(body) {
  const t = String(body || '').trim();
  if (!t.startsWith('{')) return t;
  const end = matchBalanced(t, 0);
  if (end < 0) return t.slice(1);
  return t.slice(1, end);
}

function eachObjectProperty(body, onProp) {
  for (const raw of splitTopLevelArgs(stripJsComments(objectInner(body)))) {
    const piece = raw.trim();
    if (!piece || piece.startsWith('...')) continue;
    if (piece[0] === '[') {
      const keyEnd = matchBalanced(piece, 0);
      if (keyEnd < 0) continue;
      const after = piece.slice(keyEnd + 1).trim();
      if (!after.startsWith(':')) continue;
      onProp({ keySrc: piece.slice(1, keyEnd), value: after.slice(1).trim(), computed: true });
      continue;
    }
    const colon = indexOfTopLevelColon(piece);
    if (colon < 0) continue;
    onProp({ keySrc: piece.slice(0, colon).trim(), value: piece.slice(colon + 1).trim(), computed: false });
  }
}

function resolveObjectKey(src, keySrc, computed) {
  const raw = String(keySrc || '').trim();
  if (computed) return resolveComputedKey(src, raw);
  if (/^[A-Za-z_][\w]*$/.test(raw)) return { resolved: raw, opaque: false };
  return resolveComputedKey(src, raw);
}

/** 对象字面量上的 child_process 属性转发：键走 resolveComputedKey，值走别名解析。 */
function applyObjectSpawnProps(body, src, names, cpNames, addAlias, addOpaque) {
  let has = false;
  let opaqueFwd = false;
  eachObjectProperty(body, (prop) => {
    const key = resolveObjectKey(src, prop.keySrc, prop.computed);
    const info = spawnNameFromExpr(prop.value, names, cpNames, src);
    if (!info.name && !info.opaque) return;
    has = true;
    if (key.opaque || !key.resolved || !/^[A-Za-z_][\w]*$/.test(key.resolved)) {
      opaqueFwd = true;
      return;
    }
    if (info.name) addAlias(key.resolved, info.name);
    else addOpaque(key.resolved);
  });
  return { has, opaqueFwd };
}

/** `box.run = (cp.spawnSync)` / `box["r"+"un"] = cp.spawnSync` / `box.run = cp["spawnSync"]` */
function scanHolderAssigns(text, names, cpNames, addAlias, addOpaque, holders, opaqueHolders) {
  const src = String(text || '');
  let inStr = null;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (!/[A-Za-z_]/.test(c)) continue;
    if (i > 0 && /[A-Za-z0-9_]/.test(src[i - 1])) continue;
    const idm = src.slice(i).match(/^([A-Za-z_][\w]*)/);
    if (!idm) continue;
    const prop = matchPropertyAccess(src, i + idm[1].length, src);
    if (!prop) continue;
    const after = src.slice(prop.end);
    const eq = after.match(/^\s*=(?![=>])\s*/);
    if (!eq) {
      i += idm[1].length - 1;
      continue;
    }
    const rhsStart = prop.end + eq[0].length;
    const rhsEnd = scanRhsEnd(src, rhsStart);
    const rhs = src.slice(rhsStart, rhsEnd);
    const info = spawnNameFromExpr(rhs, names, cpNames, src);
    if (!info.name && !info.opaque) {
      i += idm[1].length - 1;
      continue;
    }
    holders.add(idm[1]);
    if (prop.opaque || !prop.name || !/^[A-Za-z_][\w]*$/.test(prop.name)) {
      opaqueHolders.add(idm[1]);
    } else if (info.name) {
      addAlias(prop.name, info.name);
    } else {
      addOpaque(prop.name);
    }
    i = Math.max(i, rhsEnd - 1);
  }
}

function spreadsChildProcess(body, cpNames) {
  if (!cpNames || !cpNames.size) return false;
  const ids = [...cpNames].map(escapeIdent).join('|');
  return new RegExp(String.raw`(?:^|[^\w.])\.\.\.\s*(?:${ids})\b`).test(String(body || ''));
}

function collectSpawnAliasSets(src) {
  const names = new Set(SPAWN_FNS);
  const opaque = new Set();
  const holders = new Set();
  const opaqueHolders = new Set();
  const execNames = new Set(['exec', 'execSync']);
  const text = String(src || '');
  const cpNames = collectChildProcessReceivers(text);
  const addOpaque = (id) => {
    if (!id) return;
    names.add(id);
    opaque.add(id);
  };
  const addAlias = (dest, srcName) => {
    if (!dest) return;
    names.add(dest);
    if (srcName && execNames.has(srcName)) execNames.add(dest);
  };
  for (let n = 0; n < 32; n++) {
    const before = names.size + opaque.size + holders.size + opaqueHolders.size + cpNames.size + execNames.size;
    const fns = [...names].map(escapeIdent).join('|');
    const dest = new RegExp(String.raw`(?<!-)\b(${fns})\s*:\s*([A-Za-z_][\w]*)(?:\s*=(?![=>])|\s*[,}])`, 'g');
    let m;
    while ((m = dest.exec(text))) addAlias(m[2], m[1]);
    scanObjectDestructureSpawnAliases(text, names, cpNames, addAlias, addOpaque);
    scanArrayDestructureSpawnAliases(text, names, cpNames, addAlias, addOpaque);
    const imp = new RegExp(String.raw`(?<!-)\b(${fns})\s+as\s+([A-Za-z_][\w]*)\b`, 'g');
    while ((m = imp.exec(text))) addAlias(m[2], m[1]);
    const asg = new RegExp(
      String.raw`\b(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*(?!\{)[^\n;]*(?<!-)\b(${fns})\s*(?![(\w])`,
      'g',
    );
    while ((m = asg.exec(text))) addAlias(m[1], m[2]);
    const bare = new RegExp(
      String.raw`(?:^|[;\n])\s*([A-Za-z_][\w]*)\s*=\s*(?!\{)[^\n;]*(?<!-)\b(${fns})\s*(?![(\w])`,
      'g',
    );
    while ((m = bare.exec(text))) addAlias(m[1], m[2]);
    eachObjectSpawnProp(text, fns, (id, srcName) => addAlias(id, srcName));
    const takeObj = (id, body) => {
      let has = false;
      eachObjectSpawnProp(body, fns, () => { has = true; });
      const props = applyObjectSpawnProps(body, text, names, cpNames, addAlias, addOpaque);
      if (props.has) has = true;
      if (has) holders.add(id);
      if (props.opaqueFwd) opaqueHolders.add(id);
      if (spreadsChildProcess(body, cpNames)) {
        holders.add(id);
        cpNames.add(id);
      }
    };
    const asgObj = /\b(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*\{/g;
    while ((m = asgObj.exec(text))) {
      const openIdx = text.indexOf('{', m.index + m[0].length - 1);
      if (openIdx < 0) continue;
      const end = matchBalanced(text, openIdx);
      if (end < 0) continue;
      takeObj(m[1], text.slice(openIdx, end + 1));
    }
    const bareObj = /(?:^|[;\n])\s*([A-Za-z_][\w]*)\s*=\s*\{/g;
    while ((m = bareObj.exec(text))) {
      const openIdx = text.indexOf('{', m.index + m[0].length - 1);
      if (openIdx < 0) continue;
      const end = matchBalanced(text, openIdx);
      if (end < 0) continue;
      takeObj(m[1], text.slice(openIdx, end + 1));
    }
    const mem = new RegExp(
      String.raw`\b([A-Za-z_][\w]*)\s*\.\s*([A-Za-z_][\w]*)\s*=\s*(?:[A-Za-z_][\w]*\s*\.\s*)?(${fns})\s*(?![(\w])`,
      'g',
    );
    while ((m = mem.exec(text))) {
      holders.add(m[1]);
      addAlias(m[2], m[3]);
    }
    scanHolderAssigns(text, names, cpNames, addAlias, addOpaque, holders, opaqueHolders);
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
    if (opaqueHolders.size) {
      const ohs = [...opaqueHolders].map(escapeIdent).join('|');
      const asgOh = new RegExp(
        String.raw`\b(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*(?:${ohs})\s*(?![(\w.])`,
        'g',
      );
      while ((m = asgOh.exec(text))) opaqueHolders.add(m[1]);
      const bareOh = new RegExp(
        String.raw`(?:^|[;\n])\s*([A-Za-z_][\w]*)\s*=\s*(?:${ohs})\s*(?![(\w.])`,
        'g',
      );
      while ((m = bareOh.exec(text))) opaqueHolders.add(m[1]);
    }
    scanComputedAliases(text, cpNames, (id, info) => {
      if (isSpawnName(info.resolved, [...names])) addAlias(id, info.resolved);
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
    if (cpNames.size) {
      const ids = [...cpNames].map(escapeIdent).join('|');
      const ns = String.raw`(?:${ids})${CP_NS_SUFFIX}`;
      const asgCp = new RegExp(
        String.raw`\b(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*${ns}\s*(?![(\w.])`,
        'g',
      );
      while ((m = asgCp.exec(text))) cpNames.add(m[1]);
      const bareCp = new RegExp(
        String.raw`(?:^|[;\n])\s*([A-Za-z_][\w]*)\s*=\s*${ns}\s*(?![(\w.])`,
        'g',
      );
      while ((m = bareCp.exec(text))) cpNames.add(m[1]);
      scanCpDefaultDestructure(text, cpNames);
    }
    for (const h of holders) cpNames.add(h);
    if (names.size + opaque.size + holders.size + opaqueHolders.size + cpNames.size + execNames.size === before) break;
  }
  return { names, opaque, holders, cpNames, execNames, opaqueHolders };
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

/** 实参列表的 '('：`(0, spawnSync)(args)` 取第二个，`spawnSync?.(args)` 取唯一那个。 */
function invocationOpen(span) {
  const s = String(span || '');
  if (s.endsWith(')')) {
    const end = s.length - 1;
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== '(') continue;
      if (matchBalanced(s, i) === end) return i;
    }
  }
  return s.indexOf('(');
}

function calleeName(span) {
  const open = invocationOpen(span);
  if (open < 0) return '';
  const before = span.slice(0, open).trim().replace(/\?\.\s*$/, '').replace(/\)\s*$/, '').trim();
  const whole = before.match(/^([A-Za-z_][\w]*)$/);
  if (whole) return whole[1];
  const m = before.match(/([A-Za-z_][\w]*)$/);
  return m ? m[1] : '';
}

const CP_SPEC = String.raw`['"\`](?:node:)?child_process['"\`]`;
const CP_LOAD = String.raw`(?:\(\s*)?(?:await\s+)?(?:require|import)\s*\(\s*${CP_SPEC}\s*\)`;
const CP_NS_SUFFIX = String.raw`(?:\s*\??\.\s*(?:default|promises))*`;
const CP_INLINE_DOT = new RegExp(
  String.raw`(?:require\s*\(\s*${CP_SPEC}\s*\)|(?:await\s+)?import\s*\(\s*${CP_SPEC}\s*\))\s*\)?${CP_NS_SUFFIX}\s*\??\.\s*$`,
);

function isChildProcessNamespaceExpr(expr, cpNames) {
  const t = unwrapParens(expr);
  if (!t) return false;
  if (new RegExp(String.raw`^${CP_LOAD}\s*\)?${CP_NS_SUFFIX}$`).test(t)) return true;
  if (!cpNames || !cpNames.size) return false;
  const ids = [...cpNames].map(escapeIdent).join('|');
  return new RegExp(String.raw`^(?:${ids})${CP_NS_SUFFIX}$`).test(t);
}

function scanCpDefaultDestructure(text, names) {
  eachDestructure(text, '{', ({ inner, rhs }) => {
    if (!isChildProcessNamespaceExpr(rhs, names)) return;
    for (const raw of splitTopLevelArgs(stripJsComments(inner))) {
      const binding = parseObjectBinding(raw, text);
      if (binding && binding.dest) {
        if (binding.src === 'default' || binding.opaque) names.add(binding.dest);
        continue;
      }
      const dest = guessBindingDest(raw);
      if (dest) names.add(dest);
    }
  });
}

/** 剥掉一层或多层只包着整个表达式的括号。 */
function unwrapParens(expr) {
  let t = String(expr || '').trim();
  for (let n = 0; n < 8; n++) {
    if (!t.startsWith('(')) return t;
    const end = matchBalanced(t, 0);
    if (end < 0) return t;
    if (t.slice(end + 1).trim()) return t;
    t = t.slice(1, end).trim();
  }
  return t;
}

/** 绑定模式里的注释：ident 与冒号之间的块注释换成空格。字符串原样保留。 */
function stripJsComments(s) {
  let out = '';
  let inStr = null;
  let esc = false;
  const text = String(s || '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      if (i < text.length) out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      if (i < text.length) i += 1;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

function asNameList(names) {
  if (!names) return [];
  return names instanceof Set ? [...names] : [...names];
}

function asNameSet(names) {
  if (names instanceof Set) return names;
  return new Set(asNameList(names));
}

/** `arr[i] =` 是成员赋值，不是数组解构。`const [run] =` / `([run] =` 才是。 */
function isIndexOrMemberBracket(text, openIdx) {
  let i = openIdx - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return false;
  if (text[i] === ')' || text[i] === ']') return true;
  if (text[i] === '.') return true;
  if (!/[A-Za-z0-9_$]/.test(text[i])) return false;
  let j = i;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(text[j])) j--;
  const ident = text.slice(j + 1, i + 1);
  return !/^(?:const|let|var|of|in|from|await|return|case|throw|typeof|void|delete|yield|new)$/.test(ident);
}

function guessBindingDest(raw) {
  const head = splitBindingDefault(stripJsComments(raw));
  if (!head || head.startsWith('...')) return '';
  const m = head.match(/([A-Za-z_][\w]*)\s*$/);
  return m ? m[1] : '';
}

function exprLooksUnprovenSpawn(expr, names, cpNames) {
  const t = unwrapParens(expr);
  if (!t) return false;
  if (isChildProcessNamespaceExpr(t, cpNames)) return true;
  if (/child_process/.test(t)) return true;
  if (new RegExp(String.raw`\b(?:${SPAWN_FNS.map(escapeIdent).join('|')})\b`).test(t)) return true;
  if (cpNames && cpNames.size) {
    const ids = [...cpNames].map(escapeIdent).join('|');
    if (ids && new RegExp(String.raw`\b(?:${ids})\b`).test(t)) return true;
  }
  const nameSet = asNameSet(names);
  return /^[A-Za-z_][\w]*$/.test(t) && nameSet.has(t);
}

/** 剥掉解构绑定的默认值：`run = fallback` → `run`。括号/方括号/字符串里的 `=` 不算。 */
function splitBindingDefault(raw) {
  const t = String(raw || '').trim();
  let depthParen = 0;
  let depthBrack = 0;
  let depthBrace = 0;
  let inStr = null;
  let esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
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
    else if (
      depthParen === 0 && depthBrack === 0 && depthBrace === 0
      && c === '=' && t[i + 1] !== '=' && t[i + 1] !== '>'
    ) {
      return t.slice(0, i).trim();
    }
  }
  return t;
}

function parseObjectBinding(raw, src) {
  const head = splitBindingDefault(stripJsComments(raw));
  if (!head || head.startsWith('...')) return null;
  if (head[0] === '[') {
    const keyEnd = matchBalanced(head, 0);
    if (keyEnd < 0) return null;
    const after = head.slice(keyEnd + 1).trim();
    const destM = after.match(/^:\s*([A-Za-z_][\w]*)$/);
    if (!destM) return null;
    const { resolved, opaque } = resolveComputedKey(src, head.slice(1, keyEnd));
    return { dest: destM[1], src: resolved, opaque };
  }
  const quoted = head.match(/^(['"])((?:\\.|[^\\])*?)\1\s*:\s*([A-Za-z_][\w]*)$/);
  if (quoted) return { dest: quoted[3], src: quoted[2].replace(/\\(['"])/g, '$1'), opaque: false };
  const rename = head.match(/^([A-Za-z_][\w]*)\s*:\s*([A-Za-z_][\w]*)$/);
  if (rename) return { dest: rename[2], src: rename[1], opaque: false };
  const short = head.match(/^([A-Za-z_][\w]*)$/);
  if (short) return { dest: short[1], src: short[1], opaque: false };
  return null;
}

function parseArrayDest(raw) {
  const head = splitBindingDefault(stripJsComments(raw));
  if (!head || head.startsWith('...') || head[0] === '[' || head[0] === '{') return null;
  const m = head.match(/^([A-Za-z_][\w]*)$/);
  return m ? m[1] : null;
}

function spawnNameFromExpr(expr, names, cpNames, src) {
  const t = unwrapParens(expr);
  if (!t) return { name: '', opaque: false };
  const nameList = asNameList(names);
  const nameSet = asNameSet(names);
  const computed = t.match(/^([\s\S]*?)(?:\s*\?\.\s*)?\[([\s\S]*)\]\s*$/);
  if (computed && computed[1].trim()) {
    const recv = computed[1].trim().replace(/\?\.\s*$/, '');
    if (isChildProcessNamespaceExpr(recv, cpNames)) {
      const { resolved, opaque } = resolveComputedKey(src, computed[2]);
      if (isSpawnName(resolved, nameList)) return { name: resolved, opaque: false };
      if (opaque) return { name: '', opaque: true };
    }
  }
  const mem = t.match(/^([\s\S]*?)(?:\s*\??\.\s*)([A-Za-z_][\w]*)\s*$/);
  if (
    mem
    && isSpawnName(mem[2], nameList)
    && isChildProcessNamespaceExpr(mem[1].trim(), cpNames)
  ) {
    return { name: mem[2], opaque: false };
  }
  if (/^[A-Za-z_][\w]*$/.test(t) && nameSet.has(t)) return { name: t, opaque: false };
  return { name: '', opaque: false };
}

/** 声明解构 + 赋值解构（含括号）+ for-of。`arr[i] =` 不当数组解构。 */
function eachDestructure(text, openCh, onMatch) {
  const src = String(text || '');
  let inStr = null;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c !== openCh) continue;
    if (openCh === '[' && isIndexOrMemberBracket(src, i)) continue;
    const end = matchBalanced(src, i);
    if (end < 0) continue;
    const after = src.slice(end + 1);
    const eq = after.match(/^\s*=\s*/);
    const ofKw = after.match(/^\s+of\b\s*/);
    if (!eq && !ofKw) continue;
    const sep = eq || ofKw;
    const rhsStart = end + 1 + sep[0].length;
    const rhsEnd = scanRhsEnd(src, rhsStart);
    onMatch({
      inner: src.slice(i + 1, end),
      rhs: src.slice(rhsStart, rhsEnd).trim(),
      start: i,
      end: rhsEnd,
      kind: eq ? 'assign' : 'of',
    });
    i = end;
  }
}

function scanObjectDestructureSpawnAliases(text, names, cpNames, addAlias, addOpaque) {
  eachDestructure(text, '{', ({ inner, rhs }) => {
    const rhsIsCp = isChildProcessNamespaceExpr(rhs, cpNames);
    for (const raw of splitTopLevelArgs(stripJsComments(inner))) {
      const binding = parseObjectBinding(raw, text);
      if (binding && binding.dest) {
        if (rhsIsCp && (binding.src === 'default' || binding.opaque)) cpNames.add(binding.dest);
        if (binding.src && isSpawnName(binding.src, asNameList(names))) addAlias(binding.dest, binding.src);
        else if (binding.opaque && rhsIsCp) addOpaque(binding.dest);
        continue;
      }
      if (!rhsIsCp) continue;
      const dest = guessBindingDest(raw);
      if (dest) {
        addOpaque(dest);
        cpNames.add(dest);
      }
    }
  });
}

function forOfSources(rhs, src) {
  let t = unwrapParens(rhs);
  if (/^[A-Za-z_][\w]*$/.test(t)) {
    const arr = findArrayLiteral(src, t);
    if (arr) t = unwrapParens(arr);
  }
  if (!t.startsWith('[')) return [t];
  const close = matchBalanced(t, 0);
  if (close < 0 || t.slice(close + 1).trim()) return [t];
  const slots = splitTopLevelArgs(t.slice(1, close)).map((s) => s.trim()).filter(Boolean);
  return slots.length ? slots : [t];
}

function scanArrayDestructureSpawnAliases(text, names, cpNames, addAlias, addOpaque) {
  eachDestructure(text, '[', ({ inner, rhs, kind }) => {
    const sources = kind === 'of' ? forOfSources(rhs, text) : [rhs];
    const lhs = splitTopLevelArgs(stripJsComments(inner));
    const failClosedDests = () => {
      for (const raw of lhs) {
        const dest = parseArrayDest(raw);
        if (dest) addOpaque(dest);
      }
    };
    for (const source of sources) {
      const rhsUnwrapped = unwrapParens(source);
      if (!rhsUnwrapped.startsWith('[')) {
        if (exprLooksUnprovenSpawn(rhsUnwrapped, names, cpNames)) failClosedDests();
        continue;
      }
      const close = matchBalanced(rhsUnwrapped, 0);
      if (close < 0 || rhsUnwrapped.slice(close + 1).trim()) {
        if (exprLooksUnprovenSpawn(rhsUnwrapped, names, cpNames)) failClosedDests();
        continue;
      }
      const slots = splitTopLevelArgs(rhsUnwrapped.slice(1, close));
      for (let i = 0; i < lhs.length; i++) {
        const dest = parseArrayDest(lhs[i]);
        if (!dest) continue;
        const slot = slots[i] || '';
        const info = spawnNameFromExpr(slot, names, cpNames, text);
        if (info.name) addAlias(dest, info.name);
        else if (info.opaque) addOpaque(dest);
        else if (exprLooksUnprovenSpawn(slot, names, cpNames)) addOpaque(dest);
      }
    }
  });
}

function collectChildProcessReceivers(src) {
  const names = new Set();
  const text = String(src || '');
  const loadNs = String.raw`${CP_LOAD}\s*\)?${CP_NS_SUFFIX}`;
  const patterns = [
    new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*${loadNs}`, 'g'),
    new RegExp(String.raw`(?:^|[;\n])\s*([A-Za-z_][\w]*)\s*=\s*${loadNs}`, 'g'),
    new RegExp(String.raw`import\s+\*\s+as\s+([A-Za-z_][\w]*)\s+from\s+${CP_SPEC}`, 'g'),
    new RegExp(String.raw`import\s+([A-Za-z_][\w]*)\s+from\s+${CP_SPEC}`, 'g'),
    new RegExp(String.raw`(?:await\s+)?import\s*\(\s*${CP_SPEC}\s*\)\s*\.then\s*\(\s*\(?\s*([A-Za-z_][\w]*)`, 'g'),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) names.add(m[1]);
  }
  scanCpDefaultDestructure(text, names);
  return names;
}

function knownMemberReceiver(window, cpNames) {
  const w = String(window || '');
  if (CP_INLINE_DOT.test(w)) return true;
  const recv = w.match(/([A-Za-z_][\w]*)(?:\s*\??\.\s*(?:default|promises))*\s*\??\.\s*$/);
  return !!(recv && cpNames && cpNames.has(recv[1]));
}

function receiverBefore(text, bracketIdx, cpNames) {
  const before = text.slice(Math.max(0, bracketIdx - 120), bracketIdx);
  const load = before.match(new RegExp(
    String.raw`(?:require\s*\(\s*${CP_SPEC}\s*\)|(?:await\s+)?import\s*\(\s*${CP_SPEC}\s*\))\s*\)?${CP_NS_SUFFIX}(?:\s*\?\.)?\s*$`,
  ));
  if (load) return { isCp: true, start: bracketIdx - load[0].length };
  const dotted = before.match(/([A-Za-z_][\w]*)(?:\s*\??\.\s*(?:default|promises))*(?:\s*\?\.)?\s*$/);
  if (dotted) return { isCp: !!(cpNames && cpNames.has(dotted[1])), start: bracketIdx - dotted[0].length };
  const id = before.match(/([A-Za-z_][\w]*)(?:\s*\?\.)?\s*$/);
  if (id) return { isCp: !!(cpNames && cpNames.has(id[1])), start: bracketIdx - id[0].length };
  return { isCp: false, start: bracketIdx };
}

function unwrapArrayArg(expr) {
  const t = String(expr || '').trim();
  if (!t.startsWith('[')) return null;
  const end = matchBalanced(t, 0);
  if (end < 0) return null;
  if (t.slice(end + 1).trim()) return null;
  return splitTopLevelArgs(t.slice(1, end)).map((s) => s.trim()).filter(Boolean);
}

function skipWs(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

function indexOfCallOpen(text, i) {
  let k = skipWs(text, i);
  if (text[k] === '?' && text[k + 1] === '.') k = skipWs(text, k + 2);
  k = skipWs(text, k);
  return text[k] === '(' ? k : -1;
}

/** 从 i 起读一个属性访问：.name / ?.name / ["name"] / ?.["name"] */
function matchPropertyAccess(text, i, src = text) {
  let k = skipWs(text, i);
  if (k >= text.length) return null;
  if (text[k] === '?' && text[k + 1] === '.') k = skipWs(text, k + 2);
  else if (text[k] === '.') k = skipWs(text, k + 1);
  else if (text[k] !== '[') return null;
  if (text[k] === '[') {
    const end = matchBalanced(text, k);
    if (end < 0) return null;
    const { resolved, opaque } = resolveComputedKey(src, text.slice(k + 1, end));
    return { name: resolved, opaque, end: end + 1 };
  }
  const m = text.slice(k).match(/^([A-Za-z_][\w]*)/);
  if (!m) return null;
  return { name: m[1], opaque: false, end: k + m[1].length };
}

function matchAdapterAfter(rest, src) {
  const s = String(rest || '');
  const dotted = s.match(
    /^(?:\s*\?\s*\.\s*|\s*\.\s*)(call|apply|bind)\b(?:\s*\?\s*\.\s*)?\s*\(/,
  );
  if (dotted) return { kind: dotted[1], prefixLen: dotted[0].length };
  const head = s.match(/^(?:\s*\?\s*\.\s*)?\s*\[/);
  if (!head) return null;
  const lb = s.indexOf('[');
  const keyEnd = matchBalanced(s, lb);
  if (keyEnd < 0) return null;
  const afterKey = s.slice(keyEnd + 1);
  const callParen = afterKey.match(/^(?:\s*\?\s*\.\s*)?\s*\(/);
  if (!callParen) return null;
  const { resolved } = resolveComputedKey(src || s, s.slice(lb + 1, keyEnd));
  const prefixLen = keyEnd + 1 + callParen[0].length;
  if (resolved === 'call' || resolved === 'apply' || resolved === 'bind') {
    return { kind: resolved, prefixLen };
  }
  return { kind: 'opaque', prefixLen };
}

function calleeNameFromTarget(expr) {
  const t = String(expr || '').trim();
  const mem = t.match(/([A-Za-z_][\w]*)\s*$/);
  return mem ? mem[1] : '';
}

function exprIsSpawnTarget(expr, spawnNames, cpNames) {
  const t = String(expr || '').trim().replace(/^\(+/, '').replace(/\)+$/, '');
  if (!t) return false;
  if (/^[A-Za-z_][\w]*$/.test(t)) return !!(spawnNames && spawnNames.has(t)) || SPAWN_FNS.includes(t);
  const mem = t.match(/^([A-Za-z_][\w]*)(?:\s*\??\.\s*(?:default|promises))*\s*(?:\?\.\s*|\.\s*)([A-Za-z_][\w]*)$/);
  if (mem && cpNames && cpNames.has(mem[1]) && (spawnNames.has(mem[2]) || SPAWN_FNS.includes(mem[2]))) {
    return true;
  }
  if (new RegExp(String.raw`(?:require|import)\s*\(\s*${CP_SPEC}\s*\)`).test(t)
    && SPAWN_FNS.some((n) => new RegExp(String.raw`(?:^|[^\w])${escapeIdent(n)}(?:[^\w]|$)`).test(t))) {
    return true;
  }
  const computed = t.match(/^([A-Za-z_][\w]*)\s*(?:\?\.\s*)?\[/);
  if (computed && cpNames && cpNames.has(computed[1])) return true;
  return false;
}

function emitAdapterCall(kind, text, adapterOpen, name, index, onSpan) {
  const adapterClose = matchBalanced(text, adapterOpen);
  if (adapterClose < 0) return -1;
  if (kind === 'opaque') {
    onSpan(`${name}(${text.slice(adapterOpen + 1, adapterClose)})`, index, true);
    return adapterClose;
  }
  const adapterArgs = splitTopLevelArgs(text.slice(adapterOpen + 1, adapterClose));
  if (kind === 'bind') {
    const after = text.slice(adapterClose + 1);
    if (!/^\s*\(/.test(after)) return -2;
    const invOpen = adapterClose + 1 + after.indexOf('(');
    const invClose = matchBalanced(text, invOpen);
    if (invClose < 0) return -1;
    onSpan(`${name}(${splitTopLevelArgs(text.slice(invOpen + 1, invClose)).join(', ')})`, index);
    return invClose;
  }
  if (kind === 'apply') {
    const unwrapped = unwrapArrayArg(adapterArgs[1] || '');
    if (!unwrapped) {
      onSpan(`${name}(${adapterArgs.slice(1).join(', ')})`, index, true);
      return adapterClose;
    }
    onSpan(`${name}(${unwrapped.join(', ')})`, index);
    return adapterClose;
  }
  onSpan(`${name}(${adapterArgs.slice(1).join(', ')})`, index);
  return adapterClose;
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
  const open = invocationOpen(span);
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
    const after = text.slice(keyEnd + 1);
    const direct = after.match(/^(?:\s*\?\.)?\s*\(/);
    const adapter = matchAdapterAfter(after, text);
    if (!direct && !adapter) continue;
    const { resolved, opaque } = resolveComputedKey(text, text.slice(i + 1, keyEnd));
    const recv = receiverBefore(text, i, cpNames);
    if (!isSpawnName(resolved, [...spawnNames]) && !(opaque && recv.isCp)) continue;
    const name = isSpawnName(resolved, [...spawnNames]) ? resolved : 'spawnSync';
    if (adapter) {
      const adapterOpen = text.indexOf('(', keyEnd + 1);
      if (adapterOpen < 0) continue;
      const end = emitAdapterCall(adapter.kind, text, adapterOpen, name, recv.start, onSpan);
      if (end >= 0) i = end;
      continue;
    }
    const openIdx = text.indexOf('(', keyEnd + 1);
    if (openIdx < 0) continue;
    const callEnd = matchBalanced(text, openIdx);
    if (callEnd < 0) continue;
    onSpan(text.slice(recv.start, callEnd + 1), recv.start);
    i = callEnd;
  }
}

function scanIndirectApply(text, spawnNames, cpNames, onSpan) {
  const re = /\b(?:Reflect|Function)\b/g;
  let m;
  while ((m = re.exec(text))) {
    let openIdx = -1;
    let viaApply = false;
    if (m[0] === 'Reflect') {
      const prop = matchPropertyAccess(text, m.index + m[0].length);
      if (!prop || (prop.name !== 'apply' && !prop.opaque)) continue;
      openIdx = indexOfCallOpen(text, prop.end);
      if (openIdx < 0) continue;
      viaApply = true;
    } else {
      const proto = matchPropertyAccess(text, m.index + m[0].length);
      if (!proto || proto.name !== 'prototype') continue;
      const meth = matchPropertyAccess(text, proto.end);
      if (!meth || (meth.name !== 'call' && meth.name !== 'apply' && !meth.opaque)) continue;
      const invoke = matchPropertyAccess(text, meth.end);
      if (!invoke || (invoke.name !== 'call' && !invoke.opaque)) continue;
      openIdx = indexOfCallOpen(text, invoke.end);
      if (openIdx < 0) continue;
      viaApply = meth.name === 'apply' || meth.opaque;
    }
    const closeIdx = matchBalanced(text, openIdx);
    if (closeIdx < 0) continue;
    const args = splitTopLevelArgs(text.slice(openIdx + 1, closeIdx));
    if (!args.length) continue;
    const target = args[0].trim();
    if (!exprIsSpawnTarget(target, spawnNames, cpNames)) continue;
    const name = calleeNameFromTarget(target) || 'spawnSync';
    if (viaApply) {
      const unwrapped = unwrapArrayArg(args[2] || '');
      if (!unwrapped) {
        onSpan(`${name}(${args.slice(2).join(', ')})`, m.index, true);
        continue;
      }
      onSpan(`${name}(${unwrapped.join(', ')})`, m.index);
      continue;
    }
    onSpan(`${name}(${args.slice(2).join(', ')})`, m.index);
  }
}

export function extractCallSpans(src, names) {
  const sets = collectSpawnAliasSets(src);
  return extractCallSites(src, names, sets.holders, sets.cpNames, sets.opaqueHolders).map((s) => s.span);
}

function scanOpaqueHolderCalls(text, opaqueHolders, onSpan) {
  const set = opaqueHolders instanceof Set ? opaqueHolders : new Set(opaqueHolders || []);
  if (!set.size) return;
  const hs = [...set].map(escapeIdent).join('|');
  const re = new RegExp(String.raw`\b(?:${hs})\b`, 'g');
  let m;
  while ((m = re.exec(text))) {
    const prop = matchPropertyAccess(text, m.index + m[0].length, text);
    if (!prop) continue;
    const adapter = matchAdapterAfter(text.slice(prop.end), text);
    if (adapter) {
      const adapterOpen = text.indexOf('(', prop.end);
      if (adapterOpen < 0) continue;
      const name = prop.name && /^[A-Za-z_][\w]*$/.test(prop.name) ? prop.name : 'spawnSync';
      const end = emitAdapterCall(adapter.kind, text, adapterOpen, name, m.index, onSpan);
      if (end >= 0) re.lastIndex = end + 1;
      continue;
    }
    const openIdx = indexOfCallOpen(text, prop.end);
    if (openIdx < 0) continue;
    const close = matchBalanced(text, openIdx);
    if (close < 0) continue;
    onSpan(text.slice(m.index, close + 1), m.index, true);
    re.lastIndex = close + 1;
  }
}

function groupOpenBefore(text, closeIdx, nameIdx) {
  const lo = Math.max(0, nameIdx - 160);
  for (let i = nameIdx - 1; i >= lo; i--) {
    if (text[i] !== '(') continue;
    if (matchBalanced(text, i) === closeIdx) return i;
  }
  return -1;
}

function extractCallSites(src, names, holders, cpReceivers, opaqueHolders) {
  const text = String(src || '');
  const list = (Array.isArray(names) ? names : [names]).map(String).filter(Boolean);
  const alts = list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const sites = [];
  const seen = new Set();
  const push = (span, index, opaque = false) => {
    if (!span) return;
    const key = `${index}:${span}:${opaque ? 1 : 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    sites.push({ span, index, opaque: !!opaque });
  };
  const cpNames = new Set(cpReceivers || collectChildProcessReceivers(text));
  for (const h of holders || []) cpNames.add(h);
  if (alts.length) {
    const re = new RegExp(String.raw`\b(?:${alts.join('|')})\b`, 'g');
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      if (/\bfunction\s+$/.test(before)) continue;
      const rest = text.slice(m.index + m[0].length);
      const direct = rest.match(/^(?:\s*\?\.)?\s*\(/);
      const wrapped = rest.match(/^\s*\)\s*\(/);
      const adapter = matchAdapterAfter(rest, text);
      const window = text.slice(Math.max(0, m.index - 120), m.index);
      if (/\.\s*$/.test(before) && !knownMemberReceiver(window, cpNames)) continue;
      let openIdx = -1;
      let spanStart = m.index;
      if (adapter) {
        const adapterOpen = m.index + m[0].length + adapter.prefixLen - 1;
        const end = emitAdapterCall(adapter.kind, text, adapterOpen, m[0], spanStart, push);
        if (end >= 0) re.lastIndex = end + 1;
        continue;
      }
      if (direct) {
        openIdx = m.index + m[0].length + direct[0].lastIndexOf('(');
      } else if (wrapped) {
        const closeIdx = m.index + m[0].length + wrapped[0].indexOf(')');
        const groupOpen = groupOpenBefore(text, closeIdx, m.index);
        if (groupOpen < 0) continue;
        openIdx = m.index + m[0].length + wrapped[0].lastIndexOf('(');
        spanStart = groupOpen;
      } else continue;
      if (openIdx < 0) continue;
      const end = matchBalanced(text, openIdx);
      if (end < 0) continue;
      push(text.slice(spanStart, end + 1), spanStart);
    }
  }
  const spawnNames = new Set([...list, ...SPAWN_FNS]);
  scanComputedCalls(text, spawnNames, cpNames, push);
  scanIndirectApply(text, spawnNames, cpNames, push);
  scanOpaqueHolderCalls(text, opaqueHolders, push);
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
    else if (c === ')') {
      if (!depthParen) return i;
      depthParen--;
    } else if (c === '[') depthBrack++;
    else if (c === ']') {
      if (!depthBrack) return i;
      depthBrack--;
    } else if (c === '{') depthBrace++;
    else if (c === '}') {
      if (!depthBrace) return i;
      depthBrace--;
    } else if (depthParen === 0 && depthBrack === 0 && depthBrace === 0) {
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

function collectArgvMutations(src, name, fromIdx, toIdx) {
  const text = String(src || '');
  const out = [];
  const ident = escapeIdent(name);
  const callRe = new RegExp(
    String.raw`\b${ident}\s*\??\.\s*(push|unshift|pop|shift|splice)\s*\(`,
    'g',
  );
  let m;
  while ((m = callRe.exec(text))) {
    if (m.index < fromIdx || m.index >= toIdx) continue;
    const open = text.indexOf('(', m.index + m[0].length - 1);
    if (open < 0 || open >= toIdx) continue;
    const close = matchBalanced(text, open);
    if (close < 0 || close > toIdx) continue;
    const args = splitTopLevelArgs(text.slice(open + 1, close)).map((s) => s.trim()).filter(Boolean);
    out.push({ kind: m[1], args, index: m.index });
  }
  const lbRe = new RegExp(String.raw`\b${ident}\s*\[`, 'g');
  while ((m = lbRe.exec(text))) {
    if (m.index < fromIdx || m.index >= toIdx) continue;
    const open = text.indexOf('[', m.index);
    const close = matchBalanced(text, open);
    if (close < 0) continue;
    const after = text.slice(close + 1);
    const eq = after.match(/^\s*=(?![=>])\s*/);
    if (!eq) continue;
    const rhsStart = close + 1 + eq[0].length;
    if (rhsStart >= toIdx) continue;
    const rhsEnd = scanRhsEnd(text, rhsStart);
    if (rhsEnd > toIdx) continue;
    const keySrc = text.slice(open + 1, close);
    const key = resolveComputedKey(text, keySrc);
    const slot = key.resolved && /^(?:0|[1-9]\d*)$/.test(key.resolved) ? Number(key.resolved) : NaN;
    out.push({
      kind: 'index',
      slot,
      value: text.slice(rhsStart, rhsEnd).trim(),
      opaque: key.opaque || !Number.isInteger(slot),
      index: m.index,
    });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

function resolveArgvArray(src, name, beforeIdx = Infinity) {
  const asg = findLastAssignment(src, name, beforeIdx);
  if (!asg) return { lit: '', unresolved: false };
  const rhs = asg.rhs.trim();
  if (!rhs.startsWith('[')) return { lit: '', unresolved: false };
  const end = matchBalanced(rhs, 0);
  if (end < 0) return { lit: '', unresolved: false };
  const slots = splitTopLevelArgs(rhs.slice(1, end)).map((s) => s.trim());
  const muts = collectArgvMutations(src, name, asg.end, beforeIdx);
  let unresolved = false;
  const destructive = new Set(['pop', 'shift', 'splice']);
  for (const mut of muts) {
    if (mut.kind === 'push') {
      slots.push(...mut.args);
    } else if (mut.kind === 'unshift') {
      slots.unshift(...mut.args);
    } else if (mut.kind === 'index' && Number.isInteger(mut.slot) && mut.slot >= 0 && !mut.opaque) {
      while (slots.length <= mut.slot) slots.push('');
      slots[mut.slot] = mut.value;
    } else if (destructive.has(mut.kind) || mut.kind === 'index') {
      unresolved = true;
    } else {
      unresolved = true;
    }
  }
  return { lit: `[${slots.join(', ')}]`, unresolved };
}

function findArrayLiteral(src, name, beforeIdx = Infinity) {
  return resolveArgvArray(src, name, beforeIdx).lit;
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

function isProcessNamespaceExpr(expr) {
  return /^(?:global(?:This)?\s*\.\s*)?process$/.test(unwrapParens(expr));
}

/** `const { execPath } = process` / `({ execPath: nodePath } = process)` / 字符串键与计算键 */
function isProcessExecPathBinding(src, name, beforeIdx = Infinity) {
  const ident = String(name || '');
  if (!ident) return false;
  const text = String(src || '');
  let found = false;
  eachDestructure(text, '{', ({ inner, rhs, start, end }) => {
    if (found) return;
    if (start >= beforeIdx || end > beforeIdx) return;
    if (!isProcessNamespaceExpr(rhs)) return;
    for (const raw of splitTopLevelArgs(stripJsComments(inner))) {
      const binding = parseObjectBinding(raw, text);
      if (binding && binding.dest === ident) {
        if (binding.src === 'execPath' || binding.opaque) found = true;
        return;
      }
      if (!binding && guessBindingDest(raw) === ident) found = true;
    }
  });
  return found;
}

function stripTemplateInterp(s) {
  const text = String(s || '');
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '{') {
      const end = matchBalanced(text, i + 1);
      if (end < 0) return `${out} `;
      out += ' ';
      i = end;
      continue;
    }
    out += text[i];
  }
  return out;
}

function staticCommandText(expr) {
  let s = foldStringConcat(String(expr || '')).trim();
  const wrapped = s.match(/^(['"`])([\s\S]*)\1$/);
  if (wrapped) s = wrapped[2];
  return stripTemplateInterp(s);
}

function commandHasDynamicParts(expr) {
  const t = foldStringConcat(String(expr || ''));
  if (/\$\{/.test(t)) return true;
  return /\+\s*(?:[A-Za-z_$(\[]|`)/.test(t);
}

function looksLikeNodeDaoCommand(expr) {
  const staticText = staticCommandText(expr);
  if (!staticText.trim()) return false;
  const first = (staticText.trim().match(/^([^\s]+)/) || ['', ''])[1].replace(/^['"]|['"]$/g, '');
  const hasNode = /\b(?:node|nodejs)(?:\.exe)?\b/i.test(staticText)
    || /\bprocess\s*\.\s*execPath\b/.test(String(expr || ''))
    || isNodeExecutableName(first);
  const hasDao = /(?:^|\/)dao\.mjs(?:\s|$)/.test(staticText) || /\bdao\.mjs\b/.test(staticText);
  return hasNode && hasDao;
}

function commandStaticallyHasDryRun(expr) {
  return hasDryRun(staticCommandText(expr));
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
    if (asg && isJsRunnerCommand(src, asg.rhs, asg.start, seen)) return true;
    if (!asg) {
      const str = findStringLiteral(src, t, beforeIdx);
      if (str) return isJsRunnerCommand(src, str, beforeIdx, seen);
    }
    if (isProcessExecPathBinding(src, t, beforeIdx)) return true;
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
    if (looksLikeNodeDaoCommand(t)) return true;
    return false;
  }
  if (looksLikeNodeDaoCommand(t)) return true;
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
    const resolved = resolveArgvArray(src, t, beforeIdx);
    if (resolved.lit) {
      const slots = flattenArgvSlots(src, resolved.lit, beforeIdx, depth + 1);
      if (resolved.unresolved) slots.push({ kind: 'unknown' });
      return slots;
    }
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
  if (looksLikeNodeDaoCommand(t) && commandHasDynamicParts(t) && !commandStaticallyHasDryRun(t)) {
    return true;
  }
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
function argvTextForCall(src, span, callIndex = Infinity, execNames) {
  const open = invocationOpen(span);
  if (open < 0) return { text: '', unresolved: false };
  const close = matchBalanced(span, open);
  if (close < 0) return { text: '', unresolved: false };
  const args = splitTopLevelArgs(span.slice(open + 1, close));
  const pieces = [];
  let unresolved = false;
  let command = '';
  const argvExprs = [];
  const callee = calleeName(span);
  const execFns = execNames instanceof Set ? execNames : new Set(['exec', 'execSync']);
  const execString = execFns.has(callee);
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
      const resolved = resolveArgvArray(src, t, callIndex);
      const arr = resolved.lit;
      const str = findStringLiteral(src, t, callIndex);
      if (arr) addArray(arr);
      if (str) pieces.push(str);
      if (resolved.unresolved && isJsRunnerCommand(src, command, callIndex)) unresolved = true;
      if (!arr && !str) {
        pieces.push(t);
        if (!treatingAsCommand && isJsRunnerCommand(src, command, callIndex)) unresolved = true;
      }
      continue;
    }
    pieces.push(t);
  }
  if (looksLikeNodeDaoCommand(command) && commandHasDynamicParts(command) && !commandStaticallyHasDryRun(command)) {
    unresolved = true;
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
  const { names, opaque: opaqueAliases, holders, cpNames, execNames, opaqueHolders } = collectSpawnAliasSets(text);
  const nameList = [...names];
  const sites = extractCallSites(text, nameList, holders, cpNames, opaqueHolders);
  const violations = [];
  let scanned = 0;
  for (const { span, index, opaque: siteOpaque } of sites) {
    const argvInfo = argvTextForCall(text, span, index, execNames);
    const argvText = foldStringConcat(argvInfo.text);
    const opaque = isOpaqueComputedSpan(span, nameList, text)
      || opaqueAliases.has(calleeName(span))
      || !!siteOpaque;
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
      let optionalMember = false;
      let optionalCall = false;
      let commaCall = false;
      let computedObjKey = false;
      let spreadCp = false;
      let destructureExecPath = false;
      let fnCall = false;
      let fnApply = false;
      let reflectApply = false;
      let dynamicImport = false;
      let assignedRequire = false;
      let importDefaultFwd = false;
      let computedAdapter = false;
      let computedReflect = false;
      let execDynamicTmpl = false;
      let execAliasDynamic = false;
      let destructureDefault = false;
      let computedDestructure = false;
      let arrayDestructure = false;
      let quotedDestructure = false;
      let commentDestructure = false;
      let assignDestructure = false;
      let arrayAliasDestructure = false;
      let arrayParenDestructure = false;
      let arrayAssignDestructure = false;
      let defaultAssignDestructure = false;
      let execPathAssignDestructure = false;
      let computedConcatObjKey = false;
      let argvPush = false;
      let forOfArrayDestructure = false;
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
        if (/\?\.\s*spawnSync\s*\(/.test(src) && r.scanned > 0 && !r.ok) optionalMember = true;
        if (/\bspawnSync\s*\?\.\s*\(/.test(src) && r.scanned > 0 && !r.ok) optionalCall = true;
        if (/\(\s*0\s*,\s*spawnSync\s*\)\s*\(/.test(src) && r.scanned > 0 && !r.ok) commaCall = true;
        if (/\[\s*['"]run['"]\s*\]\s*:/.test(src) && r.scanned > 0 && !r.ok) computedObjKey = true;
        if (/\{\s*\.\.\.\s*[A-Za-z_][\w]*\s*\}/.test(src) && r.scanned > 0 && !r.ok) spreadCp = true;
        if (/execPath\s*:\s*[A-Za-z_][\w]*/.test(src) && r.scanned > 0 && !r.ok) destructureExecPath = true;
        if (/\.call\s*\(\s*null/.test(src) && r.scanned > 0 && !r.ok) fnCall = true;
        if (/\.apply\s*\(\s*null/.test(src) && r.scanned > 0 && !r.ok) fnApply = true;
        if (/Reflect\s*\.\s*apply\s*\(/.test(src) && r.scanned > 0 && !r.ok) reflectApply = true;
        if (/await\s+import\s*\(\s*['"`](?:node:)?child_process['"`]/.test(src) && r.scanned > 0 && !r.ok) {
          dynamicImport = true;
        }
        if (
          /(?:const|let|var)\s+[A-Za-z_][\w]*\s*;/.test(src)
          && /(?:^|[;\n])\s*[A-Za-z_][\w]*\s*=\s*require\s*\(\s*['"`](?:node:)?child_process['"`]/.test(src)
          && r.scanned > 0 && !r.ok
        ) assignedRequire = true;
        if (
          /\.default\b/.test(src)
          && /await\s+import\s*\(/.test(src)
          && r.scanned > 0 && !r.ok
        ) importDefaultFwd = true;
        if (/\[["'](?:call|apply|bind)["']\]/.test(src) && r.scanned > 0 && !r.ok) {
          computedAdapter = true;
        }
        if (/Reflect\s*\[["']apply["']\]/.test(src) && r.scanned > 0 && !r.ok) {
          computedReflect = true;
        }
        if (
          /\bexec\s*\(/.test(src)
          && /dao\.mjs/.test(src)
          && /\$\{/.test(src)
          && r.scanned > 0 && !r.ok
        ) execDynamicTmpl = true;
        if (
          /\bexec\s*:\s*[A-Za-z_][\w]*/.test(src)
          && /dao\.mjs/.test(src)
          && /\$\{/.test(src)
          && r.scanned > 0 && !r.ok
        ) execAliasDynamic = true;
        if (
          /\bexec\s*:\s*[A-Za-z_][\w]*\s*=/.test(src)
          && /dao\.mjs/.test(src)
          && /\$\{/.test(src)
          && r.scanned > 0 && !r.ok
        ) destructureDefault = true;
        if (
          /\[\s*['"`]exec['"`]\s*\]\s*:/.test(src)
          && /dao\.mjs/.test(src)
          && /\$\{/.test(src)
          && r.scanned > 0 && !r.ok
        ) computedDestructure = true;
        if (
          /(?:const|let|var)\s*\[/.test(src)
          && /\bcp\s*\.\s*exec\b/.test(src)
          && /dao\.mjs/.test(src)
          && /\$\{/.test(src)
          && r.scanned > 0 && !r.ok
        ) arrayDestructure = true;
        if (
          /['"`]exec['"`]\s*:\s*[A-Za-z_]/.test(src)
          && !/\[\s*['"`]exec['"`]/.test(src)
          && /dao\.mjs/.test(src)
          && /\$\{/.test(src)
          && r.scanned > 0 && !r.ok
        ) quotedDestructure = true;
        if (
          /\bexec\s*\/\*/.test(src)
          && /dao\.mjs/.test(src)
          && /\$\{/.test(src)
          && r.scanned > 0 && !r.ok
        ) commentDestructure = true;
        if (
          /\(\s*\{/.test(src)
          && /\[\s*['"`]exec['"`]\s*\]\s*:/.test(src)
          && /dao\.mjs/.test(src)
          && /\$\{/.test(src)
          && r.scanned > 0 && !r.ok
        ) assignDestructure = true;
        if (
          /\b(?:const|let|var)\s+[A-Za-z_][\w]*\s*=\s*[A-Za-z_][\w]*\s*\.\s*exec\b/.test(src)
          && /\[[A-Za-z_][\w]*\]\s*=\s*\[[A-Za-z_][\w]*\]/.test(src)
          && /dao\.mjs/.test(src)
          && /\$\{/.test(src)
          && r.scanned > 0 && !r.ok
        ) arrayAliasDestructure = true;
        if (
          /\[\s*\(\s*[A-Za-z_][\w]*\s*\.\s*exec/.test(src)
          && /dao\.mjs/.test(src)
          && /\$\{/.test(src)
          && r.scanned > 0 && !r.ok
        ) arrayParenDestructure = true;
        if (
          /\(\s*\[[^\]]+\]\s*=/.test(src)
          && /dao\.mjs/.test(src)
          && /\$\{/.test(src)
          && r.scanned > 0 && !r.ok
        ) arrayAssignDestructure = true;
        if (
          /\(\s*\{\s*default\s*:/.test(src)
          && /await\s+import\s*\(/.test(src)
          && r.scanned > 0 && !r.ok
        ) defaultAssignDestructure = true;
        if (
          /\(\s*\{\s*execPath\s*:/.test(src)
          && /=\s*process\b/.test(src)
          && r.scanned > 0 && !r.ok
        ) execPathAssignDestructure = true;
        if (
          /\[\s*['"][^'"]+['"]\s*\+\s*['"][^'"]+['"]\s*\]\s*:/.test(src)
          && /spawnSync/.test(src)
          && r.scanned > 0 && !r.ok
        ) computedConcatObjKey = true;
        if (
          /\.push\s*\(/.test(src)
          && /dispatch/.test(src)
          && r.scanned > 0 && !r.ok
        ) argvPush = true;
        if (
          /for\s*\(\s*(?:const|let|var)\s*\[/.test(src)
          && /\bof\b/.test(src)
          && /dao\.mjs/.test(src)
          && /\$\{/.test(src)
          && r.scanned > 0 && !r.ok
        ) forOfArrayDestructure = true;
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
      if (!optionalMember) problems.push('red/ 没点出可选链成员调用（cp?.spawnSync）');
      if (!optionalCall) problems.push('red/ 没点出可选链调用（spawnSync?.）');
      if (!commaCall) problems.push('red/ 没点出逗号间接调用（(0, spawnSync)）');
      if (!computedObjKey) problems.push('red/ 没点出计算属性键对象别名（[\'run\']）');
      if (!spreadCp) problems.push('red/ 没点出展开 child_process（{ ...cp }）');
      if (!destructureExecPath) problems.push('red/ 没点出解构 process.execPath');
      if (!fnCall) problems.push('red/ 没点出 Function.call 适配（spawnSync.call）');
      if (!fnApply) problems.push('red/ 没点出 Function.apply 适配（spawnSync.apply）');
      if (!reflectApply) problems.push('red/ 没点出 Reflect.apply 适配');
      if (!dynamicImport) problems.push('red/ 没点出动态 import() child_process');
      if (!assignedRequire) problems.push('red/ 没点出先声明再赋值的 require(child_process)');
      if (!importDefaultFwd) problems.push('red/ 没点出动态 import() 默认导出转发');
      if (!computedAdapter) problems.push('red/ 没点出计算属性 Function.call/apply/bind 适配');
      if (!computedReflect) problems.push('red/ 没点出计算属性 Reflect.apply 适配');
      if (!execDynamicTmpl) problems.push('red/ 没点出 exec 动态模板命令');
      if (!execAliasDynamic) problems.push('red/ 没点出 exec 别名动态模板命令');
      if (!destructureDefault) problems.push('red/ 没点出解构默认值别名（exec: run = fallback）');
      if (!computedDestructure) problems.push('red/ 没点出计算键解构别名（["exec"]: run）');
      if (!arrayDestructure) problems.push('red/ 没点出数组解构别名（[run] = [cp.exec]）');
      if (!quotedDestructure) problems.push('red/ 没点出字符串键解构别名（"exec": run）');
      if (!commentDestructure) problems.push('red/ 没点出带注释的解构别名（exec /* comment */: run）');
      if (!assignDestructure) problems.push('red/ 没点出对象解构赋值（({ ["exec"]: run } = cp)）');
      if (!arrayAliasDestructure) problems.push('red/ 没点出数组解构别名链（[run] = [fn]）');
      if (!arrayParenDestructure) problems.push('red/ 没点出数组解构括号（[(cp.exec)]）');
      if (!arrayAssignDestructure) problems.push('red/ 没点出数组解构赋值（([run] = [cp.exec])）');
      if (!defaultAssignDestructure) problems.push('red/ 没点出动态 import default 解构赋值（({ default: cp } = await import)）');
      if (!execPathAssignDestructure) problems.push('red/ 没点出 process.execPath 解构赋值（({ execPath: nodePath } = process)）');
      if (!computedConcatObjKey) problems.push('red/ 没点出拼接计算键对象转发（["r"+"un"]）');
      if (!argvPush) problems.push('red/ 没点出 argv.push 调用前变更');
      if (!forOfArrayDestructure) problems.push('red/ 没点出 for-of 数组解构（for (const [run] of [[cp.exec]])）');
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
