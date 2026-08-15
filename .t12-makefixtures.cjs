const fs = require('fs');
const base = 'tests/flow-fixtures/fake-loop';
const w = (dispatchId, taskId, status, workerState) => ({
  dispatchId, taskId, runId: 'run_' + dispatchId, worktreeId: 'wt::worker-999',
  agentTerminalHandle: 'term_worker_999', dispatchStatus: status, workerState, terminalState: 'retained'
});
for (const [dir, workers, note] of [
  ['dispatch-multi-active', [w('ctx_a1', 'task_a1', 'dispatched', 'ready'), w('ctx_a2', 'task_a2', 'dispatched', 'ready'), w('ctx_hist_a', 'task_hist_a', 'completed', 'succeeded')], '样本3：多条 dispatched 真歧义 → 待帅转交'],
  ['dispatch-multi-idle', [w('ctx_i1', 'task_i1', 'completed', 'succeeded'), w('ctx_i2', 'task_i2', 'completed', 'succeeded')], '样本2：多条 completed 无在岗 → 无时间字段不猜顺序 → 待帅转交'],
  ['dispatch-failed-excluded', [w('ctx_ok', 'task_ok', 'dispatched', 'ready'), w('ctx_fail', 'task_fail', 'failed', 'failed')], '样本4：failed 一律排除']
]) {
  fs.cpSync(base, 'tests/flow-fixtures/' + dir, { recursive: true });
  fs.writeFileSync('tests/flow-fixtures/' + dir + '/orca-workers.json', JSON.stringify(workers, null, 1));
  fs.writeFileSync('tests/flow-fixtures/' + dir + '/README.md',
    note + '\n多历史 dispatch 形态字段取自真实 orca orchestration worker-list 存档\n(tests/fixtures/orca-returns/worker-list.json，采集 2026-08-15T18:14Z：\n带 worktreeId 工位 111 个，其中 21 个已有多条历史 dispatch；本 PR 工位 11 条)。\n');
}
console.log('fixtures created');
