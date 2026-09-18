import { normalizeTask, judgeReview, judgeChecks, judgeDelivery, classifyStepFailure } from './contract.mjs';

const SHA = /^[a-f0-9]{40}$/;
const phases = { prepare: 'preparing', lead: 'planning', execute: 'executing', verify: 'verifying', review: 'reviewing', integrate: 'integrating', deploy: 'deploying', closeIssue: 'closing' };
const copy = value => JSON.parse(JSON.stringify(value));

export async function runFusionTask(input, io, { previous, cancelled = () => false, onState = () => {} } = {}) {
  const task = normalizeTask(input);
  const fingerprint = JSON.stringify(task);
  if (previous && (previous.taskId !== task.id || previous.fingerprint !== fingerprint)) throw new Error('checkpoint identity or contract mismatch');
  const state = previous ? copy(previous) : { taskId: task.id, fingerprint, state: 'running', phase: 'queued', round: 0 };
  if (!Number.isSafeInteger(state.round) || state.round < 0 || state.round > task.limits.reviewRounds) throw new Error('checkpoint round invalid');
  state.state = 'running';
  delete state.reason;
  delete state.failureClass;
  const report = () => onState(copy(state));
  const finish = (status, reason, extra = {}) => {
    Object.assign(state, { state: status, ...extra });
    if (reason) state.reason = reason;
    report();
    return copy(state);
  };
  const step = async (name, ...args) => {
    if (cancelled()) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    state.phase = phases[name];
    report();
    const value = await io[name](task, ...args);
    if (cancelled()) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    return value;
  };
  const artifactValid = value => value?.repository === task.repository && SHA.test(value.head || '') && typeof value.checkpoint === 'string' && value.checkpoint.length > 0;
  try {
    if (cancelled()) return finish('cancelled', 'cancelled');
    if (!state.prepared) {
      state.prepared = await step('prepare');
      if (!artifactValid(state.prepared)) {
        delete state.prepared;
        return finish('blocked', 'workspace-evidence-invalid', { failureClass: 'unscanned' });
      }
      report();
    }
    while (!state.acceptedHead) {
      if (state.round >= task.limits.reviewRounds) return finish('blocked', 'review-budget-exhausted');
      if (!state.plan) {
        state.plan = await step('lead', { prepared: state.prepared, artifact: state.artifact, feedback: state.feedback, round: state.round });
        if (typeof state.plan?.plan !== 'string' || !state.plan.plan.trim()) {
          delete state.plan;
          return finish('blocked', 'plan-not-complete', { failureClass: 'unscanned' });
        }
        report();
      }
      if (!state.artifact) {
        state.artifact = await step('execute', { plan: state.plan, prepared: state.prepared, feedback: state.feedback, round: state.round });
        if (!artifactValid(state.artifact)) {
          delete state.artifact;
          return finish('blocked', 'artifact-evidence-invalid', { failureClass: 'unscanned' });
        }
        report();
      }
      if (!state.checks) {
        state.checks = await step('verify', state.artifact);
        report();
      }
      const checked = judgeChecks(task, state.artifact.head, state.checks);
      if (checked.state === 'unscanned' || checked.state === 'pending') {
        delete state.checks;
        return finish('blocked', checked.reason, { failureClass: checked.state });
      }
      if (checked.state === 'blocked') {
        // 检查失败不进审查：把失败本身当返工输入，别烧一轮审查预算去审一份过不了闸的东西。
        state.round += 1;
        state.feedback = { head: state.artifact.head, checkpoint: state.artifact.checkpoint, checks: state.checks, blocking: [{ id: 'checks-failed', severity: 'P1', detail: `契约检查未通过：${JSON.stringify(state.checks.checks)}` }] };
        delete state.plan; delete state.artifact; delete state.checks; delete state.review;
        report();
        continue;
      }
      if (!state.review) {
        state.review = await step('review', state.artifact, { checks: state.checks, previousFindings: state.feedback?.blocking || [] });
        report();
      }
      const reviewed = judgeReview(task, state.artifact.head, state.review);
      if (reviewed.state === 'unscanned') {
        delete state.review;
        return finish('blocked', reviewed.reason, { failureClass: 'unscanned' });
      }
      state.round += 1;
      state.advisory = reviewed.advisory;
      if (checked.state === 'passed' && reviewed.state === 'passed') {
        state.acceptedHead = state.artifact.head;
        report();
        break;
      }
      state.feedback = { head: state.artifact.head, checkpoint: state.artifact.checkpoint, checks: state.checks, blocking: reviewed.blocking };
      delete state.plan;
      delete state.artifact;
      delete state.checks;
      delete state.review;
      report();
    }
    if (judgeReview(task, state.acceptedHead, state.review).state !== 'passed' || judgeChecks(task, state.acceptedHead, state.checks).state !== 'passed') {
      return finish('blocked', 'accepted-evidence-invalid', { failureClass: 'unscanned' });
    }
    if (!state.delivery?.merged) {
      state.delivery = await step('integrate', state.artifact, { review: state.review, checks: state.checks });
      report();
    }
    const merged = judgeDelivery({ ...task, contract: { ...task.contract, deploymentRequired: false } }, state.acceptedHead, state.delivery);
    if (merged.state !== 'passed') return finish('blocked', merged.reason, { failureClass: merged.state });
    if (task.contract.deploymentRequired && judgeDelivery(task, state.acceptedHead, state.delivery).state !== 'passed') {
      state.delivery.deployment = await step('deploy', state.delivery);
      report();
    }
    const delivered = judgeDelivery(task, state.acceptedHead, state.delivery);
    if (delivered.state !== 'passed') return finish('blocked', delivered.reason, { failureClass: delivered.state });
    if (!state.closed) {
      const receipt = await step('closeIssue', state.delivery, { advisory: state.advisory });
      if (receipt?.closed !== true || receipt.repository !== task.repository || receipt.issue !== task.issue) return finish('blocked', 'closure-unconfirmed', { failureClass: 'unscanned' });
      state.closed = receipt;
      report();
    }
    return finish('completed');
  } catch (error) {
    const code = error?.code || error?.cause?.type || (error?.name === 'CancelledFailure' ? 'CANCELLED' : 'UNKNOWN');
    if (code === 'CANCELLED') return finish('cancelled', 'cancelled');
    return finish('blocked', `step-failed:${code}`, { failureClass: classifyStepFailure({ code, reason: error?.cause?.message }) });
  }
}
