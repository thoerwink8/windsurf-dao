import { normalizeTask, judgeReview, judgeChecks, judgeDelivery, classifyStepFailure } from './contract.mjs';
import { splitFindings } from './triage.mjs';
import { classifyRisk, tierPlan } from './risk.mjs';
import { buildEscalation } from './escalation.mjs';

const SHA = /^[a-f0-9]{40}$/;
const phases = { prepare: 'preparing', lead: 'planning', execute: 'executing', verify: 'verifying', changedFiles: 'classifying', selfReview: 'self-reviewing', review: 'reviewing', integrate: 'integrating', deploy: 'deploying', closeIssue: 'closing' };
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
  const finish = async (status, reason, extra = {}) => {
    Object.assign(state, { state: status, ...extra });
    if (reason) state.reason = reason;
    if (status === 'blocked') {
      // T39 ④：阶梯走完还解决不了就**上报指挥官裁决**（机器可读载荷），别继续空转。
      state.escalation = buildEscalation({ task, state, reason, extra });
      try {
        state.escalationReceipt = await io.escalate(task, state.escalation);
      } catch (error) {
        // 上报失败不挡收尾，但要在状态里留痕（不许静默）。
        state.escalationReceipt = { written: false, why: String((error && error.message) || error).slice(0, 160) };
      }
    }
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
        state.feedback = { head: state.artifact.head, checkpoint: state.artifact.checkpoint, checks: state.checks, blocking: [{ id: 'checks-failed', severity: 'P1', detail: `契约检查未通过：${JSON.stringify(state.checks.checks)}` }], sessionKey: state.artifact.sessionKey };
        delete state.plan; delete state.artifact; delete state.checks; delete state.review; delete state.selfReview; delete state.risk;
        report();
        continue;
      }
      // T34 风险分层：按爆炸半径决定这一步要不要自审/异厂审查（严格程度正比于爆炸半径）。
      if (!state.risk) {
        state.risk = await step('changedFiles', state.artifact);
        report();
      }
      state.riskTier = classifyRisk({ files: state.risk?.files }) || 'T2';
      const tierSteps = tierPlan(state.riskTier);
      if (!tierSteps.review) {
        // T0（纯文档）：CI 绿即过，不派审查。
        state.acceptedHead = state.artifact.head;
        report();
        break;
      }
      // T33 两级审查的第一级：lead 自审（上下文还热、便宜）先捞掉便宜的，异厂审查者看到更干净的产物。
      // 它**不参与判定**：只把判为「当场修」的当返工输入；其余照旧走异厂审查。T1 跳过这一级。
      if (tierSteps.selfReview && !state.selfReview) {
        state.selfReview = await step('selfReview', state.artifact, { checks: state.checks, plan: state.plan });
        report();
      }
      const { rework: selfRework } = tierSteps.selfReview
        ? splitFindings({ findings: state.selfReview?.findings || [], resumable: !!state.artifact.sessionKey })
        : { rework: [] };
      if (selfRework.length) {
        state.round += 1;
        state.feedback = { head: state.artifact.head, checkpoint: state.artifact.checkpoint, checks: state.checks, blocking: selfRework, sessionKey: state.artifact.sessionKey };
        delete state.plan; delete state.artifact; delete state.checks; delete state.review; delete state.selfReview; delete state.risk;
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
      // T7：把上一轮执行会话的 key 带进反馈——返工要**续跑同一会话**（上下文还热），不是重开。
      // T33：返工只带「P1 + 急的 + 便宜且上下文热的」；其余进册子（不啃大改）。
      const { rework } = splitFindings({ findings: reviewed.advisory, resumable: !!state.artifact.sessionKey });
      state.feedback = { head: state.artifact.head, checkpoint: state.artifact.checkpoint, checks: state.checks, blocking: [...reviewed.blocking, ...rework], sessionKey: state.artifact.sessionKey };
      delete state.plan;
      delete state.artifact;
      delete state.checks;
      delete state.review;
      delete state.selfReview;
      delete state.risk;
      report();
    }
    const reviewOk = state.riskTier === 'T0' || judgeReview(task, state.acceptedHead, state.review).state === 'passed';
    if (!reviewOk || judgeChecks(task, state.acceptedHead, state.checks).state !== 'passed') {
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
      // T32：advisory 必须**随 delivery 走**——活动层签名是 (task, delivery)，第三个参数会被丢掉
      // （此前就是这么丢的：P2/P3 到不了任何消费方 = 静默丢失）。
      const receipt = await step('closeIssue', { ...state.delivery, advisory: state.advisory });
      if (receipt?.closed !== true || receipt.repository !== task.repository || receipt.issue !== task.issue) return finish('blocked', 'closure-unconfirmed', { failureClass: 'unscanned' });
      state.closed = receipt;
      report();
    }
    return finish('completed');
  } catch (error) {
    const code = error?.code || error?.cause?.type || (error?.name === 'CancelledFailure' ? 'CANCELLED' : 'UNKNOWN');
    if (code === 'CANCELLED') return finish('cancelled', 'cancelled');
    const detail = String(error?.cause?.message || error?.message || '').slice(0, 160);
    const failureClass = classifyStepFailure({ code, reason: detail });
    // T39 ①：停滞单独说——「本步超预算、phase 没进展」，别混进 step-failed:UNKNOWN。
    if (failureClass === 'stall') return finish('blocked', `step-stalled:${state.phase}`, { failureClass });
    return finish('blocked', `step-failed:${code}${detail ? `：${detail}` : ''}`, { failureClass });
  }
}
