// #1024：派工链 --repo owner/name。不传一字不变；非法格式当场拒；没授权拒且不许回落本仓；
// 名单没扫成报「没查成」，不许当成「这个仓不存在」。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs');
const DAO = path.join(REPO, 'scripts', 'dao.mjs');
const { cliInProc } = require('./helpers/dao-harness');
const S_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

describe('#1024 parseOwnerNameRepo / withGhRepo / assertRepoAuthorized', () => {
  it('不传 / 空串 = 省略（本仓路径一字不变）', async () => {
    const S = await S_LOAD;
    assert.equal(S.parseOwnerNameRepo(undefined).omitted, true);
    assert.equal(S.parseOwnerNameRepo(null).omitted, true);
    assert.equal(S.parseOwnerNameRepo('').omitted, true);
    // 纯空白不是「没传」，是带空格的非法格式（#1028 审官红 2）。
    const keep = S.withGhRepo(['issue', 'view', '1'], undefined);
    assert.equal(keep.ok, true);
    assert.deepEqual(keep.args, ['issue', 'view', '1']);
    assert.equal(keep.injected, false);
  });

  it('合法 owner/name 收下；gh 参数钉 --repo', async () => {
    const S = await S_LOAD;
    const p = S.parseOwnerNameRepo('thoerwink8/ws-cleaner');
    assert.equal(p.ok, true);
    assert.equal(p.omitted, false);
    assert.equal(p.ownerName, 'thoerwink8/ws-cleaner');
    const pinned = S.withGhRepo(['pr', 'view', '12'], 'thoerwink8/ws-cleaner');
    assert.equal(pinned.ok, true);
    assert.equal(pinned.injected, true);
    assert.deepEqual(pinned.args, ['pr', 'view', '12', '--repo', 'thoerwink8/ws-cleaner']);
  });

  it('格式非法：缺 owner、带空格、URL、路径、半截选择符当场拒', async () => {
    const S = await S_LOAD;
    for (const bad of ['ws-cleaner', 'thoerwink8 /ws-cleaner', 'https://github.com/a/b', 'id:uuid', '/srv/projects/x', 'git@github.com:a/b.git']) {
      const r = S.parseOwnerNameRepo(bad);
      assert.equal(r.ok, false, bad);
      assert.match(String(r.error), /格式非法/);
    }
  });

  it('格式非法：首空格 / 尾空格 / 首尾同时有空格当场拒，不许 trim 后收下', async () => {
    const S = await S_LOAD;
    for (const bad of [' thoerwink8/ws-cleaner', 'thoerwink8/ws-cleaner ', ' thoerwink8/ws-cleaner ', '  ']) {
      const r = S.parseOwnerNameRepo(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.omitted, undefined, JSON.stringify(bad));
      assert.match(String(r.error), /带空格/);
    }
  });

  it('授权闸：扫成且不在名单 → 这个仓没授权给 <role>，不许回落', async () => {
    const S = await S_LOAD;
    const denied = S.assertRepoAuthorized({
      ownerName: 'someone/other',
      role: 'worker',
      repositories: ['thoerwink8/windsurf-dao', 'thoerwink8/ws-cleaner'],
      repoScan: { scanned: true, count: 2 },
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.unscanned, undefined);
    assert.match(denied.error, /这个仓没授权给 worker/);
    assert.match(denied.error, /someone\/other/);
    assert.doesNotMatch(denied.error, /不存在/);

    const ok = S.assertRepoAuthorized({
      ownerName: 'thoerwink8/ws-cleaner',
      role: 'worker',
      repositories: ['thoerwink8/windsurf-dao', 'thoerwink8/ws-cleaner'],
      repoScan: { scanned: true, count: 2 },
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.ownerName, 'thoerwink8/ws-cleaner');
  });

  it('授权闸：名单没扫成 → 没查成，不许当成这个仓不存在', async () => {
    const S = await S_LOAD;
    const miss = S.assertRepoAuthorized({
      ownerName: 'thoerwink8/ws-cleaner',
      role: 'reviewer',
      repositories: [],
      repoScan: { scanned: false, error: 'network down' },
    });
    assert.equal(miss.ok, false);
    assert.equal(miss.unscanned, true);
    assert.match(miss.error, /没查成/);
    assert.match(miss.error, /不是「这个仓不存在」/);
  });

  it('跨仓 resolveRepoSelector 不许路径兜底回落本仓', async () => {
    const S = await S_LOAD;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-repo-1024-'));
    const ident = (url) => ({ gitRemoteIdentity: { remoteUrl: url } });
    const pathOnly = S.resolveRepoSelector({
      repos: [{ id: 'local', path: root }],
      root,
      remoteUrl: 'https://github.com/thoerwink8/ws-cleaner.git',
      allowPath: false,
      label: 'thoerwink8/ws-cleaner',
    });
    assert.equal(pathOnly.ok, false);
    assert.match(pathOnly.error, /thoerwink8\/ws-cleaner/);
    assert.match(pathOnly.error, /不许回落本仓/);

    const remoteHit = S.resolveRepoSelector({
      repos: [
        { id: 'local', path: root },
        { id: 'cleaner', ...ident('https://github.com/thoerwink8/ws-cleaner.git') },
      ],
      root,
      remoteUrl: 'https://github.com/thoerwink8/ws-cleaner.git',
      allowPath: false,
      label: 'thoerwink8/ws-cleaner',
    });
    assert.equal(remoteHit.ok, true);
    assert.equal(remoteHit.selector, 'id:cleaner');
    assert.equal(remoteHit.matchedBy, 'remote');
  });
});

describe('#1024 FLAGS / 热路贯通 / CLI 早退', () => {
  it('dispatch / reviewer-create / worker-done / reviewer-attach / review-pending-drain 都登记 --repo', async () => {
    const S = await S_LOAD;
    for (const v of ['dispatch', 'reviewer-create', 'worker-done', 'reviewer-attach', 'review-pending-drain']) {
      assert.equal(S.FLAGS_BY_VERB[v].has('--repo'), true, v);
    }
  });

  it('热路把 --repo 写进派工单；执行体再过闸；审官/交卷/drain 都调 assertCrossRepoOrFail', () => {
    const src = fs.readFileSync(DAO, 'utf8');
    // #1115 删了 orca 派工单脊：cmdDispatch 只转 mirasim。闸在 resolveMirasimRepoTarget 里。
    const dispatch = src.slice(
      src.indexOf('async function cmdDispatchMirasim'),
      src.indexOf('async function cmdDispatch(args)'),
    );
    assert.match(dispatch, /resolveMirasimRepoTarget\(/);
    assert.match(src, /function resolveMirasimRepoTarget[\s\S]*assertCrossRepoOrFail\(/);
    assert.match(src, /function cmdReviewerAttach[\s\S]*assertCrossRepoOrFail/);
    assert.match(src, /function cmdReviewPendingDrain[\s\S]*assertCrossRepoOrFail/);
    assert.match(src, /if \(repo\) argv\.push\('--repo'/);
    const reviewer = src.slice(
      src.indexOf('async function cmdReviewerCreateMirasim'),
      src.indexOf('async function cmdWorkerDoneMirasim'),
    );
    assert.match(reviewer, /resolveMirasimRepoTarget\(/);
    const done = src.slice(
      src.indexOf('async function cmdWorkerDoneMirasim'),
      src.indexOf('async function cmdStartMirasim'),
    );
    assert.match(done, /resolveMirasimRepoTarget\(/);
  });

  it('CLI：非法 --repo 热路当场拒，不写派工单', async () => {
    const r = await cliInProc([
      'dispatch', '--name', '跨仓', '--issue', '1024', '--model', 'grok-4.6',
      '--reviewer', 'gpt-5.6-luna', '--spec', 'x', '--split', 'no', '--split-reason', '单测',
      '--repo', 'ws-cleaner', '--dry-run',
    ]);
    assert.equal(r.status, 1);
    const p = JSON.parse(r.stdout);
    assert.equal(p.ok, false);
    assert.match(String(p.error), /格式非法/);
  });

  it('CLI：--repo 带空格当场拒', async () => {
    const r = await cliInProc([
      'dispatch', '--name', '跨仓', '--issue', '1024', '--model', 'grok-4.6',
      '--reviewer', 'gpt-5.6-luna', '--spec', 'x', '--split', 'no', '--split-reason', '单测',
      '--repo', 'thoerwink8 /ws-cleaner', '--dry-run',
    ]);
    assert.equal(r.status, 1);
    const p = JSON.parse(r.stdout);
    assert.equal(p.ok, false);
    assert.match(String(p.error), /带空格/);
  });

  it('CLI：--repo 首空格 / 尾空格当场拒，不许 trim 后当合法仓', async () => {
    for (const repo of [' thoerwink8/ws-cleaner', 'thoerwink8/ws-cleaner ']) {
      const r = await cliInProc([
        'dispatch', '--name', '跨仓', '--issue', '1024', '--model', 'grok-4.6',
        '--reviewer', 'gpt-5.6-luna', '--spec', 'x', '--split', 'no', '--split-reason', '单测',
        '--repo', repo, '--dry-run',
      ]);
      assert.equal(r.status, 1, JSON.stringify(repo));
      const p = JSON.parse(r.stdout);
      assert.equal(p.ok, false, JSON.stringify(repo));
      assert.match(String(p.error), /带空格/);
    }
  });
});

describe('#1024 drain 计划带票上的 --repo', () => {
  // master 把 drain 统一成 reviewer-create --executor mirasim（attach 随 orca 退役删掉）。
  // #1024 要保住的是票上的 --repo 仍进 argv；有没有工人树都一样。
  it('待办有 repo → create argv 带 --repo（有工人树也走 create）', async () => {
    const S = await S_LOAD;
    const plan = S.planReviewPendingDrain({
      pr: '12', workerWorktree: 'wt-abc', reviewer: 'gpt-5.6-luna',
      repo: 'thoerwink8/ws-cleaner',
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.verb, 'reviewer-create');
    assert.equal(plan.argv.includes('--executor'), true);
    assert.equal(plan.argv.includes('mirasim'), true);
    assert.equal(plan.argv.includes('--repo'), true);
    assert.equal(plan.argv.includes('thoerwink8/ws-cleaner'), true);
  });

  it('快马待办有 repo → create argv 带 --repo', async () => {
    const S = await S_LOAD;
    const plan = S.planReviewPendingDrain({
      pr: '884', workerWorktree: null, reviewer: 'gpt-5.6-luna', issue: '880',
      repo: 'thoerwink8/ws-cleaner',
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.verb, 'reviewer-create');
    assert.equal(plan.argv.includes('--executor'), true);
    assert.equal(plan.argv.includes('mirasim'), true);
    assert.equal(plan.argv.includes('--repo'), true);
    assert.equal(plan.argv.includes('thoerwink8/ws-cleaner'), true);
  });
});

describe('#1024 返工：GitHub owner/name 与 runtime 本地路径拆开', () => {
  it('splitRepoTarget：不传=本仓；路径走 path；owner/name 不塞 localPath', async () => {
    const S = await S_LOAD;
    const omitted = S.splitRepoTarget(undefined, { root: '/srv/projects/windsurf-dao' });
    assert.equal(omitted.ok, true);
    assert.equal(omitted.omitted, true);
    assert.equal(omitted.kind, 'omitted');
    assert.equal(omitted.ownerName, null);
    assert.equal(omitted.localPath, '/srv/projects/windsurf-dao');

    const p = S.splitRepoTarget('/home/orca/windsurf-dao');
    assert.equal(p.ok, true);
    assert.equal(p.kind, 'path');
    assert.equal(p.ownerName, null);
    assert.equal(p.localPath, '/home/orca/windsurf-dao');

    const n = S.splitRepoTarget('thoerwink8/ws-cleaner');
    assert.equal(n.ok, true);
    assert.equal(n.kind, 'ownerName');
    assert.equal(n.ownerName, 'thoerwink8/ws-cleaner');
    assert.equal(n.localPath, null);

    const bad = S.splitRepoTarget(' thoerwink8/ws-cleaner');
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /带空格/);
  });

  it('resolveLocalCheckout：owner/name → /srv/projects/<name>；不在报没查成，不许原样返回 owner/name', async () => {
    const S = await S_LOAD;
    const miss = S.resolveLocalCheckout({
      ownerName: 'thoerwink8/ws-cleaner',
      projectsRoot: '/tmp/not-a-projects-root-1024',
      exists: () => false,
    });
    assert.equal(miss.ok, false);
    assert.equal(miss.unscanned, true);
    assert.equal(miss.localPath, '/tmp/not-a-projects-root-1024/ws-cleaner');
    assert.match(miss.error, /没查成/);
    assert.match(miss.error, /不许把 owner\/name 当路径/);
    assert.doesNotMatch(miss.error, /^这个仓不存在/);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-repo-1024-checkout-'));
    const hit = S.resolveLocalCheckout({
      ownerName: 'thoerwink8/ws-cleaner',
      projectsRoot: root,
      exists: (p) => p === path.join(root, 'ws-cleaner'),
      isGit: () => true,
    });
    assert.equal(hit.ok, true);
    assert.equal(hit.localPath, path.join(root, 'ws-cleaner'));
    assert.equal(hit.ownerName, 'thoerwink8/ws-cleaner');
    assert.notEqual(hit.localPath, 'thoerwink8/ws-cleaner');

    const notGit = S.resolveLocalCheckout({
      ownerName: 'thoerwink8/ws-cleaner',
      projectsRoot: root,
      exists: () => true,
      isGit: () => false,
    });
    assert.equal(notGit.ok, false);
    assert.equal(notGit.unscanned, true);
    assert.match(notGit.error, /不是 git 仓/);
  });

  it('默认 mirasim 路：ensureWorkspace 吃本地路径，gh 钉目标仓，不再把 owner/name 当路径', () => {
    const src = fs.readFileSync(DAO, 'utf8');
    assert.doesNotMatch(src, /const repo = String\(args\.repo \|\| ''\)\.trim\(\) \|\| ROOT/);

    const resolve = src.slice(
      src.indexOf('function resolveMirasimRepoTarget'),
      src.indexOf('function mirasimRepoOrFail'),
    );
    assert.match(resolve, /splitRepoTarget\(/);
    assert.match(resolve, /assertCrossRepoOrFail\(/);
    assert.match(resolve, /resolveLocalCheckout\(/);

    const dispatch = src.slice(
      src.indexOf('async function cmdDispatchMirasim'),
      src.indexOf('async function cmdDispatch(args)'),
    );
    assert.match(dispatch, /resolveMirasimRepoTarget\(/);
    assert.match(dispatch, /const repo = targetRepo\.localPath/);
    assert.match(dispatch, /ensureWorkspace\(repo, branch\)/);
    assert.match(dispatch, /ghRunnerForTarget\(targetRepo\)/);

    const reviewer = src.slice(
      src.indexOf('async function cmdReviewerCreateMirasim'),
      src.indexOf('async function cmdWorkerDoneMirasim'),
    );
    assert.match(reviewer, /resolveMirasimRepoTarget\(/);
    assert.match(reviewer, /ghRunnerForTarget\(targetRepo, \{ role: 'reviewer' \}\)/);
    assert.match(reviewer, /const repo = targetRepo\.localPath/);

    const done = src.slice(
      src.indexOf('async function cmdWorkerDoneMirasim'),
      src.indexOf('async function cmdStartMirasim'),
    );
    assert.match(done, /resolveMirasimRepoTarget\(/);
    assert.match(done, /ghRunnerForTarget\(targetRepo, \{ role: 'worker' \}\)/);
    assert.match(done, /ghRunnerForTarget\(targetRepo, \{ role: 'reviewer' \}\)/);
    assert.match(done, /const repo = targetRepo\.localPath/);
  });
});

describe('#1024 复审：跨仓按仓+PR 键，同号不串',
  () => {
  it('repoPrKey：本仓纯 PR 号；跨仓 owner__name__pr；非法 repo 当场拒',
    async () => {
    const S = await S_LOAD;
    const home = S.repoPrKey({ pr: '12' });
    assert.equal(home.ok, true);
    assert.equal(home.stem, '12');
    assert.equal(home.scoped, false);
    assert.equal(home.key, '12');

    const a = S.repoPrKey({ repo: 'org/a', pr: '12' });
    const b = S.repoPrKey({ repo: 'org/b', pr: '12' });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.stem, 'org__a__12');
    assert.equal(b.stem, 'org__b__12');
    assert.notEqual(a.stem, b.stem);
    assert.notEqual(a.stem, home.stem);

    const bad = S.repoPrKey({ repo: ' org/a', pr: '12' });
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /带空格/);
  });

  it('两个仓同一 PR 号写待办互不覆盖；list 两张都在',
    async () => {
    const S = await S_LOAD;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-repo-1024-pending-'));
    const a = S.buildReviewPendingTicket({
      pr: '12', workerWorktree: 'wt-a', reviewer: 'gpt-5.6-luna',
      source: S.REVIEW_PENDING_SOURCE_WORKER_DONE_FAIL, repo: 'org/a',
    });
    const b = S.buildReviewPendingTicket({
      pr: '12', workerWorktree: 'wt-b', reviewer: 'gpt-5.6-luna',
      source: S.REVIEW_PENDING_SOURCE_WORKER_DONE_FAIL, repo: 'org/b',
    });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    const wa = S.writeReviewPending({ dir, ticket: a.ticket });
    const wb = S.writeReviewPending({ dir, ticket: b.ticket });
    assert.equal(wa.ok, true, JSON.stringify(wa));
    assert.equal(wb.ok, true, JSON.stringify(wb));
    assert.equal(fs.existsSync(path.join(dir, '12.json')), false, '跨仓票不许落到纯 PR 号文件');
    assert.equal(fs.existsSync(path.join(dir, 'org__a__12.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'org__b__12.json')), true);
    const listed = S.listReviewPending(dir);
    assert.equal(listed.ok, true);
    assert.equal(listed.scanned, 2);
    const repos = listed.tickets.map((t) => t.repo).sort();
    assert.deepEqual(repos, ['org/a', 'org/b']);
    const storedA = JSON.parse(fs.readFileSync(path.join(dir, 'org__a__12.json'), 'utf8'));
    assert.equal(storedA.repo, 'org/a');
    assert.equal(storedA.workerWorktree, 'wt-a');
  });

  it('本仓待办仍写 12.json（不传 --repo 一字不变）',
    async () => {
    const S = await S_LOAD;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-repo-1024-home-'));
    const built = S.buildReviewPendingTicket({
      pr: '12', workerWorktree: 'wt', reviewer: 'gpt-5.6-luna',
      source: S.REVIEW_PENDING_SOURCE_WORKER_DONE_FAIL,
    });
    const wrote = S.writeReviewPending({ dir, ticket: built.ticket });
    assert.equal(wrote.ok, true);
    assert.equal(fs.existsSync(path.join(dir, '12.json')), true);
  });

  it('消费 org/a#12 只删那张票，org/b#12 还在',
    async () => {
    const S = await S_LOAD;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-repo-1024-consume-'));
    const a = S.buildReviewPendingTicket({
      pr: '12', workerWorktree: 'wt-a', reviewer: 'gpt-5.6-luna',
      source: S.REVIEW_PENDING_SOURCE_WORKER_DONE_FAIL, repo: 'org/a',
    });
    const b = S.buildReviewPendingTicket({
      pr: '12', workerWorktree: 'wt-b', reviewer: 'gpt-5.6-luna',
      source: S.REVIEW_PENDING_SOURCE_WORKER_DONE_FAIL, repo: 'org/b',
    });
    assert.equal(S.writeReviewPending({ dir, ticket: a.ticket }).ok, true);
    assert.equal(S.writeReviewPending({ dir, ticket: b.ticket }).ok, true);
    const consumed = S.consumeReviewPending({
      dir, ticket: a.ticket, attach: () => ({ ok: true }),
    });
    assert.equal(consumed.ok, true, JSON.stringify(consumed));
    assert.equal(fs.existsSync(path.join(dir, 'org__a__12.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'org__b__12.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '12.json')), false);
  });

  it('非法 --repo 造票当场拒，不许落到 12.json',
    async () => {
    const S = await S_LOAD;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-repo-1024-bad-'));
    const bad = S.buildReviewPendingTicket({
      pr: '12', workerWorktree: 'wt', reviewer: 'gpt-5.6-luna',
      source: S.REVIEW_PENDING_SOURCE_WORKER_DONE_FAIL, repo: ' org/a',
    });
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /带空格/);
    assert.equal(fs.existsSync(path.join(dir, '12.json')), false);
  });
});
