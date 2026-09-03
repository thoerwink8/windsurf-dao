// #589：卡名归人眼、判据归字段。判别实验 = 卡改名叫 zzz，四处判定不变。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'card-identity.mjs');
const C_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

describe('card-identity', () => {
  it('#589 卡名分类：新格式 / 旧格式 / 其他', async () => {
    const C = await C_LOAD;
    assert.strictEqual(C.classifyCardName('PR-#616 工人·grok-4.6 备零件'), 'new');
    assert.strictEqual(C.classifyCardName('PR-#616 审官·gpt-5.6-sol'), 'new');
    assert.strictEqual(C.classifyCardName('ISSUE-#589 工人·grok-4.6 strikes闸'), 'new');
    assert.strictEqual(C.classifyCardName('PR-616 工人·grok-4.6 x'), 'new');
    assert.strictEqual(C.classifyCardName('ISSUE-589 工人·x y'), 'new');
    assert.strictEqual(C.classifyCardName('#559 - 修地基'), 'legacy');
    assert.strictEqual(C.classifyCardName('zzz'), 'other');
  });

  it('#589 四处判据不读卡名：改成 zzz 判定不变', async () => {
    const C = await C_LOAD;
    const worker = {
      id: 'wt_worker',
      parentWorktreeId: null,
      agents: [{ state: 'working' }],
      displayName: '#589 - 工人',
      workspaceStatus: 'in-progress',
    };
    const reviewer = {
      id: 'wt_rev',
      parentWorktreeId: 'wt_worker',
      createdAt: 10,
      displayName: '#589 - 审官·gpt',
      agents: [{ state: 'working' }],
    };
    const leftover = {
      id: 'wt_left',
      parentWorktreeId: null,
      displayName: 'windsurf-dao',
      agents: [],
      isMainWorktree: false,
    };

    const workerZ = { ...worker, displayName: 'zzz' };
    const reviewerZ = { ...reviewer, displayName: 'zzz' };
    assert.strictEqual(C.isTaskCard(worker), true);
    assert.strictEqual(C.isTaskCard(workerZ), true);
    assert.strictEqual(C.isChildWorktree(reviewer), true);
    assert.strictEqual(C.isChildWorktree(reviewerZ), true);
    assert.strictEqual(C.isTaskCard(reviewer), false);
    assert.strictEqual(C.isTaskCard(reviewerZ), false);
    assert.strictEqual(C.isTaskCard(leftover), false);
    assert.strictEqual(C.isTaskCard({ ...leftover, displayName: 'zzz' }), false);

    const found = C.findReviewerWorktree({
      parent: { ...worker, childWorktreeIds: ['wt_rev'] },
      worktrees: [worker, reviewer],
    });
    const foundZ = C.findReviewerWorktree({
      parent: { ...workerZ, childWorktreeIds: ['wt_rev'] },
      worktrees: [workerZ, reviewerZ],
    });
    assert.ok(found.ok && foundZ.ok && found.worktreeId === 'wt_rev' && foundZ.worktreeId === 'wt_rev');

    const anon = C.findReviewerWorktree({
      parent: worker,
      worktrees: [worker, { id: 'wt_aux', parentWorktreeId: 'wt_worker', displayName: '随便叫啥' }],
      workers: [{ resource: { worktreeId: 'wt_aux' } }],
    });
    assert.strictEqual(anon.worktreeId, 'wt_aux');
    assert.strictEqual(C.isChildWorktree(worker), false);
    assert.strictEqual(C.isChildWorktree(reviewer), true);
  });

  it('#589 issue 号不从 PR- 前缀瞎取', async () => {
    const C = await C_LOAD;
    assert.strictEqual(C.issueNumberFromWorktree({ displayName: 'ISSUE-#589 工人·grok-4.6 x' }), 589);
    assert.strictEqual(C.issueNumberFromWorktree({ displayName: 'ISSUE-589 工人·x y' }), 589);
    assert.strictEqual(C.issueNumberFromWorktree({ displayName: 'PR-616 工人·grok-4.6 x', linkedIssue: 589 }), 589);
    assert.strictEqual(C.issueNumberFromWorktree({ displayName: 'PR-616 工人·grok-4.6 x' }), null);
    assert.strictEqual(C.issueNumberFromWorktree({ displayName: '#589 - x' }), 589);
    assert.strictEqual(C.issueNumberFromWorktree({ displayName: 'zzz', comment: '进度｜[#589]' }), 589);
    assert.strictEqual(C.displayNumberFromWorktree({ displayName: 'PR-616 工人·grok-4.6 x' }), 616);
    assert.strictEqual(C.displayNumberFromWorktree({ displayName: 'PR-#616 工人·grok-4.6 x' }), 616);
    assert.strictEqual(C.displayNumberFromWorktree({ displayName: 'ISSUE-589 工人·x y' }), 589);
  });

  it('#652 PR 号判据：linkedPR 优先，其次卡名/路径 PR-#N / PR-N，issue 号不算', async () => {
    const C = await C_LOAD;
    assert.strictEqual(C.prNumberFromWorktree({ linkedPR: { number: 652 } }), 652);
    assert.strictEqual(C.prNumberFromWorktree({ linkedPR: { number: '652' } }), 652);
    assert.strictEqual(C.prNumberFromWorktree({ linkedPR: { number: 0 } }), null);
    assert.strictEqual(C.prNumberFromWorktree({ linkedPR: { number: -3 } }), null);
    assert.strictEqual(C.prNumberFromWorktree({ displayName: 'PR-#777 审官·grok-4.6' }), 777);
    assert.strictEqual(C.prNumberFromWorktree({ displayName: 'PR-777 审官·grok-4.6' }), 777);
    assert.strictEqual(C.prNumberFromWorktree({ displayName: 'ISSUE-589 工人·x y', path: 'C:/p/PR-#616-w1' }), 616);
    assert.strictEqual(C.prNumberFromWorktree({ path: 'C:/p/PR-616-w1' }), 616);
    assert.strictEqual(C.prNumberFromWorktree({ displayName: '#589 - 调研单' }), null);
    assert.strictEqual(C.prNumberFromWorktree({ displayName: 'ISSUE-589 工人·x y', linkedIssue: 589 }), null);
    assert.strictEqual(C.prNumberFromWorktree({}), null);
    // linkedPR 优先于卡名里的 PR 号
    assert.strictEqual(C.prNumberFromWorktree({ linkedPR: { number: 100 }, displayName: 'PR-#200 工人' }), 100);
  });

  it('#589 源码钉：卡名分类仍走 card-identity，不读卡名当判据', async () => {
    const C = await C_LOAD;
    assert.strictEqual(C.classifyCardName('zzz'), 'other');
    assert.strictEqual(C.isTaskCard({ displayName: 'zzz', parentWorktreeId: null, agents: [{ state: 'working' }] }), true);
  });
});
