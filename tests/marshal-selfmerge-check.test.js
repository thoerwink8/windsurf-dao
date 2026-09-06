// 帅位 reviews=0 自合并闸（dao-check ㉝，issue #1093）
//
// 验 scripts/lib/marshal-selfmerge-check.mjs：
//   author 与 mergedBy 同为 marshal 且 reviews=0 → 红，点名 PR；
//   扫了 N 个 0 违规 vs 一个都没扫到——后者没查成，不许当绿；
//   缺 reviews 字段 = 没查成，不是 reviews=0；
//   检查器自持 marshal 登录名，不 import gh.mjs；
//   故意违规夹具（marshal 自合 + reviews=[]）必须当场拦下。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'marshal-selfmerge-check.mjs');
const GH = path.join(REPO, 'scripts', 'lib', 'gh.mjs');
const FIX = path.join(__dirname, 'fixtures', 'marshal-selfmerge');
const HOST = path.join(REPO, 'host');
const LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function walkMd(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walkMd(p, acc);
    else if (name.endsWith('.md') && st.isFile()) acc.push(p);
  }
  return acc;
}

describe('marshal-selfmerge-check', () => {
  it('检查器不复用 gh.mjs / land.mjs', () => {
    const src = fs.readFileSync(LIB, 'utf8');
    const imports = [...src.matchAll(/^import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(!imports.some((s) => /gh\.mjs$/.test(s) || /land\.mjs$/.test(s)),
      '检查器 import 了被检查对象  →  ' + JSON.stringify(imports));
    assert.equal(/require\s*\(/.test(src), false, '也不许 require 被检查对象');
    const ghSrc = fs.readFileSync(GH, 'utf8');
    assert.match(ghSrc, /dao-marshal\[bot\]/, 'gh.mjs 仍有 marshal bot 名，检查器必须自持一份而不是 import');
  });

  it('judgeOne：marshal 自合 reviews=0 红；缺字段没查成', async (t) => {
    const S = await LOAD;

    const red = S.judgeOne({
      number: 1,
      author: { login: 'dao-marshal[bot]' },
      mergedBy: { login: 'dao-marshal[bot]' },
      reviews: [],
    });
    await t.test('故意违规：author=mergedBy=marshal 且 reviews=[] → 违规', () => {
      assert.equal(red.kind, 'ok');
      assert.equal(red.violation, true);
      assert.equal(red.reviews, 0);
    });

    const withReview = S.judgeOne({
      number: 2,
      author: { login: 'dao-marshal[bot]' },
      mergedBy: { login: 'dao-marshal[bot]' },
      reviews: [{ state: 'APPROVED' }],
    });
    await t.test('同身份但 reviews≥1 不在本闸（本闸只认 reviews=0）', () => {
      assert.equal(withReview.violation, false);
    });

    const worker = S.judgeOne({
      number: 3,
      author: { login: 'dao-worker[bot]' },
      mergedBy: { login: 'dao-marshal[bot]' },
      reviews: [],
    });
    await t.test('工人开、帅合、reviews=0：验收公式要 author 也是 marshal，本闸不报', () => {
      assert.equal(worker.violation, false);
    });

    const missingReviews = S.judgeOne({
      number: 4,
      author: { login: 'dao-marshal[bot]' },
      mergedBy: { login: 'dao-marshal[bot]' },
    });
    await t.test('缺 reviews 字段 = 没查成，不是 reviews=0', () => {
      assert.equal(missingReviews.kind, 'unscanned');
      assert.match(missingReviews.error, /没拿到 reviews/);
    });

    const missingAuthor = S.judgeOne({
      number: 5,
      mergedBy: { login: 'dao-marshal[bot]' },
      reviews: [],
    });
    await t.test('缺 author = 没查成', () => {
      assert.equal(missingAuthor.kind, 'unscanned');
    });
  });

  it('inspectMarshalSelfMerge：0 个 = 没查成；扫了 N 个 0 违规是绿', async () => {
    const S = await LOAD;

    const zero = S.inspectMarshalSelfMerge({ prs: [], baselinePr: 0 });
    assert.equal(zero.unscanned, true);
    assert.equal(zero.ok, false);
    assert.equal(zero.kind, 'unscanned');
    assert.match(zero.line, /没扫到任何样本/);

    const missing = S.inspectMarshalSelfMerge();
    assert.equal(missing.unscanned, true);

    const green = S.inspectMarshalSelfMerge({
      baselinePr: 0,
      prs: [
        {
          number: 10,
          author: { login: 'dao-worker[bot]' },
          mergedBy: { login: 'dao-marshal[bot]' },
          reviews: [{ state: 'APPROVED' }],
        },
      ],
    });
    assert.equal(green.unscanned, false);
    assert.equal(green.ok, true);
    assert.equal(green.kind, 'ok');
    assert.equal(green.scanned, 1);
    assert.equal(green.violations.length, 0);

    const red = S.inspectMarshalSelfMerge({
      baselinePr: 0,
      prs: [
        {
          number: 11,
          author: { login: 'dao-marshal[bot]' },
          mergedBy: { login: 'dao-marshal[bot]' },
          reviews: [],
        },
        {
          number: 12,
          author: { login: 'dao-worker[bot]' },
          mergedBy: { login: 'dao-marshal[bot]' },
          reviews: [{ state: 'APPROVED' }],
        },
      ],
    });
    assert.equal(red.ok, false);
    assert.equal(red.kind, 'red');
    assert.equal(red.scanned, 2);
    assert.equal(red.violations.length, 1);
    assert.equal(red.violations[0].number, 11);

    const afterBaseline = S.inspectMarshalSelfMerge({
      baselinePr: 11,
      prs: [
        {
          number: 11,
          author: { login: 'dao-marshal[bot]' },
          mergedBy: { login: 'dao-marshal[bot]' },
          reviews: [],
        },
      ],
    });
    assert.equal(afterBaseline.unscanned, true, '基准之后 0 个 = 没扫到样本，不是把存量自合并当绿');
  });

  it('夹具红/绿/空有判别力；故意 marshal 自合 reviews=0 被拦住', async () => {
    const S = await LOAD;
    const exists = (rel) => fs.existsSync(path.join(REPO, rel));
    const readFile = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
    const r = S.inspectMarshalSelfMergeFixtures({ exists, readFile });
    assert.equal(r.ok, true, r.error || (r.problems || []).join('；'));
    assert.equal(r.unscanned, false);
    assert.equal(r.kinds.red, 1);
    assert.equal(r.kinds.ok, 1);
    assert.equal(r.kinds.empty, 1);

    const redDoc = JSON.parse(fs.readFileSync(path.join(FIX, 'red.json'), 'utf8'));
    const red = S.inspectMarshalSelfMerge({ prs: redDoc.prs, baselinePr: redDoc.baselinePr ?? 0 });
    assert.equal(red.kind, 'red');
    assert.equal(red.violations[0].reviews, 0);
    assert.equal(red.violations[0].author, 'dao-marshal[bot]');
    assert.equal(red.violations[0].mergedBy, 'dao-marshal[bot]');
  });

  it('host/ 无旧口径；判定权与 reviews=0 禁令还在', () => {
    const files = walkMd(HOST);
    assert.ok(files.length > 0, 'host/ 一个 .md 都没扫到，本断言已经不在查任何东西');
    const hits = [];
    for (const p of files) {
      const text = fs.readFileSync(p, 'utf8');
      if (/帅窗禁止/.test(text) || /主会话手不碰 git/.test(text)) {
        hits.push(path.relative(REPO, p));
      }
    }
    assert.deepEqual(hits, [], 'host/ 残留旧口径 帅窗禁止 / 主会话手不碰 git  →  ' + hits.join('、'));

    const prFast = fs.readFileSync(path.join(HOST, 'skills', 'pr-fast', 'SKILL.md'), 'utf8');
    const dispatch = fs.readFileSync(path.join(HOST, 'skills', 'dispatch', 'SKILL.md'), 'utf8');
    for (const [name, text] of [['pr-fast', prFast], ['dispatch', dispatch]]) {
      assert.match(text, /主树禁 git 写/, name + ' 要写「主树禁 git 写」');
      assert.match(text, /帅窗在自己 worktree 里可以/, name + ' 要写帅窗在自己 worktree 里可以 commit/push');
      assert.match(text, /\*\*判定权永远不归帅位\*\*/, name + ' 「判定权永远不归帅位」必须加粗还在');
      assert.match(text, /帅位不得合并 reviews=0 的 PR/, name + ' 要明写不得合 reviews=0');
    }
  });
});
