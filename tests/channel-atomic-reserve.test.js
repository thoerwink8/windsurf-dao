// tests/channel-atomic-reserve.test.js —— 渠道占槽是**原子**的，不是读快照（#1145 审官第二轮红项）
//
// 起因：门里原先「读快照再放行」。两个并发 startSession() 可以同时看到 inFlight < cap 都判 free，
// 随后都 open() 发 prompt，真实并发超上限。cap=2 的 pqapi 被两个并发顶到 3-4，正好落回 429 区，
// 闸等于白设。takeChannelSlot() 只在 commander 的纯决策快照里返回新对象，护不到真实起会话路径。
//
// 本套是**真并发**实验，不是串行快照断言：Promise.all 同时发两个真 startSession()，
// 数「谁真的开了连接 / 发了业务帧」。变异验证见报告：把锁内占槽换回读快照，本套第一条必红。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const LIB = 'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'mirasim-runtime.mjs').replace(/\\/g, '/');
const CC = 'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'channel-concurrency.mjs').replace(/\\/g, '/');

const T0 = 1757332800000; // 2026-09-08T12:00:00Z
const KEY = 'pi:11111111-2222-3333-4444-555555555555';
const LUNA = 'gpt-5.6-luna';                 // → 渠道 gw:windsurf
const CH = 'gw:windsurf';

function goodState() {
  return { version: '0.0.282', platform: 'linux', workdir: '/srv', home: '/srv', agentsAvailable: ['claude', 'codex', 'pi'] };
}

// 每棵「树」一条线：记它开没开、发了什么帧。opened 是判别点——原子占槽下只许一个开。
function wireFactory(opened) {
  return () => {
    const w = {
      state: goodState(), sent: [],
      send(o) { w.sent.push(o); if (o.type === 'prompt') w.inbox.push({ type: 'accepted', sessionKey: KEY, taskId: 't' }); },
      inbox: [],
      async waitFor(pred) { const i = w.inbox.findIndex(pred); return i === -1 ? null : w.inbox.splice(i, 1)[0]; },
      close() { w.hungUp = true; },
    };
    opened.push(w);
    return w;
  };
}

// 假腿表：只有一条在役腿，上限由用例给。models 让 target 算得出（熔断键用）。
function routing(cap) {
  return {
    腿: [{ id: 'luna@gw/orca', 模型: LUNA, 状态: '在役', 供应商: 'gw', 落地: { provider: 'gw', cli_model: 'gw-windsurf/gpt-5.6-luna' }, 并发上限: cap }],
  };
}
const MODELS = [{ id: LUNA, provider: 'gw', cli_model: 'gw-windsurf/gpt-5.6-luna' }];

// 真占槽（真锁 + 真预占文件），但落在一次性 tmp home 里，不碰 ~/.dao。
function tmpHome(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dao-1145-${tag}-`));
}

async function runtimeFor({ cap, home, opened, now = () => T0 }) {
  const { createRuntime } = await import(LIB);
  const { admitAndReserveChannel } = await import(CC);
  return createRuntime({
    homeDir: '/srv',
    connect: async () => wireFactory(opened)(),
    now,
    leaseCheck: () => ({ ok: true, verdict: 'free' }), // 隔离：只测渠道占槽
    channelAdmit: ({ model }) => admitAndReserveChannel({
      model, now: now(), home,
      io: {
        loadRouting: () => routing(cap),
        loadModels: () => MODELS,
        checkInFlight: () => ({ ok: true, trees: [], count: 0 }), // /proc 里还没有会话——竞态窗口正是这一格
        loadJobs: () => [],
        loadBreaker: () => null,
      },
    }),
  });
}

describe('故意违规样本（真并发）：cap=1，两个 startSession 同时起', () => {
  it('恰好一个进入 open()/发业务帧，另一个背压入队（busy + channel-full）', async () => {
    const { CHANNEL_FULL_REASON } = await import(CC);
    const home = tmpHome('cap1');
    const opened = [];
    const rt = await runtimeFor({ cap: 1, home, opened });

    const results = await Promise.allSettled([
      rt.startSession({ agent: 'pi', workdir: '/srv/w1', prompt: 'x', model: LUNA }),
      rt.startSession({ agent: 'pi', workdir: '/srv/w2', prompt: 'x', model: LUNA }),
    ]);

    const okd = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    assert.equal(okd.length, 1, '上限 1 却起成了 ' + okd.length + ' 个——占槽不原子');
    assert.equal(bad.length, 1);

    // 判别点①：真的只开了一条连接、只发了一帧业务帧
    assert.equal(opened.length, 1, '开了 ' + opened.length + ' 条连接——被拒的那个不该连 ws');
    const prompts = opened.reduce((n, w) => n + w.sent.filter((f) => f.type === 'prompt').length, 0);
    assert.equal(prompts, 1);

    // 判别点②：被拒的那个是**背压**，不是失败
    const err = bad[0].reason;
    assert.equal(err.name, 'MirasimRejectedError');
    assert.equal(err.detail.busy, true);
    assert.equal(err.detail.reason, CHANNEL_FULL_REASON);
    assert.equal(err.detail.channel, CH);
  });

  it('cap=2 两个同时起 → 两个都放行（证明不是无脑串行拒第二个）', async () => {
    const home = tmpHome('cap2');
    const opened = [];
    const rt = await runtimeFor({ cap: 2, home, opened });
    const results = await Promise.allSettled([
      rt.startSession({ agent: 'pi', workdir: '/srv/w1', prompt: 'x', model: LUNA }),
      rt.startSession({ agent: 'pi', workdir: '/srv/w2', prompt: 'x', model: LUNA }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
    assert.equal(opened.length, 2);
  });

  it('cap=2 三个同时起 → 恰好 2 个放行、1 个背压', async () => {
    const home = tmpHome('cap2of3');
    const opened = [];
    const rt = await runtimeFor({ cap: 2, home, opened });
    const results = await Promise.allSettled([
      rt.startSession({ agent: 'pi', workdir: '/srv/w1', prompt: 'x', model: LUNA }),
      rt.startSession({ agent: 'pi', workdir: '/srv/w2', prompt: 'x', model: LUNA }),
      rt.startSession({ agent: 'pi', workdir: '/srv/w3', prompt: 'x', model: LUNA }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    assert.equal(opened.length, 2);
  });
});

describe('预占的生命周期', () => {
  it('起会话成功后预占已退场 —— 下一个还能起（cap=1 连着起两次）', async () => {
    const home = tmpHome('serial');
    const opened = [];
    const rt = await runtimeFor({ cap: 1, home, opened });
    const a = await rt.startSession({ agent: 'pi', workdir: '/srv/w1', prompt: 'x', model: LUNA });
    assert.equal(a.sessionKey, KEY);
    // 串行第二次：前一个的预占应已在 finally 里删掉（/proc 仍是空的，所以只剩预占这一项判据）
    const b = await rt.startSession({ agent: 'pi', workdir: '/srv/w2', prompt: 'x', model: LUNA });
    assert.equal(b.sessionKey, KEY);
  });

  it('起会话抛错后预占也退场（被拒/抛错那两条路不漏退槽）', async () => {
    const { admitAndReserveChannel, reserveDir } = await import(CC);
    const { createRuntime } = await import(LIB);
    const home = tmpHome('throw');
    const rt = createRuntime({
      homeDir: '/srv',
      // 契约不符 → assertContract 抛，走的是「占了槽然后抛错」那条路
      connect: async () => ({ state: { ...goodState(), version: '0.0.999' }, sent: [], send() {}, async waitFor() { return null; }, close() {} }),
      now: () => T0,
      leaseCheck: () => ({ ok: true, verdict: 'free' }),
      channelAdmit: ({ model }) => admitAndReserveChannel({
        model, now: T0, home,
        io: {
          loadRouting: () => routing(1), loadModels: () => MODELS,
          checkInFlight: () => ({ ok: true, trees: [], count: 0 }), loadJobs: () => [], loadBreaker: () => null,
        },
      }),
    });
    await assert.rejects(() => rt.startSession({ agent: 'pi', workdir: '/srv/w1', prompt: 'x', model: LUNA }));
    // 判别点：目录里不该留下预占文件
    const dir = reserveDir({ home, channel: CH });
    const left = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.res')) : [];
    assert.deepEqual(left, [], '抛错后预占没删——这个渠道会假满员到 TTL 到点');
  });

  it('持有者进程已死的预占不占位（注入 pidAlive，不靠真 sleep）', async () => {
    const { countLiveReservations } = await import(CC);
    const dir = tmpHome('dead');
    fs.writeFileSync(path.join(dir, 'a.res'), JSON.stringify({ pid: 999001, at: T0 }), 'utf8');
    fs.writeFileSync(path.join(dir, 'b.res'), JSON.stringify({ pid: 999002, at: T0 }), 'utf8');
    const r = countLiveReservations({ dir, now: T0, pidAlive: (p) => p === 999002 });
    assert.equal(r.ok, true);
    assert.equal(r.live, 1);
    assert.deepEqual(r.reaped, ['a.res']);            // 死的当场清掉（自愈）
    assert.equal(fs.existsSync(path.join(dir, 'a.res')), false);
  });

  it('超 TTL 的预占不占位（注入时钟，不靠真 sleep）', async () => {
    const { countLiveReservations, RESERVE_TTL_MS } = await import(CC);
    const dir = tmpHome('ttl');
    fs.writeFileSync(path.join(dir, 'old.res'), JSON.stringify({ pid: process.pid, at: T0 }), 'utf8');
    fs.writeFileSync(path.join(dir, 'new.res'), JSON.stringify({ pid: process.pid, at: T0 }), 'utf8');
    // 只把时钟推过 TTL，两条都该过期（pid 是活的，证明过期这一条判据独立生效）
    const r = countLiveReservations({ dir, now: T0 + RESERVE_TTL_MS + 1, pidAlive: () => true });
    assert.equal(r.live, 0);
    assert.equal(r.reaped.length, 2);
  });

  it('TTL 之内 + pid 活着 → 照常占位（别把活预占也清了）', async () => {
    const { countLiveReservations, RESERVE_TTL_MS } = await import(CC);
    const dir = tmpHome('live');
    fs.writeFileSync(path.join(dir, 'x.res'), JSON.stringify({ pid: process.pid, at: T0 }), 'utf8');
    const r = countLiveReservations({ dir, now: T0 + RESERVE_TTL_MS - 1, pidAlive: () => true });
    assert.equal(r.live, 1);
    assert.deepEqual(r.reaped, []);
  });

  it('形状坏了的预占当死的清掉（留着＝永久假满员，那是全盘阻塞）', async () => {
    const { countLiveReservations } = await import(CC);
    const dir = tmpHome('junk');
    fs.writeFileSync(path.join(dir, 'junk.res'), 'not json', 'utf8');
    const r = countLiveReservations({ dir, now: T0, pidAlive: () => true });
    assert.equal(r.live, 0);
    assert.deepEqual(r.reaped, ['junk.res']);
  });

  it('预占目录不在 = 0 条（查成了，不是没查成）', async () => {
    const { countLiveReservations } = await import(CC);
    const r = countLiveReservations({ dir: path.join(os.tmpdir(), 'dao-1145-nonexistent-' + Date.now()), now: T0 });
    assert.equal(r.ok, true);
    assert.equal(r.live, 0);
  });

  it('预占目录读不动 = 没查成（fail-close），不许当 0', async () => {
    const { countLiveReservations } = await import(CC);
    const r = countLiveReservations({
      dir: '/some/dir', now: T0,
      exists: () => true, readdir: () => { throw new Error('EACCES'); },
    });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
  });
});

describe('锁本身的失效面', () => {
  it('锁拿不到（超时）→ 没查成 fail-close，不带 busy', async () => {
    const { admitAndReserveChannel } = await import(CC);
    const r = admitAndReserveChannel({
      model: LUNA, now: T0, home: tmpHome('lockfail'),
      io: {
        loadRouting: () => routing(5), loadModels: () => MODELS,
        checkInFlight: () => ({ ok: true, trees: [], count: 0 }), loadJobs: () => [], loadBreaker: () => null,
      },
      lockIo: { acquire: () => ({ ok: false, error: '建树锁等超时（2000ms）' }) },
    });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
    assert.match(r.error, /占槽锁没拿到/);
  });

  it('门里收到「锁没拿到」→ MirasimUnavailableError，不标 busy（不是背压）', async () => {
    const { createRuntime } = await import(LIB);
    const rt = createRuntime({
      homeDir: '/srv', connect: async () => { throw new Error('不该连'); }, now: () => T0,
      leaseCheck: () => ({ ok: true, verdict: 'free' }),
      channelAdmit: () => ({ ok: false, unscanned: true, error: '渠道占槽锁没拿到（超时）' }),
    });
    await assert.rejects(
      () => rt.startSession({ agent: 'pi', workdir: '/srv/w', prompt: 'x', model: LUNA }),
      (e) => {
        assert.equal(e.name, 'MirasimUnavailableError');
        assert.notEqual(e.detail && e.detail.busy, true);
        return true;
      },
    );
  });

  it('每个渠道一把锁 —— 不同渠道互不阻塞（锁路径按渠道分）', async () => {
    const { reserveLockPath, reserveDir } = await import(CC);
    const home = '/h';
    assert.notEqual(reserveLockPath({ home, channel: 'gw:windsurf' }), reserveLockPath({ home, channel: 'direct:codex@pqapi' }));
    assert.notEqual(reserveDir({ home, channel: 'gw:windsurf' }), reserveDir({ home, channel: 'gw:grok' }));
  });

  it('渠道键 slug 可安全落文件名（冒号/@ 不许进路径）', async () => {
    const { channelSlug } = await import(CC);
    assert.equal(channelSlug('direct:codex@pqapi'), 'direct-codex-pqapi');
    assert.equal(channelSlug('gw:windsurf'), 'gw-windsurf');
    assert.equal(channelSlug(''), 'unknown');
  });
});
