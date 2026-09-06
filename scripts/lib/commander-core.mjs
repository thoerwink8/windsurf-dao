// scripts/lib/commander-core.mjs —— 服务器指挥官「决策」层纯函数（#800）
//
// 眼睛（scan）产出「态势 situation」，本层 decide(situation) → 动作清单 actions[]，
// 手（act）逐条执行。判断全在这层，测试拿夹具钉判别力，不起真 orca / 真 GitHub。
//
// #800 三节判据逐条落这里：
//   自己做（确定性，调 dao.mjs 现有动词）：dispatch / rework / attach-reviewer / merge(+land)
//   唤大脑（要判断，起一次性 pi）：撞死指纹 #833 没接住 / 双向门到期代拍
//   报帅停手（永不自动）：缺 model|reviewer 标签 / 撞死指纹三次唤醒仍没闭环
//
// #931（用户 2026-09-05 拍板，grill-ai 从零重推）：**判红这条路上的「唤大脑」整层删掉**。
//   旧路 判红 → 唤大脑翻译返工方向 → 送达工人终端 → 唤满报帅：工人早已下班，方案没有接收者。
//   新路 判红 → 直接派一个返工工人（kind:'rework'），任务书带审官红项**全文**（不摘要）。
//   审官标准本来就要求红项写「文件:行号 + 现象 + 期望改法」，工人照着改即可，不需要中间那层翻译。
//   撞死指纹 / 代拍两条路的 wake-brain **没动**——它们要判断的不是「怎么改代码」，#931 没拍过它们。
//
// 铁律（CLAUDE.md「自动检查」+ #800）：**situation 里任何一节 unscanned，对应正向动作一律不产，
//   改产 escalate(reason:'unscanned')**。没查成 ≠ 空态势——空态势静默（noop），没查成要 fail-visible。
//   这条有专门红样本测试（tests/commander.test.js「没查成 ≠ 空」）。
//
// 复用已测原语（不重造）：
//   shuai-scan.mjs   prApprovedReady / prApprovedDraft / prChecksRed —— PR 判绿/待拍板/CI 红
//   ready-queue-check.mjs  inspectReadyQueue —— 已消歧 + 无在途 PR + 无卡 = 可立即起
//   review-state.mjs analyzeGithubReviews —— GitHub APPROVED / CHANGES_REQUESTED

import { prApprovedReady, prApprovedDraft, prChecksRed } from './shuai-scan.mjs';
import { inspectReadyQueue } from './ready-queue-check.mjs';
import { analyzeGithubReviews, normalizeReviewState } from './review-state.mjs';
import { hasPendingLabel } from './pending-disambiguation.mjs';
import { attributedIssueNumber } from './close-issue.mjs';
import {
  proposeAddLabel, validateRetryDrain, escalateToOpenIssue,
} from './commander-verbs.mjs';
import { buildMarkExhausted, prHasStuckLabel } from './exhausted.mjs';
import {
  REVIEW_PENDING_SOURCE_WORKER_DONE_FAIL,
  REVIEW_PENDING_SOURCE_COMMANDER_REREVIEW,
  reviewPendingSourceOf,
} from './dispatch/review-pending.mjs';
import { resolveMergeable } from './dispatch/git.mjs';
import {
  hasLiveExecutor, sessionListForLiveness, planReconcile,
} from './session-reconcile.mjs';

export const ACTION_KINDS = [
  'dispatch', 'rework', 'rereview', 'attach-reviewer', 'merge', 'land',
  'notify-hub', 'wake-brain', 'escalate', 'noop',
  'add-label', 'retry-drain', 'open-issue', 'reap-ticket', 'mark-exhausted',
];

// 报帅停手的默认门槛：同一撞死终端唤醒大脑到这个次数仍没闭环 → 转报帅（#800）。
// #931 后 PR 判红不再走唤醒预算（改直接派返工工人），这个门槛只管撞死指纹 / 代拍两条路。
export const WAKE_LIMIT = 3;

/** 复审票里的 head：写票一侧给的是 {name, oid}，别处可能是字符串。取不出返回 null（不猜）。
 *  drain 账本的键要用它，decide 与 execute 两侧必须走同一个门面，否则算出来的键对不上。 */
export function ticketHeadOid(head) {
  if (typeof head === 'string') return head.trim() || null;
  const oid = head && typeof head === 'object' ? head.oid : null;
  return typeof oid === 'string' && oid.trim() ? oid.trim() : null;
}

/** #1014：attach-reviewer 的 why 按票上记下的来源写，不许写死、不许猜。
 *  来源缺失/不认识 → 「来源没查成」；真失败要把 error 原文带上。 */
export function attachReviewerWhy(ticket) {
  const pr = ticket && ticket.pr != null ? ticket.pr : '?';
  const source = reviewPendingSourceOf(ticket);
  if (source === REVIEW_PENDING_SOURCE_WORKER_DONE_FAIL) {
    const err = ticket && ticket.error != null && String(ticket.error).trim()
      ? String(ticket.error).trim()
      : '（票上没带 error）';
    return `PR #${pr} 工人起审官失败：${err}`;
  }
  if (source === REVIEW_PENDING_SOURCE_COMMANDER_REREVIEW) {
    return `PR #${pr} 交卷可合但没人审，按设计叫审官`;
  }
  return `PR #${pr} 复审票来源没查成`;
}

/** 返工去重键：同一 PR 同一 head 只派一次（#931 边界）。act 侧按它记 state.reworkDispatched。 */
export function reworkKey(pr, head) { return `rework:${pr}@${head}`; }

// 框架活的角色标（type/体系）。这类单不进自动派单队列，走快马：主会话子代理闭环（#876，用户 2026-09-04 拍板）。
// 为什么不派：框架活要改的是派单机制本身，让派单机制去派它，等于让手术刀切自己。
export const FRAMEWORK_ROLE = '体系';

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
 * 一张 PR 的审官 review 历史 → 判别态。入参按时间序（旧→新）。
 * 认 GitHub state（APPROVED / CHANGES_REQUESTED）；兼容旧夹具里的判定行字符串。
 * 返回：
 *   { scanned:false }                 —— 入参不是数组（没查成）
 *   { redRounds:N, green:bool, latestGreen:bool }
 */
export function analyzeReviews(reviews) {
  if (!Array.isArray(reviews)) return { scanned: false };
  const mapped = reviews.map((item) => {
    if (item && typeof item === 'object' && (item.state || item.body != null)) return item;
    const s = String(item || '');
    if (/^\s*(?:[>*]\s*)*(判定|复核结论)[:：].*绿/.test(s) && !/红\s*\d+\s*项/.test(s)) return { state: 'APPROVED' };
    if (/^\s*(?:[>*]\s*)*(判定|复核结论)[:：].*红\s*\d+\s*项/.test(s)) return { state: 'CHANGES_REQUESTED' };
    return { state: 'COMMENTED' };
  });
  return analyzeGithubReviews(mapped);
}

/**
 * 只数「打在当前 PR head 上」的红/绿。
 *
 * 判绿只对它当时看的那个 commit 有效（memory review-green-must-match-head）——反过来同样成立：
 * 判红也只对当时那个 commit 有效。工人返工推了新 head，旧 review 挂在旧 commit 上，
 * 不能再当「仍红」。#911–#918 一夜八张重复报帅单就是拿历史累计红轮数判出来的。
 *
 * 三种「没查成」，一律 fail-visible，**绝不**当成「head 变了所以清零」，也不当成「仍红」：
 *   reviews-missing     —— 这张 PR 的 reviews 没抓到（既有契约：静默跳过，不臆测）
 *   head-unscanned      —— PR headRefOid 没查成，无从判断红打在哪个 commit 上
 *   commit-id-unscanned —— 有判别态 review 缺 commit_id，无从判断它属于哪个 commit
 *
 * 查成时返回 analyzeGithubReviews 的形态（redRounds/green/latestGreen/latestRed），
 * 外加 head（当前 head）、judgedTotal（历史判别态总数）、atHead（其中打在当前 head 上的条数）、
 * judged（打在当前 head 上的那几条 review 原件——返工任务书要拿红项**全文**，#931）。
 */
export function analyzeReviewsAtHead(reviews, head) {
  if (!Array.isArray(reviews)) return { scanned: false, reason: 'reviews-missing' };
  const h = typeof head === 'string' ? head.trim() : '';
  if (!h) return { scanned: false, reason: 'head-unscanned' };
  const judged = [];
  for (const rv of reviews) {
    const state = normalizeReviewState(rv);
    if (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED') continue; // COMMENTED 等不参与判别，缺 commit_id 也无所谓
    const cid = rv && typeof rv === 'object' ? String(rv.commit_id || rv.commitId || '').trim() : '';
    if (!cid) return { scanned: false, reason: 'commit-id-unscanned' };
    judged.push({ rv, cid });
  }
  const atHead = judged.filter((x) => x.cid === h);
  return {
    ...analyzeGithubReviews(atHead.map((x) => x.rv)),
    head: h,
    judgedTotal: judged.length,
    atHead: atHead.length,
    judged: atHead.map((x) => x.rv),
  };
}

/**
 * 当前 head 上**最后一条**判红 review 的正文全文（#931：任务书带红项全文，不摘要）。
 * 空正文 / 拿不到 = 没查成（返回 null）——审官判了红却没留正文，返工工人无从下手，
 * 这时不许派工（「没查成」不许触发派工）。
 */
export function latestRedBody(judgedAtHead) {
  const list = Array.isArray(judgedAtHead) ? judgedAtHead : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (normalizeReviewState(list[i]) !== 'CHANGES_REQUESTED') continue;
    const body = list[i] && typeof list[i] === 'object' ? String(list[i].body || '') : '';
    return body.trim() ? body : null;
  }
  return null;
}

/**
 * 从 prReviews.byPr[n] 取给 analyzeReviews 的入参：优先 `.reviews`（[{state, body}]，认 GitHub state），
 * 缺时才回退 `.bodies`（旧夹具的判定行字符串）。#807 后 reviewer-book 不再写「判定：」行，
 * 只喂 bodies 会把真 approve 判成 approved-without-review、两轮 request-changes 判成 noop。
 */
function prReviewInput(entry) {
  if (!entry || typeof entry !== 'object') return undefined;
  if (Array.isArray(entry.reviews)) return entry.reviews;
  return entry.bodies;
}

function esc(why, extra = {}) {
  return { kind: 'escalate', why, ...extra };
}
function hub(subject, moment, extra = {}) {
  // moment ∈ {dispatched, decide, merged, stuck, heartbeat}：四个回流时刻 + 心跳
  return { kind: 'notify-hub', subject, moment, ...extra };
}

// 态势的必查节。scan 每节标 scanned:true/false。
// #1055：orca 运行时 2026-09-06 退役，这一节再也不可能被扫出来。留在必查清单里
// fail-closed 总闸就永远合上（每天最后一行都是「没查成的节：orca」）——搬走真相源、
// 检查器判据还钉在旧位置。观察面若还扫，不进本清单、不当闸。
export const SITUATION_SECTIONS = ['github', 'reviewPending', 'prReviews', 'stall'];

// 复审重试：上一票的宽限期与上限。
// 宽限期要大于「审官从起来到落判定」的常见耗时，否则审官正在看的时候就被重发一张票；
// commander-act 20 分钟一轮，45 分钟约等于「连着两轮都没等到判定才重发」。
// 上限是为了别死循环——试满仍无判定就停手交人（判据：当前 head 判定仍是 0）。
export const REREVIEW_GRACE_MIN = 45;
export const MAX_REREVIEW_TRIES = 3;
// 返工派工失败后的重试节奏。与 drain / 复审同一套语义（45 分钟宽限、试满 3 次停手交人），
// 故意不另造一套数字：三条路犯的是同一个「派了 ≠ 成了」，节奏不同只会让人以为它们是三件事。
export const REWORK_RETRY_GRACE_MIN = 45;
export const MAX_REWORK_TRIES = 3;

/**
 * PR 该派哪个审官：查它署名 issue 上的 reviewer/ 标签。
 *
 * 两处快照都要看，因为它们装的是不同的东西：
 *  · `github.issues` 只有 **open** 单（GraphQL `states: OPEN`）；
 *  · `github.attributedIssues` 是「open PR 署名到、但不在上面那张表里」的单，多半是**已关闭**的。
 *
 * 2026-09-05 实咬：#945/#947/#909 的署名单 #833/#815/#889 早已关闭，标签明明带着 reviewer/，
 * 可只查 open 快照就是查不到 → 每轮报「不猜审官」→ 三张交卷可合的 PR 无限期挂着。
 * 单子关了不等于 PR 不用审。
 *
 * 已关闭的单**只用来查标签**，绝不并进 `github.issues`——那张表是派工候选表，
 * 混进已关闭的「已消歧」单会被当成新活派出去。
 */
export function attributedIssueOf(gh = {}, pr) {
  const n = attributedIssueNumber(pr);
  if (n == null) return null;
  return (gh.issues || []).find((i) => i && i.number === n)
    || (gh.attributedIssues || []).find((i) => i && i.number === n)
    || null;
}

export function reviewerLabelFor(gh = {}, pr) {
  return labelValue(attributedIssueOf(gh, pr), 'reviewer/');
}

// 声明式依赖表：每个动作 kind 的「必要节」——任一未 scanned，该动作在入口总闸一律不产。
// notify-hub / land 是随附动作，产出处会用 _needs 显式继承主动作的依赖（下面 hub/withNeeds）。
// escalate 是 fail-visible 出口、noop 是空态势——本身不依赖任何节。
// 审官 #840 红①要求：不靠各分支散落 if 挡 unscanned，改在 decide 入口按此表统一 fail-closed。
export const ACTION_NEEDS = {
  // 2026-09-06 摘掉 orca 依赖：派工/返工的建树起工人已切 mirasim（dao.mjs 的
  // MIRASIM_IS_ONLY_PATH），orca 节查不查得到都不影响这两个动作能不能干成。
  // 摘之前实测过后果：orca-serve 一停，这里的 fail-closed 让 commander 一个动作都不产，
  // 整条自动化停摆——依赖表没跟上执行体切换，就成了退役的最后一道锁。
  // #1055：orca 也不再进 SITUATION_SECTIONS——只摘 ACTION_NEEDS 不够，总闸按节清单
  // 合上，退役后每天仍刷「没查成的节：orca」。
  dispatch: ['github', 'prReviews'],
  rework: ['github', 'prReviews'],
  'attach-reviewer': ['github', 'reviewPending'],
  rereview: ['github', 'prReviews'],
  merge: ['github', 'prReviews'],
  land: ['github', 'prReviews'],
  'wake-brain': ['github', 'prReviews', 'stall'],
  'notify-hub': [],
  escalate: [],
  noop: [],
  'add-label': ['github'],
  'retry-drain': ['reviewPending'],
  'open-issue': [],
  // 回收死票要同时知道「队列里有什么」和「哪些 PR 还开着」——少一节都会把活票当死票剪掉。
  'reap-ticket': ['github', 'reviewPending'],
  // 认输打标写的是 PR。github 没查成不知道有没有标，不许盲打。
  'mark-exhausted': ['github'],
};

// 决不能出现在自动路径里的动作（审官建议的「自动路径边界」）：清树 / 写指纹 / 改 dao.mjs 等
// 有破坏性或越界的动作，指挥官自动层永不产出——归帅或归别的在途单。
export const FORBIDDEN_AUTO_KINDS = new Set([
  'worktree-rm', 'worktree-remove', 'rm-tree', 'write-fingerprint', 'edit-dao', 'merge-force',
]);

function withNeeds(action, needs) { return { ...action, _needs: needs }; }

/** 半标能推出唯一跨厂值 → add-label；推不出保持 null，调用方报帅（查不到 ≠ 猜一个）。 */
function maybeAddLabel(issue, situation, extra, needs) {
  if (!issue || issue.number == null) return null;
  const proposed = proposeAddLabel({
    existingLabels: issue.labels,
    models: situation.routingModelRecords,
    reviewerOrder: situation.reviewerOrder,
    workerOrder: situation.workerOrder,
  });
  if (!proposed.ok) return null;
  return withNeeds({
    kind: 'add-label',
    issue: issue.number,
    labels: proposed.labels,
    existingLabels: issue.labels,
    workerId: proposed.workerId,
    reviewerId: proposed.reviewerId,
    models: situation.routingModelRecords,
    why: extra.why,
    ...extra,
  }, needs);
}

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
  const reworkDispatched = situation.reworkDispatched || {};
  // 时钟从态势里取（不用 Date.now）：decide 是纯函数，同一份态势必须产同一批动作。
  const nowMs = Date.parse(situation.at || '') || 0;
  let reworkThisRound = 0;
  const policy = resolveCommanderPolicy(situation.commanderPolicy);
  const enabledIds = situation.routingModels;
  const redIds = situation.healthRedModels;
  const N = ACTION_NEEDS;

  // ① 已消歧 + 无在途派工 → dispatch（缺标签 / 模型不在选型 / 健康表红 = 报帅不派）
  // #849：本轮最多派 maxDispatchPerRound 张，超出的排队下轮再派（不丢、不 escalate）。
  // #1055：orca 已退役，scanned=false 不能把整个 ready 队列停掉。卡面排除仍走 worktrees||[]；
  // 「有没有活执行者」只问下面 hasLiveExecutor（#1056 唯一活性口），不再拿 orca 卡面猜。
  const ready = inspectReadyQueue({
    issues: gh.issues || [],
    prs: gh.prs || [],
    worktrees: orca.worktrees || [],
  });
  if (ready.kind === 'ready') {
    let dispatchedThisRound = 0;
    for (const n of ready.ready) {
      const issue = (gh.issues || []).find((i) => i && i.number === n);
      const model = labelValue(issue, 'model/');
      const reviewer = labelValue(issue, 'reviewer/');
      const role = labelValue(issue, 'type/');
      // #876 ②：带「待消歧」标的单一律不派，哪怕故意同时挂着「已消歧」。静默跳过——
      // 该说的话由盘点在「时机到了」那天说一次（commander-inventory 的待消歧一项），这里天天喊没意义。
      if (hasPendingLabel(issue?.labels)) continue;
      // #876 ①：框架活（type/体系）不进自动派单队列，改回流一条「走快马」。
      // 放在缺标签判据之前：框架单本就不该被要求补 model|reviewer，报帅催标签纯属噪音。
      if (role === FRAMEWORK_ROLE) {
        out.push(withNeeds(hub(`#${n}${issue?.title ? '「' + issue.title + '」' : ''}是框架活，走快马：主会话子代理闭环，不进派单队列`, 'decide', { issue: n }), N.dispatch));
        continue;
      }
      // 缺标签三档（#1003）。硬边界：不许改回「缺任一就报」。
      //
      // ① 为什么不是「缺任一就报」（2026-09-05 实咬）：进这个分支的门槛只有一条「已消歧」，
      //    而帅位开**任何**记账单/体系单都按惯例打「已消歧」⇒ 每开一张新单，指挥官下一轮就为它
      //    生一张「[待拍板] missing-labels」。#953 开单 06:49、#954 生成 06:56，隔 6 分钟；
      //    当天关掉 4 张（#900/#946/#951/#954），转头又生 4 张（#957/#958/#959/#961）。
      //    源单一直开着，报单就一直生——这不是漏标提醒，是自我繁殖。
      //
      // ② 为什么上面那条 type/体系 豁免接不住裸「已消歧」——**鸡生蛋**：
      //    type/* 的唯一自动写入方是 stampIssueLabels（scripts/lib/dispatch/card.mjs），
      //    由 scripts/dao.mjs 在**派工成功之后**才调。也就是说，豁免的开关只有「被派过工」
      //    才会自动打开，而这条豁免存在的目的**正是阻止派工**。新开的框架单永远等不到那一下。
      //    别拿「手工打过 type/体系 的单确实安静」当反证（#904/#903/#902/#895/#888 都安静）：
      //    那不是判据对，是有人替它手工打开了开关；没人手工打的单一律炸单。
      //    所以无 type/ + 两个都没有，必须继续静默。
      //
      // ③ 但注释 ② 同时点出了分得开的信号（#1003 实咬 #1000/#1001）：
      //    新开的单上如果出现 type/写码（或其他非 type/体系 的 type 标），一定是人手打的——
      //    stampIssueLabels 派工成功之后才写 type/*，记账单/体系单不会长出 type/写码。
      //    那就是明确瞄准了派工车道：两个都缺也要报帅，不能再跟记账单混成一档静默跳过。
      //
      // 三档：半标（有一个缺一个）→ 报（或 #971 能推出唯一跨厂值就自己补）；
      //       两个都没有 + 人手打过非体系 type/ → 报；
      //       两个都没有 + 无 type/ → 静默（记账单）。
      //
      // 「没查成」不会落进这里：labels 不是数组的 issue 在 inspectReadyQueue 就被挡掉了
      // （labelNames 返回 null → 不进 ready，整节报 kind:'unscanned'），所以走到这一步的 null
      // 一律是「查过、确实没这个标」，与「没查成」在出口上分得开。
      if ((model || reviewer) && (!model || !reviewer)) {
        // #971：半标且选型能推出唯一跨厂值 → 自己补，不再喊给空气。推不出仍报帅（查不到 ≠ 猜一个）。
        const filled = maybeAddLabel(issue, situation, {
          why: `#${n} 半标，补唯一跨厂标签（不猜）`,
        }, N['add-label']);
        if (filled) { out.push(filled); continue; }
        out.push(withNeeds(esc(`#${n} 已消歧，但派工标只打了一半：有 ${model ? 'model/' : 'reviewer/'}、缺 ${!model ? 'model/' : 'reviewer/'}，不猜——报帅补标签`, {
          reason: 'missing-labels', issue: n, title: issue?.title || '',
        }), N.dispatch));
        continue;
      }
      if (!model && !reviewer) {
        // 框架活已在上面 continue。走到这里的 role 只可能是人手打的非体系 type/，或根本没有。
        if (role) {
          out.push(withNeeds(esc(`#${n} 已消歧且带 type/${role}，但 model/ 和 reviewer/ 都没有——人手瞄准了派工车道却没打派工标，不猜——报帅补标签`, {
            reason: 'missing-labels', issue: n, title: issue?.title || '',
          }), N.dispatch));
        }
        continue; // 无 type/：记账单，静默（理由见上 ①②）
      }
      const gate = assessDispatchModel(model, { policy, enabledIds, redIds });
      if (!gate.ok) {
        out.push(withNeeds(esc(`#${n} ${gate.why}`, {
          reason: gate.reason, issue: n, model, title: issue?.title || '',
        }), N.dispatch));
        continue;
      }
      // #1056：活性只问这一处。同一 issue 已有活执行者（或名单没查成）→ 不派。
      // 观测面未接入（老夹具）live.live=false，既有派工路不受影响。
      const live = hasLiveExecutor({
        sessions: sessionListForLiveness(situation),
        issue: n,
      });
      if (live.live) continue;
      if (dispatchedThisRound >= policy.maxDispatchPerRound) {
        continue; // 超上限：排队下轮，不丢、不 escalate（#849 消歧）
      }
      dispatchedThisRound += 1;
      out.push(withNeeds({ kind: 'dispatch', issue: n, model, reviewer, role: role || null, title: issue?.title || '', why: `#${n} 已消歧、无在途派工、model|reviewer 标签齐` }, N.dispatch));
      out.push(withNeeds(hub(`已自动派单 #${n}：${issue?.title || ''}`, 'dispatched', { issue: n }), N.dispatch));
    }
  }

  // ② review-pending 入队 → 首次 attach-reviewer；票还在且有上次尝试账 → retry-drain（#971）
  // 走到重试分支本身就是「上次没成」的证据（派了 ≠ 成了）。宽限期内不重发；试满 escalate。
  // 队列自己不认领存活，票就永远不死：PR 合了/关了，票还在，drain 永远消不掉，
  // tries 打满后每一轮都开一张 [待拍板] 单。实咬 2026-09-06：#970/#972/#983 合并后
  // 仍被开单，17 张噪音单全从这里来。存活判据只在 github 真扫到时才成立——
  // 没扫到时 openPrs 是空集，把全部活票判成死票正是最坏的剪法。
  // 主查询是 pullRequests(first:100, states:OPEN)——含 draft，所以 draft 票不会被误剪。
  // 但取满 100 条就说明窗口可能被截断，掉出窗口的活 PR 会长得和「已关」一模一样，
  // 那时「不在列表里」不再是死票的证据，一张都不剪。
  const PR_WINDOW = 100;
  const prList = gh.prs || [];
  const ghScanned = gh.scanned === true && prList.length < PR_WINDOW;
  const openPrs = new Set(prList.map((p) => Number(p?.number)).filter(Number.isFinite));
  const exhaustedThisRound = new Set(); // 本轮刚认输的 PR：标还没打上，PR 循环也要跳过

  for (const it of rp.items || []) {
    if (!it || it.pr == null) continue;
    if (ghScanned && !openPrs.has(Number(it.pr))) {
      out.push(withNeeds({
        kind: 'reap-ticket', pr: it.pr,
        why: `PR #${it.pr} 已不在开放列表（合并/已关）——复审票是死票，回收，不再叫审官`,
      }, N['reap-ticket']));
      continue;
    }
    const livePr = (gh.prs || []).find((p) => p && Number(p.number) === Number(it.pr));
    if (livePr && prHasStuckLabel(livePr)) continue; // #1000：已认输 / 等用户，省额度不重试 drain
    // 票里的 head 有两种形态：字符串，或 {name, oid}（写票的一侧给的是后者）。
    // 取不出就传 null——退回旧键，不是猜一个。
    const itHead = ticketHeadOid(it.head);
    const drain = validateRetryDrain({
      pr: it.pr,
      head: itHead,
      queue: rp.items,
      ledger: situation.drainLedger || {},
      nowMs,
    });
    if (drain.ok) {
      out.push(withNeeds({
        kind: 'retry-drain', pr: it.pr, head: itHead, tries: drain.tries, stateKey: drain.stateKey,
        queue: rp.items,
        why: `PR #${it.pr} 上次 drain 没成（票还在队列），重试第 ${drain.tries} 次`,
      }, N['retry-drain']));
      continue;
    }
    if (drain.code === 'grace') continue;
    if (drain.code === 'exhausted') {
      // #1000：认输是 PR 属性，不再 escalate 开单（开单去重会把出口捂死）。
      if (livePr && prHasStuckLabel(livePr)) continue;
      const tries = Number(drain.tries) || 0;
      out.push(withNeeds(buildMarkExhausted({
        pr: it.pr, verb: 'drain', tries, head: itHead,
        why: drain.error,
      }), N['mark-exhausted']));
      exhaustedThisRound.add(Number(it.pr));
      continue;
    }
    out.push(withNeeds({
      kind: 'attach-reviewer', pr: it.pr, reviewer: it.reviewer || null, worker: it.worker || null,
      head: it.head || null, source: it.source || null, error: it.error || null,
      why: attachReviewerWhy(it),
    }, N['attach-reviewer']));
  }

  // 返工工人的构造：判红和解冲突两条路共用。取 model/reviewer 一律从**署名 issue 的标签**来
  // （与原派工同源，不猜、不换厂），任何一步取不到就报帅不派。
  // 抽成闭包是因为「冲突」这条路必须在 analyzeReviewsAtHead 之前判——冲突 PR 常常一条 review 都没有，
  // 而 reviews-missing 在下面是静默 continue，写在后面会被那一条吃掉。
  function pushRework(pr, { brief, head, redRounds, why, hubText, conflict = false }) {
    const rkey = reworkKey(pr.number, head);
    // 「派了 ≠ 成了」这条早就为 drain 定过（tries + 宽限 + 试满 escalate），却没接到返工这条路上：
    // 原判据只看「这条账在不在」，不看它成没成。于是一次**失败**的派工（ok:false，压根没造出工人）
    // 也会把这个 PR 在这个 head 上永久挡住。2026-09-06 实咬：PR #909 的返工 21:11 因署名单缺
    // 「已消歧」被拒派，标签当天就补上了，可它再也没被重派过——head 没变，账在，永远静默。
    // 账本里 ok 字段一直都在记，只是没人读。
    const prev = reworkDispatched[rkey];
    if (prev) {
      if (prev.ok === true) return;        // 真派出去了：工人正在改，等它推新 head
      if (prev.unscanned === true) return; // 没查成：不知道有没有工人，fail-closed 不重派（重派会造重复工人）
      // 明确失败：上次没有工人被造出来，可以重试。但要宽限期 + 上限，
      // 否则失败原因没解决时会每轮刷一次（#849 刷单教训）。
      const tries = Number(prev.tries) || 1;
      const ageMin = (nowMs - (Date.parse(prev.at || '') || 0)) / 60000;
      if (Number.isFinite(ageMin) && ageMin < REWORK_RETRY_GRACE_MIN) return;
      if (tries >= MAX_REWORK_TRIES) {
        if (prHasStuckLabel(pr)) return;
        out.push(withNeeds(buildMarkExhausted({
          pr: pr.number, verb: 'rework', tries, head,
          why: `PR #${pr.number} 返工派了 ${tries} 次都没派成（当前 head ${String(head).slice(0, 8)}）——停手交人`,
        }), N['mark-exhausted']));
        exhaustedThisRound.add(Number(pr.number));
        return;
      }
    }
    const issueNo = attributedIssueNumber(pr);
    if (issueNo == null) {
      out.push(withNeeds(esc(`PR #${pr.number} 要返工，但正文/标题里没有署名 issue——model/reviewer 无从取，报帅`, { reason: 'rework-no-issue', pr: pr.number }), N.rework));
      return;
    }
    // 走 attributedIssueOf 门面：它带了「开放单查不到就查 attributedIssues」的兜底，
    // 而 attributedIssues 正是为「单关了但 PR 还要审/要返工」补的（点名的就是 #945/#833 这一对）。
    const rIssue = attributedIssueOf(gh, pr);
    if (!rIssue) {
      out.push(withNeeds(esc(
        `PR #${pr.number} 的署名 issue #${issueNo} 这轮没扫到（已关且不在署名补取里）——标签没查成，不派`,
        { reason: 'unscanned', pr: pr.number, issue: issueNo, missing: ['github'], detail: 'rework-issue-unscanned' },
      ), N.rework));
      return;
    }
    const rModel = labelValue(rIssue, 'model/');
    const rReviewer = labelValue(rIssue, 'reviewer/');
    if (!rModel || !rReviewer) {
      const filled = maybeAddLabel(rIssue, situation, {
        pr: pr.number,
        why: `PR #${pr.number} 要返工，署名 issue #${issueNo} 半标——补唯一跨厂标签`,
      }, N['add-label']);
      if (filled) { out.push(filled); return; }
      out.push(withNeeds(esc(`PR #${pr.number} 要返工，但署名 issue #${issueNo} 缺 ${!rModel ? 'model/' : ''}${!rModel && !rReviewer ? '、' : ''}${!rReviewer ? 'reviewer/' : ''} 标签，不猜——报帅补标签`, {
        reason: 'missing-labels', pr: pr.number, issue: issueNo, title: rIssue.title || '',
      }), N.rework));
      return;
    }
    let rGate = assessDispatchModel(rModel, { policy, enabledIds, redIds });
    // 顶班（2026-09-05 实咬）：快马单的 model/ 标签常是主会话子代理的模型（claude-opus-5），
    // 它在服务器腿表里没有可派的腿 → 返工永远派不出去，红项在 GitHub 上躺着没人接。
    // 返工要的是「有人改」，不是「同一个人改」——原模型派不出就落回选型写码首选。
    // 只对「这个模型不能派」两种原因顶班；「选型没查成」仍 fail-closed，因为那时连顶班人选也验不了。
    let reworkModel = rModel;
    let substituted = null;
    if (!rGate.ok && (rGate.reason === 'model-not-in-routing' || rGate.reason === 'model-health-red')) {
      const fb = situation.defaultWorkerModel;
      const fbGate = fb ? assessDispatchModel(fb, { policy, enabledIds, redIds }) : { ok: false };
      if (fb && fbGate.ok) {
        substituted = { from: rModel, to: fb, why: rGate.why };
        reworkModel = fb;
        rGate = fbGate;
      }
    }
    if (!rGate.ok) {
      out.push(withNeeds(esc(`PR #${pr.number} 要返工，但${rGate.why}`, { reason: rGate.reason, pr: pr.number, issue: issueNo, model: rModel }), N.rework));
      return;
    }
    // 单轮上限沿用 maxDispatchPerRound（#849：无上限会刷单）。返工走**独立计数**而不是与新派单共用一个：
    // 新派单循环在本函数更早处跑，共用一个计数会让 ready 队列长期把返工挤掉（判红的 PR 永远等不到人）。
    // 独立计数同样封死刷单（每轮最多 maxDispatchPerRound 个返工工人），超出的排队下轮，不丢、不 escalate。
    if (reworkThisRound >= policy.maxDispatchPerRound) return;
    reworkThisRound += 1;
    out.push(withNeeds({
      kind: 'rework', pr: pr.number, head, issue: issueNo,
      model: reworkModel, reviewer: rReviewer, redRounds,
      title: pr.title || '', brief, reworkKey: rkey, conflict,
      ...(substituted ? { substitutedModel: substituted } : {}),
      why: why + (substituted ? `；原模型 ${substituted.from} 派不出（${substituted.why}），顶班 ${substituted.to}` : ''),
    }, N.rework));
    out.push(withNeeds(hub(hubText, 'dispatched', { pr: pr.number }), N.rework));
  }

  // ③ PR 驱动：判绿合并 / manual 待拍板 / 审官轮次
  for (const pr of gh.prs || []) {
    if (!pr || pr.number == null) continue;
    // #1000：认输 / 等用户是 PR 属性。指挥官见到就跳过，不再机械重试（省额度）。
    // 合并路仍走——帅位关掉或去掉标之后自然回来；标还在时也不自动合一张已经认输的 PR。
    if (prHasStuckLabel(pr) || exhaustedThisRound.has(Number(pr.number))) continue;

    // 判绿判据只认**真 review**（2026-09-05 实咬）：原来这里的入口是 prApprovedReady，
    // 它要 pr.reviewDecision === 'APPROVED'。而 reviewDecision 是 GitHub 按分支保护规则算的聚合值，
    // 本仓没开分支保护 ⇒ 它恒为 null，判绿也 null、判红也 null。
    // 后果是自动合并这条路**从来没通过电**：审官判绿了，指挥官这一格永远进不去，
    // PR 就一直挂着等人。判红那一维同样在帅位盘面上隐形（shuai-scan 的 prRed 只看 CI）。
    // 改成按当前 head 看真 review（analyzeReviewsAtHead，与下面判红同一判据，绿红一把尺）：
    //   · reviewDecision=APPROVED 仍然认（开了分支保护的仓走这条）；
    //   · 没查成一律不合，与「查过确实没绿」分开。
    const mergeA = analyzeReviewsAtHead(prReviewInput(reviews.byPr?.[pr.number]), pr.headRefOid);
    const decisionApproved = String(pr.reviewDecision || '').toUpperCase() === 'APPROVED';
    const greenAtHead = mergeA.scanned && mergeA.latestGreen === true;
    // #1017：list / GraphQL 上 mergeable 常恒 UNKNOWN。未知态才单张重查，已知态不烧配额。
    const resolvedMergeable = resolveMergeable(pr, { viewMergeable: situation.viewMergeable });
    const mergeableState = String(resolvedMergeable.mergeable || '').toUpperCase();
    const mergeableNow = mergeableState === 'MERGEABLE';

    if ((greenAtHead || decisionApproved) && !pr.isDraft && mergeableNow) {
      const ci = prChecksRed(pr);
      if (ci.red) { // 判绿却 CI 红：矛盾态，不自动合，报帅
        out.push(withNeeds(esc(`PR #${pr.number} 审官判绿但 CI 红（${ci.reason}）——不自动合，报帅`, { reason: 'approved-but-ci-red', pr: pr.number }), N.merge));
        out.push(withNeeds(hub(`PR #${pr.number} 判绿但 CI 红，卡住了`, 'stuck', { pr: pr.number }), N.merge));
        continue;
      }
      if (!greenAtHead) {
        // 只有 reviewDecision 说绿、而当前 head 上看不到 APPROVED 时才走这条老路（既有契约不动）：
        // 不带 head 复核一遍逐条 review，拿不到就报没查成，拿到但没绿就报 approved-without-review。
        const a = analyzeReviews(prReviewInput(reviews.byPr?.[pr.number]));
        if (!a.scanned) {
          out.push(withNeeds(esc(`PR #${pr.number} 判绿待合并，但该 PR reviews 没查成`, { reason: 'unscanned', pr: pr.number, missing: ['prReviews'] }), N.merge));
          continue;
        }
        if (!a.green && !a.latestGreen) {
          out.push(withNeeds(esc(`PR #${pr.number} reviewDecision=APPROVED 但 reviews 里没有 APPROVED 状态——报帅`, { reason: 'approved-without-review', pr: pr.number }), N.merge));
          continue;
        }
      }
      out.push(withNeeds({ kind: 'merge', pr: pr.number, title: pr.title || '', why: '审官判绿（当前 head）+ CI 绿 + MERGEABLE' }, N.merge));
      out.push(withNeeds({ kind: 'land', why: '合并后收工清理（land 幂等；清树归 #829，本单只调 land）' }, N.land));
      out.push(withNeeds(hub(`PR #${pr.number} 已自动合并`, 'merged', { pr: pr.number }), N.merge));
      continue;
    }

    if ((greenAtHead || decisionApproved) && pr.isDraft) { // 判绿但 draft（manual 合门）→ 需拍板，报帅（不自动合）
      out.push(withNeeds(hub(`PR #${pr.number} 判绿待人工合并（manual 合门）`, 'decide', { pr: pr.number }), N.merge));
      continue;
    }

    // 冲突态：审官判不了冲突 PR——GitHub 对 CONFLICTING 连 CI 都不触发，叫审官必然白跑，
    // drain 试满后每轮开一张 [待拍板] 单。这一格原本整个空着：指挥官只认 MERGEABLE（合并）
    // 和判红（返工），CONFLICTING 从所有分支里漏掉，9 张 PR 卡在这里没有任何动作（2026-09-06 实测）。
    // 必须排在下面 analyzeReviewsAtHead 之前：冲突 PR 常常一条 review 都没有，
    // 而 reviews-missing 在下面是静默 continue，写在后面会被吃掉。
    // 只认显式 CONFLICTING：UNKNOWN 是 GitHub 还在异步算，没查成 ≠ 有冲突。
    // mergeableState 已经过 resolveMergeable：列表 UNKNOWN 时单张重查后再判。
    // #1056 / #1043：draft 不是「有人在做」。4 张 CONFLICTING 全是 draft、一个活会话都没有，
    // 却被 !pr.isDraft 整批挡在门外。改问活执行者；查不成当有人在做（不往活树上再塞人）。
    // 观测面未接入（老夹具）维持旧契约：draft 不派。
    if (mergeableState === 'CONFLICTING') {
      const live = hasLiveExecutor({
        sessions: sessionListForLiveness(situation),
        pr: pr.number,
        issue: attributedIssueNumber(pr),
      });
      if (live.live) continue; // 有人在做，或会话名单没查成——不派
      if (live.unavailable && pr.isDraft) continue; // 观测面未接：draft 维持旧契约
      const head = pr.headRefOid || '';
      if (!head) {
        out.push(withNeeds(esc(
          `PR #${pr.number} 是 CONFLICTING 但 headRefOid 没查成——派不出解冲突工人`,
          { reason: 'unscanned', pr: pr.number, missing: ['github'], detail: 'conflict-head-unscanned' },
        ), N.rework));
        continue;
      }
      pushRework(pr, {
        head,
        redRounds: 0,
        conflict: true,
        brief: [
          `本单只做一件事：把 PR #${pr.number} 与 master 的冲突解掉，让它回到可合并状态。`,
          ``,
          `做法：把 origin/master 合进本分支，逐个冲突文件按「两边的意图都要保住」来解，`,
          `解完跑 node scripts/dao-check.mjs，绿了再推。`,
          ``,
          `硬边界：`,
          `- 不许用 --ours/--theirs 整片覆盖——master 上已合并的成果被反向删掉是本仓判例（#902）。`,
          `- 不许借机改本单范围外的东西；解冲突就只解冲突。`,
          `- 冲突文件在 master 侧被删除/拆分的（例如测试拆套），要把本分支的改动搬到新落点，不是把文件复活。`,
        ].join('\n'),
        why: `PR #${pr.number} 与 master 冲突（CONFLICTING）——审官判不了冲突 PR，先派工人解冲突`,
        hubText: `PR #${pr.number} 与 master 冲突，已自动派工人解冲突`,
      });
      continue;
    }

    // 红轮数按**当前 head** 重算：工人推了新 head ⇒ 旧红不作数，该 PR 回到「等审官」（不派返工）。
    const a = analyzeReviewsAtHead(prReviewInput(reviews.byPr?.[pr.number]), pr.headRefOid);
    if (!a.scanned) {
      // 「没查成」与「查过确实没红」必须分开。reviews-missing 沿用既有契约静默跳过；
      // head / commit_id 没查成走 fail-visible 的 unscanned escalate（escalate 对 unscanned 是静默进 status，不开单不刷屏）。
      if (a.reason !== 'reviews-missing') {
        const headMissing = a.reason === 'head-unscanned';
        out.push(withNeeds(esc(
          `PR #${pr.number} 的红要按当前 head 重算，但${headMissing ? ' PR headRefOid 没查成' : '有判别态 review 缺 commit_id'}——不清零、也不当仍红`,
          { reason: 'unscanned', pr: pr.number, missing: [headMissing ? 'github' : 'prReviews'], detail: a.reason },
        ), N.rework));
      }
      continue;
    }
    // 当前 head 上一条判定都没有 ⇒ 要审官。历史上审过（复审）和从没审过（首审）是同一格，
    // 别拆成两条规则：判据都是「当前 head 缺判定」，做法都是写一张复审待办票交给 drain。
    //
    // 2026-09-05 实咬两次，两次都是「记账记错了对象」：
    //  一、#890/#893/#896/#905 的红全打在旧 commit 上，工人早改完推了新 head，
    //     「按当前 head 重算」把红清零 → 不派返工也不走合并，这一格空着，PR 挂了 10 小时。
    //  二、补上复审票之后仍然卡死：账本记的是「票写出去了」，可审官起来就死（裸 pi 落错 provider 401），
    //     判定一条没落，而 `if (!reworkDispatched[rrKey])` 把这张 PR 永久挡在门外——
    //     #894/#899/#905 的票 04:22 就"派成功"了，7 小时后当前 head 判定仍是 0，没有任何东西会重试。
    //     这与同日 agent-stall-watch 换人账本犯的是同一个病（失败和成功记同一条账）。
    //
    // 所以这里不记 ok：**走到这个分支本身就是「上一次没落地」的证据**（判定真落了 a.atHead 就 > 0，
    // 根本进不来）。只记 tries，并给上一票一段宽限期——审官正在看的时候别每 20 分钟重发一张。
    // 试满仍无判定 ⇒ 停手报帅，不死循环。
    if (a.atHead === 0) {
      // #971：缺 reviewer/ 时先补标签。等宽限期不会让标签自己长出来；
      // 执行侧 requestRereview 没 reviewer 会拒，票写出去也是空转。
      const reviewer = reviewerLabelFor(gh, pr);
      if (!reviewer) {
        const filled = maybeAddLabel(attributedIssueOf(gh, pr), situation, {
          pr: pr.number,
          why: `PR #${pr.number} 要叫审官，但署名单缺 reviewer/——补唯一跨厂标签`,
        }, N['add-label']);
        if (filled) { out.push(filled); continue; }
      }
      const rrKey = `rereview:${pr.number}@${a.head}`;
      const prev = reworkDispatched[rrKey];
      const tries = Number(prev?.tries) || 0;
      const ageMin = prev ? (nowMs - (Date.parse(prev.at || '') || 0)) / 60000 : Infinity;
      if (prev && Number.isFinite(ageMin) && ageMin < REREVIEW_GRACE_MIN) continue; // 上一票还在宽限期，审官可能正在看
      const firstRound = a.judgedTotal === 0;
      if (tries >= MAX_REREVIEW_TRIES) {
        out.push(withNeeds(buildMarkExhausted({
          pr: pr.number, verb: 'rereview', tries, head: a.head,
          why: `PR #${pr.number} 叫了 ${tries} 次审官，当前 head ${a.head.slice(0, 8)} 判定仍是 0——停手交人`,
        }), N['mark-exhausted']));
        exhaustedThisRound.add(Number(pr.number));
        continue;
      }
      out.push(withNeeds({
        kind: 'rereview', pr: pr.number, head: a.head,
        issue: attributedIssueNumber(pr),
        reviewer,
        stateKey: rrKey,
        tries: tries + 1,
        why: firstRound
          ? `PR #${pr.number} 交卷可合但一条判定都没有，当前 head ${a.head.slice(0, 8)} 没人审——叫审官`
          : `PR #${pr.number} 的 ${a.judgedTotal} 条判定都打在旧 commit 上，当前 head ${a.head.slice(0, 8)} 没人审——叫审官复审（第 ${tries + 1} 次）`,
      }, N['attach-reviewer']));
      continue;
    }
    // 当前 head 上最后一条判别态是红 → 派一个返工工人（#931：删掉「唤大脑翻译返工方向」整层）。
    // 旧红（打在旧 head）在上面 analyzeReviewsAtHead 里就已经不算数了，这里天然不会触发。
    if (!a.latestRed) continue; // 没红 / 最后一条是绿 = 等审官或走合并路，本分支无事
    // 红项全文取不到（审官判了红没留正文）= 没查成：不派、也不当成功。
    const brief = latestRedBody(a.judged);
    if (!brief) {
      out.push(withNeeds(esc(
        `PR #${pr.number} 当前 head ${a.head.slice(0, 8)} 上判了红，但最后一条判红 review 没有正文——返工工人无从下手，不派`,
        { reason: 'unscanned', pr: pr.number, missing: ['prReviews'], detail: 'rework-brief-unscanned' },
      ), N.rework));
      continue;
    }
    pushRework(pr, {
      brief, head: a.head, redRounds: a.redRounds,
      why: `PR #${pr.number} 审官判红（打在当前 head ${a.head.slice(0, 8)} 上）——派返工工人，任务书带红项全文`,
      hubText: `PR #${pr.number} 审官判红，已自动派返工工人（红项全文交给它，逐条改）`,
    });
  }

  // ⑤ 对账循环（#1056）：未结 job.dispatch ∖ 活会话 → 差集重派。
  // 观测面和期望集都没挂上（老夹具）→ 整段跳过，既有动作不受影响。
  // sessions 不进 SITUATION_SECTIONS：名单没查成只挡住重派，不许把合并/叫审官整轮停掉。
  if (situation.sessions != null || situation.desiredJobs != null) {
    const desired = situation.desiredJobs;
    const plan = planReconcile({
      desired: desired && desired.unscanned ? null : (desired && desired.items),
      sessions: sessionListForLiveness(situation),
      openIssues: gh.scanned ? (gh.issues || []).map((i) => i && i.number).filter((n) => Number.isInteger(n)) : null,
      alreadyQueued: out.map((a) => a.issue).filter((n) => Number.isInteger(n)),
      maxPerRound: policy.maxDispatchPerRound,
      dispatchedThisRound: out.filter((a) => a.kind === 'dispatch').length,
    });
    if (plan.unscanned) {
      out.push(withNeeds(esc(plan.reports[0] || '对账循环没查成——当有人在做，不重派', {
        reason: 'unscanned', detail: 'reconcile-unscanned',
      }), N.dispatch));
    }
    for (const rd of plan.redispatches) {
      const issue = (gh.issues || []).find((i) => i && i.number === rd.issue);
      const model = labelValue(issue, 'model/');
      const reviewer = labelValue(issue, 'reviewer/');
      if (!issue || !model || !reviewer) {
        out.push(withNeeds(esc(`#${rd.issue} 差集要重派，但 model/reviewer 没查成，不猜`, {
          reason: 'missing-labels', issue: rd.issue,
        }), N.dispatch));
        continue;
      }
      const rGate = assessDispatchModel(model, { policy, enabledIds, redIds });
      if (!rGate.ok) {
        out.push(withNeeds(esc(`#${rd.issue} 差集要重派，但${rGate.why}`, {
          reason: rGate.reason, issue: rd.issue, model,
        }), N.dispatch));
        continue;
      }
      out.push(withNeeds({
        kind: 'dispatch', issue: rd.issue, model, reviewer,
        role: labelValue(issue, 'type/') || null,
        title: issue.title || '',
        why: rd.why,
        reconcile: true,
      }, N.dispatch));
      out.push(withNeeds(hub(`#${rd.issue} 账上有人、名单里没有——已自动重派`, 'dispatched', { issue: rd.issue }), N.dispatch));
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
 *                    prs:[{number,title,isDraft,reviewDecision,mergeable,headRefOid,statusCheckRollup,body}], error }
 *                  headRefOid 缺 ⇒ 该 PR 的红轮判据按「没查成」走：不清零、也不当仍红
 *   orca:          观察面（#1055 起不进必查清单；退役后 scanned:false 不当闸）
 *   reviewPending: { scanned, items:[{pr,head,reviewer,worker,source,error}], error }
 *   prReviews:     { scanned, byPr:{ <n>:{ reviews:[{state,body,commit_id}], bodies:[...] } }, error }（decide 优先 reviews）
 *   stall:         { scanned, strikes:{ <term>:{strikes,sig} }, error }
 *   sessions:      { scanned, items:[{key,title,state,cwd}], error } —— #1056 观测集；不进 SITUATION_SECTIONS
 *   desiredJobs:   { unscanned, items:[{job_id,issue,pr,identity,model}], error } —— #1056 期望集（未结 job.dispatch）
 *   wakeCounts:    { <target>: n }——撞死指纹 `stall:<term>` / 代拍 `daipai:issue-<n>`（#931 后 PR 判红不再走唤醒）
 *   reworkDispatched: { `rework:<pr>@<oid>`: {...} }——该 PR 该 head 已派过返工工人；act 侧派工后记账
 *   viewMergeable:  (prNumber) => string | {ok, mergeable, error} —— #1017 列表 UNKNOWN 时单张重查；不注入则 UNKNOWN 保持没查成
 *
 * 契约：任一节 unscanned → 依赖它的动作一律不产，汇成**一条** escalate(reason:'unscanned', missing:[...])；
 *       依赖节全 scanned 的动作照常。全部 unscanned → 只有那一条 escalate、零正向动作。
 */
export function decide(situation = {}) {
  const unscanned = SITUATION_SECTIONS.filter((s) => !situation[s]?.scanned);
  const candidates = collectCandidates(situation);
  const actions = [];
  const openLedger = situation.openIssueLedger || {};
  for (const cand of candidates) {
    const needs = cand._needs || ACTION_NEEDS[cand.kind] || [];
    const missing = needs.filter((s) => !situation[s]?.scanned);
    const { _needs, ...clean } = cand;
    if (missing.length === 0) {
      // #971：能转成 open-issue 的 escalate 当场转；已开过返回 null；转不成保持原动作。
      const next = escalateToOpenIssue(clean, { ledger: openLedger });
      if (next) actions.push(next);
    }
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
