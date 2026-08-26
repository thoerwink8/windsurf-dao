#!/usr/bin/env node
// 纯函数：bump(当前版本号, 语义类型) → { shouldBump, bumpType, from, to }
// 无 IO、无第三方依赖。类型由调用方判断，这里不解析 commit 消息。
// 判据：feat→minor、fix→patch、breaking→major、其他→不 bump。
// breaking 与 feat 同现取 major。非法 semver 不 throw，error 字段说明。

export function parseSemver(input) {
  const raw = String(input ?? '').trim();
  const m = raw.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw };
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
