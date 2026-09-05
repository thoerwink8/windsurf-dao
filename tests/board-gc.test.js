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
      aliveWorktreeIds: NONE, prState: {}, branchState: { wip: { onRemote: false, ahead: 5, dirty: 0 } },
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
      aliveWorktreeIds: NONE, prState: {}, branchState: { wip: { onRemote: true, ahead: 5, dirty: 0 } },
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
