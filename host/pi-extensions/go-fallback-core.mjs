// go-fallback-core.mjs —— go-fallback 的纯决策层（node 22 可测，不 import .ts——CI 是 node 22）。
// 运行时接线在 go-fallback.ts；本文件只做「看到当前默认值 → 决定恢复动作」的判断。
//
// restoreDefaults 的修复背景（审查发现两处错）：
//   1. 旧逻辑把「当前值 == 原值」当成「已恢复过」直接清掉 pendingRestore。
//      但 setModel 的 settings 写队列是异步落盘——恢复刀跑在落盘前时读到的就是原值，
//      pending 被误清，随后降级值落盘，补刀（agent_settled/session_shutdown）变 no-op，
//      settings.json 永远停在降级通道（#519 主通道被静默改掉）。
//   2. 旧逻辑对「当前值既非原值也非降级值」（用户在降级后手动改了默认）也无条件写回原值，
//      覆盖用户修改。
//
// 修复后的判定（pending 里同时记原值与降级写入值）：
//   - 当前值 == 降级值 → restore：降级写已落盘，写回原值，清 pending。
//   - 当前值 == 原值   → wait：要么已恢复、要么降级写还没落盘——区分不开，但两种情形
//     正确动作都是「不写文件、保留 pending 等下一刀」（幂等，无副作用）。
//   - 当前值是其它值   → respect-user：用户手动改过默认，尊重用户，清 pending 不再补刀。

/**
 * @param {{pending: ?{provider: string, model: string, fallbackProvider: string, fallbackModel: string},
 *          current: {provider: *, model: *}}} input
 * @returns {{action: 'noop'|'restore'|'wait'|'respect-user', from?: {provider: *, model: *}}}
 */
export function planRestore({ pending, current }) {
  if (!pending) return { action: "noop" };
  const from = { provider: current.provider, model: current.model };
  const atFallback = current.provider === pending.fallbackProvider && current.model === pending.fallbackModel;
  if (atFallback) return { action: "restore", from };
  const atOriginal = current.provider === pending.provider && current.model === pending.model;
  if (atOriginal) return { action: "wait" };
  return { action: "respect-user", from };
}
