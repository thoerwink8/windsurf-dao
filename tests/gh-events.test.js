// GitHub 事件桥的闸（#956）。
//
// 这个桥要防的坏事只有一件：**「它悄悄停了」被当成「这段时间没有事发生」。**
// 两者在事件计数上长得一模一样，都是 0。所以下面每一条断言，最后都落在
// 「没有自证 ping 就不许判绿」这一句上。
//
// 另外守两条会被顺手拆掉的东西：
//   · 兜底 timer 还在（webhook 上线了就把轮询关掉，是这单最容易犯的错）
//   · sudoers 白名单没开宽（桥能叫醒的单元只有写死的那两个）
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const toUrl = (p) => 'file://' + p.split(path.sep).join('/');
const LIB = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'gh-events.mjs')));
const CHECK = import(toUrl(path.join(ROOT, 'scripts', 'server-check.mjs')));

const MIN = 60 * 1000;
const NOW = Date.parse('2026-09-05T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

/** 一份「一切正常」的状态：桥活着、ping 刚回来。各条测试在它上面改一处。 */
function healthy(over = {}) {
  return {
    schema: 1,
    startedAt: ago(60 * MIN),
    heartbeatAt: ago(10 * 1000),
    hookId: 674864657,
    ping: { intervalMs: 10 * MIN, sentAt: ago(2 * MIN), recvAt: ago(2 * MIN) },
    lastEvent: null,
    counts: { received: 6, routed: 2, ignored: 4, malformed: 0, pings: 6 },
    triggers: {},
    ...over,
  };
}

describe('forward 的 stdout 怎么切成事件', () => {
  // 实测契约（2026-09-05，服务器上用 `1>o.log 2>e.log` 分流跑出来的）：
  //   stdout —— 只有负载，一行一个 JSON
  //   stderr —— notice: / Forwarding… / [LOG] received event "X"
  // 这条回归的来历：最早我用 `2>&1` 探，两股混一起看着像「事件名+负载两行一组」，
  // 照那个写的解析器把每一条负载都丢了（收到 4 个事件，counts.received 是 0）。
  // 所以下面这些「事件名行」全部只该出现在 stderr，喂给解析器必须当噪音忽略。
  const STDERR_ONLY = [
    'notice: no `--url` specified; printing webhook payloads to stdout',
    'Forwarding Webhook events from GitHub...',
    '[LOG] received event "ping"',
    '[LOG] received event "pull_request"',
  ];

  it('故意违规样本：把 stderr 那几行喂进来，一条都不许被当负载', async () => {
    const { createForwardParser } = await LIB;
    const p = createForwardParser();
    for (const l of STDERR_ONLY) {
      assert.equal(p.push(l), null, `「${l}」在 stderr 上，当负载解析就会记一条假的 malformed`);
    }
  });

  it('事件类型从负载自己认（事件名根本不在 stdout 上）', async () => {
    const { createForwardParser } = await LIB;
    const p = createForwardParser();
    const ping = p.push('{"zen":"Speak like a human.","hook_id":674864657}');
    assert.equal(ping.type, 'ping');
    assert.equal(ping.payload.hook_id, 674864657);

    const pr = p.push('{"action":"closed","number":930,"pull_request":{"number":930,"merged":true}}');
    assert.equal(pr.type, 'pull_request');
    assert.equal(pr.payload.number, 930);

    const rv = p.push('{"action":"submitted","review":{"state":"approved"},"pull_request":{"number":952}}');
    assert.equal(rv.type, 'pull_request_review', 'review 必须排在 pull_request 前面——它的负载里也有 pull_request');
  });

  it('认不出来的负载判 unknown，不猜成某个会触发动作的类型', async () => {
    const { eventTypeOf } = await LIB;
    assert.equal(eventTypeOf({ ref: 'refs/heads/x', commits: [] }), 'unknown');
    assert.equal(eventTypeOf({ action: 'created', comment: { id: 1 }, pull_request: { number: 9 } }), 'unknown',
      'review_comment 那一族带 comment，不是 PR 本身动了');
    assert.equal(eventTypeOf(null), 'unknown');
  });

  it('负载读不懂要显形成 malformed——「收到了但读不懂」不能等于「没收到」', async () => {
    const { createForwardParser } = await LIB;
    const ev = createForwardParser().push('{这不是 JSON');
    assert.equal(ev.malformed, true);
  });
});

describe('事件 → 叫醒谁', () => {
  it('PR 合进来了：关单 + 指挥官，两个都要', async () => {
    const { routeEvent, UNIT_CLOSE_ISSUES, UNIT_COMMANDER_ACT } = await LIB;
    const r = routeEvent({ type: 'pull_request', payload: { action: 'closed', number: 930, pull_request: { number: 930, merged: true } } });
    assert.equal(r.kind, 'pr-merged');
    assert.deepEqual(r.units, [UNIT_CLOSE_ISSUES, UNIT_COMMANDER_ACT]);
  });

  it('故意违规样本：PR 关了但没合，绝不许去关单', async () => {
    const { routeEvent, UNIT_CLOSE_ISSUES } = await LIB;
    const r = routeEvent({ type: 'pull_request', payload: { action: 'closed', number: 931, pull_request: { number: 931, merged: false } } });
    assert.ok(!r.units.includes(UNIT_CLOSE_ISSUES),
      '关单判据只认 MERGED；把「关了没合」也送去关单，等于替 close-issues 改了判据');
  });

  it('审官判定落地 → 叫指挥官（#903 那 20 分钟就是这一条补的）', async () => {
    const { routeEvent, UNIT_COMMANDER_ACT } = await LIB;
    const r = routeEvent({ type: 'pull_request_review', payload: { action: 'submitted', pull_request: { number: 952 }, review: { state: 'changes_requested' } } });
    assert.deepEqual(r.units, [UNIT_COMMANDER_ACT]);
  });

  it('ping 不触发任何动作，但要把 hook_id 交出来', async () => {
    const { routeEvent } = await LIB;
    const r = routeEvent({ type: 'ping', payload: { hook_id: 42 } });
    assert.deepEqual(r.units, []);
    assert.equal(r.hookId, 42);
  });

  it('没订的事件不许凭空叫人', async () => {
    const { routeEvent } = await LIB;
    for (const t of ['push', 'issues', 'star', 'workflow_run']) {
      assert.deepEqual(routeEvent({ type: t, payload: {} }).units, [], `${t} 不在判据表里`);
    }
  });

  it('订阅清单里每一类都得有人用——订了没人用的事件只会让 act 白醒', async () => {
    const { FORWARD_EVENTS, routeEvent } = await LIB;
    assert.ok(FORWARD_EVENTS.length > 0, '订阅清单空了，桥收不到任何东西');
    const used = new Set();
    const samples = [
      { type: 'pull_request', payload: { action: 'opened', number: 1 } },
      { type: 'pull_request_review', payload: { action: 'submitted', pull_request: { number: 1 } } },
    ];
    for (const s of samples) if (routeEvent(s).units.length) used.add(s.type);
    for (const t of FORWARD_EVENTS) {
      assert.ok(used.has(t), `订了 ${t} 却没有任何一行判据用它——要么补判据，要么别订`);
    }
  });
});

describe('叫醒节流：不丢事件，也不让 act 连轴转', () => {
  it('从没叫过 → 立刻叫（首发不等，端到端延迟才做得到秒级）', async () => {
    const { planTrigger } = await LIB;
    assert.deepEqual(planTrigger({ lastFiredAt: null, now: NOW }), { fire: true, scheduleAt: null });
  });

  it('冷却期内 → 不立刻叫，但要排一次补发（丢了就等于没收到这条事件）', async () => {
    const { planTrigger } = await LIB;
    const r = planTrigger({ lastFiredAt: NOW - 10 * 1000, now: NOW, cooldownMs: 60 * 1000 });
    assert.equal(r.fire, false);
    assert.equal(r.scheduleAt, NOW + 50 * 1000, '补发时刻要落在冷却期末，不能直接丢弃');
  });

  it('冷却过了 → 再叫', async () => {
    const { planTrigger } = await LIB;
    assert.equal(planTrigger({ lastFiredAt: NOW - 90 * 1000, now: NOW, cooldownMs: 60 * 1000 }).fire, true);
  });
});

describe('三态：ok / red / unscanned', () => {
  it('反证：一切正常时判绿——判据不是恒红', async () => {
    const { classifyGhEventBridge } = await LIB;
    assert.equal(classifyGhEventBridge({ probed: true, state: healthy(), now: NOW }).state, 'ok');
  });

  it('故意违规样本：桥停了但状态文件还在——必须红，不许当「没有事发生」', async () => {
    const { classifyGhEventBridge } = await LIB;
    const r = classifyGhEventBridge({ probed: true, state: healthy({ heartbeatAt: ago(30 * MIN) }), now: NOW });
    assert.equal(r.state, 'red');
    assert.match(r.detail, /心跳|不在守着/, '要说清是「它停了」，不是「没事发生」');
  });

  it('故意违规样本：进程活着但 ping 早就不回来了——通道断了，也是红', async () => {
    const { classifyGhEventBridge } = await LIB;
    const r = classifyGhEventBridge({
      probed: true, now: NOW,
      state: healthy({ ping: { intervalMs: 10 * MIN, sentAt: ago(1 * MIN), recvAt: ago(90 * MIN) } }),
    });
    assert.equal(r.state, 'red');
    assert.match(r.detail, /送不进来|没事/, '要点破「别把它当这段时间没事」');
  });

  it('这一单的核心：0 个事件 + ping 通 = 绿；0 个事件 + 没 ping = 不绿', async () => {
    const { classifyGhEventBridge } = await LIB;
    const quiet = healthy({ counts: { received: 0, routed: 0, ignored: 0, malformed: 0, pings: 0 }, lastEvent: null });
    assert.equal(classifyGhEventBridge({ probed: true, state: quiet, now: NOW }).state, 'ok',
      'ping 回得来就说明通道通着，此时 0 个事件是真的没事');

    const noSample = healthy({
      startedAt: ago(60 * MIN),
      ping: { intervalMs: 10 * MIN, sentAt: ago(9 * MIN), recvAt: null },
      counts: { received: 0, routed: 0, ignored: 0, malformed: 0, pings: 0 },
    });
    assert.notEqual(classifyGhEventBridge({ probed: true, state: noSample, now: NOW }).state, 'ok',
      '一个样本都没扫到就判绿，正是「没查成」被当成「查过没事」');
  });

  it('刚起步还没收到第一个 ping → unknown，不是红（别在启动那几十秒刷噪音）', async () => {
    const { classifyGhEventBridge } = await LIB;
    const boot = healthy({ startedAt: ago(20 * 1000), heartbeatAt: ago(1000), ping: { intervalMs: 10 * MIN, sentAt: null, recvAt: null } });
    assert.equal(classifyGhEventBridge({ probed: true, state: boot, now: NOW }).state, 'unknown');
  });

  it('没探到 / 读不出对象 → unknown，绝不当绿', async () => {
    const { classifyGhEventBridge } = await LIB;
    assert.equal(classifyGhEventBridge({ probed: false, reason: '没装' }).state, 'unknown');
    assert.equal(classifyGhEventBridge({ probed: true, state: null }).state, 'unknown');
    assert.equal(classifyGhEventBridge({ probed: true, state: 'nope' }).state, 'unknown');
    assert.equal(classifyGhEventBridge({ probed: true, state: {} }).state, 'unknown', '没有心跳时刻就判不了死活');
  });

  // 长连接自己会断，而「断了」和「没有事发生」长得一模一样——这单最该防的形状。
  // 断得干脆（ping 收不回来）上面那条已经拦下了；难的是**断断续续**：
  // 每次能连上几分钟，ping 照样偶尔回得来，所有判据都放行，而断开窗口里的事件真丢了
  // （GitHub 不补投）。所以另立一格看重连频率。
  it('故意违规样本：长连接一小时断 8 次——ping 还回得来，也必须红', async () => {
    const { classifyGhEventBridge } = await LIB;
    const exits = [];
    for (let i = 1; i <= 8; i++) exits.push(ago(i * 6 * MIN));
    const r = classifyGhEventBridge({
      probed: true, now: NOW, state: healthy({ forward: { restarts: 8, recentExits: exits } }),
    });
    assert.equal(r.state, 'red', 'ping 通不代表没丢事——断开窗口里的事件 GitHub 不会补投');
    assert.match(r.detail, /断了 8 次|丢事/);
  });

  it('反证：偶尔断一两次不算抽风，否则这格会天天红成噪音', async () => {
    const { classifyGhEventBridge } = await LIB;
    const r = classifyGhEventBridge({
      probed: true, now: NOW,
      state: healthy({ forward: { restarts: 9, recentExits: [ago(5 * MIN), ago(50 * MIN), ago(5 * 60 * MIN)] } }),
    });
    assert.equal(r.state, 'ok', '近一小时只断了 2 次，且累计 9 次是几个月攒的——不是抽风');
    assert.match(r.detail, /重连 2 次/, '虽然判绿，也要把重连次数摆出来给人看见');
  });

  it('重连退避写进红项详情——告警可见', async () => {
    const { classifyGhEventBridge } = await LIB;
    const r = classifyGhEventBridge({
      probed: true, now: NOW,
      state: healthy({
        ping: { intervalMs: 10 * MIN, sentAt: ago(1 * MIN), recvAt: ago(90 * MIN) },
        forward: { attempt: 12, backoffMs: 5 * MIN, atCap: true, restarts: 12, recentExits: [] },
      }),
    });
    assert.equal(r.state, 'red');
    assert.match(r.detail, /重连第 12 次/);
    assert.match(r.detail, /已到上界/);
  });

  it('故意违规样本：事件收到了却叫不动单元（sudoers 没装）——红，且点名是哪个', async () => {
    const { classifyGhEventBridge } = await LIB;
    const r = classifyGhEventBridge({
      probed: true, now: NOW,
      state: healthy({ triggers: { 'dao-close-issues.service': { lastAt: ago(1 * MIN), fails: 3, lastError: 'sudo: a password is required' } } }),
    });
    assert.equal(r.state, 'red');
    assert.match(r.detail, /dao-close-issues\.service/);
  });

  it('server-check 也能拿到同一把尺（㉓ 接线了没）', async () => {
    const S = await CHECK;
    assert.equal(typeof S.classifyGhEventBridge, 'function', 'server-check 没 re-export，㉓ 那一格就是空的');
    assert.equal(Array.isArray(S.CHECKS), true, 'CHECKS 不是数组，接线无从查');
    const wired = S.CHECKS.filter(([n]) => /GitHub 事件桥/.test(n)).map(([n]) => n);
    assert.deepEqual(wired, ['(23) GitHub 事件桥在守着（自证 ping 通，#956）'],
      'CHECKS 里没有事件桥那一格——re-export 了函数但没人调，等于没接线');
    assert.equal(S.classifyGhEventBridge({ probed: true, state: healthy(), now: NOW }).state, 'ok');
  });
});

describe('兜底与权限：两样最容易被顺手拆掉的东西', () => {
  it('低频轮询兜底必须还在——webhook 会丢，桥停了要有人接住', () => {
    const dir = path.join(ROOT, 'host', 'machine', 'systemd');
    const timers = fs.readdirSync(dir).filter((f) => f.endsWith('.timer'));
    assert.ok(timers.length > 0, '一个 timer 都没扫到，本闸判据已失效');
    assert.ok(timers.includes('dao-close-issues.timer'),
      '关单的兜底轮询没了——webhook 一丢，合进来的 PR 就再也没人关单');
  });

  it('事件桥单元存在，且没把自己写成 root（能写仓的 agent 会顺着它提权）', () => {
    const f = path.join(ROOT, 'host', 'machine', 'systemd', 'dao-gh-events.service');
    assert.ok(fs.existsSync(f), '事件桥单元不在仓里，装机时没有东西可装');
    const t = fs.readFileSync(f, 'utf8');
    assert.match(t, /^User=orca$/m, '不写 User= 就是 root，而 ExecStart 指的是 orca 可写的仓');
    assert.match(t, /^Restart=always$/m, '桥挂了没人拉起来，就退化成纯轮询且无声');
  });

  it('故意违规样本：sudoers 白名单不许带通配，也不许指家目录', () => {
    const f = path.join(ROOT, 'host', 'machine', 'sudoers.d', 'dao-gh-events');
    assert.ok(fs.existsSync(f), '白名单不在——桥收到事件也叫不动任何单元');
    const rules = fs.readFileSync(f, 'utf8').split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#'));
    assert.ok(rules.length > 0, '一条规则都没有，扫出 0 条不算通过');
    for (const r of rules) {
      assert.ok(!/[*?]/.test(r), `带通配等于把「能起任何单元」给了 orca：${r}`);
      assert.match(r, /NOPASSWD:\s*\/usr\/bin\/systemctl start --no-block \S+\.service$/,
        `只许 start 写死的单元，多一个动词就是多一条提权路：${r}`);
      assert.ok(!/\/home\//.test(r), `白名单指向家目录 = 指向可写的地方，收窄就白收了：${r}`);
    }
  });

  it('白名单里的单元名，和判据表要叫的那两个对得上', async () => {
    const { UNIT_CLOSE_ISSUES, UNIT_COMMANDER_ACT } = await LIB;
    const text = fs.readFileSync(path.join(ROOT, 'host', 'machine', 'sudoers.d', 'dao-gh-events'), 'utf8');
    for (const u of [UNIT_CLOSE_ISSUES, UNIT_COMMANDER_ACT]) {
      assert.ok(text.includes(u), `代码要叫 ${u}，白名单里没有它——事件到了会静默失败`);
    }
  });

  // 2026-09-05 实测：pkill 掉桥之后，子进程 `gh webhook forward` **活了下来**，
  // 连接还在、它建的 hook 还挂在仓上。GitHub 一个仓上限 20 个 hook，而单元是 Restart=always，
  // 这种孤儿每积一个占一个名额；占满之后桥起得来、心跳照跳，就是一个事件都收不到——无声。
  // （反证也测了：两个进程都 SIGKILL 时 hook 自己就没了，连接一断 GitHub 那边自己收摊。
  //   所以要防的是孤儿，不是硬杀——别照直觉写成「硬杀会漏」。）
  it('单元必须让整个 cgroup 都收到 SIGTERM，否则 forward 变孤儿、hook 占着名额不放', () => {
    const t = fs.readFileSync(path.join(ROOT, 'host', 'machine', 'systemd', 'dao-gh-events.service'), 'utf8');
    const mode = (t.match(/^KillMode=(.+)$/m) || [])[1];
    assert.ok(mode, '没写 KillMode——默认值虽然对，但改错的代价是隐性的，要写出来');
    assert.equal(mode.trim(), 'control-group',
      'mixed 只把 SIGTERM 给主进程，gh webhook forward 会活下来变孤儿，连接和 hook 都还在');
  });

  it('桥不许再宽扫全部 forwarder hook——归属函数必须接上', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'gh-event-bridge.mjs'), 'utf8');
    assert.equal(/staleForwarderHooks/.test(src), false, '宽扫函数还在，09-16 补修就是要拆掉它');
    assert.match(src, /ownInvalidHookIds/);
    assert.match(src, /claimLiveHook/);
    assert.match(src, /isolateOrphanAfterSweep/);
    assert.match(src, /skipHookIds/);
    assert.match(src, /planReconnectBackoff/);
    assert.match(src, /shouldSpawnForward/);
    assert.equal(/if \(state\.hookId == null\) return;/.test(src), false,
      'hookId 为空直接 return，就是 03:54 要人补 ping 的那条');
    assert.equal(/setTimeout\(startForward,\s*5000\)/.test(src), false,
      '5 秒无上界重连还在，17709 次还会再来');
  });

  it('桥不许起本地监听：一旦改回 --url，签名校验就必须补回来', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'gh-event-bridge.mjs'), 'utf8');
    assert.ok(!/createServer|--url=/.test(src),
      '出现了本地监听/--url——那才真有一个「谁都能 POST 进来」的口子，必须同时加 X-Hub-Signature-256 校验');
  });
});

describe('2026-09-16 补修：EOF 孤儿 hook 与初始 ping 丢失', () => {
  const FWD = 'https://webhook-forwarder.github.com/abc';
  const OWN_EVENTS = ['pull_request', 'pull_request_review'];
  const SPAWN = '2026-09-14T22:21:00.000Z';
  const hook = ({ id, url = FWD, events = OWN_EVENTS, created_at = '2026-09-14T22:21:05.000Z' }) => ({
    id, events, created_at, config: { url },
  });
  const ownOrphan = hook({ id: 679102785 });
  const foreignLive = hook({ id: 111, created_at: '2026-09-10T00:00:00.000Z' });
  const ci = hook({ id: 2, url: 'https://ci.example.com/gh', events: ['push'] });
  const otherForwarder = hook({
    id: 222,
    url: 'https://webhook-forwarder.github.com/other',
    events: ['push', '*'],
    created_at: '2026-09-14T22:21:08.000Z',
  });

  it('反例：EOF 遗留自家 hook，别人的活 hook 和 CI hook 都不许删', async () => {
    const { ownInvalidHookIds } = await LIB;
    const ids = ownInvalidHookIds({
      hooks: [ownOrphan, foreignLive, ci, otherForwarder],
      ownedHookId: 679102785,
      liveHookId: null,
    });
    assert.deepEqual(ids, [679102785]);
  });

  it('故意违规样本：没有归属证据时，即使全是 forwarder 也不许宽扫', async () => {
    const { ownInvalidHookIds } = await LIB;
    const ids = ownInvalidHookIds({
      hooks: [ownOrphan, foreignLive, ci],
      ownedHookId: null,
      liveHookId: null,
      spawnAt: null,
    });
    assert.deepEqual(ids, [], '旧 staleForwarderHooks 会返回 [679102785, 111]，那就是误伤');
  });

  it('当前桥的 live hook 即使也是 owned，不许删', async () => {
    const { ownInvalidHookIds } = await LIB;
    const ids = ownInvalidHookIds({
      hooks: [ownOrphan, ci],
      ownedHookId: 679102785,
      liveHookId: 679102785,
    });
    assert.deepEqual(ids, []);
  });

  it('故意违规样本：没有 ownedHookId 时，时间窗口内唯一同形 hook 也不许删', async () => {
    const { ownInvalidHookIds } = await LIB;
    const ids = ownInvalidHookIds({
      hooks: [ownOrphan, foreignLive, ci],
      ownedHookId: null,
      liveHookId: null,
      spawnAt: SPAWN,
    });
    assert.deepEqual(ids, [], 'created_at/host/events 在另一台机器上也一样，不能当归属证据');
  });

  it('故意违规样本：启动后出现两根自家形态的 hook，认不出哪根——全都不删', async () => {
    const { ownInvalidHookIds } = await LIB;
    const twin = hook({ id: 679871907, created_at: '2026-09-14T22:21:06.000Z' });
    const ids = ownInvalidHookIds({
      hooks: [ownOrphan, twin, ci],
      ownedHookId: null,
      liveHookId: null,
      spawnAt: SPAWN,
    });
    assert.deepEqual(ids, []);
  });

  it('查不到清单就别删——没查成不是「没有」', async () => {
    const { ownInvalidHookIds } = await LIB;
    assert.deepEqual(ownInvalidHookIds({ hooks: null, ownedHookId: 679102785 }), []);
    assert.deepEqual(ownInvalidHookIds({ hooks: [], ownedHookId: 679102785 }), []);
  });

  it('子串撞 FORWARDER_HOST 的假地址不许认', async () => {
    const { isForwarderUrl, isOwnForwarderHook } = await LIB;
    assert.equal(isForwarderUrl('https://evil.example/webhook-forwarder.github.com'), false);
    assert.equal(isOwnForwarderHook(hook({
      id: 9,
      url: 'https://evil.example/webhook-forwarder.github.com',
    })), false);
  });

  it('有 ownedHookId 且清单对得上，才认领', async () => {
    const { claimLiveHook } = await LIB;
    assert.equal(claimLiveHook({
      hooks: [ownOrphan, foreignLive, ci],
      ownedHookId: 679102785,
    }), 679102785);
  });

  it('故意违规样本：没有 ownedHookId 时，时间窗口内唯一同形 hook 也不许认领', async () => {
    const { claimLiveHook } = await LIB;
    const id = claimLiveHook({
      hooks: [ownOrphan, foreignLive, ci],
      ownedHookId: null,
      spawnAt: SPAWN,
    });
    assert.equal(id, null, '初始 ping 丢失只能保持 unresolved，不许凭时间窗口猜');
  });

  it('认不出时 claim 返回 null——不猜别人的活 hook', async () => {
    const { claimLiveHook } = await LIB;
    assert.equal(claimLiveHook({ hooks: [foreignLive, ci], ownedHookId: null, spawnAt: SPAWN }), null);
    assert.equal(claimLiveHook({ hooks: null, spawnAt: SPAWN }), null);
    assert.equal(claimLiveHook({ hooks: [ownOrphan, hook({ id: 679871907 })], spawnAt: SPAWN }), null);
  });

  it('反例：外部桥在本次时间窗口创建、且它是唯一候选——不许删、不许认领', async () => {
    const { ownInvalidHookIds, claimLiveHook } = await LIB;
    const foreignNow = hook({
      id: 777,
      created_at: '2026-09-14T22:21:05.000Z',
    });
    assert.deepEqual(ownInvalidHookIds({
      hooks: [foreignNow],
      ownedHookId: null,
      liveHookId: null,
      spawnAt: SPAWN,
    }), [], '审官复现：唯一候选 777 仍是外部 hook，不能删');
    assert.equal(claimLiveHook({
      hooks: [foreignNow],
      ownedHookId: null,
      spawnAt: SPAWN,
    }), null, '审官复现：唯一候选 777 仍是外部 hook，不能认领');
  });

  it('反例：DELETE 失败后旧 orphanHookId 不许再当新桥 ping 目标', async () => {
    const { isolateOrphanAfterSweep, claimLiveHook } = await LIB;
    const oldHook = hook({ id: 100, created_at: '2026-09-14T22:21:05.000Z' });
    const newHook = hook({ id: 200, created_at: '2026-09-14T22:22:05.000Z' });
    const iso = isolateOrphanAfterSweep({
      orphanHookId: 100,
      listed: true,
      deletedIds: [],
      failedIds: [100],
      remainingIds: [100, 200],
    });
    assert.equal(iso.orphanHookId, null);
    assert.equal(iso.isolated, true);
    assert.match(iso.why, /删除失败/);
    assert.equal(claimLiveHook({
      hooks: [oldHook, newHook],
      ownedHookId: iso.orphanHookId,
      spawnAt: '2026-09-14T22:22:00.000Z',
    }), null, '隔离后不得认领旧 100；新 200 仅凭时间/host/events 也不认');
    assert.equal(claimLiveHook({
      hooks: [oldHook, newHook],
      ownedHookId: 100,
      skipHookIds: [100],
    }), null, '即使调用方忘了清空，skipHookIds 也要挡住旧 ID');
  });

  it('清单没查成或旧 ID 仍在清单里，都要隔离 orphan', async () => {
    const { isolateOrphanAfterSweep } = await LIB;
    const unknown = isolateOrphanAfterSweep({
      orphanHookId: 100,
      listed: false,
      remainingIds: null,
    });
    assert.equal(unknown.orphanHookId, null);
    assert.match(unknown.why, /清单没查成/);

    const stillThere = isolateOrphanAfterSweep({
      orphanHookId: 100,
      listed: true,
      deletedIds: [],
      failedIds: [],
      remainingIds: [100, 200],
    });
    assert.equal(stillThere.orphanHookId, null);
    assert.match(stillThere.why, /清单仍含旧 hook/);

    const swept = isolateOrphanAfterSweep({
      orphanHookId: 100,
      listed: true,
      deletedIds: [100],
      failedIds: [],
      remainingIds: [200],
    });
    assert.equal(swept.orphanHookId, null);
    assert.equal(swept.isolated, true);
  });

  it('认下后 ping 404：失效不沿用', async () => {
    const { interpretHookPingResult } = await LIB;
    const gone = interpretHookPingResult({
      status: 1,
      stderr: 'gh: Not Found (HTTP 404)\n{"message":"Not Found"}',
    });
    assert.equal(gone.ok, false);
    assert.equal(gone.gone, true);

    const ok = interpretHookPingResult({ status: 0, stderr: '', stdout: '' });
    assert.equal(ok.ok, true);
    assert.equal(ok.gone, false);

    const transient = interpretHookPingResult({ status: 1, stderr: 'gh: API rate limit (HTTP 403)' });
    assert.equal(transient.ok, false);
    assert.equal(transient.gone, false);
  });

  it('退避有上界：第 20 次也不会短过 cap，不会 5 秒一次打到 17709 次', async () => {
    const { planReconnectBackoff, RECONNECT_BASE_MS, RECONNECT_CAP_MS } = await LIB;
    const first = planReconnectBackoff({ attempt: 0 });
    assert.equal(first.delayMs, RECONNECT_BASE_MS);
    assert.equal(first.atCap, false);
    const late = planReconnectBackoff({ attempt: 20 });
    assert.equal(late.delayMs, RECONNECT_CAP_MS);
    assert.equal(late.atCap, true);
    assert.equal(late.delayMs >= RECONNECT_CAP_MS, true);
  });

  it('当前桥还活着不许再 spawn 第二条', async () => {
    const { shouldSpawnForward } = await LIB;
    assert.deepEqual(shouldSpawnForward({ childAlive: true, stopping: false }), {
      spawn: false, why: '当前桥还在，不启第二桥',
    });
    assert.deepEqual(shouldSpawnForward({ childAlive: false, stopping: true }), {
      spawn: false, why: '正在停',
    });
    assert.deepEqual(shouldSpawnForward({ childAlive: false, stopping: false }), {
      spawn: true, why: null,
    });
  });
});

describe('2026-09-16 补修：外部信号退出不得假活', () => {
  async function liveChild() {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return child;
  }

  function waitExit(child, ms = 8000) {
    return new Promise((resolve, reject) => {
      if (child.exitCode != null || child.signalCode != null) {
        return resolve({ code: child.exitCode, signal: child.signalCode });
      }
      const t = setTimeout(() => reject(new Error(`子进程 ${child.pid} 等退出超时`)), ms);
      child.once('exit', (code, signal) => {
        clearTimeout(t);
        resolve({ code, signal });
      });
    });
  }

  function reap(child) {
    if (!child || child.exitCode != null || child.signalCode != null) return;
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已经不在 */ }
  }

  it('事故原样：exitCode=null、killed=false、signalCode=SIGTERM → 必须判死并允许重连', async () => {
    const { isChildAlive, shouldSpawnForward } = await LIB;
    const ghost = { exitCode: null, killed: false, signalCode: 'SIGTERM' };
    assert.equal(isChildAlive(ghost), false);
    assert.deepEqual(shouldSpawnForward({ childAlive: isChildAlive(ghost), stopping: false }), {
      spawn: true, why: null,
    });
  });

  it('审官复现：exitCode=null、signalCode=null、killed=true → 仍算活着，不得再 spawn', async () => {
    const { isChildAlive, shouldSpawnForward } = await LIB;
    const midKill = { exitCode: null, signalCode: null, killed: true };
    assert.equal(isChildAlive(midKill), true);
    assert.deepEqual(shouldSpawnForward({ childAlive: isChildAlive(midKill), stopping: false }), {
      spawn: false, why: '当前桥还在，不启第二桥',
    });
    assert.deepEqual(shouldSpawnForward({ childAlive: isChildAlive(midKill), stopping: true }), {
      spawn: false, why: '正在停',
    });
  });

  it('发出 child.kill 后、exit 事件前：真实子进程仍活着，不得再 spawn', async () => {
    const { isChildAlive, shouldSpawnForward } = await LIB;
    // 忽略 SIGTERM，把「已发信号、尚未退出」窗口拉长到可断言。
    const child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    try {
      assert.equal(isChildAlive(child), true);
      assert.equal(child.kill('SIGTERM'), true);
      assert.equal(child.killed, true);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      assert.equal(isChildAlive(child), true);
      assert.deepEqual(shouldSpawnForward({ childAlive: isChildAlive(child), stopping: false }), {
        spawn: false, why: '当前桥还在，不启第二桥',
      });
      assert.deepEqual(shouldSpawnForward({ childAlive: isChildAlive(child), stopping: true }), {
        spawn: false, why: '正在停',
      });
    } finally {
      reap(child);
      await waitExit(child).catch(() => {});
    }
  });

  it('外部 SIGTERM：真实子进程 exitCode 仍 null、killed 仍 false，必须判死并允许重连', async () => {
    const { isChildAlive, shouldSpawnForward } = await LIB;
    const child = await liveChild();
    try {
      assert.equal(isChildAlive(child), true);
      process.kill(child.pid, 'SIGTERM');
      const exited = await waitExit(child);
      assert.equal(exited.signal, 'SIGTERM');
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, 'SIGTERM');
      assert.equal(child.killed, false);
      assert.equal(isChildAlive(child), false);
      assert.deepEqual(shouldSpawnForward({ childAlive: isChildAlive(child), stopping: false }), {
        spawn: true, why: null,
      });
    } finally {
      reap(child);
    }
  });

  it('外部 SIGKILL：真实子进程同样判死并允许重连', async () => {
    const { isChildAlive, shouldSpawnForward } = await LIB;
    const child = await liveChild();
    try {
      process.kill(child.pid, 'SIGKILL');
      const exited = await waitExit(child);
      assert.equal(exited.signal, 'SIGKILL');
      assert.equal(child.exitCode, null);
      assert.equal(child.killed, false);
      assert.equal(isChildAlive(child), false);
      assert.deepEqual(shouldSpawnForward({ childAlive: isChildAlive(child), stopping: false }), {
        spawn: true, why: null,
      });
    } finally {
      reap(child);
    }
  });

  it('正常 exit：真实子进程判死并允许重连', async () => {
    const { isChildAlive, shouldSpawnForward } = await LIB;
    const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
    try {
      const exited = await waitExit(child);
      assert.equal(exited.code, 7);
      assert.equal(child.exitCode, 7);
      assert.equal(child.signalCode, null);
      assert.equal(isChildAlive(child), false);
      assert.deepEqual(shouldSpawnForward({ childAlive: isChildAlive(child), stopping: false }), {
        spawn: true, why: null,
      });
    } finally {
      reap(child);
    }
  });

  it('存活子进程不得再 spawn 第二条', async () => {
    const { isChildAlive, shouldSpawnForward } = await LIB;
    const child = await liveChild();
    try {
      assert.equal(isChildAlive(child), true);
      assert.deepEqual(shouldSpawnForward({ childAlive: isChildAlive(child), stopping: false }), {
        spawn: false, why: '当前桥还在，不启第二桥',
      });
    } finally {
      reap(child);
      await waitExit(child).catch(() => {});
    }
  });

  it('停止过程：即使真实子进程已死也不许重连', async () => {
    const { isChildAlive, shouldSpawnForward } = await LIB;
    const child = await liveChild();
    try {
      process.kill(child.pid, 'SIGTERM');
      await waitExit(child);
      assert.equal(isChildAlive(child), false);
      assert.deepEqual(shouldSpawnForward({ childAlive: isChildAlive(child), stopping: true }), {
        spawn: false, why: '正在停',
      });
    } finally {
      reap(child);
    }
  });

  it('观测边界：forward 刚被打死但 ping 还新 → classify 仍绿（靠重连，不靠立刻判红）', async () => {
    const { classifyGhEventBridge } = await LIB;
    const r = classifyGhEventBridge({
      probed: true, now: NOW,
      state: healthy({
        forward: {
          restarts: 1,
          lastExitAt: ago(5 * 1000),
          lastExitCode: null,
          lastExitSignal: 'SIGTERM',
          recentExits: [ago(5 * 1000)],
        },
      }),
    });
    assert.equal(r.state, 'ok');
    assert.match(r.detail, /在守着/);
  });

  it('桥必须用 lib 的 isChildAlive；本地假活判据和 stop 忽略 signalCode 都不许还在', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'gh-event-bridge.mjs'), 'utf8');
    const lib = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'gh-events.mjs'), 'utf8');
    assert.match(lib, /export function isChildAlive/);
    assert.match(lib, /signalCode/);
    assert.equal(/if \(c\.killed\) return false/.test(lib), false);
    assert.match(src, /isChildAlive/);
    assert.equal(/function isChildAlive/.test(src), false);
    assert.equal(/exitCode === null && !c\.killed/.test(src), false);
    assert.match(src, /signalCode/);
  });
});

