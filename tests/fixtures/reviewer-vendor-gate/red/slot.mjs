export function nextReviewerAfter({ currentId, models = [], passerIds = [] } = {}) {
  return { ok: true, next: passerIds[0] };
}
export function parseReviewerCardName() {}
export function judgeCapacityFailover({ requested, capacityFailover } = {}) {
  return { ok: true, to: (capacityFailover || {}).deadModelId };
}
