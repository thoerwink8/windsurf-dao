export function nextReviewerAfter({ currentId, models = [], passerIds = [] } = {}) {
  return { ok: true, next: passerIds[0] };
}
export function parseReviewerCardName() {}
export function planCapacitySwitch({ displayName, models = [], passerIds = [] } = {}) {
  return { ok: true, action: 'switch', to: passerIds[0] };
}
