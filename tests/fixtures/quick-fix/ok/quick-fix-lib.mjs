// 绿样本：lib 层真调同厂闸。
import { assertCrossVendor } from './reviewer-vendor-gate.mjs';

export function planQuickFixGate({ workerModel, reviewerId, models }) {
  return assertCrossVendor({ workerId: workerModel, reviewerId, models });
}
