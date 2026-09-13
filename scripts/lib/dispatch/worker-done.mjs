// scripts/lib/dispatch/worker-done.mjs —— 完工结算 + label 选型域（#762 拆分）
//
// 改这段前必须知道：worker-done 按已有 review 条数分首审 / 返工。
// #1125 起：首审只入队、不自己起审官；drain 按在役审官数拉取。返工往已有会话再推一针。
// 决定在 dispatch 那一刻完整落账（model + reviewer + branch + repo）；PR 上的
// model/* / reviewer/* 是给人看、也是选型唯一真相源（#1116）。
// 选型只读 PR 自己的 label——不读 issue、不从宿主前缀猜家族。
// 打标匹配键是 GitHub owner/name（目标/base 仓，不是 headRepository）+ 分支；
// 缺 reviewer / 缺仓 / identity 不是工人都拒。
// 三态必须分得开：查到一个 / 扫完没有 / 没查成——后两者都拒，不许猜。

import { parseOwnerNameRepo } from './repo.mjs';

export const DEFAULT_DISPATCH_TYPE = '写码';
export const REVIEWER_LABEL_PREFIX = 'reviewer/';

export function dispatchLabelNames({ model, role, reviewer } = {}) {
  const names = [];
  if (model && String(model).trim()) names.push(`model/${String(model).trim()}`);
  names.push(`type/${String(role || DEFAULT_DISPATCH_TYPE).trim()}`);
  if (reviewer && String(reviewer).trim()) names.push(`${REVIEWER_LABEL_PREFIX}${String(reviewer).trim()}`);
  return names;
}

function labelNameOf(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && typeof item.name === 'string') return item.name;
  return '';
}

/**
 * 从 label 列表读出唯一的审官模型。无 IO、可复算。
 * 三态必须输出不同的话：查到一个 / 没有 reviewer/* / 有多个。
 * 后两者都算没查成，不许猜一个。没拿到列表（null/非数组）和「扫完 0 条」也要分开。
 * #1116：真相源是一张 PR 自己的 label，不再对多源拼接做去重。
 */
export function pickReviewer(labels) {
  if (labels == null || !Array.isArray(labels)) {
    return {
      ok: false,
      state: 'unscanned',
      error: 'pickReviewer 没拿到 label 列表（没查成，不许猜）',
    };
  }
  const hits = labels
    .map(labelNameOf)
    .filter(name => name.startsWith(REVIEWER_LABEL_PREFIX) && name.length > REVIEWER_LABEL_PREFIX.length);
  if (hits.length === 0) {
    return {
      ok: false,
      state: 'none',
      error: '没有 reviewer/* label（扫完 0 条，不许猜一个）',
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      state: 'many',
      labels: hits,
      error: `有多个 reviewer/* label（${hits.join('、')}，不许猜一个）`,
    };
  }
  return {
    ok: true,
    state: 'one',
    modelId: hits[0].slice(REVIEWER_LABEL_PREFIX.length),
    label: hits[0],
  };
}

const MODEL_LABEL_PREFIX = 'model/';

/** 从 label 列表读出唯一的工人模型。三态同分：一个 / 没有 / 多个。 */
export function pickModel(labels) {
  if (labels == null || !Array.isArray(labels)) {
    return { ok: false, state: 'unscanned', error: 'pickModel 没拿到 label 列表（没查成，不许猜）' };
  }
  const hits = labels
    .map(labelNameOf)
    .filter(name => name.startsWith(MODEL_LABEL_PREFIX) && name.length > MODEL_LABEL_PREFIX.length);
  if (hits.length === 0) {
    return { ok: false, state: 'none', error: '没有 model/* label（扫完 0 条，不许猜一个）' };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      state: 'many',
      labels: hits,
      error: `有多个 model/* label（${hits.join('、')}，不许猜一个）`,
    };
  }
  return {
    ok: true,
    state: 'one',
    modelId: hits[0].slice(MODEL_LABEL_PREFIX.length),
    label: hits[0],
  };
}

/** 起审官前查工人模型。没拿到列表 ≠ 扫完没有 model/*，两者都拒绝起审官。 */
export function requireWorkerModel(labels) {
  const pick = pickModel(labels);
  if (pick.ok) return pick;
  if (pick.state === 'unscanned') {
    return { ...pick, error: '工人模型列表没拿到（没查成），拒绝起审官' };
  }
  if (pick.state === 'none') {
    return { ...pick, error: '扫完没有 model/*，拒绝起审官' };
  }
  return { ...pick, error: `${pick.error}，拒绝起审官` };
}

/** PR 正文/标题里的署名单号：认「署名 issue #N」（#657）、「关联 issue #N」（#633）
 * 与旧的 GitHub 关闭关键词（Closes/Fixes/Resolves…）。正文随手引用的 #单号 仍不算。
 * #1116：仓里原先两份正则（本文件认「关联」，ready-queue-check 不认）收成这一份。 */
export function linkedIssueNumbers(text) {
  const found = [];
  const re = /(?:署名\s+issue\s*#?\s*|关联(?:\s*issue)?\s+#|(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#)(\d+)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const t = Number(m[1]);
    if (Number.isInteger(t) && !found.includes(t)) found.push(t);
  }
  return found;
}

function parseJsonOut(raw, what) {
  try { return { ok: true, value: JSON.parse(raw) }; }
  catch { return { ok: false, error: `${what} 返回非 JSON：${String(raw).slice(0, 120)}` }; }
}

function normalizeDispatchRepo(raw) {
  const parsed = parseOwnerNameRepo(raw);
  if (!parsed.ok || parsed.omitted) return '';
  return String(parsed.ownerName).toLowerCase();
}

function repoFromPrMeta(meta) {
  // 所属仓是目标/base 仓。headRepository 是 head 来源仓，fork PR 跟 --repo 比会误拒。
  // gh pr view 没有 baseRepository，URL 指向目标仓。
  const url = String((meta && meta.url) || '');
  const m = url.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:pull|issues)\b/i);
  return m ? normalizeDispatchRepo(m[1]) : '';
}

/** 只读一张 PR 自己的 label + 标题/正文（给署名 issue 发完工 comment 用）。不读 issue。 */
export function collectPrLabels({ pr, runGh } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'collectPrLabels 没给 PR 号' };
  if (typeof runGh !== 'function') {
    return { ok: false, unscanned: true, error: 'collectPrLabels 没拿到 gh 执行器（没查成，不许猜）' };
  }
  const view = runGh(['pr', 'view', n, '--json', 'title,body,labels,headRefName,url']);
  if (!view.ok) return { ok: false, unscanned: true, error: `gh pr view #${n} 失败：${view.error}` };
  const parsed = parseJsonOut(view.out, `gh pr view #${n}`);
  if (!parsed.ok) return { ok: false, unscanned: true, error: parsed.error };
  const meta = parsed.value;
  if (!meta || !Array.isArray(meta.labels)) {
    return { ok: false, unscanned: true, error: `gh pr view #${n} 缺 labels 数组（没查成，不许当扫完 0 条）` };
  }
  const labels = meta.labels.map(labelNameOf).filter(Boolean);
  const title = String(meta.title || '');
  const body = String(meta.body || '');
  return {
    ok: true,
    unscanned: false,
    labels,
    title,
    body,
    headRefName: String(meta.headRefName || ''),
    repo: repoFromPrMeta(meta) || null,
    refs: linkedIssueNumbers(`${title}\n${body}`),
  };
}

/**
 * 工人 job.dispatch：先按分支取最新一条（另一仓的完整记录不算这条链；
 * 缺 repo 的后写残缺仍是最新一条），再校验 repo/identity/model/reviewer。
 * 挑最新一条的规则不变——缺字段的残缺仍是最新一条，不回退旧的完整记录。
 *
 * 缺 repo / reviewer 是同一类历史缺口（#1118 才把这两项写进账本，#1116 之前一条都没有），
 * 所以按同一口径收下，都在返回值里说清来源：
 *   repoAssumed —— 账本没写仓，仓是按「没写别的仓」推的（推不出才是拒绝）。
 *   reviewerSource —— 'ledger' 账本写了 / 'pr-label' 账本没写、取 PR 自己的 reviewer/*。
 * 账本与 PR 标签都有且不一致时**不猜**：两条都是「派工那刻的决定」，证不出哪条对，报人工。
 * model 没有这种缺口（1017 条事件全带 model），缺它仍是拒绝，不许推。 */
export function pickWorkerDispatchByBranch(events, branch, repo, { reviewerHint } = {}) {
  const want = String(branch || '').trim();
  if (!want) return { ok: false, state: 'none', error: '没给分支名（没查成，不许猜）' };
  const wantRepo = normalizeDispatchRepo(repo);
  if (!wantRepo) {
    return { ok: false, state: 'unscanned', error: '没给仓（没查成，不许猜）' };
  }
  if (events == null || !Array.isArray(events)) {
    return { ok: false, state: 'unscanned', error: '账本事件列表没拿到（没查成，不许猜）' };
  }
  const keyed = [];
  for (const e of events) {
    if (!e || e.type !== 'job.dispatch') continue;
    if (String(e.branch || '').trim() !== want) continue;
    const eventRepo = normalizeDispatchRepo(e.repo);
    // 明确写了另一仓的，不是这条链。缺仓的后写残缺要留下来当最新一条校验。
    if (eventRepo && eventRepo !== wantRepo) continue;
    keyed.push(e);
  }
  if (keyed.length === 0) {
    return {
      ok: false,
      state: 'none',
      error: `账本没有仓 ${wantRepo} 分支 ${want} 的工人 job.dispatch——这不是派工链上的 PR，需人工打标`,
    };
  }
  const hit = keyed[keyed.length - 1];
  const hitRepo = normalizeDispatchRepo(hit.repo);
  // 缺 repo 的历史事件（#1116 之前）：按本仓收下，不拒。明确写别的仓的在上一步已被滤掉。
  if (hitRepo && hitRepo !== wantRepo) {
    return {
      ok: false,
      state: 'none',
      error: `仓 ${wantRepo} 分支 ${want} 最新 job.dispatch 仓是 ${hitRepo}——需人工打标`,
    };
  }
  if (hit.identity !== '工人') {
    return {
      ok: false,
      state: 'none',
      error: `仓 ${wantRepo} 分支 ${want} 最新 job.dispatch 缺 identity 或不是工人——需人工打标`,
    };
  }
  const model = String(hit.model || '').trim();
  if (!model) {
    return {
      ok: false,
      state: 'none',
      error: `仓 ${wantRepo} 分支 ${want} 最新工人 job.dispatch 缺 model——需人工打标`,
    };
  }
  // reviewer：账本写了就用账本的；没写（历史事件）退到调用方给的 PR 标签，两条都没有才拒。
  const hint = String(reviewerHint || '').trim();
  const fromLedger = String(hit.reviewer || '').trim();
  if (fromLedger && hint && fromLedger !== hint) {
    return {
      ok: false,
      state: 'conflict',
      error: `仓 ${wantRepo} 分支 ${want} 账本审官 ${fromLedger} 与 PR 标签 ${hint} 不一致`
        + '——两条都是派工那刻的决定，证不出哪条对，需人工打标',
    };
  }
  const reviewer = fromLedger || hint;
  if (!reviewer) {
    return {
      ok: false,
      state: 'none',
      error: `仓 ${wantRepo} 分支 ${want} 最新工人 job.dispatch 缺 reviewer，PR 上也没有 reviewer/*`
        + '——需人工打标',
    };
  }
  const role = String(hit.work_type || hit.role || '').trim();
  return {
    ok: true,
    state: 'one',
    event: hit,
    model,
    reviewer,
    role: role || DEFAULT_DISPATCH_TYPE,
    branch: want,
    repo: wantRepo,
    // 账本这条没写 repo，仓是按「没写别的仓」推的（历史事件）。调用方要能说清这一层。
    repoAssumed: !hitRepo,
    // 账本没写 reviewer，审官是按 PR 标签取的（历史事件）。'ledger' = 账本写的。
    reviewerSource: fromLedger ? 'ledger' : 'pr-label',
  };
}

/**
 * 仓 + PR head 分支 → 账本工人 dispatch → 把 model/* reviewer/* type/* 打到这张 PR。
 * 幂等：已有同名 label 不再加。缺完整记录 ⇒ 明确报「需人工打标」，不猜、不读 issue。
 * 缺 reviewer 不许只打 model/type 后报 ok。
 */
export function stampPrLabelsFromDispatch({ pr, runGh, events, ensureLabels, repo } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'stampPrLabelsFromDispatch 没给 PR 号' };
  if (typeof runGh !== 'function') {
    return { ok: false, unscanned: true, error: 'stampPrLabelsFromDispatch 没拿到 gh 执行器（没查成，不许猜）' };
  }
  const collected = collectPrLabels({ pr: n, runGh });
  if (!collected.ok) return collected;
  const branch = collected.headRefName;
  if (!branch) {
    return { ok: false, unscanned: true, error: `gh pr view #${n} 缺 headRefName（没查成，不许猜）` };
  }
  const wantRepo = normalizeDispatchRepo(repo) || collected.repo || '';
  if (!wantRepo) {
    return { ok: false, unscanned: true, error: 'stampPrLabelsFromDispatch 没给仓（没查成，不许猜）' };
  }
  if (collected.repo && collected.repo !== wantRepo) {
    return {
      ok: false,
      state: 'none',
      skipped: true,
      pr: n,
      branch,
      repo: wantRepo,
      error: `PR #${n} 在 ${collected.repo}，打标目标是 ${wantRepo}——需人工打标（不许跨仓套标）`,
    };
  }
  // reviewer 的历史缺口（#1118 前的账本没这项）用 PR 自己的 reviewer/* 补——PR 标签是审官
  // 选型的既有真相源（pickReviewer），不是从 issue 反推。没有标签才拒。
  // 多个（含同名重复）reviewer/* 一律 fail-closed：不许拿账本单值把歧义抹平。
  const hint = pickReviewer(collected.labels);
  if (!hint.ok && hint.state === 'many') {
    return {
      ok: false,
      state: 'many',
      skipped: false,
      pr: n,
      branch,
      repo: wantRepo,
      error: `${hint.error}——需人工打标`,
      labels: hint.labels,
    };
  }
  const picked = pickWorkerDispatchByBranch(events, branch, wantRepo, {
    reviewerHint: hint.ok ? hint.modelId : '',
  });
  if (!picked.ok) {
    return {
      ...picked,
      pr: n,
      branch,
      repo: wantRepo,
      skipped: picked.state === 'none',
      error: picked.error,
    };
  }
  const names = dispatchLabelNames({
    model: picked.model,
    role: picked.role,
    reviewer: picked.reviewer,
  });
  if (!names.some((name) => name.startsWith(REVIEWER_LABEL_PREFIX))) {
    return {
      ok: false,
      state: 'none',
      skipped: true,
      pr: n,
      branch,
      repo: wantRepo,
      error: `仓 ${wantRepo} 分支 ${branch} 打标缺 reviewer/*——需人工打标`,
    };
  }
  const existing = collected.labels;
  const add = names.filter((name) => !existing.includes(name));
  const skipped = names.filter((name) => existing.includes(name)).map((name) => ({ name, reason: 'already' }));
  if (add.length) {
    if (typeof ensureLabels === 'function') {
      const ensured = ensureLabels({ names: add, runGh });
      if (!ensured || !ensured.ok) {
        return {
          ok: false,
          unscanned: !!(ensured && ensured.unscanned),
          error: (ensured && ensured.error) || 'ensureRepoLabels 失败',
          pr: n,
          branch,
          repo: wantRepo,
        };
      }
    }
    const flags = [];
    for (const name of add) flags.push('--add-label', name);
    const edit = runGh(['pr', 'edit', n, ...flags]);
    if (!edit.ok) return { ok: false, error: `PR #${n} 打 label 失败：${edit.error}`, pr: n, branch, repo: wantRepo };
  }
  return {
    ok: true,
    pr: n,
    branch,
    repo: wantRepo,
    names,
    add,
    skipped,
    labels: names,
    model: picked.model,
    reviewer: picked.reviewer,
    role: picked.role,
    refs: collected.refs,
    repoAssumed: picked.repoAssumed === true,
    reviewerSource: picked.reviewerSource,
  };
}

export function resolveWorkerFromPr({ pr, runGh, model } = {}) {
  const explicit = model == null ? '' : String(model).trim();
  const collected = collectPrLabels({ pr, runGh });
  if (explicit) {
    if (!collected.ok && collected.unscanned) return collected;
    return {
      ok: true,
      source: 'flag',
      modelId: explicit,
      refs: collected.ok ? collected.refs : [],
      labels: collected.ok ? collected.labels : [],
    };
  }
  if (!collected.ok) return collected;
  const picked = requireWorkerModel(collected.labels);
  if (picked.ok) return { ...picked, source: 'label', refs: collected.refs, labels: collected.labels };
  if (picked.state === 'none') {
    return {
      ...picked,
      source: 'label',
      error: `${picked.error}——PR 上没有 model/*，需人工打标（不读 issue、不猜家族）`,
      refs: collected.refs,
      labels: collected.labels,
    };
  }
  return { ...picked, source: 'label', refs: collected.refs, labels: collected.labels };
}

/** 只读 PR 自己的 label，再走 pickReviewer。传了 explicit 就用它。
 * #895：显式 --reviewer 也要把 PR 的 label/refs 一起收回来——快马单没有 reviewer/* label
 * （没走派单流程写不上），从前 explicit 分支直接返回、refs 为空，调用方（planWorkerDone）拿不到
 * 单号与 model/* 就照旧拒，于是「--reviewer 也救不了」。gh 本身没查成（unscanned）仍照旧拒。
 * #1116：不再读 issue label、不从宿主前缀猜家族。 */
export function resolveReviewerFromPr({ pr, reviewer, runGh } = {}) {
  const explicit = reviewer == null ? '' : String(reviewer).trim();
  if (explicit) {
    const collected = collectPrLabels({ pr, runGh });
    if (!collected.ok && collected.unscanned) return collected;
    return {
      ok: true,
      source: 'flag',
      modelId: explicit,
      refs: collected.ok ? collected.refs : [],
      labels: collected.ok ? collected.labels : [],
    };
  }
  const collected = collectPrLabels({ pr, runGh });
  if (!collected.ok) return collected;
  const picked = pickReviewer(collected.labels);
  if (!picked.ok) {
    const extra = picked.state === 'none'
      ? '——PR 上没有 reviewer/*，需人工打标（不读 issue、不猜家族）'
      : '';
    return { ...picked, source: 'label', refs: collected.refs, labels: collected.labels, error: `${picked.error}${extra}` };
  }
  return { ...picked, source: 'label', refs: collected.refs, labels: collected.labels };
}

/** 读 PR 上的 review 条数。没查成和「0 条」分开。 */
export function listPrReviews({ pr, runGh } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'listPrReviews 没给 PR 号' };
  if (typeof runGh !== 'function') {
    return { ok: false, unscanned: true, error: 'listPrReviews 没拿到 gh 执行器（没查成，不许猜）' };
  }
  const view = runGh(['pr', 'view', n, '--json', 'reviews']);
  if (!view.ok) return { ok: false, unscanned: true, error: `gh pr view #${n} reviews 失败：${view.error}` };
  const parsed = parseJsonOut(view.out, `gh pr view #${n} reviews`);
  if (!parsed.ok) return { ok: false, unscanned: true, error: parsed.error };
  if (!parsed.value || !Array.isArray(parsed.value.reviews)) {
    return { ok: false, unscanned: true, error: `gh pr view #${n} 缺 reviews 数组（没查成，不许当 0 条）` };
  }
  return { ok: true, reviews: parsed.value.reviews, count: parsed.value.reviews.length };
}

/** 完工计划：按已有 review 条数分首审 / 返工。#1125：首审只入队。 */
export function planWorkerDone({ pr, body, runGh, reviewer } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'worker-done 要 --pr' };
  // #895：快马单没有 reviewer/* label，允许显式 --reviewer 指名审官（label 优先级不变：不传才自读）。
  const resolved = resolveReviewerFromPr({ pr: n, reviewer, runGh });
  if (!resolved.ok) return resolved;
  const issue = Array.isArray(resolved.refs) && resolved.refs[0] ? resolved.refs[0] : null;
  if (!issue) {
    return { ok: false, unscanned: false, error: `PR #${n} 没有署名单号，完工 comment 没处可发` };
  }
  const listed = listPrReviews({ pr: n, runGh });
  if (!listed.ok) return listed;
  const round = listed.count > 0 ? 'rework' : 'first';
  const prefix = round === 'rework' ? '返工完成' : '完工';
  const custom = body == null ? '' : String(body);
  if (custom && !new RegExp(`^${prefix}`).test(custom)) {
    return { ok: false, unscanned: false, error: `worker-done --body 首行必须以「${prefix}」开头（${round === 'rework' ? '已有 review，这是返工轮' : '流转器只认这个'}）` };
  }
  const shouldCreate = round === 'first';
  // 首审起审官要过同厂闸，工人型号必须落在 PR 自己的 model/* 上。
  // 没有就不猜家族、不读 issue（#1116）。返工轮不起第二个审官，工人型号缺了也不挡交卷。
  const workerPick = shouldCreate
    ? resolveWorkerFromPr({ pr: n, runGh })
    : pickModel(resolved.labels || []);
  if (shouldCreate && !workerPick.ok) return { ...workerPick, pr: n, issue, reviewer: resolved.modelId };
  const comment = custom || (round === 'rework'
    ? [`返工完成：PR #${n}`, '', `自读选型：${resolved.modelId}`, '已有 review，不起第二个审官。'].join('\n')
    : [`完工：PR #${n}`, '', `自读选型：${resolved.modelId}`, '首审已入待审队列，由指挥官按在役审官数拉取（#1125）。'].join('\n'));
  return {
    ok: true,
    wired: true,
    round,
    shouldCreate,
    reviewCount: listed.count,
    pr: n,
    issue,
    reviewer: resolved.modelId,
    reviewerSource: resolved.source,
    workerModel: workerPick.ok ? workerPick.modelId : null,
    workerSource: workerPick.ok ? (workerPick.source || null) : null,
    comment,
    reviewerCreate: shouldCreate
      ? {
        verb: 'reviewer-create',
        pr: n,
        args: ['--pr', n],
        invoked: false,
        reason: '首审：入待审队列，由指挥官按在役审官数拉取（#1125）',
      }
      : {
        verb: 'reviewer-create',
        pr: n,
        invoked: false,
        skipped: true,
        reason: '已有 review，返工轮不起第二个审官',
      },
  };
}

/**
 * 士兵→审官 完工/返工投递决策。无 IO：投递走传入的 deliver。
 * 首审、返工都必须送到审官 dispatch；缺 id 或投失败一律 ok:false（fail-visible）。
 */
export function completeWorkerDoneNotify({
  round,
  pr,
  comment,
  reviewerDispatchId,
  shouldCreate,
  deliver,
  orca,
} = {}) {
  const prefix = round === 'rework' ? '返工完成' : '完工';
  const id = reviewerDispatchId == null ? '' : String(reviewerDispatchId).trim();
  if (!id) {
    if (round === 'rework') {
      return { ok: false, notified: null, error: '返工找不到现有审官 dispatch，返工完成消息没处可投（没查成）' };
    }
    if (shouldCreate) {
      return { ok: false, notified: null, error: 'reviewer-create 没返回 reviewerDispatchId，完工消息没处可投（没查成）' };
    }
    return { ok: false, notified: null, error: `${prefix}找不到审官 dispatch，完工消息没处可投（没查成）` };
  }
  if (typeof deliver !== 'function') {
    return { ok: false, notified: null, error: 'completeWorkerDoneNotify 没拿到投递器（没查成）' };
  }
  const notified = deliver({
    to: `dispatch:${id}`,
    subject: `${prefix}：PR #${pr}`,
    body: comment,
    hop: '士兵→审官',
    orca,
  });
  if (!notified || !notified.ok) {
    return {
      ok: false,
      notified: notified || null,
      error: `${prefix}通知没送到审官：${notified && notified.error ? notified.error : '投递器没返回'}`,
    };
  }
  return { ok: true, notified: { ...notified, dispatchId: id } };
}

/**
 * 返工/首审投递目标：只认新建或复用返回的新 id。
 * #552：复用失败禁止回退已有 dispatch（可能已结算，信箱 inspect-only）。
 */
export function pickWorkerDoneDispatchId({ create, reused, existingDispatchId } = {}) {
  const fromCreate = create && create.reviewerDispatchId ? String(create.reviewerDispatchId).trim() : '';
  if (fromCreate) return { ok: true, reviewerDispatchId: fromCreate, source: 'create' };
  const fromReuse = reused && reused.reviewerDispatchId ? String(reused.reviewerDispatchId).trim() : '';
  if (fromReuse) return { ok: true, reviewerDispatchId: fromReuse, source: 'reuse' };
  if (reused && reused.reuseFailed) {
    return {
      ok: false, reviewerDispatchId: null, source: null,
      error: '复用审官失败，禁止回退已有 dispatch（可能已结算、信箱 inspect-only）。应重试 worker-start --terminal 开新 Dispatch，或升级给帅。',
    };
  }
  const existing = existingDispatchId == null ? '' : String(existingDispatchId).trim();
  if (existing) {
    return {
      ok: false, reviewerDispatchId: null, source: 'existing-blocked',
      error: `禁止回退已有审官 dispatch ${existing}（#552：可能已结算）。第二轮复审必须新 Dispatch。`,
    };
  }
  return { ok: false, reviewerDispatchId: null, source: null, error: '没有审官 dispatch 可投' };
}
