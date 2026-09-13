// 控制面闸写腿（#1165）。
//
// 判定仍在 control-plane-gate.mjs（只读）。本文件负责生产侧两件事：
//   1. 把探测三态写成 ~/.dao/control-plane.json（给探头读）
//   2. 给现役 worktree 挂上 git pre-push（不问 Claude/Cursor hook）
// 钩子从正在跑的这份代码装（stableHooksDir），不读工作树里有没有 scripts/githooks。
// 挂不上由调用方 fail-closed——建树成功却没接线，正是 #1165 审官 P1。
//
// 三态落盘规矩（2026-09-07 5A）：
//   green     → {reachable:true}
//   red       → {reachable:false, error}
//   unscanned → 不写 reachable（探头读成没查成，不拦）
// 不许把没查成写成 false——一次抖动会锁死整条链。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CONTROL_PLANE_REL } from './control-plane-gate.mjs';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

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
 * 钩子稳定来源：正在跑的这份 dao 代码自带的 scripts/githooks。
 * 不读工作树里那份——工作树可能还停在合本单之前的 master，那里没有 pre-push。
 * wrapper 必须 exec $here/../lib/control-plane-pre-push.mjs，不许再跳回工作树同名文件。
 */
export function stableHooksDir() {
  return join(THIS_DIR, '..', 'githooks');
}

/**
 * 把工作树的 core.hooksPath 指到稳定来源，写完读回。
 * 不是 git 树 / 稳定来源没有钩子 / 写不上 / 读回对不上 → 返回 ok:false，由调用方 fail-closed。
 */
export function ensureControlPlaneHooksPath({
  cwd,
  spawnGit = spawnSync,
  exists = existsSync,
  hooksDir = stableHooksDir(),
} = {}) {
  if (!cwd) return { ok: false, why: '没给 cwd' };
  if (!exists(join(cwd, '.git'))) return { ok: false, why: `${cwd} 不是 git 工作树` };

  const hookFile = join(hooksDir, 'pre-push');
  if (!exists(hookFile)) return { ok: false, why: `稳定来源钩子不在：${hookFile}` };

  const top = spawnGit('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if ((top.status ?? 1) !== 0) {
    return { ok: false, why: `rev-parse 失败：${String(top.stderr || '').slice(0, 80)}` };
  }

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

  const got = spawnGit('git', ['-C', cwd, 'config', '--worktree', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const readBack = String(got.stdout || '').trim();
  if (readBack !== hooksDir) {
    return {
      ok: false,
      why: `hooksPath 写了但读回是 ${readBack || '空'}，不是 ${hooksDir}`,
    };
  }
  return { ok: true, already: false, hooksPath: hooksDir };
}

/** 建树热路用：挂不上就抛，调用方不能再报「建树成功」。 */
export function attachControlPlaneHooksOrThrow(cwd, opts) {
  const r = ensureControlPlaneHooksPath({ cwd, ...(opts || {}) });
  if (!r.ok) throw new Error(`控制面闸没挂上：${r.why}`);
  return r;
}
