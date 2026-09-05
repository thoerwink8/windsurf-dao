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

  it('故意违规样本：事件收到了却叫不动单元（sudoers 没装）——红，且点名是哪个', async () => {
    const { classifyGhEventBridge } = await LIB;
    const r = classifyGhEventBridge({
      probed: true, now: NOW,
      state: healthy({ triggers: { 'dao-close-issues.service': { lastAt: ago(1 * MIN), fails: 3, lastError: 'sudo: a password is required' } } }),
    });
    assert.equal(r.state, 'red');
    assert.match(r.detail, /dao-close-issues\.service/);
  });

  it('server-check 也能拿到同一把尺（㉑ 接线了没）', async () => {
    const S = await CHECK;
    assert.equal(typeof S.classifyGhEventBridge, 'function', 'server-check 没 re-export，㉑ 那一格就是空的');
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

  it('孤儿留下的 hook，下次启动要扫掉——只扫 forwarder 那种，别的一根汗毛不许碰', async () => {
    const B = await import(toUrl(path.join(ROOT, 'scripts', 'gh-event-bridge.mjs')));
    const hooks = [
      { id: 1, config: { url: 'https://webhook-forwarder.github.com/hook' } },
      { id: 2, config: { url: 'https://ci.example.com/gh' } },      // 别人的，不许动
      { id: 3, config: {} },                                         // 没有 url，不许猜
      { id: 4, config: { url: 'https://webhook-forwarder.github.com/hook' } },
    ];
    assert.deepEqual(B.staleForwarderHooks(hooks), [1, 4]);
    assert.deepEqual(B.staleForwarderHooks(null), [], '查不到清单就别删——没查成不是「没有」');
    assert.deepEqual(B.staleForwarderHooks([]), []);
  });

  it('桥不许起本地监听：一旦改回 --url，签名校验就必须补回来', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'gh-event-bridge.mjs'), 'utf8');
    assert.ok(!/createServer|--url=/.test(src),
      '出现了本地监听/--url——那才真有一个「谁都能 POST 进来」的口子，必须同时加 X-Hub-Signature-256 校验');
  });
});
