#!/usr/bin/env node

// 模型校准 v4 口径（#581）：
//   1. 样本 = ledger/events 里成对的 job.dispatch + job.closed（一事件一模型，
//      审官 identity=审官 / work_type=审查 第一次进战绩）。
//   2. 返工轮数优先读 closed.worker_rework（已扣除帅追加需求的判定行）；
//      否则 closed.verdict_rounds - 1 - marshal_rounds；再否则 boolean rework。
//      null = 没测成，不是 0 轮。
//   3. 红项三态（#591）：undefined = 未记录（有审官痕迹但没记住，不进均值）；
//      0 = 审过零红；无 -review job 且无 red_flags = 无审。三者表上不许长得一样。
//   4. judgment.mjs 不再承担校准计量，只给 flow 判红绿。
//   5. classifyPr 仍导出给 flow 写账本时读标签。
//
// 本脚本只读账本（--pr 标题可问 GitHub，失败单独说），只向 stdout/stderr 输出。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { redFlagsFromReviewBodies, judgmentFromReview } from './lib/judgment.mjs';
import { describeUnclosedJobs, formatUnclosedDetails, unclosedJobIds } from './lib/ledger-query.mjs';
import { describeAttribution, scopeOverridesFor } from './lib/ledger-job.mjs';

export { redFlagsFromReviewBodies } from './lib/judgment.mjs';

export const TASK_TYPES = ['写码', '判断', '查证', '审查', 'UI'];

const ROOT = resolve(import.meta.dirname, '..');

export function loadLedgerEvents(dir = join(ROOT, 'ledger/events')) {
  if (!existsSync(dir)) return { ok: false, error: `账本目录不在：${dir}`, events: [] };
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const events = [];
  const bad = [];
  for (const f of files) {
    try { events.push(JSON.parse(readFileSync(join(dir, f), 'utf8'))); }
    catch { bad.push(f); }
  }
  if (bad.length) {
    return { ok: false, error: `账本 ${bad.length} 个文件不是 JSON：${bad.slice(0, 3).join(',')}`, events };
  }
  return { ok: true, events, emptyDir: files.length === 0 };
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
  return `没有事件（没查成）：ledger/events 里 PR #${prNumber} 一条 job.dispatch/job.closed 都没有——不是 0 红，是没查成`;
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

// 返工轮数口径 v3（issue #501 缺陷二）：返工轮数 = 审官判定行的条数 - 1，数据源与红项数
// 同一处（PR review 正文判定行）。判定行解析复用 judgment.mjs（唯一真相源，禁止在别处
// 再写一份正则）：一条判定行 = 审官审过一次 = 零返工；两条 = 返工一轮；以此类推。
// 0 条判定行记 null、输出「无判定行（本项没测成）」——「数到 0 轮」和「一条判定行都没有」
// 必须输出不同的话（仓规硬条款：没查成 ≠ 查过没事）。
export function countVerdictLines(bodies) {
  return (bodies || []).filter(body => judgmentFromReview(body).kind !== null).length;
}

export function reworkFromVerdictLines(bodies) {
  const count = countVerdictLines(bodies);
  return count === 0 ? null : count - 1;
}

// 单 PR 报告的返工三态输出（三种话可分辨）：
//   - 判定行 1 条 → 「0 轮（判定行 1 条：审过一次，零返工）」
//   - 判定行 N>1 条 → 「N-1 轮（判定行 N 条）」
//   - 0 条判定行 → 「无判定行（本项没测成）」并说明可能原因——不是 0 轮。
export function describeRework(rework, malformed = []) {
  if (malformed.length > 0) {
    return `判定行不合规（没查成）：${malformed.map(m => `「${m.attempt || '?'}」`).join('、')}——格式只认 判定：红 N 项 / 判定：绿，可合并 / 复核结论：…（见 scripts/lib/judgment.mjs），流转器与校准都把它当没查成，不许当无判定`;
  }
  if (rework === null || rework === undefined) {
    return '无判定行（本项没测成）：PR 上一条审官判定行都没有——审读可能走了 Orca 消息没落 PR review，流转器自动同步（缺陷一修法）生效后会自动补上';
  }
  return rework === 0
    ? `0 轮（判定行 1 条：审过一次，零返工）`
    : `${rework} 轮（判定行 ${rework + 1} 条）`;
}

// 红项口径 v2（issue #444，提交方式经 #573 更新）：从 review 正文判定行提取红项数。
// 判定格式：判定写正文首行，如「判定：红 N 项」「**判定：红 N 项**」
// 「复核结论：绿，可合并」（#444 曾因同账号限制只能 COMMENT；#573 起审官走
// approve / request-changes，解析仍只认正文判定行）。跨全部 review 取最大 N ⇒
// 复核绿（无红数）不清零首审红项。
// 解析逻辑的单一真相源 = scripts/lib/judgment.mjs（本脚本与 scripts/flow.mjs
// 共用，禁止复制第二份）。判定行 = 行首为「判定」「复核结论」（允许 >、** 前缀）
// 的行——正文叙述里引用他单「红 N 项」不计入，防引用性多计（对抗审 #449 红 1）。

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
    ? '无判定行'
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
  const result = spawnSync('gh', ['pr', 'view', String(number), '--json', 'title,state,mergedAt,isDraft'], { encoding: 'utf8' });
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
    console.log(renderFullReport(buildRows(samples, models, taskTypes), openCount, 'ledger/events', unclosedRows));
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
