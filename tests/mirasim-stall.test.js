// mirasim 保活与回收（#880 卡 D）：卡死判据、会话/树 GC、健康段、共用采集、sweepOnce。
//
// 任务钉死的四条判别用例是本套的存在理由：
//   ① 跑着且账本不涨 → 卡死；② 跑着且账本在涨 → 活；
//   ③ done 超 TTL → 回收；④ 读不到 → 没查成不判死。
// 全部用假 runtime + 假账本，不碰真服务：测的是判据不是那台机今天在不在。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MON = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'mirasim-monitor.mjs').replace(/\\/g, '/');
const CLI = 'file://' + path.resolve(__dirname, '..', 'scripts', 'agent-stall-watch-mirasim.mjs').replace(/\\/g, '/');

const KEY = 'claude:a8d67849-7fe3-4d03-ae25-312b86952bf9';
const T0 = 1_788_000_000_000;
const MIN = 60_000;

describe('judgeStall —— 卡死判据', () => {
  it('① 跑着且账本不涨、正文没变超阈值 → 卡死', async () => {
    const { judgeStall, activitySig } = await import(MON);
    const view = { phase: 'running', text: '在跑', missing: false };
    const ledger = { readable: true, rows: [{}, {}, {}] };
    const sig = activitySig({ ledger, text: '在跑', updatedAt: T0 - 20 * MIN });
    const prev = { sig, sinceTs: T0 - 10 * MIN };
    const r = judgeStall({ view, ledger, updatedAt: T0 - 20 * MIN, prev, now: T0, stallMs: 8 * MIN });
    assert.equal(r.status, 'stalled', r.reason);
  });

  it('② 跑着但账本在涨 → 活（活性指纹变了，sinceTs 顶到现在）', async () => {
    const { judgeStall, activitySig } = await import(MON);
    const view = { phase: 'running', text: '在跑', missing: false };
    const prevLedger = { readable: true, rows: [{}, {}] };
    const prev = { sig: activitySig({ ledger: prevLedger, text: '在跑', updatedAt: T0 - 20 * MIN }), sinceTs: T0 - 10 * MIN };
    const nowLedger = { readable: true, rows: [{}, {}, {}, {}] }; // 涨了两行
    const r = judgeStall({ view, ledger: nowLedger, updatedAt: T0 - 5 * MIN, prev, now: T0, stallMs: 8 * MIN });
    assert.equal(r.status, 'live', r.reason);
    assert.equal(r.sinceTs, T0);
  });

  it('④ 读不到会话 → 没查成，绝不判死', async () => {
    const { judgeStall } = await import(MON);
    const r = judgeStall({ view: { missing: true, why: '快照和清单都没读到' }, ledger: { readable: false, rows: [] }, updatedAt: 0, prev: { sig: 'x', sinceTs: T0 - 99 * MIN }, now: T0, stallMs: 8 * MIN });
    assert.equal(r.status, 'unknown');
    assert.match(r.reason, /没读到|没查成/);
  });

  it('还在宽限窗内（静默没到阈值）→ 活，不误杀', async () => {
    const { judgeStall, activitySig } = await import(MON);
    const view = { phase: 'running', text: 't', missing: false };
    const ledger = { readable: true, rows: [{}] };
    const sig = activitySig({ ledger, text: 't', updatedAt: T0 });
    const r = judgeStall({ view, ledger, updatedAt: T0, prev: { sig, sinceTs: T0 - 3 * MIN }, now: T0, stallMs: 8 * MIN });
    assert.equal(r.status, 'live');
  });

  it('终态 phase 不是卡死候选', async () => {
    const { judgeStall } = await import(MON);
    const r = judgeStall({ view: { phase: 'done', text: 'PONG', missing: false }, ledger: { readable: true, rows: [{}] }, updatedAt: T0, prev: null, now: T0, stallMs: 8 * MIN });
    assert.equal(r.status, 'terminal');
  });
});

describe('judgeGcSession —— 会话回收', () => {
  it('③ done 且过 TTL、不 open → 回收', async () => {
    const { judgeGcSession } = await import(MON);
    const meta = { runState: 'completed', updatedAt: T0 - 40 * MIN, open: false };
    const r = judgeGcSession({ meta, now: T0, ttlMs: 30 * MIN });
    assert.equal(r.gc, true, r.reason);
  });
  it('done 但没过 TTL → 不回收', async () => {
    const { judgeGcSession } = await import(MON);
    const r = judgeGcSession({ meta: { runState: 'completed', updatedAt: T0 - 5 * MIN, open: false }, now: T0, ttlMs: 30 * MIN });
    assert.equal(r.gc, false);
  });
  it('还在跑 → 不回收', async () => {
    const { judgeGcSession } = await import(MON);
    const r = judgeGcSession({ meta: { runState: 'running', updatedAt: T0 - 99 * MIN, open: false }, now: T0, ttlMs: 30 * MIN });
    assert.equal(r.gc, false);
  });
  it('open 着 → 不回收', async () => {
    const { judgeGcSession } = await import(MON);
    const r = judgeGcSession({ meta: { runState: 'error', updatedAt: T0 - 99 * MIN, open: true }, now: T0, ttlMs: 30 * MIN });
    assert.equal(r.gc, false);
  });
  it('updatedAt 读不到 → 没查成不回收', async () => {
    const { judgeGcSession } = await import(MON);
    const r = judgeGcSession({ meta: { runState: 'completed', open: false }, now: T0, ttlMs: 30 * MIN });
    assert.equal(r.gc, false);
    assert.match(r.reason, /没查成|算不出/);
  });
});

describe('judgeGcWorktree —— 树回收', () => {
  it('分支已合并 → 回收', async () => {
    const { judgeGcWorktree } = await import(MON);
    assert.equal(judgeGcWorktree({ path: '/t', branch: 'b', merged: true }).gc, true);
  });
  it('未合并 → 不回收', async () => {
    const { judgeGcWorktree } = await import(MON);
    assert.equal(judgeGcWorktree({ path: '/t', branch: 'b', merged: false }).gc, false);
  });
  it('合没合并没查成（merged=null）→ 不回收', async () => {
    const { judgeGcWorktree } = await import(MON);
    const r = judgeGcWorktree({ path: '/t', branch: 'b', merged: null });
    assert.equal(r.gc, false);
    assert.match(r.reason, /没查成/);
  });
});

describe('buildMirasimHealth —— 健康段读真机', () => {
  const relay = {
    mode: 'cloud',
    agentRoutes: { claude: 'relay', codex: 'relay', kimi: 'relay', dsh: 'direct' },
    usage: { windows: [{ label: '5h', usedPercent: 4.6, remainingPercent: 95.4, status: 'allowed' }] },
  };
  it('版本对 + relay 全齐 → ok', async () => {
    const { buildMirasimHealth } = await import(MON);
    const h = buildMirasimHealth({ state: { version: '0.0.282' }, relay });
    assert.equal(h.state, 'ok', JSON.stringify(h.notes));
    assert.equal(h.mode, 'cloud');
    assert.equal(h.windows[0].usedPercent, 4.6);
    assert.equal(h.agentRoutes.claude, 'relay');
  });
  it('版本不符 → 真红', async () => {
    const { buildMirasimHealth } = await import(MON);
    const h = buildMirasimHealth({ state: { version: '0.0.999' }, relay, pinnedVersion: '0.0.282' });
    assert.equal(h.state, 'red');
  });
  it('连不上 → 红（服务多半没在跑）', async () => {
    const { buildMirasimHealth } = await import(MON);
    const h = buildMirasimHealth({ connectError: '连不上回环 ws' });
    assert.equal(h.state, 'red');
    assert.match(h.notes[0], /连不上|没在跑/);
  });
  it('没 relay 帧 → unknown（没查成，不当绿）', async () => {
    const { buildMirasimHealth } = await import(MON);
    const h = buildMirasimHealth({ state: { version: '0.0.282' }, relay: null });
    assert.equal(h.state, 'unknown');
  });
});

describe('activeWorkdirs / usageRecord / probeMirasimTarget', () => {
  it('活动树集合：跑着或 open 的会话 workdir 才算在用', async () => {
    const { activeWorkdirs } = await import(MON);
    const set = activeWorkdirs([
      { workdir: '/a', runState: 'running', open: false },
      { workdir: '/b', runState: 'completed', open: false },
      { workdir: '/c', runState: 'completed', open: true },
    ]);
    assert.ok(set.has('/a'));
    assert.ok(!set.has('/b'));
    assert.ok(set.has('/c'));
  });
  it('usageRecord：读到窗 → readable，读不到 → 标没查成', async () => {
    const { usageRecord } = await import(MON);
    const ok = usageRecord({ relay: { mode: 'cloud', agentRoutes: {}, usage: { windows: [{ label: '5h', usedPercent: 4.6 }] } }, host: 'h', port: 4316, now: T0 });
    assert.equal(ok.readable, true);
    assert.equal(ok.windows[0].usedPercent, 4.6);
    const miss = usageRecord({ relay: null, now: T0 });
    assert.equal(miss.readable, false);
    assert.match(miss.notes[0], /没查成/);
  });
  it('probeMirasimTarget：claude→relay 且窗读到 → ok；健康没采到 → 没查成', async () => {
    const { probeMirasimTarget, buildMirasimHealth } = await import(MON);
    const health = buildMirasimHealth({ state: { version: '0.0.282' }, relay: { mode: 'cloud', agentRoutes: { claude: 'relay' }, usage: { windows: [{ label: '5h', usedPercent: 1 }] } } });
    const t = probeMirasimTarget({ agent: 'claude', health });
    assert.equal(t.target, 'mirasim:claude');
    assert.equal(t.state, 'ok');
    const u = probeMirasimTarget({ agent: 'claude', health: { probed: false } });
    assert.equal(u.state, 'unknown');
  });
});

describe('sweepOnce —— 一遍扫：卡死停+评论、终态回收', () => {
  function fakeDeps(over = {}) {
    const calls = { stop: [], del: [], comment: [], removeTree: [] };
    const sessions = over.sessions || [
      { sessionKey: KEY, agent: 'claude', title: '卡死的', runState: 'running', updatedAt: T0 - 30 * MIN, workdir: '/w/880d', branch: 'mirasim-keepalive-880d', open: true },
      { sessionKey: 'claude:bbbbbbbb-7fe3-4d03-ae25-312b86952bf9', agent: 'claude', title: '老完工的', runState: 'completed', updatedAt: T0 - 40 * MIN, workdir: '/w/old', branch: 'done-880x', open: false },
    ];
    return {
      calls,
      now: () => T0,
      listSessions: async () => sessions,
      readSession: async () => ({ phase: 'running', text: '一直卡在工具调用', missing: false, error: null }),
      readLedger: async () => ({ readable: true, rows: [{}, {}] }),
      stopSession: async k => { calls.stop.push(k); return { ok: true, why: null }; },
      deleteSession: async (k, o) => { calls.del.push({ k, o }); return { ok: true, why: null }; },
      removeWorktree: async p => { calls.removeTree.push(p); return { ok: true }; },
      isBranchMerged: b => b === 'done-880x',
      postComment: ({ issue, body }) => { calls.comment.push({ issue, body }); return { ok: true }; },
      issueOf: s => (String(s.branch).match(/-(\d+)[a-z]?$/) || [])[1] && Number((String(s.branch).match(/-(\d+)[a-z]?$/) || [])[1]),
      ...over.deps,
    };
  }

  it('卡死会话：账本不涨两轮 → stop + 评论；老完工：deleteSession 回收', async () => {
    const { sweepOnce } = await import(CLI);
    const deps = fakeDeps();
    const sig1 = (await import(MON)).activitySig({ ledger: { readable: true, rows: [{}, {}] }, text: '一直卡在工具调用', updatedAt: T0 - 30 * MIN });
    const prev = { sessions: { [KEY]: { sig: sig1, sinceTs: T0 - 20 * MIN, errFp: null } } };
    const res = await sweepOnce(deps, prev, { stallMs: 8 * MIN, ttlMs: 30 * MIN });
    assert.equal(res.stalled.length, 1, JSON.stringify(res.stalled));
    assert.deepEqual(deps.calls.stop, [KEY]);
    assert.equal(deps.calls.comment.length, 1);
    assert.equal(deps.calls.comment[0].issue, 880);
    assert.equal(res.gced.length, 1);
    assert.equal(deps.calls.del.length, 1);
  });

  it('枚举失败 → 没查成 exit 2，不误动', async () => {
    const { sweepOnce } = await import(CLI);
    const deps = fakeDeps({ deps: { listSessions: async () => null } });
    const res = await sweepOnce(deps, { sessions: {} }, {});
    assert.equal(res.exit, 2);
    assert.equal(res.unscanned, true);
    assert.equal(deps.calls.stop.length, 0);
  });

  it('dry-run：判出卡死但不真停不真删', async () => {
    const { sweepOnce } = await import(CLI);
    const { activitySig } = await import(MON);
    const deps = fakeDeps();
    const sig1 = activitySig({ ledger: { readable: true, rows: [{}, {}] }, text: '一直卡在工具调用', updatedAt: T0 - 30 * MIN });
    const prev = { sessions: { [KEY]: { sig: sig1, sinceTs: T0 - 20 * MIN } } };
    const res = await sweepOnce(deps, prev, { dryRun: true, stallMs: 8 * MIN, ttlMs: 30 * MIN });
    assert.equal(res.stalled.length, 1);
    assert.equal(deps.calls.stop.length, 0);
    assert.equal(deps.calls.del.length, 0);
  });
});

describe('land-core decideWorktreeRemove —— mirasim 在用树保护', () => {
  it('mirasimManaged → 不删（哪怕已合并且干净）', async () => {
    const LC = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'land-core.mjs').replace(/\\/g, '/');
    const { decideWorktreeRemove } = await import(LC);
    const r = decideWorktreeRemove({ branch: 'b', merged: true, dirty: false, isMain: false, isCurrent: false, isDefaultBranch: false, orcaManaged: false, mirasimManaged: true, detached: false });
    assert.equal(r.remove, false);
    assert.match(r.reason, /mirasim/);
  });
});
