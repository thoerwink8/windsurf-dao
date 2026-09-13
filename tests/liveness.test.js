// 会话活性统一接口（issue #940，用户 2026-09-05 拍板：删指纹层只判静默 + 三驱动统一接口）。
// 每条都对着一个实咬：6 个审官掉回裸 shell 停 10 小时零报警；reclaude 终端因为没有 agentIdentity 被整个跳过。
//
// 2026-09-06：原先钉在 agent-stall-watch.mjs 源码文本上的四组断言随该文件一起删了
// （用户拍板屏面指纹整层退役）。本文件现在只测 liveness.mjs 自己的采样与判定。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LIB = 'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'liveness.mjs').replace(/\\/g, '/');
const LOAD = import(LIB);

const NOW = Date.parse('2026-09-05T12:00:00Z');
const min = (n) => new Date(NOW - n * 60000).toISOString();

describe('活性：orca / reclaude 采样面', () => {
  it('reclaude 终端（没有 agentIdentity）也进采样面——旧代码这里 continue 掉了', async () => {
    const S = await LOAD;
    const s = S.sessionFromOrcaTerminal({ handle: 't1', title: '帅位', lastOutputAt: min(5) });
    assert.ok(s, 'reclaude 终端不许被跳过');
    assert.equal(s.driver, 'reclaude');
    assert.equal(S.assessLiveness(s, { now: NOW }).state, 'active');
  });

  it('有 agentIdentity 的仍标 orca 驱动', async () => {
    const S = await LOAD;
    const s = S.sessionFromOrcaTerminal({ handle: 't2', agentIdentity: 'codex', lastOutputAt: min(1) });
    assert.equal(s.driver, 'orca');
  });

  it('停在裸 shell 十小时 → silent（今天真发生的那件事）', async () => {
    const S = await LOAD;
    const s = S.sessionFromOrcaTerminal({
      handle: 't3', title: 'PR-#894 审官·gpt-5.6-luna',
      lastOutputAt: min(611), preview: 'orca@vmi:~/...$',
    });
    const a = S.assessLiveness(s, { now: NOW });
    assert.equal(a.state, 'silent', '屏上没有任何错误字样，但它已经死了 10 小时');
    assert.equal(S.routeSilent(s).action, 'restart-reviewer', '审官静默要判死重起');
  });

  it('没有 lastOutputAt → unscanned，绝不当 active', async () => {
    const S = await LOAD;
    const s = S.sessionFromOrcaTerminal({ handle: 't4', title: 'x' });
    assert.equal(s.unscanned, true);
    assert.equal(S.assessLiveness(s, { now: NOW }).state, 'unscanned');
  });
});

describe('活性：mirasim 驱动', () => {
  it('自报 completed → done，不算静默也不算活着', async () => {
    const S = await LOAD;
    const s = S.sessionFromMirasimSession({ key: 'codex:1', title: '审 PR #893', state: 'completed' });
    assert.equal(S.assessLiveness(s, { now: NOW }).state, 'done');
  });

  it('incomplete 且没有活动时间戳 → silent（一轮跑完在等下一句话，不是没查成）', async () => {
    const S = await LOAD;
    const s = S.sessionFromMirasimSession({ key: 'codex:2', title: 'x', state: 'incomplete' });
    const a = S.assessLiveness(s, { now: NOW });
    assert.equal(a.state, 'silent');
    assert.match(a.why, /incomplete/);
    assert.equal(S.routeSilent(s).action, 'nudge', '工人 incomplete 先推一句继续');
  });

  it('incomplete 不管时间戳新不新都是 silent——阈值还没到也是卡在等话', async () => {
    const S = await LOAD;
    const fresh = S.sessionFromMirasimSession({ key: 'k', state: 'incomplete', lastActivityAt: min(3) });
    const stale = S.sessionFromMirasimSession({ key: 'k', state: 'incomplete', lastActivityAt: min(500) });
    assert.equal(S.assessLiveness(fresh, { now: NOW }).state, 'silent');
    assert.equal(S.assessLiveness(stale, { now: NOW }).state, 'silent');
  });
});

describe('活性：扫一轮的三态可辨', () => {
  it('「扫完都健康」与「压根没采到样本」必须分得开', async () => {
    const S = await LOAD;
    const empty = S.scanLiveness({ sessions: [], now: NOW });
    assert.equal(empty.sampledNothing, true, '空采样面要显形，不许看起来像全绿');
    const healthy = S.scanLiveness({
      sessions: [S.sessionFromOrcaTerminal({ handle: 'a', lastOutputAt: min(1) })], now: NOW,
    });
    assert.equal(healthy.sampledNothing, false);
    assert.equal(healthy.counts.active, 1);
  });

  it('不是数组 → 没查成（第三态）', async () => {
    const S = await LOAD;
    assert.equal(S.scanLiveness({ sessions: null }).ok, false);
  });

  it('四态各自计数，silent 与 unscanned 各自成清单', async () => {
    const S = await LOAD;
    const r = S.scanLiveness({
      now: NOW,
      sessions: [
        S.sessionFromOrcaTerminal({ handle: 'a', lastOutputAt: min(1) }),
        S.sessionFromOrcaTerminal({ handle: 'b', title: '审官', lastOutputAt: min(600) }),
        S.sessionFromOrcaTerminal({ handle: 'c' }),
        S.sessionFromMirasimSession({ key: 'd', state: 'completed' }),
      ],
    });
    assert.deepEqual(r.counts, { active: 1, silent: 1, done: 1, unscanned: 1 });
    assert.equal(r.silent.length, 1);
    assert.equal(r.unscanned.length, 1);
  });

  it('阈值判别力：把阈值调大，同一批就不该再判静默（反证判据真的在用时间）', async () => {
    const S = await LOAD;
    const sessions = [S.sessionFromOrcaTerminal({ handle: 'b', lastOutputAt: min(600) })];
    assert.equal(S.scanLiveness({ sessions, now: NOW }).counts.silent, 1);
    assert.equal(S.scanLiveness({ sessions, now: NOW, thresholdMs: 24 * 3600 * 1000 }).counts.silent, 0);
  });
});

describe('routeSilent：已合并 PR 不重起审官（#1056 / #1043 现场 B）', () => {
  it('PR #1025 已不在开放名单 → skip，不是 restart-reviewer', async () => {
    const S = await LOAD;
    const s = {
      label: '审官', title: '按审官任务书审 PR #1025',
      cwd: '/x/dao-review-pr-1025', why: '静默',
    };
    const r = S.routeSilent(s, { openPrs: [1018] });
    assert.equal(r.action, 'skip', '已合并 PR 不许重起');
    assert.notEqual(r.action, 'restart-reviewer');
  });

  it('PR 还开着 → 仍 restart-reviewer（判别力：不是把审官静默一律掐了）', async () => {
    const S = await LOAD;
    const s = {
      label: '审官', title: '按审官任务书审 PR #1018',
      cwd: '/x/dao-review-pr-1018', why: '静默',
    };
    const r = S.routeSilent(s, { openPrs: [1018] });
    assert.equal(r.action, 'restart-reviewer');
    assert.equal(r.pr, 1018);
  });

  it('开放名单没给 → 仍可报警（现场 B 的 fail 方向）', async () => {
    const S = await LOAD;
    const s = { label: '审官', title: '按审官任务书审 PR #1025', why: '静默' };
    const r = S.routeSilent(s);
    assert.equal(r.action, 'restart-reviewer');
    assert.equal(r.unscanned, true);
  });

  it('工人静默不走审官闸', async () => {
    const S = await LOAD;
    const r = S.routeSilent({ label: '工人 ISSUE-#885', why: '静默' }, { openPrs: [] });
    assert.equal(r.action, 'nudge');
  });

  it('审官判别实验：短 label=「审官」、PR 号在 title 里——已关闭也不重起（不能用短 label 盖掉 title）', async () => {
    const S = await LOAD;
    const r = S.routeSilent(
      { label: '审官', title: '按审官任务书审 PR #1025' },
      { openPrs: [1018] },
    );
    assert.equal(r.action, 'skip', '审官实验：routeSilent({label:审官}) + 已关 PR 不得 restart-reviewer');
    assert.notEqual(r.action, 'restart-reviewer');
  });
});

describe('会话名：卡名压过终端标题（实咬：9 个静默审官一个都没换成人）', () => {
  it('有卡名时用卡名，不用被 CLI 盖成 shell 提示符的标题', async () => {
    const S = await LOAD;
    const s = S.sessionFromOrcaTerminal({
      handle: 't', lastOutputAt: min(600),
      // 这一串就是 CLI 盖上去的 shell 提示符（路径分段拼出来，避免仓外路径闸把测试样本当真指针）
      title: ['orca@vmi:', '~', 'orca', 'workspaces', 'windsurf-dao', 'PR-894-审官-gpt-5.6-luna$'].join('/'),
      displayName: 'PR-#894 审官·gpt-5.6-luna',
    });
    assert.equal(s.label, 'PR-#894 审官·gpt-5.6-luna',
      '拿终端标题当名字，换人判据 parseReviewerCardName 就认不出审官卡，静默审官永远换不了人');
  });
  it('没有卡名才回落标题', async () => {
    const S = await LOAD;
    assert.equal(S.sessionFromOrcaTerminal({ handle: 't', title: '帅位', lastOutputAt: min(1) }).label, '帅位');
  });
});

// ── #1166 之后的同形问题：记录的时间戳会冻住（观察 2026-09-11-会话在跑记录说停.md）──
//
// 病：`record.json` 的 `updatedAt` 记的是「服务端最后一次写记录」。上游 run 断流之后
// 本地执行体继续干、记录不再回写，一个冻住的旧值会被判成「它安静了 45 分钟」。
// 实测推演：同一条会话在 44 分钟时是 active、45 分钟时翻成 silent，此后可回收——
// 而那一刻树里还有 18 个进程在跑整套测试。判据的可靠性不该依赖「恰好没跑到越线那一刻」。
//
// 改法：加一层树内进程判据，且**记录说安静但树里有活进程 → 按在跑处理**。
// 这四条各自对着一个具体的翻车形态。
describe('活性：树内进程压过冻住的时间戳', () => {
  const TREE = '/home/orca/mirasim-worktrees/windsurf-dao/dao-1150';
  const scanWith = (cwd) => ({ ok: true, procs: [{ pid: 11, cwd }] });

  it('记录冻住两小时、但树里有活进程 → active（这正是那条实咬）', async () => {
    const S = await LOAD;
    const frozen = { id: 's', worktreeId: TREE, driverState: 'running', lastProgressAt: NOW - 120 * 60000 };
    const v = S.assessLivenessWithTree(frozen, { now: NOW, scan: scanWith(TREE) });
    assert.equal(v.state, 'active', JSON.stringify(v));
    assert.equal(v.treeOverride, true);
  });

  it('记录冻住、树里确实没进程 → 仍是 silent（不许把没进程的树永久免死）', async () => {
    const S = await LOAD;
    const frozen = { id: 's', worktreeId: TREE, driverState: 'running', lastProgressAt: NOW - 120 * 60000 };
    const v = S.assessLivenessWithTree(frozen, { now: NOW, scan: scanWith('/somewhere/else') });
    assert.equal(v.state, 'silent', JSON.stringify(v));
    assert.equal(v.treeOverride, undefined);
  });

  // 「没查成」既不当在跑也不当没在跑——两种都是一种猜。这条跟上面两条同等重要：
  // 扫不动进程的身份（非 root/orca）必须退化成「不改判」，而不是退化成「没在跑」。
  it('进程面没查成 → 不改判，也不谎称在跑', async () => {
    const S = await LOAD;
    const frozen = { id: 's', worktreeId: TREE, driverState: 'running', lastProgressAt: NOW - 120 * 60000 };
    const v = S.assessLivenessWithTree(frozen, { now: NOW, scan: { unscanned: true, error: '/proc 读不动' } });
    assert.equal(v.state, 'silent');
    assert.equal(v.treeOverride, undefined);
    assert.equal(v.treeState, 'unknown');
  });

  it('mirasim 服务不在 = 查成了、结论是 0，不是没查成', async () => {
    const S = await LOAD;
    const r = S.treeProcessState(TREE, { scan: { ok: true, noServer: true, procs: [] } });
    assert.equal(r.state, 'idle', JSON.stringify(r));
  });

  it('进程属于别的树不算这棵树的', async () => {
    const S = await LOAD;
    const r = S.treeProcessState(TREE, { scan: { ok: true, procs: [{ pid: 1, cwd: '/other' }, { pid: 2, cwd: TREE + '/' }] } });
    assert.equal(r.state, 'running', '后缀斜杠要归一化，不然同一棵树被当成两棵');
    assert.deepEqual(r.pids, [2]);
  });

  it('没给进程观测 / 没给树 → unknown，不许当成 idle', async () => {
    const S = await LOAD;
    assert.equal(S.treeProcessState(TREE, {}).state, 'unknown');
    assert.equal(S.treeProcessState('', { scan: scanWith(TREE) }).state, 'unknown');
    assert.equal(S.treeProcessState(TREE, { scan: { ok: false, error: 'x' } }).state, 'unknown');
  });
});
