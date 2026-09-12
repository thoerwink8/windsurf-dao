// 收件箱闸（用户 2026-09-05 拍板：提醒 + 超时硬拦；#1171 挂载面改到指挥官盘点）。
// 每条对着一个实咬：codex 审计会话写的两份 docs/observations/*.md 是未跟踪文件，
// 帅位靠 git status 偶然看见 ?? 才知道——落盘了没人读，等于没写。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const LIB = 'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'inbox.mjs').replace(/\\/g, '/');
const LOAD = import(LIB);
const NOW = Date.parse('2026-09-05T12:00:00Z');
const hoursAgo = (h) => NOW - h * 3600000;

describe('收件箱：一份文档的状态', () => {
  it('没有 frontmatter 的老文件默认 new——「没标过」不许当「已读」', async () => {
    const S = await LOAD;
    const d = S.parseInboxDoc('# mirasim 巡检模型与身份\n\n## 结论\n...', { name: 'a.md', mtimeMs: NOW });
    assert.equal(d.status, S.STATUS_NEW);
    assert.equal(d.handled, false);
    assert.equal(d.title, 'mirasim 巡检模型与身份');
  });

  it('写了「处置：」行就算已处置（约定要容得下最省事的写法）', async () => {
    const S = await LOAD;
    const d = S.parseInboxDoc('# x\n\n处置：#944\n', { name: 'b.md', mtimeMs: NOW });
    assert.equal(d.handled, true);
  });

  it('frontmatter status: wontfix 也算已处置', async () => {
    const S = await LOAD;
    const d = S.parseInboxDoc('---\nstatus: wontfix\n---\n# x\n理由：本仓改不动\n', { name: 'c.md', mtimeMs: NOW });
    assert.equal(d.status, 'wontfix');
    assert.equal(d.handled, true);
  });
});

describe('收件箱：扫一轮的四态', () => {
  const doc = (over = {}) => ({ name: 'x.md', title: 't', status: 'new', handled: false, at: NOW, ...over });

  it('全处置完 → quiet，不注入（零条时不占 token）', async () => {
    const S = await LOAD;
    const r = S.assessInbox({ docs: [doc({ handled: true })], now: NOW });
    assert.equal(r.mode, 'quiet');
    assert.equal(S.renderInbox(r), '');
  });

  it('有未处置但不超时 → notice，只提醒', async () => {
    const S = await LOAD;
    const r = S.assessInbox({ docs: [doc({ at: hoursAgo(2) })], now: NOW });
    assert.equal(r.mode, 'notice');
    assert.match(S.renderInbox(r), /\[收件箱\]/);
  });

  it('超过 24 小时 → block，注入的是硬性指令不是提示', async () => {
    const S = await LOAD;
    const r = S.assessInbox({ docs: [doc({ at: hoursAgo(30) })], now: NOW });
    assert.equal(r.mode, 'block');
    const text = S.renderInbox(r);
    assert.match(text, /硬闸/);
    assert.match(text, /本轮先处置/);
  });

  it('堆到 5 条也 block（渐变状态要有触发条件，否则规矩永不触发）', async () => {
    const S = await LOAD;
    const docs = Array.from({ length: 5 }, (_, i) => doc({ name: `d${i}.md`, at: hoursAgo(1) }));
    assert.equal(S.assessInbox({ docs, now: NOW }).mode, 'block');
    assert.equal(S.assessInbox({ docs: docs.slice(0, 4), now: NOW }).mode, 'notice');
  });

  it('未跟踪文件一律 block，且单独说清「没提交别的机器看不到」（当天实咬）', async () => {
    const S = await LOAD;
    const r = S.assessInbox({ docs: [], untracked: ['2026-09-05-x.md'], now: NOW });
    assert.equal(r.mode, 'block');
    assert.match(S.renderInbox(r), /还没提交进 git/);
  });

  it('没查成 ≠ 没有新东西——目录读不了要出声', async () => {
    const S = await LOAD;
    const r = S.assessInbox({ unscanned: '目录读不了（EACCES）' });
    assert.equal(r.unscanned, true);
    assert.notEqual(r.mode, 'quiet');
    assert.match(S.renderInbox(r), /没查成/);
  });

  it('docs 不是数组 → 也判没查成，不当空', async () => {
    const S = await LOAD;
    assert.equal(S.assessInbox({ docs: null }).unscanned, true);
  });
});

describe('收件箱：盘点挂载面（#1171）', () => {
  const ROOT = path.join(__dirname, '..');
  const INV = import('file://' + path.join(ROOT, 'scripts', 'lib', 'commander-inventory.mjs').replace(/\\/g, '/'));
  const invSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'commander-inventory.mjs'), 'utf8');
  const checkSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'dao-check.mjs'), 'utf8');
  const skill = fs.readFileSync(path.join(ROOT, 'host', 'skills', 'dao-inbox', 'SKILL.md'), 'utf8');
  const gclaude = fs.readFileSync(path.join(ROOT, 'docs', 'global-CLAUDE.md'), 'utf8');

  it('block → 盘点 red，带人话三行（会开单 + 总控群）', async () => {
    const { judgeInbox } = await INV;
    const r = judgeInbox({
      mode: 'block', unscanned: false,
      pending: [{}, {}, {}], overdue: [{}], untracked: ['a.md'], lines: [],
    });
    assert.equal(r.state, 'red');
    assert.equal(r.key, 'inbox');
    assert.equal(Object.keys(r.plain || {}).sort().join(','), 'impact,plan,what');
    assert.match(r.detail, /3 条未处置/);
    assert.match(r.plain.what, /3 条/);
  });

  it('quiet → ok；notice 未到硬闸也 ok，不开单', async () => {
    const { judgeInbox } = await INV;
    assert.equal(judgeInbox({ mode: 'quiet', unscanned: false, pending: [], overdue: [], untracked: [] }).state, 'ok');
    const notice = judgeInbox({ mode: 'notice', unscanned: false, pending: [{}, {}], overdue: [], untracked: [], lines: [] });
    assert.equal(notice.state, 'ok', '未到硬闸不许红——否则 1 条新观察每 6 小时就刷一张待拍板');
    assert.match(notice.detail, /未到硬闸/);
  });

  it('没查成 → unknown，不当绿也不当红', async () => {
    const { judgeInbox } = await INV;
    const r = judgeInbox({ unscanned: true, mode: 'notice', lines: ['收件箱没查成：目录读不了'], pending: [], overdue: [] });
    assert.equal(r.state, 'unknown');
    assert.match(r.detail, /没查成/);
  });

  it('git 查不成 → unknown，不许当空（dao-check 旧病）', async () => {
    const { checkInbox } = await INV;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
    try {
      fs.mkdirSync(path.join(tmp, 'docs', 'observations'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'docs', 'observations', 'x.md'), '# x\n');
      const r = checkInbox({ ROOT: tmp });
      assert.equal(r.state, 'unknown');
      assert.match(r.detail, /没查成/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('目录确实不在 → ok（本仓没这条通道），不是没查成', async () => {
    const { checkInbox } = await INV;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-none-'));
    try {
      const r = checkInbox({ ROOT: tmp });
      assert.equal(r.state, 'ok');
      assert.match(r.detail, /不在/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('父目录不可读 → unknown，不许当「通道不在」（existsSync 会把 EACCES 报成 false）', async () => {
    const { checkInbox } = await INV;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-eacces-'));
    const docsDir = path.join(tmp, 'docs');
    try {
      fs.mkdirSync(path.join(docsDir, 'observations'), { recursive: true });
      fs.writeFileSync(path.join(docsDir, 'observations', 'x.md'), '# x\n');
      fs.chmodSync(docsDir, 0);
      const r = checkInbox({ ROOT: tmp });
      assert.equal(r.state, 'unknown', JSON.stringify(r));
      assert.match(r.detail, /没查成/);
      assert.doesNotMatch(r.detail, /不在/);
    } finally {
      try { fs.chmodSync(docsDir, 0o755); } catch { /* 清理必须先拿回权限 */ }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('现役腿是指挥官盘点调用 assessInbox，不是 dao-check，也不是已死的 hook 名', () => {
    assert.match(invSrc, /assessInbox/);
    const iInbox = invSrc.indexOf('checkInbox({ ROOT })');
    const iSurface = invSrc.lastIndexOf('scanPendingSurfacing({ runGh, REPO })');
    assert.notEqual(iInbox, -1, '盘点 checks 数组必须调用 checkInbox');
    assert.notEqual(iSurface, -1, '待消歧扫描还在');
    assert.equal(iInbox < iSurface, true, 'inbox 必须在 pending-surface 前面（后者靠 checks[length-1]）');
    assert.match(invSrc, /git 查未跟踪失败/, 'git 失败必须 unknown，不许当空');
    assert.doesNotMatch(checkSrc, /function checkInbox\b/, 'dao-check 不再当收件箱载体');
    assert.doesNotMatch(skill, /UserPromptSubmit/, 'skill 还写已死的 hook 名就红');
    assert.doesNotMatch(skill, /每轮由全局 hook/);
    assert.doesNotMatch(gclaude, /每轮由全局 hook/);
    assert.match(skill, /commander-inventory/);
    assert.match(gclaude, /盘点/);
  });
});
