// dao-check ㉕（#682）：微通道 quick-fix 还在。
// 检查器自己持有正则，不 import scripts/lib/quick-fix.mjs——自己查自己查不出错。
//
// 查四样：脚本存在且强制 --issue/--model、#679 同厂闸在、异步 attach 走 reviewer-attach、
// dispatch SKILL 主会话红线写着微通道例外。红/绿/空样本各一验判别力。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const NEED_ISSUE = /--issue/;
const NEED_MODEL = /--model/;
const GATE_PLAN = /planQuickFixGate\s*\(/;
const GATE_CALL = /assertCrossVendor\s*\(/;
const ATTACH_CALL = /reviewer-attach/;
const SKIP_WAIT = /--skip-wait/;
const ROLLBACK = /rollback|整体回滚|整体退出/;
const WORKER_IDENTITY = /ROLE_META\.worker|dao-worker\[bot\]/;
const LIB_IMPORT = /from\s+['"]\.\/lib\/quick-fix\.mjs['"]/;

/**
 * quick-fix 本体（CLI + 纯函数层）：缺一条就红。没给正文 = 没查成。
 * 闸逻辑在 lib（planQuickFixGate），CLI 必须调它；lib 必须真调 assertCrossVendor。
 */
export function inspectQuickFixSource({ qfSrc, qfLibSrc } = {}) {
  if (qfSrc == null || qfLibSrc == null) {
    return { ok: false, unscanned: true, error: '没给 quick-fix.mjs / lib 正文（没查成）' };
  }
  const problems = [];
  if (!NEED_ISSUE.test(qfSrc)) problems.push('缺 --issue 强制（微修必须挂已有单号）');
  if (!NEED_MODEL.test(qfSrc)) problems.push('缺 --model 强制（主会话模型必须显式声明）');
  if (!GATE_PLAN.test(qfSrc)) problems.push('CLI 没调 planQuickFixGate（#679 闸不在入口）');
  if (!GATE_CALL.test(qfLibSrc)) problems.push('lib 没调 assertCrossVendor（#679 同厂闸不在）');
  if (!ATTACH_CALL.test(qfSrc)) problems.push('没走 reviewer-attach（异步审官不在）');
  if (!SKIP_WAIT.test(qfSrc)) problems.push('缺 --skip-wait（微修没有士兵 dispatch，审官要跳过等完工）');
  if (!ROLLBACK.test(qfSrc)) problems.push('没有整体回滚（任一步失败要不留半成品）');
  if (!WORKER_IDENTITY.test(qfSrc)) problems.push('commit 不是 dao-worker[bot] 身份');
  if (!LIB_IMPORT.test(qfSrc)) problems.push('CLI 没从 lib/quick-fix.mjs 取判定逻辑');
  return { ok: problems.length === 0, unscanned: false, problems };
}

/** dispatch SKILL 主会话红线必须写微通道例外。没给正文 = 没查成。 */
export function inspectDispatchRedLine({ skillSrc } = {}) {
  if (skillSrc == null) return { ok: false, unscanned: true, error: '没给 dispatch SKILL.md 正文（没查成）' };
  const problems = [];
  if (!/微通道|quick-fix/.test(skillSrc)) problems.push('主会话红线没写微通道例外');
  if (!/无例外/.test(skillSrc)) problems.push('「无例外」红线不在了');
  if (!/scripts\/quick-fix\.mjs/.test(skillSrc)) problems.push('例外没点名 quick-fix.mjs 脚本');
  return { ok: problems.length === 0, unscanned: false, problems };
}

/** live 故意样本：同厂 dry-run 被当场拦；--model 未声明被当场拦。CI 无 GH_TOKEN 也能跑（闸在 gh 前）。 */
export function probeQuickFixGate(root) {
  if (!root) return { ok: false, unscanned: true, error: '没给仓库根' };
  const cli = join(root, 'scripts', 'quick-fix.mjs');
  if (!existsSync(cli)) return { ok: false, unscanned: true, error: 'scripts/quick-fix.mjs 不在' };
  const same = spawnSync(process.execPath, [cli, '--dry-run', '--issue', '1', '--model', 'grok-4.6', '--reviewer', 'grok-4.6'], {
    encoding: 'utf8', cwd: root, timeout: 30000, windowsHide: true,
  });
  let sameJson = {};
  try { sameJson = JSON.parse(String(same.stdout || '').trim().split(/\r?\n/).pop()); } catch { sameJson = {}; }
  const sameErr = String(sameJson.error || same.stderr || '');
  if (same.status === 0 || !/同厂/.test(sameErr)) {
    return { ok: false, unscanned: false, error: `故意同厂样本没拦住 status=${same.status} ${sameErr.slice(0, 180)}` };
  }
  const noModel = spawnSync(process.execPath, [cli, '--dry-run', '--issue', '1'], {
    encoding: 'utf8', cwd: root, timeout: 30000, windowsHide: true,
  });
  let noModelJson = {};
  try { noModelJson = JSON.parse(String(noModel.stdout || '').trim().split(/\r?\n/).pop()); } catch { noModelJson = {}; }
  const noModelErr = String(noModelJson.error || noModel.stderr || '');
  if (noModel.status === 0 || !/未声明|--model/.test(noModelErr)) {
    return { ok: false, unscanned: false, error: `--model 未声明样本没拦住 status=${noModel.status} ${noModelErr.slice(0, 180)}` };
  }
  return { ok: true, unscanned: false };
}

/** 红/绿/空样本：red/ 自称该红、ok/ 自称该绿、empty/ 必须 0 样本 = 没查成。 */
export function inspectQuickFixFixtures(root) {
  if (!root) return { ok: false, unscanned: true, error: '没给样本根目录' };
  if (!existsSync(root)) return { ok: false, unscanned: true, error: `样本目录不在：${root}` };
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];

  function bundle(dir) {
    const out = { qfSrc: null, qfLibSrc: null, skillSrc: null };
    let present = 0;
    for (const [k, file] of [['qfSrc', 'quick-fix.mjs'], ['qfLibSrc', 'quick-fix-lib.mjs'], ['skillSrc', 'skill.md']]) {
      const p = join(dir, file);
      if (existsSync(p)) {
        out[k] = readFileSync(p, 'utf8');
        present += 1;
      }
    }
    return { present, ...out };
  }

  for (const kind of ['red', 'ok', 'empty']) {
    const dir = join(root, kind);
    if (!existsSync(dir)) {
      problems.push(`缺 ${kind}/`);
      continue;
    }
    const files = readdirSync(dir).filter((f) => /\.(mjs|js|md|txt)$/i.test(f));
    if (kind === 'empty') {
      if (files.length !== 0) {
        problems.push('empty/ 应该 0 个样本（0 条 = 没查成）');
        continue;
      }
      const r = inspectQuickFixSource({});
      if (!r.unscanned) problems.push('empty 没标没查成');
      else kinds.empty += 1;
      continue;
    }
    if (files.length === 0) {
      problems.push(`${kind}: 0 个样本——没查成`);
      continue;
    }
    const b = bundle(dir);
    if (b.present < 3) {
      problems.push(`${kind}: 样本缺文件（要 quick-fix.mjs + quick-fix-lib.mjs + skill.md 各一）`);
      continue;
    }
    const src = inspectQuickFixSource({ qfSrc: b.qfSrc, qfLibSrc: b.qfLibSrc });
    const skill = inspectDispatchRedLine({ skillSrc: b.skillSrc });
    if (kind === 'red') {
      if (src.unscanned || skill.unscanned || (src.ok && skill.ok)) {
        problems.push('red/ 自称该红但扫不到缺闸/缺例外');
      } else kinds.red += 1;
    }
    if (kind === 'ok') {
      if (src.unscanned || skill.unscanned) problems.push('ok/ 没查成');
      else if (!src.ok || !skill.ok) {
        problems.push(`ok/ 自称该绿但扫到：${[...src.problems, ...skill.problems].join('；')}`);
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
