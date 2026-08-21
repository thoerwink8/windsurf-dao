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

describe('close-issue 基线化（相对绿）', () => {
  const MERGE = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
  const PARENT = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';
  const named = (name, conclusion, status = 'COMPLETED') => ({ name, status, conclusion });
  /** 假 gh：merge commit → 首父；首父 check-runs 里 check 硬红、notify 绿、build 在跑。 */
  const ghBaseline = (args) => {
    if (args[0] === 'api' && args[1].includes(`/commits/${MERGE}`) && !args[1].includes('check-runs')) {
      return { ok: true, json: { parents: [{ sha: PARENT }, { sha: 'cccc' }] } };
    }
    if (args[0] === 'api' && args[1].includes(`/commits/${PARENT}/check-runs`)) {
      return { ok: true, json: { check_runs: [
        { name: 'check', status: 'completed', conclusion: 'failure' },
        { name: 'notify', status: 'completed', conclusion: 'success' },
        { name: 'build', status: 'in_progress', conclusion: null },
      ] } };
    }
    return { ok: true, json: {} };
  };

  it('baselineRedChecks：取 merge commit 首父的硬红 check 名集合', async (t) => {
    const C = await LOAD;
    await t.test('正常：硬红收编，绿的与没跑完的不收', () => {
      const r = C.baselineRedChecks({ pr: { mergeCommit: { oid: MERGE } }, runGh: ghBaseline });
      assert.ok(r.ok && r.red.has('check') && !r.red.has('notify') && !r.red.has('build') && r.base === PARENT, '基线红集合  →  ' + JSON.stringify({ ok: r.ok, red: r.red && [...r.red], base: r.base, reason: r.reason }));
    });
    await t.test('无 mergeCommit → 没查成', () => {
      assert.strictEqual(C.baselineRedChecks({ pr: {}, runGh: ghBaseline }).ok, false);
    });
    await t.test('读 merge commit 失败 → 没查成', () => {
      const r = C.baselineRedChecks({ pr: { mergeCommit: { oid: MERGE } }, runGh: () => ({ ok: false, error: 'boom' }) });
      assert.ok(!r.ok && /读 merge commit 失败/.test(r.reason), 'reason 要带失败点  →  ' + r.reason);
    });
    await t.test('无父 commit → 没查成', () => {
      const gh = () => ({ ok: true, json: { parents: [] } });
      assert.strictEqual(C.baselineRedChecks({ pr: { mergeCommit: { oid: MERGE } }, runGh: gh }).ok, false);
    });
    await t.test('基线 0 条 check → 没查成 ≠ 基线全绿', () => {
      const gh = (args) => args[1].includes('check-runs')
        ? { ok: true, json: { check_runs: [] } }
        : { ok: true, json: { parents: [{ sha: PARENT }] } };
      const r = C.baselineRedChecks({ pr: { mergeCommit: { oid: MERGE } }, runGh: gh });
      assert.ok(!r.ok && /没查成/.test(r.reason), '空基线必须报没查成  →  ' + r.reason);
    });
    await t.test('读 check-runs 失败 → 没查成', () => {
      const gh = (args) => args[1].includes('check-runs')
        ? { ok: false, error: 'api down' }
        : { ok: true, json: { parents: [{ sha: PARENT }] } };
      assert.strictEqual(C.baselineRedChecks({ pr: { mergeCommit: { oid: MERGE } }, runGh: gh }).ok, false);
    });
  });

  it('closeDecision 相对绿：失败项全属基线红 → close；否则维持 reopen', async (t) => {
    const C = await LOAD;
    const baseline = { ok: true, red: new Set(['check']), base: PARENT };
    await t.test('PR 硬红=check 且基线红=check → close（相对绿）', () => {
      const d = C.closeDecision({ state: 'MERGED', statusCheckRollup: [named('check', 'FAILURE'), named('notify', 'SUCCESS')] }, { baseline });
      assert.ok(d.action === 'close' && /相对绿/.test(d.reason), '相对绿 close  →  ' + d.reason);
    });
    await t.test('失败项超出基线（notify 红但基线 notify 绿）→ reopen', () => {
      const d = C.closeDecision({ state: 'MERGED', statusCheckRollup: [named('check', 'FAILURE'), named('notify', 'FAILURE')] }, { baseline });
      assert.ok(d.action === 'reopen' && /超出合并时基线/.test(d.reason), '超出基线不许关  →  ' + d.reason);
    });
    await t.test('基线没查成 → reopen 从严', () => {
      const d = C.closeDecision({ state: 'MERGED', statusCheckRollup: [named('check', 'FAILURE')] }, { baseline: { ok: false, reason: 'api down' } });
      assert.ok(d.action === 'reopen' && /基线没查成/.test(d.reason), '基线没查成从严  →  ' + d.reason);
    });
    await t.test('不传基线（旧调用形态）→ reopen 从严', () => {
      const d = C.closeDecision({ state: 'MERGED', statusCheckRollup: [named('check', 'FAILURE')] });
      assert.ok(d.action === 'reopen' && /基线没查成/.test(d.reason), '旧形态从严  →  ' + d.reason);
    });
    await t.test('PR 有 check 未完成 → 相对绿不适用（没查成 ≠ 绿）', () => {
      const d = C.closeDecision({ state: 'MERGED', statusCheckRollup: [{ name: 'check', status: 'IN_PROGRESS', conclusion: null }] }, { baseline });
      assert.ok(d.action === 'reopen' && /未完成/.test(d.reason), 'PR 没查完不可赦免  →  ' + d.reason);
    });
    await t.test('绝对绿不需要基线 → close', () => {
      const d = C.closeDecision({ state: 'MERGED', statusCheckRollup: [named('check', 'SUCCESS')] }, { baseline: { ok: false, reason: 'x' } });
      assert.strictEqual(d.action, 'close');
    });
  });

  it('closeIssueForPr 相对绿落动作：红 PR + 基线同名红 + 单未关 → issue close', async (t) => {
    const C = await LOAD;
    const calls = [];
    const gh = (args) => {
      calls.push(args.slice());
      if (args[0] === 'issue' && args[1] === 'view') return { ok: true, json: { state: 'OPEN' } };
      return ghBaseline(args);
    };
    await t.test('相对绿 → issue close，理由带相对绿', async () => {
      const r = C.closeIssueForPr({ pr: { number: 700, title: 'x', body: '署名 issue #699', state: 'MERGED', mergeCommit: { oid: MERGE }, statusCheckRollup: [named('check', 'FAILURE'), named('notify', 'SUCCESS')] }, runGh: gh });
      assert.ok(r.ok && r.action === 'close' && r.issue === 699 && /相对绿/.test(r.reason), '相对绿 close  →  ' + JSON.stringify(r));
      assert.ok(calls.some(a => a[0] === 'issue' && a[1] === 'close' && a[2] === '699'), '应调 issue close #699  →  ' + JSON.stringify(calls));
    });
    calls.length = 0;
    await t.test('基线没查成 → 维持 reopen 判定（单没关则不动）', async () => {
      const ghNoBase = (args) => {
        calls.push(args.slice());
        if (args[0] === 'issue' && args[1] === 'view') return { ok: true, json: { state: 'OPEN' } };
        return { ok: false, error: 'api down' };
      };
      const r = C.closeIssueForPr({ pr: { number: 700, title: 'x', body: '署名 issue #699', state: 'MERGED', mergeCommit: { oid: MERGE }, statusCheckRollup: [named('check', 'FAILURE')] }, runGh: ghNoBase });
      assert.ok(r.ok && r.action === 'none' && !calls.some(a => a[0] === 'issue' && (a[1] === 'close' || a[1] === 'reopen')), '基线没查成不许关  →  ' + JSON.stringify(r));
    });
  });
});

describe('close-issue 祖父条款（CI 建立前合并的无 check PR 豁免 reopen）', () => {
  // 祖父线 2026-08-14T02:57:51+08:00 = 2026-08-13T18:57:51Z（首个 PR check workflow
  // check.yml 经 PR #428 合入 master；更早的 ci-sweep.yml 是云审对账，不在 PR 上跑 check）。
  const BEFORE = '2026-08-10T00:00:00Z';
  const AT = '2026-08-13T18:57:51Z';
  const AFTER = '2026-08-20T00:00:00Z';

  it('grandfatherExempt：祖父线前/恰在祖父线 + 确认无 check → 豁免；其余形态一律从严', async (t) => {
    const C = await LOAD;
    await t.test('祖父线前 + 空 rollup → 豁免', () => {
      assert.ok(C.grandfatherExempt({ mergedAt: BEFORE, statusCheckRollup: [] }).exempt);
    });
    await t.test('ci-sweep 时代（8/11~8/14，云审已建但 PR check 未建）合并 + 空 rollup → 仍豁免', () => {
      assert.ok(C.grandfatherExempt({ mergedAt: '2026-08-12T00:00:00Z', statusCheckRollup: [] }).exempt);
    });
    await t.test('恰在祖父线（同一刻合入，CI 来不及跑）→ 豁免', () => {
      assert.ok(C.grandfatherExempt({ mergedAt: AT, statusCheckRollup: [] }).exempt);
    });
    await t.test('祖父线后 + 空 rollup → 不豁免（没查成 ≠ 绿）', () => {
      assert.ok(!C.grandfatherExempt({ mergedAt: AFTER, statusCheckRollup: [] }).exempt);
    });
    await t.test('mergedAt 缺失/不可解析 → 不豁免（从严）', () => {
      assert.ok(!C.grandfatherExempt({ statusCheckRollup: [] }).exempt);
      assert.ok(!C.grandfatherExempt({ mergedAt: 'not-a-date', statusCheckRollup: [] }).exempt);
    });
    await t.test('rollup 缺失（字段没查成）→ 不豁免', () => {
      assert.ok(!C.grandfatherExempt({ mergedAt: BEFORE }).exempt);
    });
    await t.test('有 check → 不归祖父管', () => {
      assert.ok(!C.grandfatherExempt({ mergedAt: BEFORE, statusCheckRollup: rollup('SUCCESS') }).exempt);
    });
  });

  it('closeDecision：祖父前无 check → close；祖父后无 check → reopen；祖父前有 check FAILURE → 仍 reopen', async (t) => {
    const C = await LOAD;
    await t.test('祖父前无 check → close（理由带祖父条款）', () => {
      const d = C.closeDecision({ state: 'MERGED', mergedAt: BEFORE, statusCheckRollup: [] });
      assert.ok(d.action === 'close' && /祖父条款/.test(d.reason), '祖父豁免 close  →  ' + d.reason);
    });
    await t.test('祖父后无 check → reopen（时代特征不背锅，从严）', () => {
      const d = C.closeDecision({ state: 'MERGED', mergedAt: AFTER, statusCheckRollup: [] });
      assert.strictEqual(d.action, 'reopen');
    });
    await t.test('祖父前有 check 且 FAILURE → 仍 reopen（祖父条款不赦免真失败）', () => {
      const d = C.closeDecision({ state: 'MERGED', mergedAt: BEFORE, statusCheckRollup: rollup('FAILURE') });
      assert.strictEqual(d.action, 'reopen');
    });
  });

  it('closeIssueForPr 祖父豁免落动作：单开着 → issue close，且不花 api 取基线', async (t) => {
    const C = await LOAD;
    const calls = [];
    const gh = (args) => {
      calls.push(args.slice());
      if (args[0] === 'issue' && args[1] === 'view') return { ok: true, json: { state: 'OPEN', url: 'https://x/issue/21' } };
      return { ok: true, json: {} };
    };
    await t.test('祖父前无 check + 单 OPEN → issue close', () => {
      const r = C.closeIssueForPr({ pr: { number: 20, title: 'x', body: '署名 issue #21', state: 'MERGED', mergedAt: BEFORE, statusCheckRollup: [] }, runGh: gh });
      assert.ok(r.ok && r.action === 'close' && r.issue === 21 && /祖父条款/.test(r.reason), '祖父豁免 close  →  ' + JSON.stringify(r));
      assert.ok(calls.some(a => a[0] === 'issue' && a[1] === 'close' && a[2] === '21'), '应调 issue close #21  →  ' + JSON.stringify(calls));
      assert.ok(!calls.some(a => a[0] === 'api'), '祖父豁免不该花 api 取基线  →  ' + JSON.stringify(calls));
    });
    calls.length = 0;
    await t.test('祖父前无 check + 单已关 → none（绝不 reopen）', () => {
      const ghClosed = (args) => {
        calls.push(args.slice());
        if (args[0] === 'issue' && args[1] === 'view') return { ok: true, json: { state: 'CLOSED', url: 'https://x/issue/22' } };
        return { ok: true, json: {} };
      };
      const r = C.closeIssueForPr({ pr: { number: 20, title: 'x', body: '署名 issue #22', state: 'MERGED', mergedAt: BEFORE, statusCheckRollup: [] }, runGh: ghClosed });
      assert.ok(r.ok && r.action === 'none' && !calls.some(a => a[0] === 'issue' && (a[1] === 'close' || a[1] === 'reopen')), '已关不动  →  ' + JSON.stringify(r));
    });
  });

  it('#305 类署名误中：目标是 PR / 单不存在 → 清晰跳过不污染 exit code；网络失败 → 仍算失败', async (t) => {
    const C = await LOAD;
    const redPr = { number: 307, title: 'x（原 #305 重开版）', body: '', state: 'MERGED', mergedAt: AFTER, statusCheckRollup: rollup('FAILURE') };
    await t.test('署名目标是 PR（url 含 /pull/）→ ok 跳过，reason 说清是 PR', () => {
      const gh = (args) => {
        if (args[0] === 'issue' && args[1] === 'view') return { ok: true, json: { state: 'CLOSED', url: 'https://github.com/x/y/pull/305' } };
        return { ok: true, json: {} };
      };
      const r = C.closeIssueForPr({ pr: redPr, runGh: gh });
      assert.ok(r.ok && r.action === 'none' && /是 PR 不是 issue/.test(r.reason), 'PR 误中跳过  →  ' + JSON.stringify(r));
    });
    await t.test('署名目标不存在 → ok 跳过，reason 说清单不存在', () => {
      const gh = () => ({ ok: false, error: 'GraphQL: Could not resolve to an issue with the number of 9999.' });
      const r = C.closeIssueForPr({ pr: { ...redPr, title: 'x', body: '署名 issue #9999' }, runGh: gh });
      assert.ok(r.ok && r.action === 'none' && /不存在/.test(r.reason), '单不存在跳过  →  ' + JSON.stringify(r));
    });
    await t.test('网络/权限失败 → ok:false（真失败保留给 exit code）', () => {
      const gh = () => ({ ok: false, error: 'connect ETIMEDOUT api.github.com:443' });
      const r = C.closeIssueForPr({ pr: { ...redPr, title: 'x', body: '署名 issue #30' }, runGh: gh });
      assert.ok(!r.ok && /网络\/权限/.test(r.error), '网络失败算真失败  →  ' + JSON.stringify(r));
    });
  });
});
