// 可立即起但没起 · 判别力回归网（issue #577）
//
// 验 scripts/lib/ready-queue-check.mjs（dao-check 第 ⑮ 项）：
//   故意违规 —— 已消歧且无在途 PR/卡，必须打出「有 N 个可立即起的单没起」
//   扫完是 0 —— 形必须和「没查成」分开
//   没查成 —— 缺 labels / 缺面 / 非数组，不许压成 0
//   永不报红 —— 返回值没有 fail 槽，kind=ready 只是可见
//
// 纯函数 + fixture，不碰 orca / GitHub。
// 检查器自己解析署名和卡名，测试按同一份规格对答案，不 import dao-check ⑭。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'ready-queue-check.mjs');
const SKILL = path.join(__dirname, '..', 'host', 'skills', 'dispatch', 'SKILL.md');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function issue(number, labels) {
  const row = { number };
  if (labels !== undefined) row.labels = labels.map(name => ({ name }));
  return row;
}

describe('ready-queue', () => {
  it('#577 故意违规：已消歧且没起，必须打出可见行', async (t) => {
    const Q = await LIB_LOAD;
    const r = Q.inspectReadyQueue({
      issues: [
        issue(10, ['已消歧']),
        issue(11, ['已消歧', '任务']),
        issue(12, ['任务']),          // 没过消歧门：不算
        issue(13, ['已消歧']),        // 有 PR 署名：不算
        issue(14, ['已消歧']),        // 有卡：不算
      ],
      prs: [{ title: 'x', body: 'Closes #13' }],
      worktrees: [
        { displayName: '#14 - 在干活', isMainWorktree: false },
        { displayName: 'master', isMainWorktree: true },
      ],
    });
    await t.test('故意违规被打出「有 N 个可立即起的单没起」',
      () => {
        assert.ok(r.kind === 'ready' && /^有 2 个可立即起的单没起/.test(r.line), '故意违规被打出「有 N 个可立即起的单没起」  →  ' + JSON.stringify(r));
      });
    await t.test('列出的是没起的那两张，不是有 PR/卡的',
      () => {
        assert.ok(Array.isArray(r.ready) && r.ready.join(',') === '10,11' && /#10/.test(r.line) && /#11/.test(r.line) && !/#13/.test(r.line) && !/#14/.test(r.line), '列出的是没起的那两张，不是有 PR/卡的  →  ' + JSON.stringify(r));
      });
    await t.test('可见行不报红（没有 fail 槽，kind 不是红）',
      () => {
        assert.ok(r.fail == null && r.kind !== 'red' && r.kind !== 'fail', '可见行不报红（没有 fail 槽，kind 不是红）  →  ' + JSON.stringify(r));
      });
  });

  it('#577 扫完 0 与没查成不同形', async (t) => {
    const Q = await LIB_LOAD;
    const zeroAllInFlight = Q.inspectReadyQueue({
      issues: [issue(13, ['已消歧']), issue(14, ['已消歧'])],
      prs: [{ title: 'a', body: 'Fixes #13' }, { title: 'b', body: 'Resolves #14' }],
      worktrees: [],
    });
    const zeroEmpty = Q.inspectReadyQueue({ issues: [], prs: [], worktrees: [] });
    const noLabels = Q.inspectReadyQueue({
      issues: [{ number: 10 }],
      prs: [],
      worktrees: [],
    });
    const noIssues = Q.inspectReadyQueue({ prs: [], worktrees: [] });
    const noPrs = Q.inspectReadyQueue({ issues: [], worktrees: [] });
    const noWts = Q.inspectReadyQueue({ issues: [], prs: [] });
    const snapError = Q.inspectReadyQueue({ error: 'gh issue list 失败' });

    await t.test('全在途 → 扫完 0，不是没查成',
      () => {
        assert.ok(zeroAllInFlight.kind === 'zero' && /可立即起 0 个/.test(zeroAllInFlight.line) && !/可立即起：没查成/.test(zeroAllInFlight.line), '全在途 → 扫完 0，不是没查成  →  ' + JSON.stringify(zeroAllInFlight));
      });
    await t.test('open 单真是 0 → 同样是扫完 0',
      () => {
        assert.ok(zeroEmpty.kind === 'zero' && zeroEmpty.line === zeroAllInFlight.line, 'open 单真是 0 → 同样是扫完 0  →  ' + JSON.stringify(zeroEmpty));
      });
    await t.test('缺 labels 字段 → 没查成，不是 0',
      () => {
        assert.ok(noLabels.kind === 'unscanned' && /没查成/.test(noLabels.line) && !/可立即起 0/.test(noLabels.line), '缺 labels 字段 → 没查成，不是 0  →  ' + JSON.stringify(noLabels));
      });
    await t.test('缺 issues → 没查成',
      () => {
        assert.ok(noIssues.kind === 'unscanned' && /没查成/.test(noIssues.line), '缺 issues → 没查成  →  ' + JSON.stringify(noIssues));
      });
    await t.test('缺 prs → 没查成（在途排除做不全）',
      () => {
        assert.ok(noPrs.kind === 'unscanned' && /没查成/.test(noPrs.line), '缺 prs → 没查成（在途排除做不全）  →  ' + JSON.stringify(noPrs));
      });
    await t.test('缺 worktrees → 没查成（卡面排除做不全）',
      () => {
        assert.ok(noWts.kind === 'unscanned' && /没查成/.test(noWts.line), '缺 worktrees → 没查成（卡面排除做不全）  →  ' + JSON.stringify(noWts));
      });
    await t.test('快照带 error → 没查成',
      () => {
        assert.ok(snapError.kind === 'unscanned' && /gh issue list 失败/.test(snapError.line), '快照带 error → 没查成  →  ' + JSON.stringify(snapError));
      });
    await t.test('0 的形和没查成的形不是同一句话',
      () => {
        assert.ok(zeroEmpty.line !== noLabels.line && zeroEmpty.line !== snapError.line, '0 的形和没查成的形不是同一句话  →  ' + `${zeroEmpty.line} || ${noLabels.line}`);
      });
  });

  it('近义标不算已消歧：扫完 0，不是没查成', async (t) => {
    const Q = await LIB_LOAD;
    const r = Q.inspectReadyQueue({
      issues: [
        issue(31, ['已拍板']),
        issue(32, ['已澄清']),
        issue(33, ['disambiguated']),
        issue(34, ['待拍板']),
        issue(35, ['任务']),
      ],
      prs: [],
      worktrees: [],
    });
    await t.test('近义/其它标 → kind=zero，不是 ready',
      () => {
        assert.ok(r.kind === 'zero' && r.ready && r.ready.length === 0, '近义/其它标 → kind=zero，不是 ready  →  ' + JSON.stringify(r));
      });
    await t.test('近义标扫完 0 的形不是没查成',
      () => {
        assert.ok(/可立即起 0 个/.test(r.line) && !/可立即起：没查成/.test(r.line), '近义标扫完 0 的形不是没查成  →  ' + r.line);
      });
  });

  it('#577 卡面 / 署名边界', async (t) => {
    const Q = await LIB_LOAD;
    const archived = Q.inspectReadyQueue({
      issues: [issue(20, ['已消歧'])],
      prs: [],
      worktrees: [
        { displayName: '#20', isArchived: true },
        { displayName: '#20', isMainWorktree: true },
      ],
    });
    await t.test('archived / master 卡不算在途，#20 仍可立即起',
      () => {
        assert.ok(archived.kind === 'ready' && archived.ready.join(',') === '20', 'archived / master 卡不算在途，#20 仍可立即起  →  ' + JSON.stringify(archived));
      });

    const fixes = Q.inspectReadyQueue({
      issues: [issue(21, ['已消歧'])],
      prs: [{ title: 'Fixes #21', body: '' }],
      worktrees: [],
    });
    await t.test('Fixes #N 也算已起（本检查自己的正则）',
      () => {
        assert.ok(fixes.kind === 'zero', 'Fixes #N 也算已起（本检查自己的正则）  →  ' + JSON.stringify(fixes));
      });

    const issueNamed = Q.inspectReadyQueue({
      issues: [issue(22, ['已消歧'])],
      prs: [],
      worktrees: [{ displayName: 'ISSUE-22 工人·grok-4.6 在干活', isMainWorktree: false }],
    });
    await t.test('ISSUE- 前缀的卡算已起', () => {
      assert.ok(issueNamed.kind === 'zero', JSON.stringify(issueNamed));
    });

    const linked = Q.inspectReadyQueue({
      issues: [issue(23, ['已消歧'])],
      prs: [],
      worktrees: [{ displayName: 'PR-616 工人·grok-4.6 x', linkedIssue: 23, isMainWorktree: false }],
    });
    await t.test('linkedIssue 算已起（卡名是 PR 号也不丢）', () => {
      assert.ok(linked.kind === 'zero', JSON.stringify(linked));
    });

    const prOnly = Q.inspectReadyQueue({
      issues: [issue(24, ['已消歧'])],
      prs: [],
      worktrees: [{ displayName: 'PR-616 工人·grok-4.6 x', isMainWorktree: false }],
    });
    await t.test('只有 PR- 前缀不算 issue 24 的卡（号对不上）', () => {
      assert.ok(prOnly.kind === 'ready' && prOnly.ready.join(',') === '24', JSON.stringify(prOnly));
    });
  });

  it('#577 dispatch skill 四件里的规矩原文还在', async (t) => {
    const txt = fs.readFileSync(SKILL, 'utf8');
    await t.test('skill 写了立刻并行派', () => {
      assert.ok(/阻塞项立刻并行派/.test(txt), 'skill 写了立刻并行派  →  缺「阻塞项立刻并行派」');
    });
    await t.test('反面清单点名：等同一文件合了再派', () => {
      assert.ok(/跟在途 PR 改同一个文件，等它合了再派/.test(txt), '反面清单点名：等同一文件合了再派  →  ' + txt.slice(0, 80));
    });
    await t.test('反面清单点名：先收口避免盘面太乱', () => {
      assert.ok(/先把这一单收口，避免盘面太乱/.test(txt), '反面清单点名：先收口避免盘面太乱  →  缺第二条');
    });
    await t.test('反面清单点名：等验证完再开下一个', () => {
      assert.ok(/等这个验证完再开下一个/.test(txt), '反面清单点名：等验证完再开下一个  →  缺第三条');
    });
    await t.test('skill 写清 next 可立即起必须是列表', () => {
      assert.ok(/这些都可以现在起，不是让你挑一个/.test(txt), 'skill 写清 next 可立即起必须是列表  →  缺给 #576 的那句');
    });
  });
});