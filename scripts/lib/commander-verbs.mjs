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

export const DEFAULT_GH_ROLE = 'marshal';
export const ADD_LABEL_PREFIXES = ['reviewer/', 'model/'];

// 与 commander-core 的 REREVIEW_GRACE_MIN / MAX_REREVIEW_TRIES 同形同值。
// 本文件不 import core，避免 decide ↔ 校验循环依赖；测试钉死两边相等。
export const DRAIN_GRACE_MIN = 45;
export const MAX_DRAIN_TRIES = 3;

/** 会转成 open-issue 的 escalate 理由。unscanned / missing-labels 不在这里（前者静默，后者走 add-label）。 */
export const OPEN_ISSUE_REASONS = new Set([
  'wake-exhausted', 'drain-exhausted', 'rereview-exhausted',
]);

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
export function planAddLabelCmd(action = {}, { models } = {}) {
  const v = validateAddLabel({ ...action, models: models || action.models });
  if (!v.ok) return v;
  if (action.issue == null && action.pr == null) {
    return fail('no-target', 'add-label 要 issue 或 pr 号');
  }
  const sub = action.issue != null
    ? ['issue', 'edit', String(action.issue)]
    : ['pr', 'edit', String(action.pr)];
  const argv = ['node', 'scripts/gh-as.mjs', v.role, '--', ...sub];
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

  const key = `pr:${pr}`;
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

  const exhausted = gated(
    'retry-drain.max-tries',
    tries >= maxTries,
    fail('exhausted', `PR #${pr} 已试 ${tries} 次仍在队列——停手交人`, { escalate: true, tries }),
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
    queue: opts.queue,
    ledger: opts.ledger,
    nowMs: opts.nowMs,
    graceMin: opts.graceMin,
    maxTries: opts.maxTries,
  });
  if (!v.ok) return v;
  return {
    ok: true,
    argv: ['node', 'scripts/dao.mjs', 'review-pending-drain', '--pr', String(v.pr)],
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
  return { ok: true, body, title: `[待拍板] ${v.reason}${link ? '：' + link : ''}`, key: v.key, role: v.role };
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
      'node', 'scripts/gh-as.mjs', v.role, '--',
      'issue', 'create',
      '--repo', repo,
      '--title', rendered.title,
      '--body-file', bodyPath,
      '--label', '待拍板',
    ],
    role: v.role,
    key: v.key,
    title: rendered.title,
    body: rendered.body,
  };
}

/** decide 把可转的 escalate 换成 open-issue；转不成保持原动作。 */
export function escalateToOpenIssue(action, { ledger } = {}) {
  if (!action || action.kind !== 'escalate') return action;
  if (!OPEN_ISSUE_REASONS.has(action.reason)) return action;
  const answers = threeQuestionsFor(action.reason, action.why);
  if (!answers) return action;
  const target = action.pr != null ? `pr-${action.pr}` : action.issue != null ? `issue-${action.issue}` : action.term || '';
  const v = validateOpenIssue({
    reason: action.reason,
    original: action.why,
    target,
    answers,
    ledger: ledger || {},
    role: action.role,
  });
  if (!v.ok) {
    // 已开过：吞掉，不许再走旧 escalate 开第二张。其它校验拒：保持 escalate（人不猜）。
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
