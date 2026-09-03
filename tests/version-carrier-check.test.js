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

  it('SemVer 契约：prerelease/build 合法，前导零/空标识/数字预发布前导零非法', async (t) => {
    const S = await LOAD;
    const { parseSemver } = await import('file://' + path.join(REPO, 'host', 'skills', 'dao-commit', 'bump.mjs').replace(/\\/g, '/'));

    const valid = ['0.0.0', '1.2.3', '1.2.3-beta.1', '1.2.3+build.7', '1.2.3-beta.1+exp.sha.5114f85', 'v1.2.3', '1.0.0-0', '1.0.0-alpha-1', '1.2.3+01', '9007199254740992.0.0', '1.0.0-9007199254740992'];
    const invalid = [
      '01.2.3', '1.02.3', '1.2.03',
      '1.2.3-', '1.2.3-.', '1.2.3-alpha.', '1.2.3-.alpha', '1.2.3-alpha..1',
      '1.2.3+', '1.2.3+.', '1.2.3+build.',
      '1.2.3-01', '1.2.3-beta.01',
      'abc', '1.2', '1.2.3.4',
    ];

    for (const v of valid) {
      await t.test(`合法 ${v}`, () => {
        assert.ok(S.parseCarrierVersion(v), 'check 应接受  →  ' + v);
        assert.ok(parseSemver(v), 'bump 应接受  →  ' + v);
      });
    }
    for (const v of invalid) {
      await t.test(`非法 ${v}`, () => {
        assert.equal(S.parseCarrierVersion(v), null, 'check 应拒绝  →  ' + v);
        assert.equal(parseSemver(v), null, 'bump 应拒绝  →  ' + v);
      });
    }

    await t.test('审官复现：1.2.3-beta.1 不变绿', () => {
      const r = S.inspectVersionChange({ oldRaw: '1.2.3-beta.1', newRaw: '1.2.3-beta.1' });
      assert.ok(r.ok && !r.skip, JSON.stringify(r));
    });
    await t.test('审官复现：1.2.3+build.7 不变绿', () => {
      const r = S.inspectVersionChange({ oldRaw: '1.2.3+build.7', newRaw: '1.2.3+build.7' });
      assert.ok(r.ok && !r.skip, JSON.stringify(r));
    });
    await t.test('审官复现：01.2.3 非法红', () => {
      const r = S.inspectVersionChange({ oldRaw: '1.2.3', newRaw: '01.2.3' });
      assert.ok(!r.ok && /非法/.test((r.problems || []).join(' ')), JSON.stringify(r));
    });
  });

  it('prerelease 顺序符合 SemVer 2.0.0（build 不参与）', async (t) => {
    const S = await LOAD;
    const order = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        const cmp = S.compareCarrierVersion(order[i], order[j]);
        const expect = i === j ? 0 : i < j ? -1 : 1;
        const got = cmp === 0 ? 0 : cmp < 0 ? -1 : 1;
        await t.test(`${order[i]} ${expect < 0 ? '<' : expect > 0 ? '>' : '='} ${order[j]}`, () => {
          assert.equal(got, expect, `cmp=${cmp}`);
        });
      }
    }
    await t.test('build 元数据不改变优先级', () => {
      assert.equal(S.compareCarrierVersion('1.2.3+aaa', '1.2.3+bbb'), 0);
      assert.equal(S.compareCarrierVersion('1.2.3+build.7', '1.2.3'), 0);
    });
    await t.test('正式版降到预发布 = 倒退', () => {
      const r = S.inspectVersionChange({ oldRaw: '1.2.3', newRaw: '1.2.3-rc.1' });
      assert.ok(!r.ok && /倒退/.test((r.problems || []).join(' ')), JSON.stringify(r));
    });
    await t.test('预发布升到正式版绿', () => {
      const r = S.inspectVersionChange({ oldRaw: '1.2.3-beta.1', newRaw: '1.2.3' });
      assert.ok(r.ok, JSON.stringify(r));
    });
    await t.test('预发布号倒退红', () => {
      const r = S.inspectVersionChange({ oldRaw: '1.2.3-beta.2', newRaw: '1.2.3-beta.1' });
      assert.ok(!r.ok && /倒退/.test((r.problems || []).join(' ')), JSON.stringify(r));
    });
  });

  it('超过 MAX_SAFE_INTEGER 的数字标识符合法且可比较', async (t) => {
    const S = await LOAD;
    const { parseSemver, bump } = await import('file://' + path.join(REPO, 'host', 'skills', 'dao-commit', 'bump.mjs').replace(/\\/g, '/'));
    const core = '9007199254740992.0.0';
    const pre = '1.0.0-9007199254740992';
    const preNext = '1.0.0-9007199254740993';
    const coreNext = '9007199254740993.0.0';

    await t.test('两套解析器都接受超大核心段', () => {
      assert.ok(S.parseCarrierVersion(core));
      assert.ok(parseSemver(core));
    });
    await t.test('两套解析器都接受超大数字预发布', () => {
      assert.ok(S.parseCarrierVersion(pre));
      assert.ok(parseSemver(pre));
    });
    await t.test('超大预发布顺序', () => {
      const cmp = S.compareCarrierVersion(pre, preNext);
      assert.ok(cmp < 0, String(cmp));
    });
    await t.test('超大核心段升级绿，倒退红', () => {
      const up = S.inspectVersionChange({ oldRaw: core, newRaw: coreNext });
      const down = S.inspectVersionChange({ oldRaw: coreNext, newRaw: core });
      assert.ok(up.ok, JSON.stringify(up));
      assert.ok(!down.ok && /倒退/.test((down.problems || []).join(' ')), JSON.stringify(down));
    });
    await t.test('bump 超大核心段加一', () => {
      assert.equal(bump(core, 'breaking').to, coreNext);
      assert.equal(bump(core, 'fix').to, '9007199254740992.0.1');
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

  it('溯源（#800）：非发布提交动版本号红 / release 提交或 tag 上动绿 / 未变 skip / 没查成', async (t) => {
    const S = await LOAD;
    await t.test('isReleaseCommit：release: 前缀（含宿主标）认，普通提交不认', () => {
      assert.ok(S.isReleaseCommit('release: v1.3.0'));
      assert.ok(S.isReleaseCommit('[cc] release: v1.3.0'));
      assert.ok(S.isReleaseCommit('release(train): v1.3.0'));
      assert.ok(!S.isReleaseCommit('[cc] feat: 顺手 bump'));
      assert.ok(!S.isReleaseCommit('fix: 修个 bug'));
    });
    await t.test('非发布提交动版本号 → 红', () => {
      const r = S.inspectCarrierProvenance({ oldRaw: '1.2.3', newRaw: '1.3.0', changingCommits: [{ subject: '[cc] feat: x', tagged: false }] });
      assert.ok(!r.ok && !r.skip && !r.unscanned && /非发布提交/.test((r.problems || []).join(' ')), JSON.stringify(r));
    });
    await t.test('release 提交上动 → 绿', () => {
      const r = S.inspectCarrierProvenance({ oldRaw: '1.2.3', newRaw: '1.3.0', changingCommits: [{ subject: 'release: v1.3.0', tagged: false }] });
      assert.ok(r.ok && !r.skip, JSON.stringify(r));
    });
    await t.test('被 tag 指到的提交上动 → 绿', () => {
      const r = S.inspectCarrierProvenance({ oldRaw: '1.2.3', newRaw: '1.3.0', changingCommits: [{ subject: '[cc] feat: x', tagged: true }] });
      assert.ok(r.ok && !r.skip, JSON.stringify(r));
    });
    await t.test('载体未变 → skip（正常提交不动版本号是常态）', () => {
      const r = S.inspectCarrierProvenance({ oldRaw: '1.2.3', newRaw: '1.2.3', changingCommits: null });
      assert.ok(r.ok && r.skip, JSON.stringify(r));
    });
    await t.test('变了却没给改动提交清单 → 没查成', () => {
      const r = S.inspectCarrierProvenance({ oldRaw: '1.2.3', newRaw: '1.3.0', changingCommits: null });
      assert.ok(r.unscanned && /没查成/.test(r.error), JSON.stringify(r));
    });
    await t.test('夹具判别力：nonrelease-red 红 / release-ok 绿 / unchanged-skip skip', () => {
      const r = S.inspectCarrierProvenanceFixtures(path.join(__dirname, 'fixtures', 'version-carrier-provenance'));
      assert.ok(r.ok === true, JSON.stringify(r));
      assert.ok(r.kinds.red === 1 && r.kinds.ok === 1 && r.kinds.skip === 1, JSON.stringify(r.kinds));
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
