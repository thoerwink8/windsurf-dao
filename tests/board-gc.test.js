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
