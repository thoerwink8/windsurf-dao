// dao-check ㉙：docs/release-policy.json 可解析且过 schema（issue #817）。
//
// 病：发布/确认/回滚/预算策略只写在散文里会过期；JSON 缺键或 bump 表漏类型时
// dao-check 照样绿。本项只验文件在、能解析、schema 齐。机制接入在 #800，
// 本检查不读任何将来的消费方解析器（自己查自己查不出错）。
//
// schema（#817）：四个顶层键齐（confirm/version/rollback/budget）、
// confirm 三级齐（patch/minor/major）、bump 表覆盖 conventional 类型、
// 每项目有 demo（kind）。不把配置值写进检查器。
//
// 三态必须分得开：
//   unscanned —— 没查成（文件不在 / JSON 坏了 / 根不是对象 / 四个顶层键一个都没有）
//   red       —— 扫到了策略但 schema 缺件（故意违规样本必须拦）
//   ok        —— 可解析且过 schema
// 「四个顶层键都没有」= 没查成，不是「查过没事」。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const POLICY_REL = 'docs/release-policy.json';
export const TOP_KEYS = ['confirm', 'version', 'rollback', 'budget'];
export const CONFIRM_LEVELS = ['patch', 'minor', 'major'];
export const BUMP_TYPES = ['fix', 'docs', 'chore', 'refactor', 'perf', 'feat', 'feat!', 'BREAKING CHANGE'];

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function ownKeys(obj) {
  return isPlainObject(obj) ? Object.keys(obj).filter((k) => !k.startsWith('_')) : [];
}

/** 独立 schema。不 import 任何 release-policy 消费方。 */
export function inspectReleasePolicy(doc) {
  if (!isPlainObject(doc)) {
    return { ok: false, unscanned: true, error: '根不是对象', problems: [], scanned: 0 };
  }
  const present = TOP_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(doc, k));
  if (present.length === 0) {
    return {
      ok: false,
      unscanned: true,
      error: '四个顶层键都没扫到（没查成，不是过）',
      problems: [],
      scanned: 0,
    };
  }

  const problems = [];
  for (const k of TOP_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(doc, k)) problems.push(`缺顶层键 ${k}`);
    else if (!isPlainObject(doc[k])) problems.push(`${k} 不是对象`);
  }

  const confirm = doc.confirm;
  if (isPlainObject(confirm)) {
    for (const lv of CONFIRM_LEVELS) {
      if (!Object.prototype.hasOwnProperty.call(confirm, lv)) problems.push(`confirm 缺 ${lv}`);
      else if (!isPlainObject(confirm[lv])) problems.push(`confirm.${lv} 不是对象`);
      else if (confirm[lv].who == null || String(confirm[lv].who).trim() === '') {
        problems.push(`confirm.${lv} 缺 who`);
      }
    }
  }

  const bump = isPlainObject(doc.version) ? doc.version.bump_by_commit_type : null;
  if (!isPlainObject(bump)) {
    problems.push('version.bump_by_commit_type 不是对象');
  } else {
    const bumpKeys = ownKeys(bump);
    if (bumpKeys.length === 0) problems.push('bump 表 0 个类型（没扫成）');
    for (const t of BUMP_TYPES) {
      if (!Object.prototype.hasOwnProperty.call(bump, t)) problems.push(`bump 表缺 ${t}`);
      else if (bump[t] == null || String(bump[t]).trim() === '') problems.push(`bump 表 ${t} 值为空`);
    }
  }

  const demo = doc.demo;
  if (!isPlainObject(demo)) {
    problems.push('demo 不是对象');
  } else {
    const projects = ownKeys(demo);
    if (projects.length === 0) problems.push('demo 0 个项目（没扫成）');
    for (const p of projects) {
      const v = demo[p];
      if (!isPlainObject(v)) problems.push(`demo.${p} 不是对象`);
      else if (v.kind == null || String(v.kind).trim() === '') problems.push(`demo.${p} 缺 kind`);
    }
  }

  const scanned = present.length
    + (isPlainObject(confirm) ? CONFIRM_LEVELS.filter((lv) => Object.prototype.hasOwnProperty.call(confirm, lv)).length : 0)
    + (isPlainObject(bump) ? ownKeys(bump).length : 0)
    + (isPlainObject(demo) ? ownKeys(demo).length : 0);

  return { ok: problems.length === 0, unscanned: false, problems, scanned };
}

export function inspectReleasePolicySource(text) {
  if (text == null) {
    return { ok: false, unscanned: true, error: '没给正文（没查成）', problems: [], scanned: 0 };
  }
  let doc;
  try {
    doc = JSON.parse(String(text));
  } catch (e) {
    return {
      ok: false,
      unscanned: true,
      error: `JSON 坏了：${String(e.message || e).split(/\r?\n/)[0].slice(0, 160)}`,
      problems: [],
      scanned: 0,
    };
  }
  return inspectReleasePolicy(doc);
}

export function inspectReleasePolicyFile(file) {
  if (!file) return { ok: false, unscanned: true, error: '没给路径（没查成）', problems: [], scanned: 0 };
  if (!existsSync(file)) {
    return { ok: false, unscanned: true, error: `文件不在：${file}`, problems: [], scanned: 0 };
  }
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch (e) {
    return {
      ok: false,
      unscanned: true,
      error: `读失败：${String(e.message || e).split(/\r?\n/)[0].slice(0, 160)}`,
      problems: [],
      scanned: 0,
    };
  }
  return inspectReleasePolicySource(src);
}

export function inspectReleasePolicyLive(root) {
  if (!root) return { ok: false, unscanned: true, error: '没给仓库根（没查成）', problems: [], scanned: 0 };
  return inspectReleasePolicyFile(join(root, POLICY_REL));
}

/** 夹具判别力：red 必须拦、ok 必须绿、empty 必须没查成（不是绿）。 */
export function inspectReleasePolicyFixtures(root) {
  if (!root) return { ok: false, unscanned: true, error: '没给样本根目录' };
  if (!existsSync(root)) return { ok: false, unscanned: true, error: `样本目录不在：${root}` };
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];
  for (const kind of ['red', 'ok', 'empty']) {
    const file = join(root, kind, 'release-policy.json');
    if (!existsSync(file)) {
      problems.push(`缺 ${kind}/release-policy.json`);
      continue;
    }
    const r = inspectReleasePolicyFile(file);
    if (kind === 'empty') {
      if (!r.unscanned) problems.push(`empty/ 应没查成但判成 ${JSON.stringify({ ok: r.ok, unscanned: r.unscanned, problems: r.problems })}`);
      else kinds.empty += 1;
    } else if (kind === 'red') {
      if (r.unscanned || r.ok) {
        problems.push(`red/ 自称该红但判成 ${JSON.stringify({ ok: r.ok, unscanned: r.unscanned, problems: r.problems })}`);
      } else kinds.red += 1;
    } else if (kind === 'ok') {
      if (r.unscanned || !r.ok) {
        problems.push(`ok/ 自称该绿但判成 ${JSON.stringify({ ok: r.ok, unscanned: r.unscanned, problems: r.problems })}`);
      } else kinds.ok += 1;
    }
  }
  if (kinds.red === 0 || kinds.ok === 0 || kinds.empty === 0) {
    return {
      ok: false,
      unscanned: true,
      error: `样本种类不够 red=${kinds.red} ok=${kinds.ok} empty=${kinds.empty}`,
      kinds,
      problems,
    };
  }
  if (problems.length) return { ok: false, unscanned: false, error: problems[0], kinds, problems };
  return { ok: true, unscanned: false, kinds };
}
