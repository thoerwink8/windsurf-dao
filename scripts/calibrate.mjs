#!/usr/bin/env node

// 模型校准 v4 口径（#581）：
//   1. 样本 = 本机账本（~/.dao/ledger/events）里成对的 job.dispatch + job.closed（一事件一模型，
//      审官 identity=审官 / work_type=审查 第一次进战绩）。
//   2. 返工轮数优先读 closed.worker_rework（已扣除帅追加需求的判定行）；
//      否则 closed.verdict_rounds - 1 - marshal_rounds；再否则 boolean rework。
//      null = 没测成，不是 0 轮。
//   3. 红项三态（#591）：undefined = 未记录（有审官痕迹但没记住，不进均值）；
//      0 = 审过零红；无 -review job 且无 red_flags = 无审。三者表上不许长得一样。
//   4. #807：判定行协议退役。校准计量只读账本；GitHub 侧只认 APPROVED / CHANGES_REQUESTED。
//   5. classifyPr 仍导出给 flow 写账本时读标签。
//
// 本脚本只读账本（--pr 标题可问 GitHub，失败单独说），只向 stdout/stderr 输出。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describeUnclosedJobs, formatUnclosedDetails, unclosedJobIds } from './lib/ledger-query.mjs';
import { describeAttribution, scopeOverridesFor } from './lib/ledger-job.mjs';
import { ensureLocalLedger } from './lib/ledger-home.mjs';
import { judgedReviewCount, requestedChangeCount } from './lib/review-state.mjs';

export const TASK_TYPES = ['写码', '判断', '查证', '审查', 'UI'];

const ROOT = resolve(import.meta.dirname, '..');

// 默认落点 = 本机 ~/.dao/ledger/events（ledger 本机化：事件不进 git，仓内历史自动种子过来）
export function loadLedgerEvents(dir) {
  const eventsDir = dir || ensureLocalLedger({ root: ROOT }).dir;
  if (!existsSync(eventsDir)) return { ok: false, error: `账本目录不在：${eventsDir}`, events: [] };
  const files = readdirSync(eventsDir).filter(f => f.endsWith('.json'));
  const events = [];
  const bad = [];
  for (const f of files) {
    try { events.push(JSON.parse(readFileSync(join(eventsDir, f), 'utf8'))); }
    catch { bad.push(f); }
  }
  if (bad.length) {
    return { ok: false, error: `账本 ${bad.length} 个文件不是 JSON：${bad.slice(0, 3).join(',')}`, events };
  }
  return { ok: true, events, emptyDir: files.length === 0, dir: eventsDir };
}

export function reworkFromClosed(closed) {
  if (!closed) return null;
  if (closed.worker_rework != null) return closed.worker_rework;
  const marshal = Number(closed.marshal_rounds) || 0;
  if (closed.verdict_rounds != null) return Math.max(0, Number(closed.verdict_rounds) - 1 - marshal);
  if (typeof closed.rework === 'boolean') return closed.rework ? 1 : 0;
  return null;
}

export function redFlagsFromClosed(closed) {
  if (!closed || closed.red_flags === undefined) return null;
  return closed.red_flags;
}

/** 未记录 / 0 / 无审。无 redKind 的旧样本（测试手造）按 null → 无审。 */
export function redKindFromClosed(closed, events) {
  if (!closed) return 'none';
  if (closed.red_flags === 0) return 'zero';
  if (closed.red_flags != null) return 'counted';
  const pr = closed.pr_number;
  const jobId = String(closed.job_id || '');
  const isReview = jobId.endsWith('-review');
  const hasReviewJob = (events || []).some(e => (
    e && e.type === 'job.dispatch' && (
      e.job_id === `gh-pr-${pr}-review`
      || (pr != null && Number(e.pr_number) === Number(pr) && e.identity === '审官')
    )
  ));
  if (isReview || hasReviewJob) return 'unrecorded';
  return 'none';
}

export function formatRedCell(item) {
  if (!item) return '无审';
  if (item.redKind === 'unrecorded') return '未记录';
  if (item.redKind === 'zero' || item.redFlags === 0) return '0';
  if (item.redKind === 'none' || item.redFlags == null || item.redFlags === undefined) return '无审';
  return String(item.redFlags);
}

function attributionForClosed(closed, events) {
  const overrides = scopeOverridesFor(events, {
    jobId: closed.job_id,
    prNumber: closed.pr_number,
  });
  if (overrides.length > 0 && closed.attribution_source !== 'event') {
    const marshalRounds = overrides.length;
    let rework = null;
    if (closed.verdict_rounds != null) {
      rework = Math.max(0, Number(closed.verdict_rounds) - 1 - marshalRounds);
    } else if (closed.worker_rework != null) {
      rework = Math.max(0, Number(closed.worker_rework) - marshalRounds);
    } else {
      rework = reworkFromClosed(closed);
    }
    return {
      rework,
      marshalRounds,
      triggeredBy: marshalRounds > 0 && rework > 0 ? '混合' : marshalRounds > 0 ? '帅' : (closed.triggered_by || null),
      attributionSource: 'event',
      attributionNote: '按 job.override 事件归因',
    };
  }
  const source = closed.attribution_source
    || ((closed.worker_rework == null && closed.verdict_rounds == null && closed.rework == null)
      ? 'unscanned'
      : 'inferred');
  return {
    rework: reworkFromClosed(closed),
    marshalRounds: Number(closed.marshal_rounds) || 0,
    triggeredBy: closed.triggered_by || null,
    attributionSource: source,
    attributionNote: closed.attribution_note || (
      source === 'event' ? '按 job.override 事件归因'
        : source === 'inferred' ? '归因来自反推，可能低估帅的轮次'
          : '归因没查成'
    ),
  };
}

/** 有 closed 才是样本。没有 dispatch 的 closed 用 merged_by 当模型，工种记空（不进矩阵）。 */
export function samplesFromEvents(events) {
  const dispatches = new Map();
  for (const e of events || []) {
    if (e && e.type === 'job.dispatch' && e.job_id) dispatches.set(e.job_id, e);
  }
  const samples = [];
  for (const e of events || []) {
    if (!e || e.type !== 'job.closed' || !e.job_id) continue;
    if (String(e.job_id).startsWith('dispatch-')) continue;
    const d = dispatches.get(e.job_id);
    const model = (d && d.model) || e.merged_by || null;
    const taskType = (d && d.work_type) || null;
    const identity = (d && d.identity) || null;
    const redKind = redKindFromClosed(e, events);
    const attr = attributionForClosed(e, events);
    samples.push({
      number: e.pr_number ?? null,
      jobId: e.job_id,
      model,
      taskType,
      identity,
      tagged: Boolean(model && taskType),
      rework: attr.rework,
      redFlags: redFlagsFromClosed(e),
      redKind,
      triggeredBy: attr.triggeredBy,
      marshalRounds: attr.marshalRounds,
      attributionSource: attr.attributionSource,
      attributionNote: attr.attributionNote,
      mergedAt: e.ts,
      title: (d && d.why) || e.job_id,
    });
  }
  return samples;
}

export function describeNoEvents(prNumber) {
  return `没有事件（没查成）：本机账本（~/.dao/ledger/events）里 PR #${prNumber} 一条 job.dispatch/job.closed 都没有——不是 0 红，是没查成`;
}

function labelNames(pr) {
  return (pr.labels || []).map(label => typeof label === 'string' ? label : label.name);
}

export function classifyPr(pr) {
  const names = labelNames(pr);
  const modelLabel = names.find(name => name.startsWith('model/'));
  const typeLabel = names.find(name => name.startsWith('type/'));
  return {
    model: modelLabel ? modelLabel.slice('model/'.length) : null,
    taskType: typeLabel ? typeLabel.slice('type/'.length) : null,
    tagged: Boolean(modelLabel && typeLabel),
  };
}

// #807：返工轮数 = GitHub 判别态 review 条数 - 1（APPROVED / CHANGES_REQUESTED）。
// 0 条记 null、输出「无审读（本项没测成）」——「数到 0 轮」和「一条判别态都没有」必须不同形。
export function countVerdictLines(reviews) {
  const list = Array.isArray(reviews) ? reviews : [];
  let n = 0;
  for (const r of list) {
    if (r && typeof r === 'object' && r.state) {
      const s = String(r.state).toUpperCase();
      if (s.includes('APPROV') || s.includes('CHANGES')) n += 1;
      continue;
    }
    const body = typeof r === 'string' ? r : (r && r.body) || '';
    if (/^\s*(?:[>*]\s*)*(判定|复核结论)/m.test(String(body))) n += 1;
  }
  return n;
}

export function reworkFromVerdictLines(reviews) {
  const count = countVerdictLines(reviews);
  return count === 0 ? null : count - 1;
}

export function redFlagsFromReviewBodies(reviews) {
  const list = Array.isArray(reviews) ? reviews : [];
  let max = 0;
  let anyJudged = false;
  for (const r of list) {
    if (r && typeof r === 'object' && r.state) {
      anyJudged = true;
      if (String(r.state).toUpperCase().includes('CHANGES')) max = Math.max(max, 1);
      continue;
    }
    const body = typeof r === 'string' ? r : (r && r.body) || '';
    for (const line of String(body).split(/\r?\n/)) {
      if (!/^\s*(?:[>*]\s*)*(判定|复核结论)/.test(line)) continue;
      anyJudged = true;
      for (const m of line.matchAll(/红\s*(\d+)\s*项/g)) max = Math.max(max, Number(m[1]));
    }
  }
  return anyJudged || list.length === 0 ? max : 0;
}

export function describeRework(rework) {
  if (rework === null || rework === undefined) {
    return '无审读（本项没测成）：PR 上没有 APPROVED / CHANGES_REQUESTED';
  }
  return rework === 0
    ? `0 轮（判别态 1 条：审过一次，零返工）`
    : `${rework} 轮（判别态 ${rework + 1} 条）`;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatAverage(value) {
  return value.toFixed(1);
}

function sampleTime(sample) {
  return Date.parse(sample.mergedAt || sample.updatedAt || sample.createdAt || 0);
}

export function buildRows(samples, models = [], taskTypes = TASK_TYPES) {
  const modelSet = new Set(models);
  const typeSet = new Set(taskTypes);
  for (const sample of samples) {
    if (sample.model) modelSet.add(sample.model);
    if (sample.taskType) typeSet.add(sample.taskType);
  }

  const rows = [];
  for (const model of [...modelSet].sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
    for (const taskType of [...typeSet]) {
      const matched = samples
        .filter(sample => sample.model === model && sample.taskType === taskType)
        .sort((a, b) => sampleTime(a) - sampleTime(b));
      if (matched.length === 0) {
        rows.push({ model, taskType, sampleCount: 0, averageRework: null, averageRedFlags: null, trend: [] });
        continue;
      }
      // 红项口径 v2 + #591：未记录 / 无审 都不进平均，也不当 0。
      const reviewedRed = matched.filter(sample => sample.redFlags !== null && sample.redFlags !== undefined);
      const measuredRework = matched.filter(sample => sample.rework !== null && sample.rework !== undefined);
      const redBlank = reviewedRed.length === 0
        && matched.some(sample => sample.redKind === 'unrecorded')
        ? 'unrecorded'
        : 'none';
      rows.push({
        model,
        taskType,
        sampleCount: matched.length,
        averageRework: measuredRework.length === 0 ? null : average(measuredRework.map(sample => sample.rework)),
        averageRedFlags: reviewedRed.length === 0 ? null : average(reviewedRed.map(sample => sample.redFlags)),
        redBlank,
        trend: matched.slice(-3).map(sample => ({
          number: sample.number,
          rework: sample.rework,
          redFlags: sample.redFlags,
          redKind: sample.redKind,
          malformed: (sample.judgmentMalformed || []).length > 0,
        })),
      });
    }
  }
  return rows;
}

export function renderRow(row) {
  if (row.sampleCount === 0) {
    return `| ${row.model} | ${row.taskType} | 无样本 | 无样本 | 无样本 | 无样本 |`;
  }
  const trend = row.trend
    .map(item => `#${item.number} ${item.malformed ? '判定不合规' : (item.rework === null || item.rework === undefined ? '无判定' : item.rework)}/${formatRedCell(item)}`)
    .join(' → ');
  const avgRework = row.averageRework === null || row.averageRework === undefined
    ? '无审读'
    : formatAverage(row.averageRework);
  const avgRed = row.averageRedFlags === null || row.averageRedFlags === undefined
    ? (row.redBlank === 'unrecorded' ? '未记录' : '无审读')
    : formatAverage(row.averageRedFlags);
  return `| ${row.model} | ${row.taskType} | ${row.sampleCount} | ${avgRework} | ${avgRed} | ${trend} |`;
}

export function renderFullReport(rows, unlabelledCount, repository = null, unclosedRows = null) {
  const list = Array.isArray(rows) ? rows : [];
  const withSamples = list.filter(r => r && r.sampleCount > 0);
  const emptyCount = list.filter(r => r && r.sampleCount === 0).length;
  const table = withSamples.length > 0
    ? [
        '| 模型 | 任务类 | 样本数 | 平均返工轮数 | 平均红项 | 最近 3 单（返工/红项） |',
        '| --- | --- | ---: | ---: | ---: | --- |',
        ...withSamples.map(renderRow),
        '',
      ]
    : [];
  const unclosedLine = Array.isArray(unclosedRows)
    ? formatUnclosedDetails(unclosedRows)
    : `账本未结单：${unlabelledCount} 个（未混入战绩）。`;
  const lines = [
    '# 模型累计战绩',
    '',
    ...(repository ? [`仓库：${repository}`, ''] : []),
    ...table,
    ...(emptyCount > 0 ? [`另有 ${emptyCount} 个模型×任务类组合无样本。`, ''] : []),
    unclosedLine,
  ];
  return lines.join('\n');
}

function openDispatchCount(events) {
  return unclosedJobIds(events).length;
}

function tryGhPrTitle(number) {
  const result = spawnSync('gh', ['pr', 'view', String(number), '--json', 'title,state,mergedAt,isDraft'], { windowsHide: true, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return { ok: false, error: String(result.error?.message || result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 160) };
  }
  try { return { ok: true, pr: JSON.parse(result.stdout) }; }
  catch { return { ok: false, error: 'gh 返回不是 JSON' }; }
}

function stateName(pr) {
  if (!pr) return '账本有结单';
  if (pr.mergedAt) return '已合并';
  if (pr.isDraft) return 'Draft';
  if (pr.state === 'CLOSED') return '已关闭';
  return pr.state || '开放';
}

function renderSingleReport(sample, cumulativeRow, openCount, extra = {}) {
  const lines = [
    `# ${sample.number != null ? `PR #${sample.number}` : sample.jobId} 本单成绩`,
    '',
    `- 标题：${extra.title || sample.title || '（账本无标题）'}`,
    `- 状态：${stateName(extra.pr)}`,
    `- 模型：${sample.model || '未记录'}`,
    `- 身份：${sample.identity || '未记录'}`,
    `- 任务类：${sample.taskType || '未记录'}`,
    `- 返工轮数：${describeRework(sample.rework, sample.judgmentMalformed || [])}`,
    `- 触发方：${sample.triggeredBy || '未记'}`,
    `- 归因：${describeAttribution({ attributionSource: sample.attributionSource, attributionNote: sample.attributionNote })}`,
    `- 审查红项数：${formatRedCell(sample) === '0' || formatRedCell(sample) === String(sample.redFlags)
      ? sample.redFlags
      : `${formatRedCell(sample)}（${formatRedCell(sample) === '未记录' ? '账本没记住，不是 0 红' : '没有审官，不是 0 红'}）`}`,
    '',
    '## 最新累计战绩（含本单）',
    '',
  ];
  if (!sample.tagged) {
    lines.push('此条结单缺模型或工种，不能归入模型×任务类累计战绩。');
  } else {
    lines.push(
      '| 模型 | 任务类 | 样本数 | 平均返工轮数 | 平均红项 | 最近 3 单（返工/红项） |',
      '| --- | --- | ---: | ---: | ---: | --- |',
      renderRow(cumulativeRow),
    );
  }
  const extraUnclosed = extra.unclosedRows;
  lines.push('', Array.isArray(extraUnclosed) ? formatUnclosedDetails(extraUnclosed) : `账本未结单：${openCount} 个（未混入战绩）。`);
  return lines.join('\n');
}

function parseArgs(argv) {
  if (argv.length === 0) return { pr: null };
  if (argv.length === 2 && argv[0] === '--pr' && /^\d+$/.test(argv[1]) && Number(argv[1]) > 0) {
    return { pr: Number(argv[1]) };
  }
  throw new Error('用法：node scripts/calibrate.mjs [--pr <正整数>]');
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const loaded = loadLedgerEvents();
  if (!loaded.ok) throw new Error(loaded.error);
  const samples = samplesFromEvents(loaded.events).filter(s => s.tagged);
  const unclosedRows = describeUnclosedJobs(loaded.events);
  const openCount = unclosedRows.length;
  const models = [...new Set(samples.map(s => s.model).filter(Boolean))];
  const taskTypes = [...new Set([...TASK_TYPES, ...samples.map(s => s.taskType).filter(Boolean)])];

  if (args.pr === null) {
    console.log(renderFullReport(buildRows(samples, models, taskTypes), openCount, loaded.dir || 'ledger/events', unclosedRows));
    return;
  }

  const related = samplesFromEvents(loaded.events).filter(s => s.number === args.pr);
  if (related.length === 0) {
    console.log(`# PR #${args.pr} 本单成绩\n\n- ${describeNoEvents(args.pr)}`);
    return;
  }
  const gh = tryGhPrTitle(args.pr);
  const extra = gh.ok ? { pr: gh.pr, title: gh.pr.title } : { title: `（GitHub 标题没查成：${gh.error}）` };
  const blocks = related.map(target => {
    const row = target.tagged
      ? buildRows(samples.some(s => s.jobId === target.jobId) ? samples : [...samples, target], [target.model], [target.taskType])
        .find(candidate => candidate.model === target.model && candidate.taskType === target.taskType)
      : null;
    return renderSingleReport(target, row, openCount, { ...extra, unclosedRows });
  });
  console.log(blocks.join('\n\n'));
}

const isDirectRun = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(`校准失败：${error.message}`);
    process.exitCode = 1;
  }
}
