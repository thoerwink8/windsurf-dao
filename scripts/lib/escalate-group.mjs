// scripts/lib/escalate-group.mjs —— 指挥官报帅的两条判据（纯函数，2026-09-06）
//
// 起因：2026-09-06 17:11—19:51，指挥官为**同一个**缺陷（读回口断了，见 #1056）开了 6 张
// 待拍板单——#1049 #1050 #1053 #1054 #1060 #1061，正文只有对象号不同，原因逐字相同。
// 用户点破的那句是判据本身：「GitHub issue 是处理问题的地方，这些噪声单明显不是问题」。
//
// 业界怎么分（PagerDuty 的 events → alerts → incidents）：
//   · event  原始信号，留档取证，不惊动人；
//   · alert  按 **dedup key** 聚合的「有件事不对」，只有 triggered/resolved 两态，
//            **不能被 acknowledge**——它压根没设计来承载工作流状态；
//   · ticket 有人要干的活，人手关。
// 把 alert 1:1 变成 ticket 是结构性错配。本仓的对应物：态势文件/status 三态 = event 层，
// GitHub issue = ticket 层，中间的 alert 层缺失，于是机器一发现异常就直接开 ticket。
//
// 本模块只做能就地做的那两件，不新造 alert 层（那是 #1029/#1052 那条总控群改造的地盘）：
//
//   ① **没查成不开单**（bug 修复，不是设计变更）。commander.escalate 上方的注释早写着
//      「unscanned-class 只进态势/status（静默，不刷屏）」，代码也照做了——但判据是
//      `reason === 'unscanned'` 的**字符串相等**，而实际原因名是 `dispatch-unscanned` /
//      `rework-unscanned`（commander.mjs 由 `r.unscanned` 派生）。相等判据接不住，全部漏过去
//      开了单。证据：升级账本 13 条里没有一条裸 `unscanned` 的键，而裸 `unscanned`（orca 那条）
//      每轮都老老实实打「没查成（静默进 status）」。规则是对的，判据写窄了三个字。
//
//   ② **去重键按原因，不按对象**（Alertmanager 的 group_by / PagerDuty 的 dedup_key）。
//      业界口径：dedup key 的粒度取「人要干的那件事」，不是「发射源」。人要干的只有一件
//      （修那个缺陷），却按对象裂成 N 张。同因的后续对象**追加进已开的那张单**，不新开——
//      一条告警带受影响对象清单，正是 group_by 的产物。
//
// 抑制不等于丢弃：被压下的信号照旧进态势文件和 status 三态（fail-close 一个字不动），
// 改的只是「怎么报给人」。

/**
 * 人要拍板的原因（ticket 层）。**它不在运行期做准入判据，只给穷举闸用。**
 *
 * 为什么不做成运行期白名单（想过，否掉了）：那样「不在表里」就得选一个失败方向——
 * 静默会把将来某个真问题永久吞掉，开单则等于没加闸。两边都不对。
 * 而本仓的命名约定已经把两类分开了：**机器故障类一律以 `-unscanned` 结尾**，其余是拍板题。
 * 所以运行期照旧按后缀判（上面那个函数），本表只负责在**测试期**逼人分类：
 * 新增一个既不带 `-unscanned`、又不在本表里的原因 ⇒ tests/escalate-group.test.js 当场红。
 *
 * 失败方向因此是安全的：新原因在被分类之前照旧开单（不会被悄悄吞掉），而它进不了主干。
 */
export const HUMAN_DECISION_REASONS = new Set([
  'missing-labels',          // 人补标
  'model-health-red',        // 换不换模型——花钱/换人
  'model-not-in-routing',    // 要不要把这个模型加进选型
  'wake-exhausted',          // 唤醒用尽，人来接
  'approved-but-ci-red',     // 判绿了但 CI 红，人来判
  'approved-without-review', // reviewDecision 与 reviews 对不上，人来判
  'reviews-missing',         // 该有判定却没有，人来判
  'rework-no-issue',         // PR 没署名 issue，人补
  'dispatch-failed',         // 派工**真失败**（区别于没查成），人来判
  'rework-failed',           // 返工派工真失败，人来判
  // 巡检会话改了它不该改的东西（越界审计抓到的提交）。这条**必须留在 ticket 层**：
  // 它是「已经发生的越界改动」，要人去看那个提交、决定留还是回滚——机器代不了。
  // 本条是穷举闸上线第一次跑就抓出来的漏网，原本谁都没想起它（scripts/commander.mjs:1196）。
  'patrol-out-of-bounds',
]);

/**
 * 「没查成」连续多少轮才值得开单（#1063）。
 *
 * 为什么不是「永久静默」：`unscanned` 的语义本来就是「下一轮再看」，偶发一次不该惊动人；
 * 但**一直没查成**是真问题，永久静默会把它悄悄吞掉——那正是 fail-close 最怕的降级。
 * 3 轮 ≈ 1 小时（指挥官 20 分钟一轮）。
 *
 * 判的是**轮数**不是墙钟：轮数是确定性的量，墙钟在有负载的机器上两次能差一倍
 * （判例 memory `wall-clock-cannot-be-a-gate`）。
 */
export const UNSCANNED_STREAK_TO_OPEN = 3;

/**
 * 「没查成」class：这一类不立刻开单。
 *
 * 判前缀不判相等——`dispatch-unscanned` / `rework-unscanned` 都是「没查成」的具体位置，
 * 语义与裸 `unscanned` 完全一致（都由 `r.unscanned` 派生）。**新增任何 `<动作>-unscanned`
 * 原因都自动被接住**，这正是相等判据当初漏掉它们的原因。
 */
export function isUnscannedReason(reason) {
  const r = String(reason || '');
  return r === 'unscanned' || r.endsWith('-unscanned');
}

/**
 * 去重键 = 原因。**对象不进键**——进键就是按发射源聚合，一个原因刷 N 张单。
 *
 * 旧键形如 `escalate/dispatch-unscanned/issue-1007`，新键是 `escalate/dispatch-unscanned`。
 * 旧账本条目匹配不上新键：不做迁移是有意的——旧键指向的单要么已关（本就该重开），
 * 要么是 unscanned class（现在根本不开单），没有需要抢救的在途状态。
 */
export function escalateDedupKey(action) {
  return `escalate/${String(action?.reason || 'x')}`;
}

/** 受影响对象的稳定标识（进正文清单，不进键）。认不出对象 → null，按「无对象」记。 */
export function escalateTarget(action) {
  if (!action) return null;
  if (action.pr != null) return `PR #${action.pr}`;
  if (action.issue != null) return `issue #${action.issue}`;
  if (action.term) return String(action.term);
  return null;
}

/**
 * 判这次报帅该怎么落地。纯函数——同一份输入必产同一个判决，测试直接喂。
 *
 * @param {object} action  decide 产出的 escalate 动作（含 reason / pr / issue / term / why）
 * @param {object|null} booked  账本里这个键已记的条目 `{ issue, objects }`；没记过传 null
 * @param {'OPEN'|'CLOSED'|null} bookedState  已记单的实时状态；**没查成必须传 null**
 * @returns {{verdict:'silent'|'open'|'append'|'noop'|'unscanned', why:string, target:string|null, objects?:string[]}}
 *
 * 四个出口的分界：
 *   silent    没查成 class —— 只进 status，永不开单
 *   open      这个原因还没有活着的单 —— 开一张
 *   append    有活单，且这次是个**没登记过的新对象** —— 追加一条评论，不新开
 *   noop      有活单，对象也登记过 —— 什么都不做（同一件事不重复说）
 *   unscanned 已记单的状态核不出来 —— 不开单（开单是写动作、不可撤，fail-closed 向「不开」）
 */
export function judgeEscalation(action, { booked = null, bookedState = null, streak = 0 } = {}) {
  const target = escalateTarget(action);
  if (isUnscannedReason(action?.reason)) {
    // 前 N-1 轮只进 status；连续到第 N 轮说明不是偶发，照常走下面的开单/追加判定。
    if (streak < UNSCANNED_STREAK_TO_OPEN) {
      return {
        verdict: 'silent',
        why: `「没查成」连续第 ${streak} 轮（满 ${UNSCANNED_STREAK_TO_OPEN} 轮才开单），本轮只进 status`,
        target,
        streak,
      };
    }
  }
  if (!booked || !booked.issue) {
    return { verdict: 'open', why: '这个原因还没有活着的单', target, objects: target ? [target] : [] };
  }
  if (bookedState == null) {
    return { verdict: 'unscanned', why: `账本记着 #${booked.issue}，核不出状态——开单不可撤，本轮不开`, target };
  }
  if (bookedState !== 'OPEN') {
    // 单被人关了 = 这件事被处置过了。再发生就是新一轮，可以重开。
    return { verdict: 'open', why: `#${booked.issue} 已关，这件事又发生了`, target, objects: target ? [target] : [] };
  }
  const seen = Array.isArray(booked.objects) ? booked.objects : [];
  if (target && !seen.includes(target)) {
    return {
      verdict: 'append',
      why: `#${booked.issue} 在管同一个原因，本次是新对象 ${target}——追加进那张单，不新开`,
      target,
      objects: [...seen, target],
    };
  }
  return { verdict: 'noop', why: `#${booked.issue} 在管同一个原因，对象也已登记`, target, objects: seen };
}

/** 从去重键还原原因名（键形如 `escalate/<reason>`）。认不出返回 null。 */
export function reasonOfKey(key) {
  const m = /^escalate\/(.+)$/.exec(String(key || ''));
  return m ? m[1] : null;
}

/**
 * 一轮结束时的收敛（#1063）：数连续轮、把消失的原因收掉。纯函数。
 *
 * @param {string[]} reasonsThisRound 本轮 decide 产出的全部 escalate 原因
 * @param {object} streak    上一轮的连续计数 `{ <reason>: 轮数 }`
 * @param {object} ledger    升级账本 `{ 'escalate/<reason>': { issue, objects } }`
 * @param {boolean} allScanned 本轮态势是否全部查成
 * @returns {{streak:object, toClose:Array<{reason,issue,key}>, skipped:string|null}}
 *
 * **没全查成就不收敛**（fail-closed，这条是要害）：入口总闸会因为某一面没查成而不产依赖它的
 * 动作，于是原因会「凭空消失」。拿这种消失去关单，等于把 GitHub 上的单按扫描故障关掉。
 * 所以只在全查成的轮次里收敛；没查成的轮次连计数都不动（否则连续轮数会被扫描故障洗掉）。
 */
export function reconcileEscalationRound({
  reasonsThisRound = [], streak = {}, ledger = {}, allScanned = false,
} = {}) {
  const seen = new Set((reasonsThisRound || []).filter(Boolean).map(String));
  if (!allScanned) {
    return { streak, toClose: [], skipped: '本轮有面没查成——不收敛也不清计数（消失可能是扫描故障，不是问题解决了）' };
  }
  const next = {};
  for (const r of seen) next[r] = (Number(streak?.[r]) || 0) + 1;
  const toClose = [];
  for (const key of Object.keys(ledger || {})) {
    const reason = reasonOfKey(key);
    if (!reason || seen.has(reason)) continue;
    const entry = ledger[key];
    if (entry && entry.issue) toClose.push({ reason, issue: entry.issue, key });
  }
  return { streak: next, toClose, skipped: null };
}

/** 自动关单的留言。必须写清是被哪条原因收敛掉的——关单要可追溯（#1063 硬边界）。 */
export function closeCommentBody({ reason, objects, at }) {
  return [
    `指挥官：这条原因本轮已不再出现，自动收敛关单。`,
    ``,
    `- 原因：${reason}`,
    `- 关单前受影响：${(objects || []).join('、') || '（没记到对象）'}`,
    `- 判据：态势**全部查成**的一轮里，decide 没有再产出这条原因。`,
    `  （没查成的轮次不收敛——那种「消失」可能是扫描故障，不是问题解决了）`,
    ``,
    `又发生的话会重新开一张，不会静默。`,
    at ? `\n时间：${at}` : '',
  ].filter(Boolean).join('\n');
}

/** 追加评论的正文。只说新增了谁、现在一共影响谁——不复述原因（原因在单里）。 */
export function appendCommentBody({ target, objects, why, at }) {
  return [
    `指挥官：同一原因又命中一个对象。`,
    ``,
    `- 新增：${target}`,
    `- 现在受影响：${(objects || []).join('、') || '（没记到对象）'}`,
    `- 本次判定：${why || ''}`,
    ``,
    `（按原因聚合，不为每个对象另开单——判据见 scripts/lib/escalate-group.mjs）`,
    at ? `\n时间：${at}` : '',
  ].filter(Boolean).join('\n');
}
