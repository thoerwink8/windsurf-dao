// tests/escalate-roundtrip.test.js —— PR #1070 审官第 3 轮两条红项的回归闸
//
// 红①：runActions() 在执行中动态产生 escalate 动作（dispatch-unscanned / rework-failed…），
//      但轮末 reconcileEscalations 只拿到 decide 的静态数组。后果有两个，都不响铃：
//        · 连续计数每轮归零 → 「连续 N 轮才开单」那条路永远走不到第 N 轮；
//        · 已有的同因 OPEN 单被判成「本轮已消失」→ 自动关掉。
// 红②：账本没这条键但 GitHub 上已有单时，只写了本地账本、没在单上留言。
//      「状态文件丢了 / 换机」之后，新对象永远不会出现在用户看的那张单里。
//
// 两条都配了判别性实验：把修法退回旧行为，断言当场变红。

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// 必须在 import 之前设：STATE_DIR 是模块加载时读的，晚一步就写进真的 ~/.dao。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'escalate-roundtrip-'));
process.env.COMMANDER_STATE_DIR = TMP;

const { describe, it } = require('node:test');
const assert = require('node:assert');

const CMD = import('file://' + path.join(__dirname, '..', 'scripts', 'commander.mjs').replace(/\\/g, '/'));
const LIB = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'escalate-group.mjs').replace(/\\/g, '/'));

/** 轮末收敛的真实入口口径：从一批动作里挑出 escalate 的原因名。 */
const reasonsOf = (actions) => actions
  .filter((a) => a && a.kind === 'escalate' && a.reason)
  .map((a) => String(a.reason));

describe('红①：执行中动态产生的升级原因必须回到轮末收敛', () => {
  it('派工「没查成」产生的升级动作进 generated', async () => {
    const { runActions } = await CMD;
    const ran = runActions([{ kind: 'dispatch', issue: 900 }], {
      exec: (a) => (a.kind === 'dispatch' ? { ok: false, unscanned: true, error: '落盘超时' } : { ok: true }),
    });
    assert.equal(ran.generated.length, 1);
    assert.equal(ran.generated[0].kind, 'escalate');
    assert.equal(ran.generated[0].reason, 'dispatch-unscanned');
    assert.equal(ran.generated[0].issue, 900);
  });

  it('返工失败产生的是 rework-failed，且带 PR 号', async () => {
    const { runActions } = await CMD;
    const ran = runActions([{ kind: 'rework', issue: 900, pr: 901 }], {
      exec: (a) => (a.kind === 'rework' ? { ok: false, error: '模型不在选型' } : { ok: true }),
    });
    assert.equal(ran.generated.length, 1);
    assert.equal(ran.generated[0].reason, 'rework-failed');
    assert.equal(ran.generated[0].pr, 901);
  });

  it('背压（busy）不产生升级动作——拦下不是失败，不报帅', async () => {
    const { runActions } = await CMD;
    const ran = runActions([{ kind: 'dispatch', issue: 900 }], {
      exec: (a) => (a.kind === 'dispatch' ? { ok: false, busy: true, error: '租约被占' } : { ok: true }),
    });
    assert.deepEqual(ran.generated, []);
  });

  it('派成了也不产生升级动作', async () => {
    const { runActions } = await CMD;
    const ran = runActions([{ kind: 'dispatch', issue: 900 }], { exec: () => ({ ok: true }) });
    assert.deepEqual(ran.generated, []);
  });

  it('连跑三轮：连续计数真的累到 3，且已有 OPEN 单一轮都没被误关', async () => {
    const { runActions } = await CMD;
    const { reconcileEscalationRound } = await LIB;
    const ledger = { 'escalate/dispatch-unscanned': { issue: 999, objects: ['issue #900'] } };
    const actions = [{ kind: 'dispatch', issue: 900 }];
    const exec = (a) => (a.kind === 'dispatch' ? { ok: false, unscanned: true, error: '落盘超时' } : { ok: true });

    let streak = {};
    const closedPerRound = [];
    const streakPerRound = [];
    for (let round = 1; round <= 3; round += 1) {
      const ran = runActions(actions, { exec });
      const r = reconcileEscalationRound({
        reasonsThisRound: reasonsOf([...actions, ...ran.generated]),
        streak,
        ledger,
        allScanned: true,
      });
      streak = r.streak;
      closedPerRound.push(r.toClose.length);
      streakPerRound.push(streak['dispatch-unscanned']);
    }
    assert.deepEqual(streakPerRound, [1, 2, 3], '连续计数没累起来：第 3 轮开单那条路永远走不到');
    assert.deepEqual(closedPerRound, [0, 0, 0], '已有 OPEN 单被误判成「本轮已消失」关掉了');
  });

  // 判别性实验：把输入退回「只喂 decide 的静态数组」（红①的旧行为），必须当场变红。
  it('只喂静态动作（旧行为）就会：计数归零 + 已有单被误关', async () => {
    const { runActions } = await CMD;
    const { reconcileEscalationRound } = await LIB;
    const ledger = { 'escalate/dispatch-unscanned': { issue: 999, objects: ['issue #900'] } };
    const actions = [{ kind: 'dispatch', issue: 900 }];
    runActions(actions, { exec: () => ({ ok: false, unscanned: true, error: '落盘超时' }) });
    const r = reconcileEscalationRound({
      reasonsThisRound: reasonsOf(actions), // ← 少了 ran.generated，就是修之前的样子
      streak: {},
      ledger,
      allScanned: true,
    });
    assert.equal(r.streak['dispatch-unscanned'], undefined, '旧行为下计数本就不该涨——夹具失真了');
    assert.equal(r.toClose.length, 1, '旧行为下已有单本该被误关——夹具失真了');
    assert.equal(r.toClose[0].issue, 999);
  });
});

describe('红②：无账本 + 已有 OPEN 单 + 新对象 → 必须真的在单上留言', () => {
  const ACTION = { kind: 'escalate', reason: 'dispatch-failed', issue: 900, why: '#900 自动派工失败：上游 502' };

  /** 造一份「hub 6 小时内已发过」的 state，免得测试去碰真的群播报。 */
  async function freshState() {
    const { escalateDedupKey } = await CMD;
    const key = escalateDedupKey(ACTION);
    return {
      key,
      state: {
        escalateLedger: {},                              // ← 账本是空的，这正是本组要测的场景
        escalateStreak: {},
        hubSeen: { [`esc:${key}`]: new Date().toISOString() },
      },
    };
  }

  /** gh 假件：search 命中已有单 #555；issue view 的评论由入参给定。 */
  const fakeGh = (comments, { viewOk = true } = {}) => (argv) => {
    if (argv[0] === 'search') return { ok: true, out: JSON.stringify([{ number: 555 }]) };
    if (argv[0] === 'issue' && argv[1] === 'view') {
      if (!viewOk) return { ok: false, error: 'gh 读评论超时' };
      return { ok: true, out: JSON.stringify({ comments }) };
    }
    return { ok: false, error: `没夹具：${argv.join(' ')}` };
  };

  it('没留过 → 真的发出一条 issue comment，账本记上这个对象', async () => {
    const { escalate } = await CMD;
    const { state, key } = await freshState();
    const calls = [];
    const r = escalate(ACTION, {
      state,
      dryRun: false,
      say: () => {},
      io: {
        runGh: fakeGh([]),
        runCmd: (argv) => { calls.push(argv); return { ok: true }; },
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.issue, 555);
    assert.equal(calls.length, 1, '一条评论都没发——账本写了但用户在单里看不到这个对象');
    assert.equal(calls[0].includes('comment'), true);
    assert.equal(calls[0].includes('555'), true);
    assert.deepEqual(state.escalateLedger[key].objects, ['issue #900']);
    assert.equal(state.escalateLedger[key].issue, 555);
  });

  it('已经留过 → 不重复留言，但账本照样写回（重试幂等）', async () => {
    const { escalate } = await CMD;
    const { state, key } = await freshState();
    const calls = [];
    const r = escalate(ACTION, {
      state,
      dryRun: false,
      say: () => {},
      io: {
        runGh: fakeGh([{ body: '指挥官：同一原因又命中一个对象。\n\n- 新增：issue #900\n' }]),
        runCmd: (argv) => { calls.push(argv); return { ok: true }; },
      },
    });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 0, '同一个对象被刷了第二条评论');
    assert.deepEqual(state.escalateLedger[key].objects, ['issue #900']);
  });

  it('评论读不到 → 不留言、不写账本，下轮再试（没查成 ≠ 没留过）', async () => {
    const { escalate } = await CMD;
    const { state, key } = await freshState();
    const calls = [];
    const r = escalate(ACTION, {
      state,
      dryRun: false,
      say: () => {},
      io: {
        runGh: fakeGh([], { viewOk: false }),
        runCmd: (argv) => { calls.push(argv); return { ok: true }; },
      },
    });
    assert.equal(r.skipped, 'append-unscanned');
    assert.equal(calls.length, 0);
    assert.equal(state.escalateLedger[key], undefined, '没查成却把账本写了：下轮会以为这个对象已经说过');
  });

  it('留言失败 → 账本不动（记早了那个对象就永远不会被提起）', async () => {
    const { escalate } = await CMD;
    const { state, key } = await freshState();
    const r = escalate(ACTION, {
      state,
      dryRun: false,
      say: () => {},
      io: {
        runGh: fakeGh([]),
        runCmd: () => ({ ok: false, error: 'gh comment 502' }),
      },
    });
    assert.equal(r.ok, false);
    assert.equal(state.escalateLedger[key], undefined);
  });
});

describe('alreadyAppended：三个出口分得开', () => {
  it('评论里有这行 → found', async () => {
    const { alreadyAppended } = await CMD;
    const got = alreadyAppended({
      issue: 555,
      target: 'issue #900',
      gh: () => ({ ok: true, out: JSON.stringify({ comments: [{ body: '- 新增：issue #900' }] }) }),
    });
    assert.equal(got.unscanned, false);
    assert.equal(got.found, true);
  });

  it('评论里没有 → 没 found，但也不是没查成', async () => {
    const { alreadyAppended } = await CMD;
    const got = alreadyAppended({
      issue: 555,
      target: 'issue #900',
      gh: () => ({ ok: true, out: JSON.stringify({ comments: [{ body: '- 新增：PR #7' }] }) }),
    });
    assert.equal(got.unscanned, false);
    assert.equal(got.found, false);
  });

  it('返回不是数组 → 判没查成，不许当「没留过」', async () => {
    const { alreadyAppended } = await CMD;
    const got = alreadyAppended({
      issue: 555,
      target: 'issue #900',
      gh: () => ({ ok: true, out: JSON.stringify({ comments: null }) }),
    });
    assert.equal(got.unscanned, true);
  });

  it('返回非 JSON → 判没查成', async () => {
    const { alreadyAppended } = await CMD;
    const got = alreadyAppended({ issue: 555, target: 'issue #900', gh: () => ({ ok: true, out: '<html>502' }) });
    assert.equal(got.unscanned, true);
  });
});
