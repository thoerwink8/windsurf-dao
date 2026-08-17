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

const path = require('path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'ready-queue-check.mjs');
const SKILL = path.join(__dirname, '..', 'host', 'skills', 'dispatch', 'SKILL.md');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  →  ${detail}` : ''}`); }
}

function issue(number, labels) {
  const row = { number };
  if (labels !== undefined) row.labels = labels.map(name => ({ name }));
  return row;
}

async function main() {
  const Q = await import('file://' + LIB.replace(/\\/g, '/'));
  const fs = require('fs');

  console.log('\n=== #577 故意违规：已消歧且没起，必须打出可见行 ===');
  {
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
    check('故意违规被打出「有 N 个可立即起的单没起」',
      r.kind === 'ready' && /^有 2 个可立即起的单没起/.test(r.line),
      JSON.stringify(r));
    check('列出的是没起的那两张，不是有 PR/卡的',
      Array.isArray(r.ready) && r.ready.join(',') === '10,11' && /#10/.test(r.line) && /#11/.test(r.line) && !/#13/.test(r.line) && !/#14/.test(r.line),
      JSON.stringify(r));
    check('可见行不报红（没有 fail 槽，kind 不是红）',
      r.fail == null && r.kind !== 'red' && r.kind !== 'fail',
      JSON.stringify(r));
  }

  console.log('\n=== #577 扫完 0 与没查成不同形 ===');
  {
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

    check('全在途 → 扫完 0，不是没查成',
      zeroAllInFlight.kind === 'zero' && /可立即起 0 个/.test(zeroAllInFlight.line) && !/可立即起：没查成/.test(zeroAllInFlight.line),
      JSON.stringify(zeroAllInFlight));
    check('open 单真是 0 → 同样是扫完 0',
      zeroEmpty.kind === 'zero' && zeroEmpty.line === zeroAllInFlight.line,
      JSON.stringify(zeroEmpty));
    check('缺 labels 字段 → 没查成，不是 0',
      noLabels.kind === 'unscanned' && /没查成/.test(noLabels.line) && !/可立即起 0/.test(noLabels.line),
      JSON.stringify(noLabels));
    check('缺 issues → 没查成',
      noIssues.kind === 'unscanned' && /没查成/.test(noIssues.line), JSON.stringify(noIssues));
    check('缺 prs → 没查成（在途排除做不全）',
      noPrs.kind === 'unscanned' && /没查成/.test(noPrs.line), JSON.stringify(noPrs));
    check('缺 worktrees → 没查成（卡面排除做不全）',
      noWts.kind === 'unscanned' && /没查成/.test(noWts.line), JSON.stringify(noWts));
    check('快照带 error → 没查成',
      snapError.kind === 'unscanned' && /gh issue list 失败/.test(snapError.line),
      JSON.stringify(snapError));
    check('0 的形和没查成的形不是同一句话',
      zeroEmpty.line !== noLabels.line && zeroEmpty.line !== snapError.line,
      `${zeroEmpty.line} || ${noLabels.line}`);
  }

  console.log('\n=== #577 卡面 / 署名边界 ===');
  {
    const archived = Q.inspectReadyQueue({
      issues: [issue(20, ['已消歧'])],
      prs: [],
      worktrees: [
        { displayName: '#20', isArchived: true },
        { displayName: '#20', isMainWorktree: true },
      ],
    });
    check('archived / master 卡不算在途，#20 仍可立即起',
      archived.kind === 'ready' && archived.ready.join(',') === '20',
      JSON.stringify(archived));

    const fixes = Q.inspectReadyQueue({
      issues: [issue(21, ['已消歧'])],
      prs: [{ title: 'Fixes #21', body: '' }],
      worktrees: [],
    });
    check('Fixes #N 也算已起（本检查自己的正则）',
      fixes.kind === 'zero', JSON.stringify(fixes));
  }

  console.log('\n=== #577 dispatch skill 四件里的规矩原文还在 ===');
  {
    const txt = fs.readFileSync(SKILL, 'utf8');
    check('skill 写了立刻并行派', /阻塞项立刻并行派/.test(txt), '缺「阻塞项立刻并行派」');
    check('反面清单点名：等同一文件合了再派', /跟在途 PR 改同一个文件，等它合了再派/.test(txt), txt.slice(0, 80));
    check('反面清单点名：先收口避免盘面太乱', /先把这一单收口，避免盘面太乱/.test(txt), '缺第二条');
    check('反面清单点名：等验证完再开下一个', /等这个验证完再开下一个/.test(txt), '缺第三条');
    check('skill 写清 next 可立即起必须是列表', /这些都可以现在起，不是让你挑一个/.test(txt), '缺给 #576 的那句');
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
