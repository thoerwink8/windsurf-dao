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
        if ((state.failureClass === 'retryable' || state.failureClass === 'pending') && transientRetries < 3) {
          transientRetries += 1;
          await sleep((2 ** transientRetries + Math.random()) * 1000);
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
      try {
        const cleanup = await CancellationScope.nonCancellable(() => activities.cleanup(task, { checkpoint: state.artifact?.checkpoint || state.prepared?.checkpoint || null }));
        if (cleanup?.verified !== true) throw new Error('cleanup not verified');
      } catch {
        state = { ...state, state: 'blocked', reason: 'cancel-cleanup-unconfirmed', cancelRequested: true };
      }
    }
  }
  return state;
}
