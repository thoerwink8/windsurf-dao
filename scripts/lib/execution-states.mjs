// scripts/lib/execution-states.mjs —— 执行会话状态的正典（单一定义处）
//
// 为什么单独抽一个文件（2026-09-11 实咬，第 2 次）：
// 「哪些状态算死了」这件事在仓里曾有四份手打清单，而且**互相不一致**——
//   · execution-runtime 的 FINISHED（挡住新会话的判据）
//   · execution-runtime 的 RESERVED（中间态）
//   · lease-gc 的 terminal 数组 ×2（回收判据）
//   · acp-runtime 的 ACP_TERMINAL
// 后果不是抽象的：run 记录停在 `incomplete`（上游断流打死时的常态），
// FINISHED 里没有它 → 判成「未结算预留」挡住新派工；而租约那边的清单里**有**它
// → 判成「可回收」。同一个状态，一边永久占树、一边该扫不扫，#1150 就是被这样卡住的。
// 手打的常量早晚会被凭印象填（判例 memory `hand-typed-constant-will-be-wrong`），
// 所以这里只留一处定义，谁判都来读它。

/** 终态：会话已经结束了，不管结束得好不好。落在这里的状态不占树。 */
export const EXECUTION_FINISHED = new Set([
  'done', 'completed', 'complete',
  'failed', 'error', 'aborted', 'cancelled', 'canceled', 'stopped', 'rejected',
  'auth_required', 'unsupported_interaction',
  'incomplete', // 上游断流打死的常态：run 有终帧但没干完。**终态**，不是「还在启动」
  'gone',       // 名单里查不到、盘上也没了
]);

/** 预留态：启动/收尾只走了一半，答案还不知道——按「可能还在跑」处理，只由对账决定去留。 */
export const EXECUTION_RESERVED = new Set(['pending', 'uncertain', 'stopping']);

/**
 * 这条记录是否会在起会话时被判成「未结算的预留」而挡住同一棵工作树。
 *
 * 与 `startSession` 里那道闸同义（execution-runtime 的 orphan 判据）：
 * 非终态、或落在预留态里，就会挡人。抽出来是为了让**回收侧读同一句话**——
 * 判据一旦两边各写一份，就会出现「挡人的说它没死、回收的说它死了」。
 */
export function blocksWorktree(state) {
  const st = String(state || '');
  return !EXECUTION_FINISHED.has(st) || EXECUTION_RESERVED.has(st);
}
