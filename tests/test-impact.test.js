// tests/test-impact.test.js —— 只跑受影响的测试（TIA）的判别力
//
// 这一层唯一的危险是**静默漏跑**：算错了不会报错，只会少跑几套，然后带病合进去。
// 所以本套的重点不是「算得对」，是「算不出来时会不会退全量」「不知道的会不会照跑」。
//
// 2026-09-06 判据换了方向：原来「不在图里」= 静默跳过 + 一条红项提醒人去重建地图，
// 现在 = **直接跑**。⑧ 与 ⑩ 钉的就是这一条，它替掉了整个 mapHealth 健康闸。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  repoRelPath, filesFromCoverage, buildMap, affectedTests, depsFromRun, mergeMapEntries, MAP_VERSION,
} from '../scripts/lib/test-impact.mjs';

const ROOT = '/srv/projects/windsurf-dao';
const u = (rel) => `file://${ROOT}/${rel}`;

const MAP = buildMap({
  entries: {
    'tests/legs.test.js': ['scripts/lib/legs.mjs', 'docs/model-routing.json'],
    'tests/dao.test.js': ['scripts/dao.mjs', 'scripts/lib/dao-cmd.mjs'],
    'tests/dao-mode.test.js': ['host/skills/dao-mode/hooks/dao-mode.mjs'],
  },
  head: 'abc1234',
});
const ALL = ['tests/legs.test.js', 'tests/dao.test.js', 'tests/dao-mode.test.js'];

test('① 路径归一：仓外/node_modules/沙盒产物一律不入图', () => {
  assert.equal(repoRelPath(u('scripts/lib/legs.mjs'), ROOT), 'scripts/lib/legs.mjs');
  assert.equal(repoRelPath(u('node_modules/x/i.js'), ROOT), null);
  assert.equal(repoRelPath(u('_tmp/mode-sandbox/homes/a/x.mjs'), ROOT), null, '测试自己造的沙盒产物不许入图');
  assert.equal(repoRelPath('file:///etc/passwd', ROOT), null, '仓外文件不入图');
  assert.equal(repoRelPath('node:fs', ROOT), null);
});

test('② 覆盖率 → 文件集合', () => {
  const docs = [{ result: [{ url: u('scripts/dao.mjs') }, { url: 'node:fs' }, { url: u('node_modules/a/b.js') }] }];
  assert.deepEqual([...filesFromCoverage(docs, ROOT)], ['scripts/dao.mjs']);
});

test('③ 命中：改源文件 → 只跑碰过它的那套', () => {
  const r = affectedTests({ map: MAP, changed: ['scripts/lib/legs.mjs'], allTests: ALL });
  assert.equal(r.mode, 'affected');
  assert.deepEqual(r.tests, ['tests/legs.test.js']);
});

test('④ 数据文件也算依赖（覆盖率外的那半，靠采样时真读过）', () => {
  const r = affectedTests({ map: MAP, changed: ['docs/model-routing.json'], allTests: ALL });
  assert.deepEqual(r.tests, ['tests/legs.test.js']);
});

test('⑤ 改测试文件本身 → 跑它（新测试还不在图里，靠这条兜住）', () => {
  const r = affectedTests({ map: MAP, changed: ['tests/dao.test.js'], allTests: ALL });
  assert.deepEqual(r.tests, ['tests/dao.test.js']);
  const brandNew = affectedTests({ map: MAP, changed: ['tests/brand-new.test.js'], allTests: [...ALL, 'tests/brand-new.test.js'] });
  assert.deepEqual(brandNew.tests, ['tests/brand-new.test.js'], '图里没有的新测试也必须被跑到');
});

test('⑥ 算不出来就退全量——三种情形一条都不许静默放行', () => {
  const noMap = affectedTests({ map: null, changed: ['scripts/x.mjs'], allTests: ALL });
  assert.equal(noMap.mode, 'full', '没有地图必须全量');

  const oldVer = affectedTests({ map: { ...MAP, version: MAP_VERSION + 1 }, changed: ['scripts/x.mjs'], allTests: ALL });
  assert.equal(oldVer.mode, 'full', '地图版本对不上必须全量');

  for (const f of ['package.json', 'scripts/dao-check.mjs', 'scripts/lib/test-impact.mjs', 'tests/helpers/no-network.mjs', '.github/workflows/check.yml']) {
    assert.equal(affectedTests({ map: MAP, changed: [f], allTests: ALL }).mode, 'full', `${f} 应落兜底面`);
  }
});

test('⑥′ 新增的源文件必须退全量——按目录扫的测试认得它，地图不认', () => {
  // 2026-09-06 当场咬到的：新加 host/machine/systemd/dao-nudge-stalled.timer 之后，
  // timer-armed.test.js（按目录扫 *.timer）没被选中，因为地图记的是采样那刻的具体文件名。
  const r = affectedTests({
    map: MAP, changed: ['host/machine/systemd/dao-nudge-stalled.timer'],
    allTests: ALL, added: ['host/machine/systemd/dao-nudge-stalled.timer'],
  });
  assert.equal(r.mode, 'full');
  assert.match(r.why, /采样时还不存在/);

  // 同一个文件，如果不是本次新增（早就在仓里、只是没测试碰过）⇒ 0 套才是对的，不许过度保守
  const old = affectedTests({ map: MAP, changed: ['host/machine/systemd/dao-nudge-stalled.timer'], allTests: ALL, added: [] });
  assert.equal(old.mode, 'affected');
  assert.deepEqual(old.tests, []);

  // 新增的是测试文件 ⇒ 走规则②跑它自己，不该整个退全量
  const newTest = affectedTests({
    map: MAP, changed: ['tests/brand-new.test.js'],
    allTests: [...ALL, 'tests/brand-new.test.js'], added: ['tests/brand-new.test.js'],
  });
  assert.equal(newTest.mode, 'affected');
  assert.ok(newTest.tests.includes('tests/brand-new.test.js'));
});

test('⑦ 0 命中必须带理由，不许光秃秃地判「没事」', () => {
  const r = affectedTests({ map: MAP, changed: ['README.md'], allTests: ALL });
  assert.equal(r.mode, 'affected');
  assert.deepEqual(r.tests, []);
  assert.match(r.why, /没有任何测试碰过/, '0 命中和「查过没事」必须在输出上分得开');
});

test('⑧ 不在图里的测试一律照跑——这条替掉了整个健康闸', () => {
  const withNew = [...ALL, 'tests/new-one.test.js'];
  // 改的是跟 new-one 毫无关系的文件：图里说 legs 碰过它，new-one 图里根本没有。
  const r = affectedTests({ map: MAP, changed: ['scripts/lib/legs.mjs'], allTests: withNew });
  assert.equal(r.mode, 'affected');
  assert.deepEqual(r.tests, ['tests/legs.test.js', 'tests/new-one.test.js']);
  assert.deepEqual(r.unknown, ['tests/new-one.test.js']);
  assert.match(r.why, /还不在图里/, '为什么多跑了一套，输出里要说得出来');
});

test('⑨ 图里有幽灵条目不影响判定（跑测试时自然会被剔掉）', () => {
  const r = affectedTests({ map: MAP, changed: ['scripts/lib/legs.mjs'], allTests: ['tests/legs.test.js'] });
  assert.deepEqual(r.tests, ['tests/legs.test.js'], '已删测试留在图里不该把它选出来跑');
});

test('⑩ 并回地图：只写采到了的，采不到的绝不写空数组冒充「无依赖」', () => {
  const { map, written } = mergeMapEntries({
    map: MAP,
    sampled: {
      'tests/legs.test.js': ['scripts/lib/legs.mjs', 'scripts/lib/legs.mjs', 'docs/x.json'],
      'tests/no-sample.test.js': null,        // 没采成
    },
    head: 'def5678',
  });
  assert.equal(written, 1, '只该写进 1 套');
  assert.deepEqual(map.entries['tests/legs.test.js'], ['docs/x.json', 'scripts/lib/legs.mjs'], '去重并排序');
  assert.equal('tests/no-sample.test.js' in map.entries, false, '没采成就别进图——进了就等于从此被永久跳过');
  assert.deepEqual(map.entries['tests/dao.test.js'], MAP.entries['tests/dao.test.js'], '这轮没跑的条目原样留着');
  assert.equal(map.head, 'def5678');
});

test('⑪ 给了 allTests 才剔幽灵；不给就一个都不删（裁剪跑不能拿来剃图）', () => {
  const kept = mergeMapEntries({ map: MAP, sampled: { 'tests/legs.test.js': ['a.mjs'] } });
  assert.equal(Object.keys(kept.map.entries).length, 3, '不给 allTests 时不许删条目');

  const pruned = mergeMapEntries({
    map: MAP, sampled: { 'tests/legs.test.js': ['a.mjs'] },
    allTests: ['tests/legs.test.js', 'tests/dao.test.js'],
  });
  assert.deepEqual(Object.keys(pruned.map.entries).sort(), ['tests/dao.test.js', 'tests/legs.test.js']);
});

test('⑫ 采样：一份覆盖率都没落 ⇒ 回 null，不回空数组', () => {
  const io = { exists: () => true, readDir: () => [], readFile: () => '' };
  assert.equal(depsFromRun({ covDir: '/c', readLog: '/c/reads.txt', root: '/r', testFile: 'tests/a.test.js', io }), null);
});

test('⑬ 采样：覆盖率 + 读取日志两路合并，自己不算自己的依赖', () => {
  const cov = JSON.stringify({ result: [{ url: 'file:///r/scripts/a.mjs' }, { url: 'file:///r/tests/a.test.js' }] });
  const io = {
    exists: () => true,
    readDir: () => ['cov-1.json', 'reads.txt'],
    readFile: (p) => (p.endsWith('reads.txt') ? 'docs/b.json\nnode_modules/x/y.js\n' : cov),
  };
  const deps = depsFromRun({ covDir: '/c', readLog: '/c/reads.txt', root: '/r', testFile: 'tests/a.test.js', io });
  assert.deepEqual(deps.sort(), ['docs/b.json', 'scripts/a.mjs']);
});

test('⑭ 判别力反证：把「不在图里也跑」这条拿掉，新测试立刻静默漏跑', () => {
  // 模拟旧判据——只按图查，不认「图里没有的也要跑」
  const naive = (changed, allTests) => {
    const out = new Set();
    for (const f of changed) {
      if (/\.test\.js$/.test(f)) { if (allTests.includes(f)) out.add(f); continue; }
      for (const [t, s] of Object.entries(MAP.entries)) if (s.includes(f)) out.add(t);
    }
    return [...out].sort();
  };
  const withNew = [...ALL, 'tests/new-one.test.js'];
  assert.deepEqual(naive(['scripts/lib/legs.mjs'], withNew), ['tests/legs.test.js'],
    '旧判据下 new-one 被静默跳过——这正是它当年需要一条红项来兜的原因');
  assert.deepEqual(affectedTests({ map: MAP, changed: ['scripts/lib/legs.mjs'], allTests: withNew }).tests,
    ['tests/legs.test.js', 'tests/new-one.test.js'], '新判据直接把它跑掉，不用任何人去处置红项');
});
