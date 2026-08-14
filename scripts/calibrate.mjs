#!/usr/bin/env node

// 模型校准 v2 口径：
//   1. 样本 = 同时带 model/* 与 type/* 标签的 PR；累计战绩只使用已合并 PR。
//   2. 返工轮数 = PR 首次 ready 之后新增的 commit 数。若 PR 从未是 Draft，
//      GitHub 没有 ready_for_review 事件，以 PR 创建时间作为首次 ready 时间。
//   3. 审查红项数 = 从每条 review 正文提取「判定：红 N 项」或「红 N 项」的最大 N
//      （issue #444：同账号不能 request-changes，审官以 COMMENT 提交、判定写正文首行，
//      结构化线程数为 0，红项被计成 0）。跨 review 取最大值 ⇒ 复核绿不清零首审红项；
//      结构化 request-changes 的线程数仍兼容，取两者最大值。
//   4. 最近 3 单趋势按合并时间从旧到新显示“返工/红项”。
//
// 本脚本只读 GitHub 官方数据，只向 stdout/stderr 输出，不改文件、不发评论。

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

export function countReworkAfterReady(commits, readyAt) {
  if (!readyAt) return 0;
  const boundary = Date.parse(readyAt);
  return commits.filter(commit => Date.parse(commit.committedDate) > boundary).length;
}

// 红项口径 v2（issue #444）：从 review 正文判定行提取红项数。
// 判定格式：审官以 COMMENT 提交 review，判定写正文首行，如「判定：红 N 项」
// 「**判定：红 N 项**」「复核结论：绿，可合并」。跨全部 review 取最大 N ⇒
// 复核绿（无红数）不清零首审红项。正则配真实语料回归：语料来自 gh api 拉取的
// PR #446 / #440 真实 review body（tests/fixtures/reviews-446.json、
// reviews-440.json），断言见 tests/calibrate.tests.js，禁止 mock 内生。
const RED_FLAG_PATTERN = /红\s*(\d+)\s*项/g;

export function redFlagsFromReviewBodies(bodies) {
  let max = 0;
  for (const body of bodies || []) {
    for (const match of String(body || '').matchAll(RED_FLAG_PATTERN)) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max;
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
      rows.push({
        model,
        taskType,
        sampleCount: matched.length,
        averageRework: average(matched.map(sample => sample.rework)),
        averageRedFlags: average(matched.map(sample => sample.redFlags)),
        trend: matched.slice(-3).map(sample => ({
          number: sample.number,
          rework: sample.rework,
          redFlags: sample.redFlags,
        })),
      });
    }
  }
  return rows;
}

function renderRow(row) {
  if (row.sampleCount === 0) {
    return `| ${row.model} | ${row.taskType} | 无样本 | 无样本 | 无样本 | 无样本 |`;
  }
  const trend = row.trend
    .map(item => `#${item.number} ${item.rework}/${item.redFlags}`)
    .join(' → ');
  return `| ${row.model} | ${row.taskType} | ${row.sampleCount} | ${formatAverage(row.averageRework)} | ${formatAverage(row.averageRedFlags)} | ${trend} |`;
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
          commits(first: 100) {
            totalCount
            nodes { commit { committedDate } }
          }
          timelineItems(first: 100, itemTypes: [READY_FOR_REVIEW_EVENT]) {
            nodes { ... on ReadyForReviewEvent { createdAt } }
          }
        }
      }
    }`;
  const data = runGh([
    'api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`,
    '-F', `number=${number}`,
  ]);
  const details = data.data?.repository?.pullRequest;
  if (!details) throw new Error(`读取不到 PR #${number} 的校准数据。`);
  if (details.commits.totalCount > details.commits.nodes.length) {
    throw new Error(`PR #${number} 有 ${details.commits.totalCount} 个 commit，超过 v1 单次读取上限 100，拒绝给出不完整成绩。`);
  }
  if (details.reviews.totalCount > details.reviews.nodes.length) {
    throw new Error(`PR #${number} 有 ${details.reviews.totalCount} 条 review，超过单次读取上限 100，拒绝给出不完整成绩。`);
  }
  return {
    redFlags: Math.max(
      redFlagsFromReviewBodies((details.reviews?.nodes || []).map(node => node.body)),
      details.reviewThreads.totalCount,
    ),
    commits: details.commits.nodes.map(node => node.commit),
    readyAt: details.timelineItems.nodes
      .map(node => node.createdAt)
      .filter(Boolean)
      .sort()[0] || null,
  };
}

function measurePr(repository, pr) {
  const classification = classifyPr(pr);
  const details = pullRequestDetails(repository, pr.number);
  const readyAt = details.readyAt || (pr.isDraft ? null : pr.createdAt);
  return {
    ...pr,
    ...classification,
    readyAt,
    rework: countReworkAfterReady(details.commits, readyAt),
    redFlags: details.redFlags,
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
    `- 返工轮数：${sample.rework}`,
    `- 审查红项数：${sample.redFlags}`,
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
