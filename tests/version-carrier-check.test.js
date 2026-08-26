// 版本号载体闸（dao-check ㉗，issue #787）
// 自持 semver，不 import bump.mjs。红夹具 = 倒退被当场拦下。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'version-carrier-check.mjs');
const LOAD = import('file://' + LIB.replace(/\\/g, '/'));

describe('version-carrier-check', () => {
  it('检查器不复用 bump.mjs', () => {
    const src = fs.readFileSync(LIB, 'utf8');
    const imports = [...src.matchAll(/^import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(!imports.some((s) => /bump\.mjs$/.test(s) || /dao-commit/.test(s)),
      '检查器 import 了 bump 纯函数 ⇒ 自己查自己  →  ' + JSON.stringify(imports));
  });

  it('inspectVersionChange：合法 / 倒退 / 非法 / 无变化 / 无载体', async (t) => {
    const S = await LOAD;

    await t.test('合法 bump 绿', () => {
      const r = S.inspectVersionChange({ oldRaw: '1.2.3', newRaw: '1.3.0' });
      assert.ok(r.ok && !r.skip && !r.unscanned, JSON.stringify(r));
    });
    await t.test('不 bump（号不变）绿——不判该不该 bump', () => {
      const r = S.inspectVersionChange({ oldRaw: '1.2.3', newRaw: '1.2.3' });
      assert.ok(r.ok && !r.skip, JSON.stringify(r));
    });
    await t.test('倒退红', () => {
      const r = S.inspectVersionChange({ oldRaw: '1.2.3', newRaw: '1.2.2' });
      assert.ok(!r.ok && /倒退/.test((r.problems || []).join(' ')), JSON.stringify(r));
    });
    await t.test('非法红', () => {
      const r = S.inspectVersionChange({ oldRaw: '1.2.3', newRaw: 'banana' });
      assert.ok(!r.ok && /非法/.test((r.problems || []).join(' ')), JSON.stringify(r));
    });
    await t.test('两侧都空 = skip', () => {
      const r = S.inspectVersionChange({ oldRaw: null, newRaw: null });
      assert.ok(r.skip && r.ok, JSON.stringify(r));
    });
    await t.test('首次合法号绿', () => {
      const r = S.inspectVersionChange({ oldRaw: null, newRaw: '0.1.0' });
      assert.ok(r.ok && !r.skip && r.to === '0.1.0', JSON.stringify(r));
    });
  });

  it('没给清单 = 没查成，不是没有问题', async () => {
    const S = await LOAD;
    const r = S.inspectCarriers({});
    assert.ok(r.unscanned && /没查成/.test(r.error), JSON.stringify(r));
  });

  it('package.json 抽 version；坏 JSON 当场红', async (t) => {
    const S = await LOAD;
    await t.test('抽得出', () => {
      assert.equal(S.extractVersion('{"name":"x","version":"2.0.1"}', 'package.json'), '2.0.1');
    });
    await t.test('坏 JSON 报 error', () => {
      const v = S.extractVersion('{', 'package.json');
      assert.ok(v && v.error, JSON.stringify(v));
    });
    await t.test('无 version 字段不算载体', () => {
      assert.equal(S.extractVersion('{"name":"x"}', 'package.json'), null);
    });
  });

  it('夹具判别力：red 倒退被拦 / ok 绿 / empty SKIP', async (t) => {
    const S = await LOAD;
    const r = S.inspectVersionCarrierFixtures(path.join(__dirname, 'fixtures', 'version-carrier'));
    await t.test('三类样本全过', () => {
      assert.ok(r.ok === true, JSON.stringify(r));
    });
    await t.test('red/ok/empty 各 1', () => {
      assert.ok(r.kinds.red === 1 && r.kinds.ok === 1 && r.kinds.empty === 1, JSON.stringify(r.kinds));
    });
    const red = S.inspectCarrierDir(path.join(__dirname, 'fixtures', 'version-carrier', 'red'));
    await t.test('red 夹具证据含倒退', () => {
      assert.ok(!red.ok && /倒退/.test((red.problems || []).join(' ')), JSON.stringify(red));
    });
  });

  it('live 探头：无载体 skip；git 失败没查成；倒退红', async (t) => {
    const S = await LOAD;
    await t.test('无载体 skip', () => {
      const r = S.inspectLiveVersionCarriers({
        root: path.join(__dirname, 'fixtures', 'version-carrier', 'empty'),
        mergeBaseSha: 'deadbeef',
        gitShow: () => null,
      });
      assert.ok(r.skip && r.ok && !r.unscanned, JSON.stringify(r));
    });
    await t.test('缺 gitShow = 没查成', () => {
      const r = S.inspectLiveVersionCarriers({ root: REPO, mergeBaseSha: 'x' });
      assert.ok(r.unscanned && /没查成/.test(r.error), JSON.stringify(r));
    });
    await t.test('merge-base 空 = 没查成', () => {
      const r = S.inspectLiveVersionCarriers({
        root: path.join(__dirname, 'fixtures', 'version-carrier', 'ok'),
        mergeBaseSha: null,
        gitShow: () => '1.2.3',
      });
      assert.ok(r.unscanned && /merge-base/.test(r.error), JSON.stringify(r));
    });
    await t.test('live 倒退当场拦下', () => {
      const dir = path.join(__dirname, 'fixtures', 'version-carrier', 'red');
      const r = S.inspectLiveVersionCarriers({
        root: dir,
        mergeBaseSha: 'base',
        gitShow: () => '1.2.3\n',
      });
      assert.ok(!r.ok && !r.unscanned && /倒退/.test((r.problems || []).join(' ')), JSON.stringify(r));
    });
  });
});
