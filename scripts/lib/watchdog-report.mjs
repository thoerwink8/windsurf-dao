// 看门狗报帅落 GitHub（#673）。
//
// 谁写：dao-watchdog[bot]，不是 marshal、不是卡住的工人。
// 何时写：type:报帅（含连败阈值、不再自动动作的那一次）。
// 何时不写：snapshot / --dispose-actions off（测试钩 WATCHDOG_GH_AS 除外）。
// 失败：事件里报「GitHub 没写成」，不许当写成功。
// 去重：同一树 + 同一指纹。评论列表没扫成 ≠ 扫完 0 条；没扫成不得发评论。

import { spawnSync } from 'node:child_process';
import { ghAs, loadRoleCreds } from './gh.mjs';

export const COMMENT_HEAD = '【看门狗】';
export const ACCIDENT_KEY_PREFIX = '事故键：';

export function fingerprintFromDetail(detail) {
  const text = String(detail || '');
  const quoted = text.match(/指纹「([^」]+)」/);
  if (quoted) return quoted[1];
  if (/capacity 指纹/.test(text)) return 'capacity';
  return null;
}

export function accidentKey(event = {}) {
  const tree = event.worktreeId || event.name || '?';
  const fp = event.fingerprint || fingerprintFromDetail(event.detail) || 'unknown';
  return `${tree}|${fp}`;
}

export function formatWatchdogComment({ name, detail, at, key, worktreeId } = {}) {
  const ts = new Date(Number.isFinite(at) ? at : Date.now()).toISOString();
  const lines = [
    COMMENT_HEAD,
    `卡名：${name || '?'}`,
    `指纹/原因：${detail || ''}`,
    `时间：${ts}`,
  ];
  if (worktreeId) lines.push(`树：${worktreeId}`);
  lines.push(`${ACCIDENT_KEY_PREFIX}${key}`);
  return lines.join('\n');
}

export function resolveCommentTarget(event = {}) {
  const pr = Number(event.prNumber);
  if (Number.isInteger(pr) && pr > 0) return { ok: true, kind: 'pr', number: pr };
  const issue = Number(event.issueNumber);
  if (Number.isInteger(issue) && issue > 0) return { ok: true, kind: 'issue', number: issue };
  return { ok: false, error: '没有 PR 也没有关联 issue' };
}

export function shouldWriteGithub(args = {}) {
  if (args.disposeActions === false) return false;
  if (args.snapshotDir && !process.env.WATCHDOG_GH_AS) return false;
  return true;
}

/** 扫完 0 条：scanned=true keys=[]；没扫成：scanned=false。两者不许混。 */
export function parseAccidentKeysFromComments(list) {
  if (list == null) {
    return { scanned: false, error: '评论列表没读到——不是 0 条，是没扫成', keys: [], count: 0 };
  }
  if (!Array.isArray(list)) {
    return { scanned: false, error: '评论列表不是数组——不是 0 条，是没扫成', keys: [], count: 0 };
  }
  const keys = [];
  for (const c of list) {
    const body = String((c && c.body) || '');
    const m = body.match(/事故键：(.+)/);
    if (m) keys.push(m[1].trim());
  }
  return { scanned: true, keys, count: list.length };
}

/** gh api --paginate --slurp：一页是评论数组，多页是数组的数组。展平后再扫。 */
export function flattenCommentPages(parsed) {
  if (!Array.isArray(parsed)) {
    return { ok: false, error: '评论列表不是数组——不是 0 条，是没扫成' };
  }
  if (parsed.length > 0 && parsed.every(p => Array.isArray(p))) {
    return { ok: true, comments: parsed.flat() };
  }
  return { ok: true, comments: parsed };
}

/** listed = runGh 结果。ok 失败 / 非 JSON / 非数组 = 没扫成，不许当成 0 条。 */
export function scanCommentsOut(listed) {
  if (!listed || listed.ok !== true) {
    return {
      scanned: false,
      error: `评论列表没查成：${listed?.error || '未知'}——不是 0 条，是没扫成`,
      keys: [],
      count: 0,
    };
  }
  const raw = listed.out;
  if (raw == null || String(raw).trim() === '') {
    return { scanned: false, error: '评论列表输出空——不是 0 条，是没扫成', keys: [], count: 0 };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    return { scanned: false, error: '评论列表不是 JSON——不是 0 条，是没扫成', keys: [], count: 0 };
  }
  const flat = flattenCommentPages(parsed);
  if (!flat.ok) {
    return { scanned: false, error: flat.error, keys: [], count: 0 };
  }
  return parseAccidentKeysFromComments(flat.comments);
}

export function defaultLoadCreds(opts) {
  return loadRoleCreds('watchdog', opts);
}

export function defaultRunGh(ghArgs, opts = {}) {
  const hook = process.env.WATCHDOG_GH_AS;
  if (hook) {
    const r = spawnSync(process.execPath, [hook, ...ghArgs], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      env: process.env,
    });
    if (r.error || (r.status !== 0 && r.status != null)) {
      return {
        ok: false,
        status: r.status == null ? 1 : r.status,
        error: String(r.error?.message || r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 240),
        out: String(r.stdout || ''),
      };
    }
    return { ok: true, status: 0, out: String(r.stdout || '') };
  }
  return ghAs('watchdog', ghArgs, opts);
}

function failEvent(name, reason) {
  return { name: name || '?', type: '动作', detail: `GitHub 没写成：${reason}` };
}

function postOne({ payload, key, now, runGh }) {
  const name = payload.name || '?';
  const target = resolveCommentTarget(payload);
  if (!target.ok) return { ok: false, event: failEvent(name, target.error) };

  const listed = runGh(['api', `repos/{owner}/{repo}/issues/${target.number}/comments`, '--paginate', '--slurp']);
  const scan = scanCommentsOut(listed);
  if (!scan.scanned) {
    return { ok: false, event: failEvent(name, scan.error) };
  }
  if (scan.keys.includes(key)) {
    return {
      ok: true,
      deduped: true,
      event: { name, type: '观察', detail: `同一树+同一指纹已报过（${key}），不再刷` },
    };
  }

  const body = formatWatchdogComment({
    name,
    detail: payload.detail,
    at: now,
    key,
    worktreeId: payload.worktreeId,
  });
  const args = target.kind === 'pr'
    ? ['pr', 'comment', String(target.number), '--body', body]
    : ['issue', 'comment', String(target.number), '--body', body];
  const posted = runGh(args);
  if (!posted.ok) {
    return { ok: false, event: failEvent(name, posted.error || 'gh 失败') };
  }
  const where = target.kind === 'pr' ? `PR #${target.number}` : `issue #${target.number}`;
  return { ok: true, event: { name, type: '动作', detail: `已写 GitHub 评论：${where}` } };
}

/**
 * 把本轮 type:报帅 落到 GitHub。失败显形。同一 key 成功后不再刷。
 * 写失败保留 pending，下轮再试；「没写成」每个 key 只打一次，避免 30s 刷屏。
 */
export function reportWatchdogGithub({ events, args, state, now, runGh, loadCreds } = {}) {
  if (!Array.isArray(events)) return { skipped: 'no-events', extras: [] };
  if (!shouldWriteGithub(args || {})) return { skipped: 'gate', extras: [] };

  if (!state.githubPosted) state.githubPosted = new Set();
  if (!state.githubPending) state.githubPending = new Map();
  if (!state.githubFailShown) state.githubFailShown = new Set();

  for (const e of events) {
    if (!e || e.type !== '报帅') continue;
    const key = accidentKey(e);
    if (state.githubPosted.has(key)) continue;
    if (!state.githubPending.has(key)) state.githubPending.set(key, { ...e, key });
  }

  const extras = [];
  // 测试钩 WATCHDOG_GH_AS 代替真凭据（同仓 WATCHDOG_ORPHAN_RM）。生产仍 fail-loud。
  const creds = loadCreds
    ? loadCreds()
    : (process.env.WATCHDOG_GH_AS ? { ok: true } : defaultLoadCreds());
  if (!creds.ok) {
    for (const [key, payload] of state.githubPending) {
      if (state.githubFailShown.has(key)) continue;
      extras.push(failEvent(payload.name, creds.error));
      state.githubFailShown.add(key);
    }
    events.push(...extras);
    return { extras, skipped: creds.code || 'creds' };
  }

  const gh = runGh || defaultRunGh;
  for (const [key, payload] of state.githubPending) {
    if (state.githubPosted.has(key)) {
      state.githubPending.delete(key);
      continue;
    }
    const result = postOne({ payload, key, now: now || Date.now(), runGh: gh });
    extras.push(result.event);
    if (result.ok) {
      state.githubPosted.add(key);
      state.githubPending.delete(key);
      state.githubFailShown.delete(key);
    } else if (!state.githubFailShown.has(key)) {
      state.githubFailShown.add(key);
    } else {
      extras.pop();
    }
  }
  events.push(...extras);
  return { extras };
}
