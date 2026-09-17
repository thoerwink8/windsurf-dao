import { ApplicationFailure, CancellationScope, condition, defineQuery, defineSignal, isCancellation, proxyActivities, setHandler, sleep } from '@temporalio/workflow';
import { normalizeTask } from './contract.mjs';
import { runFusionTask } from './runner.mjs';

export const statusQuery = defineQuery('status');
export const resumeSignal = defineSignal('resume');
export const cancelSignal = defineSignal('cancel');

export async function fusionTaskWorkflow(input, options = {}) {
  let task;
  try { task = normalizeTask(input); }
  catch { throw ApplicationFailure.nonRetryable('Invalid fleet task contract', 'INVALID_TASK'); }
  let state = { taskId: task.id, state: 'running', phase: 'queued', round: 0 };
  let resumed = false;
  let cancelled = false;
  let transientRetries = 0;
  const scope = new CancellationScope();
  const activityOptions = {
    startToCloseTimeout: `${task.limits.stepTimeoutSeconds}s`,
    retry: { maximumAttempts: 1 },
    ...(options.activityTaskQueue ? { taskQueue: options.activityTaskQueue } : {}),
  };
  const activities = proxyActivities(activityOptions);
  setHandler(statusQuery, () => ({ taskId: state.taskId, state: state.state, phase: state.phase, round: state.round, head: state.acceptedHead || state.artifact?.head || null, reason: state.reason || null, failureClass: state.failureClass || null }));
  setHandler(resumeSignal, () => { if (state.state === 'blocked') resumed = true; });
  setHandler(cancelSignal, () => { cancelled = true; scope.cancel(); });
  try {
    await scope.run(async () => {
      let previous;
      for (;;) {
        state = await runFusionTask(task, activities, { previous, cancelled: () => cancelled, onState: value => { state = value; } });
        if (state.state !== 'blocked') return state;
        previous = state;
        const transientBudget = state.failureClass === 'pending' ? 10 : 3;
        if ((state.failureClass === 'retryable' || state.failureClass === 'pending') && transientRetries < transientBudget) {
          transientRetries += 1;
          // 退避必须确定性：工作流里出现随机/时间会让重放对不上历史（Temporal 沙箱外的 Math.random 不可重放）。
          await sleep(state.failureClass === 'pending' ? '60s' : `${2 ** transientRetries}s`);
          continue;
        }
        await condition(() => resumed);
        resumed = false;
        transientRetries = 0;
      }
    });
  } catch (error) {
    if (!cancelled && !isCancellation(error)) throw error;
    state = { ...state, state: 'cancelled', reason: 'cancelled' };
  } finally {
    if (cancelled || state.state === 'cancelled') {
      const checkpoint = state.artifact?.checkpoint || state.prepared?.checkpoint || null;
      let verified = false;
      for (let attempt = 0; attempt < 5 && !verified; attempt += 1) {
        try {
          const cleanup = await CancellationScope.nonCancellable(() => activities.cleanup(task, { checkpoint }));
          verified = cleanup?.verified === true;
        } catch { verified = false; }
        if (!verified) await CancellationScope.nonCancellable(() => sleep('5s'));
      }
      if (!verified) state = { ...state, state: 'blocked', reason: 'cancel-cleanup-unconfirmed', cancelRequested: true };
    }
  }
  return state;
}
