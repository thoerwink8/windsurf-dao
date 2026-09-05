// dao-check ㉗：版本号载体存在时，变化必须合法、不倒退。
//
// 只拦「乱 bump」（新号不是合法 SemVer，或比基线小）。不判「该不该 bump」——
// 语义判断是 AI 职责（#787 拍板 Q9=C）。
//
// 语法契约与 bump.mjs 相同（SemVer 2.0.0 + 可选 v 前缀），检查器自持实现，
// 不 import bump（自己查自己查不出错）：
// 合法：1.2.3 / 1.2.3-beta.1 / 1.2.3+build.7 / 9007199254740992.0.0
// 非法：01.2.3（核心段前导零）/ 1.2.3-（空标识）/ 1.2.3-01（数字预发布前导零）
// 比较：SemVer 2.0.0 优先级（预发布低于同核心正式版；build 元数据不参与比较）。
// 数字标识符无上限：规范化十进制字符串按长度再字典序，不转 Number。
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
  if (s === '0') return '0';
  if (!/^[1-9][0-9]*$/.test(s)) return null;
  return s;
}

function cmpDec(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return x.length - y.length;
  if (x === y) return 0;
  return x < y ? -1 : 1;
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
      const c = cmpDec(x.n, y.n);
      if (c !== 0) return c;
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
  const maj = cmpDec(a.major, b.major);
  if (maj !== 0) return maj;
  const min = cmpDec(a.minor, b.minor);
  if (min !== 0) return min;
  const pat = cmpDec(a.patch, b.patch);
  if (pat !== 0) return pat;
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

// ── 溯源（#800 发布列车）：新规则下「乱 bump」= 在非发布提交上动版本号 ──────────
// 合并只进列车，版本号只由发布动作产生。载体真变了，改动它的每个提交都必须是
// release 提交（release: 前缀）或被 tag 指到，否则红。老的「不倒退/合法」校验照旧。

/** 提交是不是发布提交：剥掉开头的宿主标 [cc] 等，核心以 release: / release(scope): 开头。 */
export function isReleaseCommit(subject) {
  const core = String(subject ?? '').trim().replace(/^(?:\[[^\]]*\]\s*)+/, '');
  return /^release[:(]/i.test(core);
}

/**
 * 载体从 oldRaw 变到 newRaw：改动它的提交必须全是发布提交或带 tag。
 * changingCommits: [{subject, tagged}]，merge-base..HEAD 里改过该载体的提交。
 *   null/undefined = 没查成（载体变了却拿不到改动提交，不当没问题）。
 * 载体没变 = skip（正常提交不该动版本号，这是常态）。
 */
export function inspectCarrierProvenance({ oldRaw, newRaw, changingCommits } = {}) {
  const changed = String(oldRaw ?? '') !== String(newRaw ?? '');
  if (!changed) return { ok: true, skip: true, unscanned: false, reason: '载体未变' };
  if (changingCommits == null) {
    return { ok: false, skip: false, unscanned: true, error: '载体变了但没给改动提交清单（没查成）' };
  }
  const list = Array.isArray(changingCommits) ? changingCommits : [];
  const offenders = list.filter((c) => c && !c.tagged && !isReleaseCommit(c.subject));
  if (offenders.length) {
    return {
      ok: false,
      skip: false,
      unscanned: false,
      problems: offenders.map((c) => `非发布提交动了版本号：${String(c.subject || '').slice(0, 80)}`),
    };
  }
  return { ok: true, skip: false, unscanned: false, scanned: list.length };
}

/** 溯源夹具单目录：从 VERSION/base/VERSION 取 old→new，从 commits.json 取改动提交。 */
export function inspectProvenanceDir(dir) {
  if (!dir || !existsSync(dir)) return { ok: false, skip: false, unscanned: true, error: `目录不在：${dir}` };
  const cur = loadCarriers(dir);
  if (cur.length === 0) return { ok: false, skip: false, unscanned: true, error: '夹具无载体' };
  const one = cur[0];
  const newExtracted = extractVersion(one.text, one.kind);
  const newRaw = newExtracted && typeof newExtracted === 'object' ? null : newExtracted;
  const baseDir = join(dir, 'base');
  let oldRaw = null;
  if (existsSync(baseDir)) {
    const prev = loadCarriers(baseDir).find((p) => p.rel === one.rel);
    if (prev) {
      const oldExtracted = extractVersion(prev.text, prev.kind);
      oldRaw = oldExtracted && typeof oldExtracted === 'object' ? null : oldExtracted;
    }
  }
  const cjson = join(dir, 'commits.json');
  let commits = null;
  if (existsSync(cjson)) {
    try {
      commits = JSON.parse(readFileSync(cjson, 'utf8'));
    } catch {
      commits = null;
    }
  }
  return inspectCarrierProvenance({ oldRaw, newRaw, changingCommits: commits });
}

/**
 * 溯源夹具判别力（三态）：
 *   nonrelease-red —— 载体前进但被非发布提交改动 → 红
 *   release-ok     —— 载体前进且改动全在发布提交/tag 上 → 绿
 *   unchanged-skip —— 载体未变 → skip（正常提交不动版本号）
 */
export function inspectCarrierProvenanceFixtures(root) {
  if (!root) return { ok: false, unscanned: true, error: '没给样本根目录' };
  if (!existsSync(root)) return { ok: false, unscanned: true, error: `样本目录不在：${root}` };
  const kinds = { red: 0, ok: 0, skip: 0 };
  const problems = [];
  const specs = [
    ['nonrelease-red', 'red'],
    ['release-ok', 'ok'],
    ['unchanged-skip', 'skip'],
  ];
  for (const [name, expect] of specs) {
    const dir = join(root, name);
    if (!existsSync(dir)) {
      problems.push(`缺 ${name}/`);
      continue;
    }
    const r = inspectProvenanceDir(dir);
    if (expect === 'red') {
      if (r.unscanned || r.skip || r.ok) problems.push(`${name}/ 该红但判成 ${JSON.stringify({ ok: r.ok, skip: r.skip, unscanned: r.unscanned })}`);
      else kinds.red += 1;
    } else if (expect === 'ok') {
      if (r.unscanned || r.skip || !r.ok) problems.push(`${name}/ 该绿但判成 ${JSON.stringify({ ok: r.ok, skip: r.skip, unscanned: r.unscanned, problems: r.problems })}`);
      else kinds.ok += 1;
    } else {
      if (r.unscanned || !r.skip) problems.push(`${name}/ 该 skip（未变）但判成 ${JSON.stringify({ ok: r.ok, skip: r.skip, unscanned: r.unscanned })}`);
      else kinds.skip += 1;
    }
  }
  if (kinds.red === 0 || kinds.ok === 0 || kinds.skip === 0) {
    return { ok: false, unscanned: true, error: `样本种类不够 red=${kinds.red} ok=${kinds.ok} skip=${kinds.skip}`, kinds, problems };
  }
  if (problems.length) return { ok: false, unscanned: false, error: problems[0], kinds, problems };
  return { ok: true, unscanned: false, kinds };
}

function gitMergeBase(cwd) {
  for (const ref of ['origin/master', 'master']) {
    const r = spawnSync('git', ['merge-base', 'HEAD', ref], { windowsHide: true, encoding: 'utf8', cwd });
    if (r.status === 0 && String(r.stdout || '').trim()) return String(r.stdout).trim();
  }
  return null;
}

function gitShowFile(cwd, sha, rel) {
  const spec = `${sha}:${String(rel).replace(/\\/g, '/')}`;
  const r = spawnSync('git', ['show', spec], { windowsHide: true, encoding: 'utf8', cwd });
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

/** merge-base..HEAD 里改过 rel 的提交（含是否被 tag 指到）。git 失败返回 {error}。 */
function gitLogTouching(cwd, base, rel) {
  const path = String(rel).replace(/\\/g, '/');
  const r = spawnSync('git', ['-C', cwd, 'log', `${base}..HEAD`, '--format=%H%x1f%s', '--', path], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) return { error: String(r.stderr || r.stdout || `git log exit ${r.status}`).trim().slice(0, 160) };
  const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const [sha, subject] = line.split('\x1f');
    const t = spawnSync('git', ['-C', cwd, 'tag', '--points-at', sha], { windowsHide: true, encoding: 'utf8' });
    const tagged = t.status === 0 && String(t.stdout || '').trim().length > 0;
    out.push({ sha, subject: subject || '', tagged });
  }
  return out;
}

export function inspectLiveAt(root) {
  const base = inspectLiveVersionCarriers({
    root,
    mergeBaseSha: () => gitMergeBase(root),
    gitShow: (sha, rel) => gitShowFile(root, sha, rel),
  });
  // 无载体 / 没查成 / 已经红了：溯源不再叠加，直接回。
  if (base.skip || base.unscanned || !base.ok) return base;
  // 载体在且合法：再核溯源——载体的任何变化只允许出现在发布提交/tag 上。
  const mb = gitMergeBase(root);
  if (!mb) return { ok: false, skip: false, unscanned: true, error: '溯源 merge-base 没查成' };
  for (const c of loadCarriers(root)) {
    const oldText = gitShowFile(root, mb, c.rel);
    if (oldText && typeof oldText === 'object' && oldText.error) {
      return { ok: false, skip: false, unscanned: true, error: `溯源 git show ${c.rel} 失败：${oldText.error}` };
    }
    const oldRaw = typeof oldText === 'string' ? extractVersion(oldText, c.kind) : null;
    const newRaw = extractVersion(c.text, c.kind);
    const oldStr = oldRaw && typeof oldRaw === 'object' ? null : oldRaw;
    const newStr = newRaw && typeof newRaw === 'object' ? null : newRaw;
    if (String(oldStr ?? '') === String(newStr ?? '')) continue;
    const commits = gitLogTouching(root, mb, c.rel);
    if (commits && typeof commits === 'object' && commits.error) {
      return { ok: false, skip: false, unscanned: true, error: `溯源 git log ${c.rel} 失败：${commits.error}` };
    }
    const prov = inspectCarrierProvenance({ oldRaw: oldStr, newRaw: newStr, changingCommits: commits });
    if (prov.unscanned) return { ok: false, skip: false, unscanned: true, error: `${c.rel}: ${prov.error}` };
    if (!prov.ok) return { ok: false, skip: false, unscanned: false, problems: (prov.problems || []).map((p) => `${c.rel}: ${p}`) };
  }
  return base;
}
