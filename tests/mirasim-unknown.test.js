// PR #885 审官八条的回归网（7×P1 + 1×P2）。
//
// 七条 P1 里五条是同一种病：「读不到 / 没查成」被编成「已知值」，于是走进判死 / 回收 /
// 报健康 ok。判据只有一处（mirasim-monitor.mjs 的 gapReport / knownTimestamp /
// stallReadGaps），本套按那一处对齐地咬八个点——每条都是审官已复现的反例原样。
//
// 每条测试都要「改坏就翻红」：断言的是 status/gc/exit/state 这些**结论**，
// 不是实现细节，所以把 fail-closed 那行删掉或反过来，这里必定红。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MON = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'mirasim-monitor.mjs').replace(/\\/g, '/');
const CLI = 'file://' + path.resolve(__dirname, '..', 'scripts', 'agent-stall-watch-mirasim.mjs').replace(/\\/g, '/');
const LC = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'land-core.mjs').replace(/\\/g, '/');

const T0 = 1_788_000_000_000;
const MIN = 60_000;
const KEY = 'claude:a8d67849-7fe3-4d03-ae25-312b86952bf9';

/** 一份「跑着、账本可读、快照完整」的干净基线，各条只改要咬的那一格。 */
function liveView(over = {}) {
  return { phase: 'running', text: '在跑', missing: false, partial: false, error: null, ...over };
}
const okLedger = { readable: true, rows: [{}, {}] };

describe('① 账本不可读 → unknown，不进 stall TTL', () => {
  it('账本读不到且正文/时间戳都没变，第二轮也不许判死', async () => {
    const { judgeStall, activitySig } = await import(MON);
    const view = liveView();
    const ledger = { readable: false, rows: [], why: '账本目录读不到' };
    // 上一轮存的就是这个「含没查成占位」的指纹——原实现在这里返回 stalled
    const prev = { sig: activitySig({ ledger, text: '在跑', updatedAt: T0 - 20 * MIN }), sinceTs: T0 - 20 * MIN };
    const r = judgeStall({ view, ledger, updatedAt: T0 - 20 * MIN, prev, now: T0, stallMs: 8 * MIN });
    assert.equal(r.status, 'unknown', r.reason);
    assert.match(r.reason, /账本/);
    assert.match(r.reason, /没查成/);
    assert.equal(r.sinceTs, T0, 'sinceTs 要顶到现在，别把旧窗留给下一轮接着误判');
  });
  it('账本可读时该判死还是判死（fail-closed 不许把功能闷死）', async () => {
    const { judgeStall, activitySig } = await import(MON);
    const prev = { sig: activitySig({ ledger: okLedger, text: '在跑', updatedAt: T0 - 20 * MIN }), sinceTs: T0 - 20 * MIN };
    const r = judgeStall({ view: liveView(), ledger: okLedger, updatedAt: T0 - 20 * MIN, prev, now: T0, stallMs: 8 * MIN });
    assert.equal(r.status, 'stalled', r.reason);
  });
});

describe('② partial 预览不许当完整正文', () => {
  it('partial:true 的快照 → unknown（预览没变证不了正文没变）', async () => {
    const { judgeStall, activitySig } = await import(MON);
    const view = liveView({ partial: true, via: 'meta', text: '预览前若干字…' });
    const prev = { sig: activitySig({ ledger: okLedger, text: '预览前若干字…', updatedAt: T0 - 20 * MIN }), sinceTs: T0 - 20 * MIN };
    const r = judgeStall({ view, ledger: okLedger, updatedAt: T0 - 20 * MIN, prev, now: T0, stallMs: 8 * MIN });
    assert.equal(r.status, 'unknown', r.reason);
    assert.match(r.reason, /预览|partial/);
  });
  it('partial 且报终态也只能 unknown（跟卡 A judgeCompletion 同一条 fail-closed）', async () => {
    const { judgeStall } = await import(MON);
    const r = judgeStall({ view: liveView({ phase: 'completed', partial: true }), ledger: okLedger, updatedAt: T0, prev: null, now: T0, stallMs: 8 * MIN });
    assert.equal(r.status, 'unknown', r.reason);
  });
});

describe('③ ws 连上 ≠ 会话枚举成了；没探成就一棵树都不拆', () => {
  it('reachable:true 但 sessions:null → judgeWorkdirProbe 判没探成、活动集不当空集用', async () => {
    const { judgeWorkdirProbe } = await import(MON);
    const r = judgeWorkdirProbe({ reachable: true, connectError: null, sessions: null, activeWorkdirs: new Set() });
    assert.equal(r.probed, false, r.why);
    assert.match(r.why, /会话清单/);
    assert.equal(r.workdirs.size, 0);
  });
  it('令牌在、ws 却连不上（服务多半卡着）→ 也 blocking', async () => {
    const { judgeWorkdirProbe } = await import(MON);
    const r = judgeWorkdirProbe({ reachable: false, connectError: '连不上回环 ws', sessions: null });
    assert.equal(r.probed, false);
    assert.equal(r.blocking, true, '服务可能在跑并占着树，不敢删');
    assert.equal(r.serverAbsent, false);
  });
  it('连令牌都没有（服务没在跑）→ 不 blocking：没有会话就没有它在用的树', async () => {
    const { judgeWorkdirProbe, SERVER_ABSENT_HINT } = await import(MON);
    const r = judgeWorkdirProbe({ reachable: false, connectError: `${SERVER_ABSENT_HINT}，服务多半没在跑`, sessions: null });
    assert.equal(r.serverAbsent, true);
    assert.equal(r.blocking, false, '本机/CI 没起 mirasim 时 land 还得能清树');
    assert.equal(r.workdirs.size, 0);
  });
  it('SERVER_ABSENT_HINT 是指向卡 A 文案的指针——卡 A 改了文案这条就翻红', async () => {
    const { SERVER_ABSENT_HINT } = await import(MON);
    const { openWire } = await import('file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'mirasim-runtime.mjs').replace(/\\/g, '/'));
    // 这个端口的回环令牌文件必然不存在（服务没在跑 = 令牌文件不在）
    await assert.rejects(
      () => openWire({ port: 65123, openTimeoutMs: 500 }),
      e => {
        assert.ok(e.message.includes(SERVER_ABSENT_HINT), `卡 A 的「服务没在跑」文案变了：${e.message}`);
        return true;
      },
    );
  });
  it('枚举成了才交出活动集', async () => {
    const { judgeWorkdirProbe } = await import(MON);
    const r = judgeWorkdirProbe({ reachable: true, sessions: [{ workdir: '/a', runState: 'running' }], activeWorkdirs: new Set(['/a']) });
    assert.equal(r.probed, true);
    assert.ok(r.workdirs.has('/a'));
  });
  it('land：没探成时「已合并且干净」的树也不拆', async () => {
    const { decideWorktreeRemove } = await import(LC);
    const base = { branch: 'b', merged: true, dirty: false, isMain: false, isCurrent: false, isDefaultBranch: false, orcaManaged: false, mirasimManaged: false, detached: false };
    assert.equal(decideWorktreeRemove({ ...base, mirasimUnprobed: true }).remove, false);
    assert.equal(decideWorktreeRemove({ ...base, mirasimUnprobed: false }).remove, true, '探成了该拆的还得拆');
  });
});

describe('④ GC 的成功证据与失败传播', () => {
  /** 连接已断的假线：send 不抛、waitFor 回 null——原实现在这里报 ok:true。 */
  const deadWire = { closed: true, failure: 'ws 断了', send() {}, async waitFor() { return null; }, close() {} };

  it('连接 closed/failure 时 wireDeleteSession / wireRemoveWorktree 不许报成功', async () => {
    const { wireDeleteSession, wireRemoveWorktree } = await import(MON);
    const d = await wireDeleteSession(deadWire, { sessionKey: 'k' }, 1);
    assert.equal(d.ok, false, JSON.stringify(d));
    assert.match(d.why, /连接断了|没查成/);
    const w = await wireRemoveWorktree(deadWire, { path: '/t' }, 1);
    assert.equal(w.ok, false, JSON.stringify(w));
  });
  it('send 抛了也算没送到', async () => {
    const { wireDeleteSession } = await import(MON);
    const throwWire = { closed: false, failure: null, send() { throw new Error('连接已断，这一帧没发出去'); }, async waitFor() { return null; }, close() {} };
    const d = await wireDeleteSession(throwWire, { sessionKey: 'k' }, 1);
    assert.equal(d.ok, false);
  });

  function gcDeps(over = {}) {
    const sessions = [{ sessionKey: KEY, agent: 'claude', runState: 'completed', updatedAt: T0 - 40 * MIN, workdir: '/w/old', branch: null, open: false }];
    let round = 0;
    return {
      now: () => T0,
      // 第一次是本轮枚举，第二次起是删完的回读
      listSessions: async () => { round += 1; return round === 1 ? sessions : (over.after === undefined ? [] : over.after); },
      readSession: async () => liveView(),
      readLedger: async () => okLedger,
      stopSession: async () => ({ ok: true }),
      deleteSession: async () => over.del || { ok: true, why: null },
      removeWorktree: async () => ({ ok: true }),
      isBranchMerged: () => true,
      branchOfWorktree: () => over.branch ?? null,
      treeExists: () => (over.treeExists === undefined ? false : over.treeExists),
      postComment: () => ({ ok: true }),
      issueOf: () => 880,
    };
  }

  it('deleteSession 明确失败 → actionFailed 且 exit 非零', async () => {
    const { sweepOnce } = await import(CLI);
    const res = await sweepOnce(gcDeps({ del: { ok: false, why: '删会话被拒' } }), { sessions: {} }, { ttlMs: 30 * MIN });
    assert.equal(res.actionFailed, true);
    assert.notEqual(res.exit, 0);
    assert.equal(res.gced[0].ok, false);
  });
  it('删完回读清单里还在 → 没删成，非零', async () => {
    const { sweepOnce } = await import(CLI);
    const res = await sweepOnce(gcDeps({ after: [{ sessionKey: KEY }] }), { sessions: {} }, { ttlMs: 30 * MIN });
    assert.equal(res.gced[0].verified, false);
    assert.notEqual(res.exit, 0);
    assert.ok(res.nextState.sessions[KEY], '没自证成要留状态可重试');
  });
  it('删完回读不回来 → 没查成，非零（不许当删成了）', async () => {
    const { sweepOnce } = await import(CLI);
    const res = await sweepOnce(gcDeps({ after: null }), { sessions: {} }, { ttlMs: 30 * MIN });
    assert.equal(res.gced[0].verified, null);
    assert.notEqual(res.exit, 0);
  });
  it('回读确认不在了才算删成（exit 0）', async () => {
    const { sweepOnce } = await import(CLI);
    const res = await sweepOnce(gcDeps(), { sessions: {} }, { ttlMs: 30 * MIN });
    assert.equal(res.gced[0].verified, true);
    assert.equal(res.exit, 0);
    assert.ok(!res.nextState.sessions[KEY], '自证删成了就不用留状态');
  });
  it('连树删但树还在 / 还在不在没查成 → 都非零', async () => {
    const { sweepOnce } = await import(CLI);
    const stay = await sweepOnce(gcDeps({ branch: 'feature-880x', treeExists: true }), { sessions: {} }, { ttlMs: 30 * MIN });
    assert.equal(stay.gced[0].treeGone, false);
    assert.notEqual(stay.exit, 0);
    const blind = await sweepOnce(gcDeps({ branch: 'feature-880x', treeExists: null }), { sessions: {} }, { ttlMs: 30 * MIN });
    assert.equal(blind.gced[0].treeGone, null);
    assert.notEqual(blind.exit, 0);
  });
});

describe('⑤ relay.available 必须查', () => {
  const relayWith = over => ({ mode: 'cloud', agentRoutes: { claude: 'relay', dsh: 'direct' }, usage: { windows: [{ label: '5h', usedPercent: 1, remainingPercent: 99 }] }, ...over });

  it('available:false → 健康判红、relay 腿探针判红（不许放行）', async () => {
    const { buildMirasimHealth, probeMirasimTarget } = await import(MON);
    const h = buildMirasimHealth({ state: { version: '0.0.282' }, relay: relayWith({ available: false }), pinnedVersion: '0.0.282' });
    assert.equal(h.state, 'red', JSON.stringify(h.notes));
    assert.equal(h.available, false);
    assert.equal(probeMirasimTarget({ agent: 'claude', health: h }).state, 'red');
  });
  it('缺 available 字段 → unknown（没查成，不当绿）', async () => {
    const { buildMirasimHealth, probeMirasimTarget } = await import(MON);
    const h = buildMirasimHealth({ state: { version: '0.0.282' }, relay: relayWith({}), pinnedVersion: '0.0.282' });
    assert.equal(h.state, 'unknown', JSON.stringify(h.notes));
    assert.equal(h.available, null);
    assert.equal(probeMirasimTarget({ agent: 'claude', health: { ...h, state: 'unknown' } }).state, 'unknown');
  });
  it('available:true 且全齐 → ok；不走 relay 的腿不受影响', async () => {
    const { buildMirasimHealth, probeMirasimTarget } = await import(MON);
    const h = buildMirasimHealth({ state: { version: '0.0.282' }, relay: relayWith({ available: true }), pinnedVersion: '0.0.282' });
    assert.equal(h.state, 'ok', JSON.stringify(h.notes));
    assert.equal(probeMirasimTarget({ agent: 'claude', health: h }).state, 'ok');
    const direct = buildMirasimHealth({ state: { version: '0.0.282' }, relay: relayWith({ available: false }), pinnedVersion: '0.0.282' });
    assert.equal(direct.state, 'red', 'available:false 时整段仍是红——dsh 走 direct 不代表 relay 可用');
  });
  it('额度落盘也记 available（#881 读那份别自己猜）', async () => {
    const { usageRecord } = await import(MON);
    assert.equal(usageRecord({ relay: relayWith({ available: false }), now: T0 }).available, false);
    const miss = usageRecord({ relay: relayWith({}), now: T0 });
    assert.equal(miss.available, null);
    assert.ok(miss.notes.some(n => /available/.test(n)));
  });
});

describe('⑥ TTL 闸不许把 null/空值当时间 0', () => {
  it('updatedAt 是 null / 空串 / 非法串 / NaN → 一律不回收', async () => {
    const { judgeGcSession } = await import(MON);
    for (const bad of [null, undefined, '', '   ', 'not-a-time', NaN, {}, []]) {
      const r = judgeGcSession({ meta: { runState: 'completed', updatedAt: bad, open: false }, now: T0, ttlMs: 30 * MIN });
      assert.equal(r.gc, false, `updatedAt=${JSON.stringify(bad)} 竟然回收了：${r.reason}`);
      assert.match(r.reason, /没查成/);
    }
  });
  it('knownTimestamp：只认有限数值 / 数字串 / 可解析时间串', async () => {
    const { knownTimestamp } = await import(MON);
    assert.equal(knownTimestamp(T0), T0);
    assert.equal(knownTimestamp(String(T0)), T0);
    assert.equal(knownTimestamp('2026-09-04T00:00:00Z'), Date.parse('2026-09-04T00:00:00Z'));
    for (const bad of [null, undefined, '', 'x', NaN, Infinity, {}, []]) assert.equal(knownTimestamp(bad), null, `${JSON.stringify(bad)} 不该当成时间`);
  });
  it('open 不是布尔（读不到）→ 不回收', async () => {
    const { judgeGcSession } = await import(MON);
    const r = judgeGcSession({ meta: { runState: 'completed', updatedAt: T0 - 99 * MIN }, now: T0, ttlMs: 30 * MIN });
    assert.equal(r.gc, false);
    assert.match(r.reason, /没查成/);
  });
  it('三格都读到且过 TTL → 照旧回收（别把功能闷死）', async () => {
    const { judgeGcSession } = await import(MON);
    assert.equal(judgeGcSession({ meta: { runState: 'completed', updatedAt: T0 - 40 * MIN, open: false }, now: T0, ttlMs: 30 * MIN }).gc, true);
  });
});

describe('⑦ 树 GC 在真机 branch:null 的会话上真能触发，且不误删', () => {
  function treeDeps(branchLookup) {
    const sessions = [{ sessionKey: KEY, agent: 'claude', runState: 'completed', updatedAt: T0 - 40 * MIN, workdir: '/w/merged-tree', branch: null, open: false }];
    const calls = [];
    let round = 0;
    return {
      calls,
      now: () => T0,
      listSessions: async () => { round += 1; return round === 1 ? sessions : []; },
      readSession: async () => liveView({ phase: 'done' }),
      readLedger: async () => okLedger,
      stopSession: async () => ({ ok: true }),
      deleteSession: async (k, o) => { calls.push(o); return { ok: true }; },
      removeWorktree: async () => ({ ok: true }),
      isBranchMerged: () => true,
      branchOfWorktree: () => branchLookup,
      treeExists: () => false,
      postComment: () => ({ ok: true }),
      issueOf: () => 880,
    };
  }

  it('会话 branch:null，但从 workdir 反查到已合并分支 → 连树回收（原实现永远 false）', async () => {
    const { sweepOnce } = await import(CLI);
    const deps = treeDeps('feature-880x');
    const res = await sweepOnce(deps, { sessions: {} }, { ttlMs: 30 * MIN });
    assert.equal(res.gced[0].removeTree, true, res.gced[0].treeReason);
    assert.equal(res.gced[0].treeBranch, 'feature-880x');
    assert.deepEqual(deps.calls, [{ removeWorktree: true }]);
  });
  it('反查到默认分支 master → 拒（--merged master 永远算已合并，删了就是误删）', async () => {
    const { sweepOnce } = await import(CLI);
    const res = await sweepOnce(treeDeps('master'), { sessions: {} }, { ttlMs: 30 * MIN });
    assert.equal(res.gced[0].removeTree, false);
    assert.match(res.gced[0].treeReason, /默认分支/);
  });
  it('反查不成（游离 HEAD / 不是 git 树）→ 拒', async () => {
    const { sweepOnce } = await import(CLI);
    const res = await sweepOnce(treeDeps(null), { sessions: {} }, { ttlMs: 30 * MIN });
    assert.equal(res.gced[0].removeTree, false);
    assert.match(res.gced[0].treeReason, /没查成/);
  });
  it('树在保护名单里（本仓根/主树）→ 拒', async () => {
    const { sweepOnce } = await import(CLI);
    const res = await sweepOnce(treeDeps('feature-880x'), { sessions: {} }, { ttlMs: 30 * MIN, protectPaths: ['/w/merged-tree'] });
    assert.equal(res.gced[0].removeTree, false);
    assert.match(res.gced[0].treeReason, /保护名单/);
  });
  it('judgeGcWorktree 的保护名单比路径写法（斜杠/大小写/尾斜杠）', async () => {
    const { judgeGcWorktree } = await import(MON);
    const r = judgeGcWorktree({ path: 'D:/frank/windsurf-dao', branch: 'b', merged: true, protectedPaths: ['D:\\frank\\WINDSURF-DAO\\'] });
    assert.equal(r.gc, false, r.reason);
  });
});

describe('⑧ 单个会话读失败要升级成「没查成」', () => {
  function oneSession(readSession, readLedger) {
    const calls = { stop: [], comment: [] };
    const sessions = [{ sessionKey: KEY, agent: 'claude', runState: 'running', updatedAt: T0, workdir: '/w/x', branch: 'b-880d', open: true }];
    return {
      calls,
      now: () => T0,
      listSessions: async () => sessions,
      readSession,
      readLedger,
      stopSession: async k => { calls.stop.push(k); return { ok: true }; },
      deleteSession: async () => ({ ok: true }),
      removeWorktree: async () => ({ ok: true }),
      isBranchMerged: () => null,
      branchOfWorktree: () => null,
      treeExists: () => false,
      postComment: a => { calls.comment.push(a); return { ok: true }; },
      issueOf: () => 880,
    };
  }

  it('readSession 报 missing → unscanned、exit 2、不 stop、不计入「在跑」', async () => {
    const { sweepOnce } = await import(CLI);
    const deps = oneSession(async () => ({ phase: null, text: '', missing: true, why: '快照和会话清单都没读到' }), async () => ({ readable: false, rows: [] }));
    const res = await sweepOnce(deps, { sessions: {} }, { stallMs: 8 * MIN });
    assert.equal(res.unscanned, true);
    assert.equal(res.exit, 2);
    assert.equal(res.unknown.length, 1);
    assert.equal(deps.calls.stop.length, 0);
    assert.equal(res.live.length, 0, 'unknown 不许混进健康的「在跑」');
  });
  it('账本单独读不到也算没查成（会话读到了也不放行）', async () => {
    const { sweepOnce } = await import(CLI);
    const deps = oneSession(async () => liveView(), async () => ({ readable: false, rows: [], why: '账本目录读不到' }));
    const res = await sweepOnce(deps, { sessions: {} }, { stallMs: 8 * MIN });
    assert.equal(res.exit, 2);
    assert.equal(res.live.length, 0);
    assert.equal(deps.calls.comment.length, 0, '读链路 unknown 时连报帅都不许发——view.error 也不可信');
  });
  it('读链路齐了才允许 exit 0 并算「在跑」', async () => {
    const { sweepOnce } = await import(CLI);
    const deps = oneSession(async () => liveView(), async () => okLedger);
    const res = await sweepOnce(deps, { sessions: {} }, { stallMs: 8 * MIN });
    assert.equal(res.exit, 0);
    assert.equal(res.unscanned, false);
    assert.equal(res.live.length, 1);
  });
});

describe('真机词表（server.cjs 实证 runState = ok ? completed : incomplete）', () => {
  it('incomplete 是终态失败，不是卡死候选（真机 65 条里 30 条）', async () => {
    const { judgeStall, isTerminalPhase, activitySig } = await import(MON);
    assert.equal(isTerminalPhase('incomplete'), true);
    const prev = { sig: activitySig({ ledger: okLedger, text: '在跑', updatedAt: T0 }), sinceTs: T0 - 99 * MIN };
    const r = judgeStall({ view: liveView({ phase: 'incomplete' }), ledger: okLedger, updatedAt: T0, prev, now: T0, stallMs: 8 * MIN });
    assert.equal(r.status, 'terminal', r.reason);
  });
  it('queued 还没开跑，天然没活性，不许判死', async () => {
    const { judgeStall, activitySig } = await import(MON);
    const ledger = { readable: true, rows: [] };
    const prev = { sig: activitySig({ ledger, text: '', updatedAt: T0 }), sinceTs: T0 - 99 * MIN };
    const r = judgeStall({ view: liveView({ phase: 'queued', text: '' }), ledger, updatedAt: T0, prev, now: T0, stallMs: 8 * MIN });
    assert.equal(r.status, 'pending', r.reason);
  });
});

describe('gapReport —— 「没查成」怎么传播的唯一出处', () => {
  it('任一格 known!==true 就整条 unknown，且说得出哪一格', async () => {
    const { gapReport } = await import(MON);
    const ok = gapReport([{ name: 'a', known: true }, { name: 'b', known: true }]);
    assert.equal(ok.ok, true);
    assert.equal(ok.gaps.length, 0);
    const bad = gapReport([{ name: 'a', known: true }, { name: '账本', known: false, why: '读不到' }]);
    assert.equal(bad.ok, false);
    assert.equal(bad.gaps.length, 1);
    assert.match(bad.why, /账本：读不到/);
  });
  it('known 只认严格 true——undefined / 0 / 空串都是没查成', async () => {
    const { gapReport } = await import(MON);
    for (const v of [undefined, null, 0, '', 'true', 1]) {
      assert.equal(gapReport([{ name: 'x', known: v }]).ok, false, `known=${JSON.stringify(v)} 不该算查成`);
    }
  });
});
