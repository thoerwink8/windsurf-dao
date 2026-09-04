// mirasim 执行体绑定（#880 卡 A）：契约断言、判完工交叉核、五个动词的形状。
//
// 两个判别用例是本套的存在理由（缺了它们，这套测试全绿也说明不了什么）：
//   ①「版本不符 → 拒派」——不光要抛错，还要证明**一帧 prompt 都没发出去**；
//   ②「snapshot 丢失 → 没查成」——不许把取不到状态说成跑完了。
// 连线层用假线注入，不碰真服务：测的是判据，不是那台机器今天在不在。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LIB = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'mirasim-runtime.mjs').replace(/\\/g, '/');

const KEY = 'claude:a8d67849-7fe3-4d03-ae25-312b86952bf9';
const UUID = 'a8d67849-7fe3-4d03-ae25-312b86952bf9';
const T0 = Date.parse('2026-09-04T06:43:00.000Z');

// 服务端连上就推的 state 帧，字段照实测抄
function goodState(over = {}) {
  return {
    version: '0.0.282',
    workdir: '/srv/work',
    home: '/srv',
    platform: 'linux',
    agentsAvailable: ['claude', 'codex', 'pi'],
    ...over,
  };
}

// 假连线：记下发出去的每一帧，按脚本把应答塞进收件箱
function fakeWire(state, script = () => []) {
  const sent = [];
  const inbox = [];
  return {
    state,
    sent,
    closed: false,
    send(obj) {
      sent.push(obj);
      for (const r of script(obj) || []) inbox.push(r);
    },
    async waitFor(pred) {
      const at = inbox.findIndex(pred);
      return at === -1 ? null : inbox.splice(at, 1)[0];
    },
    close() { this.closed = true; },
  };
}

async function runtimeWith(wire, over = {}) {
  const { createRuntime } = await import(LIB);
  return createRuntime({
    homeDir: '/srv',
    connect: async () => wire,
    now: () => T0,
    ...over,
  });
}

const ledgerRow = (over = {}) => ({
  callId: 'c1',
  ts: new Date(T0 + 2_000).toISOString(),
  sessionId: UUID,
  agent: 'claude',
  path: '/v1/messages',
  upstreamHost: 'relay.mirasim.ai',
  viaRelay: true,
  model: 'claude-opus-5',
  status: 200,
  durationMs: 1990,
  ...over,
});

describe('契约断言', () => {
  it('版本不符：抛 MirasimContractError，且一帧 prompt 都没发出去（这才叫拒派）', async () => {
    const wire = fakeWire(goodState({ version: '0.0.283' }), () => [
      { type: 'accepted', sessionKey: KEY, taskId: 't1' },
    ]);
    const rt = await runtimeWith(wire);
    await assert.rejects(
      () => rt.startSession({ agent: 'claude', workdir: '/srv/work', prompt: '只回 PONG' }),
      err => {
        assert.strictEqual(err.name, 'MirasimContractError');
        assert.strictEqual(err.code, 'contract');
        assert.match(err.message, /版本不符/);
        assert.match(err.message, /0\.0\.283/);
        return true;
      },
    );
    // 判别点：拒派 = 没发；只抛错但已经把 prompt 发出去了，额度照烧
    assert.deepStrictEqual(wire.sent.filter(f => f.type === 'prompt'), []);
    assert.strictEqual(wire.sent.length, 0);
    assert.strictEqual(wire.closed, true);
  });

  it('服务端没有这个执行体：同样拒派，不发 prompt', async () => {
    const wire = fakeWire(goodState({ agentsAvailable: ['codex'] }));
    const rt = await runtimeWith(wire);
    await assert.rejects(
      () => rt.startSession({ agent: 'claude', workdir: '/srv/work', prompt: 'x' }),
      /没有 claude 这个执行体/,
    );
    assert.strictEqual(wire.sent.length, 0);
  });

  it('没收到 state 帧算「没查成」，跟版本不符分开报', async () => {
    const { judgeContract } = await import(LIB);
    const v = judgeContract(null, { agent: 'claude' });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.unscanned, true);
    assert.match(v.errors.join(''), /没查成/);

    const wire = fakeWire(null);
    const rt = await runtimeWith(wire);
    await assert.rejects(
      () => rt.startSession({ agent: 'claude', workdir: '/srv/work', prompt: 'x' }),
      err => (assert.strictEqual(err.name, 'MirasimUnavailableError'), true),
    );
    assert.strictEqual(wire.sent.length, 0);
  });

  it('缺关键字段（形状变了）也拒派', async () => {
    const { judgeContract } = await import(LIB);
    const v = judgeContract({ version: '0.0.282', platform: 'linux', agentsAvailable: ['claude'] });
    assert.strictEqual(v.ok, false);
    assert.match(v.errors.join('；'), /state\.workdir 形状不符/);
    assert.match(v.errors.join('；'), /state\.home 形状不符/);
  });

  it('版本一致：放行，prompt 发出去并收回 sessionKey/taskId', async () => {
    const wire = fakeWire(goodState(), f => (f.type === 'prompt'
      ? [{ type: 'accepted', sessionKey: KEY, taskId: 'task-9' }] : []));
    const rt = await runtimeWith(wire);
    const r = await rt.startSession({ agent: 'claude', workdir: '/srv/work', prompt: '只回 PONG', effort: 'low' });
    assert.strictEqual(r.sessionKey, KEY);
    assert.strictEqual(r.taskId, 'task-9');
    assert.strictEqual(r.startedAt, T0);
    const sentPrompt = wire.sent.find(f => f.type === 'prompt');
    assert.strictEqual(sentPrompt.agent, 'claude');
    assert.strictEqual(sentPrompt.workdir, '/srv/work');
    assert.strictEqual(sentPrompt.effort, 'low');
  });

  it('应答帧的 sessionKey 形状不对：判契约不符，不硬着头皮往下走', async () => {
    const wire = fakeWire(goodState(), f => (f.type === 'prompt'
      ? [{ type: 'accepted', sessionKey: 'a8d67849', taskId: '' }] : []));
    const rt = await runtimeWith(wire);
    await assert.rejects(
      () => rt.startSession({ agent: 'claude', workdir: '/srv/work', prompt: 'x' }),
      err => (assert.strictEqual(err.name, 'MirasimContractError'), assert.match(err.message, /sessionKey 形状不符/), true),
    );
  });
});

describe('读会话', () => {
  it('两条读法都空：报「没查成」，不是「跑完了没内容」', async () => {
    const wire = fakeWire(goodState(), () => []); // 快照不回帧、清单也没这条
    const rt = await runtimeWith(wire);
    const view = await rt.readSession(KEY);
    assert.strictEqual(view.missing, true);
    assert.strictEqual(view.phase, null);
    assert.match(view.why, /没查成/);

    const { judgeCompletion } = await import(LIB);
    const verdict = judgeCompletion({ view, snapshotMissing: true, ledger: { readable: true, rows: [ledgerRow()] }, since: T0 });
    assert.strictEqual(verdict.status, 'unknown');
    assert.notStrictEqual(verdict.status, 'done');
    assert.match(verdict.reason, /没查成/);
  });

  it('读的是 subscribe 那条路，回的是 snapshot 帧（真机形状）', async () => {
    const wire = fakeWire(goodState(), f => (f.type === 'subscribe' ? [{
      type: 'snapshot',
      sessionKey: KEY,
      seq: 9,
      snapshot: {
        phase: 'done', text: 'PONG', reasoning: '', toolCalls: [{ id: 1, name: 'Bash', status: 'ok' }],
        interactions: [], error: null, incomplete: false,
      },
    }] : []));
    const rt = await runtimeWith(wire);
    const view = await rt.readSession(KEY);
    assert.strictEqual(view.via, 'snapshot');
    assert.strictEqual(view.missing, false);
    assert.strictEqual(view.phase, 'done');
    assert.strictEqual(view.text, 'PONG');
    assert.deepStrictEqual(view.toolCalls, [{ id: 1, name: 'Bash', status: 'ok' }]);
    assert.strictEqual(view.seq, 9);
    assert.ok(wire.sent.some(f => f.type === 'subscribe'), '要用 subscribe 读，不能用 getSnapshot');
  });

  it('快照读不到就退到会话清单，且标明正文只是预览', async () => {
    const wire = fakeWire(goodState(), f => (f.type === 'listSessions' ? [{
      type: 'sessions',
      sessions: [{ sessionKey: KEY, agent: 'claude', runState: 'completed', preview: 'PONG', numTurns: 1 }],
    }] : []));
    const rt = await runtimeWith(wire);
    const view = await rt.readSession(KEY);
    assert.strictEqual(view.missing, false);
    assert.strictEqual(view.via, 'meta');
    assert.strictEqual(view.phase, 'done', 'runState=completed 要归一成 done');
    assert.strictEqual(view.partial, true);
    assert.match(view.why, /预览/);
  });

  it('只读到清单时，interact 报没查成，不谎称「没有问题」', async () => {
    const wire = fakeWire(goodState(), f => (f.type === 'listSessions' ? [{
      type: 'sessions',
      sessions: [{ sessionKey: KEY, runState: 'running', preview: '' }],
    }] : []));
    const rt = await runtimeWith(wire);
    const r = await rt.interact(KEY, '随便');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.missing, true);
    assert.match(r.why, /没查成/);
  });

  it('两种帧形状都认：订阅回执与流式推送', async () => {
    const { judgeSnapshot } = await import(LIB);
    const a = judgeSnapshot({ type: 'snapshot', sessionKey: KEY, seq: 1, snapshot: { phase: 'done' } }, KEY);
    assert.strictEqual(a.ok, true);
    assert.strictEqual(a.snapshot.phase, 'done');
    const b = judgeSnapshot({ type: 'session', sessionKey: KEY, seq: 2, patch: { full: { phase: 'running' } } }, KEY);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(b.snapshot.phase, 'running');
  });

  it('回来的是别的会话的快照：不认', async () => {
    const { judgeSnapshot } = await import(LIB);
    const v = judgeSnapshot({ type: 'snapshot', sessionKey: 'claude:' + '0'.repeat(8) + '-0000-0000-0000-000000000000', snapshot: {} }, KEY);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.missing, false);
    assert.match(v.errors.join(''), /别的会话/);
  });

  // ── 返工判别（PR #883 审官）：顶层没 sessionKey 的订阅回执必须保住完整 snapshot ──
  it('订阅回执没顶层 sessionKey：按所订阅的会话收，保住完整 snapshot（不退 meta/missing）', async () => {
    const wire = fakeWire(goodState(), f => (f.type === 'subscribe' ? [{
      type: 'snapshot',   // 注意：故意不带顶层 sessionKey，只有内层 snapshot
      seq: 7,
      snapshot: {
        phase: 'done', text: 'PONG', reasoning: '',
        toolCalls: [{ id: 2, name: 'Bash', status: 'ok' }],
        interactions: [], error: null, incomplete: false,
      },
    }] : []));
    const rt = await runtimeWith(wire);
    const view = await rt.readSession(KEY);
    assert.strictEqual(view.via, 'snapshot', '没顶层 sessionKey 也得走 snapshot，不能退 meta');
    assert.strictEqual(view.missing, false);
    assert.strictEqual(view.partial, false, '拿到的是完整 snapshot，不是预览');
    assert.strictEqual(view.phase, 'done');
    assert.strictEqual(view.text, 'PONG');
    assert.deepStrictEqual(view.toolCalls, [{ id: 2, name: 'Bash', status: 'ok' }]);
    assert.strictEqual(view.seq, 7);
    assert.ok(!wire.sent.some(f => f.type === 'listSessions'), '完整 snapshot 已到手，不该再退去查会话清单');
  });

  it('judgeSnapshot：顶层没 sessionKey 按上下文收；内层带的 sessionKey/uuid 若明确不匹配则拒', async () => {
    const { judgeSnapshot } = await import(LIB);
    // 顶层缺 sessionKey → 收
    const ok = judgeSnapshot({ type: 'snapshot', seq: 1, snapshot: { phase: 'done' } }, KEY);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.snapshot.phase, 'done');
    // 内层 sessionKey 明确写了别的会话 → 拒
    const badInnerKey = judgeSnapshot(
      { type: 'snapshot', snapshot: { phase: 'done', sessionKey: 'claude:' + '0'.repeat(8) + '-0000-0000-0000-000000000000' } },
      KEY,
    );
    assert.strictEqual(badInnerKey.ok, false);
    assert.match(badInnerKey.errors.join(''), /内层 sessionKey.*别的会话/);
    // 内层 uuid 明确不匹配 sessionKey 的 uuid 段 → 拒
    const badInnerUuid = judgeSnapshot(
      { type: 'snapshot', snapshot: { phase: 'done', uuid: '00000000-0000-0000-0000-000000000000' } },
      KEY,
    );
    assert.strictEqual(badInnerUuid.ok, false);
    assert.match(badInnerUuid.errors.join(''), /内层 uuid.*别的会话/);
  });

  it('订阅回执顶层写了别的会话：不当成本会话的快照（谓词跳过，退到没查成）', async () => {
    // 顶层 sessionKey 明确是别的会话，且没有会话清单兜底 → readSession 报 missing，绝不拿它当本会话正文
    const other = 'claude:' + '0'.repeat(8) + '-0000-0000-0000-000000000000';
    const wire = fakeWire(goodState(), f => (f.type === 'subscribe' ? [{
      type: 'snapshot', sessionKey: other, seq: 3, snapshot: { phase: 'done', text: '别的会话的正文' },
    }] : []));
    const rt = await runtimeWith(wire);
    const view = await rt.readSession(KEY);
    assert.notStrictEqual(view.via, 'snapshot', '别的会话的帧不能当本会话的 snapshot');
    assert.strictEqual(view.missing, true);
    assert.match(view.why, /没查成/);
  });
});

describe('判完工交叉核', () => {
  it('快照 done + 账本有起针后的成功行 → done', async () => {
    const { judgeCompletion } = await import(LIB);
    const v = judgeCompletion({
      view: { phase: 'done', text: 'PONG', toolCalls: [], error: null },
      ledger: { readable: true, rows: [ledgerRow()] },
      journal: { readable: false, why: '没注入日志读取器' },
      since: T0,
    });
    assert.strictEqual(v.status, 'done');
    assert.deepStrictEqual(v.confirmedBy, ['snapshot', 'ledger']);
    assert.match(v.reason, /journal 未参与/);
  });

  it('快照 done 但账本读不到 → 没查成（交叉核没做成就不算成）', async () => {
    const { judgeCompletion } = await import(LIB);
    const v = judgeCompletion({
      view: { phase: 'done' },
      ledger: { readable: false, rows: [], why: '这个会话还没有账本目录' },
      since: T0,
    });
    assert.strictEqual(v.status, 'unknown');
    assert.match(v.reason, /没查成/);
  });

  it('快照 done 但账本里没有起针后的行 → 两边不一致，判没查成', async () => {
    const { judgeCompletion } = await import(LIB);
    const v = judgeCompletion({
      view: { phase: 'done' },
      ledger: { readable: true, rows: [ledgerRow({ ts: new Date(T0 - 3_600_000).toISOString() })] },
      since: T0,
    });
    assert.strictEqual(v.status, 'unknown');
    assert.match(v.reason, /不一致/);
  });

  it('账本只有非 2xx 行 → 不算成', async () => {
    const { judgeCompletion } = await import(LIB);
    const v = judgeCompletion({
      view: { phase: 'done' },
      ledger: { readable: true, rows: [ledgerRow({ status: 429 })] },
      since: T0,
    });
    assert.strictEqual(v.status, 'unknown');
  });

  it('journal 能读且同窗回合不是 ok → 判没查成，不跟着快照说成', async () => {
    const { judgeCompletion } = await import(LIB);
    const v = judgeCompletion({
      view: { phase: 'done' },
      ledger: { readable: true, rows: [ledgerRow()] },
      journal: { readable: true, turns: [{ agent: 'claude', startedAt: T0 + 100, outcome: 'error' }] },
      since: T0,
    });
    assert.strictEqual(v.status, 'unknown');
    assert.match(v.reason, /journal/);
  });

  it('三方都对上 → done，且写明谁核过', async () => {
    const { judgeCompletion } = await import(LIB);
    const v = judgeCompletion({
      view: { phase: 'done' },
      ledger: { readable: true, rows: [ledgerRow()] },
      journal: { readable: true, turns: [{ agent: 'claude', startedAt: T0 + 100, outcome: 'ok' }] },
      since: T0,
    });
    assert.strictEqual(v.status, 'done');
    assert.deepStrictEqual(v.confirmedBy, ['snapshot', 'ledger', 'journal']);
  });

  it('跑着的、挂了的、没 phase 的各归各的', async () => {
    const { judgeCompletion } = await import(LIB);
    assert.strictEqual(judgeCompletion({ view: { phase: 'running' } }).status, 'running');
    assert.strictEqual(judgeCompletion({ view: { phase: 'error', error: '上游 503' } }).status, 'failed');
    assert.strictEqual(judgeCompletion({ view: { phase: null } }).status, 'unknown');
  });

  it('done 但带 incomplete 标记：算没干完，不算成', async () => {
    const { judgeCompletion } = await import(LIB);
    const v = judgeCompletion({
      view: { phase: 'done', incomplete: true, text: '半截' },
      ledger: { readable: true, rows: [ledgerRow()] },
      since: T0,
    });
    assert.strictEqual(v.status, 'failed');
    assert.match(v.reason, /incomplete/);
  });

  it('会话清单的 runState 归一到 phase 这套词', async () => {
    const { metaView, readSessionView } = await import(LIB);
    assert.strictEqual(metaView({ runState: 'completed', preview: 'PONG' }).phase, 'done');
    assert.strictEqual(metaView({ runState: 'running' }).phase, 'running');
    assert.strictEqual(readSessionView({ runState: 'complete' }).phase, 'done');
    assert.strictEqual(readSessionView({ phase: 'done', incomplete: true }).incomplete, true);
  });
});

describe('账本与日志解析', () => {
  it('按 sessionKey 拼账本目录并读 ndjson', async () => {
    const { readLedger } = await import(LIB);
    const seen = [];
    const r = readLedger({
      sessionKey: KEY,
      homeDir: '/srv',
      io: {
        exists: p => (seen.push(p), true),
        readdir: () => ['index-0.ndjson', 'usage-index-state.json'],
        readFile: () => JSON.stringify(ledgerRow()) + '\n{坏行\n' + JSON.stringify(ledgerRow({ callId: 'c2' })) + '\n',
      },
    });
    assert.strictEqual(r.readable, true);
    assert.strictEqual(r.rows.length, 2);
    assert.strictEqual(r.bad, 1);
    assert.ok(seen[0].includes(UUID), '目录名要用 sessionKey 的 uuid 段');
  });

  it('账本目录不在：readable=false，不返回「0 行」冒充没事', async () => {
    const { readLedger } = await import(LIB);
    const r = readLedger({ sessionKey: KEY, homeDir: '/srv', io: { exists: () => false, readdir: () => [], readFile: () => '' } });
    assert.strictEqual(r.readable, false);
    assert.deepStrictEqual(r.rows, []);
    assert.ok(r.why);
  });

  it('sessionKey 形状不对：拼不出目录就直说', async () => {
    const { readLedger, sessionUuid } = await import(LIB);
    assert.strictEqual(sessionUuid('claude:nope'), null);
    assert.strictEqual(sessionUuid(KEY), UUID);
    assert.strictEqual(readLedger({ sessionKey: 'claude:nope', homeDir: '/srv' }).readable, false);
  });

  it('journal 的回合行照真样本解析', async () => {
    const { parseTurnTiming } = await import(LIB);
    const real = 'Sep 04 14:43:14 vmi3551059 node[767216]: [server 14:43:14] MIRASIM_AGENT_TURN_TIMING '
      + '{"schemaVersion":1,"agent":"claude","startedAt":1788504192143,"mode":"start","transport":"cold",'
      + '"model":"claude-opus-5[1m]","effort":"high","outcome":"ok","attempts":1,'
      + '"stages":{"prepMs":660,"nativeThreadMs":366,"modelWaitMs":1302,"firstOutputMs":1962,"activeMs":713,"totalMs":2676}}';
    const { turns, bad } = parseTurnTiming(real + '\n无关行\n');
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(bad, 0);
    assert.strictEqual(turns[0].outcome, 'ok');
    assert.strictEqual(turns[0].startedAt, 1788504192143);
    assert.strictEqual(turns[0].stages.totalMs, 2676);
  });

  it('没注入日志读取器：如实说没读，不冒充核过', async () => {
    const { readJournal } = await import(LIB);
    const r = readJournal({});
    assert.strictEqual(r.readable, false);
    assert.ok(r.why);
  });
});

describe('问答与工作区', () => {
  it('interact 先从快照翻出 promptId，再按 promptId 发（服务端不认 sessionKey）', async () => {
    const wire = fakeWire(goodState(), f => (f.type === 'subscribe' ? [{
      type: 'snapshot',
      sessionKey: KEY,
      snapshot: {
        phase: 'waiting',
        interactions: [
          { promptId: 'p-old', questions: [{ id: 'q0' }], answeredAt: 123 },
          { promptId: 'p-live', currentIndex: 1, questions: [{ id: 'q1' }, { id: 'q2' }] },
        ],
      },
    }] : []));
    const rt = await runtimeWith(wire);
    const r = await rt.interact(KEY, '选第二个');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.promptId, 'p-live');
    assert.strictEqual(r.questionId, 'q2');
    const sent = wire.sent.find(f => f.type === 'interact');
    assert.deepStrictEqual(sent, { type: 'interact', promptId: 'p-live', action: 'answer', value: '选第二个' });
  });

  it('没有等回答的问题：直说，不乱回一个 promptId', async () => {
    const { pendingInteraction } = await import(LIB);
    assert.strictEqual(pendingInteraction({ interactions: [] }), null);
    assert.strictEqual(pendingInteraction({}), null);
    assert.strictEqual(pendingInteraction({ interactions: [{ promptId: 'p1', answeredAt: 1 }] }), null);
  });

  it('工作区已有这个分支的树：直接给路径，不再建（幂等）', async () => {
    const wire = fakeWire(goodState(), f => (f.type === 'listWorkspaces' ? [{
      type: 'workspaces',
      workspaces: [{ path: '/repo', name: 'repo', worktrees: [{ path: '/trees/feat-x', branch: 'feat-x' }] }],
    }] : []));
    const rt = await runtimeWith(wire);
    const r = await rt.ensureWorkspace('/repo', 'feat-x');
    assert.strictEqual(r.path, '/trees/feat-x');
    assert.strictEqual(r.created, false);
    assert.deepStrictEqual(wire.sent.filter(f => f.type === 'addWorktree'), []);
  });

  it('没有就建，并按 reqId 收应答、再列一次读回自证', async () => {
    let listed = 0;
    const wire = fakeWire(goodState(), f => {
      if (f.type === 'listWorkspaces') {
        listed++;
        return [{
          type: 'workspaces',
          workspaces: [{
            path: '/repo',
            worktrees: listed >= 2 ? [{ path: '/trees/feat-y', branch: 'feat-y' }] : [],
          }],
        }];
      }
      if (f.type === 'addWorktree') {
        return [{ type: 'worktreeAdded', reqId: f.reqId, ok: true, path: '/trees/feat-y', branch: 'feat-y' }];
      }
      return [];
    });
    const rt = await runtimeWith(wire);
    const r = await rt.ensureWorkspace('/repo', 'feat-y');
    assert.strictEqual(r.path, '/trees/feat-y');
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.verified, true);
  });

  it('建好了但清单一直没露面：给 verified=false，不谎称核过', async () => {
    const wire = fakeWire(goodState(), f => {
      if (f.type === 'listWorkspaces') return [{ type: 'workspaces', workspaces: [{ path: '/repo', worktrees: [] }] }];
      if (f.type === 'addWorktree') return [{ type: 'worktreeAdded', reqId: f.reqId, ok: true, path: '/trees/feat-q', branch: 'feat-q' }];
      return [];
    });
    const rt = await runtimeWith(wire, { worktreeVerifyTries: 2, worktreeVerifyDelayMs: 1 });
    const r = await rt.ensureWorkspace('/repo', 'feat-q');
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.verified, false);
  });

  it('worktreeAdded 说 ok 却不给 path：判契约不符', async () => {
    const wire = fakeWire(goodState(), f => {
      if (f.type === 'listWorkspaces') return [{ type: 'workspaces', workspaces: [{ path: '/repo', worktrees: [] }] }];
      if (f.type === 'addWorktree') return [{ type: 'worktreeAdded', reqId: f.reqId, ok: true }];
      return [];
    });
    const rt = await runtimeWith(wire);
    await assert.rejects(() => rt.ensureWorkspace('/repo', 'feat-p'), err => {
      assert.strictEqual(err.name, 'MirasimContractError');
      return true;
    });
  });

  it('建树被拒：抛出来带上服务端给的 code/detail，不当成建好了', async () => {
    const wire = fakeWire(goodState(), f => {
      if (f.type === 'listWorkspaces') return [{ type: 'workspaces', workspaces: [{ path: '/repo', worktrees: [] }] }];
      if (f.type === 'addWorktree') return [{ type: 'worktreeAdded', reqId: f.reqId, ok: false, error: '分支已被别的树占用', code: 'branch-busy' }];
      return [];
    });
    const rt = await runtimeWith(wire);
    await assert.rejects(() => rt.ensureWorkspace('/repo', 'feat-z'), err => {
      assert.strictEqual(err.name, 'MirasimRejectedError');
      assert.strictEqual(err.detail.code, 'branch-busy');
      return true;
    });
  });

  it('addWorktree 没回帧：判没查成，不判没建成', async () => {
    const wire = fakeWire(goodState(), f => (f.type === 'listWorkspaces'
      ? [{ type: 'workspaces', workspaces: [{ path: '/repo', worktrees: [] }] }] : []));
    const rt = await runtimeWith(wire);
    await assert.rejects(() => rt.ensureWorkspace('/repo', 'feat-none'), err => {
      assert.strictEqual(err.name, 'MirasimUnavailableError');
      assert.match(err.message, /没查成/);
      return true;
    });
  });
});
