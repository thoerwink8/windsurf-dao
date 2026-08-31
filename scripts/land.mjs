#!/usr/bin/env node
// land —— 收工一条命令（2026-08-31 拍板；跑几遍都安全，本机和 Linux 服务器同一条）。
//
//   node scripts/land.mjs [--dry-run] [仓路径]     # 在任何 git 仓里可用，不限本仓
//
// 干什么：① 在默认分支上：有检查跑检查（发现 scripts/dao-check.mjs 才跑），绿了 push；
//         ② 清理：fetch --prune → 删「已合并进默认分支」的本地分支 →
//            拆「分支已合并 + 树干净 + 非主树/非当前树/不挂默认分支 + orca 没在管」的 git worktree。
// 不干什么（判断全在 scripts/lib/land-core.mjs，测试见 tests/land.test.js）：
//   - 不在派生分支上代劳「进主分支」（那是 PR/审官闭环的活，编排态绕过它=绕过审查）；
//   - 发散不自动 rebase；未合并/不干净/orca 在管的一律不删；删分支只用 -d（git 兜底拒未合并）。
// 为什么不是 post-commit hook：rebase/amend/cherry-pick 也触发 post-commit，会把中间态推上主分支；
//   工人在编排树里的 commit 也会触发，等于绕过审官。收工是「一段活的结尾」，不是「每个 commit」。
// 退出码：0 = 收工净（该运的运了、没有可清而未清的）；1 = 有事没收完（发散/检查红/在派生分支）。

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decideShip, decideBranchDelete, decideWorktreeRemove } from './lib/land-core.mjs';

const DRY = process.argv.includes('--dry-run');
const argPath = process.argv.slice(2).filter(a => a !== '--dry-run')[0];
const cwd = resolve(argPath || process.cwd());
const say = (s) => process.stdout.write(s + '\n');

function git(args, opts = {}) {
  const r = spawnSync('git', ['-C', opts.cwd || root, ...args], { encoding: 'utf8', windowsHide: true });
  return { status: r.status ?? 1, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}

// ── 读盘面 ─────────────────────────────────────────────────────────
let root = cwd;
{
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) { say(`[收工] 这里不是 git 仓：${cwd}`); process.exit(1); }
  root = String(r.stdout).trim();
}
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
const hasOrigin = git(['remote']).out.split(/\r?\n/).includes('origin');
if (hasOrigin && !DRY) {
  const f = git(['fetch', '--prune', 'origin']);
  if (f.status !== 0) { say(`[收工] fetch 失败（${f.err.slice(0, 120)}）——远端状态没刷到，不盲推`); process.exit(1); }
}
let defaultBranch = '';
{
  const r = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (r.status === 0) defaultBranch = r.out.replace(/^origin\//, '');
  else defaultBranch = git(['rev-parse', '--verify', '--quiet', 'refs/heads/master']).status === 0 ? 'master' : 'main';
}

// ── ① 运默认分支 ───────────────────────────────────────────────────
let counts = git(['rev-list', '--left-right', '--count', `origin/${defaultBranch}...${defaultBranch}`]).out.split(/\s+/).map(Number);
if (!hasOrigin || counts.length !== 2 || counts.some(Number.isNaN)) counts = [0, 0];
const ship = decideShip({ branch, defaultBranch, ahead: counts[1], behind: counts[0], hasOrigin });
say(`[收工] ${root} · 分支 ${branch}（默认 ${defaultBranch}）→ ${ship.action}：${ship.reason}`);

let unfinished = false;
if (ship.action === 'refuse' || ship.action === 'stop-diverged') unfinished = true;
if (ship.action === 'ff' && !DRY) {
  const r = git(['merge', '--ff-only', `origin/${defaultBranch}`]);
  say(r.status === 0 ? '[收工] 已快进到远端' : `[收工] 快进失败：${r.err.slice(0, 120)}`);
  if (r.status !== 0) unfinished = true;
}
if (ship.action === 'push') {
  const checkFile = join(root, 'scripts', 'dao-check.mjs');
  if (existsSync(checkFile)) {
    if (DRY) say('[收工] [拟] 跑检查 node scripts/dao-check.mjs');
    else {
      say('[收工] 推之前跑检查…');
      const c = spawnSync(process.execPath, [checkFile], { cwd: root, encoding: 'utf8', windowsHide: true });
      const tail = String(c.stdout || '').trim().split(/\r?\n/).pop() || '';
      say(`[收工] 检查：${tail}`);
      if (c.status !== 0) { say('[收工] 检查红——不推，先修（master 必须能跑）'); process.exit(1); }
    }
  } else {
    say('[收工] 本仓没有 scripts/dao-check.mjs，跳过检查（如实报告，不是查过没事）');
  }
  if (DRY) say(`[收工] [拟] git push origin ${defaultBranch}`);
  else {
    const p = git(['push', 'origin', defaultBranch]);
    if (p.status !== 0) { say(`[收工] push 失败：${(p.err || p.out).slice(0, 160)}`); process.exit(1); }
    say(`[收工] 已推 origin/${defaultBranch}`);
  }
}

// ── ② 清理：worktree 先（占着分支），分支后 ─────────────────────────
const orcaPaths = new Set();
{
  // orca 在管的树绝不碰（删卡走编排闭环）。orca 不在 = 空集，不算没查成——本机停派工态没有编排树。
  const r = spawnSync('orca', ['worktree', 'list', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 15000, shell: true });
  if (r.status === 0) {
    try {
      for (const w of JSON.parse(r.stdout)?.result?.worktrees || []) {
        if (w?.path) orcaPaths.add(resolve(String(w.path)).toLowerCase());
      }
    } catch { /* 输出畸形当空集：只影响多留不影响误删 */ }
  }
}

const mergedSet = new Set(
  git(['branch', '--merged', defaultBranch, '--format=%(refname:short)']).out.split(/\r?\n/).filter(Boolean),
);

const wtBlocks = git(['worktree', 'list', '--porcelain']).out.split(/\r?\n\r?\n|\n\n/).filter(Boolean);
const worktrees = wtBlocks.map((b) => {
  const path = (b.match(/^worktree (.+)$/m) || [])[1];
  const wtBranch = (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1] || '';
  return { path, branch: wtBranch, detached: /^detached$/m.test(b) };
}).filter(w => w.path);

for (let i = 0; i < worktrees.length; i++) {
  const w = worktrees[i];
  const abs = resolve(w.path);
  const d = decideWorktreeRemove({
    branch: w.branch,
    merged: !!w.branch && mergedSet.has(w.branch),
    dirty: git(['status', '--porcelain'], { cwd: abs }).out !== '',
    isMain: i === 0,
    isCurrent: abs.toLowerCase() === resolve(root).toLowerCase() || abs.toLowerCase() === cwd.toLowerCase(),
    isDefaultBranch: w.branch === defaultBranch,
    orcaManaged: orcaPaths.has(abs.toLowerCase()),
    detached: w.detached,
  });
  if (!d.remove) { if (i > 0) say(`[收工] 留树 ${w.path}：${d.reason}`); continue; }
  if (DRY) { say(`[收工] [拟] 拆树 ${w.path}（${d.reason}）`); continue; }
  const r = git(['worktree', 'remove', w.path]);
  say(r.status === 0 ? `[收工] 拆树 ${w.path}（${d.reason}）` : `[收工] 拆树失败 ${w.path}：${r.err.slice(0, 120)}`);
}

const checkedOut = new Map(); // 分支 → 占用它的树
for (const b of git(['worktree', 'list', '--porcelain']).out.split(/\r?\n\r?\n|\n\n/)) {
  const p = (b.match(/^worktree (.+)$/m) || [])[1];
  const br = (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1];
  if (p && br) checkedOut.set(br, p);
}
for (const name of git(['for-each-ref', 'refs/heads', '--format=%(refname:short)']).out.split(/\r?\n/).filter(Boolean)) {
  const d = decideBranchDelete({
    name,
    merged: mergedSet.has(name),
    isDefault: name === defaultBranch,
    isCurrent: name === branch,
    checkedOutAt: checkedOut.get(name) !== undefined && resolve(checkedOut.get(name)).toLowerCase() !== resolve(root).toLowerCase() ? checkedOut.get(name) : '',
  });
  if (!d.del) { if (!d.reason.includes('默认分支') && !d.reason.includes('当前分支')) say(`[收工] 留支 ${name}：${d.reason}`); continue; }
  if (DRY) { say(`[收工] [拟] 删支 ${name}`); continue; }
  const r = git(['branch', '-d', name]); // -d：git 自己再拦一道未合并
  say(r.status === 0 ? `[收工] 删支 ${name}` : `[收工] 删支失败 ${name}：${r.err.slice(0, 120)}`);
}

const staleRemote = git(['branch', '-r', '--merged', `origin/${defaultBranch}`, '--format=%(refname:short)']).out
  .split(/\r?\n/).filter(b => b && b.includes('/') && b !== `origin/${defaultBranch}` && !b.endsWith('/HEAD')); // 无 / 的是 origin/HEAD 缩写出的 origin，不是分支
if (staleRemote.length) say(`[收工] 远端已合并未删的分支（只列不删）：${staleRemote.join(' ')}`);

say(unfinished ? '[收工] 没收完，见上面的原因' : '[收工] 净');
process.exit(unfinished ? 1 : 0);
