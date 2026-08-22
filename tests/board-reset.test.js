// board-archive / board-reset 纯函数层：清理名单、存档摘要、清盘判定。
// 硬规矩：主树永不删；没查成 ≠ 扫完是空的；有跳过就不算清干净。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'board-reset.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function wt(partial) {
  return {
    worktreeId: partial.id,
    displayName: partial.name,
    path: partial.path || `/tmp/${partial.id}`,
    parentWorktreeId: partial.parent || null,
    childWorktreeIds: partial.children || [],
    agents: partial.agents || [],
    isMainWorktree: !!partial.main,
    isArchived: !!partial.archived,
    linkedIssue: partial.issue ?? null,
    linkedPR: partial.pr ?? null,
    branch: partial.branch || `refs/heads/${partial.id}`,
  };
}

function snap(overrides = {}) {
  return {
    ts: '2026-08-22T13:00:00.000Z',
    ok: true,
    sections: {
      worktrees: { ok: true, data: [] },
      terminals: { ok: true, data: [] },
      workers: { ok: true, data: [] },
      runs: { ok: true, data: [] },
      inbox: { ok: true, data: [] },
      ...overrides,
    },
  };
}

describe('board-reset', () => {
  it('清理名单：主树进 guarded，子卡与已归档跳过，顶层卡进 targets', async (t) => {
    const S = await LIB_LOAD;
    const board = [
      wt({ id: 'master', name: 'master', main: true }),
      wt({ id: 'p1', name: '#1 - 工人', children: ['c1'] }),
      wt({ id: 'c1', name: '#1 - 审官', parent: 'p1' }),
      wt({ id: 'old', name: '旧卡', archived: true }),
      wt({ id: 'p2', name: 'ISSUE-2 - 工人' }),
    ];
    const r = S.planBoardTargets(board);
    await t.test('计划成功', () => {
      assert.ok(r.ok === true, '计划成功  →  ' + JSON.stringify(r));
    });
    await t.test('targets 只有两张顶层卡', () => {
      assert.ok(r.targets.map(x => x.id).sort().join(',') === 'p1,p2', 'targets 只有两张顶层卡  →  ' + JSON.stringify(r.targets));
    });
    await t.test('主树在 guarded 且注明永不删', () => {
      assert.ok(r.guarded.length === 1 && r.guarded[0].id === 'master' && /永不删/.test(r.guarded[0].why), '主树在 guarded  →  ' + JSON.stringify(r.guarded));
    });
    await t.test('子卡与已归档不在任何名单', () => {
      const all = [...r.targets, ...r.guarded].map(x => x.id);
      assert.ok(!all.includes('c1') && !all.includes('old'), '子卡与已归档不在任何名单  →  ' + all.join(','));
    });
  });

  it('清理名单：盘面不是数组 / 卡缺 id → 没查成，一张都不删', async (t) => {
    const S = await LIB_LOAD;
    await t.test('非数组拒', () => {
      const r = S.planBoardTargets('boom');
      assert.ok(r.ok === false && /没查成/.test(r.error), '非数组拒  →  ' + r.error);
    });
    await t.test('缺 id 拒', () => {
      const r = S.planBoardTargets([{ displayName: '无 id 卡', path: '/tmp/x' }]);
      assert.ok(r.ok === false && /没有 id/.test(r.error) && r.targets.length === 0, '缺 id 拒  →  ' + r.error);
    });
  });

  it('存档摘要：计数、卡片明细、没查成的节显形', async (t) => {
    const S = await LIB_LOAD;
    const s = snap({
      worktrees: { ok: true, data: [
        wt({ id: 'master', name: 'master', main: true }),
        wt({ id: 'p1', name: '#7 - 工人', issue: 7, agents: [{ state: 'working' }] }),
      ] },
      terminals: { ok: true, data: [{ handle: 'term_1' }] },
      inbox: { ok: false, error: 'inbox boom' },
    });
    const md = S.formatBoardArchiveMd(s);
    await t.test('有计数行', () => {
      assert.ok(/卡片：2/.test(md) && /终端：1/.test(md), '有计数行  →  ' + md);
    });
    await t.test('卡片明细含关联与 agent 状态', () => {
      assert.ok(/#7 - 工人/.test(md) && /issue #7/.test(md) && /agent=working/.test(md), '卡片明细  →  ' + md);
    });
    await t.test('没查成的节不许装成空', () => {
      assert.ok(/信箱消息：没查成（inbox boom）/.test(md) && /没查成的节/.test(md), '没查成显形  →  ' + md);
    });
  });

  it('清盘判定：全清才 ok；有跳过或 gc 失败都不算清干净', async (t) => {
    const S = await LIB_LOAD;
    await t.test('全清 → ok', () => {
      const v = S.boardResetVerdict({ removed: [{ id: 'p1' }], skipped: [], gc: { ok: true } });
      assert.ok(v.ok === true && /清干净/.test(v.line), '全清  →  ' + v.line);
    });
    await t.test('有跳过 → 不 ok 且报跳过数', () => {
      const v = S.boardResetVerdict({ removed: [{ id: 'p1' }], skipped: [{ id: 'p2', reason: '占用中' }], gc: { ok: true } });
      assert.ok(v.ok === false && /跳过 1 张/.test(v.line) && /没清干净/.test(v.line), '有跳过  →  ' + v.line);
    });
    await t.test('gc 失败 → 不 ok', () => {
      const v = S.boardResetVerdict({ removed: [{ id: 'p1' }], skipped: [], gc: { ok: false, error: '退役 boom' } });
      assert.ok(v.ok === false && /run-gc/.test(v.line), 'gc 失败  →  ' + v.line);
    });
    await t.test('零目标全清也是 ok（扫完 0 张 ≠ 没查成）', () => {
      const v = S.boardResetVerdict({ removed: [], skipped: [], gc: { ok: true } });
      assert.ok(v.ok === true && /已清 0 张/.test(v.line), '零目标  →  ' + v.line);
    });
  });
});
