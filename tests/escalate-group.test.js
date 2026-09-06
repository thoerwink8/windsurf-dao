// tests/escalate-group.test.js —— 报帅两条判据（#1063）
//
// 违规样本就是 2026-09-06 那一晚的真实动作序列：同一个原因、6 个不同对象，
// 旧判据放出 6 张待拍板单。下面「回放那一晚」那条用真实 reason 名跑一遍，
// 旧判据必红、新判据必绿——判据改窄改宽都会被它当场抓住。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LIB = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'escalate-group.mjs').replace(/\\/g, '/'));

describe('「没查成」class 不开单（判前缀，不判相等）', () => {
  it('裸 unscanned 静默', async () => {
    const { isUnscannedReason } = await LIB;
    assert.equal(isUnscannedReason('unscanned'), true);
  });

  // 这两个就是漏网的：commander.mjs 由 r.unscanned 派生出它们，语义与裸 unscanned 一致，
  // 而旧判据 `reason === 'unscanned'` 接不住 —— 6 张噪音单全部出自这里。
  it('dispatch-unscanned / rework-unscanned 同样静默', async () => {
    const { isUnscannedReason } = await LIB;
    assert.equal(isUnscannedReason('dispatch-unscanned'), true);
    assert.equal(isUnscannedReason('rework-unscanned'), true);
  });

  it('将来新增的 <动作>-unscanned 自动被接住', async () => {
    const { isUnscannedReason } = await LIB;
    assert.equal(isUnscannedReason('attach-reviewer-unscanned'), true);
  });

  // 反向边界：别把该报的也吞掉。这几个是「报帅停手」class，必须照旧开单。
  it('报帅停手 class 不被误吞', async () => {
    const { isUnscannedReason } = await LIB;
    for (const r of ['missing-labels', 'two-red', 'malformed', 'wake-exhausted', 'approved-but-ci-red', 'rework-failed']) {
      assert.equal(isUnscannedReason(r), false, `${r} 不该被当成「没查成」`);
    }
  });

  // 「unscanned」出现在中间不算——判据是后缀，不是包含。写成 includes 会把
  // 「unscanned-quota-exceeded」这类将来可能出现的真问题吞掉。
  it('只认后缀，不认包含', async () => {
    const { isUnscannedReason } = await LIB;
    assert.equal(isUnscannedReason('unscanned-quota-exceeded'), false);
  });
});

// 纯函数对了不等于接上了。这条守的是**接线**：判据只要没被 escalate() 调用，
// 上面那一整套断言全绿而线上照旧刷单——2026-09-06 那 6 张单的教训就是「两边各自都对」。
describe('判据真的接在 escalate 上', () => {
  const fs = require('node:fs');
  const src = () => fs.readFileSync(path.join(__dirname, '..', 'scripts', 'commander.mjs'), 'utf8');

  it('escalate 走 judgeEscalation，不再自己判', () => {
    assert.match(src(), /judgeEscalation\(action, \{ booked, bookedState \}\)/);
  });

  // 回归闸：改回字符串相等就是把 6 张单的路重新打开。
  it('commander.mjs 里不许再出现窄判据 reason === \'unscanned\'', () => {
    assert.doesNotMatch(src(), /reason === 'unscanned'/,
      '窄判据回来了：dispatch-unscanned / rework-unscanned 会再次漏过去开单');
  });

  it('去重键不含对象号', () => {
    assert.doesNotMatch(src(), /escalate\/\$\{a\.reason\}\/\$\{t\}/,
      '按对象聚合的旧键回来了：一个原因会再刷 N 张单');
  });
});

describe('去重键按原因，不按对象', () => {
  it('同一原因不同对象 → 同一个键', async () => {
    const { escalateDedupKey } = await LIB;
    assert.equal(
      escalateDedupKey({ reason: 'missing-labels', issue: 1007 }),
      escalateDedupKey({ reason: 'missing-labels', issue: 1063 }),
    );
  });

  it('不同原因 → 不同键', async () => {
    const { escalateDedupKey } = await LIB;
    assert.notEqual(
      escalateDedupKey({ reason: 'missing-labels', issue: 1 }),
      escalateDedupKey({ reason: 'two-red', issue: 1 }),
    );
  });

  it('对象标识认得出 PR / issue / 终端，认不出就是 null', async () => {
    const { escalateTarget } = await LIB;
    assert.equal(escalateTarget({ pr: 1040 }), 'PR #1040');
    assert.equal(escalateTarget({ issue: 1007 }), 'issue #1007');
    assert.equal(escalateTarget({ term: 'grok-1' }), 'grok-1');
    assert.equal(escalateTarget({}), null);
  });
});

describe('judgeEscalation 四个出口分得开', () => {
  it('没记过 → 开一张，并把本次对象记进清单', async () => {
    const { judgeEscalation } = await LIB;
    const v = judgeEscalation({ reason: 'missing-labels', issue: 1007 }, { booked: null });
    assert.equal(v.verdict, 'open');
    assert.deepEqual(v.objects, ['issue #1007']);
  });

  it('有活单 + 新对象 → 追加，不新开', async () => {
    const { judgeEscalation } = await LIB;
    const v = judgeEscalation({ reason: 'missing-labels', issue: 1063 },
      { booked: { issue: 900, objects: ['issue #1007'] }, bookedState: 'OPEN' });
    assert.equal(v.verdict, 'append');
    assert.equal(v.target, 'issue #1063');
    assert.deepEqual(v.objects, ['issue #1007', 'issue #1063']);
  });

  it('有活单 + 老对象 → 什么都不做（同一件事不重复说）', async () => {
    const { judgeEscalation } = await LIB;
    const v = judgeEscalation({ reason: 'missing-labels', issue: 1007 },
      { booked: { issue: 900, objects: ['issue #1007'] }, bookedState: 'OPEN' });
    assert.equal(v.verdict, 'noop');
  });

  it('记着的单已关 → 这件事又发生了，可以重开', async () => {
    const { judgeEscalation } = await LIB;
    const v = judgeEscalation({ reason: 'missing-labels', issue: 1007 },
      { booked: { issue: 900, objects: ['issue #1007'] }, bookedState: 'CLOSED' });
    assert.equal(v.verdict, 'open');
  });

  // fail-closed 的方向：开单是**写**动作、不可撤（只能关），核不出状态时宁可不开。
  // 与既有 gh search 查重那条同口径，别在同一个函数里出现两种失败方向。
  it('记着的单核不出状态 → 不开单（fail-closed 向「不开」）', async () => {
    const { judgeEscalation } = await LIB;
    const v = judgeEscalation({ reason: 'missing-labels', issue: 1007 },
      { booked: { issue: 900, objects: [] }, bookedState: null });
    assert.equal(v.verdict, 'unscanned');
  });

  it('「没查成」class 压过一切，连账本都不用查', async () => {
    const { judgeEscalation } = await LIB;
    const v = judgeEscalation({ reason: 'dispatch-unscanned', issue: 1007 }, { booked: null });
    assert.equal(v.verdict, 'silent');
  });
});

// 穷举闸：仓里每一个 escalate 原因都必须被分类。
//
// 这是③「可动作性是准入条件」在本仓的落法。不做成运行期白名单的理由见
// escalate-group.mjs 里 HUMAN_DECISION_REASONS 的注释（两个失败方向都不对）。
// 闸放在测试期：新原因在被分类之前照旧开单（不会被悄悄吞掉），但它进不了主干。
//
// 判据自己解析源码，**不复用 commander 的任何解析逻辑**（自己查自己查不出错）。
describe('穷举闸：新 escalate 原因必须被分类', () => {
  const fs = require('node:fs');
  const REPO = path.join(__dirname, '..');

  function 扫出全部原因() {
    const found = new Set();
    for (const f of ['scripts/lib/commander-core.mjs', 'scripts/commander.mjs']) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8');
      for (const m of src.matchAll(/reason:\s*'([a-z][a-z0-9-]*)'/g)) found.add(m[1]);
      // 三元派生的那两对：`isRework ? 'rework-x' : 'dispatch-x'`，上面的正则取不到。
      for (const m of src.matchAll(/\?\s*'([a-z][a-z0-9-]+)'\s*:\s*'([a-z][a-z0-9-]+)'/g)) {
        if (/-unscanned$|-failed$/.test(m[1])) { found.add(m[1]); found.add(m[2]); }
      }
    }
    return found;
  }

  // 「扫完 0 条」和「没扫到样本」必须分得开——分不开就会把「没查成」当成「查过没事」。
  it('先自证扫得到（0 条 = 没查成，不是没问题）', () => {
    const got = 扫出全部原因();
    assert.ok(got.size >= 8, `只扫到 ${got.size} 个原因——正则大概率失配了，本条不是绿是没查成`);
  });

  it('每个原因要么是「没查成」class，要么在人要拍板表里', async () => {
    const { isUnscannedReason, HUMAN_DECISION_REASONS } = await LIB;
    const 没分类 = [...扫出全部原因()].filter(
      (r) => !isUnscannedReason(r) && !HUMAN_DECISION_REASONS.has(r),
    );
    assert.deepEqual(没分类, [],
      `这些 escalate 原因没被分类：${没分类.join('、')}\n`
      + '机器故障类请命名为 <动作>-unscanned（运行期按后缀自动静默）；\n'
      + '人要拍板的请加进 escalate-group.mjs 的 HUMAN_DECISION_REASONS，并说明人要做什么决定。');
  });

  // 反向：表里不许塞「没查成」类，否则同一个原因两套判定，运行期与闸期会打架。
  it('人要拍板表里不许出现 -unscanned', async () => {
    const { isUnscannedReason, HUMAN_DECISION_REASONS } = await LIB;
    const 串味 = [...HUMAN_DECISION_REASONS].filter(isUnscannedReason);
    assert.deepEqual(串味, [], `这些既在拍板表里又是「没查成」class：${串味.join('、')}`);
  });
});

// 回放 2026-09-06 17:11—19:51 的真实序列。旧行为：6 张单。新行为：0 张。
describe('回放那一晚：同一个原因、6 个对象', () => {
  const 那一晚 = [
    { reason: 'dispatch-unscanned', issue: 1007 },
    { reason: 'rework-unscanned', pr: 1018 },
    { reason: 'dispatch-unscanned', issue: 1052 },
    { reason: 'rework-unscanned', pr: 1040 },
    { reason: 'dispatch-unscanned', issue: 982 },
    { reason: 'dispatch-unscanned', issue: 1017 },
  ];

  it('一张单都不开', async () => {
    const { judgeEscalation } = await LIB;
    const 开单的 = 那一晚.filter((a) => judgeEscalation(a, { booked: null }).verdict === 'open');
    assert.deepEqual(开单的, [], '「没查成」class 不该开出任何单');
  });

  // 同一序列若换成真该报的原因，应当收敛成 1 张单 + N-1 次追加——不是 0 张（那就成了吞掉）。
  it('换成该报的原因：1 张单 + 追加，不是 6 张也不是 0 张', async () => {
    const { judgeEscalation } = await LIB;
    const ledger = {};
    let 开 = 0; let 追加 = 0;
    for (const a of 那一晚.map((x) => ({ ...x, reason: 'missing-labels' }))) {
      const booked = ledger.k || null;
      const v = judgeEscalation(a, { booked, bookedState: booked ? 'OPEN' : null });
      if (v.verdict === 'open') { 开 += 1; ledger.k = { issue: 900, objects: v.objects }; }
      else if (v.verdict === 'append') { 追加 += 1; ledger.k = { issue: 900, objects: v.objects }; }
    }
    assert.equal(开, 1);
    assert.equal(追加, 5);
    assert.deepEqual(ledger.k.objects.length, 6, '六个对象都要留在清单里，一个都不能丢');
  });
});
