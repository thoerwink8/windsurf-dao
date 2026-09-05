// 快马 PR 起审官（#880 #891）：没有士兵树/dispatch 的 PR 也要能自动起审官。
//
// 四条判据一条都不许松：
// ① 有士兵树 → 走原路，不建替身树；
// ② 确证无士兵树 → 走快马路，替身树 base 必须是 PR 分支；
// ③ worker-list / worktree list 没查成 → 拒走快马路，报「没查成」（不许把断链当快马）；
// ④ 快马路仍受一 PR 一审官闸与同厂闸约束。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs');
const S_LOAD = import('file://' + LIB.replace(/\\/g, '/'));
const DAO_SRC = fs.readFileSync(path.join(REPO, 'scripts', 'dao.mjs'), 'utf8');

const PR = 905;
const BRANCH = 'fix/fastpath-thing';
const MAIN = { id: 'wt_main', isMainWorktree: true, branch: 'master' };
const SOLDIER = {
  id: 'wt_soldier',
  parentWorktreeId: null,
  displayName: `PR-#${PR} 工人·grok-4.6`,
  branch: BRANCH,
};
const SOLDIER_DISPATCH = {
  dispatchId: 'ctx_soldier',
  resource: { worktreeId: 'wt_soldier', terminalHandle: 'term_s' },
};

describe('快马 PR 起审官', () => {
  it('① 有士兵树 → 走原路（不建替身树），并把士兵树认成父卡', async () => {
    const S = await S_LOAD;
    const plan = S.planFastPathReviewer({
      pr: PR,
      headRefName: BRANCH,
      worktrees: [MAIN, SOLDIER],
      workers: [SOLDIER_DISPATCH],
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.fastPath, false, '有士兵树时绝不许走快马路');
    assert.equal(plan.mode, 'soldier');
    assert.equal(plan.parentWorktree, 'wt_soldier');
    assert.equal(plan.soldierBooked, true);
    assert.equal(plan.standInId, undefined, '原路不许产出替身树');
  });

  it('① 士兵树没有 dispatch 记账也算士兵树——照旧报「找不到士兵 dispatch」，不许当快马', async () => {
    const S = await S_LOAD;
    const plan = S.planFastPathReviewer({
      pr: PR, headRefName: BRANCH, worktrees: [MAIN, SOLDIER], workers: [],
    });
    assert.equal(plan.fastPath, false);
    assert.equal(plan.mode, 'soldier');
    assert.equal(plan.soldierBooked, false);
    // 原路照旧：planCreateSoldierDispatch 没有 fastPath 授权时必须拒。
    const soldier = S.planCreateSoldierDispatch({
      found: { ok: false, error: '树上没有 dispatch' },
    });
    assert.equal(soldier.ok, false);
    assert.match(soldier.error, /找不到士兵 dispatch/);
  });

  it('② 确证无士兵树 → 走快马路，替身树 base = PR 分支且 --no-parent', async () => {
    const S = await S_LOAD;
    const plan = S.planFastPathReviewer({
      pr: PR, headRefName: BRANCH, worktrees: [MAIN], workers: [],
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.fastPath, true);
    assert.equal(plan.mode, 'fast-path');
    assert.equal(plan.standInId, null);
    assert.match(plan.reason, /扫完/, '走快马路必须说清是「扫完确实没有」而不是「没查」');

    const argv = S.fastPathStandInCreateArgs({
      pr: PR, issue: 880, baseBranch: BRANCH, workerModel: 'grok-4.6',
    });
    const at = (flag) => argv[argv.indexOf(flag) + 1];
    assert.equal(at('--base-branch'), BRANCH, '替身树 base 必须是 PR 分支');
    assert.ok(argv.includes('--no-parent'), '替身树必须是顶层卡，审官卡才有父卡可挂');
    assert.equal(at('--setup'), 'skip');
    assert.equal(at('--issue'), '880', '替身树要挂 issue 号便于回收');
    assert.equal(at('--comment'), S.fastPathStandInComment(PR));

    // 快马路上没有士兵可收件：d= 留空、s=1，红项按任务书直接上帅。
    const soldier = S.planCreateSoldierDispatch({ fastPath: true, found: null });
    assert.equal(soldier.ok, true);
    assert.equal(soldier.soldierDispatchId, '');
    assert.equal(soldier.skipWait, true);
    assert.equal(soldier.skipIdentity, true);
  });

  it('② 已有本机制建的替身树 → 复用它，不建第二棵', async () => {
    const S = await S_LOAD;
    const standIn = {
      id: 'wt_standin',
      parentWorktreeId: null,
      displayName: `PR-#${PR} 辅助·grok-4.6 工人替身（快马 PR）`,
      branch: BRANCH,
      comment: S.fastPathStandInComment(PR),
    };
    assert.equal(S.isFastPathStandIn(standIn, PR), true);
    assert.equal(S.isFastPathStandIn(standIn, 90), false, '标记必须整号匹配，不许 905 命中 90');
    assert.equal(S.isFastPathStandIn(SOLDIER, PR), false);

    const plan = S.planFastPathReviewer({
      pr: PR, headRefName: BRANCH, worktrees: [MAIN, standIn], workers: [],
    });
    assert.equal(plan.fastPath, true);
    assert.equal(plan.standInId, 'wt_standin');
    assert.equal(plan.standInReused, true);
  });

  it('③ worker-list / worktree list 没查成 → 拒走快马路，且说清是「没查成」', async () => {
    const S = await S_LOAD;
    const noWorkers = S.planFastPathReviewer({
      pr: PR, headRefName: BRANCH, worktrees: [MAIN], workers: null,
    });
    assert.equal(noWorkers.ok, false);
    assert.equal(noWorkers.unscanned, true);
    assert.equal(noWorkers.fastPath, false, '没查成绝不许当成快马 PR——那会把真断链掩盖成正常');
    assert.match(noWorkers.error, /worker-list 没查成/);
    assert.match(noWorkers.error, /没查成 ≠ 查过确实没有/);

    const noTrees = S.planFastPathReviewer({
      pr: PR, headRefName: BRANCH, worktrees: null, workers: [],
    });
    assert.equal(noTrees.ok, false);
    assert.equal(noTrees.unscanned, true);
    assert.equal(noTrees.fastPath, false);
    assert.match(noTrees.error, /worktree list 没查成/);

    // 「没查成」与「查过确实没有」话面必须不同。
    const scannedEmpty = S.planFastPathReviewer({
      pr: PR, headRefName: BRANCH, worktrees: [MAIN], workers: [],
    });
    assert.notEqual(noWorkers.error, scannedEmpty.reason);
    assert.equal(scannedEmpty.unscanned, undefined);

    // 没查成时命令必须停手，不许继续往下建替身树。
    assert.match(
      DAO_SRC,
      /if \(!fastPlan\.ok\) fail\(fastPlan\.error/,
      'dao.mjs 必须在 fastPlan 不 ok 时当场 fail',
    );
    const wire = DAO_SRC.slice(DAO_SRC.indexOf('async function cmdReviewerCreate'));
    assert.ok(
      wire.indexOf('if (!fastPlan.ok) fail(') < wire.indexOf('fastPathStandInCreateArgs('),
      '停手判定必须排在建替身树之前',
    );
  });

  it('③ 没查成不是「快马授权」：planCreateSoldierDispatch 只认显式 fastPath', async () => {
    const S = await S_LOAD;
    const unscanned = S.planCreateSoldierDispatch({
      found: { ok: false, unscanned: true, error: 'worker-list 没查成：boom' },
    });
    assert.equal(unscanned.ok, false);
    assert.equal(unscanned.unscanned, true);
    assert.match(unscanned.error, /没查成/);
  });

  it('④ 快马路不松一 PR 一审官闸：替身树下的审官卡照样被闸扫到', async () => {
    const S = await S_LOAD;
    const standIn = {
      id: 'wt_standin',
      parentWorktreeId: null,
      displayName: `PR-#${PR} 辅助·grok-4.6 工人替身（快马 PR）`,
      branch: BRANCH,
      comment: S.fastPathStandInComment(PR),
    };
    const reviewerCard = {
      id: 'wt_rev',
      parentWorktreeId: 'wt_standin',
      createdAt: 10,
      displayName: `PR-#${PR} 审官·gpt-5.6-sol`,
      branch: BRANCH,
    };
    const workers = [{
      dispatchId: 'ctx_r',
      resource: { worktreeId: 'wt_rev', terminalHandle: 'term_r' },
      agentTerminalHandle: 'term_r',
    }];
    const terminals = [{ handle: 'term_r', status: 'running' }];

    const gate = S.gateReviewerCreate({
      pr: PR, worktrees: [MAIN, standIn, reviewerCard], workers, terminals,
    });
    assert.equal(gate.outcome, 'reused', '快马路建的审官卡必须被一 PR 一审官闸看见');
    assert.equal(gate.worktreeId, 'wt_rev');

    // 而审官卡自己不许被当成「士兵树」把快马判定顶掉。
    const plan = S.planFastPathReviewer({
      pr: PR, headRefName: BRANCH, worktrees: [MAIN, standIn, reviewerCard], workers,
    });
    assert.equal(plan.fastPath, true);
    assert.equal(plan.standInId, 'wt_standin');
  });

  it('④ 快马路不松同厂闸与审官位闸：两道闸排在快马判定之前', async () => {
    const wire = DAO_SRC.slice(DAO_SRC.indexOf('async function cmdReviewerCreate'));
    const vendor = wire.indexOf('refuseIfSameVendor(');
    const seat = wire.indexOf('assertReviewerSeat(');
    const fast = wire.indexOf('planFastPathReviewer(');
    assert.ok(vendor > 0 && seat > 0 && fast > 0, '三处接线都要在 cmdReviewerCreate 里');
    assert.ok(vendor < fast, '同厂闸必须排在快马判定之前');
    assert.ok(seat < fast, '审官位闸必须排在快马判定之前');
    // 快马路照旧不许换厂：失败停手报帅这条在 preflight 全红时仍是 fail。
    assert.match(wire, /派前探一针：审官候选全红\/全拦，停手报帅/);
  });

  it('④ 帅显式给了选择器时不判快马（不抢帅的决定）', async () => {
    const S = await S_LOAD;
    const byParent = S.planFastPathReviewer({
      pr: PR, headRefName: BRANCH, explicitParent: 'wt_soldier', worktrees: null, workers: null,
    });
    assert.equal(byParent.ok, true);
    assert.equal(byParent.fastPath, false);
    assert.equal(byParent.mode, 'explicit');

    const byDispatch = S.planFastPathReviewer({
      pr: PR, headRefName: BRANCH, explicitDispatch: 'ctx_soldier', worktrees: null, workers: null,
    });
    assert.equal(byDispatch.fastPath, false);
    // 显式给了 dispatch 时，fastPath 授权也不许覆盖显式那条腿。
    const soldier = S.planCreateSoldierDispatch({
      explicitDispatch: 'ctx_soldier', fastPath: true, dispatchLive: true,
    });
    assert.equal(soldier.soldierDispatchId, 'ctx_soldier');
    assert.notEqual(soldier.reason, 'fast-path');
  });
});
