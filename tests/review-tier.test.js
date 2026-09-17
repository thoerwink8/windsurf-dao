// 红项分级接线检查的判别力（#1227 走甲，2026-09-16 用户拍板）。
//
// 三档夹具：red 必须红、ok 必须绿、empty 必须判「没查成」。
// 三者分不开，就会把「没查成」当成「查过没事」（CLAUDE.md 自动检查节）。
//
// 夹具内容改从 tpl/ 只读模板拷进来——之前测试自己拿最小桩覆盖夹具，
// 绿夹具被覆盖后测试红，看起来像判据坏了，其实是夹具被测试写脏了。
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'review-tier-check.mjs');
// 运行时产物写系统临时目录，不写进仓：早先写在 tests/fixtures/review-tier/basic/ 下并入了库，
// 跑一次测试就往工作树里塞一堆不是夹具的文件（`git status` 一片脏）。
// 只读模板留在 tpl/，那才是真夹具。
const FIX = path.join(os.tmpdir(), `review-tier-test-${process.pid}`);
const TPL = path.join(__dirname, 'fixtures', 'review-tier', 'tpl');
const LOAD = import('file://' + LIB.split(path.sep).join('/'));

after(() => { try { fs.rmSync(FIX, { recursive: true, force: true }); } catch { /* 清不掉不拦测试 */ } });

function writeScriptsTree(scripts, spec) {
  if (spec.scriptsFiles) {
    for (const [rel, body] of Object.entries(spec.scriptsFiles)) {
      const abs = path.join(scripts, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    return;
  }
  const sample = spec.capInCode
    ? 'const n = policy.budget.per_issue.review_rounds_max;\n'
    : spec.selfHit
      ? '// 注释里的 review_rounds_max 不算接线\nconst s = \'review_rounds_max\';\nconst n = 6;\n'
      : 'const n = 6;\n';
  fs.writeFileSync(path.join(scripts, 'sample.mjs'), sample);
  if (spec.selfHit) {
    const libDir = path.join(scripts, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, 'review-tier-check.mjs'), fs.readFileSync(LIB, 'utf8'));
  }
}

/**
 * 按夹具内容铺一个临时目录，返回 check 要的 paths。
 * @param {string} name 临时目录名
 * @param {{files:object, capInCode?:boolean, selfHit?:boolean, scriptsFiles?:object}} spec
 */
function stage(name, spec) {
  const dir = path.join(FIX, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [key, body] of Object.entries(spec.files)) {
    fs.writeFileSync(path.join(dir, key), body);
  }
  const scripts = path.join(dir, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  writeScriptsTree(scripts, spec);
  return {
    standard: path.join(dir, 'review-standard.md'),
    reviewerBook: path.join(dir, 'reviewer-book.md'),
    soldierBook: path.join(dir, 'soldier-book.md'),
    policy: path.join(dir, 'release-policy.json'),
    scripts,
  };
}

const okFiles = () => ({
  'review-standard.md': fs.readFileSync(path.join(TPL, 'standard-ok.md'), 'utf8'),
  'reviewer-book.md': fs.readFileSync(path.join(TPL, 'reviewer-ok.md'), 'utf8'),
  'soldier-book.md': fs.readFileSync(path.join(TPL, 'soldier-ok.md'), 'utf8'),
  'release-policy.json': '{"budget":{"per_issue":{"review_rounds_max":6}}}',
});

describe('review-tier-check', () => {
  it('绿夹具：三档齐全 + 两书指到 + 代码真读上限 → 绿', async () => {
    const { inspectReviewTiers } = await LOAD;
    const r = inspectReviewTiers({ root: __dirname, paths: stage('ok', { files: okFiles(), capInCode: true }) });
    assert.equal(r.kind, 'ok');
    assert.match(r.line, /已接线/);
  });

  it('红夹具：标准页没分级节 → 红', async () => {
    const { inspectReviewTiers } = await LOAD;
    const files = okFiles();
    files['review-standard.md'] = '# 判绿前必核清单\n1. 审的就是这份代码\n## 红项怎么写\n- 文件:行号 + 现象 + 期望改法\n';
    const r = inspectReviewTiers({ root: __dirname, paths: stage('red-standard', { files, capInCode: true }) });
    assert.equal(r.kind, 'red');
    assert.match(r.evidence, /缺档位/);
  });

  it('只写文档不接代码：标准页齐全但没人读上限 → 红（本单要防的就是这一档）', async () => {
    const { inspectReviewTiers } = await LOAD;
    const r = inspectReviewTiers({ root: __dirname, paths: stage('red-nocode', { files: okFiles(), capInCode: false }) });
    assert.equal(r.kind, 'red');
    assert.match(r.evidence, /没有生产代码读/);
  });

  it('只有检查器自身命中（注释/字符串自命中同在）→ 红', async () => {
    const { inspectReviewTiers } = await LOAD;
    const r = inspectReviewTiers({
      root: __dirname,
      paths: stage('red-selfhit', { files: okFiles(), selfHit: true }),
    });
    assert.equal(r.kind, 'red');
    assert.match(r.evidence, /检查器自身\/注释\/字符串自命中不算/);
  });

  it('检查器自身命中 + 另有生产消费者 → 绿（只排除自身，不误杀真消费者）', async () => {
    const { inspectReviewTiers } = await LOAD;
    const r = inspectReviewTiers({
      root: __dirname,
      paths: stage('ok-with-checker', {
        files: okFiles(),
        scriptsFiles: {
          'lib/review-tier-check.mjs': fs.readFileSync(LIB, 'utf8'),
          'lib/review-cap.mjs': 'const n = policy.budget.per_issue.review_rounds_max;\n',
        },
      }),
    });
    assert.equal(r.kind, 'ok');
    assert.match(r.line, /生产代码读到/);
  });

  it('审官书漏指标准页 → 红（审官读的是它，不指等于没接线）', async () => {
    const { inspectReviewTiers } = await LOAD;
    const files = okFiles();
    files['reviewer-book.md'] = fs.readFileSync(path.join(TPL, 'reviewer-bad.md'), 'utf8');
    const r = inspectReviewTiers({ root: __dirname, paths: stage('red-book', { files, capInCode: true }) });
    assert.equal(r.kind, 'red');
    assert.match(r.evidence, /审官书没有指到/);
  });

  it('阈值不是正数 → 红（数不出轮数就没法熔断）', async () => {
    const { inspectReviewTiers } = await LOAD;
    const files = okFiles();
    files["release-policy.json"] = '{"budget":{"per_issue":{"review_rounds_max":0}}}';
    const r = inspectReviewTiers({ root: __dirname, paths: stage('red-cap', { files, capInCode: true }) });
    assert.equal(r.kind, 'red');
    assert.match(r.line, /不是正数/);
  });

  it('空夹具：文件都不在 → 判「没查成」，不是绿也不是红', async () => {
    const { inspectReviewTiers } = await LOAD;
    const dir = path.join(FIX, 'empty');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const r = inspectReviewTiers({
      root: __dirname,
      paths: {
        standard: path.join(dir, 'nope-standard.md'),
        reviewerBook: path.join(dir, 'nope-reviewer.md'),
        soldierBook: path.join(dir, 'nope-soldier.md'),
        policy: path.join(dir, 'nope-policy.json'),
        scripts: path.join(dir, 'scripts'),
      },
    });
    assert.equal(r.kind, 'unscanned');
    assert.match(r.line, /没查成/);
  });

  it('不是合法 JSON → 判「没查成」，不是红也不是绿', async () => {
    const { inspectReviewTiers } = await LOAD;
    const files = okFiles();
    files['release-policy.json'] = '{per_issue: broken';
    const r = inspectReviewTiers({ root: __dirname, paths: stage('bad-json', { files, capInCode: true }) });
    assert.equal(r.kind, 'unscanned');
    assert.match(r.line, /不是合法 JSON/);
  });
});

describe('review-cap 生产消费者', () => {
  it('读到正数上限', async () => {
    const { readReviewRoundsMax, loadReviewRoundsMax, fuseChoiceRequired } = await import(
      'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'review-cap.mjs').split(path.sep).join('/')
    );
    assert.equal(readReviewRoundsMax({ budget: { per_issue: { review_rounds_max: 6 } } }).cap, 6);
    assert.equal(loadReviewRoundsMax('{"budget":{"per_issue":{"review_rounds_max":6}}}').cap, 6);
    assert.equal(fuseChoiceRequired(5, 6).required, false);
    assert.equal(fuseChoiceRequired(6, 6).required, true);
    assert.equal(fuseChoiceRequired(7, 6).required, true);
  });

  it('不是正数 / 坏 JSON / 轮次没查成 → unscanned', async () => {
    const { readReviewRoundsMax, loadReviewRoundsMax, fuseChoiceRequired } = await import(
      'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'review-cap.mjs').split(path.sep).join('/')
    );
    assert.equal(readReviewRoundsMax(null).unscanned, true);
    assert.equal(readReviewRoundsMax({ budget: { per_issue: { review_rounds_max: 0 } } }).unscanned, true);
    assert.equal(loadReviewRoundsMax('{nope').unscanned, true);
    assert.equal(fuseChoiceRequired(1, null).unscanned, true);
    assert.equal(fuseChoiceRequired(undefined, 6).unscanned, true);
  });
});
