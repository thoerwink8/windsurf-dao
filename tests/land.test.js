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
    // 已合并分支 merged-b；未合并分支 keep-b；已合并+干净的 worktree wt-m；脏的 worktree wt-dirty；
    // 刚建零提交的 fresh-b（无树）与 fresh-wt-b（干净树 wt-fresh）——#898 那两种「不该动」的形状。
    // merged-b / wtm-b 要**真干过活再合进来**：拿零提交的书签当「已合并」样本，正是 #898 的病本身。
    const mergeIn = (b) => { g(work, ...env, 'merge', '--no-ff', '-m', `merge ${b}`, b); };
    g(work, 'checkout', '-b', 'merged-b'); commit('干完的活'); g(work, 'checkout', 'master'); mergeIn('merged-b');
    g(work, 'checkout', '-b', 'keep-b'); commit('unmerged'); g(work, 'checkout', 'master');
    g(work, 'checkout', '-b', 'wtm-b'); commit('树里干完的活'); g(work, 'checkout', 'master'); mergeIn('wtm-b');
    g(work, 'worktree', 'add', path.join(tmp, 'wt-m'), 'wtm-b');
    g(work, 'checkout', '-b', 'wtd-b'); g(work, 'checkout', 'master');
    g(work, 'worktree', 'add', path.join(tmp, 'wt-dirty'), 'wtd-b');
    fs.writeFileSync(path.join(tmp, 'wt-dirty', 'half.txt'), '半成品');
    g(work, 'branch', 'fresh-b');                                        // 刚 branch 出来，零提交
    g(work, 'worktree', 'add', '-b', 'fresh-wt-b', path.join(tmp, 'wt-fresh')); // 刚 worktree add -b，零提交且树干净
    // 占用判据自己的样本：真已合并（上面那条「零提交」判据放行它），全靠「被树占用」这一条留住。
    g(work, 'checkout', '-b', 'wtdm-b'); commit('干完的活·树还没清'); g(work, 'checkout', 'master'); mergeIn('wtdm-b');
    g(work, 'worktree', 'add', path.join(tmp, 'wt-dm'), 'wtdm-b');
    fs.writeFileSync(path.join(tmp, 'wt-dm', 'scratch.txt'), '还在试的东西');
    commit('c2'); // master 领先 origin 1 个 → 该推；也让上面两条零提交支变成「主干上的严格祖先」（#898 真实时序）
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
    // #898：刚建、零提交的分支不是垃圾，是别人刚起的头
    assert.ok(branches.includes('fresh-b'), '刚建零提交的支必须留（--merged 对它恒真，那是没开始不是干完了）：' + branches);
    assert.ok(branches.includes('fresh-wt-b'), '刚 worktree add -b 出来的支必须留：' + branches);
    assert.ok(fs.existsSync(path.join(tmp, 'wt-fresh')), '刚建的树必须留——树和支一起没，工人回来什么都不剩');
    // 留树与删支共用同一份占用登记：树留下了，它的分支就必须跟着留下（#898 的实质）
    assert.ok(branches.includes('wtdm-b'), '被留下的树，它的支必须跟着留——哪怕那条支真已合并：' + branches);
    assert.match(r.stdout, /留支 wtdm-b：被 worktree 占用/, '留的理由必须是「占用」，不能是删失败后的将就');
    assert.ok(fs.existsSync(path.join(tmp, 'wt-dm', 'scratch.txt')), '树里没提交的东西一根毛都不许动');
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
    const env = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
    const commit = (msg) => g(work, ...env, 'commit', '--allow-empty', '-m', msg);
    commit('c1');
    g(work, 'push', '-u', 'origin', 'master');
    // 真干过活再合进来才算「已合并」——零提交的书签在 #898 之后一律留着，拿它当样本这条测试恒判「没活」。
    g(work, 'checkout', '-b', 'merged-b'); commit('干完的活'); g(work, 'checkout', 'master');
    g(work, ...env, 'merge', '--no-ff', '-m', 'merge merged-b', 'merged-b');
    g(work, 'push', 'origin', 'master'); // 推平，让「有活」只可能来自那条可删的分支
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

// #839（2026-09-03 实咬）：PR 走 squash 合并后原分支的提交号在 master 里根本不存在，
// 提交号类判据（git branch --merged / git cherry）必然判「未合并」，审官分支/树每合一个 PR 漏一条。
// 这一组的判别力靠三样：squash 样本必须判「已合」、真没合的必须判「没合」、没查成必须第三态可辨。
describe('land 认 squash 合并（#839）', () => {
  it('judgeBranchGone：squash 判「已合」、真没合判「没合」、没查成不与二者混', async () => {
    const { judgeBranchGone } = await CORE;
    // 违规样本（改判据前的病）：老 --merged 判 false，而内容已全在 master
    const squash = judgeBranchGone({ name: 'PR-820-审官-gpt-5.6-sol', merged: false, contributes: false });
    assert.equal(squash.gone, true, 'squash 合并过的分支必须判「已合」');
    assert.equal(squash.how, 'squash-content');
    // 反证：真有 master 没有的东西，一根毛都不许删（判据不许恒真）
    const real = judgeBranchGone({ name: 'feat-x', merged: false, contributes: true });
    assert.equal(real.gone, false, '真没合的分支必须判「没合」');
    assert.match(real.reason, /没做完/);
    // 「没查成」和「查过没事」在 reason 上必须分得开
    const unk = judgeBranchGone({ name: 'feat-x', merged: false, contributes: null });
    assert.equal(unk.gone, false, 'merge-tree 判不了 ⇒ 不删');
    assert.match(unk.reason, /没查成/);
    assert.notEqual(unk.reason, real.reason, '「没查成」不许说成「没做完」');
    // 老调用方（只给 merged）行为不变
    assert.equal(judgeBranchGone({ name: 'b', merged: true }).how, 'ancestor');
    assert.equal(judgeBranchGone({ name: 'b', merged: false }).gone, false, '没探内容时不许凭空放行');
  });

  it('审官分支：PR 已合/已关 → 删；PR 还开着 → 留；有独有提交 → 报出来不删', async () => {
    const { judgeBranchGone, reviewerBranchPr } = await CORE;
    const name = 'PR-820-审官-gpt-5.6-sol';
    assert.equal(reviewerBranchPr(name), 820);
    assert.equal(reviewerBranchPr('PR-#820 审官·gpt-5.6-sol'), 820, '卡名形态也要认');
    assert.equal(reviewerBranchPr('PR-820-工人-grok'), null, '工人分支不许被审官规则顺手删掉');
    assert.equal(reviewerBranchPr('审官笔记'), null, '没 PR 号就认不出，别猜');

    assert.equal(judgeBranchGone({ name, merged: false, prState: 'MERGED' }).gone, true);
    assert.equal(judgeBranchGone({ name, merged: false, prState: 'CLOSED' }).gone, true);
    assert.equal(judgeBranchGone({ name, merged: false, prState: 'MERGED' }).how, 'reviewer-pr-done');
    const open = judgeBranchGone({ name, merged: false, prState: 'OPEN' });
    assert.equal(open.gone, false, 'PR 还开着 → 留（判据不许恒真）');
    assert.match(open.reason, /还开着/);
    const dirtyReviewer = judgeBranchGone({ name, merged: false, contributes: true, prState: 'MERGED' });
    assert.equal(dirtyReviewer.gone, false, '审官有独有提交 → 不许删');
    assert.match(dirtyReviewer.reason, /审官不该改代码/);
    // prState 不传（land 不依赖 gh）⇒ 这条判据整条不启用，回落到内容判据
    assert.equal(judgeBranchGone({ name, merged: false }).gone, false);
    assert.equal(judgeBranchGone({ name, merged: false, contributes: false }).how, 'squash-content');
  });

  it('branchDeleteFlag：只有按内容证明过的才敢 -D，其余一律 -d', async () => {
    const { branchDeleteFlag } = await CORE;
    assert.equal(branchDeleteFlag('squash-content'), '-D');
    assert.equal(branchDeleteFlag('reviewer-pr-done'), '-D');
    assert.equal(branchDeleteFlag('ancestor'), '-d', '祖先关系用 -d，让 git 再拦一道');
    assert.equal(branchDeleteFlag(null), '-d', 'how 认不出宁可删不掉');
    assert.equal(branchDeleteFlag('乱七八糟'), '-d');
  });

  it('decideBranchDelete / decideWorktreeRemove 共用同一把尺（审官树漏拆是同一个病）', async () => {
    const { decideBranchDelete, decideWorktreeRemove } = await CORE;
    const b = (o) => decideBranchDelete({ name: 'PR-820-审官-x', merged: false, isDefault: false, isCurrent: false, checkedOutAt: '', ...o });
    assert.equal(b({ contributes: false }).del, true, 'squash 支要删');
    assert.equal(b({ contributes: false }).flag, '-D');
    assert.equal(b({ contributes: true }).del, false, '真没合不许删');
    assert.equal(b({ contributes: null }).del, false, '没查成不许删');
    assert.equal(b({ contributes: false, isCurrent: true }).del, false, '当前分支闸仍在最前面');
    assert.equal(b({ contributes: false, checkedOutAt: 'C:/x' }).del, false, '被树占用闸仍在');

    const w = (o) => decideWorktreeRemove({ branch: 'PR-820-审官-x', merged: false, dirty: false, isMain: false, isCurrent: false, isDefaultBranch: false, orcaManaged: false, detached: false, ...o });
    assert.equal(w({ contributes: false }).remove, true, 'squash 支的审官树要拆');
    assert.equal(w({ contributes: true }).remove, false);
    assert.equal(w({ contributes: null }).remove, false);
    assert.match(w({ contributes: null }).reason, /没查成/);
    assert.equal(w({ contributes: false, dirty: true }).remove, false, '脏树闸仍在 squash 判据前面');
    assert.equal(w({ contributes: false, orcaManaged: true }).remove, false, 'orca 在管仍不碰');
  });

  it('collectBranchMergeFacts：git 答不上来 ⇒ contributes:null，绝不当成 false', async () => {
    const { collectBranchMergeFacts, judgeBranchGone } = await CORE;
    // 老 git（无 --write-tree）/ 合不干净都长这样：非零退出
    const oldGit = (args) => (args[0] === 'merge-base' ? { status: 1, out: '' } : { status: 128, out: '', err: 'error: unknown option `write-tree`' });
    const f = collectBranchMergeFacts({ git: oldGit, branch: 'x', defaultBranch: 'master' });
    assert.equal(f.ancestor, false);
    assert.equal(f.contributes, null, '探不成必须是 null——当成 false 会把没做完的活删光');
    assert.match(judgeBranchGone({ name: 'x', merged: f.ancestor, contributes: f.contributes }).reason, /没查成/);
    // 没给 runner 也一样：两条都 null，不许瞎猜
    assert.deepEqual(collectBranchMergeFacts({ branch: 'x', defaultBranch: 'master' }),
      { ancestor: null, contributes: null, everHadContent: null });
  });

  it('真 git：squash 合进 master 的分支判「已合」，真没合的判「没合」（老 --merged 在同一夹具上失手）', async () => {
    const { collectBranchMergeFacts, judgeBranchGone, branchDeleteFlag } = await CORE;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land-squash-'));
    const env = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
    const raw = (args) => {
      const r = spawnSync('git', ['-C', tmp, ...env, ...args], { encoding: 'utf8' });
      return { status: r.status ?? 1, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
    };
    const g = (...args) => {
      const r = raw(args);
      assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.err}`);
      return r.out;
    };
    const put = (f, s) => fs.writeFileSync(path.join(tmp, f), s);
    g('init', '-b', 'master', '.');
    put('a.txt', 'a\n'); g('add', '-A'); g('commit', '-m', 'c1');
    // 工人分支两个提交 → 审官分支从它的 head 切出来（零提交）→ master 把工人分支 squash 进来
    g('checkout', '-b', 'feat-x');
    put('b.txt', 'b\n'); g('add', '-A'); g('commit', '-m', 'w1');
    put('b.txt', 'bb\n'); g('add', '-A'); g('commit', '-m', 'w2');
    g('checkout', '-b', 'PR-820-审官-gpt-5.6-sol');
    g('checkout', 'master');
    g('merge', '--squash', 'feat-x');
    g('commit', '-m', 'squash: feat-x (#820)');
    // 真没合的活 + 老路合进来的（tip 是祖先）
    g('checkout', '-b', 'real-work');
    put('c.txt', 'c\n'); g('add', '-A'); g('commit', '-m', '还没合的活');
    g('checkout', 'master');
    g('branch', 'ff-merged');

    // 夹具确实是「老判据失手」的那一种，否则下面全是空转
    const oldMerged = g('branch', '--merged', 'master', '--format=%(refname:short)').split(/\r?\n/);
    assert.ok(!oldMerged.includes('feat-x'), '夹具没造对：老判据本该判不出 squash → ' + oldMerged.join(','));
    assert.ok(!oldMerged.includes('PR-820-审官-gpt-5.6-sol'), '夹具没造对：审官分支本该也判不出');
    assert.notEqual(raw(['branch', '-d', 'feat-x']).status, 0, 'git branch -d 本该拒 squash 过的分支——这就是要 -D 的理由');

    const facts = (b) => collectBranchMergeFacts({ git: raw, branch: b, defaultBranch: 'master' });
    for (const b of ['feat-x', 'PR-820-审官-gpt-5.6-sol']) {
      const f = facts(b);
      assert.equal(f.ancestor, false, `${b}：squash 之后 tip 不可能是祖先`);
      assert.equal(f.contributes, false, `${b}：合进 master 等于没合`);
      const v = judgeBranchGone({ name: b, merged: f.ancestor, contributes: f.contributes });
      assert.equal(v.gone, true, `${b} 必须判「已合」：${v.reason}`);
      assert.equal(branchDeleteFlag(v.how), '-D', 'squash 情形非 -D 删不掉');
    }
    const rw = facts('real-work');
    assert.equal(rw.contributes, true, 'real-work 真有 master 没有的东西');
    const rv = judgeBranchGone({ name: 'real-work', merged: rw.ancestor, contributes: rw.contributes });
    assert.equal(rv.gone, false, '真没合的分支必须留着：' + rv.reason);
    assert.equal(branchDeleteFlag(rv.how), '-d');
    const ff = facts('ff-merged');
    assert.equal(ff.ancestor, true, '祖先关系照旧判得出');
    assert.equal(branchDeleteFlag(judgeBranchGone({ name: 'ff-merged', merged: ff.ancestor, contributes: ff.contributes }).how), '-d');
  });
});

// 2026-09-05 实咬：把「按内容判已合」接进 land.mjs 那一刻，land e2e 当场判红「未合并支必须留」。
// 真因——工人开工第一步就是 `git commit --allow-empty -m "起<任务>分支"`，那支的内容与 master
// 一模一样，「合进去等于没合」对它**恒成立**，于是刚开工的分支会被当成 squash 残支删掉。
// 分界：squash 过的分支**有过真改动**（只是被压成新 commit）；空提交撑的分支**从来没有过**。
describe('空提交撑的分支不许当成 squash 残支删掉', () => {
  const j = async (over) => (await CORE).judgeBranchGone({ name: 'feat-x', merged: false, contributes: false, ...over });

  it('从来没有过自己的改动 → 不删，且理由要说清是哪一种', async () => {
    const r = await j({ everHadContent: false });
    assert.equal(r.gone, false);
    assert.match(r.reason, /从来没有过自己的改动/);
  });

  it('有过真改动 + 合进去等于没合 → 才是 squash 残支，删', async () => {
    const r = await j({ everHadContent: true });
    assert.equal(r.gone, true);
    assert.equal(r.how, 'squash-content');
  });

  it('故意违规样本：有没有过改动没查成 → 不删（没查成 ≠ 没事）', async () => {
    const r = await j({ everHadContent: null });
    assert.equal(r.gone, false);
    assert.match(r.reason, /没查成/);
  });

  it('老调用方没探这一项（undefined）→ 行为与本次改动前一致，不回归', async () => {
    const r = await j({});
    assert.equal(r.gone, true, 'undefined 表示压根没探，不能当成「探了是 false」');
    assert.equal(r.how, 'squash-content');
  });

  it('null 和 undefined 必须分得开——混成一个就等于把「没查成」当「没探」放行', async () => {
    assert.notEqual((await j({ everHadContent: null })).gone, (await j({ everHadContent: undefined })).gone);
  });

  it('land.mjs 真的把这一项传下去了——不传等于这道守卫不存在', async () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'land.mjs'), 'utf8');
    const n = (src.match(/everHadContent/g) || []).length;
    assert.ok(n >= 2, `land.mjs 只出现 ${n} 处 everHadContent，删支和拆树两条路都要传`);
  });
});

// #898（2026-09-04 实咬）：`git worktree add -b` 刚建出来、一个提交都还没有的分支，其 ref 就等于
// master 的 ref，`git branch --merged` 对它恒真 → land 判「已合并」→ 删支。工人正在那棵树上干活。
// 本单实测复现出更狠的一路：树还干净时**树和支一起没**，工人回来什么都不剩。
// 判别力靠三样：零提交支必须留、真已合并支必须删（判据不许恒拒）、没查成必须第三态可辨。
describe('零提交的新分支不是「已合并」（#898）', () => {
  const j = async (over) => (await CORE).judgeBranchGone({ name: 'fix/895-vendor-gate', merged: true, ...over });

  it('刚建、零提交 → 不删，理由要说清是「没开始」不是「没查成」', async () => {
    const r = await j({ everHadContent: false });
    assert.equal(r.gone, false);
    assert.match(r.reason, /从来没有过自己的提交/);
    assert.doesNotMatch(r.reason, /没查成/, '「没开始」不许说成「没查成」——两者处置不同');
  });

  it('反证：真干过活又合进主分支 → 照删（判据不许恒拒）', async () => {
    const r = await j({ everHadContent: true });
    assert.equal(r.gone, true);
    assert.equal(r.how, 'ancestor');
  });

  it('故意违规样本：有没有过提交没查成 → 不删（删分支不可逆，一律 fail-closed）', async () => {
    const r = await j({ everHadContent: null });
    assert.equal(r.gone, false);
    assert.match(r.reason, /没查成/);
  });

  it('老调用方没探（undefined）→ 维持改动前行为，不回归', async () => {
    assert.equal((await j({})).gone, true);
    assert.equal((await j({})).how, 'ancestor');
    assert.notEqual((await j({ everHadContent: null })).gone, (await j({})).gone,
      'null 与 undefined 混成一个，就等于把「没查成」当「没探」放行');
  });

  it('两道闸都吃这条事实：删支和拆树用的是同一把尺', async () => {
    const { decideBranchDelete, decideWorktreeRemove } = await CORE;
    const b = (o) => decideBranchDelete({ name: 'f', merged: true, isDefault: false, isCurrent: false, checkedOutAt: '', ...o });
    assert.equal(b({ everHadContent: false }).del, false, '零提交支不许删');
    assert.equal(b({ everHadContent: true }).del, true, '真已合并支照删');
    const w = (o) => decideWorktreeRemove({ branch: 'f', merged: true, dirty: false, isMain: false, isCurrent: false, isDefaultBranch: false, orcaManaged: false, detached: false, ...o });
    assert.equal(w({ everHadContent: false }).remove, false, '零提交支的树不许拆——那是刚开工的工位');
    assert.match(w({ everHadContent: false }).reason, /从来没有过自己的提交/);
    assert.equal(w({ everHadContent: true }).remove, true, '真已合并支的干净树照拆');
  });

  it('parseWorktrees / branchCheckedOutAt：占用登记只解析一次，两处共用', async () => {
    const { parseWorktrees, branchCheckedOutAt } = await CORE;
    const porcelain = [
      'worktree D:/frank/windsurf-dao\nHEAD aaa\nbranch refs/heads/master',
      'worktree D:/frank/wd-895-gate\nHEAD bbb\nbranch refs/heads/fix/895-vendor-gate',
      'worktree D:/frank/wt-detached\nHEAD ccc\ndetached',
    ].join('\n\n');
    const wts = parseWorktrees(porcelain);
    assert.equal(wts.length, 3, '三块都要认出来：' + JSON.stringify(wts));
    assert.equal(wts[1].branch, 'fix/895-vendor-gate', '带斜杠的分支名不许被截断');
    assert.equal(wts[2].detached, true);
    assert.equal(wts[2].branch, '', 'detached 没有分支');
    assert.equal(branchCheckedOutAt(wts, 'fix/895-vendor-gate'), 'D:/frank/wd-895-gate');
    assert.equal(branchCheckedOutAt(wts, '没人占用的支'), '', '判据不许恒真：没占用要回空');
    assert.equal(branchCheckedOutAt(wts, ''), '');
    assert.equal(branchCheckedOutAt([], 'x'), '');
    assert.equal(parseWorktrees('').length, 0, '空输入回空表，不许炸');
  });

  it('真 git：零提交支判「没开始」、真已合并支判「已合」——老判据在同一夹具上两个都判「已合」', async () => {
    const { collectBranchMergeFacts, judgeBranchGone } = await CORE;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land-898-'));
    const env = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
    const raw = (args) => {
      const r = spawnSync('git', ['-C', tmp, ...env, ...args], { encoding: 'utf8' });
      return { status: r.status ?? 1, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
    };
    const g = (...args) => {
      const r = raw(args);
      assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.err}`);
      return r.out;
    };
    const put = (f, s) => fs.writeFileSync(path.join(tmp, f), s);
    g('init', '-b', 'master', '.');
    put('a.txt', 'a\n'); g('add', '-A'); g('commit', '-m', 'c1');
    // ① 刚建、零提交的支（`worktree add -b` 的形状），之后 master 继续往前走——#898 的真实时序
    g('branch', 'fix/895-vendor-gate');
    // ② 真干过活、合进 master 的支
    g('checkout', '-b', 'landed-work');
    put('b.txt', 'b\n'); g('add', '-A'); g('commit', '-m', '干完的活');
    g('checkout', 'master');
    g('merge', '--no-ff', '-m', 'merge landed-work', 'landed-work');
    put('c.txt', 'c\n'); g('add', '-A'); g('commit', '-m', '帅位又在 master 上提交了一笔');

    // 夹具必须是「老判据失手」的那一种，否则下面全是空转
    const oldMerged = g('branch', '--merged', 'master', '--format=%(refname:short)').split(/\r?\n/);
    assert.ok(oldMerged.includes('fix/895-vendor-gate'), '夹具没造对：老判据本该把零提交支也算进「已合并」');
    assert.ok(oldMerged.includes('landed-work'), '夹具没造对：真已合并支本该在里面');
    // 变异自证：把判据换回「和分叉点比内容」（改动前那一问），两条支的答案一模一样 → 分不开
    for (const b of ['fix/895-vendor-gate', 'landed-work']) {
      const base = g('merge-base', 'master', b);
      assert.equal(raw(['diff', '--quiet', base, b]).status, 0,
        `${b}：老那问对已进主分支的支恒答「无差异」——判据改回去这条测试必红`);
    }

    const facts = (b) => collectBranchMergeFacts({ git: raw, branch: b, defaultBranch: 'master' });
    const fresh = facts('fix/895-vendor-gate');
    assert.equal(fresh.ancestor, true, '零提交支的 tip 当然是祖先——这正是老判据被骗的地方');
    assert.equal(fresh.everHadContent, false, '它从没走出过主干');
    const fv = judgeBranchGone({ name: 'fix/895-vendor-gate', merged: true, contributes: fresh.contributes, everHadContent: fresh.everHadContent });
    assert.equal(fv.gone, false, '刚建的支必须留着：' + fv.reason);

    const done = facts('landed-work');
    assert.equal(done.ancestor, true);
    assert.equal(done.everHadContent, true, '它的提交是被合进来的，走出过自己的路');
    const dv = judgeBranchGone({ name: 'landed-work', merged: true, contributes: done.contributes, everHadContent: done.everHadContent });
    assert.equal(dv.gone, true, '真已合并的支必须照删（判据不许恒拒）：' + dv.reason);
    assert.equal(raw(['branch', '-d', 'landed-work']).status, 0, '-d 删得掉，说明它确实是干完合了');
  });

  it('land.mjs 真的接了线：占用登记只解析一处，且拆树成功才解除占用', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'land.mjs'), 'utf8');
    assert.ok(src.length > 2000, '源码没读到就不是「查过没事」');
    const parses = (src.match(/worktree', 'list', '--porcelain'/g) || []).length;
    assert.equal(parses, 1, `land.mjs 里 worktree porcelain 解析了 ${parses} 处——两处各写一遍正是 #898 这个洞`);
    assert.match(src, /branchCheckedOutAt\(occupied,/, '删支的占用判据必须来自那份共用登记');
    assert.match(src, /if \(r\.status === 0\) occupied = occupied\.filter/, '只有树真拆掉了，占用才解除');
    assert.equal((src.match(/everHadContent/g) || []).length >= 2, true, '删支和拆树两条路都要把这条事实传下去');
  });
});
