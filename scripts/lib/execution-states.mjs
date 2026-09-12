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
 * `judgeExecutionCompletion()` 的 status 值域里，**「已结束」的那半边**。
 *
 * 为什么它也在正典里（2026-09-12 实咬）：那个函数把整张 `EXECUTION_FINISHED` 折叠成
 * 归一后的 `done`/`failed` 两个词，于是**调用方判「收尾验过了没」时不该再去卡 view 的原始状态词**。
 * 可它这么干了——`stopSession` 的核验循环与 `startSession` 的放行闸都写 `['done','failed']`，
 * 而这条链最常撞的终态恰恰是 `incomplete`（上游断流打死），它不在那两个词里：
 * 收尾验不过 → 会话与租约双双重写回 `stopping` → 同一条工作树永久起不了新会话，
 * 实测卡了 56 分钟，只能等对账兜底。
 *
 * 注意这不是又一张状态表：它是**那个函数的出参值域**（折叠后的），不是会话状态词。
 * 折叠规则只有一句：`EXECUTION_FINISHED` 里的词 → `failed`，正常干完 → `done`。
 * 若哪天出参多了第三个词，改这里一处，下游全跟着走。
 */
export const EXECUTION_VERDICT_FINISHED = new Set(['done', 'failed']);

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

/**
 * 「这份会话视图能不能**证明它已经死了**」——快照没回帧（`partial`）时的采信判据。
 *
 * 2026-09-12 实咬（审官树被永久占住）：`session-read` 对一条上游断流打死的会话回
 * `{phase:'incomplete', partial:true, via:'meta'}`——快照过期没回帧，读的是会话清单预览。
 * 清单给的 `incomplete` 是**终态**（见 EXECUTION_FINISHED 的注释），可当时只有
 * `listSessions` 那条路（execution-runtime:428-436）认这句话：
 *   · `judgeExecutionCompletion` 见到 `partial` 就先回 `unknown`；
 *   · `stopSession` 的核验循环又拿手打的 `['done','failed']` 去卡，`incomplete` 不在里面。
 * 两个合起来 → 收尾永远「验不过」→ 会话与租约双双重写回 `stopping`（cleanupVerified:false）
 * → 此后同一条工作树一律报「worktree has an unresolved launch or cleanup」，
 * **死人占着树，活人进不来**。实测卡了 56 分钟，只能等对账兜底。
 *
 * **只采信「已死」那半边，不采信「干完了」**——这是安全边界，不许放宽：
 * 快照没回帧时正文可能被截断，`partial` 里报 `done` 不构成「活交付了」的证据；
 * 但它报 `failed/incomplete/stopped/...`（正典终态里**非成功**的那些）时，
 * 「这棵树没有人在干活」是成立的——收尾需要的正是这句话。
 * 真·读不成（phase 为空、态非终）照旧回 null = 没查成，调用方分开处置。
 *
 * @returns {string|null} 已确证的终态词，或 null = 不足以判死
 */
export function confirmedSessionState(view) {
  if (!view || view.missing === true) return null;
  if (view.partial !== true) return null;
  const raw = sessionStateOf(view.snapshot || view);
  if (raw == null) return null;
  if (!EXECUTION_FINISHED.has(raw)) return null;
  return EXECUTION_SUCCEEDED.has(raw) ? null : raw;
}
