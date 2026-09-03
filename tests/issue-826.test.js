// #826 三条判别：身份消息失败不整树回滚；无发信人时取协调终端；reviewer-done 不需要 Run id。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs');
const CLI = path.join(REPO, 'scripts', 'dao.mjs');
const DAO_SRC = fs.readFileSync(CLI, 'utf8');
const S_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

describe('#826 身份消息失败不整树回滚', () => {
  it('失败样本 keep=true rollback=false；成功样本不标 identityFailed', async () => {
    const S = await S_LOAD;
    const failed = S.planIdentityKeep({ identityOk: false, identityError: 'no_active_sender_terminal' });
    assert.ok(failed.ok && failed.keep === true && failed.rollback === false && failed.identityFailed === true,
      '失败必须保留树 → ' + JSON.stringify(failed));
    assert.ok(/notify --from/.test(failed.warning) && /不回滚/.test(failed.warning),
      '红项要提示补发 --from → ' + failed.warning);
    const ok = S.planIdentityKeep({ identityOk: true });
    assert.ok(ok.ok && ok.identityFailed === false && ok.rollback === false,
      '成功不得标失败 → ' + JSON.stringify(ok));
  });

  it('古路（failCreated 因身份消息）已退役：create/attach/reuse 身份失败不再 rollback', () => {
    assert.ok(/function deliverReviewerIdentity/.test(DAO_SRC), '身份投递走共享辅助');
    assert.ok(!/failCreated\([^)]*审官身份消息没送到/.test(DAO_SRC),
      'reviewer-create/attach 不得因身份消息 failCreated');
    assert.ok(!/复用审官身份消息没送到士兵/.test(DAO_SRC),
      'reuse 不得因身份消息整跳失败');
    assert.ok(/identityFailed/.test(DAO_SRC) && /planIdentityKeep/.test(DAO_SRC),
      '成功路径要带 identityFailed 红项');
  });
});

describe('#826 发信人 handle：--from + 协调终端兜底', () => {
  it('显式 --from 优先；否则取该树「派工协调（勿关）」；没查成 ≠ 没有', async () => {
    const S = await S_LOAD;
    const flag = S.resolveIdentitySender({ explicitFrom: 'term_explicit' });
    assert.ok(flag.ok && flag.from === 'term_explicit' && flag.source === 'flag', JSON.stringify(flag));

    const created = S.resolveIdentitySender({ fallbackHandle: 'term_just_created' });
    assert.ok(created.ok && created.from === 'term_just_created' && created.source === 'created-coord',
      JSON.stringify(created));

    const terminals = [
      { handle: 'term_shell', worktreeId: 'wt_rev', title: 'Terminal 1' },
      { handle: 'term_coord', worktreeId: 'wt_rev', title: '派工协调（勿关）', status: 'running' },
      { handle: 'term_other', worktreeId: 'wt_other', title: '派工协调（勿关）', status: 'running' },
    ];
    const auto = S.resolveIdentitySender({ terminals, worktreeId: 'wt_rev' });
    assert.ok(auto.ok && auto.from === 'term_coord' && auto.source === 'coordinator',
      '无 --from 必须取本树协调终端 → ' + JSON.stringify(auto));

    const otherTree = S.pickCoordinatorHandle(terminals, { worktreeId: 'wt_other' });
    assert.ok(otherTree.ok && otherTree.handle === 'term_other', '别的树不串号 → ' + JSON.stringify(otherTree));

    const none = S.pickCoordinatorHandle(terminals, { worktreeId: 'wt_missing' });
    assert.ok(none.ok === false && none.unscanned === false && /没有/.test(none.error),
      '扫完没有 ≠ 没查成 → ' + JSON.stringify(none));

    const unscanned = S.pickCoordinatorHandle(null, { worktreeId: 'wt_rev' });
    assert.ok(unscanned.ok === false && unscanned.unscanned === true,
      '没查成必须分开 → ' + JSON.stringify(unscanned));
  });

  it('CLI 登记 --from；reviewer-create 没有 --skip-wait', async () => {
    const S = await S_LOAD;
    assert.ok(S.FLAGS_BY_VERB['reviewer-create'].has('--from'), 'reviewer-create 要 --from');
    assert.ok(S.FLAGS_BY_VERB['worker-done'].has('--from'), 'worker-done 要 --from');
    assert.ok(!S.FLAGS_BY_VERB['reviewer-create'].has('--skip-wait'),
      '--skip-wait 是 reviewer-attach 的，create 没有');
    const unknown = spawnSync(process.execPath, [CLI, 'reviewer-create', '--pr', '1', '--skip-wait'], {
      encoding: 'utf8', cwd: REPO,
    });
    const text = `${unknown.stdout || ''}${unknown.stderr || ''}`;
    assert.ok(unknown.status !== 0 && /未知参数: --skip-wait/.test(text),
      'create --skip-wait 必须非零 → ' + text.slice(0, 240));
  });
});

describe('#826 reviewer-done 不需要 Run id', () => {
  it('MERGED + APPROVED → ok 且 needsRunId=false；OPEN / 无 approve / 没查成分开', async () => {
    const S = await S_LOAD;
    const good = S.planReviewerDone({
      pr: 824,
      prState: { ok: true, state: 'MERGED' },
      reviews: { ok: true, reviews: [{ state: 'APPROVED' }] },
    });
    assert.ok(good.ok && good.needsRunId === false && good.merged && good.approved,
      '已合+已批不需要 Run id → ' + JSON.stringify(good));

    const open = S.planReviewerDone({
      pr: 824,
      prState: { ok: true, state: 'OPEN' },
      reviews: { ok: true, reviews: [{ state: 'APPROVED' }] },
    });
    assert.ok(open.ok === false && /不是 MERGED/.test(open.error), JSON.stringify(open));

    const noApprove = S.planReviewerDone({
      pr: 824,
      prState: { ok: true, state: 'MERGED' },
      reviews: { ok: true, reviews: [{ state: 'COMMENTED' }] },
    });
    assert.ok(noApprove.ok === false && /没有 APPROVED/.test(noApprove.error), JSON.stringify(noApprove));

    const unscanned = S.planReviewerDone({ pr: 824, prState: null, reviews: { ok: true, reviews: [] } });
    assert.ok(unscanned.ok === false && unscanned.unscanned === true, JSON.stringify(unscanned));

    const missPr = S.planReviewerDone({});
    assert.ok(missPr.ok === false && /--pr/.test(missPr.error), JSON.stringify(missPr));
  });

  it('CLI 已登记 reviewer-done；help 出现且缺 --pr 非零', async () => {
    const S = await S_LOAD;
    assert.ok(S.VERBS.includes('reviewer-done'), 'VERBS 含 reviewer-done');
    assert.ok(S.FLAGS_BY_VERB['reviewer-done'].has('--pr'), 'FLAGS 含 --pr');
    const help = spawnSync(process.execPath, [CLI, 'reviewer-done', '--help'], { encoding: 'utf8', cwd: REPO });
    assert.ok(help.status === 0 && /reviewer-done/.test(help.stdout || ''), help.stdout.slice(0, 200));
    const miss = spawnSync(process.execPath, [CLI, 'reviewer-done'], { encoding: 'utf8', cwd: REPO });
    const text = `${miss.stdout || ''}${miss.stderr || ''}`;
    assert.ok(miss.status !== 0 && /--pr/.test(text), '缺 --pr 非零 → ' + text.slice(0, 240));
  });
});

describe('#826 worktree-rm 认已合+已 approve 可归档', () => {
  it('working 占用 + MERGED/APPROVED → 放行；没查成仍拦；未合仍拦', async () => {
    const S = await S_LOAD;
    const forest = [
      { worktreeId: 'master', displayName: 'master', isMainWorktree: true, path: '/tmp/m' },
      {
        worktreeId: 'p1', displayName: 'PR-#824 工人', path: '/tmp/p1',
        childWorktreeIds: ['c1'], linkedPR: { number: 824 },
      },
      {
        worktreeId: 'c1', displayName: 'PR-#824 审官', parentWorktreeId: 'p1', path: '/tmp/c1',
        agents: [{ state: 'working' }],
      },
    ];
    const blocked = S.planWorktreeRm(forest, 'p1');
    assert.ok(blocked.ok === false && /占用/.test(blocked.error), '无归档证据仍拦 → ' + blocked.error);

    const waived = S.planWorktreeRm(forest, 'p1', { archive: { ok: true, merged: true, approved: true } });
    assert.ok(waived.ok === true && waived.waivedOccupancy === true,
      '已合+已批放行 → ' + JSON.stringify(waived));
    assert.ok(waived.order.map((n) => n.id).join(',') === 'c1,p1', '后序仍子先父后 → ' + JSON.stringify(waived.order));

    const unscanned = S.planWorktreeRm(forest, 'p1', { archive: { ok: false, unscanned: true, error: 'gh 没查成' } });
    assert.ok(unscanned.ok === false && /没查成/.test(unscanned.error),
      '没查成不许当可归档 → ' + unscanned.error);

    const open = S.planWorktreeRm(forest, 'p1', { archive: { ok: true, merged: false, approved: true } });
    assert.ok(open.ok === false && /占用/.test(open.error), '未合仍拦 → ' + open.error);
  });
});
