// 僵尸卡自动发现（用户 2026-09-05：「自动去发现，自动去清理」）。
// 每条对着一个真实风险：删掉在跑的卡、删掉还没落地的活、把「没查成」当「查过没事」。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const LIB = 'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'board-gc.mjs').replace(/\\/g, '/');
const LOAD = import(LIB);
const LIVE = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'liveness.mjs').replace(/\\/g, '/'));

const card = (o) => ({
  id: o.id, displayName: o.name || o.id, path: '/w/' + o.id, branch: o.branch || null,
  isMainWorktree: !!o.main, isArchived: !!o.arch,
  parentWorktreeId: o.parent || null, childWorktreeIds: o.kids || [],
  lastActivityAt: o.at || 0,
});
const NONE = new Set();

describe('僵尸卡：两条同时成立才删', () => {
  it('PR 已合 + 无活进程 → 僵尸', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'PR-#10 工人·x' })],
      aliveWorktreeIds: NONE, prState: { 10: 'MERGED' }, branchState: {},
    });
    assert.equal(p.zombies.length, 1);
    assert.equal(p.zombies[0].kind, 'pr-done');
  });

  it('PR 还开着 → 留着，哪怕一个进程都没活着（卡住 ≠ 不需要）', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'PR-#10 审官·x' })],
      aliveWorktreeIds: NONE, prState: { 10: 'OPEN' }, branchState: {},
    });
    assert.equal(p.zombies.length, 0);
    assert.match(p.keep[0].why, /还开着/);
  });

  it('PR 已合但进程还活着 → 不删（memory deleted-card-process-outlived-it）', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'PR-#10 工人·x' })],
      aliveWorktreeIds: new Set(['a']), prState: { 10: 'MERGED' }, branchState: {},
    });
    assert.equal(p.zombies.length, 0);
    assert.match(p.keep[0].why, /还在推进/);
  });

  it('子卡活着也算整树活着——父卡不许删', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'PR-#10 工人·x', kids: ['b'] }), card({ id: 'b', name: 'PR-#10 审官·y', parent: 'a' })],
      aliveWorktreeIds: new Set(['b']), prState: { 10: 'MERGED' }, branchState: {},
    });
    assert.equal(p.zombies.length, 0);
  });
});

describe('僵尸卡：不许丢活', () => {
  it('分支不在远端却有本地提交 → risky，只报不删', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'ISSUE-#7 工人·x', branch: 'refs/heads/wip' })],
      aliveWorktreeIds: NONE, prState: {}, branchState: { wip: { onRemote: false, ahead: 5, dirty: 0, contributes: true } },
    });
    assert.equal(p.zombies.length, 0);
    assert.equal(p.risky.length, 1);
    assert.match(p.risky[0].why, /删了就没了/);
  });

  it('脏文件同样进 risky——未提交的改动删了也没了', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'ISSUE-#7 工人·x', branch: 'refs/heads/wip' })],
      aliveWorktreeIds: NONE, prState: {}, branchState: { wip: { onRemote: false, ahead: 0, dirty: 3 } },
    });
    assert.equal(p.risky.length, 1);
  });

  it('远端有同名分支 → 活在 GitHub 上，本地树可留可清，不进 risky', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'ISSUE-#7 工人·x', branch: 'refs/heads/wip' })],
      aliveWorktreeIds: NONE, prState: {}, branchState: { wip: { onRemote: true, ahead: 5, dirty: 0, contributes: true } },
    });
    assert.equal(p.risky.length, 0);
    assert.equal(p.keep.length, 1);
  });

  it('分支相对 master 零提交零改动 → 空卡，判僵尸', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'ISSUE-#7 工人·x', branch: 'refs/heads/wip' })],
      aliveWorktreeIds: NONE, prState: {}, branchState: { wip: { onRemote: false, ahead: 0, dirty: 0 } },
    });
    assert.equal(p.zombies.length, 1);
    assert.equal(p.zombies[0].kind, 'empty-branch');
  });
});

describe('僵尸卡：没查成 ≠ 查过没事', () => {
  it('PR 状态查不到 → unscanned，不删', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'PR-#10 工人·x' })],
      aliveWorktreeIds: NONE, prState: {}, branchState: {},
    });
    assert.equal(p.zombies.length, 0);
    assert.equal(p.unscanned.length, 1);
    assert.match(p.unscanned[0].why, /没查成/);
  });

  it('分支状态查不到 → unscanned，不删', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'ISSUE-#7 工人·x', branch: 'refs/heads/wip' })],
      aliveWorktreeIds: NONE, prState: {}, branchState: {},
    });
    assert.equal(p.unscanned.length, 1);
  });

  it('活性集合没给 → 整轮不判（一张都不动）', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({ worktrees: [card({ id: 'a' })], aliveWorktreeIds: null, prState: {}, branchState: {} });
    assert.equal(p.ok, false);
    assert.equal(p.zombies.length, 0);
  });

  it('盘面没查成 → 整轮不判', async () => {
    const { planBoardGc } = await LOAD;
    assert.equal(planBoardGc({ worktrees: null, aliveWorktreeIds: new Set() }).ok, false);
  });

  it('子卡在 childWorktreeIds 里但不在列表里 → 整树判不了，进 unscanned', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'PR-#10 工人·x', kids: ['ghost'] })],
      aliveWorktreeIds: NONE, prState: { 10: 'MERGED' }, branchState: {},
    });
    assert.equal(p.zombies.length, 0);
    assert.equal(p.unscanned.length, 1);
  });
});

describe('僵尸卡：主树与重复卡', () => {
  it('主树永不进清理名单，哪怕它的 PR 已合', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'm', name: 'PR-#10 工人·x master', main: true })],
      aliveWorktreeIds: NONE, prState: { 10: 'MERGED' }, branchState: {},
    });
    assert.equal(p.zombies.length, 0);
    assert.match(p.keep[0].why, /主树永不删/);
  });

  it('同一 PR 两张审官子卡 → 留最新的，旧的判重复（memory one-pr-one-reviewer）', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [
        card({ id: 'a', name: 'PR-#10 工人·x', kids: ['r1', 'r2'] }),
        card({ id: 'r1', name: 'PR-#10 审官·luna', parent: 'a', at: 100 }),
        card({ id: 'r2', name: 'PR-#10 审官·luna-2', parent: 'a', at: 200 }),
      ],
      aliveWorktreeIds: NONE, prState: { 10: 'OPEN' }, branchState: {},
    });
    const dup = p.zombies.filter((z) => z.kind === 'duplicate');
    assert.equal(dup.length, 1);
    assert.equal(dup[0].id, 'r1', '该删旧的那张，不是新的');
  });

  it('重复卡上还有活着的进程 → 不删', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [
        card({ id: 'a', name: 'PR-#10 工人·x', kids: ['r1', 'r2'] }),
        card({ id: 'r1', name: 'PR-#10 审官·luna', parent: 'a', at: 100 }),
        card({ id: 'r2', name: 'PR-#10 审官·luna-2', parent: 'a', at: 200 }),
      ],
      aliveWorktreeIds: new Set(['r1']), prState: { 10: 'OPEN' }, branchState: {},
    });
    assert.equal(p.zombies.length, 0);
  });

  it('普通子卡不单独出列——随父卡整树走', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'PR-#10 工人·x', kids: ['b'] }), card({ id: 'b', name: 'PR-#10 审官·y', parent: 'a' })],
      aliveWorktreeIds: NONE, prState: { 10: 'MERGED' }, branchState: {},
    });
    assert.equal(p.zombies.length, 1, '整树一条记录，不是父子各一条');
    assert.equal(p.zombies[0].id, 'a');
    assert.equal(p.zombies[0].children, 1);
  });
});

// 2026-09-05 实测：盘面 45 个会话判 active，其中 37 个是 pi 停在空会话界面反复重画边框。
// lastOutputAt 每次重画都刷新 → 永远 active → 僵尸卡永远清不掉。
describe('空转的 TUI 不算在推进', () => {
  it('屏面内容一个字没变，隔多久都不算推进', async () => {
    const L = await LIVE;
    const now = 1e9;
    const idle = { id: 't', label: 'Pi ready', preview: '——————', lastProgressAt: now };
    const r1 = L.applyProgressMemory({ sessions: [idle], memory: {}, now });
    const later = now + 3 * 3600 * 1000;
    const r2 = L.applyProgressMemory({
      sessions: [{ ...idle, lastProgressAt: later }], memory: r1.memory, now: later,
    });
    assert.equal(L.assessLiveness(r2.sessions[0], { now: later }).state, 'silent',
      '驱动一直在输出，但屏上没有任何推进——这就是它躺 10 小时没人发现的原因');
  });

  it('屏面变了就是推进', async () => {
    const L = await LIVE;
    const now = 1e9;
    const r1 = L.applyProgressMemory({ sessions: [{ id: 't', label: 'x', preview: 'A', lastProgressAt: now }], memory: {}, now });
    const later = now + 3 * 3600 * 1000;
    const r2 = L.applyProgressMemory({
      sessions: [{ id: 't', label: 'x', preview: 'B 干活了', lastProgressAt: later }], memory: r1.memory, now: later,
    });
    assert.equal(L.assessLiveness(r2.sessions[0], { now: later }).state, 'active');
  });

  it('第一轮不冤枉谁：没见过的会话按驱动报的时间算', async () => {
    const L = await LIVE;
    const now = 1e9;
    const r = L.applyProgressMemory({ sessions: [{ id: 't', label: 'x', preview: 'A', lastProgressAt: now }], memory: {}, now });
    assert.equal(L.assessLiveness(r.sessions[0], { now }).state, 'active');
  });

  it('驱动说它 10 小时没输出 → 不因为「本轮第一次见」被洗成刚动过', async () => {
    const L = await LIVE;
    const now = 1e9;
    const old = now - 10 * 3600 * 1000;
    const r = L.applyProgressMemory({ sessions: [{ id: 't', label: 'x', preview: 'A', lastProgressAt: old }], memory: {}, now });
    assert.equal(r.sessions[0].lastProgressAt, old);
    assert.equal(L.assessLiveness(r.sessions[0], { now }).state, 'silent');
  });

  it('边框装饰重画时长度抖动，不算内容变化', async () => {
    const L = await LIVE;
    const a = L.progressSignature({ label: 'Pi ready', preview: '─'.repeat(80) });
    const b = L.progressSignature({ label: 'Pi ready', preview: '─'.repeat(120) });
    assert.equal(a, b, '只是边框宽度变了，不是干了活');
  });
});

describe('board-gc 命令：判据不许在驱动层重写一遍', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'board-gc.mjs'), 'utf8');
  it('活性走 liveness.mjs，不另写一把尺', () => {
    assert.match(src, /from '\.\/lib\/liveness\.mjs'/);
    assert.doesNotMatch(src, /lastOutputAt\s*[<>]/, '别在驱动层直接拿时间戳比大小');
  });
  it('判决走 board-gc.mjs 纯函数', () => {
    assert.match(src, /planBoardGc\(\{/);
  });
  it('默认不删：要 --apply 才调 worktree-rm', () => {
    const i = src.indexOf("'worktree-rm'");
    assert.ok(i > -1, '找不到 worktree-rm 调用，判据已失效');
    assert.match(src.slice(Math.max(0, i - 400), i), /if \(args\.apply\)/);
  });
  it('任何一节没查成都以退出码 2 收场，不装成扫完是空的', () => {
    assert.ok((src.match(/process\.exit\(2\)/g) || []).length >= 4);
  });
});

// 2026-09-05 实测：三支「无 PR + 有本地提交」的分支，git cherry 全报「未合入」，
// 而内容其实早已由别的 PR 落进 master（同一件事的旧实现，rebase 后 patch-id 就对不上）。
// 提交号比不出陈旧副本，只有内容比得出来。
describe('陈旧副本分支：按内容判，不按提交号', () => {
  it('合进 master 等于没合 → 可清，哪怕它有一堆本地提交', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'ISSUE-#7 工人·x', branch: 'refs/heads/old' })],
      aliveWorktreeIds: NONE, prState: {},
      branchState: { old: { onRemote: false, ahead: 5, dirty: 0, contributes: false } },
    });
    assert.equal(p.zombies.length, 1);
    assert.equal(p.zombies[0].kind, 'already-in-master');
  });

  it('真有 master 没有的内容 + 远端没备份 → risky，绝不自动删', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'ISSUE-#7 工人·x', branch: 'refs/heads/old' })],
      aliveWorktreeIds: NONE, prState: {},
      branchState: { old: { onRemote: false, ahead: 5, dirty: 0, contributes: true } },
    });
    assert.equal(p.zombies.length, 0);
    assert.equal(p.risky.length, 1);
  });

  it('合不干净（有冲突）→ 判不了就是判不了，转 risky 不猜', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'ISSUE-#7 工人·x', branch: 'refs/heads/old' })],
      aliveWorktreeIds: NONE, prState: {},
      branchState: { old: { onRemote: false, ahead: 5, dirty: 0, contributes: null } },
    });
    assert.equal(p.zombies.length, 0);
    assert.match(p.risky[0].why, /合不干净/);
  });

  it('未提交的改动不进内容判据——它不可能已经在 master 里', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'ISSUE-#7 工人·x', branch: 'refs/heads/old' })],
      aliveWorktreeIds: NONE, prState: {},
      branchState: { old: { onRemote: false, ahead: 0, dirty: 4, contributes: false } },
    });
    assert.equal(p.zombies.length, 0, '脏文件在的时候 contributes:false 也不许判可清');
    assert.match(p.risky[0].why, /未提交改动/);
  });

  it('驱动层真的去问了 merge-tree，不是拿提交数糊弄', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'board-gc.mjs'), 'utf8');
    assert.match(src, /merge-tree/);
    assert.ok(!src.includes("['cherry'"), 'git cherry 会给出假的「未合入」，不许用它判');
  });
});

// 2026-09-05 实测：ISSUE-#874 挂在主树下，静默 26 小时、分支是陈旧副本，
// 却一轮都没进过判定名单——「子卡随父卡走」+「主树永不删」= 主树的子卡永不被判。
describe('挂在主树下的卡要单独判（不然永远轮不到它）', () => {
  it('主树的子卡按顶层卡判，能判成僵尸', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [
        card({ id: 'm', name: 'master', main: true, kids: ['c'] }),
        card({ id: 'c', name: 'ISSUE-#7 工人·x', parent: 'm', branch: 'refs/heads/old' }),
      ],
      aliveWorktreeIds: NONE, prState: {},
      branchState: { old: { onRemote: false, ahead: 3, dirty: 0, contributes: false } },
    });
    assert.equal(p.zombies.length, 1);
    assert.equal(p.zombies[0].id, 'c');
  });

  it('普通父卡的子卡仍随父卡走，不单独出列', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [
        card({ id: 'a', name: 'PR-#10 工人·x', kids: ['b'] }),
        card({ id: 'b', name: 'PR-#10 审官·y', parent: 'a', branch: 'refs/heads/old' }),
      ],
      aliveWorktreeIds: NONE, prState: { 10: 'MERGED' },
      branchState: { old: { onRemote: false, ahead: 0, dirty: 0, contributes: false } },
    });
    assert.equal(p.zombies.length, 1);
    assert.equal(p.zombies[0].id, 'a', '仍是整树一条，不是父子各一条');
  });

  it('主树的子卡活着照样不删', async () => {
    const { planBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [
        card({ id: 'm', name: 'master', main: true, kids: ['c'] }),
        card({ id: 'c', name: 'ISSUE-#7 工人·x', parent: 'm', branch: 'refs/heads/old' }),
      ],
      aliveWorktreeIds: new Set(['c']), prState: {},
      branchState: { old: { onRemote: false, ahead: 3, dirty: 0, contributes: false } },
    });
    assert.equal(p.zombies.length, 0);
  });
});

// 2026-09-05 补两类死卡：PR 还开着不代表**这张卡**的活没完。
// 盘面实况：12 张审官卡里 PR #884/#885 两张判定已落当前 head（活交付了），
// ISSUE-#874 的单早关了卡还挂着——只判 PR 态的话这三张永远清不掉。
describe('活已交付的卡也是僵尸（PR 还开着 ≠ 这张卡还有事做）', () => {
  const card = (over = {}) => ({
    id: 'wt_r', displayName: 'PR-#884 审官·gpt-5.6-luna', path: '/x', branch: 'refs/heads/PR-884-审官',
    childWorktreeIds: [], ...over,
  });
  const base = { aliveWorktreeIds: new Set(), prState: new Map([[884, 'OPEN']]), branchState: new Map() };

  it('审官判定已落当前 head + 无活口 → 判僵尸', async () => {
    const S = await LOAD;
    const p = S.planBoardGc({ ...base, worktrees: [card()], prJudgedAtHead: new Map([[884, true]]) });
    assert.equal(p.zombies.length, 1, JSON.stringify(p));
    assert.equal(p.zombies[0].kind, 'reviewer-delivered');
  });

  it('故意违规样本①：判定还没落 → 留着（这是「卡住」，归换人不归清理）', async () => {
    const S = await LOAD;
    const p = S.planBoardGc({ ...base, worktrees: [card()], prJudgedAtHead: new Map([[884, false]]) });
    assert.equal(p.zombies.length, 0);
    assert.equal(p.keep.length, 1);
  });

  it('故意违规样本②：判定表没查成 → 留着，不许当成「已交付」', async () => {
    const S = await LOAD;
    for (const t of [undefined, null, new Map()]) {
      const p = S.planBoardGc({ ...base, worktrees: [card()], prJudgedAtHead: t });
      assert.equal(p.zombies.length, 0, `prJudgedAtHead=${JSON.stringify(t)} 不该判僵尸`);
    }
  });

  it('故意违规样本③：判定落了但树上还有活口 → 不删', async () => {
    const S = await LOAD;
    const p = S.planBoardGc({ ...base, aliveWorktreeIds: new Set(['wt_r']),
      worktrees: [card()], prJudgedAtHead: new Map([[884, true]]) });
    assert.equal(p.zombies.length, 0);
  });

  it('不是审官卡的，判定落没落都不按这条清（工人卡还要返工）', async () => {
    const S = await LOAD;
    const p = S.planBoardGc({ ...base,
      worktrees: [card({ displayName: 'PR-#884 工人·claude-opus-5 返工' })],
      prJudgedAtHead: new Map([[884, true]]) });
    assert.equal(p.zombies.length, 0);
    assert.equal(p.keep.length, 1);
  });
});

describe('issue 已关闭的无 PR 卡是僵尸', () => {
  const card = (over = {}) => ({
    id: 'wt_i', displayName: 'ISSUE-#874 帅位职责制度化落地', path: '/y',
    branch: 'refs/heads/duty-solution-delivery', childWorktreeIds: [], ...over,
  });
  // 分支态给成「有东西没落地」——证明 issue 已关这条是自己判出来的，不是靠分支空。
  const base = {
    aliveWorktreeIds: new Set(), prState: new Map(),
    branchState: new Map([['duty-solution-delivery', { onRemote: true, ahead: 3, dirty: 0, contributes: true }]]),
  };

  it('issue 已关 + 无 PR + 无活口 → 判僵尸', async () => {
    const S = await LOAD;
    const p = S.planBoardGc({ ...base, worktrees: [card()], issueState: new Map([[874, 'CLOSED']]) });
    assert.equal(p.zombies.length, 1, JSON.stringify(p));
    assert.equal(p.zombies[0].kind, 'issue-closed');
  });

  it('故意违规样本：issue 还开着 → 不清（分支有 3 个提交，走原来的留着）', async () => {
    const S = await LOAD;
    const p = S.planBoardGc({ ...base, worktrees: [card()], issueState: new Map([[874, 'OPEN']]) });
    assert.equal(p.zombies.length, 0);
  });

  it('故意违规样本：issue 表没查成 → 不启用这条判据', async () => {
    const S = await LOAD;
    for (const t of [undefined, null, new Map()]) {
      const p = S.planBoardGc({ ...base, worktrees: [card()], issueState: t });
      assert.equal(p.zombies.filter((z) => z.kind === 'issue-closed').length, 0);
    }
  });

  it('有活口就不删，issue 关了也不删', async () => {
    const S = await LOAD;
    const p = S.planBoardGc({ ...base, aliveWorktreeIds: new Set(['wt_i']),
      worktrees: [card()], issueState: new Map([[874, 'CLOSED']]) });
    assert.equal(p.zombies.length, 0);
  });
});

// 审官卡永远挂在工人卡底下，而子卡原本只有「重复卡」一条出路——
// 于是「审官活已交付」这条判据够不着它：工人卡的 PR 还开着，整树就留着。
// 2026-08-22 已拍板「审结即清树」，这里把它自动化。
describe('判定已交付的审官子卡可以单独出列', () => {
  const parent = { id: 'wt_p', displayName: 'PR-#884 辅助·claude-opus 工人替身', path: '/p',
    branch: 'refs/heads/wd-884', childWorktreeIds: ['wt_r'] };
  const kid = { id: 'wt_r', displayName: 'PR-#884 审官·gpt-5.6-luna', path: '/r',
    branch: 'refs/heads/PR-884-审官', parentWorktreeId: 'wt_p', childWorktreeIds: [] };
  const base = {
    worktrees: [parent, kid], aliveWorktreeIds: new Set(),
    prState: new Map([[884, 'OPEN']]),
    branchState: new Map([['wd-884', { onRemote: true, ahead: 1, dirty: 0, contributes: true }]]),
  };

  it('判定落了 → 审官子卡单独判僵尸，父卡照旧留着', async () => {
    const S = await LOAD;
    const p = S.planBoardGc({ ...base, prJudgedAtHead: new Map([[884, true]]) });
    const z = p.zombies.filter((x) => x.kind === 'reviewer-delivered');
    assert.equal(z.length, 1, JSON.stringify(p));
    assert.equal(z[0].id, 'wt_r');
    assert.ok(p.keep.some((k) => k.id === 'wt_p'), '父卡的 PR 还开着，不该被带走');
  });

  it('故意违规样本：审官卡上还有活口 → 不删', async () => {
    const S = await LOAD;
    const p = S.planBoardGc({ ...base, aliveWorktreeIds: new Set(['wt_r']),
      prJudgedAtHead: new Map([[884, true]]) });
    assert.equal(p.zombies.filter((x) => x.kind === 'reviewer-delivered').length, 0);
  });

  it('故意违规样本：判定还没落 → 不删（这是卡住，归换人）', async () => {
    const S = await LOAD;
    const p = S.planBoardGc({ ...base, prJudgedAtHead: new Map([[884, false]]) });
    assert.equal(p.zombies.length, 0);
  });

  it('故意违规样本：不是审官的子卡，判定落了也不单独出列', async () => {
    const S = await LOAD;
    const worker = { ...kid, displayName: 'PR-#884 工人·claude-opus-5 返工' };
    const p = S.planBoardGc({ ...base, worktrees: [parent, worker],
      prJudgedAtHead: new Map([[884, true]]) });
    assert.equal(p.zombies.length, 0);
  });
});

// ── #950：risky 卡自动 salvage ────────────────────────────────────────────────
// 2026-09-05 人工救 ISSUE-#852 / #874 的两步（先把提交推成 salvage/<单号>-<短名>，再删树）
// 自动化。每条反例都对着一种「以为救了其实没救」：推失败还照删、脏文件根本推不上去、
// 把上一次的备份覆盖掉。删树不可逆，salvage 分支是唯一的备份，所以判据取最严的一档。
const { spawnSync } = require('node:child_process');
const os = require('node:os');

describe('salvage 分支名：看得出救的是哪张卡，且是条合法分支名', () => {
  it('有单号有分支名 → salvage/<单号>-<分支名>（照抄人工救那两张卡的格式）', async () => {
    const { salvageBranchName } = await LOAD;
    assert.equal(salvageBranchName({ name: 'ISSUE-#852 群聊直连', branch: 'hub-chat' }), 'salvage/852-hub-chat');
    assert.equal(salvageBranchName({ name: 'ISSUE-#874 帅位职责', branch: 'refs/heads/duty' }), 'salvage/874-duty');
  });

  it('分支名全是中文 → 退回单号，不拼出半截乱码', async () => {
    const { salvageBranchName } = await LOAD;
    assert.equal(salvageBranchName({ name: 'ISSUE-#874 帅位职责制度化落地', branch: '帅位职责' }), 'salvage/874');
  });

  it('没单号 → 用分支名，仍看得出从哪来', async () => {
    const { salvageBranchName } = await LOAD;
    assert.equal(salvageBranchName({ name: '临时试验', branch: 'wip-probe' }), 'salvage/wip-probe');
  });

  it('单号和分支名都拼不出字符 → null（名字猜不得，宁可不救）', async () => {
    const { salvageBranchName } = await LOAD;
    assert.equal(salvageBranchName({ name: '中文卡', branch: '中文分支' }), null);
    assert.equal(salvageBranchName({}), null);
  });

  it('拼出来的必须是 git 收得下的分支名：无空格无 # 无 .. 不以 - 结尾', async () => {
    const { salvageBranchName } = await LOAD;
    for (const b of ['feat/a b#c..d', '../../etc/passwd', 'x'.repeat(120), 'trailing---']) {
      const n = salvageBranchName({ name: 'ISSUE-#7 x', branch: b });
      assert.match(n, /^salvage\/[A-Za-z0-9_-]+$/, `${b} → ${n}`);
      assert.ok(!n.includes('..') && !n.endsWith('-'), n);
      assert.ok(n.length < 64, `太长：${n}`);
    }
  });
});

describe('哪种 risky 卡能自动救（反证：正常那条必须真的走通）', () => {
  const one = async (bs) => {
    const { planBoardGc, planSalvage } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'ISSUE-#852 群聊直连', branch: 'refs/heads/hub-chat' })],
      aliveWorktreeIds: NONE, prState: {}, branchState: { 'hub-chat': bs },
    });
    return { p, jobs: planSalvage(p) };
  };

  it('无远端 + 有提交 + 树干净 → 标成可救，带上要推的分支名', async () => {
    const { p, jobs } = await one({ onRemote: false, ahead: 5, dirty: 0, contributes: true });
    assert.equal(p.risky.length, 1);
    assert.equal(p.risky[0].salvage.branch, 'salvage/852-hub-chat');
    assert.equal(jobs.length, 1, '正常情况必须真能派出救援任务，否则判据是恒拒');
    assert.equal(jobs[0].path, '/w/a');
  });

  it('合不干净（判不了是不是陈旧副本）也能救——备份让「删了会丢」这个理由不成立', async () => {
    const { p, jobs } = await one({ onRemote: false, ahead: 3, dirty: 0, contributes: null });
    assert.match(p.risky[0].why, /合不干净/);
    assert.equal(jobs.length, 1);
  });

  it('故意违规样本①：有未提交改动 → 不自动救，只播报（push 推不上没提交的东西）', async () => {
    const { p, jobs } = await one({ onRemote: false, ahead: 2, dirty: 4, contributes: true });
    assert.equal(p.risky.length, 1);
    assert.equal(p.risky[0].salvage, undefined, '脏卡不许带救援标记');
    assert.match(p.risky[0].salvageBlocked, /未提交改动/);
    assert.equal(jobs.length, 0, '脏卡不许进救援名单');
    assert.equal(p.zombies.length, 0);
  });

  it('故意违规样本②：脏卡就算被塞进一条「推成功」的结果，也一张都不删', async () => {
    const { planBoardGc, applySalvage } = await LOAD;
    const p = planBoardGc({
      worktrees: [card({ id: 'a', name: 'ISSUE-#852 群聊直连', branch: 'refs/heads/hub-chat' })],
      aliveWorktreeIds: NONE, prState: {},
      branchState: { 'hub-chat': { onRemote: false, ahead: 2, dirty: 4, contributes: true } },
    });
    const after = applySalvage(p, { a: { pushed: true, branch: 'salvage/852-hub-chat' } });
    assert.equal(after.zombies.length, 0, '没标可救的卡，伪造结果也不该让它变可清');
    assert.equal(after.risky.length, 1);
  });

  it('分支已在远端 → 本来就有备份，不进 risky 也不救', async () => {
    const { p, jobs } = await one({ onRemote: true, ahead: 5, dirty: 0, contributes: true });
    assert.equal(p.risky.length, 0);
    assert.equal(jobs.length, 0);
    assert.equal(p.keep.length, 1);
  });

  it('分支在远端但合不干净 → 仍要人判，但不再推一条备份（已经有了）', async () => {
    const { p, jobs } = await one({ onRemote: true, ahead: 4, dirty: 0, contributes: null });
    assert.equal(p.risky.length, 1);
    assert.match(p.risky[0].salvageBlocked, /已在远端/);
    assert.equal(jobs.length, 0, '同一份内容不该在远端存两条');
  });

  it('卡上没有树路径 → 推不了，不救（理由要写出来，别让它无声无息挂着）', async () => {
    const { planBoardGc, planSalvage } = await LOAD;
    const w = card({ id: 'a', name: 'ISSUE-#852 群聊直连', branch: 'refs/heads/hub-chat' });
    w.path = null;
    const p = planBoardGc({
      worktrees: [w], aliveWorktreeIds: NONE, prState: {},
      branchState: { 'hub-chat': { onRemote: false, ahead: 5, dirty: 0, contributes: true } },
    });
    assert.match(p.risky[0].salvageBlocked, /树路径/);
    assert.equal(planSalvage(p).length, 0);
  });

  it('干跑报告要说清「会推哪条」和「为什么没救」', async () => {
    const { planBoardGc, formatBoardGc } = await LOAD;
    const p = planBoardGc({
      worktrees: [
        card({ id: 'a', name: 'ISSUE-#852 群聊直连', branch: 'refs/heads/hub-chat' }),
        card({ id: 'b', name: 'ISSUE-#853 脏树', branch: 'refs/heads/dirty-one' }),
      ],
      aliveWorktreeIds: NONE, prState: {},
      branchState: {
        'hub-chat': { onRemote: false, ahead: 5, dirty: 0, contributes: true },
        'dirty-one': { onRemote: false, ahead: 1, dirty: 2, contributes: true },
      },
    });
    const txt = formatBoardGc(p, { apply: false });
    assert.match(txt, /可自动救：--apply 会先推 salvage\/852-hub-chat/);
    assert.match(txt, /不自动救：.*未提交改动/);
  });
});

describe('推成了才准清树（applySalvage 是删树前最后一道闸）', () => {
  const plan = async () => {
    const { planBoardGc } = await LOAD;
    return planBoardGc({
      worktrees: [card({ id: 'a', name: 'ISSUE-#852 群聊直连', branch: 'refs/heads/hub-chat' })],
      aliveWorktreeIds: NONE, prState: {},
      branchState: { 'hub-chat': { onRemote: false, ahead: 5, dirty: 0, contributes: true } },
    });
  };

  it('推成了 → 转判可清，说明里带上备份在哪（反证：这条路必须真能走通）', async () => {
    const { applySalvage } = await LOAD;
    const after = applySalvage(await plan(), new Map([['a', { pushed: true, branch: 'salvage/852-hub-chat' }]]));
    assert.equal(after.risky.length, 0);
    assert.equal(after.zombies.length, 1);
    assert.equal(after.zombies[0].kind, 'salvaged');
    assert.match(after.zombies[0].why, /salvage\/852-hub-chat/);
  });

  it('故意违规样本③：推失败 → 一张都不删，理由写进 risky', async () => {
    const { applySalvage } = await LOAD;
    const after = applySalvage(await plan(), { a: { pushed: false, error: '没网' } });
    assert.equal(after.zombies.length, 0, 'push 没成功而树被删 = 活丢了');
    assert.equal(after.risky.length, 1);
    assert.match(after.risky[0].why, /自动 salvage 没成：没网/);
  });

  it('故意违规样本：压根没拿到推送结果 → 不删（没查成 ≠ 推成了）', async () => {
    const { applySalvage } = await LOAD;
    for (const r of [new Map(), {}, null, undefined, { a: null }, { a: 'ok' }]) {
      const after = applySalvage(await plan(), r);
      assert.equal(after.zombies.length, 0, `results=${JSON.stringify(r)} 不该删`);
      assert.equal(after.risky.length, 1);
    }
  });

  it('故意违规样本：pushed 是字符串 "true" → 不删（只认布尔真）', async () => {
    const { applySalvage } = await LOAD;
    const after = applySalvage(await plan(), { a: { pushed: 'true', branch: 'salvage/852-hub-chat' } });
    assert.equal(after.zombies.length, 0);
  });

  it('故意违规样本：推成了但推的是另一条分支 → 不删（备份不在说好的地方）', async () => {
    const { applySalvage } = await LOAD;
    const after = applySalvage(await plan(), { a: { pushed: true, branch: 'salvage/别的' } });
    assert.equal(after.zombies.length, 0);
    assert.match(after.risky[0].why, /不是 salvage\/852-hub-chat/);
  });

  it('原本就判出来的僵尸、留着、没查成三节，救援一步都不动它们', async () => {
    const { planBoardGc, applySalvage } = await LOAD;
    const p = planBoardGc({
      worktrees: [
        card({ id: 'z', name: 'PR-#10 工人·x' }),
        card({ id: 'k', name: 'PR-#11 工人·y' }),
        card({ id: 'u', name: 'PR-#12 工人·z' }),
      ],
      aliveWorktreeIds: NONE, prState: { 10: 'MERGED', 11: 'OPEN' }, branchState: {},
    });
    const after = applySalvage(p, new Map());
    assert.deepEqual(after.zombies, p.zombies);
    assert.deepEqual(after.keep, p.keep);
    assert.deepEqual(after.unscanned, p.unscanned);
  });

  it('判决本身没跑成 → 原样退回，不凭空造出可清名单', async () => {
    const { planBoardGc, applySalvage, planSalvage } = await LOAD;
    const bad = planBoardGc({ worktrees: null, aliveWorktreeIds: new Set() });
    assert.equal(applySalvage(bad, { a: { pushed: true } }).zombies.length, 0);
    assert.equal(planSalvage(bad).length, 0);
  });
});

// 上面几条都是纯函数层的判据。真正会把备份冲掉的是 git 那一步，所以这一节在真 git 仓上跑：
// 临时建一个 bare 当 origin，造出「远端已有同名 salvage 分支」的违规样本，看它被不被拦。
describe('pushSalvage 真 git：不覆盖、不谎报', () => {
  const DRIVER = import('file://' + path.join(__dirname, '..', 'scripts', 'board-gc.mjs').replace(/\\/g, '/'));
  const REF = 'refs/heads/salvage/900-probe';

  const git = (cwd, args) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { encoding: 'utf8', windowsHide: true });
  const oidOnOrigin = (work) => {
    const r = git(work, ['ls-remote', 'origin', REF]);
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.trim().split(/\r?\n/).filter(Boolean)[0];
    return line ? line.split(/\s+/)[0] : null;
  };
  const commit = (work, file, text) => {
    fs.writeFileSync(path.join(work, file), text);
    assert.equal(git(work, ['add', '-A']).status, 0);
    assert.equal(git(work, ['commit', '-m', file]).status, 0);
    return git(work, ['rev-parse', 'HEAD']).stdout.trim();
  };

  const withRepo = async (fn) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bgc-salvage-'));
    const origin = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    fs.mkdirSync(work);
    assert.equal(spawnSync('git', ['init', '--bare', origin], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['init', work], { encoding: 'utf8' }).status, 0);
    assert.equal(git(work, ['remote', 'add', 'origin', origin]).status, 0);
    try { await fn({ root, origin, work }); }
    finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响判定 */ } }
  };

  it('远端没有同名分支 → 推上去，且远端那条 ref 真的等于本地 HEAD（反证：正常路走得通）', async () => {
    const { pushSalvage } = await DRIVER;
    await withRepo(async ({ work }) => {
      const head = commit(work, 'a.txt', 'one');
      const r = pushSalvage({ path: work, salvageBranch: 'salvage/900-probe' });
      assert.equal(r.pushed, true, r.error);
      assert.equal(r.branch, 'salvage/900-probe');
      assert.equal(oidOnOrigin(work), head, '说推成了就得真在远端');
    });
  });

  it('故意违规样本③：远端已有同名分支且是别的 commit → 判失败，远端那条一个字没变', async () => {
    const { pushSalvage } = await DRIVER;
    await withRepo(async ({ work }) => {
      const first = commit(work, 'a.txt', 'one');
      assert.equal(git(work, ['push', 'origin', 'HEAD:' + REF]).status, 0, '先造出「上一次的备份」');
      const second = commit(work, 'b.txt', 'two');
      assert.notEqual(first, second);
      const r = pushSalvage({ path: work, salvageBranch: 'salvage/900-probe' });
      assert.equal(r.pushed, false);
      assert.match(r.error, /不覆盖/);
      assert.equal(oidOnOrigin(work), first, '上一次的备份被冲掉了——这正是不许发生的事');
    });
  });

  it('远端已有同名分支且就是同一个 commit → 算已经救过，重跑不报错也不重推', async () => {
    const { pushSalvage } = await DRIVER;
    await withRepo(async ({ work }) => {
      const head = commit(work, 'a.txt', 'one');
      assert.equal(pushSalvage({ path: work, salvageBranch: 'salvage/900-probe' }).pushed, true);
      const again = pushSalvage({ path: work, salvageBranch: 'salvage/900-probe' });
      assert.equal(again.pushed, true);
      assert.equal(oidOnOrigin(work), head);
    });
  });

  it('故意违规样本：远端问不出来（origin 指向不存在的地方）→ 判失败，不当成「远端没有」', async () => {
    const { pushSalvage } = await DRIVER;
    await withRepo(async ({ root, work }) => {
      commit(work, 'a.txt', 'one');
      assert.equal(git(work, ['remote', 'set-url', 'origin', path.join(root, 'no-such-repo.git')]).status, 0);
      const r = pushSalvage({ path: work, salvageBranch: 'salvage/900-probe' });
      assert.equal(r.pushed, false);
      assert.match(r.error, /问不出|push 失败/);
    });
  });

  it('故意违规样本：push 报成功、远端那条 ref 却不是本地 HEAD → 判失败（推完必须回查）', async () => {
    const { pushSalvage } = await DRIVER;
    await withRepo(async ({ origin, work }) => {
      const first = commit(work, 'a.txt', 'one');
      const second = commit(work, 'b.txt', 'two');
      // 远端收下推送后立刻把 ref 改回旧 commit（真实里对应钩子改写／推错仓／代理吞掉）：
      // push 退出码照样是 0，而备份并不是我们以为的那个。只信退出码就会在这里删掉活。
      fs.writeFileSync(path.join(origin, 'hooks', 'post-receive'),
        '#!/bin/sh\ngit update-ref ' + REF + ' ' + first + '\n', { mode: 0o755 });
      const r = pushSalvage({ path: work, salvageBranch: 'salvage/900-probe' });
      assert.equal(r.pushed, false, 'push 说成功 ≠ 备份落在说好的地方');
      assert.match(r.error, /回查对不上/);
      assert.equal(oidOnOrigin(work), first);
      assert.notEqual(oidOnOrigin(work), second);
    });
  });

  it('故意违规样本：树里一个提交都没有 → 读不出 HEAD，判失败（不知道推的是什么就不推）', async () => {
    const { pushSalvage } = await DRIVER;
    await withRepo(async ({ work }) => {
      const r = pushSalvage({ path: work, salvageBranch: 'salvage/900-probe' });
      assert.equal(r.pushed, false);
      assert.match(r.error, /HEAD/);
    });
  });
});

describe('board-gc 命令：救援这一步也不许在干跑时动手', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'board-gc.mjs'), 'utf8');

  it('pushSalvage 只有一处调用，且在 --apply 里面', () => {
    const hits = src.match(/pushSalvage\(/g) || [];
    assert.equal(hits.length, 2, '一处定义一处调用；多出来的调用可能跑在干跑路径上');
    const i = src.indexOf('pushSalvage(j)');
    assert.ok(i > -1, '找不到调用点，判据已失效');
    assert.match(src.slice(Math.max(0, i - 300), i), /if \(args\.apply/);
  });

  it('干跑不许把 risky 转成可清：applySalvage 也在 --apply 里面', () => {
    const i = src.indexOf('applySalvage(plan');
    assert.ok(i > -1);
    assert.match(src.slice(Math.max(0, i - 400), i), /if \(args\.apply/);
  });

  it('删树读的是救援之后的名单，不是原判决', () => {
    const i = src.indexOf("'worktree-rm'");
    assert.match(src.slice(Math.max(0, i - 300), i), /for \(const z of final\.zombies\)/);
  });

  it('永远不许 --force：这条路上没有任何该覆盖的情形', () => {
    // 只看真传给 git 的参数（带引号的那种），不看注释里提到的字样——
    // 注释解释「为什么不用 --force」是好事，被自己的注释判红就没人敢写解释了。
    assert.doesNotMatch(src, /['"`]--force/);
  });

  it('救援判据走 lib 纯函数，不在驱动层重写一遍', () => {
    assert.match(src, /planSalvage, applySalvage \} from '\.\/lib\/board-gc\.mjs'/);
  });

  it('加了「被 import 时不跑 main」的开关后，直接跑仍然照跑（别把命令自己关掉）', () => {
    // 喂一个什么都不吐的假 orca：盘面查不成 → 退出码 2。如果 main 没跑，退出码会是 0，
    // 命令看着还在、其实一轮都不干活——加那个开关最可能造成的正是这种静默失效。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgc-noorca-'));
    const fake = path.join(dir, 'orca.mjs');
    fs.writeFileSync(fake, '// 假 orca：一个字都不输出\n');
    try {
      const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'board-gc.mjs')], {
        encoding: 'utf8', windowsHide: true, timeout: 60000,
        env: { ...process.env, BOARD_GC_ORCA: fake },
      });
      assert.equal(r.status, 2, '盘面查不成该以 2 收场；如果是 0，多半是 main 根本没跑');
      assert.match(String(r.stderr), /盘面没查成/);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响判定 */ } }
  });
});

// salvage 分支只保命、不开 PR——它永远不会「已合并」，收工令必须留着它。
describe('收工令不许把没合的 salvage 分支当垃圾清掉', () => {
  const LAND = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'land-core.mjs').replace(/\\/g, '/'));

  it('未合并的 salvage 分支 → 不删', async () => {
    const { decideBranchDelete } = await LAND;
    const d = decideBranchDelete({ name: 'salvage/852-hub-chat', merged: false, isDefault: false, isCurrent: false, checkedOutAt: '' });
    assert.equal(d.del, false);
    assert.match(d.reason, /未合并/);
  });

  it('land.mjs 删本地分支只看「已合并进默认分支」，远端那节只列不删', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'land.mjs'), 'utf8');
    assert.match(src, /'branch', '--merged'/, '删支判据必须是 --merged；换成别的判据就可能扫到 salvage');
    assert.match(src, /只列不删/);
    assert.doesNotMatch(src, /'push', '--delete'|'--delete', 'origin'/, '收工令不许删远端分支');
  });
});
