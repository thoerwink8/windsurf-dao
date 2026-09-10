// mirasim 执行体绑定（#880 卡 A）：契约断言、判完工交叉核、五个动词的形状。
//
// 两个判别用例是本套的存在理由（缺了它们，这套测试全绿也说明不了什么）：
//   ①「版本不符 → 拒派」——不光要抛错，还要证明**一帧 prompt 都没发出去**；
//   ②「snapshot 丢失 → 没查成」——不许把取不到状态说成跑完了。
// 连线层用假线注入，不碰真服务：测的是判据，不是那台机器今天在不在。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const LIB = 'file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'mirasim-runtime.mjs').replace(/\\/g, '/');

// 夹具要一个「服务端报得出的合法版本号」。
// 2026-09-10 起钉版本改成跟随在役版本（读 bundle 的 VERSION），不再有手打常量可抄——
// 所以这里也从真源读：本机在役版本，读不到就退一个形状合法的假值。
// 写死具体版本号会在每次升级后把「版本一致」的用例判成不符（0.0.307 那次 8 条一起红）。
const PINNED_VERSION = (() => {
  try {
    const { installedVersion } = require(path.resolve(__dirname, '..', 'scripts', 'lib', 'mirasim-runtime.mjs'));
    return installedVersion(require('node:os').homedir()) || '0.0.0';
  } catch { return '0.0.0'; }
})();

const KEY = 'claude:a8d67849-7fe3-4d03-ae25-312b86952bf9';
const UUID = 'a8d67849-7fe3-4d03-ae25-312b86952bf9';
const T0 = Date.parse('2026-09-04T06:43:00.000Z');

// 服务端连上就推的 state 帧，字段照实测抄
function goodState(over = {}) {
  return {
    version: PINNED_VERSION,  // 跟随库内常量：写死会在每次升级后把「版本一致」的用例判成不符
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
    // 真实连线里 closed 反映的是「对端/链路断了」（ws onclose），我们自己收尾的 close()
    // 发生在所有判定之后；假线的 close() 只记账不置 closed，closed 由用例显式模拟断线时置。
    close() { this.hungUp = true; },
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
  // 2026-09-10 改：钉版本默认改成「跟随本机在役版本」，不再比对具体值（那次因为手打常量
  // 没跟上升级，96 条派工被拒）。所以「版本不符就拒派」这个能力现在需要**显式钉住**才触发——
  // 这条测试跟着显式给 pinnedVersion，判别力（拒派=一帧都不发）原样保留。
  it('显式钉住版本时：不符就抛 MirasimContractError，且一帧 prompt 都没发出去（这才叫拒派）', async () => {
    const wire = fakeWire(goodState({ version: '0.0.283' }), () => [
      { type: 'accepted', sessionKey: KEY, taskId: 't1' },
    ]);
    const rt = await runtimeWith(wire, { pinnedVersion: '0.0.307' });
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
    assert.strictEqual(wire.hungUp, true, '拒派后要主动挂断（hungUp 是假线 close() 的记账，见 fakeWire 注释）');
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
    const v = judgeContract({ version: PINNED_VERSION, platform: 'linux', agentsAvailable: ['claude'] });
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

  it('partial（会话清单预览）报 completed + 账本有成功行 → 仍不得 done（fail-closed）', async () => {
    const { judgeCompletion } = await import(LIB);
    const v = judgeCompletion({
      view: { phase: 'done', text: '只是预览…', toolCalls: [], error: null, partial: true },
      ledger: { readable: true, rows: [ledgerRow()] },
      since: T0,
    });
    assert.strictEqual(v.status, 'unknown');
    assert.match(v.reason, /partial|预览/);
  });

  it('partial 报 error 也不得判 failed——预览的终态一律没查成；running 放行', async () => {
    const { judgeCompletion } = await import(LIB);
    const bad = judgeCompletion({
      view: { phase: 'error', error: 'x', partial: true },
      ledger: { readable: true, rows: [ledgerRow()] },
      since: T0,
    });
    assert.strictEqual(bad.status, 'unknown');
    const run = judgeCompletion({
      view: { phase: 'running', partial: true },
      ledger: { readable: true, rows: [] },
      since: T0,
    });
    assert.strictEqual(run.status, 'running');
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

  // #1121：被杀死的会话 phase 照样是 done，死因只写进 error。两条死因串是 2026-09-07
  // 从真会话上抄下来的原文，不是编的——工人 3 次、审官 8 次，全天 11 次判成「完工」。
  const STALL_ERR = 'pi turn stalled past 30 minutes';
  const CAPACITY_ERR = 'Selected model is at capacity. Please try a different model.';

  for (const [name, err] of [['回合看门狗掐死工人', STALL_ERR], ['审官撞上游满载', CAPACITY_ERR]]) {
    it(`#1121 ${name}：phase=done 但带死因 → failed（账本有成功行也不许判 done）`, async () => {
      const { judgeCompletion } = await import(LIB);
      const v = judgeCompletion({
        // 账本里**有**起针后的成功行：会话被杀前已经打了几十个工具调用，
        // 交叉核拦不住这一类——所以判据必须落在 error 上。
        view: { phase: 'done', text: '读了一堆，什么也没写', toolCalls: [], error: err },
        ledger: { readable: true, rows: [ledgerRow()] },
        since: T0,
      });
      assert.strictEqual(v.status, 'failed');
      assert.notStrictEqual(v.status, 'done');
      assert.strictEqual(v.error, err, '死因原文不许被吞掉');
      assert.equal(v.reason.includes(err), true);
    });
  }

  it('#1121 反证：phase=done 且 error 为空 → 照旧走交叉核判 done（这条不是恒红）', async () => {
    const { judgeCompletion } = await import(LIB);
    for (const empty of [null, undefined, '', '   ']) {
      const v = judgeCompletion({
        view: { phase: 'done', text: 'PONG', toolCalls: [], error: empty },
        ledger: { readable: true, rows: [ledgerRow()] },
        since: T0,
      });
      assert.strictEqual(v.status, 'done', `error=${JSON.stringify(empty)} 时应判 done`);
    }
  });

  it('#1121 非终态不受影响：phase=running 带 error 仍判 running（不提前结算）', async () => {
    const { judgeCompletion } = await import(LIB);
    const v = judgeCompletion({
      view: { phase: 'running', error: CAPACITY_ERR },
      ledger: { readable: true, rows: [] },
      since: T0,
    });
    assert.strictEqual(v.status, 'running');
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

  it('interact：发送后连接断了且无 error 回执 → 不许报成功（送没送到没查成）', async () => {
    const wire = fakeWire(goodState(), f => (f.type === 'subscribe' ? [{
      type: 'snapshot',
      sessionKey: KEY,
      snapshot: { phase: 'waiting', interactions: [{ promptId: 'p1', questions: [{ id: 'q1' }] }] },
    }] : []));
    const rawSend = wire.send.bind(wire);
    wire.send = (obj) => { rawSend(obj); if (obj.type === 'interact') wire.closed = true; };
    const rt = await runtimeWith(wire);
    const r = await rt.interact(KEY, '答');
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /连接断了|没查成/);
  });

  it('stopSession：连接带 failure 且无 error 回执 → 不许报成功', async () => {
    const wire = fakeWire(goodState());
    wire.failure = 'peer closed';
    const rt = await runtimeWith(wire);
    const r = await rt.stopSession(KEY);
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /连接断了|没查成/);
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

describe('#1125 listSessions：会话名单是第六个动词', () => {
  it('回了 sessions 数组 → ok，原样交出', async () => {
    const sessions = [
      { sessionKey: KEY, runState: 'streaming' },
      { sessionKey: 'codex:dead', runState: 'done' },
    ];
    const wire = fakeWire(goodState(), f => (f.type === 'listSessions' ? [{ type: 'sessions', sessions, hasMore: false }] : []));
    const rt = await runtimeWith(wire);
    const r = await rt.listSessions();
    assert.equal(r.ok, true);
    assert.equal(r.missing, false);
    assert.deepEqual(r.sessions, sessions);
    assert.ok(wire.sent.some(f => f.type === 'listSessions'));
  });

  it('没回可用数组 → missing，sessions 是 null 不是 []', async () => {
    const wire = fakeWire(goodState(), f => (f.type === 'listSessions' ? [{ type: 'sessions' }] : []));
    const rt = await runtimeWith(wire);
    const r = await rt.listSessions();
    assert.equal(r.ok, false);
    assert.equal(r.missing, true);
    assert.equal(r.sessions, null, 'null 才能让 countLiveReviewers 判没查成；[] 会当成 0 个在跑去拉满');
  });

  it('等不到帧 → missing，sessions 是 null', async () => {
    const wire = fakeWire(goodState(), () => []);
    const rt = await runtimeWith(wire);
    const r = await rt.listSessions();
    assert.equal(r.ok, false);
    assert.equal(r.sessions, null);
    assert.match(r.why, /没查成/);
  });

  it('hasMore=true 扩大明确 global 查询，直到服务端证明完整', async () => {
    let calls = 0;
    const wire = fakeWire(goodState(), f => f.type === 'listSessions' ? [{ type: 'sessions', sessions: [{ sessionKey: KEY }], hasMore: ++calls === 1 }] : []);
    const rt = await runtimeWith(wire);
    const r = await rt.listSessions();
    assert.equal(r.ok, true);
    const requests = wire.sent.filter(f => f.type === 'listSessions');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].scope, 'global');
    assert.ok(requests[1].limit > requests[0].limit);
  });

  it('缺完整性标志不能假报全局查成', async () => {
    const wire = fakeWire(goodState(), f => f.type === 'listSessions' ? [{ type: 'sessions', sessions: [] }] : []);
    const r = await (await runtimeWith(wire)).listSessions();
    assert.equal(r.ok, false);
    assert.equal(r.partial, true);
    assert.equal(r.sessions, null);
  });

  it('prompt 已发送但 ACK 丢失是 uncertain，不能释放后重复派', async () => {
    const wire = fakeWire(goodState(), () => []);
    const rt = await runtimeWith(wire);
    await assert.rejects(rt.startSession({ agent: 'claude', workdir: '/tmp/dao-fake', prompt: 'fixture', clientRef: 'lost-ack' }), e => e.detail.launchUncertain === true && e.detail.clientRef === 'lost-ack');
    assert.equal(wire.sent.filter(f => f.type === 'prompt').length, 1);
  });
});

describe('钉版本默认跟随本机在役版本（2026-09-10 机制改造）', () => {
  it('installedVersion 读出本机在役版本号', async () => {
    const { installedVersion } = await import(LIB);
    const v = installedVersion('/home/orca');
    assert.ok(v === null || /^\d+\.\d+\.\d+/.test(v), `读出来应是版本号或 null，实际 ${v}`);
  });

  it('读不到时返回 null，不编一个版本出来', async () => {
    const { installedVersion } = await import(LIB);
    assert.strictEqual(installedVersion('/nonexistent-home-xyz'), null);
  });

  it('跟随模式：服务端版本与常量不同也放行——升级不该再拒派', async () => {
    const { judgeContract } = await import(LIB);
    const v = judgeContract({ version: '0.0.999', workdir: '/w', home: '/h', platform: 'linux', agentsAvailable: [] });
    assert.strictEqual(v.ok, true);
  });

  it('跟随模式仍拦「服务端不报版本」——形态突变不许静默走错', async () => {
    const { judgeContract } = await import(LIB);
    const v = judgeContract({ workdir: '/w', home: '/h', platform: 'linux', agentsAvailable: [] });
    assert.strictEqual(v.ok, false);
    assert.match(v.errors.join('；'), /没报 version/);
  });

  it('跟随模式拦非法版本形状', async () => {
    const { judgeContract } = await import(LIB);
    const v = judgeContract({ version: 'not-a-version', workdir: '/w', home: '/h', platform: 'linux', agentsAvailable: [] });
    assert.strictEqual(v.ok, false);
  });

  it('显式钉住时恢复严格语义', async () => {
    const { judgeContract } = await import(LIB);
    const v = judgeContract(
      { version: '0.0.999', workdir: '/w', home: '/h', platform: 'linux', agentsAvailable: [] },
      { pinnedVersion: '0.0.307' },
    );
    assert.strictEqual(v.ok, false);
    assert.match(v.errors.join('；'), /版本不符/);
  });
});

describe('建树幂等命中（2026-09-10 服务端 worktrees 缓存陈旧）', () => {
  it('git 说分支已被某树占用，且该路径真实存在 → 当已有树复用，不报错', async () => {
    // 服务端 worktrees 缓存实测会陈旧（69 条里 31 条有 branch，git 里真有的不在列表），
    // findTree 因此漏判、走到新建，git 拒绝并在错误里给出真实路径。git 比缓存权威。
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hit-'));
    const wire = fakeWire(goodState(), f => {
      if (f.type === 'listWorkspaces') return [{ type: 'workspaces', workspaces: [{ path: '/repo', worktrees: [] }] }];
      if (f.type === 'addWorktree') {
        return [{ type: 'worktreeAdded', reqId: f.reqId, ok: false, error: `fatal: 'feat-z' is already used by worktree at '${real}'` }];
      }
      return [];
    });
    const rt = await runtimeWith(wire);
    const r = await rt.ensureWorkspace('/repo', 'feat-z');
    assert.strictEqual(r.created, false);
    assert.strictEqual(r.path, real);
    assert.strictEqual(r.verified, true);
  });

  it('git 报的路径不存在 → 仍是拒绝，不许拿一个不存在的路径当成功', async () => {
    const wire = fakeWire(goodState(), f => {
      if (f.type === 'listWorkspaces') return [{ type: 'workspaces', workspaces: [{ path: '/repo', worktrees: [] }] }];
      if (f.type === 'addWorktree') {
        return [{ type: 'worktreeAdded', reqId: f.reqId, ok: false, error: "fatal: 'feat-z' is already used by worktree at '/nope/not/here'" }];
      }
      return [];
    });
    const rt = await runtimeWith(wire);
    await assert.rejects(() => rt.ensureWorkspace('/repo', 'feat-z'), err => {
      assert.strictEqual(err.name, 'MirasimRejectedError');
      return true;
    });
  });
});

// 升级换没换干净（2026-09-10 的镜像面）：契约断言两边都读服务端，
// 所以「盘上 promote 了新版、进程还在跑老版」它天生看不见。这条判官专门补这个盲区。
describe('judgeVersionDrift：promote 出来的版本 vs 在役进程自报的版本', () => {
  const load = () => import(LIB);

  it('两个版本一致 → ok', async () => {
    const { judgeVersionDrift } = await load();
    const r = judgeVersionDrift({ promoted: '0.0.307', reported: '0.0.307', service: 'mirasim-server.service' });
    assert.equal(r.state, 'ok');
    assert.equal(r.promoted, '0.0.307');
  });

  it('盘上 0.0.307、进程 0.0.282 → red（改了软链没重启的形态）', async () => {
    const { judgeVersionDrift } = await load();
    const r = judgeVersionDrift({ promoted: '0.0.307', reported: '0.0.282' });
    assert.equal(r.state, 'red');
    assert.match(r.detail, /0\.0\.307/);
    assert.match(r.detail, /0\.0\.282/);
    // 说人话的三行缺一行，群里就只剩技术话——拆开断言，失败时看得出缺的是哪一行。
    assert.equal(typeof r.plain?.what, 'string', 'red 缺 plain.what');
    assert.equal(typeof r.plain?.impact, 'string', 'red 缺 plain.impact');
    assert.equal(typeof r.plain?.plan, 'string', 'red 缺 plain.plan');
  });

  it('进程比盘上还新（回退没生效）同样 red —— 谁新谁旧都要人看一眼', async () => {
    const { judgeVersionDrift } = await load();
    assert.equal(judgeVersionDrift({ promoted: '0.0.282', reported: '0.0.307' }).state, 'red');
  });

  it('取不到版本 → unknown，绝不是 ok（没查成 ≠ 查过没事）', async () => {
    const { judgeVersionDrift } = await load();
    assert.equal(judgeVersionDrift({ promoted: null, reported: '0.0.307' }).state, 'unknown');
    assert.equal(judgeVersionDrift({ promoted: '0.0.307', reported: null }).state, 'unknown');
    assert.equal(judgeVersionDrift({}).state, 'unknown');
    assert.match(judgeVersionDrift({}).detail, /没查成/);
  });

  it('形状不对的版本号当取不到，不当一致', async () => {
    const { judgeVersionDrift } = await load();
    assert.equal(judgeVersionDrift({ promoted: 'unknown', reported: 'unknown' }).state, 'unknown');
    assert.equal(judgeVersionDrift({ promoted: '0.0.307', reported: ' 0.0.307 ' }).state, 'ok', '两侧空白该被规整');
  });
});
