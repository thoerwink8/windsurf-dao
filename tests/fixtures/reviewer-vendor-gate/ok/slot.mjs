export function nextReviewerAfter({ currentId, models = [], passerIds = [], workerId } = {}) {
  if (workerId) return { ok: true, next: 'claude-opus' };
}
export function parseReviewerCardName() {}
export function judgeCapacityFailover({ requested, capacityFailover } = {}) {
  const { deadError, workerId } = capacityFailover || {};
  if (!deadError) return { ok: false, unscanned: true };
  return nextReviewerAfter({ workerId });
}
export function planReviewerOnCapacityDeath({ requested, capacityFailover } = {}) {
  return judgeCapacityFailover({ requested, capacityFailover });
}
