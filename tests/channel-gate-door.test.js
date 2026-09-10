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
  });

  // 钉「默认走**原子占槽**入口」。判据取 defaultChannelAdmit 的**函数体**，不取 import 列表——
  // 实测过：只钉 import 抓不住变异，把门换回 checkChannelCapacity 时两个名字都还在 import 里，
  // 测试照绿。钉「谁被调用」才钉得住（本条有变异验证：换回只读入口当场转红）。
  const 切出默认闸 = () => {
    const src = fs.readFileSync(RT_FILE, 'utf8');
    const a = src.indexOf('function defaultChannelAdmit(');
    assert.notEqual(a, -1, 'defaultChannelAdmit 锚点找不到了——切片没取成，不是「检查通过」');
    const b = src.indexOf('export function createRuntime(', a);
    assert.notEqual(b, -1, 'createRuntime 锚点找不到了——切片没取成');
    const body = src.slice(a, b);
    assert.ok(body.length > 200, `切片只有 ${body.length} 字符，锚点多半失效了`);
    return body;
  };

  it('默认闸调的是原子占槽入口 admitAndReserveChannel', async () => {
    assert.match(切出默认闸(), /return admitAndReserveChannel\(/, '默认闸没走原子占槽');
  });

  it('默认闸不许调只读入口 checkChannelCapacity —— 那会把 TOCTOU 竞态放回来', async () => {
    assert.equal(/checkChannelCapacity\(/.test(切出默认闸()), false, '门里用只读判据＝两个并发都判没满都放行');
  });

  it('占了槽的每条出路都退槽 —— release 在 finally 里', async () => {
    const { fn } = 切出();
    assert.match(fn, /releaseSlot\(\)/, '没退槽：预占泄漏会让该渠道少一个名额到 TTL 到点');
    // 退槽必须在 finally：成功、被拒、抛错三条路都要过。写在 return 前面只覆盖成功那条。
    const at = fn.indexOf('releaseSlot()');
    const fin = fn.lastIndexOf('} finally {', at);
    assert.notEqual(fin, -1, 'releaseSlot() 不在任何 finally 块里——被拒/抛错那两条路会漏退槽');
  });

  it('锁不许持过网络 I/O —— open() 在占槽之后，不在临界区里', async () => {
    const { fn } = 切出();
    // #849 那把锁的等待是忙自旋（dispatch-lock.mjs 的 sleep），持锁跨网络 I/O 会让等待者烧 CPU。
    // 判据：channelAdmit（含锁的整段）必须在 await open() 之前**结束**——门里拿不到锁对象，
    // 也就不可能把锁持过连线。
    assert.ok(fn.indexOf('channelAdmit(') < fn.indexOf('await open()'));
    assert.equal(/withWorktreeLock|acquireWorktreeLock/.test(fn), false, '门里不许自己持锁——锁只在 admitAndReserveChannel 的临界区内');
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

// 生产接线证据：不是喂假快照给纯函数，而是走**生产入口 checkChannelCapacity + 真路由表**。
// 上限数字不写死——腿表是帅位可随时改的（2026-09-05 拍板），钉死数字会在别人填真数那天变红，
// 而闸本身一点没坏。所以钉**不变量**：在途 = 该渠道上限 ⇒ 满；少一个 ⇒ 放行。
describe('生产入口 + 真腿表：第 N+1 个同渠道会话被拦（不变量，不钉具体数字）', () => {
  const ROUTING = path.join(__dirname, '..', 'docs', 'model-routing.json');

  async function bits() {
    const { checkChannelCapacity, buildChannelCaps, resolveModelChannel } = await import(CC);
    const MR = 'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'model-routing-json.mjs').replace(/\\/g, '/');
    const { loadRoutingJsonRaw, modelsFromJson } = await import(MR);
    const raw = JSON.parse(fs.readFileSync(ROUTING, 'utf8'));
    return { checkChannelCapacity, buildChannelCaps, resolveModelChannel, loadRoutingJsonRaw, modelsFromJson, raw };
  }

  const ioWith = (loadRoutingJsonRaw, modelsFromJson, trees, jobs) => ({
    loadRouting: () => loadRoutingJsonRaw(),
    loadModels: (r) => modelsFromJson(r),
    checkInFlight: () => ({ ok: true, trees, count: trees.length }),
    loadJobs: () => jobs,
    loadBreaker: () => null,
  });

  // 审官模型：#1145 的起因就是「一轮起 10 个审官全部 429」，所以判别点选审官这条腿。
  for (const model of ['gpt-5.6-luna', 'gpt-5.6-sol']) {
    it(`${model}：在途占满该渠道上限 → 生产入口判 full；少一个 → free`, async () => {
      const b = await bits();
      const caps = b.buildChannelCaps(b.raw.腿);
      const resolved = b.resolveModelChannel({ model, legs: b.raw.腿, models: b.modelsFromJson(b.raw), caps: caps.caps });
      assert.ok(resolved, `${model} 在腿表里认不出渠道——判据失效，不是「检查通过」`);
      const cap = resolved.cap;
      // 拆到最简：两个条件分开断，失败时看得出是哪半坏了（复合断言看不出）。
      assert.equal(Number.isFinite(cap), true, `${model} 的渠道 ${resolved.channel} 上限不是有限值（${cap}）——本用例失去判别力`);
      assert.ok(cap >= 1, `${model} 的渠道 ${resolved.channel} 上限 ${cap} < 1——本用例失去判别力`);

      const mk = (n) => {
        const jobs = []; const trees = [];
        for (let i = 1; i <= n; i += 1) {
          jobs.push({ pr: 9000 + i, model });
          trees.push(`/root/mirasim-worktrees/windsurf-dao/dao-review-pr-${9000 + i}`);
        }
        return { jobs, trees };
      };

      const full = mk(cap);
      const rFull = b.checkChannelCapacity({ model, now: T0, io: ioWith(b.loadRoutingJsonRaw, b.modelsFromJson, full.trees, full.jobs) });
      assert.equal(rFull.verdict, 'full');
      assert.equal(rFull.reason, 'at-cap');
      assert.equal(rFull.channel, resolved.channel);
      assert.equal(rFull.inFlight, cap);

      const under = mk(cap - 1);
      const rFree = b.checkChannelCapacity({ model, now: T0, io: ioWith(b.loadRoutingJsonRaw, b.modelsFromJson, under.trees, under.jobs) });
      assert.equal(rFree.verdict, 'free');
      assert.equal(rFree.inFlight, cap - 1);
    });
  }

  it('在途读不出来 → ok:false（fail-close），不是「扫完是 0」', async () => {
    const b = await bits();
    const r = b.checkChannelCapacity({
      model: 'gpt-5.6-sol', now: T0,
      io: { ...ioWith(b.loadRoutingJsonRaw, b.modelsFromJson, [], []), checkInFlight: () => ({ ok: false, error: '/proc 读不动' }) },
    });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
  });

  it('路由表读不出来 → ok:false（fail-close）', async () => {
    const b = await bits();
    const r = b.checkChannelCapacity({
      model: 'gpt-5.6-sol', now: T0,
      io: { ...ioWith(b.loadRoutingJsonRaw, b.modelsFromJson, [], []), loadRouting: () => { throw new Error('文件不在'); } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
  });
});

// 门里排着两道闸，各抛一种背压。只接一条＝没修（memory fix-landed-at-one-call-site-only）：
// 漏掉的那条会继续把「这轮轮不到」当失败去烧 drain 预算，撞满 3 次把 PR 判成认输。
describe('审官路径：门里两种背压都要入队，「没查成」一条都不许混进去', () => {
  // 真实错误串形状：门抛 message → mirasimReviewerCreate 包一层「起审官会话没查成：…」
  const 门抛 = (msg) => `起审官会话没查成：${msg}`;

  it('租约被占 → lease-held → queued，不 fail（#1085 的背压，本单补接）', async () => {
    const { classifyReviewerSpawnError, planWorkerDoneAfterSpawnFail } = await import(REVIEWER);
    const err = 门抛('租约被占，拒起会话：/root/mirasim-worktrees/windsurf-dao/dao-1145 已经有 1 个会话进程在干活（pi pid 2977217）');
    assert.equal(classifyReviewerSpawnError(err).kind, 'lease-held');
    const plan = planWorkerDoneAfterSpawnFail({ error: err, reviewPending: { ok: true } });
    assert.equal(plan.queued, true);
    assert.equal(plan.fail, false);
  });

  it('渠道满员 → channel-full → queued，不 fail（#1145 的背压）', async () => {
    const { classifyReviewerSpawnError, planWorkerDoneAfterSpawnFail } = await import(REVIEWER);
    const err = 门抛('渠道满员，拒起会话：渠道 direct:codex@pqapi 已满员（在途 2 ≥ 上限 2）');
    assert.equal(classifyReviewerSpawnError(err).kind, 'channel-full');
    const plan = planWorkerDoneAfterSpawnFail({ error: err, reviewPending: { ok: true } });
    assert.equal(plan.queued, true);
    assert.equal(plan.fail, false);
  });

  // 关键回归保护：这次放宽只许放进「已知拒派」，绝不许把「没查成」也顺手放进队列。
  // 混进去的后果是真故障被静默排队、每轮重试，没有人被告知——比报错还坏。
  it('回归保护：租约「没查成」仍 fail/stop 报帅，不被本次放宽误伤', async () => {
    const { classifyReviewerSpawnError, planWorkerDoneAfterSpawnFail } = await import(REVIEWER);
    const err = 门抛('租约没查成，拒起会话：扫了 412 个进程，一个 cwd 都读不出来');
    assert.equal(classifyReviewerSpawnError(err).kind, 'unscanned');
    const plan = planWorkerDoneAfterSpawnFail({ error: err, reviewPending: { ok: true } });
    assert.equal(plan.queued, false);
    assert.equal(plan.fail, true);
  });

  it('回归保护：渠道「没查成」同样 fail/stop 报帅', async () => {
    const { classifyReviewerSpawnError, planWorkerDoneAfterSpawnFail } = await import(REVIEWER);
    const err = 门抛('渠道并发没查成，拒起会话：渠道在途数没查成（/proc 读不动）');
    assert.equal(classifyReviewerSpawnError(err).kind, 'unscanned');
    const plan = planWorkerDoneAfterSpawnFail({ error: err, reviewPending: { ok: true } });
    assert.equal(plan.queued, false);
    assert.equal(plan.fail, true);
  });

  it('回归保护：不相干的真失败仍 fail（放宽没扩大到整个错误面）', async () => {
    const { classifyReviewerSpawnError, planWorkerDoneAfterSpawnFail } = await import(REVIEWER);
    const err = 门抛('workdir 不存在');
    assert.equal(classifyReviewerSpawnError(err).kind, 'unscanned');
    assert.equal(planWorkerDoneAfterSpawnFail({ error: err, reviewPending: { ok: true } }).fail, true);
  });

  it('背压集合里两条都在（漏一条就是只接了一个调用点）', async () => {
    const { planWorkerDoneAfterSpawnFail } = await import(REVIEWER);
    // 不导出集合本身，就从行为上分别确认——两条各自独立断言，失败时看得出是哪条漏了
    const lease = planWorkerDoneAfterSpawnFail({ error: 门抛('租约被占，拒起会话：x'), reviewPending: { ok: true } });
    const chan = planWorkerDoneAfterSpawnFail({ error: 门抛('渠道满员，拒起会话：y'), reviewPending: { ok: true } });
    assert.equal(lease.queued, true, 'lease-held 不在背压集合里——租约那条路仍在烧 drain 预算');
    assert.equal(chan.queued, true, 'channel-full 不在背压集合里——渠道那条路仍在烧 drain 预算');
  });

  it('背压但复审待办没写成 → 仍 fail（队列写不进就不能算交卷）', async () => {
    const { planWorkerDoneAfterSpawnFail } = await import(REVIEWER);
    const plan = planWorkerDoneAfterSpawnFail({
      error: 门抛('租约被占，拒起会话：x'),
      reviewPending: { ok: false, error: '目录写不进' },
    });
    assert.equal(plan.queued, false);
    assert.equal(plan.fail, true);
  });
});
