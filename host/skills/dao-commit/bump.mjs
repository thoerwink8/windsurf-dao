#!/usr/bin/env node
// 纯函数：bump(当前版本号, 语义类型) → { shouldBump, bumpType, from, to }
// 无 IO、无第三方依赖。类型由调用方判断，这里不解析 commit 消息。
// 判据：feat→minor、fix→patch、breaking→major、其他→不 bump。
// breaking 与 feat 同现取 major。非法 semver 不 throw，error 字段说明。
//
// 语法契约（SemVer 2.0.0 + 可选 v 前缀；检查器自持同一套，不 import 本文件）：
// 合法：1.2.3 / 1.2.3-beta.1 / 1.2.3+build.7
// 非法：01.2.3（核心段前导零）/ 1.2.3-（空标识）/ 1.2.3-01（数字预发布前导零）

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

export function parseSemver(input) {
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
  let build = [];
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

function normalizeTypes(semanticType) {
  if (semanticType == null || semanticType === '') return [];
  if (Array.isArray(semanticType)) return semanticType.flatMap(normalizeTypes);
  return String(semanticType)
    .split(/[\s,+/]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function pickBumpType(types) {
  if (types.some((t) => t === 'breaking' || t === 'break' || t.endsWith('!'))) return 'major';
  if (types.includes('feat')) return 'minor';
  if (types.includes('fix')) return 'patch';
  return null;
}

export function bump(currentVersion, semanticType) {
  const parsed = parseSemver(currentVersion);
  if (!parsed) {
    return {
      shouldBump: false,
      bumpType: null,
      from: currentVersion == null ? currentVersion : String(currentVersion),
      to: null,
      error: 'invalid semver',
    };
  }
  const bumpType = pickBumpType(normalizeTypes(semanticType));
  if (!bumpType) {
    return { shouldBump: false, bumpType: null, from: parsed.raw, to: parsed.raw };
  }
  let { major, minor, patch } = parsed;
  if (bumpType === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bumpType === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return { shouldBump: true, bumpType, from: parsed.raw, to: `${major}.${minor}.${patch}` };
}

const invoked = String(process.argv[1] || '').replace(/\\/g, '/');
if (/(?:^|\/)bump\.mjs$/i.test(invoked)) {
  const version = process.argv[2];
  const types = process.argv.slice(3);
  if (!version || types.length === 0) {
    process.stderr.write('usage: node bump.mjs <version> <type>[,type...]\n');
    process.exit(2);
  }
  const result = bump(version, types.join(' '));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.error ? 1 : 0);
}
