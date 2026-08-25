// scripts/lib/dispatch/worker-done.mjs —— 完工结算 + label 选型域（#762 拆分）
//
// 改这段前必须知道：worker-done 按已有 review 条数分首审 / 返工，首审才建审官。
// label 记「决定」：dispatch 成功时把 model/<模型> type/<角色> reviewer/<审官>
// 打到目标 issue；工人完工时用 pickReviewer / requireWorkerModel 复算。
// 三态必须分得开：查到一个 / 扫完没有 / 没查成——后两者都拒，不许猜。

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

export function collectIssueLabelsFromPr({ pr, runGh } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'collectIssueLabelsFromPr 没给 PR 号' };
  if (typeof runGh !== 'function') {
    return { ok: false, unscanned: true, error: 'collectIssueLabelsFromPr 没拿到 gh 执行器（没查成，不许猜）' };
  }
  const view = runGh(['pr', 'view', n, '--json', 'title,body']);
  if (!view.ok) return { ok: false, unscanned: true, error: `gh pr view #${n} 失败：${view.error}` };
  let meta;
  try { meta = JSON.parse(view.out); }
  catch { return { ok: false, unscanned: true, error: `gh pr view #${n} 返回非 JSON：${String(view.out).slice(0, 120)}` }; }
  const refs = linkedIssueNumbers(`${meta.title || ''}\n${meta.body || ''}`);
  if (!refs.length) {
    return { ok: false, unscanned: false, error: `PR #${n} 没有署名单号，读不到 issue label（没查成，不许猜）` };
  }
  const collected = [];
  for (const issueNum of refs) {
    const iv = runGh(['issue', 'view', String(issueNum), '--json', 'labels']);
    if (!iv.ok) return { ok: false, unscanned: true, error: `gh issue view #${issueNum} 失败：${iv.error}` };
    let parsed;
    try { parsed = JSON.parse(iv.out); }
    catch { return { ok: false, unscanned: true, error: `gh issue view #${issueNum} 返回非 JSON` }; }
    const names = (Array.isArray(parsed?.labels) ? parsed.labels : []).map(labelNameOf).filter(Boolean);
    collected.push(...names);
  }
  return { ok: true, unscanned: false, refs, labels: collected };
}

export function resolveWorkerFromPr({ pr, runGh } = {}) {
  const collected = collectIssueLabelsFromPr({ pr, runGh });
  if (!collected.ok) return collected;
  const picked = requireWorkerModel(collected.labels);
  if (!picked.ok) return { ...picked, source: 'label', refs: collected.refs, labels: collected.labels };
  return { ...picked, source: 'label', refs: collected.refs, labels: collected.labels };
}

/** 读 PR 署名 issue 上的 label，再走 pickReviewer。传了 explicit 就用它（工人路径不传）。 */
export function resolveReviewerFromPr({ pr, reviewer, runGh } = {}) {
  if (reviewer && String(reviewer).trim()) {
    return { ok: true, source: 'flag', modelId: String(reviewer).trim() };
  }
  const collected = collectIssueLabelsFromPr({ pr, runGh });
  if (!collected.ok) {
    if (!collected.unscanned && /没有署名单号/.test(collected.error || '')) {
      const n = String(pr ?? '').trim();
      return { ...collected, error: `PR #${n} 没有署名单号，读不到 reviewer/*（没查成，不许猜）` };
    }
    return collected;
  }
  const picked = pickReviewer(collected.labels);
  if (!picked.ok) return { ...picked, source: 'label', refs: collected.refs, labels: collected.labels };
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
  let parsed;
  try { parsed = JSON.parse(view.out); }
  catch { return { ok: false, unscanned: true, error: `gh pr view #${n} reviews 返回非 JSON` }; }
  if (!parsed || !Array.isArray(parsed.reviews)) {
    return { ok: false, unscanned: true, error: `gh pr view #${n} 缺 reviews 数组（没查成，不许当 0 条）` };
  }
  return { ok: true, reviews: parsed.reviews, count: parsed.reviews.length };
}

/** 完工计划：按已有 review 条数分首审 / 返工。首审才建审官。 */
export function planWorkerDone({ pr, body, runGh } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'worker-done 要 --pr' };
  const resolved = resolveReviewerFromPr({ pr: n, runGh });
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
  const workerPick = shouldCreate
    ? requireWorkerModel(resolved.labels)
    : pickModel(resolved.labels || []);
  if (shouldCreate && !workerPick.ok) return { ...workerPick, pr: n, issue, reviewer: resolved.modelId };
  const comment = custom || (round === 'rework'
    ? [`返工完成：PR #${n}`, '', `自读选型：${resolved.modelId}`, '已有 review，不起第二个审官。'].join('\n')
    : [`完工：PR #${n}`, '', `自读选型：${resolved.modelId}`, '将调 reviewer-create 按需起审官。'].join('\n'));
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
    comment,
    reviewerCreate: shouldCreate
      ? {
        verb: 'reviewer-create',
        pr: n,
        args: ['--pr', n],
        invoked: false,
        reason: '首审：真调 reviewer-create（自读选型、建树、起终端、注入）',
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

/** PR 正文/标题里的署名单号：认「署名 issue #N」（#657）、「关联 issue #N」（#633）
 * 与旧的 GitHub 关闭关键词（Closes/Fixes/Resolves…）。正文随手引用的 #单号 仍不算。 */
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
