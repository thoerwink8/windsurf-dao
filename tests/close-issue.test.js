// 关单只认脚本（issue #657）· 判别力回归网
//
// 验 scripts/lib/close-issue.mjs：
//   署名单号解析（新规范「署名 issue #N」+ 旧关单词）
//   关单判定：MERGED 且 check 全绿才 issue close；合进但 check 红不关、若已关则重开
//   没查成 ≠ 绿：statusCheckRollup 缺失/空/未完成/FAILURE 都不是绿
// 纯函数 + 注入 mock runGh，不碰 orca / GitHub。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'close-issue.mjs');
const LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function rollup(...conclusions) {
  return conclusions.map(c => ({ status: 'COMPLETED', conclusion: c }));
}

describe('close-issue 署名单号', () => {
  it('#657 正文「署名 issue #N」是署名单号（非 GitHub 关单词，不触发自动关单）', async (t) => {
    const C = await LOAD;
    const nums = C.attributedIssueNumbers('署名 issue #657，关单交给关单脚本。\n参考 #498 #480');
    await t.test('署名 issue #N 抽到 657，随手引用的 #498 #480 不算', () => {
      assert.deepStrictEqual(nums, [657], '署名 issue #N 抽到 657，随手引用的 #498 #480 不算  →  ' + JSON.stringify(nums));
    });
  });
  it('旧关单词 Closes #N / Fixes #N 向后兼容仍是署名单号', async (t) => {
    const C = await LOAD;
    await t.test('Closes #564 抽到 564', () => {
      assert.deepStrictEqual(C.attributedIssueNumbers('Closes #564'), [564]);
    });
    await t.test('Fixes #12 抽到 12', () => {
      assert.deepStrictEqual(C.attributedIssueNumbers('Fixes #12'), [12]);
    });
  });
  it('attributedIssueNumber：标题 #N 优先，其次正文署名', async (t) => {
    const C = await LOAD;
    await t.test('标题带 #N 取标题', () => {
      assert.strictEqual(C.attributedIssueNumber({ title: '[pi] #657 关单', body: '署名 issue #99' }), 657);
    });
    await t.test('标题无号取正文署名', () => {
      assert.strictEqual(C.attributedIssueNumber({ title: '修 bug', body: '署名 issue #42' }), 42);
    });
    await t.test('都没有 → null', () => {
      assert.strictEqual(C.attributedIssueNumber({ title: '修 bug', body: '无追溯' }), null);
    });
  });
});

describe('close-issue 判定', () => {
  it('#657 check 全绿判定：有空/缺失/未完成/FAILURE 都不是绿', async (t) => {
    const C = await LOAD;
    await t.test('statusCheckRollup 缺失 → 没查成 ≠ 绿', () => {
      assert.strictEqual(C.allChecksGreen({}).green, false);
    });
    await t.test('空数组 → 无 check ≠ 绿', () => {
      assert.strictEqual(C.allChecksGreen({ statusCheckRollup: [] }).green, false);
    });
    await t.test('未完成（IN_PROGRESS）→ 不绿', () => {
      assert.strictEqual(C.allChecksGreen({ statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: null }] }).green, false);
    });
    await t.test('FAILURE → 不绿', () => {
      assert.strictEqual(C.allChecksGreen({ statusCheckRollup: rollup('FAILURE') }).green, false);
    });
    await t.test('全 SUCCESS → 绿', () => {
      assert.strictEqual(C.allChecksGreen({ statusCheckRollup: rollup('SUCCESS', 'SUCCESS') }).green, true);
    });
    await t.test('有 check 无结论 → 没查成 ≠ 绿', () => {
      assert.strictEqual(C.allChecksGreen({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: '' }] }).green, false);
    });
  });

  it('#657 关单判定：MERGED 且全绿 → close；MERGED 但 check 红 → reopen（不许关）；非 MERGED → none', async (t) => {
    const C = await LOAD;
    await t.test('MERGED+绿 → close', () => {
      assert.strictEqual(C.closeDecision({ state: 'MERGED', statusCheckRollup: rollup('SUCCESS') }).action, 'close');
    });
    await t.test('MERGED+红 → reopen', () => {
      assert.strictEqual(C.closeDecision({ state: 'MERGED', statusCheckRollup: rollup('FAILURE') }).action, 'reopen');
    });
    await t.test('未合并 → none', () => {
      assert.strictEqual(C.closeDecision({ state: 'OPEN', statusCheckRollup: rollup('SUCCESS') }).action, 'none');
    });
  });

  it('#657 落动作：绿→issue close；红但单已关→issue reopen；红但单没关→不动', async (t) => {
    const C = await LOAD;
    const calls = [];
    const gh = (args) => {
      calls.push(args.slice());
      if (args[0] === 'issue' && args[1] === 'view') {
        const n = Number(args[2]);
        return { ok: true, json: { state: n === 10 ? 'CLOSED' : 'OPEN' } };
      }
      return { ok: true, json: {} };
    };
    await t.test('绿→issue close', () => {
      const r = C.closeIssueForPr({ pr: { number: 1, title: 'x', body: '署名 issue #9', state: 'MERGED', statusCheckRollup: rollup('SUCCESS') }, runGh: gh });
      assert.ok(r.ok && r.action === 'close' && r.issue === 9);
      assert.ok(calls.some(a => a[0] === 'issue' && a[1] === 'close' && a[2] === '9'), '应调 issue close #9  →  ' + JSON.stringify(calls));
    });
    calls.length = 0;
    await t.test('红且单已关→issue reopen', () => {
      const r = C.closeIssueForPr({ pr: { number: 2, title: 'x', body: '署名 issue #10', state: 'MERGED', statusCheckRollup: rollup('FAILURE') }, runGh: gh });
      assert.ok(r.ok && r.action === 'reopen' && r.issue === 10);
      assert.ok(calls.some(a => a[0] === 'issue' && a[1] === 'reopen' && a[2] === '10'), '应调 issue reopen #10  →  ' + JSON.stringify(calls));
    });
    calls.length = 0;
    await t.test('红但单没关→不动', () => {
      const r = C.closeIssueForPr({ pr: { number: 3, title: 'x', body: '署名 issue #11', state: 'MERGED', statusCheckRollup: rollup('FAILURE') }, runGh: gh });
      assert.ok(r.ok && r.action === 'none');
      assert.ok(!calls.some(a => a[0] === 'issue' && (a[1] === 'close' || a[1] === 'reopen')), '红且单没关不应调任何写动作  →  ' + JSON.stringify(calls));
    });
    calls.length = 0;
    await t.test('绿但单已关→不动', () => {
      const r = C.closeIssueForPr({ pr: { number: 4, title: 'x', body: '署名 issue #10', state: 'MERGED', statusCheckRollup: rollup('SUCCESS') }, runGh: gh });
      assert.ok(r.ok && r.action === 'none');
      assert.ok(!calls.some(a => a[0] === 'issue' && a[1] === 'close'), '绿但单已关不应重复 close  →  ' + JSON.stringify(calls));
    });
  });
});
