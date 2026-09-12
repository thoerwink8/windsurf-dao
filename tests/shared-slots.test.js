// tests/shared-slots.test.js —— 起会话的动作受机器余量约束（#1007 二期 + 2026-09-10 修订）
//
// 原来只有 dispatch 和 rework 受机器余量限制，attach-reviewer / retry-drain / rereview
// **完全不限张**。而审官吃同一份 CPU 和内存：2026-09-06 实测 137 个会话里审官 53 个。
// 只限工人不限审官 = 闸只挡了一半，机器照样被压垮（那晚 loadavg 17.3 / 6 核）。
//
// 2026-09-10 修订（本次）：原来收尾名额**从新活名额里切**，于是机器一满（slots=0）
// 连收尾也归零——25 张 PR 一条判定都没有、满载空转等收尾（实咬）。
// 现在两笔账分开：
//   · 新活（dispatch）：受机器余量（slots）限制，机器满了一个不派；
//   · 收尾（attach-reviewer / rereview / rework / retry-drain / pump-draft）：领自己的
//     名额池（finishSlots ≤ FINISH_SLOTS_MAX），不跟新活抢，也仍然**有上限**——
//     #1007 二期「审官不许不限张」那条教训原样保留。
// 优先级仍是「收尾先于开新」：预算有富余时，收尾先拿，剩下的给新活。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CORE = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'commander-core.mjs').replace(/\\/g, '/'));

function readyIssue(n) {
  return {
    number: n,
    title: `单 ${n}`,
    body: '',
    labels: [{ name: '已消歧' }, { name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }, { name: 'type/写码' }],
  };
}

function situation({ issues = [], ticket = [], slots = null } = {}) {
  return {
    github: { scanned: true, issues, prs: ticket.map((t) => ({ number: t.pr, title: `PR ${t.pr}`, isDraft: false })) },
    orca: { scanned: true, worktrees: [] },
    trees: { scanned: true, worktrees: [] },
    reviewPending: { scanned: true, items: ticket },
    prReviews: { scanned: true, byPr: {} },
    stall: { scanned: true, strikes: {} },
    wakeCounts: {},
    reworkDispatched: {},
    drainLedger: {},
    commanderPolicy: { requireModelInRouting: false },
    routingModels: ['grok-4.6', 'gpt-5.6-sol'],
    healthRedModels: [],
    ...(slots == null ? {} : { admission: { ok: true, slots, why: `slots=${slots}` } }),
  };
}

const kinds = (r, k) => r.actions.filter((a) => a.kind === k);
const 起会话动作 = (r) => r.actions.filter(
  (a) => ['dispatch', 'rework', 'attach-reviewer', 'retry-drain', 'rereview'].includes(a.kind),
).length;

describe('审官也吃名额（本次修的核心）', () => {
  it('slots=2、三张复审票 → 只起两个审官，第三张排队下轮', async () => {
    const { decide } = await CORE;
    const r = decide(situation({
      ticket: [{ pr: 101 }, { pr: 102 }, { pr: 103 }],
      slots: 2,
    }));
    assert.equal(kinds(r, 'attach-reviewer').length, 1, '#1125 每轮只喊一次 drain，闸在拉取侧');
  });

  // 2026-09-10 修订：机器满载不再让收尾归零（收尾领自己的名额池）。
  // #1007 二期的本意（审官不许不限张）由 FINISH_SLOTS_MAX 保住——见下一条。
  it('slots=0（机器满）→ 收尾照起，但**仍有上限**，不因为机器满就不限张', async () => {
    const { decide, FINISH_SLOTS_MAX } = await CORE;
    const r = decide(situation({
      // 一张票只喊一次 drain（#1125），这里靠多张返工票把收尾名额吃满
      ticket: [{ pr: 101 }, { pr: 102 }],
      slots: 0,
    }));
    assert.equal(kinds(r, 'attach-reviewer').length, 1, '机器满载时收尾仍要能推进（本轮要修的正是这一格）');
    assert.ok(FINISH_SLOTS_MAX >= 1, '收尾名额是个有上限的池子，不是不限张');
    assert.ok(FINISH_SLOTS_MAX <= 5, '上限别大开——#1007 二期的教训是审官不许不限张');
  });

  it('排队下轮不算失败：不产 escalate', async () => {
    const { decide } = await CORE;
    const r = decide(situation({ ticket: [{ pr: 101 }, { pr: 102 }, { pr: 103 }], slots: 1 }));
    const 报帅 = kinds(r, 'escalate').filter((a) => a.reason !== 'admission-unscanned');
    assert.deepEqual(报帅, [], '余量不够是排队，不是要人拍板的事');
  });
});

describe('总量：新活不超机器余量，收尾不超自己的池子', () => {
  it('新活数 ≤ slots；收尾数 ≤ FINISH_SLOTS_MAX（两笔账各自封顶）', async () => {
    const { decide, FINISH_SLOTS_MAX } = await CORE;
    for (const slots of [1, 2, 3, 5]) {
      const r = decide(situation({
        issues: [readyIssue(201), readyIssue(202), readyIssue(203), readyIssue(204)],
        ticket: [{ pr: 101 }, { pr: 102 }, { pr: 103 }],
        slots,
      }));
      assert.ok(kinds(r, 'dispatch').length <= slots, `slots=${slots} 时新活派了 ${kinds(r, 'dispatch').length} 个`);
      assert.ok(kinds(r, 'attach-reviewer').length <= FINISH_SLOTS_MAX, '收尾不许不限张（#1007 二期的教训）');
    }
  });
});

describe('收尾先于开新', () => {
  it('票占满预算时，新活一张都不派（不许把收尾挤掉）', async () => {
    const { decide } = await CORE;
    const r = decide(situation({
      issues: [readyIssue(201), readyIssue(202)],
      ticket: [{ pr: 101 }, { pr: 102 }],
      slots: 2,
    }));
    assert.equal(kinds(r, 'attach-reviewer').length, 1, '#1125 收尾每轮只留 1 个名额喊 drain');
    assert.equal(kinds(r, 'dispatch').length, 1, '老单有票时新活最多 1 张');
  });

  it('预算有富余时，老单有票则新活仍最多 1 张', async () => {
    const { decide } = await CORE;
    const r = decide(situation({
      issues: [readyIssue(201), readyIssue(202), readyIssue(203)],
      ticket: [{ pr: 101 }],
      slots: 3,
    }));
    assert.equal(kinds(r, 'attach-reviewer').length, 1);
    assert.equal(kinds(r, 'dispatch').length, 1, '老单有可执行动作时新派工压到 1');
  });

  it('没有票时，全部名额都归新活', async () => {
    const { decide } = await CORE;
    const r = decide(situation({
      issues: [readyIssue(201), readyIssue(202), readyIssue(203)],
      slots: 2,
    }));
    assert.equal(kinds(r, 'dispatch').length, 2);
  });
});

describe('旧夹具兼容：没给 admission 就不限张', () => {
  it('admission 缺席 → 照旧全派（不当成 slots=0）', async () => {
    const { decide } = await CORE;
    const r = decide(situation({
      issues: [readyIssue(201), readyIssue(202), readyIssue(203)],
      ticket: [{ pr: 101 }, { pr: 102 }],
    }));
    assert.equal(kinds(r, 'dispatch').length, 1, '即使准入不限张，老单有票时新活仍最多 1');
    assert.equal(kinds(r, 'attach-reviewer').length, 1, '#1125 每轮只产一条 attach-reviewer');
  });

  // 「没查成」放开闸，等于机器空转时把自己压垮——必须收紧到 0 而不是放开。
  it('admission 没查成 → 一个会话都不起，并报没查成', async () => {
    const { decide } = await CORE;
    const s = situation({
      issues: [readyIssue(201)],
      ticket: [{ pr: 101 }],
    });
    s.admission = { ok: false, why: '/proc 读不动' };
    const r = decide(s);
    assert.equal(起会话动作(r), 0);
    assert.equal(kinds(r, 'escalate').some((a) => a.reason === 'admission-unscanned'), true);
  });
});
