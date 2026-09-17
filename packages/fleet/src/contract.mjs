const SHA = /^[a-f0-9]{40}$/;
const text = value => typeof value === 'string' && value.trim().length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const unknown = reason => ({ state: 'unscanned', reason });

export function taskIdOf({ repository, issue, generation = 1 } = {}) {
  if (!text(repository) || !positive(issue) || !positive(generation)) throw new Error('invalid task identity');
  return `dao/${repository.toLowerCase()}/issue/${issue}/g${generation}`;
}

export function normalizeTask(input) {
  if (!input || typeof input !== 'object') throw new Error('invalid task');
  if (!text(input.repository) || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(input.repository)) throw new Error('invalid repository');
  if (!positive(input.issue)) throw new Error('invalid issue');
  if (!positive(input.generation)) throw new Error('invalid issue generation');
  const repository = input.repository.toLowerCase();
  const id = taskIdOf({ repository, issue: input.issue, generation: input.generation });
  if (input.id !== undefined && input.id !== id) throw new Error('task identity mismatch');
  const checks = input.contract?.requiredChecks;
  if (!Array.isArray(checks) || !checks.length || checks.some(name => !text(name)) || new Set(checks).size !== checks.length) throw new Error('required checks must be explicit and unique');
  if (typeof input.contract.deploymentRequired !== 'boolean') throw new Error('deployment requirement missing');
  if (!positive(input.limits?.reviewRounds)) throw new Error('invalid review budget');
  if (!positive(input.limits?.stepTimeoutSeconds)) throw new Error('invalid step timeout');
  const roles = {};
  for (const name of ['lead', 'executor', 'reviewer']) {
    const role = input.roles?.[name];
    if (!text(role?.profile) || !text(role?.family) || !text(role?.accountPool)) throw new Error(`missing ${name} profile, family or account pool`);
    roles[name] = { profile: role.profile.trim(), family: role.family.trim().toLowerCase(), accountPool: role.accountPool.trim() };
  }
  if (roles.executor.family === roles.reviewer.family) throw new Error('reviewer must be independent of executor family');
  return {
    id, repository, issue: input.issue, generation: input.generation,
    contract: { requiredChecks: [...checks], deploymentRequired: input.contract.deploymentRequired },
    limits: { reviewRounds: input.limits.reviewRounds, stepTimeoutSeconds: input.limits.stepTimeoutSeconds },
    roles,
  };
}

export function judgeReview(task, head, review) {
  if (!SHA.test(head || '') || !review || review.completed !== true || review.head !== head) return unknown('review-not-complete-on-head');
  if (review.profile !== task.roles.reviewer.profile || review.family !== task.roles.reviewer.family) return unknown('reviewer-identity-mismatch');
  if (review.family === task.roles.executor.family) return unknown('reviewer-not-independent');
  if (!Array.isArray(review.findings)) return unknown('review-findings-missing');
  const seen = new Set();
  for (const finding of review.findings) {
    if (!finding || !text(finding.id) || seen.has(finding.id) || !['P1', 'P2', 'P3'].includes(finding.severity) || !text(finding.detail)) return unknown('review-findings-invalid');
    seen.add(finding.id);
  }
  const blocking = review.findings.filter(finding => finding.severity === 'P1');
  const advisory = review.findings.filter(finding => finding.severity !== 'P1');
  return { state: blocking.length ? 'blocked' : 'passed', blocking, advisory };
}

export function judgeChecks(task, head, evidence) {
  if (!SHA.test(head || '') || evidence?.scanned !== true || evidence.head !== head || !Array.isArray(evidence.checks)) return unknown('checks-not-scanned-on-head');
  const required = [];
  for (const name of task.contract.requiredChecks) {
    const matches = evidence.checks.filter(check => check?.name === name);
    if (matches.length !== 1) return unknown(`check-missing-or-ambiguous:${name}`);
    required.push(matches[0]);
  }
  if (required.some(check => check.status !== 'COMPLETED')) return { state: 'pending', reason: 'checks-running' };
  if (required.some(check => ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(check.conclusion))) return { state: 'blocked', reason: 'checks-failed' };
  if (required.some(check => check.conclusion !== 'SUCCESS')) return unknown('checks-without-success');
  return { state: 'passed' };
}

export function judgeDelivery(task, head, evidence) {
  if (!SHA.test(head || '') || !evidence || evidence.repository !== task.repository || evidence.issue !== task.issue || !positive(evidence.pr)) return unknown('delivery-identity-mismatch');
  if (evidence.merged !== true) return { state: 'pending', reason: 'pr-not-merged' };
  if (evidence.sourceHead !== head || !SHA.test(evidence.mergeCommit || '')) return unknown('merge-evidence-mismatch');
  if (task.contract.deploymentRequired) {
    const deployed = evidence.deployment;
    if (deployed?.checked !== true || deployed.commit !== evidence.mergeCommit) return unknown('deployment-not-verified-at-merge');
    if (deployed.healthy !== true) return { state: 'blocked', reason: 'deployment-unhealthy' };
  }
  return { state: 'passed' };
}

export function classifyStepFailure(error) {
  const code = error?.code;
  if (code === 'CANCELLED') return 'cancelled';
  if (['AUTH_REQUIRED', 'PERMISSION_DENIED', 'INVALID_CONTRACT', 'INVALID_MODEL', 'UNSUPPORTED_CAPABILITY'].includes(code)) return 'blocked';
  if (['RATE_LIMITED', 'TRANSPORT_CLOSED', 'SERVICE_UNAVAILABLE', 'DEADLINE_EXCEEDED'].includes(code)) return 'retryable';
  return 'unscanned';
}
