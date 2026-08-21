// scripts/lib/guard-mirror.mjs —— 守卫只读镜像（#665）
//
// 改这段前必须知道：信箱台 / 看门狗 / flow 若吃主树当下 checkout，origin 上已合的
// 关卡看起来「活着」其实在跑旧代码。本层把代码和主树拆开：
//   ~/.dao/guard-mirror 每次启动 fetch + reset --hard origin/master 再 exec。
// 主树落后不影响关卡。查不成 / clone 失败 → 自停，不许继续跑旧代码。
// 不要 git clean：_flow 是 untracked，清掉会丢租约。
// git / exists / spawn / exit 可注入，测试不得打真远程。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkGuardRevision, haltIfStale, recordStartupRevision, STALE_EXIT_CODE,
} from './guard-revision.mjs';

function defaultGit(args, { cwd } = {}) {
  const r = spawnSync('git', args, {
    encoding: 'utf8',
    cwd,
    windowsHide: true,
    timeout: 120000,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return {
      ok: false,
      error: String(r.error?.message || r.stderr || r.stdout || `git exit ${r.status}`).trim(),
    };
  }
  return { ok: true, out: String(r.stdout || '').trim() };
}

export function defaultMirrorPath(home = homedir()) {
  return join(home, '.dao', 'guard-mirror');
}

export function skipGuardMirror({ env = process.env } = {}) {
  const v = env && env.DAO_GUARD_SKIP_MIRROR;
  return v === '1' || v === 'true';
}

// 测试旁路（同 DAO_GUARD_SKIP_MIRROR 一级）：subprocess 级 live 测试里脚本仓的 HEAD
// 是未推送的分支 commit，boot 版本闸必然自停、根本到不了主循环——设
// DAO_GUARD_SKIP_REVISION=1 跳过 boot 闸。生产不设；轮内闸（每轮 checkGuardRevision）
// 不受影响，仍在跑。
export function skipGuardRevision({ env = process.env } = {}) {
  const v = env && env.DAO_GUARD_SKIP_REVISION;
  return v === '1' || v === 'true';
}

export function isPathInside(child, parent) {
  const c = resolve(String(child || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const p = resolve(String(parent || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!c || !p) return false;
  return c === p || c.startsWith(`${p}/`);
}

export function planGuardMirror({
  cwd,
  scriptFile,
  argv = [],
  git,
  env = process.env,
  exists = existsSync,
  homedir: home = homedir(),
  mirrorPath,
} = {}) {
  if (skipGuardMirror({ env })) {
    return { ok: true, action: 'skip', reason: 'DAO_GUARD_SKIP_MIRROR' };
  }
  const run = git || defaultGit;
  const dest = mirrorPath || (env && env.DAO_GUARD_MIRROR) || defaultMirrorPath(home);
  const origin = run(['remote', 'get-url', 'origin'], { cwd });
  if (!origin.ok || !origin.out) {
    return {
      ok: false,
      action: 'halt',
      error: `守卫镜像没查成：git remote get-url origin 失败（${origin.error || '空'}）——查不成不许跑旧代码`,
    };
  }
  const destIsGit = exists(join(dest, '.git')) || exists(join(dest, 'HEAD'));
  if (exists(dest) && !destIsGit) {
    return { ok: false, action: 'halt', error: `守卫镜像路径存在但不是 git 仓：${dest}` };
  }
  if (!destIsGit) {
    const cloned = run(['clone', '--', origin.out, dest], { cwd });
    if (!cloned.ok) {
      return { ok: false, action: 'halt', error: `守卫镜像 clone 失败：${cloned.error}` };
    }
  }
  const fetched = run(['fetch', '--quiet', 'origin', 'master'], { cwd: dest });
  if (!fetched.ok) {
    return { ok: false, action: 'halt', error: `守卫镜像 fetch 失败：${fetched.error}` };
  }
  const reset = run(['reset', '--hard', 'origin/master'], { cwd: dest });
  if (!reset.ok) {
    return { ok: false, action: 'halt', error: `守卫镜像 reset --hard origin/master 失败：${reset.error}` };
  }
  const sha = run(['rev-parse', 'HEAD'], { cwd: dest });
  if (!sha.ok || !sha.out) {
    return { ok: false, action: 'halt', error: `守卫镜像 HEAD 没查成：${sha.error || '空'}` };
  }
  let scriptAbs = '';
  try {
    scriptAbs = scriptFile && String(scriptFile).startsWith('file:')
      ? fileURLToPath(scriptFile)
      : String(scriptFile || '');
  } catch {
    scriptAbs = String(scriptFile || '');
  }
  if (scriptAbs && isPathInside(scriptAbs, dest)) {
    return { ok: true, action: 'run', mirrorPath: dest, sha: sha.out, script: scriptAbs, argv };
  }
  if (!cwd || !scriptAbs) {
    return { ok: false, action: 'halt', error: '守卫镜像 reexec 没给 scriptFile/cwd' };
  }
  const rel = relative(cwd, scriptAbs);
  if (!rel || rel.startsWith('..') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) {
    const base = basename(scriptAbs);
    const parent = basename(dirname(scriptAbs));
    const guess = parent === 'scripts' ? join('scripts', base) : join('scripts', parent, base);
    return { ok: true, action: 'reexec', mirrorPath: dest, sha: sha.out, script: join(dest, guess), argv };
  }
  return {
    ok: true,
    action: 'reexec',
    mirrorPath: dest,
    sha: sha.out,
    script: join(dest, rel),
    argv,
  };
}

export function applyGuardMirror(plan, {
  spawn = spawnSync,
  exit = process.exit,
  execPath = process.execPath,
  env = process.env,
} = {}) {
  if (!plan || plan.action !== 'reexec') return plan;
  const r = spawn(execPath, [plan.script, ...(plan.argv || [])], {
    cwd: plan.mirrorPath,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...env, DAO_GUARD_MIRROR: plan.mirrorPath },
  });
  if (r.error) {
    console.error(`STALE_CODE：守卫镜像 reexec 失败：${r.error.message}——落后自停，不许继续跑旧代码`);
    exit(STALE_EXIT_CODE);
    return plan;
  }
  exit(r.status == null ? 1 : r.status);
  return plan;
}

export function bootGuardOrHalt({
  repoRoot,
  scriptFile,
  argv = process.argv.slice(2),
  snapshot = false,
  git,
  env = process.env,
  spawn,
  exit = process.exit,
  log = (msg) => console.error(msg),
  exists,
  homedir: home,
  mirrorPath,
  execPath,
} = {}) {
  if (snapshot) return { ok: true, action: 'snapshot' };
  const plan = planGuardMirror({
    cwd: repoRoot,
    scriptFile,
    argv,
    git,
    env,
    exists,
    homedir: home,
    mirrorPath,
  });
  if (!plan.ok) {
    haltIfStale({
      state: 'unknown',
      alarm: true,
      current: false,
      reason: plan.error,
    }, { log, exit });
    return plan;
  }
  if (plan.action === 'reexec') {
    applyGuardMirror(plan, { spawn, exit, env, execPath });
    return plan;
  }
  const cwd = plan.mirrorPath || repoRoot;
  if (skipGuardRevision({ env })) {
    return { ...plan, startup: null, rev: null, revisionSkipped: true };
  }
  const startup = recordStartupRevision({ git, cwd });
  const rev = checkGuardRevision({ startup, git, cwd, fetch: plan.action !== 'run' });
  haltIfStale(rev, { log, exit });
  return { ...plan, startup, rev };
}
