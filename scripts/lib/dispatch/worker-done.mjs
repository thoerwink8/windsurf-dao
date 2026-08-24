// scripts/lib/dispatch/worker-done.mjs —— 完工结算域（#768 从 dao-cmd.mjs 拆出，对外 API 不变）
import { orcaErrorText } from '../orca-error.mjs';
import {
  listPrReviews, pickModel, requireWorkerModel, resolveReviewerFromPr,
} from './reviewer.mjs';

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
/** #551：worker_done 是 exact-Dispatch 结算口，不是普通投递。 */

export function planWorkerDoneSend({ type, to, outcome, taskId, dispatchId, from, dispatchCapability } = {}) {
  const t = type == null ? '' : String(type).trim();
  if (t !== 'worker_done') {
    return { ok: true, kind: 'notify', settle: false };
  }
  const missing = [];
  if (!String(taskId || '').trim()) missing.push('task-id');
  if (!String(dispatchId || '').trim()) missing.push('dispatch-id');
  const oc = String(outcome || '').trim();
  if (oc !== 'succeeded' && oc !== 'failed') missing.push('outcome');
  if (missing.length) {
    return {
      ok: false, kind: 'settle', settled: false, unscanned: false,
      error: `未结算：worker_done 缺 ${missing.join('/')}（exact-Dispatch 信号必须带身份，不能省略）`,
    };
  }
  const dest = to == null ? '' : String(to).trim();
  if (dest) {
    return {
      ok: false, kind: 'settle', settled: false, unscanned: false,
      error: '未结算：worker_done 不能带 --to（exact-Dispatch 信号须省略 --to，走活动 Dispatch 的 Run 信箱）',
    };
  }
  return {
    ok: true, kind: 'settle', settle: true, omitTo: true,
    taskId: String(taskId).trim(),
    dispatchId: String(dispatchId).trim(),
    outcome: oc,
    from: from ? String(from).trim() : null,
    dispatchCapability: dispatchCapability ? String(dispatchCapability).trim() : null,
  };
}
/**
 * 读 worker-show 判断 Dispatch 是否真的 completed。
 * 没查成（缺信封/缺 status）和「查到了但未 completed」必须分开。
 */
export function readDispatchSettlement(json) {
  if (!json || typeof json !== 'object') {
    return { ok: false, unscanned: true, settled: false, error: 'worker-show 返回空（没查成，不许当未结算）' };
  }
  const dispatch = json.result && json.result.dispatch;
  if (!dispatch || typeof dispatch !== 'object') {
    return { ok: false, unscanned: true, settled: false, error: 'worker-show 没有 result.dispatch（没查成，不许当未结算）' };
  }
  const status = dispatch.status == null ? null : String(dispatch.status);
  const workerState = json.result?.worker?.state == null ? null : String(json.result.worker.state);
  if (status == null) {
    return {
      ok: false, unscanned: true, settled: false,
      error: 'worker-show 查到了但没有 dispatch.status（没查成，不许当未结算）',
      dispatchId: dispatch.id || null, workerState,
    };
  }
  const settled = String(status).toLowerCase() === 'completed';
  return {
    ok: true, unscanned: false, settled,
    status, workerState,
    dispatchId: dispatch.id || null,
    taskId: dispatch.task_id || null,
    assigneeHandle: dispatch.assignee_handle || null,
    completedAt: dispatch.completed_at || null,
  };
}

export function isWrongPaneWorkerDoneError(error) {
  const text = orcaErrorText(error);
  return /not the Dispatch pane|not_dispatch_pane|caller is not the Dispatch|assignee|exact-Dispatch|stable pane|pane identity/i.test(text);
}
