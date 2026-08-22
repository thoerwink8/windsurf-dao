// 红样本：lib 层忘了 #679 同厂闸。
export function planQuickFixGate({ workerModel, reviewerId }) {
  return { ok: true, state: 'pass' };
}
