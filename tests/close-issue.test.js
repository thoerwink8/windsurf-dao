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
const CLI = path.join(__dirname, '..', 'scripts', 'close-issues.mjs');
const LOAD = import('file://' + LIB.replace(/\\/g, '/'));
const LOAD_CLI = import('file://' + CLI.replace(/\\/g, '/'));

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

  it('#657 关单判定：MERGED 且全绿 → close；MERGED 但 check 红/无 check → reopen；非 MERGED → none', async (t) => {
    const C = await LOAD;
    await t.test('MERGED+绿 → close', () => {
      assert.strictEqual(C.closeDecision({ state: 'MERGED', statusCheckRollup: rollup('SUCCESS') }).action, 'close');
    });
    await t.test('MERGED+红 → reopen', () => {
      assert.strictEqual(C.closeDecision({ state: 'MERGED', statusCheckRollup: rollup('FAILURE') }).action, 'reopen');
    });
    await t.test('MERGED+无 check → reopen（没查成 ≠ 绿）', () => {
      assert.strictEqual(C.closeDecision({ state: 'MERGED', statusCheckRollup: [] }).action, 'reopen');
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
    calls.length = 0;
    await t.test('红且单已关但带「已顶替」标签→不弹回（2026-09-04：人拍过，机器让路）', () => {
      const ghLabeled = (args) => {
        calls.push(args.slice());
        if (args[0] === 'issue' && args[1] === 'view') {
          return { ok: true, json: { state: 'CLOSED', labels: [{ name: '任务' }, { name: '已顶替' }] } };
        }
        return { ok: true, json: {} };
      };
      const r = C.closeIssueForPr({ pr: { number: 5, title: 'x', body: '署名 issue #12', state: 'MERGED', statusCheckRollup: rollup('FAILURE') }, runGh: ghLabeled });
      assert.ok(r.ok && r.action === 'none', JSON.stringify(r));
      assert.match(r.reason, /已顶替/);
      assert.ok(!calls.some(a => a[0] === 'issue' && a[1] === 'reopen'), '带标签不应 reopen  →  ' + JSON.stringify(calls));
    });
  });
});

describe('close-issue 署名误中防护（#703）', () => {
  it('#305 类署名误中：目标是 PR / 单不存在 → 清晰跳过不污染 exit code；网络失败 → 仍算失败', async (t) => {
    const C = await LOAD;
    const redPr = { number: 307, title: 'x（原 #305 重开版）', body: '', state: 'MERGED', statusCheckRollup: rollup('FAILURE') };
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

describe('close-issues sweep 制度', () => {
  it('无 --pr 时默认 dry-run；实跑须 --i-know-what-im-doing', async (t) => {
    const CLI_MOD = await LOAD_CLI;
    await t.test('默认 sweep → 强制 dryRun', () => {
      const { args } = CLI_MOD.enforceSweepPolicy(CLI_MOD.parseArgs([]));
      assert.strictEqual(args.dryRun, true);
      assert.strictEqual(args.sweep, true);
    });
    await t.test('--sweep 无实跑 flag → 仍强制 dryRun', () => {
      const { args, notice } = CLI_MOD.enforceSweepPolicy(CLI_MOD.parseArgs(['--sweep']));
      assert.strictEqual(args.dryRun, true);
      assert.ok(notice && /i-know-what-im-doing/.test(notice));
    });
    await t.test('--sweep --i-know-what-im-doing → 允许实跑', () => {
      const { args } = CLI_MOD.enforceSweepPolicy(CLI_MOD.parseArgs(['--sweep', '--i-know-what-im-doing']));
      assert.strictEqual(args.dryRun, false);
      assert.strictEqual(args.iKnowWhatImDoing, true);
    });
    await t.test('--pr N 不受 sweep 限制', () => {
      const { args } = CLI_MOD.enforceSweepPolicy(CLI_MOD.parseArgs(['--pr', '42']));
      assert.strictEqual(args.dryRun, false);
      assert.strictEqual(args.pr, '42');
    });
  });
});

// ── 补丁链标记会被当成署名单号（2026-09-05 实咬 PR #893）──
describe('署名单号解析不许把补丁链标记当成 issue 号', () => {
  it('标题带 [chain:名#序号] 时，要落到正文的署名单号上', async () => {
    const { attributedIssueNumber } = await import('../scripts/lib/close-issue.mjs');
    const pr = {
      title: 'feat(events): 事件闭集加会话态三类型 [chain:session-visibility#0]',
      body: '#891 期一 W1。署名 issue #891。',
    };
    assert.equal(attributedIssueNumber(pr), 891,
      '链内序号不是 issue 号；错判成 0 会让查标签落空、复审永远派不出去（PR #893 实咬）');
  });

  it('#0 永远不是合法单号——issue 号从 1 起', async () => {
    const { attributedIssueNumber } = await import('../scripts/lib/close-issue.mjs');
    assert.equal(attributedIssueNumber({ title: '修一处 #0', body: '' }), null,
      '#0 一定是别的东西被误当成单号，宁可返回 null 让上游说「没查到」');
  });

  it('链内序号是正数时更要剥掉——否则它会冒充署名单号', async () => {
    const { attributedIssueNumber } = await import('../scripts/lib/close-issue.mjs');
    // 标题里唯一的 #N 就是链内序号 2。不剥离就返回 2，而 2 号 issue 与本 PR 毫无关系：
    // 查它的标签必然落空，复审静默派不出去（#893 同族，只是序号非 0 时 #0 那道闸拦不住）。
    const pr = { title: '[cc] fix(x): 修一处 [chain:foo#2]', body: '署名 issue #888' };
    assert.equal(attributedIssueNumber(pr), 888, '链内序号不是单号，要落到正文署名上');
  });

  it('判别力反证：标题里真的有单号时照旧优先用它', async () => {
    const { attributedIssueNumber } = await import('../scripts/lib/close-issue.mjs');
    const pr = { title: '[cc] fix(x): 修一处 #945 [chain:foo#2]', body: '署名 issue #888' };
    assert.equal(attributedIssueNumber(pr), 945, '别把整条标题优先规则一刀切废掉');
  });
});
