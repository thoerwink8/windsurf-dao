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
export const EXECUTION_SUCCEEDED = new Set(['done', 'completed', 'complete', 'finished']);
export const EXECUTION_FINISHED = new Set([
  ...EXECUTION_SUCCEEDED,
  'failed', 'error', 'aborted', 'cancelled', 'canceled', 'stopped', 'rejected',
  'auth_required', 'unsupported_interaction',
  'incomplete', // 上游断流打死的常态：run 有终帧但没干完。**终态**，不是「还在启动」
  'gone',       // 名单里查不到、盘上也没了
]);

/** 预留态：启动/收尾只走了一半，答案还不知道——按「可能还在跑」处理，只由对账决定去留。 */
export const EXECUTION_RESERVED = new Set(['pending', 'uncertain', 'stopping']);

/**
 * 从一条**外部形状**的会话对象里读出状态词。**所有消费者都该走这里，别自己点字段名。**
 *
 * 2026-09-11 实咬（本晚第 4、7 处，同一个病）：
 * 外部形状同时带着几套历史同义词，而且**有一个是幻觉**：
 *
 *   真存在的：state、phase、observedState（实测 listSessions 回的键）
 *   不存在的：runState ← 仓里两处代码只读它，于是「这条会话什么态」恒为空
 *
 * 后果不是抽象的：`countLiveReviewers` 只读 runState → 29 条登记数出 28 个「在役审官」，
 * 上限 3 永久吃满、复审票一张拉不动；`metaView` 只读 runState → 兜底路上 phase 恒 null。
 *
 * **为什么用「取第一个非空字符串」而不是 `??`**：`state` 是服务端的权威定性
 * （`observedState` 是「上一次观测到的」、`phase` 是快照侧的说法）。但服务端**会**给出
 * `state: ''` 这种「我没这个信息」的写法，`??` 只认 null/undefined，空串会被它当成有效值
 * 而挡掉后面真正有内容的 `phase`。所以逐个试、跳过空串，取第一个有内容的。
 *
 * 读不到返回 null，由调用方按「没查成」处置——**不编一个默认状态**。
 */
export function sessionStateOf(session) {
  const s = session && typeof session === 'object' ? session : {};
  for (const k of ['state', 'phase', 'observedState', 'runState']) {
    const v = typeof s[k] === 'string' ? s[k].trim().toLowerCase() : '';
    if (v) return v;
  }
  return null;
}

/**
 * 那条会话的**规范状态**（已归类）。消费者按它判分支，不要再自己 `new Set([...])`。
 *
 * 归三类，且只有三类——多一类就会有人再手打一张表：
 *   'finished'  已结束（不管结束得好不好）
 *   'reserved'  启动/收尾走了一半，答案还不知道
 *   'live'      在跑（含 running/streaming 等一切非终非预留的字）
 *   null        读不出来 = 没查成，**不等于 live**（调用方必须分开处置）
 */
export function classifySessionState(session) {
  const st = sessionStateOf(session);
  if (st == null) return null;
  if (EXECUTION_FINISHED.has(st)) return 'finished';
  if (EXECUTION_RESERVED.has(st)) return 'reserved';
  return 'live';
}


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
