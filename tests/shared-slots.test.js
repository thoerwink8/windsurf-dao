// tests/shared-slots.test.js —— 起会话的动作共用一个预算（#1007 二期）
//
// 原来只有 dispatch 和 rework 受机器余量限制，attach-reviewer / retry-drain / rereview
// **完全不限张**。而审官吃同一份 CPU 和内存：2026-09-06 实测 137 个会话里审官 53 个。
// 只限工人不限审官 = 闸只挡了一半，机器照样被压垮（那晚 loadavg 17.3 / 6 核）。
//
// 优先级是「收尾先于开新」（工作队列常识：在制品堆着不收尾，吞吐只会更差）：
// 复审票的数量本轮一开始就知道，先把名额留出来（finishReserve），剩下的才给新派单。

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
    assert.equal(kinds(r, 'attach-reviewer').length, 2, '审官原来完全不限张，这条就是修它');
  });

  it('slots=0 → 一个审官都不起', async () => {
    const { decide } = await CORE;
    const r = decide(situation({ ticket: [{ pr: 101 }, { pr: 102 }], slots: 0 }));
    assert.equal(kinds(r, 'attach-reviewer').length, 0);
  });

  it('排队下轮不算失败：不产 escalate', async () => {
    const { decide } = await CORE;
    const r = decide(situation({ ticket: [{ pr: 101 }, { pr: 102 }, { pr: 103 }], slots: 1 }));
    const 报帅 = kinds(r, 'escalate').filter((a) => a.reason !== 'admission-unscanned');
    assert.deepEqual(报帅, [], '余量不够是排队，不是要人拍板的事');
  });
});

describe('总量：所有起会话的动作加起来不超预算', () => {
  it('新活 + 复审票混在一起，总数不超 slots', async () => {
    const { decide } = await CORE;
    for (const slots of [1, 2, 3, 5]) {
      const r = decide(situation({
        issues: [readyIssue(201), readyIssue(202), readyIssue(203), readyIssue(204)],
        ticket: [{ pr: 101 }, { pr: 102 }, { pr: 103 }],
        slots,
      }));
      assert.ok(起会话动作(r) <= slots, `slots=${slots} 时起了 ${起会话动作(r)} 个会话`);
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
    assert.equal(kinds(r, 'attach-reviewer').length, 2, '收尾要先拿到名额');
    assert.equal(kinds(r, 'dispatch').length, 0, '预算被收尾占满，新活排队下轮');
  });

  it('预算有富余时，收尾之外的名额才轮到新活', async () => {
    const { decide } = await CORE;
    const r = decide(situation({
      issues: [readyIssue(201), readyIssue(202), readyIssue(203)],
      ticket: [{ pr: 101 }],
      slots: 3,
    }));
    assert.equal(kinds(r, 'attach-reviewer').length, 1);
    assert.equal(kinds(r, 'dispatch').length, 2, '3 个名额减去 1 张票，剩 2 个给新活');
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
    assert.equal(kinds(r, 'dispatch').length, 3);
    assert.equal(kinds(r, 'attach-reviewer').length, 2);
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
