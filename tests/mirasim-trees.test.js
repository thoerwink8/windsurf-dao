// mirasim 在管工作树 = 在途派工的采样面（2026-09-06）
//
// 本套的存在理由是一次真咬：指挥官判「这张 issue 有没有人在做」用的是 orca 的卡面，
// orca 退役后那一段恒 scanned:false，而调用处写着 `orca.worktrees || []` ——
// **「没查成」被洗成「查过没有」**。于是已消歧 + 标签齐 + 还没开 PR 的单，
// 每 20 分钟被重复派一次。#965 当场撞上：我手动派完，同一份态势里指挥官仍说「无在途派工」。
//
// 三条判别用例：① 认得出 mirasim 树 → 不重复派；② 目录读不了 = 没查成，一张都不派；
// ③ 审官树挂的是 PR 号，不许当成 issue 在途。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LIB = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'mirasim-trees.mjs').replace(/\\/g, '/');
const CORE = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'commander-core.mjs').replace(/\\/g, '/');

/** 假文件系统：dirs 是 { 路径: [子目录名] }。没列的路径 = 不存在。 */
function fakeIo(dirs, { throwOn } = {}) {
  return {
    join: (...xs) => xs.join('/'),
    exists: (p) => Object.prototype.hasOwnProperty.call(dirs, p),
    readdir: (p) => {
      if (throwOn && p === throwOn) throw new Error('EACCES');
      return dirs[p] || [];
    },
  };
}

describe('identifyTreeDir：认不出就回 null，不猜', () => {
  it('工人树 / 第二棵 / 审官树各自认得出', async () => {
    const { identifyTreeDir } = await import(LIB);
    assert.deepEqual(identifyTreeDir('dao-965'), { kind: '工人', number: 965, name: 'dao-965' });
    assert.equal(identifyTreeDir('dao-1012-2').kind, '工人');
    assert.equal(identifyTreeDir('dao-1012-2').number, 1012);
    assert.deepEqual(identifyTreeDir('dao-review-pr-1040'), { kind: '审官', number: 1040, name: 'dao-review-pr-1040' });
  });

  it('临时树 / 别的目录 → null（没有单号就没有重派路径，不该算在途）', async () => {
    const { identifyTreeDir } = await import(LIB);
    assert.equal(identifyTreeDir('scratch'), null);
    assert.equal(identifyTreeDir('dao-'), null);
    assert.equal(identifyTreeDir('dao-abc'), null);
    assert.equal(identifyTreeDir(''), null);
    assert.equal(identifyTreeDir(null), null);
  });
});

describe('scanMirasimTrees：扫完是 0 与没查成必须不同形', () => {
  it('扫到树 → scanned:true，工人树挂 linkedIssue、审官树挂 pr', async () => {
    const { scanMirasimTrees } = await import(LIB);
    const io = fakeIo({ '/m': ['windsurf-dao'], '/m/windsurf-dao': ['dao-965', 'dao-review-pr-1040', 'scratch'] });
    const r = scanMirasimTrees({ root: '/m', ...io });
    assert.equal(r.scanned, true);
    assert.equal(r.worktrees.length, 2, '临时目录不算树');
    const worker = r.worktrees.find((w) => w.kind === '工人');
    assert.equal(worker.linkedIssue, 965);
    assert.equal(worker.pr, null);
    const reviewer = r.worktrees.find((w) => w.kind === '审官');
    assert.equal(reviewer.pr, 1040);
    assert.equal(reviewer.linkedIssue, null, '审官树挂 PR 号，当成 issue 在途会漏派真单');
  });

  it('树根不在 → scanned:true 的空盘面（这台机器没在管树，是查成了）', async () => {
    const { scanMirasimTrees } = await import(LIB);
    const r = scanMirasimTrees({ root: '/nope', ...fakeIo({}) });
    assert.equal(r.scanned, true);
    assert.equal(r.worktrees.length, 0);
    assert.equal(r.empty, true);
  });

  it('目录读不了 → scanned:false（不许当成没有树）', async () => {
    const { scanMirasimTrees } = await import(LIB);
    const io = fakeIo({ '/m': ['windsurf-dao'], '/m/windsurf-dao': ['dao-965'] }, { throwOn: '/m/windsurf-dao' });
    const r = scanMirasimTrees({ root: '/m', ...io });
    assert.equal(r.scanned, false);
    assert.match(r.error, /没查成/);
    assert.equal(r.worktrees.length, 0);
  });

  it('没给 io → scanned:false，不是空盘面', async () => {
    const { scanMirasimTrees } = await import(LIB);
    const r = scanMirasimTrees({ root: '/m' });
    assert.equal(r.scanned, false);
    assert.match(r.error, /没查成/);
  });
});

describe('decide：在途判据只认 trees，树面没查成就一张都不派', () => {
  const ISSUE = {
    number: 965, title: 't',
    labels: [{ name: '已消歧' }, { name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-luna' }, { name: 'type/写码' }],
  };
  const sit = (over) => ({
    at: '2026-09-06T13:00:00.000Z',
    github: { scanned: true, issues: [ISSUE], prs: [] },
    orca: { scanned: false, error: 'orca 已退役' },
    trees: { scanned: true, worktrees: [] },
    reviewPending: { scanned: true, items: [] },
    prReviews: { scanned: true, byPr: {} },
    stall: { scanned: true, strikes: {} },
    wakeCounts: {}, reworkDispatched: {},
    commanderPolicy: { maxDispatchPerRound: 20, requireModelInRouting: false },
    routingModels: ['grok-4.6'], healthRedModels: [],
    ...over,
  });

  it('树面空 + 无 PR → 派（这是本来就该有的行为）', async () => {
    const { decide } = await import(CORE);
    const { actions } = decide(sit());
    assert.equal(actions.filter((a) => a.kind === 'dispatch' && a.issue === 965).length, 1);
  });

  it('**判别性**：mirasim 树里已有 dao-965 → 不许再派', async () => {
    const { decide } = await import(CORE);
    const { actions } = decide(sit({
      trees: { scanned: true, worktrees: [{ worktreeId: '/m/dao-965', linkedIssue: 965, displayName: 'ISSUE-#965 工人', isMainWorktree: false, isArchived: false }] },
    }));
    assert.equal(actions.filter((a) => a.kind === 'dispatch').length, 0,
      '树面认不出在途派工 → 每轮重复派一次，两个工人打架还烧额度');
  });

  it('树面没查成 → 一张都不派，且总闸点名 trees（不是静默跳过）', async () => {
    const { decide } = await import(CORE);
    const { actions } = decide(sit({ trees: { scanned: false, error: '目录读不了' } }));
    assert.equal(actions.filter((a) => a.kind === 'dispatch').length, 0);
    const esc = actions.find((a) => a.kind === 'escalate' && a.reason === 'unscanned');
    assert.ok(esc, '没查成必须 fail-visible');
    assert.equal(esc.missing.includes('trees'), true);
  });

  it('orca 段没查成不再拖停整轮（它已退役，恒红的闸等于没有闸）', async () => {
    const { decide } = await import(CORE);
    const { actions } = decide(sit());
    const esc = actions.find((a) => a.kind === 'escalate' && a.reason === 'unscanned');
    assert.equal(esc, undefined, 'orca 不该再出现在关键节里');
  });
});
