// scripts/lib/guard-revision.mjs —— 常驻守卫的代码版本闸（#595）
//
// 改这段前必须知道：flow / watchdog 活着、日志在滚，和「跑的是旧代码」在所有
// 可观测面上长得一样。进程启动时记下 HEAD，每轮 fetch 后跟 origin/master 比。
// 三态：current / behind / unknown。落后即报，无裕度。查不成不许当最新。
// git 执行器可注入，测试不得打真远程。

import { spawnSync } from 'node:child_process';

function defaultGit(args, { cwd } = {}) {
  const r = spawnSync('git', args, {
    encoding: 'utf8',
    cwd,
    windowsHide: true,
    timeout: 60000,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return {
      ok: false,
      error: String(r.error?.message || r.stderr || r.stdout || `git exit ${r.status}`).trim(),
    };
  }
  return { ok: true, out: String(r.stdout || '').trim() };
}

export function recordStartupRevision({ git, cwd } = {}) {
  const run = git || defaultGit;
  const r = run(['rev-parse', 'HEAD'], { cwd });
  if (!r.ok || !r.out) {
    return { ok: false, sha: null, error: r.error || 'HEAD 为空', recordedAt: Date.now() };
  }
  return { ok: true, sha: r.out, error: null, recordedAt: Date.now() };
}

export function checkGuardRevision({ startup, git, cwd, fetch = true } = {}) {
  const run = git || defaultGit;
  if (!startup || !startup.sha) {
    return {
      state: 'unknown',
      behind: null,
      startupSha: null,
      originSha: null,
      alarm: true,
      current: false,
      reason: (startup && startup.error) || '启动时没记下 HEAD',
    };
  }
  if (fetch) {
    const f = run(['fetch', '--quiet', 'origin', 'master'], { cwd });
    if (!f.ok) {
      return {
        state: 'unknown',
        behind: null,
        startupSha: startup.sha,
        originSha: null,
        alarm: true,
        current: false,
        reason: `git fetch 失败：${f.error}`,
      };
    }
  }
  const tip = run(['rev-parse', 'origin/master'], { cwd });
  if (!tip.ok || !tip.out) {
    return {
      state: 'unknown',
      behind: null,
      startupSha: startup.sha,
      originSha: null,
      alarm: true,
      current: false,
      reason: tip.error || '非 git 仓或没有 origin/master',
    };
  }
  if (tip.out === startup.sha) {
    return {
      state: 'current',
      behind: 0,
      startupSha: startup.sha,
      originSha: tip.out,
      alarm: false,
      current: true,
      reason: null,
    };
  }
  const cnt = run(['rev-list', '--count', `${startup.sha}..origin/master`], { cwd });
  let behind = null;
  if (cnt.ok && /^\d+$/.test(cnt.out)) behind = Number(cnt.out);
  return {
    state: 'behind',
    behind,
    startupSha: startup.sha,
    originSha: tip.out,
    alarm: true,
    current: false,
    reason: behind == null
      ? '落后 origin/master（数不出几个 commit）'
      : `落后 origin/master ${behind} 个 commit`,
  };
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 12) : '?';
}

/** 报警文本。current 返回空串（不报）。unknown 禁止出现「已是最新」。 */
export function formatRevisionAlarm(rev) {
  if (!rev || rev.state === 'current') return '';
  if (rev.state === 'unknown') {
    return `守卫版本没查成：${rev.reason || '未知'}——查不成不能当最新，落后自停`;
  }
  const n = rev.behind == null ? '?' : String(rev.behind);
  return `守卫代码落后 origin/master ${n} 个 commit（启动 HEAD=${shortSha(rev.startupSha)}，origin/master=${shortSha(rev.originSha)}）——落后自停，不许继续跑旧代码`;
}

export const STALE_EXIT_CODE = 4;

/**
 * #665：落后或查不成必须非零退出，不许继续跑旧代码。
 * exit 可注入；测试用收集器代替 process.exit。
 */
export function haltIfStale(rev, {
  log = (msg) => console.error(msg),
  exit = process.exit,
  tag = 'STALE_CODE',
} = {}) {
  if (!rev || rev.alarm !== true) return { halted: false };
  const msg = `${tag}：${formatRevisionAlarm(rev)}`;
  log(msg);
  exit(STALE_EXIT_CODE);
  return { halted: true, code: STALE_EXIT_CODE, message: msg };
}

export function attachRevision(heartbeat, rev) {
  const hb = heartbeat && typeof heartbeat === 'object' ? heartbeat : {};
  if (!rev) return hb;
  hb.revision = {
    state: rev.state,
    behind: rev.behind,
    startupSha: rev.startupSha,
    originSha: rev.originSha,
    reason: rev.reason,
  };
  return hb;
}
