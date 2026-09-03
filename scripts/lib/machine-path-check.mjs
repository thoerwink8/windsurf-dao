// 仓外路径闸（dao-check 第 ⑳ 项，issue #642）。
//
// 病：换机靠人脑记本机私货；新 CLI / 新家目录没有固定入口。
// 闸：仓里出现的仓外路径必须进 host/machine/INDEX.md 或带 why 的 ignore。
// 夹只装 B 类模板 + INDEX，不镜像 ~。
//
// 两套独立逻辑，禁止互相调用：
//   scanRepoPaths —— 只认路径字面量，不读 INDEX / ignore。
//   parseCatalog  —— 只读 INDEX / ignore 表格，不扫仓库。
// 自己查自己查不出错：扫描器不复用目录自己的解析。
//
// 零样本：扫到 0 条路径 = 没查成（红），不是「0 条漏」。
// 对账：发现集合必须等于 INDEX∪ignore；对不上就红。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const INDEX_REL = 'host/machine/INDEX.md';
export const IGNORE_REL = 'host/machine/ignore.md';

// 目录自己和闸的实现/单测里全是正则与示例，扫进去会把 ~/AppData/i、~/.secret
// 当成仓外路径。夹具仍扫：红样本 ~/.brand-new-cli 在独立根上验。
export const SKIP_RELS = new Set([
  INDEX_REL,
  IGNORE_REL,
  'scripts/lib/machine-path-check.mjs',
  'tests/machine-path.test.js',
  // CHANGELOG 由发布列车（#800）从**历史提交标题**自动生成：历史里提过的仓外路径会被当成
  // 「仓里新出现的指针」反复报红，而那些路径往往早已随代码删掉，人再也修不掉它。
  // 它是生成物不是代码，扫它只产出机器自己制造的红——2026-09-04 实咬：v0.1.0 一发布，
  // 历史标题里的 ~/.codex/skills 让每张在途 PR 的 CI 全红。
  'CHANGELOG.md',
]);

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|zip|7z|gz|exe|dll|pdb|bin|wasm)$/i;

const B_TEMPLATES = [
  'host/machine/shims/grok',
  'host/machine/shims/agent',
];

/** 把各种家目录写法收成同一把钥匙。扫描器和目录解析共用这一步，但不共用「去哪找字」。 */
export function normalizeKey(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  s = s.replace(/\\/g, '/');
  s = s.replace(/^[`'"]+|[`'"]+$/g, '');
  s = s.replace(/[.,;:]+$/g, '');
  s = s.replace(/\/+$/g, '');

  if (s === 'os.homedir()' || s === 'homedir()') return 'os.homedir()';
  if (/^process\.env\.(HOME|USERPROFILE)$/i.test(s)) return 'process.env.HOME';

  s = s.replace(/^%USERPROFILE%/i, '~');
  s = s.replace(/^\$HOME(?=\/|$)/i, '~');
  s = s.replace(/^\$env:USERPROFILE/i, '~');
  s = s.replace(/^\$env:HOME(?=\/|$)/i, '~');
  s = s.replace(/^%LOCALAPPDATA%/i, '~/AppData/Local');
  s = s.replace(/^%APPDATA%/i, '~/AppData/Roaming');
  s = s.replace(/^[A-Za-z]:\/Users\/[^/]+/i, '~');
  s = s.replace(/^\/[A-Za-z]\/Users\/[^/]+/i, '~');
  s = s.replace(/^\/Users\/[^/]+/i, '~');
  s = s.replace(/^\/home\/[^/]+/i, '~');

  if (s === '~' || s === '~/') return null;
  if (!s.startsWith('~/')) return s;

  const parts = s.slice(2).split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0] === 'AppData' && parts.length >= 3) {
    return `~/AppData/${parts[1]}/${parts[2]}`;
  }
  if (parts.length === 1) return `~/${parts[0]}`;
  return `~/${parts[0]}/${parts[1]}`;
}

function isCatalogKey(key) {
  return key.startsWith('~/') || key === 'os.homedir()' || key === 'process.env.HOME';
}

function addKey(set, raw) {
  const key = normalizeKey(raw);
  if (key) set.add(key);
}

const SEG = String.raw`[A-Za-z0-9._\-@*]+`;
const TAIL = String.raw`(?:[\\/]${SEG})*`;

/** 扫描器：只从正文抽仓外路径，不碰 INDEX。 */
export function scanText(text) {
  const found = new Set();
  const src = String(text || '');
  let m;

  const tilde = new RegExp(`~[\\\\/]${SEG}${TAIL}`, 'g');
  while ((m = tilde.exec(src))) addKey(found, m[0]);

  const winEnv = new RegExp(`%(?:USERPROFILE|APPDATA|LOCALAPPDATA)%[\\\\/]${SEG}${TAIL}`, 'gi');
  while ((m = winEnv.exec(src))) addKey(found, m[0]);

  const dollarHome = new RegExp(`\\$HOME[\\\\/]${SEG}${TAIL}`, 'g');
  while ((m = dollarHome.exec(src))) addKey(found, m[0]);

  const psEnv = new RegExp(`\\$env:(?:USERPROFILE|HOME)[\\\\/]${SEG}${TAIL}`, 'gi');
  while ((m = psEnv.exec(src))) addKey(found, m[0]);

  const joinPath = /Join-Path\s+\$env:(?:USERPROFILE|HOME)\s+['"]([^'"]+)['"]/gi;
  while ((m = joinPath.exec(src))) addKey(found, `~/${m[1]}`);

  const joinHome = /join\(\s*(?:os\.)?homedir\(\)\s*((?:\s*,\s*['"][^'"]+['"])+)/g;
  while ((m = joinHome.exec(src))) {
    const segs = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
    addKey(found, `~/${segs.join('/')}`);
  }

  if (/(?:os\.)?homedir\(\)/.test(src) && !/join\(\s*(?:os\.)?homedir\(\)/.test(src)) {
    addKey(found, 'os.homedir()');
  }

  if (/process\.env\.(?:HOME|USERPROFILE)/.test(src)) addKey(found, 'process.env.HOME');

  const winUser = /[A-Za-z]:\\Users\\[A-Za-z0-9._\-@*]+\\[A-Za-z0-9._\-@*]+(?:\\[A-Za-z0-9._\-@*]+)*/g;
  while ((m = winUser.exec(src))) addKey(found, m[0]);

  const slashUser = /\/[A-Za-z]\/Users\/[A-Za-z0-9._\-@*]+\/[A-Za-z0-9._\-@*]+(?:\/[A-Za-z0-9._\-@*]*)*/g;
  while ((m = slashUser.exec(src))) addKey(found, m[0]);

  return found;
}

function isSkipRel(rel) {
  const n = String(rel || '').replace(/\\/g, '/');
  if (SKIP_RELS.has(n)) return true;
  return false;
}

function isTextRel(rel) {
  if (BINARY_EXT.test(rel)) return false;
  return true;
}

function walkDir(dir, prefix, acc) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const p = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkDir(p, rel, acc);
    else if (st.isFile()) acc.push(rel.replace(/\\/g, '/'));
  }
  return acc;
}

function gitToplevel(root) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', cwd: root });
  if (r.status !== 0) return null;
  return String(r.stdout || '').trim().replace(/\\/g, '/');
}

function listTracked(root, tracked) {
  if (Array.isArray(tracked)) return { files: tracked.map(f => String(f).replace(/\\/g, '/')) };
  if (!existsSync(root)) return { unscanned: true, error: `根目录不在: ${root}` };
  const top = gitToplevel(root);
  const here = resolve(root).replace(/\\/g, '/');
  if (top && top.toLowerCase() === here.toLowerCase()) {
    const r = spawnSync('git', ['ls-files'], { encoding: 'utf8', cwd: root });
    if (r.status === 0) return { files: String(r.stdout || '').split(/\r?\n/).filter(Boolean) };
  }
  return { files: walkDir(root, '', []) };
}

function readRel(root, rel, files) {
  const n = String(rel).replace(/\\/g, '/');
  if (files && Object.prototype.hasOwnProperty.call(files, n)) return { text: files[n], rel: n };
  const p = join(root || '', n);
  if (!existsSync(p)) return { missing: true, rel: n, path: p };
  try {
    const buf = readFileSync(p);
    if (buf.includes(0)) return { skip: true, rel: n };
    return { text: buf.toString('utf8'), rel: n, path: p };
  } catch (e) {
    return { missing: true, rel: n, path: p, error: String(e.message || e) };
  }
}

/** 扫仓库（或夹具）正文。不读 INDEX / ignore。 */
export function scanRepoPaths({ root, files, tracked } = {}) {
  if (!root && !files) return { unscanned: true, error: '没给仓库根', keys: new Set(), hits: [] };
  const listed = listTracked(root || '', tracked);
  if (listed.unscanned) return { unscanned: true, error: listed.error, keys: new Set(), hits: [] };
  if (!listed.files.length) return { unscanned: true, error: '追踪面 0 个文件', keys: new Set(), hits: [] };

  const keys = new Set();
  const hits = [];
  let scanned = 0;
  for (const rel of listed.files) {
    const n = rel.replace(/\\/g, '/');
    if (isSkipRel(n) || !isTextRel(n)) continue;
    const got = readRel(root || '', n, files);
    if (got.skip || got.missing || got.text == null) continue;
    scanned += 1;
    const found = scanText(got.text);
    for (const key of found) {
      keys.add(key);
      hits.push({ rel: n, key });
    }
  }
  if (scanned === 0) return { unscanned: true, error: '一个文本文件都没扫到', keys: new Set(), hits: [] };
  return { keys, hits, scanned };
}

function parseTableRows(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/^\|/.test(line)) continue;
    if (/^\|\s*:?-{3,}/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (!cells.length) continue;
    if (cells[0] === '类' || cells[0] === '路径') continue;
    rows.push(cells);
  }
  return rows;
}

/** 目录解析：只读表格，不扫仓库。 */
export function parseIndex(text) {
  const keys = new Set();
  // E 类（他仓真相源）：本仓不写它的装法，仓里正常扫不到这条路径。它照样进 keys
  //（仓里万一提到不算漏登记），但不参与 stale 反查——否则「登记了必须仓里出现」
  // 会把 E 类的存在意义直接判红。
  const softKeys = new Set();
  const problems = [];
  if (text == null) return { missing: true, keys, softKeys, problems };
  for (const cells of parseTableRows(text)) {
    const klass = cells[0] || '';
    const isSoft = klass.replace(/s/g, '').split('/').includes('E');
    const raw = (cells[1] || '').replace(/^`|`$/g, '').trim();
    if (!raw) continue;
    if (!/^[A-E](?:\/[A-E])*$/.test(klass.replace(/\s/g, ''))) {
      problems.push(`INDEX 类不合法: ${klass} (${raw})`);
    }
    const key = normalizeKey(raw);
    if (!key || !isCatalogKey(key)) continue;
    keys.add(key);
    if (isSoft) softKeys.add(key);
  }
  return { keys, softKeys, problems };
}

export function parseIgnore(text) {
  const keys = new Set();
  const problems = [];
  if (text == null) return { missing: true, keys, problems };
  for (const cells of parseTableRows(text)) {
    const raw = (cells[0] || '').replace(/^`|`$/g, '').trim();
    const why = (cells[1] || '').trim();
    if (!raw) continue;
    if (!why || why === 'why' || why === '—' || why === '-') {
      problems.push(`ignore 缺 why: ${raw}`);
      continue;
    }
    const key = normalizeKey(raw);
    if (!key || !isCatalogKey(key)) {
      problems.push(`ignore 路径收不成钥匙: ${raw}`);
      continue;
    }
    keys.add(key);
  }
  return { keys, problems };
}

export function inspectMachinePaths({ found, indexKeys, ignoreKeys, softKeys, catalogProblems } = {}) {
  const problems = [...(catalogProblems || [])];
  const foundSet = found instanceof Set ? found : new Set(found || []);
  const indexSet = indexKeys instanceof Set ? indexKeys : new Set(indexKeys || []);
  const ignoreSet = ignoreKeys instanceof Set ? ignoreKeys : new Set(ignoreKeys || []);
  const declared = new Set([...indexSet, ...ignoreSet]);

  if (foundSet.size === 0) {
    return { kind: 'unscanned', line: '仓外路径扫到 0 条——本次没查成，不是 0 条漏', problems };
  }

  const leaks = [...foundSet].filter(k => !declared.has(k)).sort();
  const softSet = softKeys instanceof Set ? softKeys : new Set(softKeys || []);
  const stale = [...declared].filter(k => !foundSet.has(k) && !softSet.has(k)).sort();
  if (leaks.length) problems.push(`仓里有、目录没有: ${leaks.join(' ')}`);
  if (stale.length) problems.push(`目录有、仓里没有: ${stale.join(' ')}`);

  if (problems.length) {
    return {
      kind: 'red',
      line: `仓外路径闸对不上 ${problems.length} 处（扫到 ${foundSet.size}，INDEX ${indexSet.size}，ignore ${ignoreSet.size}）`,
      problems,
      leaks,
      stale,
    };
  }
  return {
    kind: 'ok',
    line: `仓外路径闸齐：扫到 ${foundSet.size} 条，INDEX ${indexSet.size} / ignore ${ignoreSet.size}，0 条漏`,
    leaks,
    stale,
  };
}

function checkBTemplates(root, files) {
  const problems = [];
  for (const rel of B_TEMPLATES) {
    const got = readRel(root || '', rel, files);
    if (got.missing || got.text == null) problems.push(`缺 B 模板 ${rel}`);
  }
  return problems;
}

/** #633：for /f in ('dir') 和 findstr 各开一个可见 cmd。读临时文件的 for /f 不算。rem 注释不算。 */
export function cmdShimVisibleWindowProblems(rel, text) {
  const problems = [];
  const src = String(text || '').split(/\r?\n/)
    .filter(line => !/^\s*(rem\b|::)/i.test(line))
    .join('\n');
  if (/for\s+\/f\b[\s\S]{0,120}in\s*\('/i.test(src)) {
    problems.push(`${rel} 禁止 for /f in ('...')：子进程会弹可见 cmd`);
  }
  if (/\bfindstr\b/i.test(src)) {
    problems.push(`${rel} 禁止 findstr：管道会弹可见 cmd`);
  }
  return problems;
}

/**
 * @returns {{green?: string, fail?: [string, string, string], kind?: string, scanned?: number}}
 */
export function checkMachinePaths({ root, files, tracked } = {}) {
  if (!root && !files) return { fail: ['没给仓库根', 'checkMachinePaths 要 root', ''] };

  const scan = scanRepoPaths({ root, files, tracked });
  if (scan.unscanned) {
    return {
      fail: [
        '仓外路径闸没查成',
        '本次等于没扫：确认在 git 仓库里跑，或夹具里要有文本文件',
        scan.error || '',
      ],
      kind: 'unscanned',
    };
  }

  const indexFile = readRel(root || '', INDEX_REL, files);
  const ignoreFile = readRel(root || '', IGNORE_REL, files);
  if (indexFile.missing) {
    return {
      fail: [
        `仓外路径地图不在：${INDEX_REL}`,
        '建 INDEX.md（A/B/C/D 表），0 个目录 = 没查成',
        indexFile.path || INDEX_REL,
      ],
    };
  }
  if (ignoreFile.missing) {
    return {
      fail: [
        `仓外路径忽略表不在：${IGNORE_REL}`,
        '建 ignore.md，每条必须有 why',
        ignoreFile.path || IGNORE_REL,
      ],
    };
  }

  const index = parseIndex(indexFile.text);
  const ignore = parseIgnore(ignoreFile.text);
  const catalogProblems = [...index.problems, ...ignore.problems];
  const inspected = inspectMachinePaths({
    found: scan.keys,
    indexKeys: index.keys,
    ignoreKeys: ignore.keys,
    softKeys: index.softKeys,
    catalogProblems,
  });

  const hasShims = files
    ? Object.keys(files).some(k => k.replace(/\\/g, '/').startsWith('host/machine/shims/'))
    : existsSync(join(root || '', 'host', 'machine', 'shims'));
  const templateProblems = hasShims ? checkBTemplates(root, files) : [];
  if (inspected.kind === 'unscanned') {
    return { fail: [inspected.line, '扫描器必须能从仓里抽出仓外路径', '0 条'], kind: 'unscanned' };
  }
  if (inspected.kind === 'red' || templateProblems.length) {
    const all = [...(inspected.problems || []), ...templateProblems];
    return {
      fail: [
        `仓外路径闸红 ${all.length} 处`,
        '仓里出现的 ~/ $HOME os.homedir() 必须进 INDEX 或带 why 的 ignore；B 模板（POSIX shim）必须在',
        all.slice(0, 8).join('；'),
      ],
      kind: 'red',
      scanned: scan.scanned,
    };
  }
  return { green: inspected.line, kind: 'ok', scanned: scan.scanned, keys: scan.keys };
}
