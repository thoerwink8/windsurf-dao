// release-policy schema 闸（dao-check ㉙，issue #817）
//
// 验 scripts/lib/release-policy-check.mjs：
//   四个顶层键齐、confirm 三级齐、bump 表覆盖 conventional 类型、每项目有 demo；
//   红 —— 故意缺 confirm.major 必须拦；
//   绿 —— 合法样本与仓内 docs/release-policy.json 必须过；
//   没查成 —— {} / JSON 坏了 / 文件不在，不是绿。
// 检查器自持解析，不复用任何将来的消费方。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'release-policy-check.mjs');
const LIVE = path.join(REPO, 'docs', 'release-policy.json');
const FIX = path.join(__dirname, 'fixtures', 'release-policy-check');
const LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function validDoc(overrides) {
  return {
    confirm: {
      patch: { who: 'auto' },
      minor: { who: 'admin:1' },
      major: { who: 'admin:1' },
    },
    version: {
      bump_by_commit_type: {
        fix: 'patch',
        docs: 'patch',
        chore: 'patch',
        refactor: 'patch',
        perf: 'patch',
        feat: 'minor',
        'feat!': 'major',
        'BREAKING CHANGE': 'major',
      },
    },
    rollback: {},
    budget: {},
    demo: { example: { kind: 'scripts' } },
    ...overrides,
  };
}

describe('release-policy-check', () => {
  it('检查器不复用消费方解析', () => {
    const src = fs.readFileSync(LIB, 'utf8');
    const imports = [...src.matchAll(/^import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(imports.every((s) => s.startsWith('node:')),
      '检查器只许 node: 内置，不许 import 消费方  →  ' + JSON.stringify(imports));
  });

  it('schema：四个顶层键 / confirm 三级 / bump 表 / 每项目 demo', async (t) => {
    const S = await LOAD;

    await t.test('合法对象绿', () => {
      const r = S.inspectReleasePolicy(validDoc());
      assert.ok(r.ok && !r.unscanned && r.scanned > 0, JSON.stringify(r));
    });

    await t.test('缺顶层键 rollback 红', () => {
      const doc = validDoc();
      delete doc.rollback;
      const r = S.inspectReleasePolicy(doc);
      assert.ok(!r.ok && !r.unscanned && /rollback/.test((r.problems || []).join(' ')), JSON.stringify(r));
    });

    await t.test('confirm 缺 major 红（故意违规）', () => {
      const doc = validDoc();
      delete doc.confirm.major;
      const r = S.inspectReleasePolicy(doc);
      assert.ok(!r.ok && !r.unscanned && /confirm 缺 major/.test((r.problems || []).join(' ')), JSON.stringify(r));
    });

    await t.test('bump 表缺 feat 红', () => {
      const doc = validDoc();
      delete doc.version.bump_by_commit_type.feat;
      const r = S.inspectReleasePolicy(doc);
      assert.ok(!r.ok && /bump 表缺 feat/.test((r.problems || []).join(' ')), JSON.stringify(r));
    });

    await t.test('demo 项目缺 kind 红', () => {
      const doc = validDoc({ demo: { example: {} } });
      const r = S.inspectReleasePolicy(doc);
      assert.ok(!r.ok && /demo.example 缺 kind/.test((r.problems || []).join(' ')), JSON.stringify(r));
    });

    await t.test('空对象 = 没查成，不是绿', () => {
      const r = S.inspectReleasePolicy({});
      assert.equal(r.unscanned, true, JSON.stringify(r));
      assert.ok(!r.ok && r.scanned === 0);
    });

    await t.test('JSON 坏了 = 没查成', () => {
      const r = S.inspectReleasePolicySource('{');
      assert.equal(r.unscanned, true, JSON.stringify(r));
    });

    await t.test('根是数组 = 没查成', () => {
      const r = S.inspectReleasePolicy([]);
      assert.equal(r.unscanned, true, JSON.stringify(r));
    });
  });

  it('夹具红/绿/空有判别力；故意违规被拦住', async () => {
    const S = await LOAD;
    const r = S.inspectReleasePolicyFixtures(FIX);
    assert.ok(r.ok && !r.unscanned, JSON.stringify(r));
    assert.equal(r.kinds.red, 1);
    assert.equal(r.kinds.ok, 1);
    assert.equal(r.kinds.empty, 1);

    const red = S.inspectReleasePolicyFile(path.join(FIX, 'red', 'release-policy.json'));
    assert.ok(!red.ok && !red.unscanned && /confirm 缺 major/.test((red.problems || []).join(' ')),
      'red 夹具必须点出缺 major  →  ' + JSON.stringify(red));
  });

  it('仓内 docs/release-policy.json 可解析且过 schema', async () => {
    const S = await LOAD;
    assert.ok(fs.existsSync(LIVE), 'docs/release-policy.json 不在');
    const r = S.inspectReleasePolicyLive(REPO);
    assert.ok(r.ok && !r.unscanned, JSON.stringify(r));
    const doc = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
    for (const k of S.TOP_KEYS) {
      assert.ok(doc[k] && typeof doc[k] === 'object', `live 缺 ${k}`);
    }
    for (const lv of S.CONFIRM_LEVELS) {
      assert.ok(doc.confirm[lv], `live confirm 缺 ${lv}`);
    }
    for (const t of S.BUMP_TYPES) {
      assert.ok(doc.version.bump_by_commit_type[t], `live bump 缺 ${t}`);
    }
    const projects = Object.keys(doc.demo || {}).filter((k) => !k.startsWith('_'));
    assert.ok(projects.length > 0, 'live demo 0 个项目');
    for (const p of projects) {
      assert.ok(doc.demo[p] && doc.demo[p].kind, `live demo.${p} 缺 kind`);
    }
  });
});
