const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LOAD = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'board-gc-collect.mjs').replace(/\\/g, '/'));

describe('board-gc 采样面：没查成 ≠ 零棵树', () => {
  it('scan 没查成 → ok:false，不许当成空盘面', async () => {
    const { cardsFromMirasim } = await LOAD;
    const r = cardsFromMirasim({ scanned: false, error: '树根读不了', worktrees: [] });
    assert.equal(r.ok, false);
    assert.match(r.error, /没查成|读不了/);
  });

  it('scan 成功零棵树 → ok:true 空数组（这是查成了）', async () => {
    const { cardsFromMirasim } = await LOAD;
    const r = cardsFromMirasim({ scanned: true, worktrees: [] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.worktrees, []);
  });

  it('工人树 linkedIssue、审官树 linkedPR，路径当 id', async () => {
    const { cardsFromMirasim } = await LOAD;
    const r = cardsFromMirasim({
      scanned: true,
      worktrees: [
        { worktreeId: '/t/dao-12', path: '/t/dao-12', kind: '工人', linkedIssue: 12, pr: null, displayName: 'ISSUE-#12 工人' },
        { worktreeId: '/t/dao-review-pr-9', path: '/t/dao-review-pr-9', kind: '审官', linkedIssue: null, pr: 9, displayName: 'PR-#9 审官' },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.worktrees[0].id, '/t/dao-12');
    assert.equal(r.worktrees[0].linkedIssue, 12);
    assert.equal(r.worktrees[1].linkedPR.number, 9);
  });

  it('busy 没查成 → 活性 ok:false', async () => {
    const { aliveIdsFromBusy } = await LOAD;
    const r = aliveIdsFromBusy({ ok: false, error: '/proc 读不动' }, []);
    assert.equal(r.ok, false);
  });

  it('busy 的路径对上卡 id', async () => {
    const { aliveIdsFromBusy } = await LOAD;
    const cards = [{ worktreeId: '/t/dao-12', path: '/t/dao-12' }];
    const r = aliveIdsFromBusy({ ok: true, trees: ['/t/dao-12'] }, cards);
    assert.equal(r.ok, true);
    assert.equal(r.alive.has('/t/dao-12'), true);
  });
});
