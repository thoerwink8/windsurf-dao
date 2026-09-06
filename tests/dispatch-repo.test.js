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
    assert.equal(S.parseOwnerNameRepo('  ').omitted, true);
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
    const hot = src.slice(src.indexOf('function cmdDispatch('), src.indexOf('function cmdDispatchExec('));
    assert.match(hot, /assertCrossRepoOrFail\(/);
    assert.match(hot, /repo: targetRepo\.ownerName/);
    const exec = src.slice(src.indexOf('function runDispatchExecution('), src.indexOf('function cmdDispatchBatch('));
    assert.match(exec, /assertCrossRepoOrFail\(/);
    assert.match(exec, /resolveTargetRepoSelector\(/);
    assert.match(src, /function cmdWorkerDone[\s\S]*assertCrossRepoOrFail/);
    assert.match(src, /function cmdReviewerCreate[\s\S]*assertCrossRepoOrFail/);
    assert.match(src, /function cmdReviewerAttach[\s\S]*assertCrossRepoOrFail/);
    assert.match(src, /function cmdReviewPendingDrain[\s\S]*assertCrossRepoOrFail/);
    assert.match(src, /if \(repo\) argv\.push\('--repo'/);
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
});

describe('#1024 drain 计划带票上的 --repo', () => {
  it('待办有 repo → attach argv 带 --repo', async () => {
    const S = await S_LOAD;
    const plan = S.planReviewPendingDrain({
      pr: '12', workerWorktree: 'wt-abc', reviewer: 'gpt-5.6-luna',
      repo: 'thoerwink8/ws-cleaner',
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.verb, 'reviewer-attach');
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
    assert.equal(plan.argv.includes('--repo'), true);
    assert.equal(plan.argv.includes('thoerwink8/ws-cleaner'), true);
  });
});
