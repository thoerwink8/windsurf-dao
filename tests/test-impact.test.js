// tests/test-impact.test.js —— 只跑受影响的测试（TIA）的判别力
//
// 这一层唯一的危险是**静默漏跑**：算错了不会报错，只会少跑几套，然后带病合进去。
// 所以本套的重点不是「算得对」，是「算不出来时会不会退全量」「地图脏了会不会红」。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  repoRelPath, filesFromCoverage, buildMap, affectedTests, mapHealth, MAP_VERSION,
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

test('⑦ 0 命中必须带理由，不许光秃秃地判「没事」', () => {
  const r = affectedTests({ map: MAP, changed: ['README.md'], allTests: ALL });
  assert.equal(r.mode, 'affected');
  assert.deepEqual(r.tests, []);
  assert.match(r.why, /没有任何测试碰过/, '0 命中和「查过没事」必须在输出上分得开');
});

test('⑧ 地图健康度：漏登记 / 有幽灵 / 太旧 都要红', () => {
  assert.equal(mapHealth({ map: MAP, allTests: ALL }).ok, true);

  const missing = mapHealth({ map: MAP, allTests: [...ALL, 'tests/new-one.test.js'] });
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join('|'), /不在地图里/, '新增测试没入图必须红——否则它永远不会被 affected 选中');

  const ghost = mapHealth({ map: MAP, allTests: ['tests/legs.test.js'] });
  assert.equal(ghost.ok, false);
  assert.match(ghost.problems.join('|'), /已不存在/);

  const stale = mapHealth({ map: MAP, allTests: ALL, headDistance: 999 });
  assert.equal(stale.ok, false);
  assert.match(stale.problems.join('|'), /落后 HEAD/);

  assert.equal(mapHealth({ map: null, allTests: ALL }).ok, false, '没有地图 = 没查成，不是健康');
});

test('⑨ 判别力反证：把「改测试文件」那条判据拿掉，⑤ 必须垮', () => {
  // 模拟判据失效——只按图查，不认「改的就是测试本身」
  const naive = (changed) => {
    const out = new Set();
    for (const f of changed) for (const [t, s] of Object.entries(MAP.entries)) if (s.includes(f)) out.add(t);
    return [...out];
  };
  assert.deepEqual(naive(['tests/brand-new.test.js']), [], '拿掉那条判据后新测试确实漏跑——证明⑤钉的是真判据');
});
