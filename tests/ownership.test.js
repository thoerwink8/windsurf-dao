// 概念归属表闸：他仓「看哪」指向空气必须红；他仓不在本机 = 没查成；常驻面没指针 = 红；齐则绿。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'ownership-check.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));
const FIX = path.join(__dirname, 'fixtures', 'ownership');

function readIf(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/** 夹具约定：被测仓在 <kind>/repo，他仓在 <kind>/repos/<名>。常驻面文件叫 RESIDENT.md
 *  （不叫 CLAUDE.md/AGENTS.md——宿主会把仓内任意层的同名文件当常驻面注入）。 */
function loadFixture(kind) {
  const base = path.join(FIX, kind);
  const repoRoot = path.join(base, 'repo');
  const tableText = readIf(path.join(repoRoot, 'docs', 'ownership.json'));
  const pointerText = readIf(path.join(repoRoot, 'RESIDENT.md'));
  const reposDir = path.join(base, 'repos');
  const repoRoots = new Map();
  if (fs.existsSync(reposDir)) {
    for (const name of fs.readdirSync(reposDir)) repoRoots.set(name, path.join(reposDir, name));
  }
  return { tableText, pointerText, repoRoots };
}

describe('ownership', () => {
  it('夹具：齐 / 指向空气 / 没指针 / 他仓不在本机', async (t) => {
    const S = await LIB_LOAD;

    const ok = S.inspectOwnership(loadFixture('ok'));
    await t.test('他仓在本机且「看哪」都在 → 绿', () => {
      assert.equal(ok.kind, 'ok', '他仓在本机且看哪都在 → 绿  →  ' + JSON.stringify(ok));
      assert.ok(ok.checked > 0, '查到的指针数应大于 0  →  ' + ok.checked);
    });

    const red = S.inspectOwnership(loadFixture('red'));
    await t.test('「看哪」指向空气 → 红，且点得出那份', () => {
      assert.ok(red.kind === 'red', '指向空气 → 红  →  ' + JSON.stringify(red));
      assert.ok(/a\.md/.test(red.problems.join(' ')), '红证据点得出 a.md  →  ' + red.problems.join(' | '));
    });

    const nopointer = S.inspectOwnership(loadFixture('nopointer'));
    await t.test('常驻面没有指向本表的行 → 红', () => {
      assert.ok(nopointer.kind === 'red', '没指针 → 红  →  ' + JSON.stringify(nopointer));
      assert.ok(/常驻面/.test(nopointer.problems.join(' ')), '红证据点出常驻面  →  ' + nopointer.problems.join(' | '));
    });

    const unscanned = S.inspectOwnership(loadFixture('unscanned'));
    await t.test('声明的他仓不在本机 → 没查成，不是绿', () => {
      assert.ok(unscanned.kind === 'unscanned', '他仓不在本机 → 没查成  →  ' + JSON.stringify(unscanned));
    });
  });

  it('解析与对账是两条路，且缺字段判红', async (t) => {
    const S = await LIB_LOAD;

    const parsed = S.parseTable('{"entries":[{"概念":"甲","归仓":"fake-repo","看哪":["a.md"],"本仓只写":"乙"}]}');
    await t.test('parseTable 只解析，不碰文件系统', () => {
      assert.equal(parsed.entries.length, 1);
      assert.deepEqual(S.collectRepos(JSON.stringify({ entries: parsed.entries })), ['fake-repo']);
    });

    const bad = S.inspectOwnership({
      tableText: '{"entries":[{"概念":"甲","归仓":"fake-repo","看哪":["a.md"]}]}',
      pointerText: 'see docs/ownership.json',
      repoRoots: new Map(),
    });
    await t.test('缺「本仓只写」→ 红', () => {
      assert.equal(bad.kind, 'red', '缺字段 → 红  →  ' + JSON.stringify(bad));
      assert.ok(/本仓只写/.test(bad.problems.join(' ')), '红证据点出缺的字段  →  ' + bad.problems.join(' | '));
    });

    const empty = S.inspectOwnership({ tableText: '{"entries":[]}', pointerText: 'docs/ownership.json', repoRoots: new Map() });
    await t.test('表 0 条 → 没查成，不是绿', () => {
      assert.ok(empty.kind === 'unscanned', '0 条 → 没查成  →  ' + JSON.stringify(empty));
    });
  });
});
