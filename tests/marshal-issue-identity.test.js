// #627 帅操作 issue 走 marshal：dispatch 约定还在，skill 不再教裸 gh issue 写动作。
// 负控：把约定节拆掉、或再写回 `gh issue create`，必须报红。
// 零样本：一个 skill .md 都没有 → 没查成，不是绿。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const CHECK = path.join(REPO, 'scripts', 'lib', 'marshal-issue-identity-check.mjs');
const CHECK_LOAD = import('file://' + CHECK.replace(/\\/g, '/'));
const DAO = path.join(REPO, 'scripts', 'dao.mjs');
const DISPATCH = path.join(REPO, 'host', 'skills', 'dispatch', 'SKILL.md');

describe('marshal-issue-identity', () => {
  it('#627 帅操作 issue 走 marshal', async (t) => {
    const { checkMarshalIssueIdentity } = await CHECK_LOAD;

    const live = checkMarshalIssueIdentity({ root: REPO });
    await t.test('本仓约定绿', () => {
      assert.ok(!!live.green && !live.fail && live.scanned > 0, '本仓约定绿  →  ' + JSON.stringify(live));
    });

    const empty = checkMarshalIssueIdentity({ root: path.join(REPO, 'tests', 'fixtures', 'no-such-root') });
    await t.test('dispatch skill 不在 → 没查成（不是绿）', () => {
      assert.ok(!!empty.fail && /不在|没查/.test(empty.fail.join(' ')), 'dispatch skill 不在 → 没查成  →  ' + JSON.stringify(empty));
    });

    const dispatch = fs.readFileSync(DISPATCH, 'utf8');
    const noHeading = dispatch.replaceAll('帅操作 issue 的身份约定', '某节被改名');
    const headingMut = checkMarshalIssueIdentity({
      root: REPO,
      files: { 'host/skills/dispatch/SKILL.md': noHeading },
    });
    await t.test('拆掉约定节标题 → 必须报红', () => {
      assert.ok(!!headingMut.fail && /约定被拆|节标题/.test(headingMut.fail.join(' ')), '拆掉约定节标题 → 必须报红  →  ' + JSON.stringify(headingMut));
    });

    const noCmd = dispatch.replaceAll('gh-as.mjs marshal', 'gh-as.mjs worker');
    const cmdMut = checkMarshalIssueIdentity({
      root: REPO,
      files: { 'host/skills/dispatch/SKILL.md': noCmd },
    });
    await t.test('把 marshal 命令改成 worker → 必须报红', () => {
      assert.ok(!!cmdMut.fail && /marshal/.test(cmdMut.fail.join(' ')), '把 marshal 命令改成 worker → 必须报红  →  ' + JSON.stringify(cmdMut));
    });

    const admit = fs.readFileSync(path.join(REPO, 'host', 'skills', 'admit-push', 'SKILL.md'), 'utf8');
    const bare = admit.replaceAll('gh-as.mjs marshal -- issue create', 'gh issue create');
    await t.test('负控样本：admit-push 里真有裸 gh issue create', () => {
      assert.ok(/\bgh issue create\b/.test(bare), '负控样本：admit-push 里真有裸 gh issue create');
    });
    const bareMut = checkMarshalIssueIdentity({
      root: REPO,
      files: {
        'host/skills/dispatch/SKILL.md': dispatch,
        'host/skills/admit-push/SKILL.md': bare,
      },
    });
    await t.test('admit-push 写回裸 gh issue create → 必须报红', () => {
      assert.ok(!!bareMut.fail && /裸 gh issue|create/.test(bareMut.fail.join(' ')), 'admit-push 写回裸 gh issue create → 必须报红  →  ' + JSON.stringify(bareMut));
    });

    const noSkills = checkMarshalIssueIdentity({
      root: REPO,
      files: { 'host/skills/dispatch/SKILL.md': dispatch },
      skills: [],
    });
    await t.test('一个 skill .md 都没扫到 → 没查成', () => {
      assert.ok(!!noSkills.fail && /没扫到|没查/.test(noSkills.fail.join(' ')), '一个 skill .md 都没扫到 → 没查成  →  ' + JSON.stringify(noSkills));
    });

    const daoSrc = fs.readFileSync(DAO, 'utf8');
    await t.test('dispatch 打 issue label 走 marshal', () => {
      assert.ok(/stampIssueLabels\(\{[\s\S]*?runGh:\s*ghRunner\(\{\s*role:\s*'marshal'\s*\}\)/.test(daoSrc), 'dispatch 打 issue label 走 marshal');
    });
    await t.test('amend 发 issue 评论走 marshal', () => {
      assert.ok(/postIssueComment\(\{\s*issue,\s*body,\s*runGh:\s*ghRunner\(\{\s*role:\s*'marshal'\s*\}\)\s*\}\)/.test(daoSrc), 'amend 发 issue 评论走 marshal');
    });
  });
});
