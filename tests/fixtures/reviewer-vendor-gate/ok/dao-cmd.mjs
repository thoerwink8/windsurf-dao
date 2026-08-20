export function resolveDispatchConstraints({ model, reviewer, routing } = {}) {
  const vendorGate = assertCrossVendor({ workerId: model, reviewerId: reviewer, models: routing.models });
  if (!vendorGate.ok) return vendorGate;
}
export function resolveSplitConstraint() {}
