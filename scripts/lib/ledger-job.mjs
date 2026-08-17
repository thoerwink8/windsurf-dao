// scripts/lib/ledger-job.mjs —— 接活账本的调用封装（#581）
//
// 写入仍走 event-writer.writeEvent，不新造写入器。这里只拼 payload、
// 定 job_id、把「已有同 job 事件」收成幂等 skip。
// 工人 job_id = gh-pr-N（与回填同口径）；审官 job_id = gh-pr-N-review
// （一 job 只能一条 job.dispatch / job.closed）。
// #595：默认落点是主树 ledger/events（git-common-dir），不随调用者所在树漂移。
// 测试或显式覆盖走 eventsDir / LEDGER_EVENTS_DIR。落点查不成必须抛，不许退回工人树。

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeEvent, nextSeq } from './event-writer.mjs';
import { hashOf } from './dianjiangtai-core.mjs';
import { toBeijingIso } from './dianjiangtai-backfill.mjs';
import { judgmentFromReview } from './judgment.mjs';

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

export function loadLedgerContext({ root = DEFAULT_ROOT, eventsDir, schemaPath, machine, git } = {}) {
  const explicit = eventsDir || process.env.LEDGER_EVENTS_DIR || '';
  let dir;
  if (explicit) {
    dir = resolve(root, explicit);
  } else {
    const main = resolveMainWorktreeRoot({ from: root, git });
    if (!main.ok) {
      throw new Error(`账本落点没查成：${main.error}——不许退回调用者所在树`);
    }
    dir = join(main.root, 'ledger', 'events');
  }
  const schemaFile = resolve(root, schemaPath || 'schemas/events.schema.json');
  if (!existsSync(schemaFile)) throw new Error(`事件 schema 不在：${schemaFile}`);
  const schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
  return { dir, schema, machine: machine || process.env.LEDGER_MACHINE || os.hostname(), root };
}

/** 从 review 正文判定行汇总轮次 / 红项，并把「绿之后又来的判定」记成帅追加。 */
export function verdictStatsFromReviews(reviews) {
  let reviewerRounds = 0;
  let marshalRounds = 0;
  let maxRed = null;
  let sawGreen = false;
  for (const rv of reviews || []) {
    const v = judgmentFromReview(rv && rv.body);
    if (!v.kind || v.malformed) continue;
    if (v.red != null) maxRed = Math.max(maxRed ?? 0, v.red);
    if (sawGreen) {
      marshalRounds += 1;
      continue;
    }
    reviewerRounds += 1;
    if (v.green) sawGreen = true;
  }
  const saw = reviewerRounds + marshalRounds > 0;
  const workerRework = reviewerRounds === 0 ? null : Math.max(0, reviewerRounds - 1);
  return {
    verdictRounds: saw ? reviewerRounds + marshalRounds : null,
    reviewerRounds: saw ? reviewerRounds : null,
    marshalRounds,
    redFlags: saw ? (maxRed ?? 0) : null,
    workerRework,
    triggeredBy: !saw ? null : marshalRounds > 0 && workerRework > 0 ? '混合' : marshalRounds > 0 ? '帅' : '审官',
  };
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

export function writeJobClosed({
  dir, ts, machine, schema, jobId, success, rework, mergedBy,
  prNumber, redFlags, verdictRounds, workerRework, marshalRounds, triggeredBy,
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
