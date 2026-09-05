// scripts/lib/spawn-budget.mjs —— 测试里起子进程的预算闸（TIA 第二刀的防忘装置）
//
// 来历（2026-09-06 用户拍板「两刀都要做，但后面肯定会忘记」）：
// 第二刀是把 196 处 `spawnSync(node, [CLI, ...])` 改成进程内调用——
// 实测每次 spawn ≈ 52-120ms，196 处光启动费就 ~23s，是全量测试 27s 的主体。
// 这活量大、要逐处判断「这条断言还需不需要 CLI 边界」，做不完一轮。
//
// **防忘不靠记性，靠一条会响的闸**：预算写死在这里，超了就报。
// 第二刀往下做，预算跟着降；一直没做，它一直响。
//
// 为什么是「上限」不是「必须减少」：新增测试合理地需要 spawn 时不该被拦死，
// 只是要看得见总量。降预算是显式动作——改这个数字本身就是一次记账。

/** 当前允许的 spawnSync 调用总数。第二刀每做一批就把这个数改小，不许只加不减。 */
export const SPAWN_BUDGET = 136;

/**
 * 数的是**调用**，不是「提到」。
 * 2026-09-06 首版按 /spawnSync/ 计数，结果本闸自己的测试文件里
 * `import { classifySpawnBudget }` 那行、注释里写的 `spawnSync` 全被算进去，
 * 总数凭空多出几处——判据把「提到」当成了「使用」，这类闸最典型的假阳性。
 * 只认后面紧跟 `(` 的形态。
 */
export const SPAWN_CALL_RE = /\bspawnSync\s*\(/g;

export function countSpawnCalls(source) {
  return (String(source).match(SPAWN_CALL_RE) || []).length;
}

/** 预算的由来与目标，报警时原样打给人看——只报数字没人知道该怎么办。 */
export const BUDGET_NOTE = '第二刀（spawn → 进程内调用）做到 136：dao.test 早退型已转完（-18），'
  + 'board-gc #902 补了 2 处真 git spawn；剩下的是真建树/真发请求的动词，进程内跑会共享模块状态互相污染，转它们要先隔离状态；目标 ≤40';

/**
 * @param {{file:string,count:number}[]} counts 每个测试文件的 spawnSync 出现次数
 * @returns {{state:'ok'|'red'|'unknown', detail:string, total?:number}}
 */
export function classifySpawnBudget(counts) {
  if (!Array.isArray(counts)) return { state: 'unknown', detail: '扫描结果不是数组（没查成）' };
  if (counts.length === 0) {
    // 「一个文件都没扫到」和「扫完 0 处 spawn」必须分开：前者是扫描面坏了。
    return { state: 'unknown', detail: '一个测试文件都没扫到——没查成，不是「没有 spawn」' };
  }
  const total = counts.reduce((s, c) => s + (Number(c.count) || 0), 0);
  if (total > SPAWN_BUDGET) {
    const top = [...counts].sort((a, b) => b.count - a.count).slice(0, 3).map((c) => `${c.file}×${c.count}`).join('、');
    return {
      state: 'red',
      total,
      detail: `测试里 spawnSync ${total} 处，超预算 ${SPAWN_BUDGET}（${BUDGET_NOTE}）。大头：${top}`,
    };
  }
  return {
    state: 'ok',
    total,
    detail: total === SPAWN_BUDGET
      ? `spawnSync ${total} 处，正好卡在预算上——${BUDGET_NOTE}`
      : `spawnSync ${total} 处 / 预算 ${SPAWN_BUDGET}（还差 ${SPAWN_BUDGET - total} 到上限）`,
  };
}
