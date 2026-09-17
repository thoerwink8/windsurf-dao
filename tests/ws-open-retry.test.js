import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/no-network.mjs';

// ── 开回环 ws 要重试瞬时抖动，但不许重试「判定」（2026-09-14 实咬）──
//
// 病：connect 一失败就抛，上层看到「起审官会话没查成：连不上回环 ws」，
// 当场判这次派工失败、烧掉一次复审预算，三次打「卡死/自动化认输」。
// 而 12 小时内回环 ws 红 11 次，每一次下一轮自己就好了——#1266/#1271 就这么被扣没的。
describe('回环 ws 开连接重试', () => {
  const RT = import('../scripts/lib/mirasim-runtime.mjs');
  const unavailable = (msg = '连不上回环 ws', detail = { why: 'ECONNREFUSED' }) => {
    const e = new Error(msg);
    e.code = 'unavailable';
    e.detail = detail;
    return e;
  };

  it('①第一次抖、第二次通 → 拿到连接，上层根本不知道抖过', async () => {
    const { connectWithRetry } = await RT;
    let calls = 0;
    const slept = [];
    const wire = await connectWithRetry({
      connect: async () => { calls += 1; if (calls === 1) throw unavailable(); return { wire: true }; },
      sleep: async (ms) => { slept.push(ms); }, random: () => 0,
    });
    assert.deepEqual(wire, { wire: true });
    assert.equal(calls, 2);
    assert.equal(slept.length, 1, '重试前要退避，别贴着脸重连');
  });

  it('②一直连不上 → 试满才抛原错，并在 detail 里留下试了几次', async () => {
    const { connectWithRetry, WS_OPEN_TRIES } = await RT;
    let calls = 0;
    let lastThrown;
    await assert.rejects(
      connectWithRetry({
        connect: async () => { calls += 1; lastThrown = unavailable(); throw lastThrown; },
        sleep: async () => {}, random: () => 0,
      }),
      (e) => {
        assert.equal(e, lastThrown, '试满后抛的是原错，不许包一层新错');
        assert.equal(e.code, 'unavailable');
        assert.equal(e.detail.wsOpenTries, WS_OPEN_TRIES, '要分得清「一次就死」和「试满都不行」');
        return true;
      },
    );
    assert.equal(calls, WS_OPEN_TRIES);
  });

  it('③负控：契约不符是**判定**，一次都不许重试（重试一万次结果一样）', async () => {
    const { connectWithRetry } = await RT;
    let calls = 0;
    const contract = new Error('契约断言不通过，拒派：版本对不上');
    contract.code = 'contract';
    await assert.rejects(
      connectWithRetry({ connect: async () => { calls += 1; throw contract; }, sleep: async () => {} }),
      /契约断言不通过/,
    );
    assert.equal(calls, 1, '判定类立刻抛，不许拖慢真结论');
  });

  it('④负控：「连上了但没收到 state 帧」也不重试——它已经连上了，重开无用', async () => {
    const { connectWithRetry } = await RT;
    let calls = 0;
    await assert.rejects(
      connectWithRetry({
        connect: async () => { calls += 1; throw unavailable('连上了但没收到 state 帧，契约没查成——不派', {}); },
        sleep: async () => {},
      }),
      /连上了/,
    );
    assert.equal(calls, 1);
  });

  it('⑤负控：服务端明确拒绝（渠道满员）不重试', async () => {
    const { connectWithRetry } = await RT;
    let calls = 0;
    const rejected = new Error('渠道满员，拒起会话');
    rejected.code = 'rejected';
    await assert.rejects(
      connectWithRetry({ connect: async () => { calls += 1; throw rejected; }, sleep: async () => {} }),
      /渠道满员/,
    );
    assert.equal(calls, 1);
  });

  it('⑥判据本身：isWsOpenRetryable 只认「没查成且没连上」', async () => {
    const { isWsOpenRetryable } = await RT;
    assert.equal(isWsOpenRetryable(unavailable()), true);
    assert.equal(isWsOpenRetryable(unavailable('连上了但没收到 state 帧', {})), false);
    const contract = new Error('x'); contract.code = 'contract';
    assert.equal(isWsOpenRetryable(contract), false);
    assert.equal(isWsOpenRetryable(null), false);
    assert.equal(isWsOpenRetryable(new Error('随便一个没有 code 的错')), false,
      '没有 code 就是认不出来，认不出来不许当可重试——宁可少试一次');
  });

  it('⑦退避要带抖动：多路同时重连不许撞在同一毫秒', async () => {
    const { connectWithRetry, WS_OPEN_BACKOFF_MS } = await RT;
    const slept = [];
    await assert.rejects(connectWithRetry({
      connect: async () => { throw unavailable(); },
      sleep: async (ms) => { slept.push(ms); }, random: () => 1,
    }), () => true);
    assert.equal(slept[0] > WS_OPEN_BACKOFF_MS, true, 'random=1 时要比基数大（抖动加上去了）');
    const flat = [];
    await assert.rejects(connectWithRetry({
      connect: async () => { throw unavailable(); },
      sleep: async (ms) => { flat.push(ms); }, random: () => 0,
    }), () => true);
    assert.equal(flat[1] > flat[0], true, '退避要随次数递增');
  });

  it('⑧接线：createRuntime.open 真走 connectWithRetry（第一次抖、第二次通）', async () => {
    const { createRuntime } = await RT;
    let calls = 0;
    const wire = {
      state: {
        version: '0.0.282', workdir: '/srv', home: '/srv', platform: 'linux',
        agentsAvailable: ['claude'],
      },
      send() {},
      async waitFor(pred) {
        return pred({ type: 'sessions', sessions: [] }) ? { type: 'sessions', sessions: [] } : null;
      },
      close() {},
    };
    const rt = createRuntime({
      connect: async () => { calls += 1; if (calls === 1) throw unavailable(); return wire; },
      sleep: async () => {},
    });
    const v = await rt.handshake();
    assert.equal(calls, 2, '拆掉 open() 的重试，这一条会回到一次就死');
    assert.equal(v.sessionsOk, true);
  });
});
