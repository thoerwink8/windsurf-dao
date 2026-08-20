export function nextReviewerAfter({ currentId, models = [], passerIds = [], workerId } = {}) {
  if (workerId) return { ok: true, next: 'claude-opus' };
}
export function parseReviewerCardName() {}
export function planCapacitySwitch({ displayName, models = [], passerIds = [], workerId } = {}) {
  if (!workerId) return { ok: false, action: 'escalate' };
}
