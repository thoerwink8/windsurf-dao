#!/usr/bin/env node

// 模型校准 v3 口径：
//   1. 样本 = 同时带 model/* 与 type/* 标签的 PR；累计战绩只使用已合并 PR。
//   2. 返工轮数 = 该 PR 上审官判定行的条数 - 1（issue #501 缺陷二：旧口径「首次 ready
//      之后新增 commit 数」惩罚「draft 到底、完工才 ready」的合规工人——#496 实返工
//      1 轮测出 0）。一条判定行 = 审官审过一次 = 零返工；两条 = 返工一轮；与 ready 状态
//      无关。0 条判定行记 null、呈现「无判定行（本项没测成）」，与「审过零返工（0 轮）」
//      分开——没查成 ≠ 查过没事（仓规硬条款）。
//   3. 审查红项数 = 从每条 review 正文**判定行**提取「判定：红 N 项」或「红 N 项」的最大 N
//      （issue #444：同账号不能 request-changes，审官以 COMMENT 提交、判定写正文首行，
//      结构化线程数为 0，红项被计成 0）。判定行 = 行首为「判定」「复核结论」（允许 >、**
//      前缀）——正文叙述引用他单红数不计入（防引用性多计，对抗审 #449 红 1）。
//      跨 review 取最大值 ⇒ 复核绿不清零首审红项；结构化 request-changes 的线程数仍兼容，
//      取两者最大值。
//   4. 无审读 vs 0 红可区分：0 条 review 记 null、呈现「无审读」，审过零红记 0
//      （对抗审 #449 红 2，仓规硬条款：扫完 0 条 ≠ 没扫到）。
//   5. 最近 3 单趋势按合并时间从旧到新显示“返工/红项”。
//
// 本脚本只读 GitHub 官方数据，只向 stdout/stderr 输出，不改文件、不发评论。

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { redFlagsFromReviewBodies, judgmentFromReview } from './lib/judgment.mjs';

export { redFlagsFromReviewBodies } from './lib/judgment.mjs';

export const TASK_TYPES = ['写码', '判断', '查证', '审查', 'UI'];

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
export function describeRework(rework) {
  if (rework === null || rework === undefined) {
    return '无判定行（本项没测成）：PR 上一条审官判定行都没有——审读可能走了 Orca 消息没落 PR review，流转器自动同步（缺陷一修法）生效后会自动补上';
  }
  return rework === 0
    ? `0 轮（判定行 1 条：审过一次，零返工）`
    : `${rework} 轮（判定行 ${rework + 1} 条）`;
}

// 红项口径 v2（issue #444）：从 review 正文判定行提取红项数。
// 判定格式：审官以 COMMENT 提交 review，判定写正文首行，如「判定：红 N 项」
// 「**判定：红 N 项**」「复核结论：绿，可合并」。跨全部 review 取最大 N ⇒
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
      // 红项口径 v2（对抗审 #449 红 2）：没被审过的样本（redFlags=null）不混进红项平均，
      // 也不当作 0 红；全组都没审过时平均红项记 null（渲染为「无审读」）。
      const reviewedRed = matched.filter(sample => sample.redFlags !== null && sample.redFlags !== undefined);
      // 返工口径 v3（#501 缺陷二）：无判定行的样本（rework=null）不混进返工平均，也不当作
      // 0 轮；全组都没判定行时平均返工记 null（渲染为「无判定行」），与「审过零返工」分开。
      const measuredRework = matched.filter(sample => sample.rework !== null && sample.rework !== undefined);
      rows.push({
        model,
        taskType,
        sampleCount: matched.length,
        averageRework: measuredRework.length === 0 ? null : average(measuredRework.map(sample => sample.rework)),
        averageRedFlags: reviewedRed.length === 0 ? null : average(reviewedRed.map(sample => sample.redFlags)),
        trend: matched.slice(-3).map(sample => ({
          number: sample.number,
          rework: sample.rework,
          redFlags: sample.redFlags,
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
    .map(item => `#${item.number} ${item.malformed ? '判定不合规' : (item.rework === null || item.rework === undefined ? '无判定' : item.rework)}/${item.redFlags === null || item.redFlags === undefined ? '无审' : item.redFlags}`)
    .join(' → ');
  const avgRework = row.averageRework === null || row.averageRework === undefined
    ? '无判定行'
    : formatAverage(row.averageRework);
  const avgRed = row.averageRedFlags === null || row.averageRedFlags === undefined
    ? '无审读'
    : formatAverage(row.averageRedFlags);
  return `| ${row.model} | ${row.taskType} | ${row.sampleCount} | ${avgRework} | ${avgRed} | ${trend} |`;
}

export function renderFullReport(rows, unlabelledCount, repository = null) {
  const dataRows = rows.length > 0
    ? rows.map(renderRow)
    : ['| 无样本 | 无样本 | 无样本 | 无样本 | 无样本 | 无样本 |'];
  const lines = [
    '# 模型累计战绩',
    '',
    ...(repository ? [`仓库：${repository}`, ''] : []),
    '| 模型 | 任务类 | 样本数 | 平均返工轮数 | 平均红项 | 最近 3 单（返工/红项） |',
    '| --- | --- | ---: | ---: | ---: | --- |',
    ...dataRows,
    '',
    `未标注的已合并 PR：${unlabelledCount} 个（缺少 model/* 或 type/* 标签，未混入战绩）。`,
  ];
  return lines.join('\n');
}

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', cwd: process.cwd() });
  if (result.error) throw new Error(`无法运行 gh：${result.error.message}`);
  if (result.status !== 0) {
    const reason = String(result.stderr || result.stdout || '').trim();
    throw new Error(`GitHub 数据读取失败：${reason || `gh 退出码 ${result.status}`}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('GitHub 返回了无法解析的 JSON。');
  }
}

function repositoryName() {
  return runGh(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
}

function mergedPullRequests() {
  return runGh([
    'pr', 'list', '--state', 'merged', '--limit', '1000',
    '--json', 'number,title,labels,createdAt,updatedAt,mergedAt,isDraft,state,url',
  ]);
}

function pullRequest(number) {
  return runGh([
    'pr', 'view', String(number),
    '--json', 'number,title,labels,createdAt,updatedAt,mergedAt,isDraft,state,url',
  ]);
}

function labelCatalog() {
  return runGh(['label', 'list', '--limit', '1000', '--json', 'name']).map(label => label.name);
}

function pullRequestDetails(repository, number) {
  const [owner, name] = repository.split('/');
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 1) { totalCount }
          reviews(first: 100) { totalCount nodes { state body } }
        }
      }
    }`;
  const data = runGh([
    'api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`,
    '-F', `number=${number}`,
  ]);
  const details = data.data?.repository?.pullRequest;
  if (!details) throw new Error(`读取不到 PR #${number} 的校准数据。`);
  if (details.reviews.totalCount > details.reviews.nodes.length) {
    throw new Error(`PR #${number} 有 ${details.reviews.totalCount} 条 review，超过单次读取上限 100，拒绝给出不完整成绩。`);
  }
  return {
    // 红项口径 v2（对抗审 #449 红 2）：没被审过（0 条 review）与审过但 0 红不可混同——
    // 没人审过记 null，报告呈现「无审读」；审过则按正文判定行与结构化线程取最大。
    redFlags: details.reviews.totalCount === 0
      ? null
      : Math.max(
          redFlagsFromReviewBodies((details.reviews?.nodes || []).map(node => node.body)),
          details.reviewThreads.totalCount,
        ),
    reviewCount: details.reviews.totalCount,
    reviewBodies: (details.reviews?.nodes || []).map(node => node.body),
  };
}

function measurePr(repository, pr) {
  const classification = classifyPr(pr);
  const details = pullRequestDetails(repository, pr.number);
  return {
    ...pr,
    ...classification,
    // 返工口径 v3（issue #501 缺陷二）：数判定行条数 - 1，与 ready/commit 节奏无关。
    rework: reworkFromVerdictLines(details.reviewBodies),
    redFlags: details.redFlags,
    reviewCount: details.reviewCount,
  };
}

function combinations(labels, samples) {
  const models = labels.filter(label => label.startsWith('model/')).map(label => label.slice(6));
  const types = [
    ...TASK_TYPES,
    ...labels.filter(label => label.startsWith('type/')).map(label => label.slice(5)),
  ];
  return {
    models: [...new Set([...models, ...samples.map(sample => sample.model).filter(Boolean)])],
    taskTypes: [...new Set(types)],
  };
}

function collectMergedSamples(repository, prs) {
  const tagged = prs.filter(pr => classifyPr(pr).tagged);
  return tagged.map(pr => measurePr(repository, pr));
}

function stateName(pr) {
  if (pr.mergedAt) return '已合并';
  if (pr.isDraft) return 'Draft';
  if (pr.state === 'CLOSED') return '已关闭';
  return '开放';
}

function renderSingleReport(sample, cumulativeRow, unlabelledCount) {
  const lines = [
    `# PR #${sample.number} 本单成绩`,
    '',
    `- 标题：${sample.title}`,
    `- 状态：${stateName(sample)}`,
    `- 模型：${sample.model || '未标注'}`,
    `- 任务类：${sample.taskType || '未标注'}`,
    `- 返工轮数：${describeRework(sample.rework, sample.judgmentMalformed || [])}`,
    `- review 条数：${sample.reviewCount ?? 0}`,
    `- 审查红项数：${sample.redFlags === null || sample.redFlags === undefined ? '无审读（0 条 review，未审不等于 0 红）' : sample.redFlags}`, 
    '',
    '## 最新累计战绩（含本单）',
    '',
  ];
  if (!sample.tagged) {
    lines.push('此 PR 缺少 model/* 或 type/* 标签，不能归入模型×任务类累计战绩。');
  } else {
    lines.push(
      '| 模型 | 任务类 | 样本数 | 平均返工轮数 | 平均红项 | 最近 3 单（返工/红项） |',
      '| --- | --- | ---: | ---: | ---: | --- |',
      renderRow(cumulativeRow),
    );
  }
  lines.push('', `未标注的已合并 PR：${unlabelledCount} 个（未混入战绩）。`);
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
  const repository = repositoryName();
  const merged = mergedPullRequests();
  const unlabelledCount = merged.filter(pr => !classifyPr(pr).tagged).length;

  if (args.pr === null) {
    const samples = collectMergedSamples(repository, merged);
    const known = combinations(labelCatalog(), samples);
    console.log(renderFullReport(buildRows(samples, known.models, known.taskTypes), unlabelledCount, repository));
    return;
  }

  const targetPr = pullRequest(args.pr);
  const target = measurePr(repository, targetPr);
  const samples = collectMergedSamples(repository, merged);
  if (target.tagged && !samples.some(sample => sample.number === target.number)) samples.push(target);
  const row = target.tagged
    ? buildRows(samples, [target.model], [target.taskType])
      .find(candidate => candidate.model === target.model && candidate.taskType === target.taskType)
    : null;
  console.log(renderSingleReport(target, row, unlabelledCount));
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
