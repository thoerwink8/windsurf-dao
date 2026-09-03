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

// 指挥官派单策略缺省（#849）：单轮上限 2；派前校验模型在当前选型内。
export const COMMANDER_POLICY_DEFAULTS = {
  maxDispatchPerRound: 2,
  requireModelInRouting: true,
};

/** 归一 commander 节：maxDispatchPerRound 整数 1~20，越界/缺失用缺省。 */
export function resolveCommanderPolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const n = Number(src.maxDispatchPerRound);
  const max = Number.isInteger(n) && n >= 1 && n <= 20
    ? n
    : COMMANDER_POLICY_DEFAULTS.maxDispatchPerRound;
  return {
    maxDispatchPerRound: max,
    requireModelInRouting: typeof src.requireModelInRouting === 'boolean'
      ? src.requireModelInRouting
      : COMMANDER_POLICY_DEFAULTS.requireModelInRouting,
  };
}

/**
 * 派前模型闸（#849）：不在当前选型 → 不派；健康表 red → 不派。
 * enabledIds 不是数组＝选型没查成（fail-closed）。
 */
export function assessDispatchModel(model, { policy, enabledIds, redIds } = {}) {
  const pol = resolveCommanderPolicy(policy);
  const id = model == null ? '' : String(model);
  if (pol.requireModelInRouting) {
    if (!Array.isArray(enabledIds)) {
      return { ok: false, reason: 'model-routing-unscanned', why: `模型 ${id} 的选型没查成，不派` };
    }
    if (!enabledIds.includes(id)) {
      return {
        ok: false,
        reason: 'model-not-in-routing',
        why: `模型标签 model/${id} 不在当前选型（退役或未登记），不派`,
      };
    }
  }
  if (Array.isArray(redIds) && redIds.includes(id)) {
    return { ok: false, reason: 'model-health-red', why: `模型 ${id} 健康表红，不派` };
  }
  return { ok: true };
}

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

// 态势的五节。scan 每节标 scanned:true/false。
export const SITUATION_SECTIONS = ['github', 'orca', 'reviewPending', 'prReviews', 'stall'];

// 声明式依赖表：每个动作 kind 的「必要节」——任一未 scanned，该动作在入口总闸一律不产。
// notify-hub / land 是随附动作，产出处会用 _needs 显式继承主动作的依赖（下面 hub/withNeeds）。
// escalate 是 fail-visible 出口、noop 是空态势——本身不依赖任何节。
// 审官 #840 红①要求：不靠各分支散落 if 挡 unscanned，改在 decide 入口按此表统一 fail-closed。
export const ACTION_NEEDS = {
  dispatch: ['github', 'orca', 'prReviews'],
  'attach-reviewer': ['github', 'reviewPending'],
  merge: ['github', 'prReviews'],
  land: ['github', 'prReviews'],
  'wake-brain': ['github', 'prReviews', 'stall'],
  'notify-hub': [],
  escalate: [],
  noop: [],
};

// 决不能出现在自动路径里的动作（审官建议的「自动路径边界」）：清树 / 写指纹 / 改 dao.mjs 等
// 有破坏性或越界的动作，指挥官自动层永不产出——归帅或归别的在途单。
export const FORBIDDEN_AUTO_KINDS = new Set([
  'worktree-rm', 'worktree-remove', 'rm-tree', 'write-fingerprint', 'edit-dao', 'merge-force',
]);

function withNeeds(action, needs) { return { ...action, _needs: needs }; }

/**
 * 收集「候选动作」：各分支照常按数据产候选，正向动作带 _needs（依赖节），由入口总闸统一裁定产不产。
 * 分支内只做「数据在不在」的安全读取（可选链 + || []），不再用 section.scanned 挡正向产出——
 * fail-closed 由总闸按 ACTION_NEEDS 统一做（审官 #840 红①：散落 if 会漏，交叉组合能绕过）。
 */
function collectCandidates(situation) {
  const out = [];
  const gh = situation.github || {};
  const orca = situation.orca || {};
  const rp = situation.reviewPending || {};
  const reviews = situation.prReviews || {};
  const stall = situation.stall || {};
  const wakeCounts = situation.wakeCounts || {};
  const policy = resolveCommanderPolicy(situation.commanderPolicy);
  const enabledIds = situation.routingModels;
  const redIds = situation.healthRedModels;
  const N = ACTION_NEEDS;

  // ① 已消歧 + 无在途派工 → dispatch（缺标签 / 模型不在选型 / 健康表红 = 报帅不派）
  // #849：本轮最多派 maxDispatchPerRound 张，超出的排队下轮再派（不丢、不 escalate）。
  const ready = inspectReadyQueue({ issues: gh.issues || [], prs: gh.prs || [], worktrees: orca.worktrees || [] });
  if (ready.kind === 'ready') {
    let dispatchedThisRound = 0;
    for (const n of ready.ready) {
      const issue = (gh.issues || []).find((i) => i && i.number === n);
      const model = labelValue(issue, 'model/');
      const reviewer = labelValue(issue, 'reviewer/');
      const role = labelValue(issue, 'type/');
      if (!model || !reviewer) {
        // 缺标签是报帅信号（数据已 scanned 才分析得出），随 dispatch 同依赖，避免 github/orca 没查成时冒出。
        out.push(withNeeds(esc(`#${n} 已消歧但缺 ${!model ? 'model/' : ''}${!model && !reviewer ? '、' : ''}${!reviewer ? 'reviewer/' : ''} 标签，不猜——报帅补标签`, {
          reason: 'missing-labels', issue: n, title: issue?.title || '',
        }), N.dispatch));
        continue;
      }
      const gate = assessDispatchModel(model, { policy, enabledIds, redIds });
      if (!gate.ok) {
        out.push(withNeeds(esc(`#${n} ${gate.why}`, {
          reason: gate.reason, issue: n, model, title: issue?.title || '',
        }), N.dispatch));
        continue;
      }
      if (dispatchedThisRound >= policy.maxDispatchPerRound) {
        continue; // 超上限：排队下轮，不丢、不 escalate（#849 消歧）
      }
      dispatchedThisRound += 1;
      out.push(withNeeds({ kind: 'dispatch', issue: n, model, reviewer, role: role || null, title: issue?.title || '', why: `#${n} 已消歧、无在途派工、model|reviewer 标签齐` }, N.dispatch));
      out.push(withNeeds(hub(`已自动派单 #${n}：${issue?.title || ''}`, 'dispatched', { issue: n }), N.dispatch));
    }
  }

  // ② review-pending 入队 → attach-reviewer（#815）
  for (const it of rp.items || []) {
    if (!it || it.pr == null) continue;
    out.push(withNeeds({ kind: 'attach-reviewer', pr: it.pr, reviewer: it.reviewer || null, worker: it.worker || null, head: it.head || null, why: `PR #${it.pr} 工人已交卷、worker-done 起审官失败入队` }, N['attach-reviewer']));
  }

  // ③ PR 驱动：判绿合并 / manual 待拍板 / 审官轮次
  for (const pr of gh.prs || []) {
    if (!pr || pr.number == null) continue;

    if (prApprovedReady(pr)) { // 判绿 + 非 draft + MERGEABLE（manual 会被审官转 draft）
      const ci = prChecksRed(pr);
      if (ci.red) { // 判绿却 CI 红：矛盾态，不自动合，报帅
        out.push(withNeeds(esc(`PR #${pr.number} 审官判绿但 CI 红（${ci.reason}）——不自动合，报帅`, { reason: 'approved-but-ci-red', pr: pr.number }), N.merge));
        out.push(withNeeds(hub(`PR #${pr.number} 判绿但 CI 红，卡住了`, 'stuck', { pr: pr.number }), N.merge));
        continue;
      }
      const a = analyzeReviews(reviews.byPr?.[pr.number]?.bodies);
      if (!a.scanned) { // 该 PR 单独没抓到 reviews（section 可能 scanned 但这条 PR 的 fetch 缺）：不合，报没查成
        out.push(withNeeds(esc(`PR #${pr.number} 判绿待合并，但该 PR reviews 没查成`, { reason: 'unscanned', pr: pr.number, missing: ['prReviews'] }), N.merge));
        continue;
      }
      if (a.malformed) {
        out.push(withNeeds(esc(`PR #${pr.number} 判定行歪了（没查成 ≠ 判绿）——报帅`, { reason: 'malformed-judgment', pr: pr.number }), N.merge));
        continue;
      }
      out.push(withNeeds({ kind: 'merge', pr: pr.number, title: pr.title || '', why: '审官判绿 + m=auto + CI 绿 + MERGEABLE' }, N.merge));
      out.push(withNeeds({ kind: 'land', why: '合并后收工清理（land 幂等；清树归 #829，本单只调 land）' }, N.land));
      out.push(withNeeds(hub(`PR #${pr.number} 已自动合并`, 'merged', { pr: pr.number }), N.merge));
      continue;
    }

    if (prApprovedDraft(pr)) { // 判绿但 draft（manual 合门）→ 需拍板，报帅（不自动合）
      out.push(withNeeds(hub(`PR #${pr.number} 判绿待人工合并（manual 合门）`, 'decide', { pr: pr.number }), N.merge));
      continue;
    }

    const a = analyzeReviews(reviews.byPr?.[pr.number]?.bodies);
    if (!a.scanned) continue; // 该 PR 没抓到 reviews 数据：不臆测（总闸另按 prReviews 节 fail-closed）
    if (a.malformed) {
      out.push(withNeeds(esc(`PR #${pr.number} 判定行歪了（没查成 ≠ 判红/判绿）——报帅`, { reason: 'malformed-judgment', pr: pr.number }), N['wake-brain']));
    } else if (a.redRounds >= 2) { // 审官两轮仍红 = 换人信号，永不自动
      out.push(withNeeds(esc(`PR #${pr.number} 审官两轮仍红（${a.redRounds} 轮）——报帅换人，不自动`, { reason: 'two-red', pr: pr.number, redRounds: a.redRounds }), N['wake-brain']));
      out.push(withNeeds(hub(`PR #${pr.number} 审官两轮仍红，等你拍换人`, 'stuck', { pr: pr.number }), N['wake-brain']));
    } else if (a.redRounds === 1 && !a.latestGreen) { // 审官判红一轮 → 唤大脑；同单已唤满 → 转报帅
      const woken = wakeCounts[`pr:${pr.number}`] || 0;
      if (woken >= WAKE_LIMIT) {
        out.push(withNeeds(esc(`PR #${pr.number} 已唤大脑 ${woken} 次仍没闭环——报帅`, { reason: 'wake-exhausted', pr: pr.number, woken }), N['wake-brain']));
        out.push(withNeeds(hub(`PR #${pr.number} 唤大脑 ${woken} 次仍没闭环，等你`, 'stuck', { pr: pr.number }), N['wake-brain']));
      } else {
        out.push(withNeeds({ kind: 'wake-brain', target: `pr:${pr.number}`, pr: pr.number, why: `PR #${pr.number} 审官判红一轮，返工方向要判` }, N['wake-brain']));
      }
    }
  }

  // ④ 撞死指纹 + #833 自动换人没接住 → wake-brain
  for (const [term, info] of Object.entries(stall.strikes || {})) {
    if (!info || (info.strikes || 0) < 2) continue;
    const woken = wakeCounts[`stall:${term}`] || 0;
    if (woken >= WAKE_LIMIT) {
      out.push(withNeeds(esc(`终端 ${term} 撞死指纹已唤大脑 ${woken} 次仍没闭环——报帅`, { reason: 'wake-exhausted', term, woken }), N['wake-brain']));
    } else {
      out.push(withNeeds({ kind: 'wake-brain', target: `stall:${term}`, term, why: `终端 ${term} 撞死指纹 strikes=${info.strikes}，#833 自动换人未接住` }, N['wake-brain']));
    }
  }

  return out;
}

/**
 * 纯函数：态势 → 动作清单。**入口总闸 fail-closed**（审官 #840 红①）。
 * situation 各节形态（scan 负责填，任一节没查成把 scanned 置 false + error）：
 *   github:        { scanned, issues:[{number,title,labels:[{name}]}],
 *                    prs:[{number,title,isDraft,reviewDecision,mergeable,statusCheckRollup,body}], error }
 *   orca:          { scanned, worktrees:[...], error }
 *   reviewPending: { scanned, items:[{pr,head,reviewer,worker}], error }
 *   prReviews:     { scanned, byPr:{ <n>:{ bodies:[...] } }, error }
 *   stall:         { scanned, strikes:{ <term>:{strikes,sig} }, error }
 *   wakeCounts:    { <target>: n }
 *
 * 契约：任一节 unscanned → 依赖它的动作一律不产，汇成**一条** escalate(reason:'unscanned', missing:[...])；
 *       依赖节全 scanned 的动作照常。全部 unscanned → 只有那一条 escalate、零正向动作。
 */
export function decide(situation = {}) {
  const unscanned = SITUATION_SECTIONS.filter((s) => !situation[s]?.scanned);
  const candidates = collectCandidates(situation);
  const actions = [];
  for (const cand of candidates) {
    const needs = cand._needs || ACTION_NEEDS[cand.kind] || [];
    const missing = needs.filter((s) => !situation[s]?.scanned);
    const { _needs, ...clean } = cand;
    if (missing.length === 0) actions.push(clean);
    // 有 missing 的候选整条丢弃（含随附 notify-hub）——不逐条产 escalate，合并成下面一条
  }
  // 入口总闸：有节没查成 → 一条合并 escalate，列全缺的节。没查成 ≠ 空态势，必须 fail-visible。
  if (unscanned.length) {
    actions.push(esc(`没查成的节：${unscanned.join('、')}——依赖它们的动作一律不产（fail-closed 总闸）`, { reason: 'unscanned', missing: unscanned }));
  }
  // 硬保险：自动路径永不出现清树/写指纹/改 dao.mjs 类破坏性动作（审官「自动路径边界」）。
  for (const a of actions) {
    if (FORBIDDEN_AUTO_KINDS.has(a.kind)) {
      throw new Error(`decide 产出了禁用的自动动作 kind=${a.kind}——自动路径不许有破坏性/越界动作`);
    }
  }
  // 空态势：全查成、无待处理 → noop（静默，不回流）
  if (actions.length === 0) actions.push({ kind: 'noop', why: '盘面全查成、无待处理' });
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
