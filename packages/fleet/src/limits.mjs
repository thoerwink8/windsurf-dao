// packages/fleet/src/limits.mjs —— 时间预算的唯一算术出处。
//
// 为什么单独一个文件：活动的 `startToCloseTimeout` 必须盖住 runSession 的最坏路径，
// 而这条路径是三块相加：首轮 `waitForCompletion(stepTimeout)` + 宽限
// `unknownWaitRounds × waitForCompletion(unknownWaitMs)` + 收尾余量。
// 之前两侧各算一次、宽限里还叠了一层 `sleep(unknownWaitMs)`，结果预算少算一半
// （独立复核 P1 实咬：`waitForCompletion` 对未定态会**睡满** timeoutMs 才返回，
// 所以每轮宽限本来就是 unknownWaitMs，再 sleep 一次就变成 2×）。
// 现在默认值与公式都从这里出，两侧不可能再各算一套。

export const DEFAULT_UNKNOWN_WAIT_MS = 120000;
export const DEFAULT_UNKNOWN_WAIT_ROUNDS = 3;
export const STEP_CLOSE_MARGIN_SECONDS = 120;

/** 活动超时（秒）。宽限里不许再叠 sleep——公式已经把每轮算作一次 waitForCompletion。 */
export function activityBudgetSeconds({ stepTimeoutSeconds, unknownWaitMs = DEFAULT_UNKNOWN_WAIT_MS, unknownWaitRounds = DEFAULT_UNKNOWN_WAIT_ROUNDS }) {
  if (!Number.isFinite(stepTimeoutSeconds) || stepTimeoutSeconds <= 0) throw new Error('activity budget requires a positive step timeout');
  if (!Number.isFinite(unknownWaitMs) || unknownWaitMs < 0) throw new Error('activity budget requires a non-negative unknown wait');
  if (!Number.isSafeInteger(unknownWaitRounds) || unknownWaitRounds < 0) throw new Error('activity budget requires a non-negative round count');
  return stepTimeoutSeconds + Math.ceil((unknownWaitMs * unknownWaitRounds) / 1000) + STEP_CLOSE_MARGIN_SECONDS;
}
