// 控制面闸写腿（#1165）。
//
// 判定仍在 control-plane-gate.mjs（只读）。本文件负责生产侧两件事：
//   1. 把探测三态写成 ~/.dao/control-plane.json（给探头读）
//   2. 给现役 worktree 挂上 git pre-push（不问 Claude/Cursor hook）
//
// 三态落盘规矩（2026-09-07 5A）：
//   green     → {reachable:true}
//   red       → {reachable:false, error}
//   unscanned → 不写 reachable（探头读成没查成，不拦）
// 不许把没查成写成 false——一次抖动会锁死整条链。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONTROL_PLANE_REL } from './control-plane-gate.mjs';

export const CONTROL_PLANE_SOURCE = 'mirasim-ws-probe';
export const HOOKS_REL = ['scripts', 'githooks'];

/**
 * 握手三态 → 落盘文档。纯函数，不碰 IO。
 * @param {{state:string, why?:string, at?:string, source?:string}} arg
 */
export function controlPlaneDocFromProbe({
  state,
  why = '',
  at = '',
  source = CONTROL_PLANE_SOURCE,
} = {}) {
  const src = source || CONTROL_PLANE_SOURCE;
  const checkedAt = at || '';
  if (state === 'green') {
    return { reachable: true, source: src, checkedAt, probe: 'green' };
  }
  if (state === 'red') {
    const doc = { reachable: false, source: src, checkedAt, probe: 'red' };
    if (why) doc.error = String(why).slice(0, 160);
    return doc;
  }
  return {
    source: src,
    checkedAt,
    probe: 'unscanned',
    why: String(why || '没查成').slice(0, 160),
  };
}

export function defaultControlPlaneFile({ env = process.env, home = homedir() } = {}) {
  if (env && env.DAO_CONTROL_PLANE_FILE) return String(env.DAO_CONTROL_PLANE_FILE);
  return join(home, ...CONTROL_PLANE_REL);
}

export function writeControlPlaneFile(doc, {
  env = process.env,
  home = homedir(),
  mkdir = mkdirSync,
  writeFile = writeFileSync,
} = {}) {
  const file = defaultControlPlaneFile({ env, home });
  mkdir(dirname(file), { recursive: true });
  writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * 把本工作树的 core.hooksPath 指到仓内 scripts/githooks。
 * 不是 git 树 / 钩子文件不在 → 不抛，返回 ok:false（建树本身不许被这个绊住）。
 */
export function ensureControlPlaneHooksPath({
  cwd,
  spawnGit = spawnSync,
  exists = existsSync,
} = {}) {
  if (!cwd) return { ok: false, why: '没给 cwd' };
  if (!exists(join(cwd, '.git'))) return { ok: false, why: `${cwd} 不是 git 工作树` };

  const top = spawnGit('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if ((top.status ?? 1) !== 0) {
    return { ok: false, why: `rev-parse 失败：${String(top.stderr || '').slice(0, 80)}` };
  }
  const root = String(top.stdout || '').trim();
  const hooksDir = join(root, ...HOOKS_REL);
  const hookFile = join(hooksDir, 'pre-push');
  if (!exists(hookFile)) return { ok: false, why: `${hookFile} 不在` };

  const cur = spawnGit('git', ['-C', cwd, 'config', '--worktree', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const now = String(cur.stdout || '').trim();
  if (now === hooksDir) return { ok: true, already: true, hooksPath: hooksDir };

  spawnGit('git', ['-C', cwd, 'config', 'extensions.worktreeConfig', 'true'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const set = spawnGit('git', ['-C', cwd, 'config', '--worktree', 'core.hooksPath', hooksDir], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if ((set.status ?? 1) !== 0) {
    return {
      ok: false,
      why: `hooksPath 写不上：${String(set.stderr || set.stdout || '').slice(0, 80)}`,
    };
  }
  return { ok: true, already: false, hooksPath: hooksDir };
}
