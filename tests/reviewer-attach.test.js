// #631 reviewer-attach 树→dispatch 映射串号：判别性验收。
// 场景：issue 派工（#625）产出的 PR 号（#626）与派工时的 issue 号不同——
// 树↔dispatch 是 issue 派工时绑的，审官要等的「完工」只可能来自 worker-done 自己建的审官；
// reviewer-attach 是 worker-done 失败后的手动补派，硬等 = 烧 600s 再误诊「实属别的单」。
// 钉死三层：① 树→PR 归属校验（传错树当场拒，issue≠PR 号不误报）
//         ② 士兵 dispatch 注入前 worker-show 复核活性（已结算禁止当收件人 #552）
//         ③ --skip-wait 显式跳过等完工（d 有就给红项去处，没有就红项上帅）
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs');
const S_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

/** #625 事故树的形态：id 带 `repoId::路径/625-625-审官合并去掉auto`，linkedIssue=625，分支=PR head。 */
function workerTree(over = {}) {
  return {
    id: 'repo::C:/wt/625-625-审官合并去掉auto',
    path: 'C:/wt/625-625-审官合并去掉auto',
    branch: 'refs/heads/thoerwink8/625-625-审官合并去掉auto',
    linkedIssue: 625,
    linkedPR: null,
    displayName: 'ISSUE-#625 工人·grok-4.6 审官合并去掉auto',
    ...over,
  };
}

describe('verifyReviewerAttachTree（#631 树→PR 归属校验）', () => {
  it('判别性主场景：issue #625 派工 → PR #626，树 issue=625 ∈ PR 署名 → 不误报串号', async () => {
    const S = await S_LOAD;
    const r = S.verifyReviewerAttachTree({
      prIssueNumbers: [625],
      headRefName: 'thoerwink8/625-625-审官合并去掉auto',
      worktrees: [workerTree()],
      worktreeSel: '625-625-审官合并去掉auto',
    });
    assert.ok(r.ok, 'issue 号 ≠ PR 号是常态，不许误报 → ' + JSON.stringify(r));
    assert.ok(r.verified, '树 issue 与分支都对上，应 verified → ' + JSON.stringify(r));
    assert.ok(r.via.length >= 2, 'issue + 分支两条判据都应走通 → ' + JSON.stringify(r.via));
  });

  it('传错树：树关联 issue 不在 PR 署名里 → 拒（对不上报错，不硬塞）', async () => {
    const S = await S_LOAD;
    const r = S.verifyReviewerAttachTree({
      prIssueNumbers: [626],
      headRefName: 'thoerwink8/625-625-审官合并去掉auto',
      worktrees: [workerTree()],
      worktreeSel: '625-625-审官合并去掉auto',
    });
    assert.ok(r.ok === false, '树 issue #625 ∉ PR 署名 #626 → 拒 → ' + JSON.stringify(r));
    assert.ok(/树关联 issue #625/.test(r.error) && /PR 署名/.test(r.error), '报错要点名两边 → ' + r.error);
  });

  it('传错树：树分支 ≠ PR head 分支 → 拒', async () => {
    const S = await S_LOAD;
    const r = S.verifyReviewerAttachTree({
      prIssueNumbers: [625],
      headRefName: 'thoerwink8/620-620-dispatch-batch-原语',
      worktrees: [workerTree()],
      worktreeSel: '625-625-审官合并去掉auto',
    });
    assert.ok(r.ok === false, '树分支 ≠ PR head → 拒 → ' + JSON.stringify(r));
    assert.ok(/分支/.test(r.error) && /refs\/heads/.test(r.error), '报错要点名分支 → ' + r.error);
  });

  it('多 issue 合单：树 issue ∈ 署名列表 → 过', async () => {
    const S = await S_LOAD;
    const r = S.verifyReviewerAttachTree({
      prIssueNumbers: [620, 625],
      headRefName: 'thoerwink8/625-625-审官合并去掉auto',
      worktrees: [workerTree()],
      worktreeSel: 'C:/wt/625-625-审官合并去掉auto',
    });
    assert.ok(r.ok && r.verified, '多署名里含树 issue → 过 → ' + JSON.stringify(r));
  });

  it('树不在盘面（已归档）→ verified:false 不硬拦，交给 dispatch 查找与活性闸', async () => {
    const S = await S_LOAD;
    const r = S.verifyReviewerAttachTree({
      prIssueNumbers: [625],
      headRefName: 'thoerwink8/625-625-审官合并去掉auto',
      worktrees: [],
      worktreeSel: '625-625-审官合并去掉auto',
    });
    assert.ok(r.ok === true && r.verified === false, '无样本不硬拦 → ' + JSON.stringify(r));
  });

  it('worktree list 没查成（不是数组）→ unscanned，不许当查过', async () => {
    const S = await S_LOAD;
    const r = S.verifyReviewerAttachTree({
      prIssueNumbers: [625],
      headRefName: 'thoerwink8/625-625-审官合并去掉auto',
      worktrees: null,
      worktreeSel: 'x',
    });
    assert.ok(r.ok === false && r.unscanned === true, '没查成必须分开 → ' + JSON.stringify(r));
  });

  it('PR 无署名单号（pr-fast 快单）→ issue 判据无样本，分支判据仍走', async () => {
    const S = await S_LOAD;
    const r = S.verifyReviewerAttachTree({
      prIssueNumbers: [],
      headRefName: 'thoerwink8/625-625-审官合并去掉auto',
      worktrees: [workerTree()],
      worktreeSel: '625-625-审官合并去掉auto',
    });
    assert.ok(r.ok && r.verified, '无署名只走分支判据 → ' + JSON.stringify(r));
  });
});

describe('planAttachSoldierDispatch（#631 活性闸 + skip-wait 决策矩阵）', () => {
  const foundLive = { ok: true, dispatchId: 'ctx_worker', runId: 'run_1', scanned: 1 };
  const foundMiss = { ok: false, error: 'worker-list 里找不到', scanned: 2 };

  it('正常补审官：树映射到活 dispatch，没 --skip-wait → 等完工模式', async () => {
    const S = await S_LOAD;
    const r = S.planAttachSoldierDispatch({ found: foundLive, dispatchLive: true, skipWait: false });
    assert.ok(r.ok && r.skipWait === false && r.soldierDispatchId === 'ctx_worker', '活 dispatch 走等待 → ' + JSON.stringify(r));
  });

  it('#625 事故场景：树映射的 dispatch 已结算（worker-show 复核死）→ 拒，指引 --skip-wait', async () => {
    const S = await S_LOAD;
    const r = S.planAttachSoldierDispatch({ found: foundLive, dispatchLive: false, skipWait: false });
    assert.ok(r.ok === false, '已结算禁止当收件人（#552）→ ' + JSON.stringify(r));
    assert.ok(/已结算/.test(r.error) && /--skip-wait/.test(r.error), '报错给可执行指引 → ' + r.error);
  });

  it('worker-list 查到 dispatch 但 worker-show 没查成 → 不许当活人', async () => {
    const S = await S_LOAD;
    const r = S.planAttachSoldierDispatch({ found: foundLive, dispatchLive: null, skipWait: false });
    assert.ok(r.ok === false && r.unscanned === true, '没查成 ≠ 活 → ' + JSON.stringify(r));
  });

  it('找不到士兵 dispatch 且没 --skip-wait → 拒，指引两条出路', async () => {
    const S = await S_LOAD;
    const r = S.planAttachSoldierDispatch({ found: foundMiss, dispatchLive: null, skipWait: false });
    assert.ok(r.ok === false, '找不到 → 拒 → ' + JSON.stringify(r));
    assert.ok(/--skip-wait/.test(r.error) && /--soldier-dispatch/.test(r.error), '指引两条出路 → ' + r.error);
  });

  it('显式 --soldier-dispatch 活 → 等完工模式用显式 id', async () => {
    const S = await S_LOAD;
    const r = S.planAttachSoldierDispatch({ explicitDispatch: 'ctx_explicit', found: foundLive, dispatchLive: true, skipWait: false });
    assert.ok(r.ok && r.soldierDispatchId === 'ctx_explicit' && r.skipWait === false, '显式 id 优先 → ' + JSON.stringify(r));
  });

  it('显式 --soldier-dispatch 已结算且没 --skip-wait → 拒', async () => {
    const S = await S_LOAD;
    const r = S.planAttachSoldierDispatch({ explicitDispatch: 'ctx_dead', found: null, dispatchLive: false, skipWait: false });
    assert.ok(r.ok === false && /已结算/.test(r.error), '显式死 id 也拒 → ' + JSON.stringify(r));
  });

  it('--skip-wait + 树映射活 dispatch → 跳过等待，d 保留（红项有去处）', async () => {
    const S = await S_LOAD;
    const r = S.planAttachSoldierDispatch({ found: foundLive, dispatchLive: true, skipWait: true });
    assert.ok(r.ok && r.skipWait === true && r.soldierDispatchId === 'ctx_worker', 'skip-wait 保留活 id → ' + JSON.stringify(r));
  });

  it('--skip-wait + 树映射已结算 → d 置空（红项上帅），带 deadWarning', async () => {
    const S = await S_LOAD;
    const r = S.planAttachSoldierDispatch({ found: foundLive, dispatchLive: false, skipWait: true });
    assert.ok(r.ok && r.skipWait === true && r.soldierDispatchId === null, '已结算树映射 id 不注入 → ' + JSON.stringify(r));
    assert.ok(/已结算/.test(r.deadWarning || ''), '附警告 → ' + JSON.stringify(r));
  });

  it('--skip-wait + 找不到 dispatch → ok，d 空，红项上帅', async () => {
    const S = await S_LOAD;
    const r = S.planAttachSoldierDispatch({ found: foundMiss, dispatchLive: null, skipWait: true });
    assert.ok(r.ok && r.skipWait === true && r.soldierDispatchId === null && r.reason === 'none', '无 d 的 skip-wait → ' + JSON.stringify(r));
  });

  it('#631 返工：--skip-wait + 显式 id 已结算 → d 置空 + deadWarning（显式 id 不得绕过活性复核，红项上帅）', async () => {
    const S = await S_LOAD;
    const r = S.planAttachSoldierDispatch({ explicitDispatch: 'ctx_dead', found: null, dispatchLive: false, skipWait: true });
    assert.ok(r.ok && r.skipWait === true && r.soldierDispatchId === null, '显式死 id 不注入 d= → ' + JSON.stringify(r));
    assert.ok(/已结算/.test(r.deadWarning || ''), '附警告 → ' + JSON.stringify(r));
  });

  it('#631 返工：--skip-wait + 显式 id 的 worker-show 没查成 → fail-close unscanned（不许当活人）', async () => {
    const S = await S_LOAD;
    const r = S.planAttachSoldierDispatch({ explicitDispatch: 'ctx_unverified', found: null, dispatchLive: null, skipWait: true });
    assert.ok(r.ok === false && r.unscanned === true, '没查成 → fail-close → ' + JSON.stringify(r));
    assert.ok(/worker-show 没查成/.test(r.error), '点名没查成 → ' + r.error);
  });

  it('#631 返工：--skip-wait + 树映射 id 的 worker-show 没查成 → fail-close unscanned', async () => {
    const S = await S_LOAD;
    const r = S.planAttachSoldierDispatch({ found: foundLive, dispatchLive: null, skipWait: true });
    assert.ok(r.ok === false && r.unscanned === true, '没查成 → fail-close → ' + JSON.stringify(r));
  });
});

describe('buildReviewerInject skip-wait 标记（#631 注入契约）', () => {
  it('skip-wait → 注入带 s=1', async () => {
    const S = await S_LOAD;
    const text = S.buildReviewerInject({
      spec: '按审官任务书审 PR #626', pr: '626',
      soldierDispatchId: 'ctx_worker', mergePolicy: 'auto', skipWait: true,
    });
    assert.ok(/ s=1/.test(text), 'skip-wait 标记进注入 → ' + text);
    assert.ok(/d=ctx_worker/.test(text), 'd 保留 → ' + text);
  });

  it('非 skip-wait → 注入不带 s 标记（worker-done 路径不变）', async () => {
    const S = await S_LOAD;
    const text = S.buildReviewerInject({
      spec: '按审官任务书审 PR #626', pr: '626',
      soldierDispatchId: 'ctx_worker', mergePolicy: 'auto', skipWait: false,
    });
    assert.ok(!/ s=1/.test(text), '默认不带 s=1 → ' + text);
    assert.ok(/p=626 d=ctx_worker m=auto$/.test(text), '默认形态不变 → ' + text);
  });

  it('skip-wait 无收件人：显式传 "" → 渲染成 d= 不炸（红项上帅）', async () => {
    const S = await S_LOAD;
    const text = S.buildReviewerInject({
      spec: '按审官任务书审 PR #626', pr: '626',
      soldierDispatchId: '', mergePolicy: 'auto', skipWait: true,
    });
    assert.ok(/d= /.test(text) || /d=$/.test(text.replace(/ s=1$/, '')), '空 d 渲染成 d= → ' + text);
    assert.ok(/ s=1/.test(text), 's=1 仍在 → ' + text);
  });

  it('skip-wait 无收件人但传 null → 仍抛（dispatch:undefined 硬闸不因 skip-wait 松动）', async () => {
    const S = await S_LOAD;
    let threw = false, msg = '';
    try {
      S.buildReviewerInject({ spec: 'x', pr: '1', soldierDispatchId: null, mergePolicy: 'auto', skipWait: true });
    } catch (e) { threw = true; msg = String(e.message || e); }
    assert.ok(threw && /SOLDIER_DISPATCH_ID/.test(msg), 'null 必须抛 → ' + msg);
  });
});

describe('findWorktreeBySel / worktreeSelMatches（#631 选择符匹配）', () => {
  it('全等 / id::后缀 / 末段后缀 / path 后缀都认', async () => {
    const S = await S_LOAD;
    const tree = workerTree();
    const full = 'repo::C:/wt/625-625-审官合并去掉auto';
    assert.ok(S.worktreeSelMatches(full, full), '全等');
    assert.ok(S.worktreeSelMatches(full, '625-625-审官合并去掉auto'), '末段后缀');
    assert.strictEqual(S.findWorktreeBySel([tree], full).id, tree.id, '全等找到');
    assert.strictEqual(S.findWorktreeBySel([tree], '625-625-审官合并去掉auto').id, tree.id, '末段找到');
    assert.strictEqual(S.findWorktreeBySel([tree], 'C:/wt/625-625-审官合并去掉auto').id, tree.id, 'path 找到');
    assert.strictEqual(S.findWorktreeBySel([tree], 'no-such'), null, '找不到 → null');
    assert.strictEqual(S.findWorktreeBySel(null, 'x'), null, '列表没查成 → null');
  });
});
