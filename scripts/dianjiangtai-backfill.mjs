#!/usr/bin/env node
// scripts/dianjiangtai-backfill.mjs —— 一次性从 GitHub 回填今日已结单事件
//
// 数据源只有 GitHub（gh pr list / gh api），禁止在脚本里造 job。
// --date 必填（北京日，YYYY-MM-DD），禁 Date.now。
// --prs 可追加指定单号（含仍开放的，只写派单、不写结单）。
// --source-json 走录好的 gh 快照（测试用），不走网络。
//
// 跑完 stdout 一行 JSON：{ written, skipped, jobs }。重跑幂等，written=0。

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  reconstructJob, writeReconstructedJobs, isClosedOnDate,
} from './lib/dianjiangtai-backfill.mjs';
import { parseYaml } from './lib/yaml-min.mjs';
import { ensureLocalLedger } from './lib/ledger-home.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function usageAndExit(msg) {
  process.stderr.write(`${msg}\n`);
  process.stderr.write(
    '用法: node scripts/dianjiangtai-backfill.mjs --date YYYY-MM-DD [--prs 460,461] [--source-json path] [--events-dir <目录>（默认本机 ~/.dao/ledger/events）]\n',
  );
  process.exit(1);
}

function runGh(args) {
  const r = spawnSync('gh', args, { windowsHide: true, encoding: 'utf8', cwd: ROOT });
  if (r.error) throw new Error(`无法运行 gh：${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`gh 失败：${String(r.stderr || r.stdout || '').trim() || r.status}`);
  }
  return JSON.parse(r.stdout);
}

function fetchReviews(number) {
  const data = runGh([
    'api', `repos/{owner}/{repo}/pulls/${number}/reviews`,
    '--paginate',
  ]);
  return (Array.isArray(data) ? data : []).map(r => ({ body: r.body || '', state: r.state }));
}

function loadFromGithub({ date, extraPrs }) {
  const listed = runGh([
    'pr', 'list', '--state', 'all', '--limit', '200',
    '--json', 'number,title,state,createdAt,mergedAt,closedAt,labels,isDraft',
  ]);
  const wanted = new Set(extraPrs);
  const picked = [];
  const seen = new Set();
  for (const pr of listed) {
    const take = isClosedOnDate(pr, date) || wanted.has(pr.number);
    if (!take || seen.has(pr.number)) continue;
    seen.add(pr.number);
    picked.push({ ...pr, reviews: fetchReviews(pr.number) });
  }
  for (const n of extraPrs) {
    if (seen.has(n)) continue;
    const pr = runGh([
      'pr', 'view', String(n),
      '--json', 'number,title,state,createdAt,mergedAt,closedAt,labels,isDraft',
    ]);
    picked.push({ ...pr, reviews: fetchReviews(n) });
  }
  return picked.sort((a, b) => a.number - b.number);
}

const date = arg('date');
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  usageAndExit('缺 --date YYYY-MM-DD（北京日，必须传入，禁用系统时钟）');
}
const extraPrs = (arg('prs') || '')
  .split(',')
  .map(s => Number(s.trim()))
  .filter(n => Number.isInteger(n) && n > 0);
const sourceJson = arg('source-json');
const eventsDir = arg('events-dir') ? resolve(ROOT, arg('events-dir')) : ensureLocalLedger({ root: ROOT }).dir;
const schemaPath = resolve(ROOT, arg('schema', 'schemas/events.schema.json'));
const modelsPath = resolve(ROOT, arg('models', 'policy/models.yml'));
const machine = arg('machine', 'backfill');

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const models = parseYaml(readFileSync(modelsPath, 'utf8')).models || [];

let prs;
if (sourceJson) {
  const p = resolve(ROOT, sourceJson);
  if (!existsSync(p)) usageAndExit(`--source-json 不在：${p}`);
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  const all = Array.isArray(raw) ? raw : (raw.prs || []);
  const extra = new Set(extraPrs);
  prs = all.filter(pr => extra.has(pr.number) || isClosedOnDate(pr, date));
} else {
  prs = loadFromGithub({ date, extraPrs });
}

const jobs = prs.map(pr => reconstructJob(pr, { models }));
const result = writeReconstructedJobs({ jobs, dir: eventsDir, schema, machine });
const out = {
  date,
  jobs: jobs.length,
  written: result.written,
  skipped: result.skipped,
  details: result.details,
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
process.stderr.write(`回填 ${result.written} 条事件（跳过 ${result.skipped}，扫描 ${jobs.length} 单）\n`);
