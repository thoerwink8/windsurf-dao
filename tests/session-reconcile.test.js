// 对账循环（#1056）：期望集 = 未结 job.dispatch，观测 = 会话真实在不在，
// 差集重派。夹具对着 #1043 五处实咬：draft 不是活性、查不成当有人在做、
// 已合并 PR 不重起审官、同一 issue 有活会话拒派。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LIB = 'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'session-reconcile.mjs').replace(/\\/g, '/');
const LOAD = import(LIB);

function dispatch(over = {}) {
  return {
    type: 'job.dispatch',
    job_id: over.job_id || 'dispatch-pi:dead',
    identity: over.identity || '工人',
    issue_number: over.issue_number ?? 1056,
    pr_number: over.pr_number ?? null,
    card_name: over.card_name || 'ISSUE-#1056 对账循环',
    dispatch_id: over.dispatch_id || 'pi:dead',
    ts: over.ts || '2026-09-06T19:00:00+08:00',
    model: over.model || 'grok-4.6',
    terminal: over.terminal || 'mirasim',
    ...over,
  };
}

describe('期望集：只读未结 job.dispatch', () => {
  it('没给数组 → unscanned，不是 0 条', async () => {
    const S = await LOAD;
    const r = S.desiredFromEvents(undefined);
    assert.equal(r.unscanned, true);
    assert.deepEqual(r.items, []);
  });

  it('有 closed 的不算未结', async () => {
    const S = await LOAD;
    const r = S.desiredFromEvents([
      dispatch({ job_id: 'dispatch-a', issue_number: 1 }),
      { type: 'job.closed', job_id: 'dispatch-a' },
      dispatch({ job_id: 'dispatch-b', issue_number: 2 }),
    ]);
    assert.equal(r.unscanned, false);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].issue, 2);
  });

  it('issue 号从卡名 ISSUE-#N 兜底', async () => {
    const S = await LOAD;
    const r = S.desiredFromEvents([
      dispatch({ issue_number: null, card_name: 'ISSUE-#1043 拿代理指标当事实' }),
    ]);
    assert.equal(r.items[0].issue, 1043);
  });

  it('审官 job_id=gh-pr-N-review 认出 PR', async () => {
    const S = await LOAD;
    assert.equal(S.prOfDispatch({ job_id: 'gh-pr-1025-review' }), 1025);
  });
});

describe('观测：活着 = 名单里有且非终态', () => {
  it('completed 不算活执行者（现场 B：干完了不是卡死）', async () => {
    const S = await LOAD;
    const a = S.isLiveSession({ key: 'pi:1', state: 'completed' });
    assert.equal(a.live, false);
    assert.equal(a.unscanned, false);
  });

  it('running 算活着', async () => {
    const S = await LOAD;
    assert.equal(S.isLiveSession({ key: 'pi:1', state: 'running' }).live, true);
  });

  it('没给对象 → unscanned，绝不当活着（方向交给调用方）', async () => {
    const S = await LOAD;
    const a = S.isLiveSession(null);
    assert.equal(a.unscanned, true);
    assert.equal(a.live, false);
  });
});

describe('hasLiveExecutor：查不成当有人在做', () => {
  it('会话名单不是数组 → live=true unscanned（现场 A 的 fail 方向）', async () => {
    const S = await LOAD;
    const r = S.hasLiveExecutor({ sessions: null, issue: 885 });
    assert.equal(r.live, true);
    assert.equal(r.unscanned, true);
  });

  it('观测面未接入（老夹具）→ live=false，不挡既有派工路', async () => {
    const S = await LOAD;
    const r = S.hasLiveExecutor({ issue: 885 });
    assert.equal(r.unavailable, true);
    assert.equal(r.live, false);
  });

  it('cwd 落在 dao-885 且 running → 有活执行者', async () => {
    const S = await LOAD;
    const r = S.hasLiveExecutor({
      sessions: [{ key: 'pi:1', state: 'running', cwd: '/home/orca/mirasim-worktrees/windsurf-dao/dao-885' }],
      issue: 885,
    });
    assert.equal(r.live, true);
    assert.equal(r.unscanned, false);
  });

  it('incomplete 仍算活执行者——推一句继续，不重派（#1007/#1037 抢树）', async () => {
    const S = await LOAD;
    const r = S.hasLiveExecutor({
      sessions: [{ key: 'pi:1', state: 'incomplete', cwd: '/x/dao-885' }],
      issue: 885,
    });
    assert.equal(r.live, true);
    assert.equal(r.unscanned, false);
  });

  it('同 issue 的会话已 completed → 没有活执行者', async () => {
    const S = await LOAD;
    const r = S.hasLiveExecutor({
      sessions: [{ key: 'pi:1', state: 'completed', cwd: '/x/dao-885', title: 'ISSUE-#885' }],
      issue: 885,
    });
    assert.equal(r.live, false);
  });

  it('命中的那条会话没 key → 当有人在做', async () => {
    const S = await LOAD;
    const r = S.hasLiveExecutor({
      sessions: [{ state: 'running', cwd: '/x/dao-885' }],
      issue: 885,
    });
    assert.equal(r.live, true);
    assert.equal(r.unscanned, true);
  });
});

describe('差集：该在却不在 → 重派；查不成零重派', () => {
  const desired = [{
    job_id: 'dispatch-pi:dead', identity: '工人', issue: 885, pr: 885,
    dispatch_id: 'pi:dead', model: 'grok-4.6',
  }];

  it('未结 + 开放单 + 名单里没有 → 重派，幂等键是 issue', async () => {
    const S = await LOAD;
    const r = S.planReconcile({
      desired,
      sessions: [{ key: 'pi:other', state: 'running', cwd: '/x/dao-999' }],
      openIssues: [885],
    });
    assert.equal(r.unscanned, false);
    assert.equal(r.redispatches.length, 1);
    assert.equal(r.redispatches[0].issue, 885);
  });

  it('同一 issue 已有活会话 → 拒绝再派', async () => {
    const S = await LOAD;
    const r = S.planReconcile({
      desired,
      sessions: [{ key: 'pi:1', state: 'running', cwd: '/x/dao-885' }],
      openIssues: [885],
    });
    assert.deepEqual(r.redispatches, []);
  });

  it('会话名单没查成 → 零重派（误杀活工人的代价更高）', async () => {
    const S = await LOAD;
    const r = S.planReconcile({ desired, sessions: null, openIssues: [885] });
    assert.equal(r.unscanned, true);
    assert.deepEqual(r.redispatches, []);
  });

  it('单已关 → 不重派（不是漏救，是完工）', async () => {
    const S = await LOAD;
    const r = S.planReconcile({ desired, sessions: [], openIssues: [] });
    assert.deepEqual(r.redispatches, []);
  });

  it('审官未结不走差集重派（现场 B 归 shouldRestartReviewer）', async () => {
    const S = await LOAD;
    const r = S.planReconcile({
      desired: [{ job_id: 'gh-pr-1025-review', identity: '审官', issue: null, pr: 1025 }],
      sessions: [],
      openIssues: [1],
    });
    assert.deepEqual(r.redispatches, []);
  });

  it('本轮已经要派同一 issue → 不造第二份', async () => {
    const S = await LOAD;
    const r = S.planReconcile({
      desired, sessions: [], openIssues: [885], alreadyQueued: [885],
    });
    assert.deepEqual(r.redispatches, []);
  });
});

describe('审官静默：先问 PR 还开着吗（现场 B）', () => {
  it('标题里的 PR 已不在开放名单 → 不重起（#1025/#1013 已合并）', async () => {
    const S = await LOAD;
    const r = S.shouldRestartReviewer(
      { key: 'codex:1', title: '按审官任务书审 PR #1025', cwd: '/x/dao-review-pr-1025' },
      { openPrs: [1018] },
    );
    assert.equal(r.restart, false);
  });

  it('PR 还开着 → 可以重起', async () => {
    const S = await LOAD;
    const r = S.shouldRestartReviewer(
      { key: 'codex:1', title: '按审官任务书审 PR #1018', cwd: '/x/dao-review-pr-1018' },
      { openPrs: [1018] },
    );
    assert.equal(r.restart, true);
    assert.equal(r.pr, 1018);
  });

  it('开放名单没查成 → 仍可报警（现场 B 的 fail 方向与现场 A 相反）', async () => {
    const S = await LOAD;
    const r = S.shouldRestartReviewer(
      { key: 'codex:1', title: '按审官任务书审 PR #1025' },
      { openPrs: null },
    );
    assert.equal(r.restart, true);
    assert.equal(r.unscanned, true);
  });
});

describe('sessions 帧形状：null / 非数组 = 没查成，不许折成空名单', () => {
  const SESS = import('file://' + path.join(__dirname, '..', 'scripts', 'mirasim-sessions.mjs').replace(/\\/g, '/'));

  it('{type:sessions, sessions:null} → ok:false', async () => {
    const { acceptSessionsFrame } = await SESS;
    const r = acceptSessionsFrame({ type: 'sessions', sessions: null });
    assert.equal(r.ok, false);
    assert.match(r.why, /不是数组/);
  });

  it('{type:sessions, sessions:[]} → ok:true 空名单（查成且空）', async () => {
    const { acceptSessionsFrame } = await SESS;
    const r = acceptSessionsFrame({ type: 'sessions', sessions: [] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.list, []);
  });

  it('其它 type 跳过，不当成 sessions 帧', async () => {
    const { acceptSessionsFrame } = await SESS;
    const r = acceptSessionsFrame({ type: 'state' });
    assert.equal(r.skip, true);
  });
});
