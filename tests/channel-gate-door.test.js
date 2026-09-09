// tests/channel-gate-door.test.js —— 渠道并发闸装在 startSession **那道门**里（#1145）
//
// 为什么测门而不是测各调用点：仓内先例是租约闸（lib/dispatch/lease.mjs 头部）——
// 四个调用点（dao dispatch / dao start / 审官 create / 推一把）全从这道门过，装在门里绕不开。
// 所以「审官起会话受不受闸」这件事，判据就是「门里拦不拦」，不是「审官代码里有没有调」。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const RT_FILE = path.join(__dirname, '..', 'scripts', 'lib', 'mirasim-runtime.mjs');
const LIB = 'file://' + RT_FILE.replace(/\\/g, '/');
const CC = 'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'channel-concurrency.mjs').replace(/\\/g, '/');
const REVIEWER_MIRASIM = 'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'reviewer-mirasim.mjs').replace(/\\/g, '/');
const REVIEWER = 'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'reviewer.mjs').replace(/\\/g, '/');

const T0 = 1757332800000; // 2026-09-08T12:00:00Z
const KEY = 'pi:11111111-2222-3333-4444-555555555555';

function goodState(over = {}) {
  return {
    version: '0.0.282',
    platform: 'linux',
    workdir: '/srv',
    home: '/srv',
    agentsAvailable: ['claude', 'codex', 'pi'],
    ...over,
  };
}

// 假连线：记下发出去的每一帧（判「拒起 = 一帧都没发」用它）
function fakeWire(state, script = () => []) {
  const sent = [];
  const inbox = [];
  return {
    state, sent, closed: false,
    send(obj) { sent.push(obj); for (const r of script(obj) || []) inbox.push(r); },
    async waitFor(pred) { const at = inbox.findIndex(pred); return at === -1 ? null : inbox.splice(at, 1)[0]; },
    close() { this.hungUp = true; },
  };
}

const freeLease = () => ({ ok: true, verdict: 'free', why: '树是空的' });

async function runtimeWith(wire, over = {}) {
  const { createRuntime } = await import(LIB);
  return createRuntime({
    homeDir: '/srv',
    connect: async () => wire,
    now: () => T0,
    leaseCheck: freeLease,   // 隔离：本测只验渠道闸，租约恒放行
    ...over,
  });
}

describe('闸的位置：源码判据（照租约闸那套锚点断言）', () => {
  const 切出 = () => {
    const src = fs.readFileSync(RT_FILE, 'utf8');
    const a = src.indexOf('async function startSession(');
    const b = src.indexOf('async function readSession(', a);
    assert.notEqual(a, -1, 'startSession 锚点找不到了——切片没取成，不是「检查通过」');
    assert.notEqual(b, -1, 'readSession 锚点找不到了——切片没取成，不是「检查通过」');
    assert.ok(b > a, `readSession(${b}) 应当排在 startSession(${a}) 后面`);
    return { src, fn: src.slice(a, b) };
  };

  it('startSession 里调了渠道闸', async () => {
    const { fn } = 切出();
    assert.match(fn, /channelAdmit\(/, '起会话入口没过渠道闸');
  });

  it('渠道闸排在 open() 之前 —— 满员连 ws 都不开', async () => {
    const { fn } = 切出();
    assert.ok(fn.indexOf('channelAdmit(') < fn.indexOf('await open()'), '闸必须排在 open() 前面');
  });

  it('默认判据是真闸，不是空函数（不给就不检查等于没有闸）', async () => {
    const { src } = 切出();
    assert.match(src, /opts\.channelAdmit \|\| defaultChannelAdmit/, '默认值被换掉，闸就等于没装');
    assert.match(src, /import \{[\s\S]{0,200}\bcheckChannelCapacity\b[\s\S]{0,200}\} from '\.\/channel-concurrency\.mjs'/);
  });
});

describe('故意违规样本：渠道满员时起会话', () => {
  it('满员 → 拒起，且一帧 prompt 都没发出去（这才叫拒起，不是「抛完照烧额度」）', async () => {
    const wire = fakeWire(goodState(), () => [{ type: 'accepted', sessionKey: KEY, taskId: 't1' }]);
    const rt = await runtimeWith(wire, {
      channelAdmit: () => ({
        ok: true, verdict: 'full', channel: 'direct:codex@pqapi', reason: 'at-cap',
        cap: 2, inFlight: 2, why: '渠道 direct:codex@pqapi 已满员（在途 2 ≥ 上限 2）',
      }),
    });
    await assert.rejects(
      () => rt.startSession({ agent: 'codex', workdir: '/srv/work', prompt: 'x', model: 'gpt-5.6-sol' }),
      (err) => {
        assert.equal(err.name, 'MirasimRejectedError');
        assert.match(err.message, /渠道满员/);
        return true;
      },
    );
    assert.deepEqual(wire.sent.filter((f) => f.type === 'prompt'), []);
    assert.equal(wire.sent.length, 0, '满员时连 ws 都不该开，一帧都不该发');
  });

  it('满员的拒起必须带 busy 背压标记 + reason（不标它指挥官会开待拍板噪音单）', async () => {
    const { CHANNEL_FULL_REASON } = await import(CC);
    const wire = fakeWire(goodState());
    const rt = await runtimeWith(wire, {
      channelAdmit: () => ({ ok: true, verdict: 'full', channel: 'gw:windsurf', reason: 'at-cap', cap: 3, inFlight: 3, why: '满了' }),
    });
    await assert.rejects(
      () => rt.startSession({ agent: 'pi', workdir: '/srv/work', prompt: 'x', model: 'gpt-5.6-luna' }),
      (err) => {
        assert.equal(err.detail.busy, true);
        assert.equal(err.detail.reason, CHANNEL_FULL_REASON);
        assert.equal(err.detail.channel, 'gw:windsurf');
        return true;
      },
    );
  });

  it('熔断冷却中 → 同样按满员拒起（冷却中等同满员）', async () => {
    const wire = fakeWire(goodState());
    const rt = await runtimeWith(wire, {
      channelAdmit: () => ({ ok: true, verdict: 'full', channel: 'gw:grok', reason: 'breaker-open', why: '熔断，冷却至 …' }),
    });
    await assert.rejects(
      () => rt.startSession({ agent: 'pi', workdir: '/srv/work', prompt: 'x', model: 'grok-4.6' }),
      (err) => (assert.equal(err.detail.channelReason, 'breaker-open'), true),
    );
    assert.equal(wire.sent.length, 0);
  });

  it('没查成 → fail-close 拒起（MirasimUnavailableError，不带 busy）', async () => {
    const wire = fakeWire(goodState());
    const rt = await runtimeWith(wire, {
      channelAdmit: () => ({ ok: false, unscanned: true, error: '渠道在途数没查成（/proc 读不动）' }),
    });
    await assert.rejects(
      () => rt.startSession({ agent: 'pi', workdir: '/srv/work', prompt: 'x', model: 'grok-4.6' }),
      (err) => {
        assert.equal(err.name, 'MirasimUnavailableError');
        assert.match(err.message, /渠道并发没查成/);
        assert.notEqual(err.detail && err.detail.busy, true, '没查成不是背压，不许标 busy');
        return true;
      },
    );
    assert.equal(wire.sent.length, 0);
  });

  it('放行 → prompt 照发（闸不误伤）', async () => {
    const wire = fakeWire(goodState(), (f) => (f.type === 'prompt' ? [{ type: 'accepted', sessionKey: KEY, taskId: 't9' }] : []));
    const rt = await runtimeWith(wire, {
      channelAdmit: () => ({ ok: true, verdict: 'free', channel: 'gw:grok', cap: Infinity, inFlight: 0 }),
    });
    const r = await rt.startSession({ agent: 'pi', workdir: '/srv/work', prompt: 'x', model: 'grok-4.6' });
    assert.equal(r.sessionKey, KEY);
    assert.equal(wire.sent.filter((f) => f.type === 'prompt').length, 1);
  });

  it('不带 model 的会话不受本闸拦（否则 dao start / 临时会话全起不来 = 全盘阻塞）', async () => {
    const wire = fakeWire(goodState(), (f) => (f.type === 'prompt' ? [{ type: 'accepted', sessionKey: KEY }] : []));
    const rt = await runtimeWith(wire); // 用真 defaultChannelAdmit
    const r = await rt.startSession({ agent: 'claude', workdir: '/srv/work', prompt: 'x' });
    assert.equal(r.sessionKey, KEY);
  });
});

describe('审官路径端到端：起审官 → 门里渠道闸 → busy 背压 → 排队不报帅', () => {
  const MODELS = [
    { id: 'gpt-5.6-luna', provider: 'gw', cli_model: 'gw-windsurf/gpt-5.6-luna' },
    { id: 'grok-4.6', provider: 'gw', cli_model: 'gw/grok-4.6' },
  ];

  // mirasimReviewerCreate 要的最小夹具：PR head 查得到、树建得出、HEAD 对得上。
  function reviewerArgs(runtime) {
    const OID = 'a'.repeat(40);
    return {
      runtime,
      gh: (argv) => {
        const a = (Array.isArray(argv) ? argv : [String(argv)]).join(' ');
        if (a.includes('pr view') && a.includes('headRefName')) {
          return { ok: true, out: JSON.stringify({ headRefName: 'feat/x', headRefOid: OID, mergeable: 'MERGEABLE' }) };
        }
        if (a.includes('pr view') && a.includes('reviews')) return { ok: true, out: JSON.stringify({ reviews: [] }) };
        return { ok: true, out: '{}' };
      },
      readTreeHead: async () => OID,
      prepareRef: async () => ({ ok: true }),
      pr: 1145,
      repo: '/srv/projects/windsurf-dao',
      reviewerModel: 'gpt-5.6-luna',
      workerModel: 'grok-4.6',
      models: MODELS,
      // 形状照 tests/mirasim-reviewer.test.js 的 MIRASIM_POLICY（真表同款），不自造
      mirasimPolicy: {
        钉版本: '0.0.282',
        模型前缀族: { 'gpt-5.6': 'gpt', gpt: 'gpt', claude: 'claude', pi: 'pi' },
        agentRoutes: {
          gpt: { agent: 'codex', mode: 'relay' },
          claude: { agent: 'claude', mode: 'relay' },
          pi: { agent: 'pi', mode: 'direct' },
        },
      },
      prompt: '审官任务书',
      now: () => T0,
    };
  }

  it('审官起会话时渠道已满 → 门拒起、带 busy，且结果里 reason=channel-full', async () => {
    const { mirasimReviewerCreate } = await import(REVIEWER_MIRASIM);
    const { CHANNEL_FULL_REASON } = await import(CC);
    const wire = fakeWire(goodState());
    const rt = await runtimeWith(wire, {
      channelAdmit: () => ({ ok: true, verdict: 'full', channel: 'gw:windsurf', reason: 'at-cap', cap: 3, inFlight: 3, why: '渠道 gw:windsurf 已满员（在途 3 ≥ 上限 3）' }),
    });
    // 建树这一步用真 runtime 会去连假线；直接给它一棵现成树，把测试focus在起会话那一跳。
    rt.ensureWorkspace = async () => ({ path: '/srv/mirasim-worktrees/windsurf-dao/dao-review-pr-1145', branch: 'dao-review-pr-1145', created: false, verified: true });
    const res = await mirasimReviewerCreate(reviewerArgs(rt));
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'start');
    // 判别点：背压标记必须活着走出审官路径，否则它会被当失败去烧 drain 的重试预算
    assert.equal(res.busy, true);
    assert.equal(res.reason, CHANNEL_FULL_REASON);
    assert.equal(wire.sent.length, 0, '审官会话也必须是「连 ws 都不开」');
  });

  it('这条 busy 走进既有 queued 背压路：分类成 channel-full → 入队交轮转，不是 fail', async () => {
    const { classifyReviewerSpawnError, planWorkerDoneAfterSpawnFail } = await import(REVIEWER);
    const err = '起审官会话没查成：渠道满员，拒起会话：渠道 gw:windsurf 已满员（在途 3 ≥ 上限 3）';
    assert.equal(classifyReviewerSpawnError(err).kind, 'channel-full');
    const plan = planWorkerDoneAfterSpawnFail({ error: err, reviewPending: { ok: true } });
    assert.equal(plan.queued, true);
    assert.equal(plan.fail, false);
  });

  it('「没查成」仍停手报帅，不许混进 queued（拿不准不降级）', async () => {
    const { classifyReviewerSpawnError, planWorkerDoneAfterSpawnFail } = await import(REVIEWER);
    const err = '起审官会话没查成：渠道并发没查成，拒起会话：/proc 读不动';
    assert.equal(classifyReviewerSpawnError(err).kind, 'unscanned');
    const plan = planWorkerDoneAfterSpawnFail({ error: err, reviewPending: { ok: true } });
    assert.equal(plan.queued, false);
    assert.equal(plan.fail, true);
  });
});

describe('429 闭环：门里收到拒绝 → 熔断 trip（2→4→8）→ 下一轮同渠道被排除', () => {
  it('上游 429 → 走 recordChannelFailure，退避 2 轮', async () => {
    const wire = fakeWire(goodState(), (f) => (f.type === 'prompt'
      ? [{ type: 'error', message: 'HTTP 429 Too Many Requests' }] : []));
    const fed = [];
    const rt = await runtimeWith(wire, {
      channelAdmit: () => ({ ok: true, verdict: 'free', channel: 'gw:windsurf', target: 'gw:windsurf/gpt-5.6-luna', cap: 3, inFlight: 0 }),
      recordChannelFailure: (ev) => { fed.push(ev); return { ok: true, rounds: 2 }; },
    });
    await assert.rejects(
      () => rt.startSession({ agent: 'pi', workdir: '/srv/work', prompt: 'x', model: 'gpt-5.6-luna' }),
      (err) => {
        assert.equal(err.name, 'MirasimRejectedError');
        assert.equal(err.detail.capacity, true);
        assert.equal(err.detail.capacityKind, '429');
        return true;
      },
    );
    assert.equal(fed.length, 1, '撞容量必须喂熔断表，否则下一轮照原样重投（retry storm）');
    assert.equal(fed[0].target, 'gw:windsurf/gpt-5.6-luna');
  });

  it('普通失败不喂熔断表（不猜——猜错会把普通失败熔成冷却）', async () => {
    const wire = fakeWire(goodState(), (f) => (f.type === 'prompt'
      ? [{ type: 'error', message: 'workdir 不存在' }] : []));
    const fed = [];
    const rt = await runtimeWith(wire, {
      channelAdmit: () => ({ ok: true, verdict: 'free', channel: 'gw:windsurf', target: 'gw:windsurf/gpt-5.6-luna' }),
      recordChannelFailure: (ev) => { fed.push(ev); return { ok: true }; },
    });
    await assert.rejects(() => rt.startSession({ agent: 'pi', workdir: '/srv/work', prompt: 'x', model: 'gpt-5.6-luna' }));
    assert.deepEqual(fed, []);
  });

  it('闭环判据：trip 落表后，legAvailability 当场判该渠道熔断（同渠道本轮不再被选中）', async () => {
    const { applyChannelFailure, legAvailability, ROUND_MS } = await import(CC);
    const LUNA = { provider: 'gw', cli_model: 'gw-windsurf/gpt-5.6-luna' };
    // 撞容量前：可用
    assert.equal(legAvailability(LUNA, { caps: { 'gw:windsurf': 3 }, inFlight: {}, now: T0 }).available, true);
    // 撞一次 → trip
    const first = applyChannelFailure({ targets: {} }, { target: 'gw:windsurf/gpt-5.6-luna', now: T0, roundMs: ROUND_MS });
    assert.equal(first.rounds, 2, '首次退避 2 轮');
    const after = legAvailability(LUNA, { caps: { 'gw:windsurf': 3 }, inFlight: {}, breaker: first.doc, now: T0 });
    assert.equal(after.available, false);
    assert.equal(after.reason, 'breaker-open');
  });

  it('退避翻倍封顶：2 → 4 → 8 → 8（同一 target 连撞）', async () => {
    const { applyChannelFailure, ROUND_MS } = await import(CC);
    const TGT = 'direct:codex@pqapi/responses';
    const rounds = [];
    let doc = { targets: {} };
    let now = T0;
    for (let i = 0; i < 4; i += 1) {
      const r = applyChannelFailure(doc, { target: TGT, now, roundMs: ROUND_MS });
      rounds.push(r.rounds);
      doc = r.doc;
      // 下一次撞在冷却到点之后（否则 open 中的 failure 按 #843 契约不刷新倒计时）
      now += r.rounds * ROUND_MS + 1000;
    }
    assert.deepEqual(rounds, [2, 4, 8, 8]);
  });
});
