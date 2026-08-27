// dao-check ㉗：版本号载体存在时，变化必须合法、不倒退。
//
// 只拦「乱 bump」（新号不是合法 SemVer，或比基线小）。不判「该不该 bump」——
// 语义判断是 AI 职责（#787 拍板 Q9=C）。
//
// 语法契约与 bump.mjs 相同（SemVer 2.0.0 + 可选 v 前缀），检查器自持实现，
// 不 import bump（自己查自己查不出错）：
// 合法：1.2.3 / 1.2.3-beta.1 / 1.2.3+build.7
// 非法：01.2.3（核心段前导零）/ 1.2.3-（空标识）/ 1.2.3-01（数字预发布前导零）
// 比较：SemVer 2.0.0 优先级（预发布低于同核心正式版；build 元数据不参与比较）。
//
// 三态必须分得开：
//   skip      —— 扫完确认无载体（package.json version / VERSION），本项不查变化
//   unscanned —— 没查成（没给根、git 探头失败、夹具目录不在）
//   ok/red    —— 载体在，变化合法或不合法
// 无载体必须是 skip 不是绿：把 skip 收成 ok，empty 夹具会抓到。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CARRIERS = [
  { rel: 'package.json', kind: 'package.json' },
  { rel: 'VERSION', kind: 'VERSION' },
];

function numericId(s) {
  if (s === '0') return 0;
  if (!/^[1-9][0-9]*$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function prereleaseId(s) {
  if (s === '') return null;
  if (/^[0-9]+$/.test(s)) {
    const n = numericId(s);
    if (n === null) return null;
    return { kind: 'n', n };
  }
  if (!/^[0-9A-Za-z-]+$/.test(s)) return null;
  return { kind: 's', s };
}

function buildId(s) {
  return s !== '' && /^[0-9A-Za-z-]+$/.test(s);
}

/** 独立解析：SemVer 2.0.0 + 可选 v 前缀。不 import bump.mjs。 */
export function parseCarrierVersion(input) {
  const raw = String(input ?? '').trim();
  const core = raw.replace(/^v/i, '');
  const m = core.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) return null;
  const major = numericId(m[1]);
  const minor = numericId(m[2]);
  const patch = numericId(m[3]);
  if (major === null || minor === null || patch === null) return null;
  let rest = m[4];
  const prerelease = [];
  const build = [];
  if (rest.startsWith('-')) {
    const plus = rest.indexOf('+');
    const pre = plus === -1 ? rest.slice(1) : rest.slice(1, plus);
    rest = plus === -1 ? '' : rest.slice(plus);
    if (pre === '') return null;
    for (const id of pre.split('.')) {
      const p = prereleaseId(id);
      if (!p) return null;
      prerelease.push(p);
    }
  }
  if (rest.startsWith('+')) {
    const meta = rest.slice(1);
    if (meta === '') return null;
    for (const id of meta.split('.')) {
      if (!buildId(id)) return null;
      build.push(id);
    }
  } else if (rest !== '') return null;
  return { major, minor, patch, prerelease, build, raw };
}

function cmpPre(a, b) {
  const an = a.prerelease.length;
  const bn = b.prerelease.length;
  if (an === 0 && bn === 0) return 0;
  if (an === 0) return 1;
  if (bn === 0) return -1;
  const n = Math.max(an, bn);
  for (let i = 0; i < n; i++) {
    if (i >= an) return -1;
    if (i >= bn) return 1;
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x.kind === 'n' && y.kind === 'n') {
      if (x.n !== y.n) return x.n - y.n;
      continue;
    }
    if (x.kind === 'n') return -1;
    if (y.kind === 'n') return 1;
    if (x.s !== y.s) return x.s < y.s ? -1 : 1;
  }
  return 0;
}

/** SemVer 2.0.0 优先级：build 不参与。任一侧非法返回 null。 */
export function compareCarrierVersion(left, right) {
  const a = typeof left === 'object' && left && 'major' in left ? left : parseCarrierVersion(left);
  const b = typeof right === 'object' && right && 'major' in right ? right : parseCarrierVersion(right);
  if (!a || !b) return null;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return cmpPre(a, b);
}

function cmpVer(a, b) {
  return compareCarrierVersion(a, b);
}

/**
 * 从载体正文抽版本号。
 * package.json：合法 JSON 且 version 是字符串才算载体；JSON 坏了返回 {error}。
 * VERSION：第一行非空文本；空文件返回空串（随后当非法号）。
 */
export function extractVersion(text, kind) {
  if (kind === 'package.json') {
    try {
      const j = JSON.parse(String(text ?? ''));
      if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 'package.json 根不是对象' };
      if (typeof j.version !== 'string') return null;
      return j.version;
    } catch {
      return { error: 'package.json 不是合法 JSON' };
    }
  }
  const line = String(text ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return line || '';
}

/** 比较一对版本字符串。oldRaw=null 表示基线没有这个载体。 */
export function inspectVersionChange({ oldRaw, newRaw } = {}) {
  if (newRaw == null && oldRaw == null) {
    return { ok: true, skip: true, unscanned: false, reason: '无版本号' };
  }
  if (newRaw == null) {
    return { ok: true, skip: true, unscanned: false, reason: '载体已删除' };
  }
  const newer = parseCarrierVersion(newRaw);
  if (!newer) {
    return { ok: false, skip: false, unscanned: false, problems: [`新版本非法: ${JSON.stringify(newRaw)}`] };
  }
  if (oldRaw == null || oldRaw === '') {
    return { ok: true, skip: false, unscanned: false, from: null, to: newer.raw };
  }
  const older = parseCarrierVersion(oldRaw);
  if (!older) {
    return { ok: true, skip: false, unscanned: false, from: String(oldRaw), to: newer.raw, reason: '旧版非法已改为合法' };
  }
  if (cmpVer(newer, older) < 0) {
    return {
      ok: false,
      skip: false,
      unscanned: false,
      problems: [`版本号倒退 ${older.raw} → ${newer.raw}`],
    };
  }
  return { ok: true, skip: false, unscanned: false, from: older.raw, to: newer.raw };
}

export function loadCarriers(dir) {
  if (!dir) return [];
  const found = [];
  for (const spec of CARRIERS) {
    const p = join(dir, spec.rel);
    if (!existsSync(p)) continue;
    found.push({ rel: spec.rel, kind: spec.kind, text: readFileSync(p, 'utf8') });
  }
  return found;
}

/**
 * current / previous: [{rel, kind, text}, ...]
 * 没给数组 = 没查成；两个都空 = skip。
 */
export function inspectCarriers({ current, previous } = {}) {
  if (!Array.isArray(current) || !Array.isArray(previous)) {
    return { ok: false, skip: false, unscanned: true, error: '没给 current/previous 清单（没查成）' };
  }
  if (current.length === 0 && previous.length === 0) {
    return { ok: true, skip: true, unscanned: false, reason: '无版本号载体' };
  }
  const problems = [];
  const prevMap = new Map(previous.map((c) => [c.rel, c]));
  for (const cur of current) {
    const extracted = extractVersion(cur.text, cur.kind);
    if (extracted && typeof extracted === 'object' && extracted.error) {
      problems.push(`${cur.rel}: ${extracted.error}`);
      continue;
    }
    if (extracted == null) continue;
    const prev = prevMap.get(cur.rel);
    let oldRaw = null;
    if (prev) {
      const oldExtracted = extractVersion(prev.text, prev.kind);
      if (oldExtracted && typeof oldExtracted === 'object' && oldExtracted.error) oldRaw = null;
      else oldRaw = oldExtracted;
    }
    const r = inspectVersionChange({ oldRaw, newRaw: extracted });
    if (!r.ok) problems.push(...(r.problems || []).map((p) => `${cur.rel}: ${p}`));
  }
  if (current.length > 0 && current.every((c) => {
    const extracted = extractVersion(c.text, c.kind);
    return extracted == null;
  }) && previous.length === 0) {
    return { ok: true, skip: true, unscanned: false, reason: '无版本号载体' };
  }
  return {
    ok: problems.length === 0,
    skip: false,
    unscanned: false,
    problems,
    scanned: current.length,
  };
}

export function inspectCarrierDir(dir) {
  if (!dir) return { ok: false, skip: false, unscanned: true, error: '没给目录（没查成）' };
  if (!existsSync(dir)) return { ok: false, skip: false, unscanned: true, error: `目录不在：${dir}` };
  const current = loadCarriers(dir);
  const baseDir = join(dir, 'base');
  const previous = existsSync(baseDir) ? loadCarriers(baseDir) : [];
  return inspectCarriers({ current, previous });
}

/** 夹具判别力：red 必须抓倒退/非法、ok 必须绿、empty 必须 SKIP（无载体，不是绿）。 */
export function inspectVersionCarrierFixtures(root) {
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
    const r = inspectCarrierDir(dir);
    if (kind === 'empty') {
      if (r.unscanned || !r.skip) problems.push(`empty/ 应 SKIP（无载体）但判成 skip=${r.skip} ok=${r.ok} unscanned=${r.unscanned}`);
      else kinds.empty += 1;
    } else if (kind === 'red') {
      if (r.unscanned || r.skip || r.ok) problems.push(`red/ 自称该红但判成 ${JSON.stringify({ ok: r.ok, skip: r.skip, unscanned: r.unscanned, problems: r.problems })}`);
      else kinds.red += 1;
    } else if (kind === 'ok') {
      if (r.unscanned || r.skip || !r.ok) problems.push(`ok/ 自称该绿但判成 ${JSON.stringify({ ok: r.ok, skip: r.skip, unscanned: r.unscanned, problems: r.problems })}`);
      else kinds.ok += 1;
    }
  }
  if (kinds.red === 0 || kinds.ok === 0 || kinds.empty === 0) {
    return { ok: false, unscanned: true, error: `样本种类不够 red=${kinds.red} ok=${kinds.ok} empty=${kinds.empty}`, kinds, problems };
  }
  if (problems.length) return { ok: false, unscanned: false, error: problems[0], kinds, problems };
  return { ok: true, unscanned: false, kinds };
}

function gitMergeBase(cwd) {
  for (const ref of ['origin/master', 'master']) {
    const r = spawnSync('git', ['merge-base', 'HEAD', ref], { encoding: 'utf8', cwd, windowsHide: true });
    if (r.status === 0 && String(r.stdout || '').trim()) return String(r.stdout).trim();
  }
  return null;
}

function gitShowFile(cwd, sha, rel) {
  const spec = `${sha}:${String(rel).replace(/\\/g, '/')}`;
  const r = spawnSync('git', ['show', spec], { encoding: 'utf8', cwd, windowsHide: true });
  if (r.status === 0) return r.stdout;
  const err = String(r.stderr || r.stdout || '');
  if (/does not exist|exists on disk, but not in|not in the working tree|bad object/i.test(err)) return null;
  return { error: err.trim().slice(0, 160) || `git show ${spec} exit ${r.status}` };
}

/**
 * live：读仓库根载体，与 merge-base 上的同名文件比。
 * gitShow(sha, rel) → string | null | {error}
 * mergeBaseSha → string | null，或无参函数。
 */
export function inspectLiveVersionCarriers({ root, gitShow, mergeBaseSha } = {}) {
  if (!root) return { ok: false, skip: false, unscanned: true, error: '没给仓库根（没查成）' };
  if (typeof gitShow !== 'function') {
    return { ok: false, skip: false, unscanned: true, error: '没给 gitShow 探头（没查成）' };
  }
  const current = loadCarriers(root);
  if (current.length === 0) {
    return { ok: true, skip: true, unscanned: false, reason: '无版本号载体' };
  }
  const base = typeof mergeBaseSha === 'function' ? mergeBaseSha() : mergeBaseSha;
  if (!base) {
    return { ok: false, skip: false, unscanned: true, error: 'merge-base 没查成（不是没问题）' };
  }
  const previous = [];
  for (const c of current) {
    const oldText = gitShow(base, c.rel);
    if (oldText && typeof oldText === 'object' && oldText.error) {
      return { ok: false, skip: false, unscanned: true, error: `git show ${c.rel} 失败：${oldText.error}` };
    }
    if (typeof oldText === 'string') previous.push({ rel: c.rel, kind: c.kind, text: oldText });
  }
  return inspectCarriers({ current, previous });
}

export function inspectLiveAt(root) {
  return inspectLiveVersionCarriers({
    root,
    mergeBaseSha: () => gitMergeBase(root),
    gitShow: (sha, rel) => gitShowFile(root, sha, rel),
  });
}
