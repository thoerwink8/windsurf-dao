// scripts/lib/commander-core.mjs —— 服务器指挥官「决策」层纯函数（#800）
//
// 眼睛（scan）产出「态势 situation」，本层 decide(situation) → 动作清单 actions[]，
// 手（act）逐条执行。判断全在这层，测试拿夹具钉判别力，不起真 orca / 真 GitHub。
//
// #800 三节判据逐条落这里：
//   自己做（确定性，调 dao.mjs 现有动词）：dispatch / attach-reviewer / merge(+land)
//   唤大脑（要判断，起一次性 pi）：审官判红一轮 / 撞死指纹 #833 没接住
//   报帅停手（永不自动）：审官两轮仍红 / 判定行歪了 / 缺 model|reviewer 标签 / 同单三次唤醒仍没闭环
//
// 铁律（CLAUDE.md「自动检查」+ #800）：**situation 里任何一节 unscanned，对应正向动作一律不产，
//   改产 escalate(reason:'unscanned')**。没查成 ≠ 空态势——空态势静默（noop），没查成要 fail-visible。
//   这条有专门红样本测试（tests/commander.test.js「没查成 ≠ 空」）。
//
// 复用已测原语（不重造）：
//   shuai-scan.mjs   prApprovedReady / prApprovedDraft / prChecksRed —— PR 判绿/待拍板/CI 红
//   ready-queue-check.mjs  inspectReadyQueue —— 已消歧 + 无在途 PR + 无卡 = 可立即起
//   judgment.mjs     judgmentFromReview —— 审官判定行解析（红 N 项 / 绿 / 歪了）

import { prApprovedReady, prApprovedDraft, prChecksRed } from './shuai-scan.mjs';
import { inspectReadyQueue } from './ready-queue-check.mjs';
import { judgmentFromReview } from './judgment.mjs';

export const ACTION_KINDS = [
  'dispatch', 'attach-reviewer', 'merge', 'land',
  'notify-hub', 'wake-brain', 'escalate', 'noop',
];

// 报帅停手的默认门槛：同一单唤醒大脑到这个次数仍没闭环 → 转报帅（#800「同单三次唤醒仍没闭环」）。
export const WAKE_LIMIT = 3;

/** issue 标签取值：`model/grok-4.6` → 传 prefix 'model/' 得 'grok-4.6'。取第一个命中，没有返回 null。 */
export function labelValue(issue, prefix) {
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  for (const l of labels) {
    const name = l && typeof l.name === 'string' ? l.name : '';
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return null;
}

/**
 * 一张 PR 的审官 review 历史 → 判别态。bodies 按时间序（旧→新）。
 * 复用 judgmentFromReview（单一判定行解析器）。
 * 返回：
 *   { scanned:false }                 —— bodies 不是数组（没查成）
 *   { malformed:true, ... }           —— 有判定行但格式歪了（近义变体/缺红数）→ 报帅，绝不当判绿
 *   { redRounds:N, green:bool, latestGreen:bool }
 * redRounds = 判红的 review 轮数（kind 判定/复核结论且 red≥1）；green = 出现过判绿。
 */
export function analyzeReviews(bodies) {
  if (!Array.isArray(bodies)) return { scanned: false };
  let redRounds = 0;
  let green = false;
  let malformed = false;
  let latestJudged = null; // 最后一条「有判定」的 review 的判别（绿/红）
  for (const body of bodies) {
    const j = judgmentFromReview(body);
    if (j.malformed) { malformed = true; continue; }
    if (j.kind == null) continue; // 该 review 没有判定行（叙述/闲聊），跳过
    if (j.green) { green = true; latestJudged = 'green'; continue; }
    if (typeof j.red === 'number' && j.red >= 1) { redRounds += 1; latestJudged = 'red'; }
  }
  return {
    scanned: true,
    malformed,
    redRounds,
    green,
    latestGreen: latestJudged === 'green',
    latestRed: latestJudged === 'red',
  };
}

function esc(why, extra = {}) {
  return { kind: 'escalate', why, ...extra };
}
function hub(subject, moment, extra = {}) {
  // moment ∈ {dispatched, decide, merged, stuck, heartbeat}：四个回流时刻 + 心跳
  return { kind: 'notify-hub', subject, moment, ...extra };
}

/**
 * 纯函数：态势 → 动作清单。
 * situation 各节形态（scan 负责填，任一节没查成把 scanned 置 false + error）：
 *   github:        { scanned, issues:[{number,title,labels:[{name}]}],
 *                    prs:[{number,title,isDraft,reviewDecision,mergeable,statusCheckRollup,body}], error }
 *   orca:          { scanned, worktrees:[...], error }   // 卡去重用
 *   reviewPending: { scanned, items:[{pr,head,reviewer,worker}], error }  // _flow/queue/review-pending
 *   prReviews:     { scanned, byPr:{ <n>:{ bodies:[...] } }, error }      // 每 PR 审官 review 正文
 *   stall:         { scanned, strikes:{ <term>:{strikes,sig} }, error }   // #833 消费，读不到=unscanned
 *   wakeCounts:    { <target>: n }                                        // 来自 state，供「三次唤醒」判据
 */
export function decide(situation = {}) {
  const actions = [];
  const gh = situation.github;
  const orca = situation.orca;
  const rp = situation.reviewPending;
  const stall = situation.stall;
  const wakeCounts = situation.wakeCounts || {};

  // ── 门：没查成的节，对应正向动作一律不产，改产 escalate(unscanned) ──
  if (!gh?.scanned) actions.push(esc(`GitHub 没查成：${gh?.error || '缺 github 节'}`, { reason: 'unscanned', section: 'github' }));
  if (!orca?.scanned) actions.push(esc(`Orca 盘面没查成：${orca?.error || '缺 orca 节'}`, { reason: 'unscanned', section: 'orca' }));
  if (!rp?.scanned) actions.push(esc(`review-pending 队列没查成：${rp?.error || '缺 reviewPending 节'}`, { reason: 'unscanned', section: 'reviewPending' }));
  if (!stall?.scanned) actions.push(esc(`撞死指纹没查成：${stall?.error || '缺 stall 节'}`, { reason: 'unscanned', section: 'stall' }));

  // ── 自己做 ①：已消歧 + 无在途派工 → dispatch（缺 model|reviewer 标签 = 报帅不猜）──
  // 需要 github + orca 都查成（inspectReadyQueue 要 issues/prs/worktrees）。
  if (gh?.scanned && orca?.scanned) {
    const ready = inspectReadyQueue({ issues: gh.issues, prs: gh.prs, worktrees: orca.worktrees });
    if (ready.kind === 'unscanned') {
      actions.push(esc(`可立即起没查成：${ready.line}`, { reason: 'unscanned', section: 'ready' }));
    } else if (ready.kind === 'ready') {
      for (const n of ready.ready) {
        const issue = (gh.issues || []).find((i) => i && i.number === n);
        const model = labelValue(issue, 'model/');
        const reviewer = labelValue(issue, 'reviewer/');
        const role = labelValue(issue, 'type/');
        if (!model || !reviewer) {
          actions.push(esc(`#${n} 已消歧但缺 ${!model ? 'model/' : ''}${!model && !reviewer ? '、' : ''}${!reviewer ? 'reviewer/' : ''} 标签，不猜——报帅补标签`, {
            reason: 'missing-labels', issue: n, title: issue?.title || '',
          }));
        } else {
          actions.push({
            kind: 'dispatch', issue: n, model, reviewer, role: role || null, title: issue?.title || '',
            why: `#${n} 已消歧、无在途派工、model|reviewer 标签齐`,
          });
          actions.push(hub(`已自动派单 #${n}：${issue?.title || ''}`, 'dispatched', { issue: n }));
        }
      }
    }
  }

  // ── 自己做 ②：worker-done 起审官失败入队 → attach-reviewer（消费 review-pending 队列，#815）──
  if (rp?.scanned) {
    for (const it of rp.items || []) {
      if (!it || it.pr == null) continue;
      actions.push({
        kind: 'attach-reviewer', pr: it.pr, reviewer: it.reviewer || null, worker: it.worker || null,
        head: it.head || null,
        why: `PR #${it.pr} 工人已交卷、worker-done 起审官失败入队`,
      });
    }
  }

  // ── PR 驱动：判绿合并 / manual 待拍板 / 审官轮次（红一轮唤大脑、两轮报帅）──
  if (gh?.scanned) {
    const reviews = situation.prReviews;
    for (const pr of gh.prs || []) {
      if (!pr || pr.number == null) continue;

      // 判绿 + 非 draft + MERGEABLE（= m=auto，manual 会被审官转 draft）→ 校 CI 与判定行 → 合并
      if (prApprovedReady(pr)) {
        const ci = prChecksRed(pr);
        if (ci.red) {
          // 判绿却 CI 红：矛盾态，不自动合，报帅（卡壳回流）
          actions.push(esc(`PR #${pr.number} 审官判绿但 CI 红（${ci.reason}）——不自动合，报帅`, { reason: 'approved-but-ci-red', pr: pr.number }));
          actions.push(hub(`PR #${pr.number} 判绿但 CI 红，卡住了`, 'stuck', { pr: pr.number }));
          continue;
        }
        // 判定行必须真查过且是绿（reviewDecision=APPROVED 已足，但按仓规核判定行，防「没查成当判绿」）
        if (!reviews?.scanned) {
          actions.push(esc(`PR #${pr.number} 审官判绿待合并，但 reviews 没查成`, { reason: 'unscanned', section: 'prReviews', pr: pr.number }));
          continue;
        }
        const a = analyzeReviews(reviews.byPr?.[pr.number]?.bodies);
        if (!a.scanned) {
          actions.push(esc(`PR #${pr.number} 判绿待合并，但该 PR reviews 没查成`, { reason: 'unscanned', section: 'prReviews', pr: pr.number }));
          continue;
        }
        if (a.malformed) {
          actions.push(esc(`PR #${pr.number} 判定行歪了（没查成 ≠ 判绿）——报帅`, { reason: 'malformed-judgment', pr: pr.number }));
          continue;
        }
        actions.push({ kind: 'merge', pr: pr.number, title: pr.title || '', why: `审官判绿 + m=auto + CI 绿 + MERGEABLE` });
        actions.push({ kind: 'land', why: `合并后收工清理（land 幂等；清树归 #829，本单只调 land）` });
        actions.push(hub(`PR #${pr.number} 已自动合并`, 'merged', { pr: pr.number }));
        continue;
      }

      // 判绿但 draft（manual 合门被审官转 draft）→ 需拍板，报帅（不自动合）
      if (prApprovedDraft(pr)) {
        actions.push(hub(`PR #${pr.number} 判绿待人工合并（manual 合门）`, 'decide', { pr: pr.number }));
        continue;
      }

      // 审官轮次（要 reviews 查成才判红轮）
      if (reviews?.scanned) {
        const a = analyzeReviews(reviews.byPr?.[pr.number]?.bodies);
        if (!a.scanned) continue; // 该 PR 没抓到 reviews：不臆测，静默（scan 已在别处标 unscanned 时会 escalate）
        if (a.malformed) {
          actions.push(esc(`PR #${pr.number} 判定行歪了（没查成 ≠ 判红/判绿）——报帅`, { reason: 'malformed-judgment', pr: pr.number }));
        } else if (a.redRounds >= 2) {
          // 报帅停手：审官两轮仍红 = 换人信号，永不自动
          actions.push(esc(`PR #${pr.number} 审官两轮仍红（${a.redRounds} 轮）——报帅换人，不自动`, { reason: 'two-red', pr: pr.number, redRounds: a.redRounds }));
          actions.push(hub(`PR #${pr.number} 审官两轮仍红，等你拍换人`, 'stuck', { pr: pr.number }));
        } else if (a.redRounds === 1 && !a.latestGreen) {
          // 唤大脑：审官判红一轮，返工方向要判——但同单已唤 WAKE_LIMIT 次仍没闭环 → 转报帅
          const woken = wakeCounts[`pr:${pr.number}`] || 0;
          if (woken >= WAKE_LIMIT) {
            actions.push(esc(`PR #${pr.number} 已唤大脑 ${woken} 次仍没闭环——报帅`, { reason: 'wake-exhausted', pr: pr.number, woken }));
            actions.push(hub(`PR #${pr.number} 唤大脑 ${woken} 次仍没闭环，等你`, 'stuck', { pr: pr.number }));
          } else {
            actions.push({ kind: 'wake-brain', target: `pr:${pr.number}`, pr: pr.number, why: `PR #${pr.number} 审官判红一轮，返工方向要判` });
          }
        }
      }
    }
  }

  // ── 唤大脑 ②：撞死指纹 + #833 自动换人没接住 → wake-brain（stall 查成才判）──
  if (stall?.scanned) {
    for (const [term, info] of Object.entries(stall.strikes || {})) {
      if (!info) continue;
      if ((info.strikes || 0) >= 2) {
        const woken = wakeCounts[`stall:${term}`] || 0;
        if (woken >= WAKE_LIMIT) {
          actions.push(esc(`终端 ${term} 撞死指纹已唤大脑 ${woken} 次仍没闭环——报帅`, { reason: 'wake-exhausted', term, woken }));
        } else {
          actions.push({ kind: 'wake-brain', target: `stall:${term}`, term, why: `终端 ${term} 撞死指纹 strikes=${info.strikes}，#833 自动换人未接住` });
        }
      }
    }
  }

  // ── 空态势：查成了但没有任何要做的 → noop（静默，不回流）──
  if (actions.length === 0) actions.push({ kind: 'noop', why: '盘面查成、无待处理' });
  return { actions };
}

/**
 * 心跳判据（假时钟可测）：一切正常连续 silenceDays 天静默 → 发一条心跳，与探针同款
 * （沉默要能与死机区分）。lastActivityAt / lastHeartbeatAt 是 ISO 串或 null。
 */
export function heartbeatDue({ state = {}, now = Date.now(), silenceDays = 7 } = {}) {
  const ms = silenceDays * 24 * 3600 * 1000;
  const lastAct = Date.parse(state.lastActivityAt || '') || 0;   // 上次有非 noop 动作
  const lastHb = Date.parse(state.lastHeartbeatAt || '') || 0;   // 上次发心跳
  const anchor = Math.max(lastAct, lastHb); // 从「上次有动静」起算，动作和心跳都算动静
  if (anchor === 0) return { due: false, reason: '无锚点（首轮不发心跳）' };
  if (now - anchor < ms) return { due: false, reason: `静默不足 ${silenceDays} 天` };
  return { due: true, reason: `已静默 ≥ ${silenceDays} 天`, sinceMs: now - anchor };
}

/** 动作清单里是否有「有动静」的动作（非 noop、非纯 unscanned-escalate）——决定要不要刷新 lastActivityAt。 */
export function hasLiveAction(actions = []) {
  return actions.some((a) => a && a.kind !== 'noop' && !(a.kind === 'escalate' && a.reason === 'unscanned'));
}

/** 稳定去重键：把一批动作归一成排序后的字符串，act 拿它跟 state 里上一轮比，决定回流不回流。 */
export function actionsDigest(actions = []) {
  const keys = actions
    .filter((a) => a && a.kind !== 'noop')
    .map((a) => {
      const t = a.issue != null ? `i${a.issue}` : a.pr != null ? `p${a.pr}` : a.term ? `t${a.term}` : a.target || '';
      return `${a.kind}:${a.reason || a.moment || ''}:${t}`;
    })
    .sort();
  return keys.join('|');
}
