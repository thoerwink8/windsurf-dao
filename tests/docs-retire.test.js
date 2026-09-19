// T47：文档清退的纯判据。喂样本，不联网、不起进程。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = import('file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'docs-retire.mjs').replace(/\\/g, '/'));

const NOW = Date.parse('2026-09-19T00:00:00Z');
const DAY = 86400000;
const doc = (over) => ({ name: 'docs/a.md', title: 'x', reviewed: null, at: null, retired: false, ...over });

test('解析：reviewed 认得出；status: retired 认得出；没标过就是没标过', async () => {
  const { parseDocMeta } = await MOD;
  const d = parseDocMeta('---\nreviewed: 2026-09-19\n---\n\n# 标题\n', { name: 'docs/a.md' });
  assert.equal(d.reviewed, '2026-09-19');
  assert.equal(d.at, Date.parse('2026-09-19'));
  assert.equal(d.title, '标题');
  assert.equal(d.retired, false);

  assert.equal(parseDocMeta('---\nstatus: retired\n---\n# t\n').retired, true);
  assert.equal(parseDocMeta('# 没有 frontmatter\n').at, null);
  // 日期解析不了按「没标过」算——宁可不认，不认错
  assert.equal(parseDocMeta('---\nreviewed: 上次\n---\n# t\n').at, null);
});

test('扫一轮：全复核过 → quiet；超期 / 从没复核 → 计入 pending', async () => {
  const { assessDocs } = await MOD;
  assert.equal(assessDocs({ docs: [doc({ at: NOW - 10 * DAY, reviewed: '2026-09-09' })], now: NOW }).mode, 'quiet');
  const r = assessDocs({ docs: [doc({ at: NOW - 100 * DAY }), doc({ at: null })], now: NOW });
  assert.equal(r.overdue.length, 1);
  assert.equal(r.never.length, 1);
  assert.equal(r.pending.length, 2);
});

test('退役的文档不进判据（不删文件，加 status: retired 就算处置过）', async () => {
  const { assessDocs, judgeDocsRetire } = await MOD;
  const r = assessDocs({ docs: [doc({ at: null, retired: true })], now: NOW });
  assert.equal(r.mode, 'quiet');
  assert.equal(judgeDocsRetire(r).state, 'green');
});

test('判红：超期必红；堆积到上限也红（与 issue-retire / 收件箱同口径）', async () => {
  const { assessDocs, judgeDocsRetire } = await MOD;
  assert.equal(assessDocs({ docs: [doc({ at: NOW - 100 * DAY })], now: NOW }).mode, 'block');
  const five = Array.from({ length: 5 }, (_, i) => doc({ name: `docs/${i}.md`, at: null }));
  assert.equal(assessDocs({ docs: five, now: NOW }).mode, 'block');
  assert.equal(assessDocs({ docs: five.slice(0, 3), now: NOW }).mode, 'notice');
  assert.equal(judgeDocsRetire(assessDocs({ docs: five, now: NOW })).state, 'red');
  assert.equal(judgeDocsRetire(assessDocs({ docs: five.slice(0, 3), now: NOW })).state, 'green');
});

test('「没查成」与「没有落后文档」分得开', async () => {
  const { assessDocs, judgeDocsRetire } = await MOD;
  assert.equal(judgeDocsRetire(assessDocs({ unscanned: '读不了 docs/（ENOENT）' })).state, 'unscanned');
  assert.equal(judgeDocsRetire(assessDocs({ docs: null, now: NOW })).state, 'unscanned');
  assert.equal(judgeDocsRetire(assessDocs({ docs: [], now: NOW })).state, 'green');
  assert.match(assessDocs({ unscanned: 'x' }).lines[0], /不是「没有落后文档」/);
});

test('档案目录不进判据（判例档案永不退役）', async () => {
  const { ARCHIVE_DIRS } = await MOD;
  assert.deepEqual([...ARCHIVE_DIRS], ['decisions', 'observations', 'exams', 'retired']);
});
