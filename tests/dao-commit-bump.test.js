// dao-commit bump.mjs 纯函数 + CLI + 指针落点（issue #787）
//
// 检查器不复用本文件：版本号合法性闸在 version-carrier-check.mjs，自持一份 semver。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const BUMP = path.join(REPO, 'host', 'skills', 'dao-commit', 'bump.mjs');
const SKILL = path.join(REPO, 'host', 'skills', 'dao-commit', 'SKILL.md');
const CLAUDE = path.join(REPO, 'CLAUDE.md');
const LOAD = import('file://' + BUMP.replace(/\\/g, '/'));

describe('dao-commit-bump', () => {
  it('落点在：skill、bump.mjs、CLAUDE.md 指针', async (t) => {
    await t.test('host/skills/dao-commit/SKILL.md 在', () => {
      assert.ok(fs.existsSync(SKILL), 'SKILL.md 缺失 ⇒ CLAUDE.md 指针指向空气');
    });
    await t.test('host/skills/dao-commit/bump.mjs 在', () => {
      assert.ok(fs.existsSync(BUMP), 'bump.mjs 缺失 ⇒ skill 动作序列调不到纯函数');
    });
    await t.test('CLAUDE.md 指向 host/skills/dao-commit/SKILL.md', () => {
      const txt = fs.readFileSync(CLAUDE, 'utf8');
      assert.ok(
        txt.includes('host/skills/dao-commit/SKILL.md'),
        'CLAUDE.md 丢了指针 ⇒ 按需入口消失',
      );
    });
    await t.test('bump.mjs 不引用 windsurf-dao 仓内脚本', () => {
      const src = fs.readFileSync(BUMP, 'utf8');
      assert.ok(!/scripts\//.test(src), 'bump.mjs 引用了仓内脚本  →  ' + src.slice(0, 200));
      const imports = [...src.matchAll(/^import\s+.*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      assert.ok(imports.every((s) => s.startsWith('node:')), '只许 node: 内置  →  ' + JSON.stringify(imports));
    });
    await t.test('SKILL.md frontmatter name=dao-commit', () => {
      const txt = fs.readFileSync(SKILL, 'utf8');
      assert.ok(/^name:\s*dao-commit\s*$/m.test(txt), 'name 必须等于目录名');
    });
  });

  it('判据分支：feat/fix/breaking/其他、同现取 major、非法 semver', async (t) => {
    const { bump } = await LOAD;

    await t.test('feat → minor，patch 归零', () => {
      const r = bump('1.2.3', 'feat');
      assert.deepStrictEqual(r, { shouldBump: true, bumpType: 'minor', from: '1.2.3', to: '1.3.0' });
    });
    await t.test('fix → patch', () => {
      const r = bump('1.2.3', 'fix');
      assert.deepStrictEqual(r, { shouldBump: true, bumpType: 'patch', from: '1.2.3', to: '1.2.4' });
    });
    await t.test('breaking → major，minor/patch 归零', () => {
      const r = bump('1.2.3', 'breaking');
      assert.deepStrictEqual(r, { shouldBump: true, bumpType: 'major', from: '1.2.3', to: '2.0.0' });
    });
    await t.test('feat 与 breaking 同现取 major', () => {
      const a = bump('1.2.3', ['feat', 'breaking']);
      const b = bump('1.2.3', 'feat,breaking');
      const c = bump('1.2.3', 'feat breaking');
      assert.equal(a.to, '2.0.0');
      assert.equal(a.bumpType, 'major');
      assert.equal(b.to, '2.0.0');
      assert.equal(c.to, '2.0.0');
    });
    await t.test('其他（chore/docs/test）不 bump', () => {
      for (const ty of ['chore', 'docs', 'test', 'refactor', 'ci', 'style']) {
        const r = bump('1.2.3', ty);
        assert.deepStrictEqual(r, { shouldBump: false, bumpType: null, from: '1.2.3', to: '1.2.3' }, ty);
      }
    });
    await t.test('feat! 视同 breaking', () => {
      const r = bump('1.2.3', 'feat!');
      assert.equal(r.bumpType, 'major');
      assert.equal(r.to, '2.0.0');
    });
    await t.test('prerelease / build 合法，bump 输出正式号', async () => {
      const { parseSemver } = await LOAD;
      assert.ok(parseSemver('1.2.3-beta.1'));
      assert.ok(parseSemver('1.2.3+build.7'));
      assert.ok(parseSemver('1.2.3-beta.1+exp.sha.5114f85'));
      assert.deepStrictEqual(bump('1.2.3-beta.1', 'feat').to, '1.3.0');
      assert.deepStrictEqual(bump('1.2.3+build.7', 'fix').to, '1.2.4');
    });
    await t.test('非法 semver 不 throw，error 字段', () => {
      for (const bad of [
        'abc', '1.2', '1', '', '1.2.3.4', 'banana',
        '01.2.3', '1.02.3', '1.2.03',
        '1.2.3-', '1.2.3-.', '1.2.3-alpha.', '1.2.3-.alpha', '1.2.3-alpha..1',
        '1.2.3+', '1.2.3+.', '1.2.3+build.',
        '1.2.3-01', '1.2.3-beta.01',
      ]) {
        const r = bump(bad, 'feat');
        assert.equal(r.shouldBump, false, bad);
        assert.equal(r.to, null, bad);
        assert.equal(r.error, 'invalid semver', bad);
      }
    });
    await t.test('null 输入也走 error，不 throw', () => {
      const r = bump(null, 'feat');
      assert.equal(r.shouldBump, false);
      assert.equal(r.error, 'invalid semver');
    });
    await t.test('v 前缀可解析，输出不带 v', () => {
      const r = bump('v1.2.3', 'fix');
      assert.equal(r.shouldBump, true);
      assert.equal(r.to, '1.2.4');
    });
  });

  it('CLI：node bump.mjs 打出 JSON', () => {
    const r = spawnSync(process.execPath, [BUMP, '1.2.3', 'feat'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const json = JSON.parse(String(r.stdout).trim());
    assert.deepStrictEqual(json, { shouldBump: true, bumpType: 'minor', from: '1.2.3', to: '1.3.0' });
  });

  it('CLI：非法 semver 退出 1 且 JSON 带 error', () => {
    const r = spawnSync(process.execPath, [BUMP, 'nope', 'feat'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    const json = JSON.parse(String(r.stdout).trim());
    assert.equal(json.error, 'invalid semver');
  });
});
