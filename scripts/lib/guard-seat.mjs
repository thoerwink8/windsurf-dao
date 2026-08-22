// scripts/lib/guard-seat.mjs —— 帥位判定（#693；2026-08-22 起保活闸与帅位展示分离）
//
// 改这段前必须知道：判定是机械的——projectDir 是主树（git worktree list 第一棵）
// 且分支是 master 才是帥位。判不出来（git 失败 / 主树路径解析失败 / detached HEAD /
// 分支读不出）不猜、不静默放行、也不静默跳过：返回 ok:false，由调用方往会话上下文
// 注入醒目提示问用户。git 可注入，测试不得碰真仓库。
//
// 2026-08-22 拍板（守卫死 15 小时无人知现场）：master 判定只用于「谁是帅位」展示，
// 不再用于「要不要拉起守卫」——主树在本仓（不管当前分支）就允许 keepalive。
// 拉起闸统一走 guardLaunchGate，两个 hook（SessionStart / board-hook）不要各判各的。

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseWorktreePorcelain } from './guard-keepalive.mjs';

export const MASTER_BRANCH = 'master';

function defaultGit(args, cwd) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return { ok: false, error: String(r.error?.message || r.stderr || r.stdout || `git exit ${r.status}`).trim() };
  }
  return { ok: true, out: String(r.stdout || '').trim() };
}

export function normalizePath(p) {
  return resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * @returns {ok:true, seat:'shuai', mainPath, branch}
 *        | {ok:true, seat:'other', reason:'not-main-worktree'|'not-master', mainPath, branch}
 *        | {ok:false, error}  // 判不出来：调用方必须可见地上浮，不许当任何一种确定态
 */
export function judgeSeat({ projectDir, git = defaultGit } = {}) {
  if (!projectDir) {
    return { ok: false, error: '没给 projectDir（CLAUDE_PROJECT_DIR 与 cwd 都空）' };
  }
  const listed = git(['worktree', 'list', '--porcelain'], projectDir);
  if (!listed.ok) {
    return { ok: false, error: `git worktree list 失败：${listed.error}` };
  }
  const mainPath = parseWorktreePorcelain(listed.out);
  if (!mainPath) {
    return { ok: false, error: 'git worktree list 输出里没解析出主树路径' };
  }
  const br = git(['rev-parse', '--abbrev-ref', 'HEAD'], projectDir);
  if (!br.ok) {
    return { ok: false, error: `分支读不出：${br.error}` };
  }
  const branch = br.out;
  if (!branch || branch === 'HEAD') {
    return { ok: false, error: 'detached HEAD，判不出当前分支名' };
  }
  if (normalizePath(projectDir) !== normalizePath(mainPath)) {
    return { ok: true, seat: 'other', reason: 'not-main-worktree', mainPath, branch };
  }
  if (branch !== MASTER_BRANCH) {
    return { ok: true, seat: 'other', reason: 'not-master', mainPath, branch };
  }
  return { ok: true, seat: 'shuai', mainPath, branch };
}

/**
 * 保活拉起闸（2026-08-22 拍板：保活不再只认 master）。
 * 入参是 judgeSeat 的结果：
 *   - ok:false（判不出）→ launch:false, unknown:true——fail-close，不许乱拉；
 *   - 主树在本仓（shuai 或 not-master）→ launch:true——主树分支不是 master 也拉；
 *   - 非主树（工人树/别的仓，reason=not-main-worktree）→ launch:false——防多树双拉。
 */
export function guardLaunchGate(seat) {
  if (!seat || seat.ok !== true) {
    return { launch: false, unknown: true, error: (seat && seat.error) || 'judgeSeat 没给出结果' };
  }
  if (seat.seat === 'shuai' || seat.reason === 'not-master') {
    return { launch: true, unknown: false, branch: seat.branch, shuai: seat.seat === 'shuai' };
  }
  return { launch: false, unknown: false, reason: seat.reason || 'not-main-worktree' };
}
