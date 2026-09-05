// 收件箱闸（用户 2026-09-05 拍板：提醒 + 超时硬拦 + 全局 hook 传导到所有项目）。
// 每条对着一个实咬：codex 审计会话写的两份 docs/observations/*.md 是未跟踪文件，
// 帅位靠 git status 偶然看见 ?? 才知道——落盘了没人读，等于没写。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

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

describe('收件箱：钩子形状', () => {
  const hook = path.join(__dirname, '..', 'host', 'skills', 'dao-inbox', 'hooks', 'inbox-check.mjs');
  const src = fs.readFileSync(hook, 'utf8');

  it('钩子存在且不靠 exit 2 拦——exit 2 挡掉的是用户说话，拦错对象', () => {
    assert.ok(fs.existsSync(hook));
    assert.doesNotMatch(src, /process\.exit\(2\)/, '硬拦要靠注入硬性指令，不是 exit 2');
  });

  it('git 查未跟踪失败时报「没查成」，不当作没有', () => {
    assert.match(src, /git 查未跟踪文件失败/, '查不成必须出声');
  });

  it('看的是**当前仓**的收件箱，不是 hook 自己所在的仓', () => {
    assert.match(src, /findRepoRoot\(process\.cwd\(\)\)/, '要从 cwd 找仓——全局 hook 在每个项目里跑');
  });
});
