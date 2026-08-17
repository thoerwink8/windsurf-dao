// #588 worktree-rm 整树后序删：先计划、再执行。占用必须在开删前拦住。
const path = require('path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'dao-cmd.mjs');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

function wt(partial) {
  return {
    worktreeId: partial.id,
    displayName: partial.name,
    path: partial.path || `/tmp/${partial.id}`,
    parentWorktreeId: partial.parent || null,
    childWorktreeIds: partial.children || [],
    agents: partial.agents || [],
    isMainWorktree: !!partial.main,
    isActive: !!partial.active,
    isArchived: !!partial.archived,
    workspaceStatus: partial.status || 'in-progress',
    linkedIssue: partial.issue || null,
    branch: partial.branch || `refs/heads/${partial.id}`,
  };
}

async function main() {
  const S = await import('file://' + LIB.replace(/\\/g, '/'));

  const parent = wt({
    id: 'p1', name: '#588 - 工人', children: ['c1', 'c2'], issue: 588,
  });
  const c1 = wt({ id: 'c1', name: '#588 - 审官甲', parent: 'p1' });
  const c2 = wt({ id: 'c2', name: '#588 - 审官乙', parent: 'p1' });
  const forest = [
    wt({ id: 'master', name: 'master', main: true, active: true }),
    parent, c1, c2,
  ];

  console.log('\n=== 带 2 个子卡：后序，子先父后 ===');
  {
    const plan = S.planWorktreeRm(forest, 'p1');
    check('计划成功', plan.ok === true, JSON.stringify(plan));
    check('三棵都在顺序里', plan.order.map(n => n.id).sort().join(',') === 'c1,c2,p1', JSON.stringify(plan.order));
    check('父卡在最后', plan.order[plan.order.length - 1].id === 'p1', JSON.stringify(plan.order));
    const idx = Object.fromEntries(plan.order.map((n, i) => [n.id, i]));
    check('两个子卡都在父卡前面', idx.c1 < idx.p1 && idx.c2 < idx.p1, JSON.stringify(idx));
  }

  console.log('\n=== 子卡占用：整树不删 ===');
  {
    const busy = [
      wt({ id: 'master', name: 'master', main: true }),
      wt({ id: 'p2', name: '#1 - 工人', children: ['c3', 'c4'] }),
      wt({ id: 'c3', name: '#1 - 审官', parent: 'p2', agents: [{ state: 'working' }] }),
      wt({ id: 'c4', name: '#1 - 闲', parent: 'p2' }),
    ];
    const plan = S.planWorktreeRm(busy, 'p2');
    check('占用 → 计划失败', plan.ok === false, JSON.stringify(plan));
    check('报出错的是哪棵', /#1 - 审官/.test(plan.error) && /working/.test(plan.error), plan.error);
    check('order 空（调用方不得开删）', Array.isArray(plan.order) && plan.order.length === 0, JSON.stringify(plan.order));
    const applied = S.applyWorktreeRmPlan(plan, { rm: () => ({ ok: true }) });
    check('失败计划不会去删', applied.ok === false && (applied.removed || []).length === 0, JSON.stringify(applied));
  }

  console.log('\n=== 执行：2 子卡一条命令删干净 ===');
  {
    const plan = S.planWorktreeRm(forest, 'name:#588 - 工人');
    const seen = [];
    const applied = S.applyWorktreeRmPlan(plan, {
      rm: (node) => { seen.push(node.id); return { ok: true }; },
    });
    check('执行成功', applied.ok === true && applied.removed.length === 3, JSON.stringify(applied));
    check('实际删除顺序与计划一致', seen.join(',') === plan.order.map(n => n.id).join(','), seen.join(','));
    check('父卡最后删', seen[seen.length - 1] === 'p1', seen.join(','));
  }

  console.log('\n=== 中途失败：报已删，不装成没动过 ===');
  {
    const plan = S.planWorktreeRm(forest, 'p1');
    let n = 0;
    const applied = S.applyWorktreeRmPlan(plan, {
      rm: (node) => {
        n += 1;
        if (n === 2) return { ok: false, error: 'orca boom' };
        return { ok: true };
      },
    });
    check('中途失败非零', applied.ok === false, JSON.stringify(applied));
    check('点得出已删和失败点', applied.removed.length === 1 && applied.failed && /半删/.test(applied.error), applied.error);
  }

  console.log('\n=== 主树 / 找不到 / 子卡失踪 ===');
  {
    check('拒绝删主树', S.planWorktreeRm(forest, 'master').ok === false
      && /主树/.test(S.planWorktreeRm(forest, 'master').error), S.planWorktreeRm(forest, 'master').error);
    check('找不到就报', /找不到/.test(S.planWorktreeRm(forest, 'no-such').error));
    const ghost = [
      wt({ id: 'p3', name: '#2', children: ['ghost-1'] }),
    ];
    const g = S.planWorktreeRm(ghost, 'p3');
    check('子卡失踪 → 不删', g.ok === false && /找不到/.test(g.error), g.error);
  }

  console.log('\n=== 选择器：active / issue / 显示名 ===');
  {
    check('issue:588 命中工人卡', S.planWorktreeRm(forest, 'issue:588').ok
      && S.planWorktreeRm(forest, 'issue:588').root.id === 'p1');
    check('active 命中主树后被拒绝（不是静默删错）',
      /主树/.test(S.planWorktreeRm(forest, 'active').error));
    const waiting = [
      wt({ id: 'p4', name: '#3', children: ['c5'] }),
      wt({ id: 'c5', name: '审', parent: 'p4', agents: [{ state: 'waiting' }] }),
    ];
    check('waiting 也算占用', /占用/.test(S.planWorktreeRm(waiting, 'p4').error), S.planWorktreeRm(waiting, 'p4').error);
    const doneOnly = [
      wt({ id: 'p5', name: '#4', children: ['c6'] }),
      wt({ id: 'p5-no', name: 'x' }),
      wt({ id: 'c6', name: '审', parent: 'p5', agents: [{ state: 'done' }] }),
    ];
    check('done 不算占用，可以删', S.planWorktreeRm(doneOnly, 'p5').ok === true, JSON.stringify(S.planWorktreeRm(doneOnly, 'p5')));
  }

  console.log('\n=== 三层：孙卡先于子卡先于父卡 ===');
  {
    const deep = [
      wt({ id: 'a', name: '项', children: ['b'] }),
      wt({ id: 'b', name: '工人', parent: 'a', children: ['c'] }),
      wt({ id: 'c', name: '审官', parent: 'b' }),
    ];
    const plan = S.planWorktreeRm(deep, 'a');
    const ids = plan.order.map(n => n.id);
    check('三层都在', [...ids].sort().join(',') === 'a,b,c', ids.join(','));
    check('孙 → 子 → 父', ids.indexOf('c') < ids.indexOf('b') && ids.indexOf('b') < ids.indexOf('a'), ids.join(','));
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
