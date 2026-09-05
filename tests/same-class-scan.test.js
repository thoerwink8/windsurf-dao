// 审官标准第 9 条「同类扫描」段闸（2026-09-05 拍板）。
// 起因：用户原话「我不可能实时注意到……希望能有一个机制主动发现不合理的地方」。
// 实咬：闪窗修复只改了 3 处热点，用户点破后才扩到全仓 61 处（PR #928）。
//
// 本闸只拦机械可判的「没写」；「写得对不对」归审官。四态必须分得开：
// pass / violation / unscanned（正文没读成）/ n/a（不是修复类，本闸不适用）。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const url = (rel) => 'file://' + path.join(REPO, rel).replace(/\\/g, '/');
const load = () => import(url('scripts/lib/dispatch/same-class-scan.mjs'));

const GOOD_BODY = `## 目标
修 A 处的空指针。

## 同类扫描

\`\`\`
grep -rn "foo(" scripts/ | grep -v null-check
\`\`\`

输出 3 处：a.mjs:10、b.mjs:22、c.mjs:88。全仓 3 处已一并修。

## 进展
全绿。`;

describe('同类扫描段闸（审官标准第 9 条）', () => {
  it('齐全（段 + 命令 + 结论）→ pass', async () => {
    const { gateSameClassScan } = await load();
    const r = gateSameClassScan({ title: '[cc] fix(x): 修 A 处空指针', body: GOOD_BODY });
    assert.equal(r.state, 'pass', JSON.stringify(r));
  });

  it('缺整段 → violation，且点名缺什么', async () => {
    const { gateSameClassScan } = await load();
    const r = gateSameClassScan({ title: '[cc] fix(x): 修 A 处空指针', body: '## 目标\n修了。\n## 进展\n绿。' });
    assert.equal(r.state, 'violation', JSON.stringify(r));
    assert.ok(r.missing.some(m => m.includes('同类扫描')), JSON.stringify(r));
  });

  it('有段但没给命令 → violation（「我扫过了」不算证据）', async () => {
    const { gateSameClassScan } = await load();
    const body = '## 同类扫描\n我全仓扫了一遍，全仓 1 处，只此一处。';
    const r = gateSameClassScan({ title: 'fix: x', body });
    assert.equal(r.state, 'violation', JSON.stringify(r));
    assert.ok(r.missing.some(m => m.includes('命令')), JSON.stringify(r));
  });

  it('有命令但没写结论 → violation（贴了输出不等于交代了结论）', async () => {
    const { gateSameClassScan } = await load();
    const body = '## 同类扫描\n\n```\ngrep -rn foo scripts/\n```\n\n（贴了一堆输出）';
    const r = gateSameClassScan({ title: 'fix: x', body });
    assert.equal(r.state, 'violation', JSON.stringify(r));
    assert.ok(r.missing.some(m => m.includes('结论')), JSON.stringify(r));
  });

  it('三种结论各自都认（只此一处 / 另有 N 处 / 扫不出来）', async () => {
    const { gateSameClassScan } = await load();
    const cmd = '\n\n```\ngrep -rn foo scripts/\n```\n\n';
    for (const concl of ['只此一处。', '另有 4 处，本单不修，已落单 #123。', '扫不出来：判据无法机械表达，理由是…']) {
      const r = gateSameClassScan({ title: 'fix: x', body: `## 同类扫描${cmd}${concl}` });
      assert.equal(r.state, 'pass', `结论「${concl}」应认 → ${JSON.stringify(r)}`);
    }
  });

  it('不是修复类 PR → n/a（与「没查成」分开）', async () => {
    const { gateSameClassScan } = await load();
    const r = gateSameClassScan({ title: '[cc] feat(x): 新增功能', body: '## 目标\n加个功能' });
    assert.equal(r.state, 'n/a', JSON.stringify(r));
  });

  it('正文没读成 → unscanned，不许当 pass 也不许当 violation', async () => {
    const { gateSameClassScan } = await load();
    for (const body of [null, undefined]) {
      const r = gateSameClassScan({ title: 'fix: x', body });
      assert.equal(r.state, 'unscanned', `body=${body} → ${JSON.stringify(r)}`);
    }
  });

  it('isFix 显式传入压过标题推断（调用方另有判据时）', async () => {
    const { gateSameClassScan } = await load();
    const asFix = gateSameClassScan({ title: '[cc] chore: 顺手改的', body: '## 目标\n无', isFix: true });
    assert.equal(asFix.state, 'violation', '显式说是修复类就要查 → ' + JSON.stringify(asFix));
    const notFix = gateSameClassScan({ title: '[cc] fix(x): 修 A', body: '## 目标\n无', isFix: false });
    assert.equal(notFix.state, 'n/a', '显式说不是就不查 → ' + JSON.stringify(notFix));
  });

  it('规矩落在两处任务书里（改了实现不改书 = 工人不知道要写）', () => {
    const fs = require('fs');
    const std = fs.readFileSync(path.join(REPO, 'host/skills/dispatch/review-standard.md'), 'utf8');
    const book = fs.readFileSync(path.join(REPO, 'host/skills/dispatch/templates/soldier-book.md'), 'utf8');
    assert.match(std, /同类扫描/, '审官标准要有第 9 条');
    assert.match(book, /同类扫描/, '工人任务书要写，否则只能靠审官判红后返工');
  });
});
