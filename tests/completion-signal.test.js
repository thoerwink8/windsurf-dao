// #575 ⑥ 完工信号契约检查：flow 读的首行「完工」与 soldier-book 教的必须是同一句。
// 检查器自己持有标记，不 import flow/judgment 的正则。
// 负控：把 soldier-book 里的「完工」改成「已完成」必须报红。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const CHECK = path.join(REPO, 'scripts', 'lib', 'completion-signal-check.mjs');
const CHECK_LOAD = import('file://' + CHECK.replace(/\\/g, '/'));

describe('completion-signal', () => {
  it('#575 ⑥ 完工信号契约', async (t) => {
    const { checkCompletionSignal } = await CHECK_LOAD;

    const live = checkCompletionSignal({ root: REPO });
    await t.test('本仓契约必须是绿（三处都在钉着同一句「完工」）', () => {
      assert.ok(!!live.green && !live.fail, '本仓自身必须过完工信号契约  →  ' + JSON.stringify(live));
    });

    const empty = checkCompletionSignal({ root: path.join(REPO, 'tests', 'fixtures', 'no-such-root') });
    await t.test('文件不在 → 没查成（不是绿）', () => {
      assert.ok(!!empty.fail && /不在|没查/.test(empty.fail[0] + empty.fail[1]), '文件不在 → 没查成（不是绿）  →  ' + JSON.stringify(empty));
    });

    const brief = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'templates', 'soldier-book.md'), 'utf8');
    const broken = brief.replaceAll('完工', '已完成');
    await t.test('负控样本：soldier-book 里已没有「完工」二字', () => {
      assert.ok(!broken.includes('完工') && broken.includes('已完成'), '负控样本：soldier-book 里已没有「完工」二字');
    });
    const mutated = checkCompletionSignal({
      root: REPO,
      files: { 'host/skills/dispatch/templates/soldier-book.md': broken },
    });
    await t.test('把 soldier-book 的「完工」改成「已完成」→ 必须报红', () => {
      assert.ok(!!mutated.fail && /对不上|已完成|完工/.test(mutated.fail.join(' ')), '把 soldier-book 的「完工」改成「已完成」→ 必须报红  →  ' + JSON.stringify(mutated));
    });

    const skill = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'SKILL.md'), 'utf8');
    const skillBroken = skill.replace('交棒发到 **issue comment**', '交棒发到 **编排层 worker_done**');
    const skillMut = checkCompletionSignal({
      root: REPO,
      files: { 'host/skills/dispatch/SKILL.md': skillBroken },
    });
    await t.test('改坏 dispatch skill 契约注释 → 必须报红', () => {
      assert.ok(!!skillMut.fail, '改坏 dispatch skill 契约注释 → 必须报红  →  ' + JSON.stringify(skillMut));
    });
  });
});