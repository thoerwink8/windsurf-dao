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
    const del = (o) => decideBranchDelete({ merged: true, everCommitted: true, isDefault: false, isCurrent: false, checkedOutAt: '', ...o }).del;
    assert.equal(del({}), true);
    assert.equal(del({ merged: false }), false, '未合并=没做完的活');
    assert.equal(del({ isDefault: true }), false);
    assert.equal(del({ isCurrent: true }), false);
    assert.equal(del({ checkedOutAt: 'C:/somewhere' }), false);
  });

  it('#898 landedMerged：可达 + 有过自己的提交才算合了；空分支/没查成都不算', async () => {
    const { landedMerged, decideBranchDelete, decideWorktreeRemove } = await CORE;
    assert.equal(landedMerged({ merged: true, everCommitted: true }), true);
    assert.equal(landedMerged({ merged: true, everCommitted: false }), false, '刚建没提交过 ≠ 已合并');
    assert.equal(landedMerged({ merged: true, everCommitted: null }), false, '没查成不是查过没事');
    assert.equal(landedMerged({ merged: false, everCommitted: true }), false);
    // 删支与拆树同源：同一组事实两处结论必须一致
    for (const ever of [false, null, undefined]) {
      const b = decideBranchDelete({ name: 'f', merged: true, everCommitted: ever, isDefault: false, isCurrent: false, checkedOutAt: '' });
      const w = decideWorktreeRemove({ branch: 'f', merged: true, everCommitted: ever, dirty: false, isMain: false, isCurrent: false, isDefaultBranch: false, orcaManaged: false, detached: false });
      assert.equal(b.del, false, `everCommitted=${ever} 时删支必须拦：${b.reason}`);
      assert.equal(w.remove, false, `everCommitted=${ever} 时拆树必须拦：${w.reason}`);
    }
    assert.equal(decideBranchDelete({ name: 'f', merged: true, everCommitted: true, isDefault: false, isCurrent: false, checkedOutAt: '' }).del, true, '真合并的还得删得掉，否则闸没判别力');
  });

  it('hasLandWork：只认 decide* 的结论，push/ff 或可清才算有活', async () => {
    const { hasLandWork } = await CORE;
    assert.equal(hasLandWork({ shipAction: 'push', removeCount: 0, deleteCount: 0 }), true);
    assert.equal(hasLandWork({ shipAction: 'ff', removeCount: 0, deleteCount: 0 }), true);
    assert.equal(hasLandWork({ shipAction: 'clean', removeCount: 1, deleteCount: 0 }), true);
    assert.equal(hasLandWork({ shipAction: 'clean', removeCount: 0, deleteCount: 1 }), true);
    assert.equal(hasLandWork({ shipAction: 'clean', removeCount: 0, deleteCount: 0 }), false, '净盘必须没活');
    assert.equal(hasLandWork({ shipAction: 'refuse', removeCount: 0, deleteCount: 0 }), false, '派生分支拒绝不算有活');
    assert.equal(hasLandWork({ shipAction: 'stop-diverged', removeCount: 0, deleteCount: 0 }), false, '发散停手不算有活');
    assert.equal(hasLandWork({ shipAction: 'local-only', removeCount: 0, deleteCount: 0 }), false);
  });

  it('decideWorktreeRemove：六道闸每道单独拦得住', async () => {
    const { decideWorktreeRemove } = await CORE;
    const ok = { branch: 'f', merged: true, everCommitted: true, dirty: false, isMain: false, isCurrent: false, isDefaultBranch: false, orcaManaged: false, detached: false };
    assert.equal(decideWorktreeRemove(ok).remove, true, '全绿样本必须可删，否则闸没判别力');
    for (const [k, v] of [['merged', false], ['everCommitted', false], ['dirty', true], ['isMain', true], ['isCurrent', true], ['isDefaultBranch', true], ['orcaManaged', true], ['detached', true]]) {
      assert.equal(decideWorktreeRemove({ ...ok, [k]: v }).remove, false, `${k}=${v} 必须拦`);
    }
  });
});

describe('land e2e（真 git 临时仓）', () => {
  it('推主分支；删真合并支；留未合并支/脏树；拆干净已合并树', () => {
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
    // merged-b：干过活并合进 master 的真合并支（无人占用）→ 该删
    g(work, 'checkout', '-b', 'merged-b'); commit('干过活'); g(work, 'checkout', 'master'); g(work, 'merge', 'merged-b');
    // keep-b：有提交没合 → 留
    g(work, 'checkout', '-b', 'keep-b'); commit('unmerged'); g(work, 'checkout', 'master');
    // wtm-b：真合并支 + 干净树 → 拆树并删支
    g(work, 'checkout', '-b', 'wtm-b'); commit('干过活2'); g(work, 'checkout', 'master'); g(work, 'merge', 'wtm-b');
    g(work, 'worktree', 'add', path.join(tmp, 'wt-m'), 'wtm-b');
    // wtd-b：脏树 → 树和支都留
    g(work, 'checkout', '-b', 'wtd-b'); g(work, 'checkout', 'master');
    g(work, 'worktree', 'add', path.join(tmp, 'wt-dirty'), 'wtd-b');
    fs.writeFileSync(path.join(tmp, 'wt-dirty', 'half.txt'), '半成品');
    commit('c2'); // master 领先 origin 1 个 → 该推
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'land.mjs'), work], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // 推到了
    assert.equal(g(bare, 'rev-parse', 'master'), g(work, 'rev-parse', 'master'), '主分支要推上远端');
    const branches = g(work, 'for-each-ref', 'refs/heads', '--format=%(refname:short)').split(/\r?\n/);
    assert.ok(!branches.includes('merged-b'), '真合并支要删：' + branches);
    assert.ok(!branches.includes('wtm-b'), '拆树后其真合并支要删：' + branches);
    assert.ok(branches.includes('keep-b'), '未合并支必须留');
    assert.ok(branches.includes('wtd-b'), '脏树的支必须留');
    assert.ok(!fs.existsSync(path.join(tmp, 'wt-m')), '干净+已合并的树要拆');
    assert.ok(fs.existsSync(path.join(tmp, 'wt-dirty', 'half.txt')), '脏树一根毛都不许动');
    assert.match(r.stdout, /留树 .*wt-dirty/, '留脏树要说原因');
  });

  // #898 实咬：工人刚 worktree add -b 出来、还没提交的分支被当「已合并」清掉（树留着支没了）。
  // 空分支 ref 与基点相等 ⇒ git branch --merged 恒真，只靠可达判不出「没开始」。
  it('#898 刚建还没提交的派生分支：树不拆、支不删（真合并的照删）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land-898-'));
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
    // ① 工人刚开工：树里的空分支（本单主角）
    const wtFresh = path.join(tmp, 'wt-fresh');
    g(work, 'worktree', 'add', wtFresh, '-b', 'fresh-wt-b', 'master');
    // ② 没人占用的空分支：也没「合」过，同样不许清
    g(work, 'branch', 'fresh-b');
    // ③ 对照：真干过活并合进 master 的支，必须照删——否则闸没判别力
    g(work, 'checkout', '-b', 'real-merged-b'); commit('真干了活'); g(work, 'checkout', 'master'); g(work, 'merge', 'real-merged-b');
    // ④ 真合并、但树还占着（脏，land 不拆）→ 留树就得留支：这两个判断必须同源
    const wtBusy = path.join(tmp, 'wt-busy');
    g(work, 'checkout', '-b', 'busy-b'); commit('干过活'); g(work, 'checkout', 'master'); g(work, 'merge', 'busy-b');
    g(work, 'worktree', 'add', wtBusy, 'busy-b');
    fs.writeFileSync(path.join(wtBusy, 'half.txt'), '半成品');

    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'land.mjs'), work], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const branches = g(work, 'for-each-ref', 'refs/heads', '--format=%(refname:short)').split(/\r?\n/);
    assert.ok(branches.includes('fresh-wt-b'), '#898 占用中的空分支不许删：' + r.stdout);
    assert.ok(fs.existsSync(wtFresh), '#898 刚建的树不许拆：' + r.stdout);
    assert.ok(branches.includes('fresh-b'), '#898 从没提交过的分支不是「已合并」：' + r.stdout);
    assert.ok(!branches.includes('real-merged-b'), '真合并支还得删得掉，否则是把清理关了：' + r.stdout);
    assert.ok(branches.includes('busy-b'), '#898 树还占着就不许删支（留树留支同源）：' + r.stdout);
    assert.ok(fs.existsSync(path.join(wtBusy, 'half.txt')), '占着的脏树一根毛都不许动');
    assert.match(r.stdout, /留支 fresh-b：.*没有过自己的提交/, '留支要说清是「没开始」不是「未合并」');
  });

  it('--has-work：有已合并支 → 0 且不删；净盘 → 非 0', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land-hw-'));
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
    const commit = (msg) => spawnSync('git', ['-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', msg], { encoding: 'utf8' });
    commit('c1');
    // 真合并支才是「可清」样本：空分支从没提交过，不算已合并（#898）
    g(work, 'checkout', '-b', 'merged-b'); commit('干过活'); g(work, 'checkout', 'master'); g(work, 'merge', 'merged-b');
    g(work, 'push', '-u', 'origin', 'master');
    const land = path.join(REPO, 'scripts', 'land.mjs');
    const has = spawnSync(process.execPath, [land, '--has-work', work], { encoding: 'utf8' });
    assert.equal(has.status, 0, has.stdout + has.stderr);
    assert.match(has.stdout, /有活/);
    const branches = g(work, 'for-each-ref', 'refs/heads', '--format=%(refname:short)').split(/\r?\n/);
    assert.ok(branches.includes('merged-b'), 'precheck 不许真删：' + branches);
    const gone = spawnSync('git', ['-C', work, 'branch', '-d', 'merged-b'], { encoding: 'utf8' });
    assert.equal(gone.status, 0, gone.stderr);
    const none = spawnSync(process.execPath, [land, '--has-work', work], { encoding: 'utf8' });
    assert.notEqual(none.status, 0, none.stdout);
    assert.match(none.stdout, /没活/);
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
