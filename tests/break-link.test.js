// T48：断链闸的纯判据。喂样本，不联网、不起进程。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = import('file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'break-link-check.mjs').replace(/\\/g, '/'));

const c = (body, url) => ({ body, html_url: url || 'https://example.invalid/c' });
const base = { openNumbers: new Set(), openSlugs: new Set() };

test('认 `[断链]` 开头（含粗体），写在中间不算', async () => {
  const { isBreakComment } = await MOD;
  assert.equal(isBreakComment('[断链] 本机起不了审官'), true);
  assert.equal(isBreakComment('**[断链]** 同上'), true);
  assert.equal(isBreakComment('  [断链] 缩进也算'), true);
  assert.equal(isBreakComment('这条不是断链，只是提到 [断链] 这个词'), false);
  assert.equal(isBreakComment(''), false);
});

test('解析自带处置：已修 / 不修 / 已开单 #N / 起因', async () => {
  const { parseBreakLink } = await MOD;
  assert.deepEqual(parseBreakLink('[断链] x\n\n已修：PR #1'), { slug: null, fixed: true, wontfix: false, opened: null });
  assert.deepEqual(parseBreakLink('[断链] x\n\n不修：Windows 专属'), { slug: null, fixed: false, wontfix: true, opened: null });
  assert.deepEqual(parseBreakLink('[断链] x\n\n已开单：#1539'), { slug: null, fixed: false, wontfix: false, opened: 1539 });
  assert.equal(parseBreakLink('[断链] x\n\n起因：break-link-gate').slug, 'break-link-gate');
  assert.equal(parseBreakLink('[断链] x\n\n已开单：还没开').opened, null);
});

test('判红：没 slug 也没处置的断链必须红（本轮真实形态）', async () => {
  const { judgeBreakLinks } = await MOD;
  const r = judgeBreakLinks({ ...base, comments: [c('[断链] 本机起不了审官\n\n处置：① 本行留痕；② 等 T17 收口')] });
  assert.equal(r.state, 'red');
  assert.equal(r.breaks, 1);
  assert.equal(r.unresolved.length, 1);
  assert.match(r.unresolved[0].why, /没法追踪/);
});

test('判绿：自带 已修 / 不修 / 已开单（且还开着）/ 起因（有 OPEN 单）', async () => {
  const { judgeBreakLinks } = await MOD;
  assert.equal(judgeBreakLinks({ ...base, comments: [c('[断链] a\n\n已修：PR #1')] }).state, 'green');
  assert.equal(judgeBreakLinks({ ...base, comments: [c('[断链] b\n\n不修：Windows 专属')] }).state, 'green');
  assert.equal(judgeBreakLinks({ ...base, openNumbers: new Set([1539]), comments: [c('[断链] c\n\n已开单：#1539')] }).state, 'green');
  assert.equal(judgeBreakLinks({ ...base, openSlugs: new Set(['x']), comments: [c('[断链] d\n\n起因：x')] }).state, 'green');
  // 已开单但那张单已经关了 = 没有在管的修复 → 红
  assert.equal(judgeBreakLinks({ ...base, comments: [c('[断链] e\n\n已开单：#1539')] }).state, 'red');
});

test('后补的处置评论也算（评论改不了，所以允许后补一条）；一条评论里多条都收', async () => {
  const { judgeBreakLinks, parseDispositions } = await MOD;
  const comments = [c('[断链] f\n\n起因：reviewer-create-win'), c('别的评论\n\n断链已处置：reviewer-create-win → 不修（Windows 专属）')];
  assert.equal(parseDispositions(comments).get('reviewer-create-win'), '不修（Windows 专属）');
  assert.equal(judgeBreakLinks({ ...base, comments }).state, 'green');

  // 一次处置好几条是常态——逐行全收，不许只取第一条（第一次真跑就栽在这里）
  const many = parseDispositions([c('断链已处置：a → 不修（理由一）\n断链已处置：issuecomment-1 → 已开单 #2（理由二）')]);
  assert.equal(many.size, 2);
  assert.equal(many.get('issuecomment-1'), '已开单 #2（理由二）');
});

test('没写 slug 的老断链：按评论键 `issuecomment-<id>` 后补处置也能关', async () => {
  const { judgeBreakLinks, commentKey } = await MOD;
  const old = { body: '[断链] 老账，没写 slug', html_url: 'https://github.com/o/r/issues/1460#issuecomment-5732109416' };
  assert.equal(commentKey(old), 'issuecomment-5732109416');
  assert.equal(judgeBreakLinks({ ...base, comments: [old] }).state, 'red');
  assert.equal(judgeBreakLinks({ ...base, comments: [old, c('断链已处置：issuecomment-5732109416 → 已开单 #1539')] }).state, 'green');
});

test('没有断链 = 绿（扫完查出 0 条），与「没查成」分得开', async () => {
  const { judgeBreakLinks } = await MOD;
  const none = judgeBreakLinks({ ...base, comments: [c('普通评论')] });
  assert.equal(none.state, 'green');
  assert.match(none.why, /扫完查出 0 条/);

  assert.equal(judgeBreakLinks({ ...base, comments: null }).state, 'unscanned');
  assert.equal(judgeBreakLinks({ comments: [], openNumbers: [], openSlugs: new Set() }).state, 'unscanned');
  assert.equal(judgeBreakLinks({ comments: [], openNumbers: new Set(), openSlugs: null }).state, 'unscanned');
});
