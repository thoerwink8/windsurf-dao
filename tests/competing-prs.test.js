// tests/competing-prs.test.js —— 竞争 PR 闸（两个开放 PR 新建同一文件）
//
// 判别力自问：把闸的判据改成「只要有两个开放 PR 就报」、或者「gh 挂了当没冲突」，
// 下面是否都至少有一条断言变红？下面每个 describe 各钉一条。
//
// 真实样本用 #884/#886 那一对：两张卡都新建 scripts/lib/executor-binding.mjs，
// #886 先合，#884 挂成 CONFLICTING 两天。闸装在那天之前的话，这条测试就是它会说的话。

const { describe, it } = require('node:test');
const assert = require('node:assert');

let judgeCompetingPrs, collectOpenPrNewFiles;
const LOAD = import('../scripts/lib/competing-prs.mjs').then((m) => {
  ({ judgeCompetingPrs, collectOpenPrNewFiles } = m);
});

describe('竞争 PR 闸 · 判定', () => {
  it('两个开放 PR 新建同一文件 → 红，并点名是哪两个', async () => {
    await LOAD;
    const r = judgeCompetingPrs({
      prs: [
        { number: 884, newPaths: ['scripts/lib/executor-binding.mjs', 'tests/executor-binding.test.js'] },
        { number: 886, newPaths: ['scripts/lib/executor-binding.mjs'] },
      ],
    });
    assert.equal(r.kind, 'red');
    assert.deepEqual(r.collisions, [{ path: 'scripts/lib/executor-binding.mjs', prs: [884, 886] }]);
  });

  it('各建各的文件 → 绿（并行开工本身不是问题）', async () => {
    await LOAD;
    const r = judgeCompetingPrs({
      prs: [
        { number: 1, newPaths: ['scripts/lib/a.mjs'] },
        { number: 2, newPaths: ['scripts/lib/b.mjs'] },
      ],
    });
    assert.equal(r.kind, 'ok');
    assert.equal(r.collisions.length, 0);
  });

  it('三个 PR 撞同一个文件 → 三个都点名，不只报前两个', async () => {
    await LOAD;
    const r = judgeCompetingPrs({
      prs: [
        { number: 7, newPaths: ['x.mjs'] },
        { number: 8, newPaths: ['x.mjs'] },
        { number: 9, newPaths: ['x.mjs'] },
      ],
    });
    assert.deepEqual(r.collisions[0].prs, [7, 8, 9]);
  });

  it('没给数组 → 没查成，不是绿', async () => {
    await LOAD;
    assert.equal(judgeCompetingPrs({}).kind, 'unscanned');
  });

  it('某个 PR 的文件清单缺失 → 没查成，不许当成「它没新建文件」', async () => {
    await LOAD;
    const r = judgeCompetingPrs({ prs: [{ number: 5 }] });
    assert.equal(r.kind, 'unscanned');
    assert.match(r.error, /不是「它没新建文件」/);
  });

  it('0 个开放 PR → 绿，但话说的是「无从相撞」而不是「对照过没事」', async () => {
    await LOAD;
    const r = judgeCompetingPrs({ prs: [] });
    assert.equal(r.kind, 'ok');
    assert.match(r.line, /没有开放 PR/);
  });
});

describe('竞争 PR 闸 · 采集', () => {
  const fakeGh = (pages) => (args) => {
    if (args[1] === 'list') return { ok: true, json: pages.list };
    if (args[1] === 'view') return pages.view[args[2]] || { ok: false, error: 'no such pr' };
    return { ok: false, error: 'unexpected' };
  };

  it('只把「有增行且主干还没有」的路径算新建——改已有文件不算', async () => {
    await LOAD;
    const r = collectOpenPrNewFiles({
      runGh: fakeGh({
        list: [{ number: 1, title: 't' }],
        view: {
          1: { ok: true, json: { files: [
            { path: 'new.mjs', additions: 10 },
            { path: 'existing.mjs', additions: 3 },   // 主干已有 → 不算新建
            { path: 'deleted.mjs', additions: 0 },
          ] } },
        },
      }),
      mainHas: (p) => p === 'existing.mjs',
    });
    assert.equal(r.unscanned, false);
    assert.deepEqual(r.prs[0].newPaths, ['new.mjs']);
  });

  it('gh 列表拿不到 → 没查成，不是「没有开放 PR」', async () => {
    await LOAD;
    const r = collectOpenPrNewFiles({
      runGh: () => ({ ok: false, error: 'gh: auth required' }),
      mainHas: () => false,
    });
    assert.equal(r.unscanned, true);
    assert.deepEqual(r.prs, []);
  });

  it('单个 PR 的详情拿不到 → 整体没查成（少扫一个就可能漏掉正好那一对）', async () => {
    await LOAD;
    const r = collectOpenPrNewFiles({
      runGh: fakeGh({ list: [{ number: 1 }, { number: 2 }], view: { 1: { ok: true, json: { files: [] } } } }),
      mainHas: () => false,
    });
    assert.equal(r.unscanned, true);
    assert.match(r.error, /#2/);
  });

  it('没注入 IO → 没查成，不许自己去打网', async () => {
    await LOAD;
    assert.equal(collectOpenPrNewFiles({}).unscanned, true);
  });
});
