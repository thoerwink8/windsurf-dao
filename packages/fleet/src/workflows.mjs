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
  // 活动超时要覆盖 runSession 的最坏路径：首轮 waitForCompletion(stepTimeout) + unknown 宽限
  // (unknownWaitMs × unknownWaitRounds) + 收尾余量——不然宽限在生产根本跑不完，活动先被 Temporal
  // 掐死（复核实咬：单测把等待改成 1ms 所以测不到）。默认值与 createActivities 的默认保持一致。
  const unknownWaitMs = Number.isFinite(options.unknownWaitMs) ? options.unknownWaitMs : 120000;
  const unknownWaitRounds = Number.isFinite(options.unknownWaitRounds) ? options.unknownWaitRounds : 3;
  const graceSeconds = Math.ceil((unknownWaitMs * unknownWaitRounds) / 1000);
  const activityOptions = {
    startToCloseTimeout: `${task.limits.stepTimeoutSeconds + graceSeconds + 120}s`,
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
        const transientBudget = state.failureClass === 'pending' ? 10 : 5;
        if ((state.failureClass === 'retryable' || state.failureClass === 'pending') && transientRetries < transientBudget) {
          transientRetries += 1;
          // 退避必须确定性：工作流里出现随机/时间会让重放对不上历史（Temporal 沙箱外的 Math.random 不可重放）。
          // 可重试档退避 4/8/16/32/64s——回环 ws 抖动实测是几十秒到几分钟级的瞬时故障。
          await sleep(state.failureClass === 'pending' ? '60s' : `${2 ** (transientRetries + 1)}s`);
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
