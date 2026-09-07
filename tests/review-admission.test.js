// #1125 按资源拉取审官：生产端不再决定消费端并发。
//
// 用户 2026-09-07 拍板：「工人做好不要自己去开 PR 唤起审官，让中间态、看门狗或者帅位
// 去根据资源调度」。这套测试钉的是**拉取那一侧的判据**，两条最容易做错的地方：
//   · 「在役几个」没查成时，不许当成「0 个在跑」去拉满——那正是本单要治的病。
//   · 残壳（会话带着死因）不许占并发位——否则上限被壳吃满，队列永远拉不动，
//     看起来像「一直满载」其实一个都没在跑。
// 纯函数夹具，不碰 mirasim / GitHub / 文件系统。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const RP = import('file://' + path.join(REPO, 'scripts', 'lib', 'dispatch', 'review-pending.mjs').replace(/\\/g, '/'));

const ticket = (pr, ts) => ({ pr: String(pr), ts, reviewer: 'gpt-5.6-luna' });

describe('#1125 planReviewAdmission：按在役审官数拉取', () => {
  it('有余量就拉到补满，且先来先服务', async () => {
    const { planReviewAdmission } = await RP;
    const r = planReviewAdmission({
      tickets: [ticket(3, '2026-09-07T03:00:00Z'), ticket(1, '2026-09-07T01:00:00Z'), ticket(2, '2026-09-07T02:00:00Z')],
      liveReviewers: 1, cap: 3,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.pull.map(t => t.pr), ['1', '2'], '余 2 个位就拉 2 张，且按 ts 最老的先走');
    assert.deepEqual(r.held.map(t => t.pr), ['3']);
  });

  it('已达上限 → 拉 0 张，票留在队列（不是丢弃）', async () => {
    const { planReviewAdmission } = await RP;
    const ts = [ticket(1, '2026-09-07T01:00:00Z'), ticket(2, '2026-09-07T02:00:00Z')];
    const r = planReviewAdmission({ tickets: ts, liveReviewers: 3, cap: 3 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.pull, []);
    assert.equal(r.held.length, 2, '票必须还在队列里');
  });

  it('超了上限（残壳没清干净时会出现）也只拉 0，不拉负数', async () => {
    const { planReviewAdmission } = await RP;
    const r = planReviewAdmission({ tickets: [ticket(1, 'x')], liveReviewers: 9, cap: 3 });
    assert.deepEqual(r.pull, []);
    assert.equal(r.held.length, 1);
  });

  it('在役数没查成 → 拉 0 并报没查成（不许当成 0 个在跑去拉满）', async () => {
    const { planReviewAdmission } = await RP;
    for (const bad of [null, undefined, NaN, -1, '2', 1.5]) {
      const r = planReviewAdmission({ tickets: [ticket(1, 'x'), ticket(2, 'y')], liveReviewers: bad, cap: 3 });
      assert.equal(r.ok, false, `liveReviewers=${JSON.stringify(bad)} 应判没查成`);
      assert.equal(r.unscanned, true);
      assert.deepEqual(r.pull, []);
      assert.equal(r.held.length, 2, '没查成时票也要留住');
    }
  });

  it('队列没扫成 → 拉 0 并报没查成（「扫完 0 条」和「没扫成」分得开）', async () => {
    const { planReviewAdmission } = await RP;
    const bad = planReviewAdmission({ tickets: null, liveReviewers: 0, cap: 3 });
    assert.equal(bad.unscanned, true);
    const empty = planReviewAdmission({ tickets: [], liveReviewers: 0, cap: 3 });
    assert.equal(empty.ok, true, '扫完 0 条是正常结果，不是没查成');
    assert.deepEqual(empty.pull, []);
  });

  it('默认上限是实测出来的 3', async () => {
    const { DEFAULT_REVIEWER_CAP } = await RP;
    assert.equal(DEFAULT_REVIEWER_CAP, 3);
  });
});

describe('#1125 countLiveReviewers：只有会话名单里的 runState 算数', () => {
  const rec = (pr, key) => ({ pr: String(pr), sessionKey: key });

  it('在跑的算，终态的不算', async () => {
    const { countLiveReviewers } = await RP;
    const r = countLiveReviewers({
      records: [rec(1, 'codex:a'), rec(2, 'codex:b'), rec(3, 'codex:c')],
      sessions: [
        { sessionKey: 'codex:a', runState: 'streaming' },
        { sessionKey: 'codex:b', runState: 'done' },
        { sessionKey: 'codex:c', runState: 'running' },
      ],
    });
    assert.equal(r.count, 2);
    assert.deepEqual(r.live.map(x => x.pr), ['1', '3']);
  });

  it('残壳不占位：会话带着死因就不算在跑（#1121 同一判据）', async () => {
    const { countLiveReviewers } = await RP;
    const r = countLiveReviewers({
      records: [rec(1, 'codex:a'), rec(2, 'codex:b')],
      sessions: [
        { sessionKey: 'codex:a', runState: 'streaming' },
        // runState 还没翻成终态，但带着死因——那一针已经废了
        { sessionKey: 'codex:b', runState: 'streaming', runDetail: 'Selected model is at capacity. Please try a different model.' },
      ],
    });
    assert.equal(r.count, 1, '带死因的那个不许占并发位，否则上限被壳吃满');
  });

  it('登记里有但名单里没有 → 不算在跑', async () => {
    const { countLiveReviewers } = await RP;
    const r = countLiveReviewers({ records: [rec(1, 'codex:gone')], sessions: [{ sessionKey: 'codex:other', runState: 'streaming' }] });
    assert.equal(r.count, 0);
  });

  it('名单读不到 → 没查成，count 是 null 不是 0', async () => {
    const { countLiveReviewers } = await RP;
    const r = countLiveReviewers({ records: [rec(1, 'codex:a')], sessions: null });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
    assert.equal(r.count, null, 'null 才能让 planReviewAdmission 判没查成；0 会让它拉满');
  });

  it('接起来：名单读不到 ⇒ 一张都不拉（两个判据串通）', async () => {
    const { countLiveReviewers, planReviewAdmission } = await RP;
    const c = countLiveReviewers({ records: [{ pr: '1', sessionKey: 'codex:a' }], sessions: null });
    const r = planReviewAdmission({ tickets: [ticket(1, 'x')], liveReviewers: c.count, cap: 3 });
    assert.equal(r.unscanned, true);
    assert.deepEqual(r.pull, []);
  });
});
