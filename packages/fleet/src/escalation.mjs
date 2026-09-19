// packages/fleet/src/escalation.mjs —— T39 ④：任务卡住时**上报指挥官裁决**（机器可读，T28 形态）。
//
// 任务内自愈阶梯走完（重试 → 续跑 → 换腿）还解决不了，就不该继续空转：把「卡在哪、凭什么、
// 试过什么、还能选谁」写成一份**可回读**的载荷，交指挥官拍（或转飞书 ask-gate 问人）。
//
// 载荷形状：{ task, phase, blockedReason, evidence, attempts, candidates, options }
//   · evidence 只放**判据**（HEAD / 检查 / 审查计数），不放叙述——叙述会漂，判据不会；
//   · options 是**机器可读的裁决选项**：重试 / 换腿（指定哪条）/ 取消 / 按现状接受（带理由）。

export const ESCALATION_OPTIONS = Object.freeze(['retry', 'swap-leg', 'cancel', 'accept-as-is']);

export function buildEscalation({ task, state, reason, extra } = {}) {
  return {
    taskId: (task && task.id) || null,
    repository: (task && task.repository) || null,
    issue: task && task.issue != null ? task.issue : null,
    generation: task && task.generation != null ? task.generation : null,
    phase: (state && state.phase) || null,
    state: (state && state.state) || null,
    blockedReason: reason || (state && state.reason) || null,
    failureClass: (extra && extra.failureClass) || null,
    attempts: {
      round: (state && state.round) != null ? state.round : null,
      reviewRounds: (task && task.limits && task.limits.reviewRounds) != null ? task.limits.reviewRounds : null,
    },
    evidence: {
      acceptedHead: (state && state.acceptedHead) || null,
      head: (state && state.artifact && state.artifact.head) || null,
      checks: (state && state.checks && state.checks.checks) || null,
      advisoryCount: Array.isArray(state && state.advisory) ? state.advisory.length : null,
      legSwappedTo: (state && state.artifact && state.artifact.legSwappedTo) || null,
      riskTier: (state && state.riskTier) || null,
    },
    candidates: [], // 由 escalate 活动用腿表补齐（同 family 候补）
    options: [...ESCALATION_OPTIONS],
  };
}

/** 落点文件名：任务 id 里带 `/`，换成 `_` 再拼（别在文件名里造目录层级）。 */
export function escalationFileName(taskId) {
  return `${String(taskId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}
