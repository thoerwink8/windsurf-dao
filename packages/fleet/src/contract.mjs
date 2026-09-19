const SHA = /^[a-f0-9]{40}$/;
const text = value => typeof value === 'string' && value.trim().length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const unknown = reason => ({ state: 'unscanned', reason });
// T32：债的分类轴（与 scripts/lib/debt-ledger.mjs 的 DEBT_TYPES 同口径）。
const DEBT_TYPES = ['security', 'data', 'contract', 'correctness', 'perf', 'maintainability', 'ui'];

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
  if (!text(input.contract.targetBranch || 'master')) throw new Error('invalid target branch');
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
    contract: { requiredChecks: [...checks], deploymentRequired: input.contract.deploymentRequired, targetBranch: (input.contract.targetBranch || 'master').trim() },
    limits: { reviewRounds: input.limits.reviewRounds, stepTimeoutSeconds: input.limits.stepTimeoutSeconds },
    roles,
  };
}

/** 审查判定。身份只认活动从执行目录**实际解析**出来的 family——契约里写的 family 是调用方的声明，
 *  不能当证据用（同厂自审会因此恒过）。identityVerified 缺一即 unscanned，不放行。 */
export function judgeReview(task, head, review) {
  if (!SHA.test(head || '') || !review || review.completed !== true || review.head !== head) return unknown('review-not-complete-on-head');
  if (review.identityVerified !== true) return unknown('reviewer-identity-unverified');
  const reviewerFamily = text(review.reviewerFamily) ? review.reviewerFamily.trim().toLowerCase() : null;
  const executorFamily = text(review.executorFamily) ? review.executorFamily.trim().toLowerCase() : null;
  if (!reviewerFamily || !executorFamily) return unknown('reviewer-identity-unverified');
  if (reviewerFamily === executorFamily) return unknown('reviewer-not-independent');
  if (reviewerFamily !== task.roles.reviewer.family) return unknown('reviewer-family-mismatch');
  if (!Array.isArray(review.findings)) return unknown('review-findings-missing');
  const seen = new Set();
  for (const finding of review.findings) {
    if (!finding || !text(finding.id) || seen.has(finding.id) || !['P1', 'P2', 'P3'].includes(finding.severity) || !text(finding.detail)) return unknown('review-findings-invalid');
    // T32：位置是**可选**的（知道就给，指纹更准）；**类型是 P2/P3 必给的**——
    // 债册子按 type×severity 算 SLA（代码算期限，模型只分类），没类型就只能兜底成最松的一类。
    if (finding.file != null && !text(finding.file)) return unknown('review-findings-invalid');
    if (finding.line != null && !Number.isInteger(finding.line)) return unknown('review-findings-invalid');
    if (finding.severity !== 'P1' && !DEBT_TYPES.includes(String(finding.type || '').toLowerCase())) return unknown('review-findings-invalid');
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
  if (evidence.baseRefName !== task.contract.targetBranch) return unknown('merge-target-mismatch');
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
  // 上游**容量满**（429 / at-capacity / 容量已满）不是「要人介入」，也不是普通瞬时故障：
  // 它是全队共享的资源条件，要**长退避等待**（分钟级），不该烧完 5 次小退避就 block
  // （2026-09-19 实咬：luna/terra/astra 同时满，g3 的审查因此停摆）。判据先于通用 code 检查。
  if (/capacity|容量已满|at capacity|rate.?limit|too many requests|429/i.test(String(error?.reason || ''))) return 'capacity';
  // 渠道满 / 维护窗：**排队**，不是失败（T27：一台 VPS 跑多任务时渠道是共享资源，满了该等）。
  if (/channel-full|maintenance/i.test(String(error?.reason || ''))) return 'queued';
  if (['RATE_LIMITED', 'TRANSPORT_CLOSED', 'SERVICE_UNAVAILABLE', 'DEADLINE_EXCEEDED'].includes(code)) return 'retryable';
  // 执行体自己抛的瞬时故障：回环 ws 连不上、租约/渠道背压、维护窗口。
  // 这些在实测里几分钟内自愈（回环 ws 12 小时红 11 次、每次下一轮自己好），
  // 判成 unscanned 会让每张单都要人点一次 resume——那不是谨慎，是把自动闭环变成半自动。
  if (code === 'MirasimUnavailableError' || code === 'busy') return 'retryable';
  // ACP 启动超时是瞬时故障（g17 实咬：执行会话已交出提交，下一步起会话超时被判 unscanned）。
  // 只认超时这一类；其它 AcpRuntimeError（会话已存在、恢复不支持、清理未核实）仍留 unscanned。
  if (code === 'AcpRuntimeError' && /timed?\s*out|timeout/i.test(String(error?.reason || ''))) return 'retryable';
  // 会话在等人回答：重试只会再问一次——这是要人/要策略介入的第三态，不是传输故障。
  if (code === 'WAITING_USER') return 'blocked';
  if (['lease-held', 'channel-full', 'maintenance', 'launch-uncertain'].includes(error?.reason)) return 'retryable';
  return 'unscanned';
}
