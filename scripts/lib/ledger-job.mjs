// scripts/lib/ledger-job.mjs —— 接活账本的调用封装（#581）
//
// 写入仍走 event-writer.writeEvent，不新造写入器。这里只拼 payload、
// 定 job_id、把「已有同 job 事件」收成幂等 skip。
// 工人 job_id = gh-pr-N（与回填同口径）；审官 job_id = gh-pr-N-review
// （一 job 只能一条 job.dispatch / job.closed）。
// 默认落点 = 本机 ~/.dao/ledger/events/（ledger 本机化拍板：事件不进 git），
// 首次使用把仓内 ledger/events 的已合并历史事件种子过来（幂等，同名跳过，见 ledger-home.mjs）。
// 测试或显式覆盖走 eventsDir / LEDGER_EVENTS_DIR（覆盖时不播种子）。

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeEvent, nextSeq } from './event-writer.mjs';
import { ensureLocalLedger } from './ledger-home.mjs';
import { hashOf } from './dianjiangtai-core.mjs';
import { toBeijingIso } from './dianjiangtai-backfill.mjs';
import { normalizeReviewState } from './review-state.mjs';

const DEFAULT_ROOT = resolve(import.meta.dirname, '../..');

function defaultGit(args, { cwd } = {}) {
  const r = spawnSync('git', args, {
    encoding: 'utf8',
    cwd,
    windowsHide: true,
    timeout: 30000,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return {
      ok: false,
      error: String(r.error?.message || r.stderr || r.stdout || `git exit ${r.status}`).trim(),
    };
  }
  return { ok: true, out: String(r.stdout || '').trim() };
}

/** 主树根 = git-common-dir 的上一级。工人树里调也必须落到这里。 */
export function resolveMainWorktreeRoot({ from = DEFAULT_ROOT, git } = {}) {
  const run = git || defaultGit;
  const r = run(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: from });
  if (!r.ok || !r.out) {
    return { ok: false, error: r.error || 'git-common-dir 为空' };
  }
  const gitDir = String(r.out).replace(/[/\\]+$/, '');
  if (!/\.git$/i.test(gitDir)) {
    return { ok: false, error: `git-common-dir 不是 .git：${gitDir}` };
  }
  return { ok: true, root: resolve(gitDir, '..'), gitDir };
}

export function workerJobId(prNumber) {
  return `gh-pr-${prNumber}`;
}

export function reviewerJobId(prNumber) {
  return `gh-pr-${prNumber}-review`;
}

export function dispatchJobId(dispatchId) {
  return `dispatch-${dispatchId}`;
}

export function beijingIsoFrom(input) {
  if (input instanceof Date) return toBeijingIso(input.toISOString());
  return toBeijingIso(input);
}

export function isDuplicateWriteError(err) {
  return /已存在|已入账|已有/.test(String(err && err.message ? err.message : err));
}

export function loadLedgerContext({ root = DEFAULT_ROOT, eventsDir, schemaPath, machine, home, env } = {}) {
  const explicit = eventsDir || (env || process.env).LEDGER_EVENTS_DIR || '';
  let dir;
  if (explicit) {
    dir = resolve(root, explicit);
  } else {
    dir = ensureLocalLedger({ root, home, env: env || process.env }).dir;
  }
  const schemaFile = resolve(root, schemaPath || 'schemas/events.schema.json');
  if (!existsSync(schemaFile)) throw new Error(`事件 schema 不在：${schemaFile}`);
  const schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
  return { dir, schema, machine: machine || process.env.LEDGER_MACHINE || os.hostname(), root };
}

export function isScopeOverride(event) {
  return Boolean(event && event.type === 'job.override' && event.override_kind === 'scope');
}

/** 收集某单的范围追加事件（按 job_id / pr / issue，不 grep 数字）。 */
export function scopeOverridesFor(events, { jobId, prNumber, issueNumber } = {}) {
  const ids = new Set();
  if (jobId) ids.add(String(jobId));
  if (prNumber != null) {
    ids.add(workerJobId(prNumber));
    ids.add(reviewerJobId(prNumber));
  }
  return (events || []).filter(e => {
    if (!isScopeOverride(e)) return false;
    if (e.job_id && ids.has(String(e.job_id))) return true;
    if (prNumber != null && Number(e.pr_number) === Number(prNumber)) return true;
    if (issueNumber != null && (Number(e.issue_number) === Number(issueNumber) || Number(e.issue) === Number(issueNumber))) {
      return true;
    }
    return false;
  });
}

function triggeredByOf(marshalRounds, workerRework) {
  if (marshalRounds > 0 && workerRework > 0) return '混合';
  if (marshalRounds > 0) return '帅';
  return '审官';
}

/**
 * 从 GitHub review 状态汇总轮次 / 红项。
 * opts.overrides：该单 job.override(scope) 列表——有则按事件算帅轮次，不再看 review 序列。
 * opts.unscanned：reviews/账本没查成，三态第三档。
 * 无 override 时退回 sawGreen 反推，并标 attributionSource=inferred（红之后追加会低估）。
 */
function reviewColor(rv) {
  const state = normalizeReviewState(rv);
  if (state === 'APPROVED') return 'green';
  if (state === 'CHANGES_REQUESTED') return 'red';
  const body = String(rv && rv.body || '');
  if (/绿/.test(body) && !/红\s*\d+\s*项/.test(body)) return 'green';
  if (/红\s*\d+\s*项/.test(body)) return 'red';
  return null;
}

export function verdictStatsFromReviews(reviews, opts = {}) {
  if (opts.unscanned) {
    return {
      verdictRounds: null,
      reviewerRounds: null,
      marshalRounds: 0,
      redFlags: null,
      workerRework: null,
      triggeredBy: null,
      attributionSource: 'unscanned',
      attributionNote: opts.unscannedError || 'reviews 没查成',
      inferredMayUnderestimate: false,
    };
  }

  let reviewerRounds = 0;
  let inferredMarshal = 0;
  let maxRed = null;
  let sawGreen = false;
  let lastColor = null;
  let redAfterRed = false;
  for (const rv of reviews || []) {
    const color = reviewColor(rv);
    if (!color) continue;
    if (color === 'red') maxRed = Math.max(maxRed ?? 0, 1);
    if (color === 'red' && lastColor === 'red') redAfterRed = true;
    lastColor = color;
    if (sawGreen) {
      inferredMarshal += 1;
      continue;
    }
    reviewerRounds += 1;
    if (color === 'green') sawGreen = true;
  }
  const inferredTotal = reviewerRounds + inferredMarshal;
  const saw = inferredTotal > 0;
  const inferredWorker = reviewerRounds === 0 ? null : Math.max(0, reviewerRounds - 1);

  const overrides = Array.isArray(opts.overrides) ? opts.overrides.filter(isScopeOverride) : [];
  if (overrides.length > 0) {
    const marshalRounds = overrides.length;
    const total = saw ? inferredTotal : null;
    const workerRework = total == null ? null : Math.max(0, total - 1 - marshalRounds);
    return {
      verdictRounds: total,
      reviewerRounds: total == null ? null : Math.max(0, total - marshalRounds),
      marshalRounds,
      redFlags: saw ? (maxRed ?? 0) : null,
      workerRework,
      triggeredBy: !saw ? null : triggeredByOf(marshalRounds, workerRework || 0),
      attributionSource: 'event',
      attributionNote: '按 job.override 事件归因',
      inferredMayUnderestimate: false,
    };
  }

  return {
    verdictRounds: saw ? inferredTotal : null,
    reviewerRounds: saw ? reviewerRounds : null,
    marshalRounds: inferredMarshal,
    redFlags: saw ? (maxRed ?? 0) : null,
    workerRework: inferredWorker,
    triggeredBy: !saw ? null : triggeredByOf(inferredMarshal, inferredWorker || 0),
    attributionSource: saw ? 'inferred' : 'unscanned',
    attributionNote: saw
      ? (redAfterRed
        ? '归因来自反推，可能低估帅的轮次（红之后追加这一类反推覆盖不到）'
        : '归因来自反推，可能低估帅的轮次')
      : '无 GitHub 判别态 review（没查成）',
    inferredMayUnderestimate: Boolean(saw),
  };
}

export function describeAttribution(stats) {
  const src = stats && stats.attributionSource;
  if (src === 'event') return '按事件归因';
  if (src === 'inferred') return stats.attributionNote || '按反推归因，可能低估帅的轮次';
  return (stats && stats.attributionNote) || '归因没查成';
}

export function writeJobDispatch({
  dir, ts, machine, schema, jobId, model, identity, workType,
  modelVersion, terminal, priceSnapshot, decisionId, prNumber, extra = {},
} = {}) {
  if (!jobId) return { ok: false, skipped: false, error: 'job.dispatch 缺 job_id' };
  if (!model) return { ok: false, skipped: false, error: 'job.dispatch 缺 model' };
  if (!ts) return { ok: false, skipped: false, error: 'job.dispatch 缺 ts' };
  try {
    const seq = nextSeq(dir, machine);
    const w = writeEvent({
      dir,
      type: 'job.dispatch',
      ts,
      machine,
      seq,
      schema,
      payload: {
        job_id: jobId,
        model,
        identity,
        work_type: workType,
        model_version: modelVersion ?? String(model),
        terminal: terminal ?? 'unknown',
        price_snapshot: priceSnapshot ?? { source: 'live', note: '派工时刻空快照' },
        decision_id: decisionId ?? hashOf({ source: 'live', job_id: jobId, model, identity, ts }),
        ...(prNumber != null ? { pr_number: prNumber } : {}),
        ...extra,
      },
    });
    return { ok: true, skipped: false, path: w.path, event: w.event };
  } catch (e) {
    if (isDuplicateWriteError(e)) return { ok: true, skipped: true, error: String(e.message || e) };
    return { ok: false, skipped: false, error: String(e.message || e) };
  }
}

export function writeJobOverride({
  dir, ts, machine, schema, jobId, model, identity, workType,
  triggeredBy, why, prNumber, issueNumber, extra = {},
} = {}) {
  if (!jobId) return { ok: false, skipped: false, error: 'job.override 缺 job_id' };
  if (!model) return { ok: false, skipped: false, error: 'job.override 缺 model' };
  if (!ts) return { ok: false, skipped: false, error: 'job.override 缺 ts' };
  if (!why || !String(why).trim()) return { ok: false, skipped: false, error: 'job.override 缺 why' };
  try {
    const seq = nextSeq(dir, machine);
    const w = writeEvent({
      dir,
      type: 'job.override',
      ts,
      machine,
      seq,
      schema,
      payload: {
        job_id: jobId,
        model,
        identity: identity || '帅',
        work_type: workType || '写码',
        override_kind: 'scope',
        triggered_by: triggeredBy || '帅',
        why: String(why).trim(),
        ...(prNumber != null ? { pr_number: prNumber } : {}),
        ...(issueNumber != null ? { issue_number: issueNumber } : {}),
        ...extra,
      },
    });
    return { ok: true, skipped: false, path: w.path, event: w.event };
  } catch (e) {
    if (isDuplicateWriteError(e)) return { ok: true, skipped: true, error: String(e.message || e) };
    return { ok: false, skipped: false, error: String(e.message || e) };
  }
}

export function writeJobHandoff({
  dir, ts, machine, schema, jobId, fromModel, toModel, reason, extra = {},
} = {}) {
  if (!jobId) return { ok: false, skipped: false, error: 'job.handoff 缺 job_id' };
  if (!ts) return { ok: false, skipped: false, error: 'job.handoff 缺 ts' };
  try {
    const seq = nextSeq(dir, machine);
    const w = writeEvent({
      dir,
      type: 'job.handoff',
      ts,
      machine,
      seq,
      schema,
      payload: {
        job_id: jobId,
        from_model: fromModel || 'unknown',
        to_model: toModel || fromModel || 'unknown',
        reason: reason || 'other',
        ...extra,
      },
    });
    return { ok: true, skipped: false, path: w.path, event: w.event };
  } catch (e) {
    if (isDuplicateWriteError(e)) return { ok: true, skipped: true, error: String(e.message || e) };
    return { ok: false, skipped: false, error: String(e.message || e) };
  }
}

function alreadyRenamed(events, fromId, toId) {
  return (events || []).some(e => (
    e && e.type === 'job.handoff' && e.kind === 'job_id_rename'
    && e.from_job_id === fromId && e.to_job_id === toId
  ));
}

/** 把 dispatch-<id> 接到 gh-pr-N / gh-pr-N-review，不另写一条假 closed。 */
export function linkAliasesToSuccessor({
  ctx, ts, events, successorJobId, issueNumber, prNumber, model, identity,
} = {}) {
  const out = [];
  if (!successorJobId) return out;
  const wantIdentity = identity || null;
  const seen = new Set();
  for (const e of events || []) {
    if (!e || e.type !== 'job.dispatch' || !e.job_id) continue;
    if (!String(e.job_id).startsWith('dispatch-')) continue;
    if (e.job_id === successorJobId) continue;
    if (wantIdentity && e.identity && e.identity !== wantIdentity) continue;
    const issueHit = issueNumber != null && (
      Number(e.issue_number) === Number(issueNumber) || Number(e.issue) === Number(issueNumber)
    );
    const prHit = prNumber != null && e.pr_number != null && Number(e.pr_number) === Number(prNumber);
    if (!issueHit && !prHit) continue;
    if (seen.has(e.job_id) || alreadyRenamed(events, e.job_id, successorJobId)) continue;
    seen.add(e.job_id);
    out.push(writeJobHandoff({
      ...ctx,
      ts,
      jobId: e.job_id,
      fromModel: e.model || model || 'unknown',
      toModel: model || e.model || 'unknown',
      reason: 'other',
      extra: {
        kind: 'job_id_rename',
        from_job_id: e.job_id,
        to_job_id: successorJobId,
        ...(prNumber != null ? { pr_number: prNumber } : {}),
        ...(issueNumber != null ? { issue_number: issueNumber } : {}),
      },
    }));
  }
  return out;
}

export function writeJobClosed({
  dir, ts, machine, schema, jobId, success, rework, mergedBy,
  prNumber, redFlags, verdictRounds, workerRework, marshalRounds, triggeredBy,
  attributionSource, attributionNote,
  extra = {},
} = {}) {
  if (!jobId) return { ok: false, skipped: false, error: 'job.closed 缺 job_id' };
  if (!ts) return { ok: false, skipped: false, error: 'job.closed 缺 ts' };
  try {
    const seq = nextSeq(dir, machine);
    const w = writeEvent({
      dir,
      type: 'job.closed',
      ts,
      machine,
      seq,
      schema,
      payload: {
        job_id: jobId,
        success: Boolean(success),
        rework: Boolean(rework),
        usd_cash: extra.usd_cash ?? 0,
        usd_economic: extra.usd_economic ?? 0,
        merged_by: mergedBy ?? 'unknown',
        ...(prNumber != null ? { pr_number: prNumber } : {}),
        ...(redFlags !== undefined ? { red_flags: redFlags } : {}),
        ...(verdictRounds !== undefined ? { verdict_rounds: verdictRounds } : {}),
        ...(workerRework !== undefined ? { worker_rework: workerRework } : {}),
        ...(marshalRounds !== undefined ? { marshal_rounds: marshalRounds } : {}),
        ...(triggeredBy ? { triggered_by: triggeredBy } : {}),
        ...(attributionSource ? { attribution_source: attributionSource } : {}),
        ...(attributionNote ? { attribution_note: attributionNote } : {}),
        ...Object.fromEntries(Object.entries(extra).filter(([k]) => !['usd_cash', 'usd_economic'].includes(k))),
      },
    });
    return { ok: true, skipped: false, path: w.path, event: w.event };
  } catch (e) {
    if (isDuplicateWriteError(e)) return { ok: true, skipped: true, error: String(e.message || e) };
    return { ok: false, skipped: false, error: String(e.message || e) };
  }
}

export function recordPair({ ctx, ts, source, worker, reviewer }) {
  const out = { worker: null, reviewer: null };
  if (worker && worker.model) {
    out.worker = writeJobDispatch({
      ...ctx,
      ts,
      jobId: worker.jobId,
      model: worker.model,
      identity: worker.identity || '工人',
      workType: worker.workType || '写码',
      modelVersion: worker.modelVersion,
      terminal: worker.terminal,
      decisionId: hashOf({ source, side: 'worker', job_id: worker.jobId, model: worker.model, ts }),
      prNumber: worker.prNumber,
      extra: { source, ...(worker.extra || {}) },
    });
  }
  if (reviewer && reviewer.model) {
    out.reviewer = writeJobDispatch({
      ...ctx,
      ts,
      jobId: reviewer.jobId,
      model: reviewer.model,
      identity: reviewer.identity || '审官',
      workType: reviewer.workType || '审查',
      modelVersion: reviewer.modelVersion,
      terminal: reviewer.terminal,
      decisionId: hashOf({ source, side: 'reviewer', job_id: reviewer.jobId, model: reviewer.model, ts }),
      prNumber: reviewer.prNumber,
      extra: { source, ...(reviewer.extra || {}) },
    });
  }
  return out;
}

/** 给测试与调用方拼路径用；不读事件内容（读事件是检查方自己的事）。 */
export function eventPathHint(dir, machine) {
  return join(dir, `*-${machine}.json`);
}

/** 给 amend 找所属 job：优先 --pr 的 gh-pr-N，否则 issue 对上的工人 dispatch。 */
export function resolveAmendTarget({ events, issue, pr } = {}) {
  const prNumber = pr != null && String(pr).trim() !== '' ? Number(pr) : null;
  const issueNumber = issue != null && String(issue).trim() !== '' ? Number(issue) : null;
  if (prNumber != null && !Number.isInteger(prNumber)) {
    return { ok: false, error: `--pr 不是正整数: ${pr}` };
  }
  if (issueNumber != null && !Number.isInteger(issueNumber)) {
    return { ok: false, error: `--issue 不是正整数: ${issue}` };
  }
  if (prNumber == null && issueNumber == null) {
    return { ok: false, error: 'amend 要 --issue <号> 或 --pr <号>' };
  }
  const list = events || [];
  if (prNumber != null) {
    const jobId = workerJobId(prNumber);
    const d = list.find(e => e && e.type === 'job.dispatch' && (
      e.job_id === jobId || Number(e.pr_number) === prNumber
    ));
    return {
      ok: true,
      jobId,
      prNumber,
      issueNumber: issueNumber ?? (d && (d.issue_number ?? d.issue) != null ? Number(d.issue_number ?? d.issue) : null),
      model: (d && d.model) || null,
      workType: (d && d.work_type) || '写码',
    };
  }
  const matches = list.filter(e => e && (
    Number(e.issue_number) === issueNumber
    || Number(e.issue) === issueNumber
    || e.job_id === workerJobId(issueNumber)
  ));
  const worker = matches.find(e => e.type === 'job.dispatch' && String(e.job_id || '').startsWith('gh-pr-') && !String(e.job_id).endsWith('-review'))
    || matches.find(e => e.type === 'job.dispatch' && String(e.job_id || '').startsWith('dispatch-'))
    || matches.find(e => e.type === 'job.dispatch');
  if (!worker) {
    return { ok: false, error: `账本里没有 issue #${issueNumber} 的 job.dispatch——给 --pr，或先派工再追加` };
  }
  const prFromId = String(worker.job_id || '').startsWith('gh-pr-')
    ? Number(String(worker.job_id).replace(/^gh-pr-/, '').replace(/-review$/, ''))
    : (worker.pr_number != null ? Number(worker.pr_number) : null);
  return {
    ok: true,
    jobId: worker.job_id,
    prNumber: Number.isInteger(prFromId) ? prFromId : null,
    issueNumber,
    model: worker.model || null,
    workType: worker.work_type || '写码',
  };
}

export function formatAmendComment({ triggeredBy, why, jobId, eventId } = {}) {
  return [
    '追加职责（账本已记 job.override）',
    '',
    `- 触发方：${triggeredBy || '帅'}`,
    `- 为什么：${why}`,
    `- job：${jobId}`,
    eventId ? `- event：${eventId}` : null,
    '<!-- dao-amend -->',
  ].filter(line => line != null).join('\n');
}
