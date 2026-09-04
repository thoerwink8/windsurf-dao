// #876 两个机制的判别力（用户 2026-09-04 拍板）：
//   机制一 框架单走快马：type/体系 的单不进自动派单队列，改回流一条；对照组照常派。
//   机制二 待消歧浮出水面：带「待消歧」拒派（派工侧 + 指挥官侧），到时机才提醒。
// 验收判据 a-d 对应下面四组断言（a 到时机提醒 / b 没到不提醒 / c 双标拒派 / d 交给 dao-check）。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const url = (p) => 'file://' + path.join(REPO, p).replace(/\\/g, '/');
const CORE = import(url('scripts/lib/commander-core.mjs'));
const PEND = import(url('scripts/lib/pending-disambiguation.mjs'));
const CARD = import(url('scripts/lib/dispatch/card.mjs'));
const PLAIN = import(url('scripts/lib/plain-words.mjs'));

// 与 tests/commander.test.js 同款基线：全查成、全空 → 只回 noop。
function baseSituation(over = {}) {
  return {
    github: { scanned: true, issues: [], prs: [] },
    orca: { scanned: true, worktrees: [] },
    reviewPending: { scanned: true, items: [] },
    prReviews: { scanned: true, byPr: {} },
    stall: { scanned: true, strikes: {} },
    wakeCounts: {},
    commanderPolicy: { maxDispatchPerRound: 20, requireModelInRouting: false },
    routingModels: ['grok-4.6', 'claude-opus'],
    healthRedModels: [],
    ...over,
  };
}
const byKind = (r, k) => r.actions.filter((a) => a.kind === k);
const labels = (...names) => names.map((name) => ({ name }));

describe('机制一：框架单不进自动派单队列（走快马）', () => {
  it('type/体系 + 已消歧 + model|reviewer 标齐 → 0 dispatch + 1 回流（说人话）', async () => {
    const { decide } = await CORE;
    const { plainViolations } = await PLAIN;
    const issue = { number: 876, title: '两个指挥官机制', labels: labels('已消歧', 'model/claude-opus', 'reviewer/gpt-5.6-luna', 'type/体系') };
    const r = decide(baseSituation({ github: { scanned: true, issues: [issue], prs: [] } }));
    assert.equal(byKind(r, 'dispatch').length, 0, '框架单绝不进自动派单队列');
    const hub = byKind(r, 'notify-hub');
    assert.equal(hub.length, 1, '要回流一条说明走快马');
    assert.equal(hub[0].moment, 'decide');
    assert.equal(hub[0].issue, 876);
    assert.match(hub[0].subject, /快马/);
    assert.match(hub[0].subject, /不进派单队列/);
    assert.deepEqual(plainViolations(hub[0].subject), [], hub[0].subject);
    assert.equal(byKind(r, 'escalate').length, 0, '框架单不是异常，不报帅');
  });

  it('对照：同样标齐、没有 type/体系 → 照常 dispatch', async () => {
    const { decide } = await CORE;
    const issue = { number: 877, title: '普通写码活', labels: labels('已消歧', 'model/grok-4.6', 'reviewer/gpt-5.6-luna', 'type/写码') };
    const r = decide(baseSituation({ github: { scanned: true, issues: [issue], prs: [] } }));
    const d = byKind(r, 'dispatch');
    assert.equal(d.length, 1, '非框架单照常派');
    assert.equal(d[0].issue, 877);
  });

  it('框架单缺 model|reviewer 也不报「补标签」（框架单本就不需要）', async () => {
    const { decide } = await CORE;
    const issue = { number: 878, title: '另一个机制', labels: labels('已消歧', 'type/体系') };
    const r = decide(baseSituation({ github: { scanned: true, issues: [issue], prs: [] } }));
    assert.equal(byKind(r, 'dispatch').length, 0);
    assert.equal(byKind(r, 'escalate').filter((a) => a.reason === 'missing-labels').length, 0);
  });
});

describe('机制二·指挥官侧：待消歧拦派工（静默，不刷屏）', () => {
  it('判据 c：故意双标（待消歧 + 已消歧 + 标齐）→ 0 dispatch、0 回流、0 报帅', async () => {
    const { decide } = await CORE;
    const issue = { number: 818, title: '额度看板', labels: labels('待消歧', '已消歧', 'model/grok-4.6', 'reviewer/gpt-5.6-luna', 'type/写码') };
    const r = decide(baseSituation({ github: { scanned: true, issues: [issue], prs: [] } }));
    assert.equal(byKind(r, 'dispatch').length, 0, '待消歧的单绝不派');
    assert.equal(byKind(r, 'notify-hub').length, 0, '拦下来不刷屏（该说的话由盘点在时机到了说）');
    assert.equal(byKind(r, 'escalate').length, 0);
    assert.deepEqual(r.actions.map((a) => a.kind), ['noop'], '静默跳过 = 盘面无事');
  });

  it('待消歧 + type/体系 同时在 → 仍然静默（待消歧优先于走快马回流）', async () => {
    const { decide } = await CORE;
    const issue = { number: 819, title: 'X', labels: labels('待消歧', '已消歧', 'type/体系') };
    const r = decide(baseSituation({ github: { scanned: true, issues: [issue], prs: [] } }));
    assert.deepEqual(r.actions.map((a) => a.kind), ['noop']);
  });
});

describe('机制二·派工侧：消歧门拒派带「待消歧」的单（判据 c）', () => {
  function fakeGh(labelNames) {
    return () => ({ ok: true, out: JSON.stringify({ labels: labelNames.map((name) => ({ name })) }) });
  }
  it('双标（待消歧 + 已消歧）→ 拒派，理由点名待消歧', async () => {
    const { checkIssueDisambiguated } = await CARD;
    const r = checkIssueDisambiguated({ issue: '818', runGh: fakeGh(['待消歧', '已消歧', 'model/grok-4.6']) });
    assert.equal(r.ok, false, '双标必须拒派');
    assert.equal(r.pending, true);
    assert.match(r.error, /待消歧/);
  });
  it('只带待消歧 → 拒派', async () => {
    const { checkIssueDisambiguated } = await CARD;
    const r = checkIssueDisambiguated({ issue: '818', runGh: fakeGh(['待消歧']) });
    assert.equal(r.ok, false);
    assert.equal(r.pending, true);
  });
  it('对照：只带已消歧 → 放行（不误伤）', async () => {
    const { checkIssueDisambiguated } = await CARD;
    const r = checkIssueDisambiguated({ issue: '876', runGh: fakeGh(['已消歧', 'model/claude-opus']) });
    assert.equal(r.ok, true);
    assert.equal(r.hasLabel, true);
  });
  it('对照：gh 读不到 → 仍是「没查成」拒派，不被新判据顶掉', async () => {
    const { checkIssueDisambiguated } = await CARD;
    const r = checkIssueDisambiguated({ issue: '876', runGh: () => ({ ok: false, error: '断网' }) });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
  });
});

describe('机制二·浮出水面判据（纯函数）', () => {
  it('判据 a：时机行引用的单已关 → 到时机，提醒文案说人话', async () => {
    const { parseTimingRef, collectSurfacing, buildSurfacingHubText, surfacingDedupKey } = await PEND;
    const { plainViolations } = await PLAIN;
    const timing = parseTimingRef(['正文……\n时机：#863 关闭后', '别的评论']);
    assert.deepEqual(timing, { found: true, issue: 863 });
    const got = collectSurfacing([{ issue: 818, title: '额度看板', timingRef: timing.issue, blockerState: 'CLOSED' }]);
    assert.equal(got.due.length, 1, '引用单已关就该端上来');
    assert.equal(got.due[0].issue, 818);
    const text = buildSurfacingHubText(got.due);
    assert.match(text, /#818/);
    assert.match(text, /到讨论时机了/);
    assert.match(text, /等你拍怎么消歧/);
    assert.deepEqual(plainViolations(text), [], text);
    assert.equal(surfacingDedupKey(got.due), 'surface:818', '去重键 = 到时机的单集合');
  });

  it('判据 b：引用的单还开着 → 不提醒', async () => {
    const { collectSurfacing } = await PEND;
    const got = collectSurfacing([{ issue: 818, timingRef: 863, blockerState: 'OPEN' }]);
    assert.equal(got.due.length, 0, '没到时机不许提醒');
    assert.equal(got.notYet.length, 1);
  });

  it('时机行缺失 → 没查成：不提醒也不报错', async () => {
    const { parseTimingRef, collectSurfacing } = await PEND;
    const t = parseTimingRef(['这单没写时机行']);
    assert.deepEqual(t, { found: false, issue: null });
    const got = collectSurfacing([{ issue: 818, timingRef: t.issue, blockerState: null }]);
    assert.equal(got.due.length, 0);
    assert.equal(got.unknown.length, 1);
    assert.match(got.unknown[0].why, /没查成/);
  });

  it('引用单状态读不到 → 没查成，不当「还开着」也不当「已关」', async () => {
    const { assessSurfacing } = await PEND;
    const v = assessSurfacing({ issue: 818, timingRef: 863, blockerState: null });
    assert.equal(v.state, 'unknown');
    assert.match(v.why, /没查成/);
  });

  it('评论里的时机行也认，后写的覆盖先写的', async () => {
    const { parseTimingRef } = await PEND;
    const t = parseTimingRef(['正文没有时机', '时机：#800 关闭后', '改了：时机：#863 关闭后']);
    assert.equal(t.issue, 863);
  });

  it('单子清单没查成（不是数组）→ scanned:false，不当「一个都没有」', async () => {
    const { collectSurfacing } = await PEND;
    const got = collectSurfacing(null);
    assert.equal(got.scanned, false);
    assert.equal(got.due.length, 0);
  });

  it('多条到时机 → 一条消息编号列全，零黑话', async () => {
    const { buildSurfacingHubText } = await PEND;
    const { plainViolations } = await PLAIN;
    const text = buildSurfacingHubText([
      { issue: 818, title: '看板', why: '等的 #863 已经关了' },
      { issue: 820, title: '另一件', why: '等的 #870 已经关了' },
    ]);
    assert.match(text, /有 2 件/);
    assert.match(text, /1）/);
    assert.match(text, /2）/);
    assert.deepEqual(plainViolations(text), [], text);
  });
});

describe('待消歧标判别（纯函数）', () => {
  it('认标、不认近义词、labels 不是数组不瞎认', async () => {
    const { hasPendingLabel, PENDING_LABEL } = await PEND;
    assert.equal(PENDING_LABEL, '待消歧');
    assert.equal(hasPendingLabel([{ name: '待消歧' }]), true);
    assert.equal(hasPendingLabel(['待消歧']), true);
    assert.equal(hasPendingLabel([{ name: '待拍板' }, { name: '已消歧' }]), false, '待拍板不是待消歧');
    assert.equal(hasPendingLabel(null), false);
  });
});


describe('盘点三态不塌（#877 审官一轮红）', () => {
  const INV = import(url('scripts/lib/commander-inventory.mjs'));

  it('检查项计数：ok+red+unknown+due 等于总项数，没见过的状态算没查成', async () => {
    const { tallyChecks } = await INV;
    const got = tallyChecks([
      { key: 'a', state: 'ok' }, { key: 'b', state: 'red' }, { key: 'c', state: 'unknown' },
      { key: 'd', state: 'due' }, { key: 'e', state: 'quiet' }, { key: 'f', state: '天外飞仙' },
    ]);
    const c = got.counts;
    assert.equal(c.total, 6);
    assert.equal(c.ok + c.red + c.unknown + c.due, c.total, '四态之和必须等于总项数');
    assert.equal(c.ok, 2, 'quiet 也算查过没事');
    assert.equal(c.unknown, 2, '没见过的状态并进没查成，不许当 ok');
  });

  it('待消歧扫描：引用单状态读不到 → 整项是没查成，日志不打 ✓', async () => {
    const { runInventory, CHECK_SYM, tallyChecks } = await INV;
    assert.equal(typeof runInventory, 'function');
    assert.equal(CHECK_SYM.unknown, '?');
    assert.equal(CHECK_SYM.quiet, '✓');
    // 一张待消歧单，时机行引用 #863 但 gh 读不出它的状态 → collectSurfacing 归入 unknown
    const { surfaceState } = await INV;
    const { collectSurfacing } = await PEND;
    const got = collectSurfacing([{ issue: 818, timingRef: 863, blockerState: null }]);
    const state = surfaceState(got);
    assert.equal(state, 'unknown', '有没查成的就不能报安静（旧判据在这里报 quiet）');
    assert.equal(surfaceState(collectSurfacing(null)), 'unknown', '整张单子都没扫成，更是没查成');
    assert.equal(surfaceState({ scanned: true, due: [], notYet: [{}], unknown: [] }), 'quiet', '全查成且都没到时机才算安静');
    assert.equal(surfaceState({ scanned: true, due: [{ issue: 1 }], notYet: [], unknown: [{}] }), 'due', '到时机优先端上来');
    assert.equal(CHECK_SYM[state], '?', '没查成不许显示 ✓');
    const tally = tallyChecks([{ key: 'pending-surface', state }]);
    assert.equal(tally.counts.unknown, 1);
    assert.equal(tally.counts.ok, 0);
  });

  it('待消歧单列不出来 → 没查成，且 due/unknown 字段仍是数组（调用方不会读到 undefined）', async () => {
    const { collectSurfacing } = await PEND;
    const got = collectSurfacing(null);
    assert.equal(got.scanned, false, '没扫成不是「一个都没有」');
    assert.ok(Array.isArray(got.due) && Array.isArray(got.unknown));
  });
});
