// scripts/lib/dianjiangtai-backfill.mjs —— 从 GitHub PR 确定性重建点将台事件
//
// 输入必须是 GitHub 拉下来的 PR 记录（gh pr list / gh api），禁止在本模块内造 job。
// 输出事件符合 schemas/events.schema.json：每单派单（opened+dispatch）+
// 已结单再写结单（closed）+ 归因（attr.rule）。
// 幂等：写一次即不可变；重跑同 (type, job_id) 跳过不重写。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashOf } from './dianjiangtai-core.mjs';
import { writeEvent, nextSeq } from './event-writer.mjs';
import { redFlagsFromReviewBodies } from './judgment.mjs';

function hasBackfillEvent(dir, type, jobId) {
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (e.type === type && e.job_id === jobId && e.source === 'github-backfill') return true;
    } catch { /* 损坏文件交给 audit */ }
  }
  return false;
}

const TITLE_MODEL = [
  [/^\[grok\]/i, 'grok-4.6'],
  [/^\[pi\]/i, 'deepseek-v4-flash'],
  [/^\[codex\]/i, 'gpt-5.6-sol'],
  [/^\[cc\]/i, 'claude-opus'],
];

const TYPE_IDENTITY = {
  写码: '工人',
  判断: '协调者',
  查证: '工人',
  审查: '审官',
  UI: '工人',
};

function labelNames(pr) {
  return (pr.labels || []).map(l => (typeof l === 'string' ? l : l.name)).filter(Boolean);
}

export function toBeijingIso(input) {
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) throw new Error(`非法时间 ${JSON.stringify(input)}`);
  const bj = new Date(ms + 8 * 3600000);
  const p = n => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())}T${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}+08:00`;
}

export function beijingDateOf(input) {
  return toBeijingIso(input).slice(0, 10);
}

export function classifyFromGithub(pr) {
  const names = labelNames(pr);
  const modelLabel = names.find(n => n.startsWith('model/'));
  const typeLabel = names.find(n => n.startsWith('type/'));
  let model = modelLabel ? modelLabel.slice('model/'.length) : null;
  let workType = typeLabel ? typeLabel.slice('type/'.length) : null;
  if (!model) {
    const hit = TITLE_MODEL.find(([re]) => re.test(pr.title || ''));
    if (hit) model = hit[1];
  }
  if (!workType) workType = /审/.test(pr.title || '') ? '审查' : '写码';
  return { model, workType, identity: TYPE_IDENTITY[workType] || '工人' };
}

export function isClosedOnDate(pr, dateBeijing) {
  const end = pr.mergedAt || pr.closedAt;
  if (!end) return false;
  return beijingDateOf(end) === dateBeijing;
}

/** 从一条 GitHub PR 记录重建事件载荷（不写盘）。reviews[].body 用判定行算红项。 */
export function reconstructJob(pr, { models = [] } = {}) {
  const { model, workType, identity } = classifyFromGithub(pr);
  if (!model) {
    return { skip: true, reason: `PR #${pr.number} 无 model/* 标签且标题推不出模型`, pr: pr.number };
  }
  const registry = models.find(m => m.id === model);
  const reviews = pr.reviews || [];
  const reviewCount = reviews.length;
  const redFlags = reviewCount === 0 ? null : redFlagsFromReviewBodies(reviews.map(r => r.body));
  const merged = Boolean(pr.mergedAt);
  const closed = Boolean(pr.closedAt || pr.mergedAt);
  const jobId = `gh-pr-${pr.number}`;
  const openTs = toBeijingIso(pr.createdAt);
  const closeTs = closed ? toBeijingIso(pr.mergedAt || pr.closedAt) : null;
  const decisionId = hashOf({ source: 'github-backfill', pr: pr.number, model, ts: openTs });
  const whyBits = [
    `回填自 GitHub PR #${pr.number}`,
    pr.title,
    redFlags === null ? '无审读' : `判定行红 ${redFlags} 项`,
  ];

  const events = [
    {
      type: 'job.opened',
      ts: openTs,
      payload: {
        job_id: jobId,
        task_class: '回填',
        work_type: workType,
        identity,
        scale: '未知',
        risk: '低',
        reversible: true,
        task_tokens: null,
        candidate_models: [model],
        selected: model,
        why: whyBits.join('；'),
        pr_number: pr.number,
        source: 'github-backfill',
      },
    },
    {
      type: 'job.dispatch',
      ts: openTs,
      payload: {
        job_id: jobId,
        model,
        identity,
        work_type: workType,
        model_version: registry?.version ?? model,
        terminal: registry?.cli ?? 'unknown',
        price_snapshot: { source: 'github-backfill', note: '回填无当时价目，空快照' },
        decision_id: decisionId,
        pr_number: pr.number,
        source: 'github-backfill',
      },
    },
  ];

  if (closed) {
    events.push({
      type: 'job.closed',
      ts: closeTs,
      payload: {
        job_id: jobId,
        success: merged,
        rework: (redFlags || 0) > 0,
        usd_cash: 0,
        usd_economic: 0,
        merged_by: merged ? model : model,
        pr_number: pr.number,
        red_flags: redFlags,
        source: 'github-backfill',
      },
    });

    const trial = /试[测点]|试点/.test(pr.title || '');
    let attr;
    if (merged) {
      attr = {
        model_share: 1, brief_share: 0, coord_share: 0, env_share: 0,
        overrun_attr: null, confidence: 0.9,
        why: `L0：成功合并直记正样本（#${pr.number}，${redFlags === null ? '无审读' : `红 ${redFlags} 项`}）`,
      };
    } else if (trial) {
      attr = {
        model_share: 0, brief_share: 0, coord_share: 1, env_share: 0,
        overrun_attr: null, confidence: 0.9,
        why: `L0：未合并关闭的试点/试测单，记协调实验（#${pr.number}）`,
      };
    } else {
      attr = {
        model_share: 0, brief_share: 0, coord_share: 0, env_share: 0,
        overrun_attr: null, confidence: 0.5,
        why: `L0：未合并关闭且判不出主责，待定 unknown（#${pr.number}）`,
      };
    }
    events.push({
      type: 'attr.rule',
      ts: closeTs,
      payload: {
        job_id: jobId,
        model,
        ...attr,
        evidence: [`github:pr-${pr.number}`],
        pr_number: pr.number,
        source: 'github-backfill',
      },
    });
  }

  return {
    skip: false,
    job_id: jobId,
    pr: pr.number,
    model,
    workType,
    closed,
    merged,
    redFlags,
    events,
  };
}

export function writeReconstructedJobs({ jobs, dir, schema, machine = 'backfill' }) {
  let seq = nextSeq(dir, machine);
  let written = 0;
  let skipped = 0;
  const details = [];
  for (const job of jobs) {
    if (job.skip) {
      details.push({ pr: job.pr, skip: true, reason: job.reason });
      continue;
    }
    const jobWritten = [];
    const jobSkipped = [];
    for (const ev of job.events) {
      if (hasBackfillEvent(dir, ev.type, ev.payload.job_id)) {
        jobSkipped.push(ev.type);
        skipped += 1;
        continue;
      }
      try {
        const w = writeEvent({
          dir, type: ev.type, ts: ev.ts, machine, seq, schema, payload: ev.payload,
        });
        jobWritten.push(w.path);
        written += 1;
        seq += 1;
      } catch (e) {
        const msg = String(e.message || e);
        if (/已存在|已入账|已有/.test(msg)) {
          jobSkipped.push(ev.type);
          skipped += 1;
        } else {
          throw e;
        }
      }
    }
    details.push({
      pr: job.pr,
      job_id: job.job_id,
      written: jobWritten.length,
      skipped: jobSkipped.length,
    });
  }
  return { written, skipped, details };
}
