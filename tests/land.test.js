// land 收工命令（2026-08-31）。判别力铁律：每类「不许删」的情形都要有故意样本被拦；
// e2e 用真 git 临时仓验「该删的删了、不该删的一根毛都没动」。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CORE = import('file://' + path.join(REPO, 'scripts', 'lib', 'land-core.mjs').replace(/\\/g, '/'));

describe('land 决策层', () => {
  it('decideShip：派生分支拒绝、发散停手、领先推、落后快进、一致净', async () => {
    const { decideShip } = await CORE;
    const base = { defaultBranch: 'master', hasOrigin: true, ahead: 0, behind: 0 };
    assert.equal(decideShip({ ...base, branch: 'feat-x' }).action, 'refuse');
    assert.equal(decideShip({ ...base, branch: 'HEAD' }).action, 'refuse');
    assert.equal(decideShip({ ...base, branch: 'master', ahead: 2, behind: 3 }).action, 'stop-diverged');
    assert.equal(decideShip({ ...base, branch: 'master', ahead: 2 }).action, 'push');
    assert.equal(decideShip({ ...base, branch: 'master', behind: 1 }).action, 'ff');
    assert.equal(decideShip({ ...base, branch: 'master' }).action, 'clean');
    assert.equal(decideShip({ ...base, branch: 'master', hasOrigin: false }).action, 'local-only');
  });

  it('landNoticeLine：只在默认分支确有未推提交时出一行，其余零输出', async () => {
    const { landNoticeLine } = await CORE;
    assert.match(landNoticeLine({ branch: 'master', defaultBranch: 'master', ahead: 2 }), /领先远端 2/);
    assert.equal(landNoticeLine({ branch: 'master', defaultBranch: 'master', ahead: 0 }), '');
    assert.equal(landNoticeLine({ branch: 'feat', defaultBranch: 'master', ahead: 3 }), '', '派生分支不提醒（进主分支另有路）');
    assert.equal(landNoticeLine({ branch: 'master', defaultBranch: 'master', ahead: NaN }), '', '探不出=沉默不是报警');
  });

  it('decideBranchDelete：只删已合并；默认/当前/被树占用/未合并全拦', async () => {
    const { decideBranchDelete } = await CORE;
    const del = (o) => decideBranchDelete({ merged: true, isDefault: false, isCurrent: false, checkedOutAt: '', ...o }).del;
    assert.equal(del({}), true);
    assert.equal(del({ merged: false }), false, '未合并=没做完的活');
    assert.equal(del({ isDefault: true }), false);
    assert.equal(del({ isCurrent: true }), false);
    assert.equal(del({ checkedOutAt: 'C:/somewhere' }), false);
  });

  it('decideWorktreeRemove：六道闸每道单独拦得住', async () => {
    const { decideWorktreeRemove } = await CORE;
    const ok = { branch: 'f', merged: true, dirty: false, isMain: false, isCurrent: false, isDefaultBranch: false, orcaManaged: false, detached: false };
    assert.equal(decideWorktreeRemove(ok).remove, true, '全绿样本必须可删，否则闸没判别力');
    for (const [k, v] of [['merged', false], ['dirty', true], ['isMain', true], ['isCurrent', true], ['isDefaultBranch', true], ['orcaManaged', true], ['detached', true]]) {
      assert.equal(decideWorktreeRemove({ ...ok, [k]: v }).remove, false, `${k}=${v} 必须拦`);
    }
  });
});

describe('land e2e（真 git 临时仓）', () => {
  it('推主分支；删已合并支；留未合并支/脏树；拆干净已合并树', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land-'));
    const g = (dir, ...args) => {
      const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.stderr}`);
      return r.stdout.trim();
    };
    const bare = path.join(tmp, 'origin.git');
    fs.mkdirSync(bare);
    g(tmp, 'init', '--bare', '-b', 'master', bare);
    const work = path.join(tmp, 'work');
    g(tmp, 'clone', bare, work);
    const env = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
    const commit = (msg) => g(work, ...env, 'commit', '--allow-empty', '-m', msg);
    commit('c1'); g(work, 'push', '-u', 'origin', 'master');
    // 已合并分支 merged-b；未合并分支 keep-b；已合并+干净的 worktree wt-m；脏的 worktree wt-dirty
    g(work, 'branch', 'merged-b');
    g(work, 'checkout', '-b', 'keep-b'); commit('unmerged'); g(work, 'checkout', 'master');
    g(work, 'checkout', '-b', 'wtm-b'); g(work, 'checkout', 'master'); // 已合并（同点）
    g(work, 'worktree', 'add', path.join(tmp, 'wt-m'), 'wtm-b');
    g(work, 'checkout', '-b', 'wtd-b'); g(work, 'checkout', 'master');
    g(work, 'worktree', 'add', path.join(tmp, 'wt-dirty'), 'wtd-b');
    fs.writeFileSync(path.join(tmp, 'wt-dirty', 'half.txt'), '半成品');
    commit('c2'); // master 领先 origin 1 个 → 该推
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'land.mjs'), work], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // 推到了
    assert.equal(g(bare, 'rev-parse', 'master'), g(work, 'rev-parse', 'master'), '主分支要推上远端');
    const branches = g(work, 'for-each-ref', 'refs/heads', '--format=%(refname:short)').split(/\r?\n/);
    assert.ok(!branches.includes('merged-b'), '已合并支要删：' + branches);
    assert.ok(!branches.includes('wtm-b'), '拆树后其已合并支要删：' + branches);
    assert.ok(branches.includes('keep-b'), '未合并支必须留');
    assert.ok(branches.includes('wtd-b'), '脏树的支必须留');
    assert.ok(!fs.existsSync(path.join(tmp, 'wt-m')), '干净+已合并的树要拆');
    assert.ok(fs.existsSync(path.join(tmp, 'wt-dirty', 'half.txt')), '脏树一根毛都不许动');
    assert.match(r.stdout, /留树 .*wt-dirty/, '留脏树要说原因');
  });

  it('派生分支上拒绝且 exit 1（不代劳进主分支）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land-b-'));
    const g = (...args) => spawnSync('git', ['-C', tmp, ...args], { encoding: 'utf8' });
    g('init', '-b', 'master', '.');
    spawnSync('git', ['-C', tmp, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'c'], { encoding: 'utf8' });
    g('checkout', '-b', 'feat');
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'land.mjs'), tmp], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /派生分支/, '要说清为什么拒绝、该走哪条路');
  });
});
