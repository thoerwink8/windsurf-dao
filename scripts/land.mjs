#!/usr/bin/env node
// land —— 收工一条命令（2026-08-31 拍板；跑几遍都安全，本机和 Linux 服务器同一条）。
//
//   node scripts/land.mjs [--dry-run] [仓路径]     # 在任何 git 仓里可用，不限本仓
//   node scripts/land.mjs --has-work [仓路径]     # precheck：有可运/可清 → 0；没活 → 非 0（#829）
//
// 干什么：① 在默认分支上：有检查跑检查（发现 scripts/dao-check.mjs 才跑），绿了 push；
//         ② 清理：fetch --prune → 删「已合并进默认分支」的本地分支 →
//            拆「分支已合并 + 树干净 + 非主树/非当前树/不挂默认分支 + orca 没在管」的 git worktree。
// 不干什么（判断全在 scripts/lib/land-core.mjs，测试见 tests/land.test.js）：
//   - 不在派生分支上代劳「进主分支」（那是 PR/审官闭环的活，编排态绕过它=绕过审查）；
//   - 发散不自动 rebase；未合并/不干净/orca 在管/被树占用/刚建还没提交过的（#898）一律不删。
// 为什么不是 post-commit hook：rebase/amend/cherry-pick 也触发 post-commit，会把中间态推上主分支；
//   工人在编排树里的 commit 也会触发，等于绕过审官。收工是「一段活的结尾」，不是「每个 commit」。
// 退出码：0 = 收工净（该运的运了、没有可清而未清的）；1 = 有事没收完（发散/检查红/在派生分支）。
// --has-work：0 = 有可运（push/ff）或可清（拆树/删支）；非 0 = 没活（给 automations precheck 记 skipped）。

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  decideShip, decideBranchDelete, decideWorktreeRemove, decideTerminalClose, hasLandWork,
  collectBranchMergeFacts, parseWorktrees, branchCheckedOutAt,
} from './lib/land-core.mjs';

const FLAGS = new Set(['--dry-run', '--has-work']);
const DRY = process.argv.includes('--dry-run');
const HAS_WORK = process.argv.includes('--has-work');
const argPath = process.argv.slice(2).filter(a => !FLAGS.has(a))[0];
const cwd = resolve(argPath || process.cwd());
const say = (s) => process.stdout.write(s + '\n');

function git(args, opts = {}) {
  const r = spawnSync('git', ['-C', opts.cwd || root, ...args], { windowsHide: true, encoding: 'utf8' });
  return { status: r.status ?? 1, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}

// ── 读盘面 ─────────────────────────────────────────────────────────
let root = cwd;
{
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { windowsHide: true, encoding: 'utf8' });
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
if (!HAS_WORK && ship.action === 'ff' && !DRY) {
  const r = git(['merge', '--ff-only', `origin/${defaultBranch}`]);
  say(r.status === 0 ? '[收工] 已快进到远端' : `[收工] 快进失败：${r.err.slice(0, 120)}`);
  if (r.status !== 0) unfinished = true;
}
if (!HAS_WORK && ship.action === 'push') {
  const checkFile = join(root, 'scripts', 'dao-check.mjs');
  if (existsSync(checkFile)) {
    if (DRY) say('[收工] [拟] 跑检查 node scripts/dao-check.mjs');
    else {
      // 快档是 dao-check 的默认档（2026-09-06 翻转）：只跑与本次改动相关的测试 + 跳过要出网的检查。
      // 这里不再传 `--affected`——那个旗标现在是等价别名，传了只会让人以为默认是全量。
      // 兜底靠两处，不靠这一次：CI 每次 PR 跑（全新 clone 无地图 ⇒ 自动全量）、本地可敲 `--full`。
      say('[收工] 推之前跑检查（快档：只跑受影响的）…');
      const c = spawnSync(process.execPath, [checkFile], { windowsHide: true, cwd: root, encoding: 'utf8' });
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
// 执行体在管的树绝不碰（拆树走编排闭环）。判据是路径：mirasim 建的树全部落在
// `<家目录>/mirasim-worktrees/<仓>/<分支>`，跟 dao.mjs 的 executorFromCwd 用同一把尺。
//
// 2026-09-06 换掉了原来的 `orca worktree list --json`：orca 退役后那条命令恒返空集，
// 而这里的「空集」被读成「没有任何树需要保护」——保护面会静默消失，land 就可能拆掉
// mirasim 工人正在里面干活的树。判据钉在一个会消失的外部命令上，是
// migration-half-done-breaks-checks 的同款：搬走了真相源，判据还留在旧位置。
//
// 路径判据没有「查不到」这一态：要么在那个目录下，要么不在，离线可判、不起子进程。
const isExecutorManaged = (abs) => /[\\/]mirasim-worktrees[\\/]/.test(abs);

const mergedSet = new Set(
  git(['branch', '--merged', defaultBranch, '--format=%(refname:short)']).out.split(/\r?\n/).filter(Boolean),
);

// 留树和删支读同一份 worktree 登记（#898：两处各解析一遍、各判一套占用，才出的「树留着支删了」）。
// occupied 是「当下还占着分支的树」：只有 land 自己**真拆掉**了某棵树，占用才随之解除；
// 拆失败 = 还占着（那正是 #898 现场的形状：树没拆成，分支却被删了）。
const worktrees = parseWorktrees(git(['worktree', 'list', '--porcelain']).out);
let occupied = worktrees.slice();

let removeCount = 0;
for (let i = 0; i < worktrees.length; i++) {
  const w = worktrees[i];
  const abs = resolve(w.path);
  const d = decideWorktreeRemove({
    branch: w.branch,
    merged: !!w.branch && mergedSet.has(w.branch),
    // squash 合并会产生全新 commit，原分支的提交在 master 里根本不存在，
    // 所以 `--merged` 这类按提交号比对的判据必然判「没合」——审官树因此每合一个 PR 漏拆一棵（#839）。
    // 按**内容**再问一次：合进去树变不变。变=真有没落地的活，不变=已经在里面了。
    ...(w.branch ? (({ contributes, everHadContent }) => ({ contributes, everHadContent }))(collectBranchMergeFacts({ git, branch: w.branch, defaultBranch })) : { contributes: null, everHadContent: null }),
    dirty: git(['status', '--porcelain'], { cwd: abs }).out !== '',
    isMain: i === 0,
    isCurrent: abs.toLowerCase() === resolve(root).toLowerCase() || abs.toLowerCase() === cwd.toLowerCase(),
    isDefaultBranch: w.branch === defaultBranch,
    executorManaged: isExecutorManaged(abs),
    detached: w.detached,
  });
  if (!d.remove) { if (i > 0) say(`[收工] 留树 ${w.path}：${d.reason}`); continue; }
  removeCount += 1;
  if (HAS_WORK) { say(`[收工] 有活：拆树 ${w.path}（${d.reason}）`); continue; }
  if (DRY) { say(`[收工] [拟] 拆树 ${w.path}（${d.reason}）`); continue; }
  const r = git(['worktree', 'remove', w.path]);
  if (r.status === 0) occupied = occupied.filter((x) => x.path !== w.path); // 真拆了才解除占用
  say(r.status === 0 ? `[收工] 拆树 ${w.path}（${d.reason}）` : `[收工] 拆树失败 ${w.path}：${r.err.slice(0, 120)}`);
}

let deleteCount = 0;
for (const name of git(['for-each-ref', 'refs/heads', '--format=%(refname:short)']).out.split(/\r?\n/).filter(Boolean)) {
  const d = decideBranchDelete({
    name,
    merged: mergedSet.has(name),
    ...(({ contributes, everHadContent }) => ({ contributes, everHadContent }))(collectBranchMergeFacts({ git, branch: name, defaultBranch })),
    isDefault: name === defaultBranch,
    isCurrent: name === branch,
    // 任何注册中的树占用即留支（含主树；主树那条另有 isDefault/isCurrent 先拦，说法不冲突）。
    checkedOutAt: branchCheckedOutAt(occupied, name),
  });
  if (!d.del) { if (!d.reason.includes('默认分支') && !d.reason.includes('当前分支')) say(`[收工] 留支 ${name}：${d.reason}`); continue; }
  deleteCount += 1;
  if (HAS_WORK) { say(`[收工] 有活：删支 ${name}`); continue; }
  if (DRY) { say(`[收工] [拟] 删支 ${name}`); continue; }
  // squash 之后 `branch -d` 必然拒绝（它也只认提交号），而那个拒绝正是 #839 的病。
  // 只有按内容证明过「合进去等于没合」的才回 -D；其余一律 -d，保住「宁可删不掉不可删错」。
  const r = git(['branch', d.flag || '-d', name]);
  say(r.status === 0 ? `[收工] 删支 ${name}` : `[收工] 删支失败 ${name}：${r.err.slice(0, 120)}`);
}

// ── ③ 僵尸终端：orca 登记着但工位目录已不在的终端，关掉（只认目录确实不存在；orca 不在 = 跳过） ──
let zombieCount = 0;
{
  const r = spawnSync('orca', ['terminal', 'list', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 15000, shell: true });
  let terminals = null;
  if (r.status === 0) { try { terminals = JSON.parse(r.stdout)?.result?.terminals; } catch { /* 畸形当没查成 */ } }
  if (Array.isArray(terminals)) {
    for (const t of terminals) {
      const p = String(t?.worktreePath || (String(t?.worktreeId || '').split('::')[1] || ''));
      const d = decideTerminalClose({ path: p, exists: p ? existsSync(p) : null });
      if (!d.close) continue;
      zombieCount += 1;
      if (HAS_WORK) { say(`[收工] 有活：关僵尸终端 ${t.handle}（${d.reason}）`); continue; }
      if (DRY) { say(`[收工] [拟] 关僵尸终端 ${t.handle}（${d.reason}）`); continue; }
      const c = spawnSync('orca', ['terminal', 'close', '--terminal', String(t.handle), '--tab'], { encoding: 'utf8', windowsHide: true, timeout: 15000, shell: true });
      say(c.status === 0 ? `[收工] 关僵尸终端 ${t.handle}（${d.reason}）` : `[收工] 关僵尸终端失败 ${t.handle}：${String(c.stderr || c.stdout).slice(0, 120)}`);
    }
  }
}

if (HAS_WORK) {
  const work = hasLandWork({ shipAction: ship.action, removeCount, deleteCount, zombieCount });
  say(work ? `[收工] 有活（运=${ship.action} 拆树=${removeCount} 删支=${deleteCount} 僵尸终端=${zombieCount}）` : '[收工] 没活');
  process.exit(work ? 0 : 2);
}

const staleRemote = git(['branch', '-r', '--merged', `origin/${defaultBranch}`, '--format=%(refname:short)']).out
  .split(/\r?\n/).filter(b => b && b.includes('/') && b !== `origin/${defaultBranch}` && !b.endsWith('/HEAD')); // 无 / 的是 origin/HEAD 缩写出的 origin，不是分支
if (staleRemote.length) say(`[收工] 远端已合并未删的分支（只列不删）：${staleRemote.join(' ')}`);

say(unfinished ? '[收工] 没收完，见上面的原因' : '[收工] 净');
process.exit(unfinished ? 1 : 0);
