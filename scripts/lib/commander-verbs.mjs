// scripts/lib/commander-verbs.mjs —— 服务器帅位三动词的纯函数校验层（#971）
//
// 与执行层分开：本文件不 spawn、不读盘、不碰 GitHub。decide 产动作前过这里，
// executor 动手前再过一遍——调用方填的值过不了就拒，不许放行后再补救。
//
// 三个动词：
//   add-label     补 reviewer/ 与 model/ 标签
//   retry-drain   重跑失败的 review-pending-drain
//   open-issue    把 escalate 转成 issue
//
// GitHub 写动作的 role 是参数，默认 marshal（不新增 App；watchdog 私钥没装也能先跑）。
//
// 变异：每个校验挂在 CHECKS 上。测试把某一条置 false，对应违规样本必须被放行
// （证明这条是承重的，不是旁路）。生产路径上 CHECKS 全 true。

import { assertCrossVendor } from './reviewer-vendor-gate.mjs';
import { ROLES } from './gh.mjs';
import { classifyDrainAttempt } from './dispatch/review-pending.mjs';
// #1236：判据版本。**定义在这里**（不在 commander-core）——drainLedgerKey 也在这文件，
// 而 commander-core → commander-verbs 是单向依赖，写在 core 会绕成环。
import { retryEpoch, stampRetryKey } from './retry-epoch.mjs';
// #1237：失败分类（terminal / retryable / unknown）——判据在那边，这里只消费。
// 行为 streak（judgeRepeatedFailure）也在那边：词表认不出的同一闸拒，靠「连着一模一样」拦。
import { judgeRetry, judgeRepeatedFailure, foldFailureStreak } from './retry-verdict.mjs';

export const DEFAULT_GH_ROLE = 'marshal';
export const ADD_LABEL_PREFIXES = ['reviewer/', 'model/'];

// 与 commander-core 的 REREVIEW_GRACE_MIN / MAX_REREVIEW_TRIES 同形同值。
// 本文件不 import core，避免 decide ↔ 校验循环依赖；测试钉死两边相等。
export const DRAIN_GRACE_MIN = 45;
export const MAX_DRAIN_TRIES = 3;

/** 会转成 open-issue 的 escalate 理由。unscanned / missing-labels 不在这里（前者静默，后者走 add-label）。
 *  #1000：drain/rereview/rework 的 exhausted 改打 PR 标，不再开单。wake-exhausted 是终端不是 PR，仍走开单。 */
export const OPEN_ISSUE_REASONS = new Set([
  'wake-exhausted',
]);

/** 与 commander.mjs HUB_DEDUP_MS 同值：发卡成功后 6 小时内不重发。 */
export const OPEN_ISSUE_CARD_DEDUP_MS = 6 * 3600 * 1000;

export const CHECKS = {
  'add-label.role': true,
  'add-label.labels-array': true,
  'add-label.prefix': true,
  'add-label.unique-prefix': true,
  'add-label.routing': true,
  'add-label.cross-vendor': true,
  'retry-drain.pr': true,
  'retry-drain.queue': true,
  'retry-drain.attempted': true,
  'retry-drain.hopeless': true,
  'retry-drain.max-tries': true,
  'retry-drain.grace': true,
  'open-issue.reason': true,
  'open-issue.original': true,
  'open-issue.three-questions': true,
  'open-issue.dedup': true,
};

function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

/** 变异测试传入 overrides，生产路径用 CHECKS。不改全局，避免测试并行互踩。 */
export function checksOf(input) {
  if (input && input._checks && typeof input._checks === 'object') return input._checks;
  return CHECKS;
}

/** 校验开着且条件命中 → 返回失败对象；校验被摘掉 → 当没这道闸。 */
export function gated(id, hit, failObj, checks = CHECKS) {
  if (checks[id] !== true) return null;
  return hit ? failObj : null;
}

function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  const out = [];
  for (const l of labels) {
    if (typeof l === 'string') { if (l) out.push(l); continue; }
    if (l && typeof l.name === 'string' && l.name) out.push(l.name);
  }
  return out;
}

function firstPrefix(names, prefix) {
  for (const n of names) {
    if (n.startsWith(prefix) && n.length > prefix.length) return n.slice(prefix.length);
  }
  return null;
}

export function resolveGhRole(role, checks = CHECKS) {
  if (role == null || role === '') return { ok: true, role: DEFAULT_GH_ROLE };
  const r = String(role);
  const blocked = gated('add-label.role', !ROLES.includes(r), fail('bad-role', `未知 gh role ${r}（只认 ${ROLES.join('/')}）`), checks);
  if (blocked) return blocked;
  return { ok: true, role: r };
}

/**
 * 补标签校验。合法样本放行；违规样本必须带着 code 被拒。
 *
 * 入参：
 *   labels          要补的标签（['reviewer/gpt-5.6-luna']）
 *   existingLabels  目标上已有的标签（判跨厂用）
 *   models          modelsFromJson 形态（id / reviewerDisabled / provider）
 *   role            gh-as 身份，默认 marshal
 *   workerId/reviewerId  已推出的成对 id（有则优先生效，不再从标签猜）
 */
export function validateAddLabel(input = {}) {
  const C = checksOf(input);
  const roleR = resolveGhRole(input.role, C);
  if (!roleR.ok) return roleR;

  const missing = gated(
    'add-label.labels-array',
    !Array.isArray(input.labels) || input.labels.length === 0,
    fail('labels-missing', '要补的标签没给'),
    C,
  );
  if (missing) return missing;
  const rawLabels = Array.isArray(input.labels) ? input.labels : [];

  const prefixes = new Map();
  const resolved = [];
  for (const raw of rawLabels) {
    const name = String(raw || '').trim();
    let prefix = null;
    if (name.startsWith('reviewer/')) prefix = 'reviewer/';
    else if (name.startsWith('model/')) prefix = 'model/';
    const badPrefix = gated(
      'add-label.prefix',
      !prefix,
      fail('label-prefix', `只允许 reviewer/ 或 model/，拒绝 ${name || '（空）'}`),
      C,
    );
    if (badPrefix) return badPrefix;
    if (!prefix) {
      const slash = name.indexOf('/');
      prefix = slash >= 0 ? name.slice(0, slash + 1) : 'model/';
    }

    const id = name.slice(prefix.length).trim();
    if (!id) return fail('label-empty-id', `${prefix} 后面没有值`);

    const dup = gated(
      'add-label.unique-prefix',
      prefixes.has(prefix),
      fail('not-unique', `同一前缀多个值（${prefixes.get(prefix)} 与 ${id}），不猜`),
      C,
    );
    if (dup) return dup;
    prefixes.set(prefix, id);

    const models = input.models;
    const routingMissing = gated(
      'add-label.routing',
      !Array.isArray(models),
      fail('routing-unscanned', '选型没查成', { unscanned: true }),
      C,
    );
    if (routingMissing) return routingMissing;
    const list = Array.isArray(models) ? models : [];
    const hits = list.filter((m) => m && m.id === id);
    const notFound = gated('add-label.routing', hits.length === 0, fail('not-found', `查不到 ${id}（不在选型）`), C);
    if (notFound) return notFound;
    const notUnique = gated('add-label.routing', hits.length > 1, fail('not-unique', `选型里 ${id} 不唯一，不猜`), C);
    if (notUnique) return notUnique;
    const disabled = gated('add-label.routing', hits[0] && hits[0].reviewerDisabled === true, fail('disabled', `${id} 已禁用（禁用 !== true 才许补）`), C);
    if (disabled) return disabled;

    resolved.push(name);
  }

  const existing = labelNames(input.existingLabels);
  const workerId = input.workerId || prefixes.get('model/') || firstPrefix(existing, 'model/');
  const reviewerId = input.reviewerId || prefixes.get('reviewer/') || firstPrefix(existing, 'reviewer/');

  if (!workerId || !reviewerId) {
    return fail('pair-unscanned', '工人与审官必须成对才能判跨厂；缺的那边查不到，不猜', { unscanned: true });
  }

  const gate = assertCrossVendor({ workerId, reviewerId, models: Array.isArray(input.models) ? input.models : [] });
  const vendorFail = gated(
    'add-label.cross-vendor',
    !gate.ok,
    fail(
      gate.state === 'unscanned' ? 'vendor-unscanned' : 'same-vendor',
      gate.error || '跨厂闸未过',
      { unscanned: gate.state === 'unscanned' },
    ),
    C,
  );
  if (vendorFail) return vendorFail;

  return {
    ok: true,
    role: roleR.role,
    labels: resolved,
    workerId,
    reviewerId,
  };
}

/** 纯函数：校验过了才给出 gh-as argv。issue 优先（派工读的是署名单上的标）。 */
export function planAddLabelCmd(action = {}, { models, repo } = {}) {
  const v = validateAddLabel({ ...action, models: models || action.models });
  if (!v.ok) return v;
  if (action.issue == null && action.pr == null) {
    return fail('no-target', 'add-label 要 issue 或 pr 号');
  }
  if (action.issue != null) {
    const targetRepo = repo || action.repo || 'thoerwink8/windsurf-dao';
    const argv = [
      'node', 'scripts/issue-gateway.mjs', 'edit-labels',
      '--repo', targetRepo,
      '--issue', String(action.issue),
      '--host', 'commander',
      '--idempotency-key', `commander-add-label:${action.issue}:${v.labels.join(',')}`,
    ];
    for (const lab of v.labels) argv.push('--add', lab);
    return { ok: true, argv, role: v.role, labels: v.labels, workerId: v.workerId, reviewerId: v.reviewerId };
  }
  const argv = ['node', 'scripts/gh-as.mjs', v.role, '--', 'pr', 'edit', String(action.pr)];
  for (const lab of v.labels) argv.push('--add-label', lab);
  return { ok: true, argv, role: v.role, labels: v.labels, workerId: v.workerId, reviewerId: v.reviewerId };
}

function firstEligibleReviewer(workerId, { models, reviewerOrder }) {
  if (!Array.isArray(models)) return fail('routing-unscanned', '选型没查成', { unscanned: true, state: 'unscanned' });
  if (!Array.isArray(reviewerOrder)) return fail('order-unscanned', '审官顺位没查成', { unscanned: true, state: 'unscanned' });
  for (const id of reviewerOrder) {
    const hit = models.find((m) => m && m.id === id);
    if (!hit || hit.reviewerDisabled === true) continue;
    const gate = assertCrossVendor({ workerId, reviewerId: id, models });
    if (gate.state === 'unscanned') {
      return fail('vendor-unscanned', gate.error, { unscanned: true, state: 'unscanned' });
    }
    if (gate.ok) return { ok: true, id };
  }
  return fail('not-found', '查不到跨厂审官（选型里没有）', { state: 'none' });
}

function firstEligibleWorker(reviewerId, { models, workerOrder }) {
  if (!Array.isArray(models)) return fail('routing-unscanned', '选型没查成', { unscanned: true, state: 'unscanned' });
  if (!Array.isArray(workerOrder)) return fail('order-unscanned', '工人顺位没查成', { unscanned: true, state: 'unscanned' });
  if (!reviewerId) return fail('not-found', '查不到跨厂工人（选型里没有）', { state: 'none' });
  for (const id of workerOrder) {
    const hit = models.find((m) => m && m.id === id);
    if (!hit || hit.reviewerDisabled === true) continue;
    const gate = assertCrossVendor({ workerId: id, reviewerId, models });
    if (gate.state === 'unscanned') {
      return fail('vendor-unscanned', gate.error, { unscanned: true, state: 'unscanned' });
    }
    if (gate.ok) return { ok: true, id };
  }
  return fail('not-found', '查不到跨厂工人（选型里没有）', { state: 'none' });
}

/**
 * 半标态推出要补哪一条。唯一值来自选型顺位（过滤禁用 + 跨厂后的首位），
 * 不是从卡名猜、也不是从无序列表里随手拿一个。
 * 顺位没查成 / 滤完为空 → 查不到（与「猜一个」分开）。
 */
export function proposeAddLabel({ existingLabels, models, reviewerOrder, workerOrder } = {}) {
  if (!Array.isArray(models)) return fail('routing-unscanned', '选型没查成', { unscanned: true, state: 'unscanned' });
  const names = labelNames(existingLabels);
  const model = firstPrefix(names, 'model/');
  const reviewer = firstPrefix(names, 'reviewer/');
  if (model && reviewer) return fail('already', '标签已齐', { state: 'already' });
  if (!model && !reviewer) return fail('none', '两个都没有，不是半标', { state: 'none' });

  if (model && !reviewer) {
    const pick = firstEligibleReviewer(model, { models, reviewerOrder });
    if (!pick.ok) return pick;
    const labels = [`reviewer/${pick.id}`];
    const v = validateAddLabel({ labels, existingLabels, models, workerId: model, reviewerId: pick.id });
    if (!v.ok) return v;
    return { ok: true, labels, workerId: model, reviewerId: pick.id };
  }

  const pick = firstEligibleWorker(reviewer, { models, workerOrder });
  if (!pick.ok) return pick;
  const labels = [`model/${pick.id}`];
  const v = validateAddLabel({ labels, existingLabels, models, workerId: pick.id, reviewerId: reviewer });
  if (!v.ok) return v;
  return { ok: true, labels, workerId: pick.id, reviewerId: reviewer };
}

/**
 * 重跑 drain 校验。只许对已在队列里的票；tries 形状 {at, tries}；
 * 宽限期内不重试；试满 escalate。走到本函数的重试分支本身就是「上次没成」的证据，
 * 所以 ok:true 但票还在队列里也不能当成功挡重试（派了 ≠ 成了）。
 */
export function validateRetryDrain(input = {}) {
  const C = checksOf(input);
  const pr = input.pr == null ? '' : String(input.pr).trim();
  const noPr = gated('retry-drain.pr', !pr, fail('missing-pr', 'retry-drain 要 pr'), C);
  if (noPr) return noPr;

  const queueMissing = gated(
    'retry-drain.queue',
    !Array.isArray(input.queue),
    fail('queue-unscanned', '复审队列没查成', { unscanned: true }),
    C,
  );
  if (queueMissing) return queueMissing;
  const queue = Array.isArray(input.queue) ? input.queue : [];
  const inQueue = queue.some((t) => t && String(t.pr) === String(pr));
  const notQueued = gated('retry-drain.queue', !inQueue, fail('not-in-queue', `PR #${pr} 不在复审队列里，不许凭空造票`), C);
  if (notQueued) return notQueued;

  // 键带 head，与 rereview:<pr>@<head> / rework:<pr>@<head> 对齐。走 drainLedgerKey，
  // 不在 decide / execute 各写一份——#909 修了 decide 侧、漏了 attach-reviewer 写侧，
  // 账记到另一个格子，票还在队列却永远走不进 retry-drain。
  const key = drainLedgerKey(pr, input.head);
  const ledger = input.ledger && typeof input.ledger === 'object' ? input.ledger : {};
  const prev = ledger[key];
  const never = gated(
    'retry-drain.attempted',
    !prev || typeof prev !== 'object',
    fail('never-attempted', `PR #${pr} 没有上次尝试的账，应走 attach-reviewer 不是 retry-drain`),
    C,
  );
  if (never) return never;
  const prevObj = prev && typeof prev === 'object' ? prev : { at: '', tries: 0 };

  const graceMin = Number.isFinite(input.graceMin) ? input.graceMin : DRAIN_GRACE_MIN;
  const maxTries = Number.isFinite(input.maxTries) ? input.maxTries : MAX_DRAIN_TRIES;
  const tries = Number(prevObj.tries) || 0;
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : 0;

  // #1237：先问「这个失败再试一次会不会不一样」。判据在 lib/retry-verdict.mjs，
  // 不在这里写词表——这里只消费结论。
  //
  // 为什么这一条要在 max-tries **之前**：7 天日志 274 条错误里 54% 是不可试的
  // （树/文件已经不在了、账本里根本没这条记录、执行目录判死）。对它们试满 3 次
  // = 白等 3×45 分钟才见到人，而每一次都不可能成功。
  // 一次就交人 vs 两小时后交人，差的不是效率，是「这张卡还活着吗」。
  //
  // 判据落在**上一轮记下的失败原文**上（applyDrainLedger 存进 lastError / sameErrorRounds）。
  // 没记过原文 → verdict 为 unknown → 按可试处理（保守：宁可多试一次）。
  // 词表认不出时，行为 streak 补上：同一原文连着 SAME_ERROR_ROUNDS_TO_STUCK 轮 = 再试还是它。
  const verdict = judgeRetry({ error: prevObj.lastError });
  const repeated = judgeRepeatedFailure(prevObj);
  const hopelessNow = verdict.verdict === 'terminal' || repeated.stuck;
  const hopelessWhy = verdict.verdict === 'terminal'
    ? `PR #${pr} 的失败重试不会变——当场交人，不烧满名额：${prevObj.lastError || '（无原文）'}`
    : `PR #${pr} 连着 ${repeated.rounds} 轮拿回一模一样的失败原文——当场交人：${prevObj.lastError || '（无原文）'}`;
  const hopeless = gated(
    'retry-drain.hopeless',
    hopelessNow,
    fail('hopeless', hopelessWhy,
      {
        escalate: true, tries,
        retryVerdict: verdict.verdict === 'terminal' ? 'terminal' : verdict.verdict,
        verdictWhy: verdict.verdict === 'terminal' ? verdict.why : repeated.why,
        error: prevObj.lastError || null,
      }),
    C,
  );
  if (hopeless) return hopeless;

  const exhausted = gated(
    'retry-drain.max-tries',
    tries >= maxTries,
    fail('exhausted', `PR #${pr} 已试 ${tries} 次仍在队列——停手交人`, { escalate: true, tries, retryVerdict: verdict.verdict }),
    C,
  );
  if (exhausted) return exhausted;

  const ageMin = prevObj.at ? (nowMs - (Date.parse(prevObj.at) || 0)) / 60000 : Infinity;
  const inGrace = gated(
    'retry-drain.grace',
    Number.isFinite(ageMin) && ageMin < graceMin,
    fail('grace', `PR #${pr} 上一票还在宽限期（${Math.round(ageMin)}/${graceMin} 分钟）`),
    C,
  );
  if (inGrace) return inGrace;

  return {
    ok: true,
    pr,
    tries: tries + 1,
    stateKey: key,
    // 不把 prev.ok === true 当成功：票还在队列里 = 没成。
  };
}

export function planRetryDrainCmd(action = {}, opts = {}) {
  const v = validateRetryDrain({
    pr: action.pr,
    head: action.head,
    queue: opts.queue,
    ledger: opts.ledger,
    nowMs: opts.nowMs,
    graceMin: opts.graceMin,
    maxTries: opts.maxTries,
  });
  if (!v.ok) return v;
  // --pr 只隔离这一张（#1104 毒票不许拖死整队），仍过容量闸。
  // 不过上限是 --force，只许人手；指挥官自动化不许带。
  return {
    ok: true,
    argv: action.repo
      ? ['node', 'scripts/dao.mjs', 'review-pending-drain', '--pr', String(v.pr), '--repo', String(action.repo)]
      : ['node', 'scripts/dao.mjs', 'review-pending-drain', '--pr', String(v.pr)],
    pr: v.pr,
    tries: v.tries,
    stateKey: v.stateKey,
  };
}

/**
 * 开单三问（#556）：说得出做到什么算完 / 这批会做 / 不是 memory-docs。
 * 过不了就不开。
 */
export function validateThreeQuestions(answers, checks = CHECKS) {
  const missing = gated(
    'open-issue.three-questions',
    !answers || typeof answers !== 'object',
    fail('three-questions-missing', '开单三问没答，不开'),
    checks,
  );
  if (missing) return missing;
  const src = answers && typeof answers === 'object' ? answers : {};
  const done = String(src.done || '').trim();
  const noDone = gated('open-issue.three-questions', !done, fail('three-questions-done', '说不出做到什么算完，不开'), checks);
  if (noDone) return noDone;
  const batch = src.batch;
  const notThis = gated(
    'open-issue.three-questions',
    batch !== true && batch !== 'this' && batch !== 'this-batch',
    fail('three-questions-batch', '不是这批会做，不开（排期/以后走 ideas）'),
    checks,
  );
  if (notThis) return notThis;
  const isDocs = gated(
    'open-issue.three-questions',
    src.docs !== false && src.docs !== 'no',
    fail('three-questions-docs', '是 memory/docs 就不开 issue'),
    checks,
  );
  if (isDocs) return isDocs;
  return { ok: true, answers: { done, batch: 'this', docs: false } };
}

/** 确定性 decide 给已知 escalate 填三问。unscanned / 空 why 填不出 → 不开。 */
export function threeQuestionsFor(reason, why) {
  if (!reason || reason === 'unscanned') return null;
  const done = String(why || '').trim();
  if (!done) return null;
  return { done, batch: 'this', docs: false };
}

export function openIssueDedupKey(reason, target) {
  return `${String(reason || '')}+${String(target || '')}`;
}

/**
 * #1236：判据版本，进程内只算一次。
 *
 * 「只算一次」不是性能优化（137KB 哈希不到 5ms），是**一致性**：一个进程里有几十处建键，
 * 必须用同一个版本号。若逐次重读文件，中途有人改了文件（派工链在跑的同时有人在 worktree
 * 里提交）就会出现同一轮里两套键，账记到两个格子——正是 #909 那个形状。
 * 缓存的是**值**不是**文件**，所以不存在「缓存何时失效」的问题：进程活多久就用多久。
 */
let EPOCH_CACHE = null;
export function epochOf({ reload = false } = {}) {
  if (!reload && EPOCH_CACHE) return EPOCH_CACHE;
  EPOCH_CACHE = retryEpoch();
  return EPOCH_CACHE;
}

// #1236：把 stampRetryKey 从本模块转出去（re-export），让 commander-core 只依赖
// commander-verbs 这一个方向，不必为了一个纯函数再 import 一层（也就不会绕成环）。
export { stampRetryKey };

/** retry-epoch 的 stampRetryKey 包一层本进程的版本号，调用方不必自己取 epoch。 */
export function stampedKey(base) { return stampRetryKey(base, epochOf().epoch); }

/** drain 账本键：有 head 写 pr:<pr>@<head>，拿不到退回 pr:<pr>（没查成，不猜）。
 *  decide 与 execute 必须走这一个门面——#909 修了 decide 侧、漏了 attach-reviewer 写侧，
 *  账记到另一个格子，票还在队列却永远走不进 retry-drain。
 *  #1236：带判据版本——决定「drain 推不推得动」的代码变了，旧账自动作废（lib/retry-epoch.mjs）。 */
/**
 * 形态部分：`pr:<pr>@<head>`（拿不到 head 退回 `pr:<pr>`）。
 * **常量、与判据版本无关**，给同步上下文（构造 fixture）用。
 *
 * 为什么拆出这一半：账本键会出现在测试的**同步** fixture 里（`sit()` 这种返回普通对象的
 * 地方），那里 `await` 用不了。逼调用方去 await 一个纯拼字符串的函数，结果就是测试退回
 * 手拼字面量——而手拼正是加判据版本那天静默失配的根源（测试假绿、生产卡死）。
 */
export function drainLedgerShape(pr, head) {
  const p = pr == null ? '' : String(pr).trim();
  const headOid = typeof head === 'string' && head.trim() ? head.trim() : null;
  return headOid ? `pr:${p}@${headOid}` : `pr:${p}`;
}

export function drainLedgerKey(pr, head) {
  return stampedKey(drainLedgerShape(pr, head));
}

/**
 * 同步建键门面：`{ rework, rereview, pump, drain }`，参数与对应的 Key() 函数一致。
 *
 * **这是给同步 context 用的**（fixture / 纯函数测试）：判据版本在**模块加载时**取一次，
 * 于是每个键都是同步可算的普通字符串。生产侧不要在长跑的进程里用它——
 * 那个进程应当在**每轮开头**取一次版本（`epochOf()`）并全程沿用，否则同一轮里两套键
 * 会把账记到两个格子（#909 的形状）。
 *
 * 版本值本身是同一份：`epochOf()` 进程内只算一次，所以这里取到的与 Key() 函数取到的一致。
 */
export const retryKeysSync = {
  rework: (pr, head) => stampedKey(`rework:${pr}@${head}`),
  rereview: (pr, head) => stampedKey(`rereview:${pr}@${head}`),
  pump: (pr) => stampedKey(`pump-draft:${pr}`),
  drain: (pr, head) => stampedKey(drainLedgerShape(pr, head)),
};

/**
 * drain 账只在「真动手」时记 tries。达上限 / 没查成拉 0 是背压，
 * 记了会在宽限期后走 retry-drain --pr 把容量闸冲掉（#1125 审官红 1）。
 */
/**
 * drain / 复审两条写路径共用的失败原文。完整原文，不 trim、不截行、不截字——
 * `foldFailureStreak` 比的就是这一串；截过再比会把不同失败揉成同错。
 */
export function drainErrorText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const raw = payload.error != null && payload.error !== '' ? payload.error : payload.why;
  if (raw == null || raw === '') return '';
  return typeof raw === 'string' ? raw : String(raw);
}

export function applyDrainLedger({
  ledger = {}, pr, head, payload, nowIso, _checks,
} = {}) {
  const verdict = classifyDrainAttempt(payload, { _checks });
  if (!verdict.countTry || pr == null) return { ledger, wrote: false, verdict };
  const key = drainLedgerKey(pr, head);
  const prev = ledger && typeof ledger === 'object' ? ledger[key] : null;
  // #1237：把失败原文**存进账本**。原先只记次数，于是下一轮要判「这个失败值不值得再试」
  // 时无从下手——原文只活在那一轮的进程内存里，轮与轮之间丢了。
  // 存完整原文交给 foldFailureStreak：截首行 / 截 400 字会把「前缀相同、后文不同」
  // 两句失败揉成同一错（审官在 1f646efc 上实测 E×400+A vs E×400+B → hopeless）。
  // 人读摘要走 exhaustedReasonText / exhaustedComment，不在比较键上截。
  // 成功拉起审官才清零 streak；失败没原文则保留上一轮（没查成不算「一直是它」，也不当成功）。
  const pulled = verdict.reason === 'pulled';
  const err = drainErrorText(payload);
  const streak = pulled
    ? foldFailureStreak(prev, null)
    : err
      ? foldFailureStreak(prev, err)
      : {
          lastError: prev && typeof prev.lastError === 'string' ? prev.lastError : null,
          sameErrorRounds: Number.isInteger(Number(prev?.sameErrorRounds)) ? Number(prev.sameErrorRounds) : 0,
        };
  return {
    ledger: {
      ...(ledger && typeof ledger === 'object' ? ledger : {}),
      [key]: {
        at: nowIso, pr, tries: (Number(prev?.tries) || 0) + 1,
        ...streak,
      },
    },
    wrote: true,
    verdict,
    key,
  };
}

/**
 * 转单校验：正文必须带 escalate 原文与 reason；同一 reason+target 只开一次；三问过不了不开。
 */
export function validateOpenIssue(input = {}) {
  const C = checksOf(input);
  const roleR = resolveGhRole(input.role, C);
  if (!roleR.ok) return roleR;

  const reason = String(input.reason || '').trim();
  const noReason = gated('open-issue.reason', !reason, fail('no-reason', 'open-issue 要 reason'), C);
  if (noReason) return noReason;
  if (reason === 'unscanned') return fail('unscanned-silent', '没查成的 escalate 不开单（静默进 status）');

  const original = String(input.original || '').trim();
  const noOrig = gated('open-issue.original', !original, fail('no-original', '正文必须带 escalate 原文，不许自己编一段'), C);
  if (noOrig) return noOrig;

  const q = validateThreeQuestions(input.answers, C);
  if (!q.ok) return q;

  const target = String(input.target || '').trim();
  const key = openIssueDedupKey(reason, target);
  const ledger = input.ledger && typeof input.ledger === 'object' ? input.ledger : {};
  const dup = gated('open-issue.dedup', Boolean(ledger[key]), fail('dup', `同一 reason+target 已开过（${key}），不重开`), C);
  if (dup) return dup;

  return {
    ok: true,
    role: roleR.role,
    reason,
    original,
    target,
    key,
    answers: q.answers,
  };
}

/** 转单正文：原文 + reason + 三问，不另编叙事。 */
export function renderOpenIssueBody(input = {}) {
  const v = validateOpenIssue(input);
  if (!v.ok) return v;
  const extra = input;
  const link = extra.pr != null
    ? `PR #${extra.pr}`
    : extra.issue != null
      ? `issue #${extra.issue}`
      : extra.term
        ? `终端 ${extra.term}`
        : (v.target || '');
  const body = [
    '指挥官转单（#971 open-issue）：',
    '',
    `- 原因：${v.reason}`,
    `- 对象：${link}`,
    '- escalate 原文：',
    v.original,
    '',
    '## 三问答案',
    `- 做到什么算完：${v.answers.done}`,
    '- 这批会做：是',
    '- 不是 memory/docs：是',
    '',
    '- 机制判定（处置人必填）：这错在制度生效前还会再犯吗？会 → 机制改在哪；不会 → 为什么。答不出就写「没查成」。',
    '',
    `查重键（勿删）：[commander-open-issue] ${v.key}`,
  ].join('\n');
  if (!body.includes(v.original) || !body.includes(`- 原因：${v.reason}`)) {
    return fail('body-missing-source', '渲染丢了原文或 reason，不开');
  }
  // 标题不再带 `[待拍板] ` 前缀（#1240）：待拍板由 **label** 承载，前缀是同一件事的第二个
  // 真相源，而它俩会不同步（人开的单只有 label；#1210 一度开出两道前缀）。
  // 单里照样有 label（见上面 argv 的 --label），收件人靠 label 找它。
  return { ok: true, body, title: `${v.reason}${link ? '：' + link : ''}`, key: v.key, role: v.role };
}

export function planOpenIssueCmd(action = {}, { repo, bodyPath } = {}) {
  const v = validateOpenIssue(action);
  if (!v.ok) return v;
  if (!repo) return fail('no-repo', 'open-issue 要 repo');
  if (!bodyPath) return fail('no-body-file', 'open-issue 要 --body-file（不许 --body 塞换行）');
  const rendered = renderOpenIssueBody(action);
  if (!rendered.ok) return rendered;
  return {
    ok: true,
    argv: [
      'node', 'scripts/issue-gateway.mjs', 'create',
      '--repo', repo,
      '--title', rendered.title,
      '--body-file', bodyPath,
      '--label', '待拍板',
      '--host', 'commander',
      '--idempotency-key', `commander-open-issue:${v.key}`,
    ],
    role: v.role,
    key: v.key,
    title: rendered.title,
    body: rendered.body,
  };
}

/** 发卡去重戳：与 execOpenIssue / askEscalateCard 的 hubAskOnce key 同一格子。 */
export function openIssueCardSeenKey(dedupKey) {
  return `esc:${String(dedupKey || '')}`;
}

function bookedOpenIssueNumber(entry) {
  const n = Number(entry && entry.number);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function cardStillFresh(hubSeen, dedupKey, now) {
  const last = Date.parse((hubSeen && hubSeen[openIssueCardSeenKey(dedupKey)]) || '') || 0;
  if (!last) return false;
  const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : 0;
  if (!nowMs) return true; // 有戳没时钟：不当过期，免刷屏
  return nowMs - last < OPEN_ISSUE_CARD_DEDUP_MS;
}

/** decide 把可转的 escalate 换成 open-issue；转不成保持原动作。
 *  账本只免重开，不免发卡：已有 OPEN 且没有成功 hubSeen 戳时，仍产 existing 动作去重试卡。 */
export function escalateToOpenIssue(action, { ledger, hubSeen, now } = {}) {
  if (!action || action.kind !== 'escalate') return action;
  if (!OPEN_ISSUE_REASONS.has(action.reason)) return action;
  const answers = threeQuestionsFor(action.reason, action.why);
  if (!answers) return action;
  const target = action.pr != null ? `pr-${action.pr}` : action.issue != null ? `issue-${action.issue}` : action.term || '';
  const key = openIssueDedupKey(action.reason, target);
  const booked = ledger && typeof ledger === 'object' ? ledger[key] : null;
  if (booked) {
    // 已开过：不许再走旧 escalate 开第二张。卡没送到就继续产 existing 去重试。
    const number = bookedOpenIssueNumber(booked);
    if (!number) return null;
    if (cardStillFresh(hubSeen, key, now)) return null;
    return {
      kind: 'open-issue',
      reason: action.reason,
      original: action.why,
      target,
      answers,
      issue: action.issue,
      pr: action.pr,
      term: action.term,
      title: action.title,
      why: action.why,
      role: action.role,
      existing: true,
      number,
    };
  }
  const v = validateOpenIssue({
    reason: action.reason,
    original: action.why,
    target,
    answers,
    ledger: ledger || {},
    role: action.role,
  });
  if (!v.ok) {
    if (v.code === 'dup') return null;
    return action;
  }
  return {
    kind: 'open-issue',
    reason: action.reason,
    original: action.why,
    target,
    answers,
    issue: action.issue,
    pr: action.pr,
    term: action.term,
    title: action.title,
    why: action.why,
    role: v.role,
  };
}
