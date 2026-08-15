#!/usr/bin/env node
// scripts/dianjiangtai-select.mjs —— 点将台接线 CLI（包装 dianjiangtai-core）
//
// 协调者派新工位时跑这一条，把 stdout 三选项转述给帅拍板。不替代 scripts/select.mjs
// （后者带 --commit 落账）；本入口只出推荐，并把 model-routing.toml [[routes]]
// 分时路由送进核心参与 A 位计算。
//
// 用法：
//   node scripts/dianjiangtai-select.mjs --role 写码 --ts 2026-08-15T10:00:00+08:00
//   node scripts/dianjiangtai-select.mjs --role 审读 --ts 2026-08-15T15:00:00+08:00 --job-id dj-002
//
// 纪律：选型时刻必须 --ts 传入，禁 Date.now（决策票按它复算）。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parseYaml } from './lib/yaml-min.mjs';
import { select, hashOf, EVENT_ORDER_KEY } from './lib/dianjiangtai-core.mjs';

const require = createRequire(import.meta.url);
const { parse: parseToml } = require('./lib/smol-toml.cjs');

const ROOT = resolve(import.meta.dirname, '..');

// 角色别名 → (workType, 默认 identity)。审读 = 审查工种。
const ROLE_MAP = {
  写码: { workType: '写码', identity: '工人' },
  审读: { workType: '审查', identity: '审官' },
  审查: { workType: '审查', identity: '审官' },
  判断: { workType: '判断', identity: '协调者' },
  查证: { workType: '查证', identity: '工人' },
  UI: { workType: 'UI', identity: '工人' },
};

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function usageAndExit(msg) {
  process.stderr.write(`${msg}\n`);
  process.stderr.write(
    '用法: node scripts/dianjiangtai-select.mjs --role <写码|审读|审查|判断|查证|UI> --ts <ISO8601> [--job-id <id>] [--identity 帅|协调者|工人|审官] [--task-tokens N] [--risk 低|中|高]\n',
  );
  process.exit(1);
}

const role = arg('role');
const ts = arg('ts');
if (!role || !ts) usageAndExit('缺必填参数：--role / --ts（时间必须传入，禁用系统时钟）');
if (Number.isNaN(Date.parse(ts))) usageAndExit(`--ts 不是合法 ISO8601：${ts}`);

const mapped = ROLE_MAP[role];
if (!mapped) usageAndExit(`未知角色「${role}」（允许 ${Object.keys(ROLE_MAP).join('/')}）`);

const workType = arg('work-type', mapped.workType);
const identity = arg('identity', mapped.identity);
const jobId = arg('job-id', `preview-${role}`);
const taskTokens = arg('task-tokens') != null ? Number(arg('task-tokens')) : null;
if (taskTokens !== null && !Number.isFinite(taskTokens)) usageAndExit(`--task-tokens 必须为数字，实际 ${arg('task-tokens')}`);
const risk = arg('risk', '低');
const reversible = arg('reversible', 'true') !== 'false';

const policyDir = resolve(ROOT, arg('policy-dir', 'policy'));
const eventsDir = resolve(ROOT, arg('events-dir', 'ledger/events'));
const routingPath = resolve(ROOT, arg('routing', 'docs/model-routing.toml'));

if (!existsSync(routingPath)) usageAndExit(`路由真相源不在：${routingPath}`);
const routing = parseToml(readFileSync(routingPath, 'utf8'));
const routes = routing.routes || [];
if (routes.length === 0) {
  process.stderr.write('docs/model-routing.toml 里 0 条 [[routes]]——本次等于没读到分时路由，拒绝出推荐（没查成 ≠ 查过没事）。\n');
  process.exit(1);
}

const models = parseYaml(readFileSync(join(policyDir, 'models.yml'), 'utf8')).models;
const bans = parseYaml(readFileSync(join(policyDir, 'bans.yml'), 'utf8')).bans || [];
const weights = parseYaml(readFileSync(join(policyDir, 'weights.yml'), 'utf8'));
const policyHash = hashOf({ models, bans, weights, routes });

const events = existsSync(eventsDir)
  ? readdirSync(eventsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(join(eventsDir, f), 'utf8')))
  : [];
events.sort(EVENT_ORDER_KEY);

const result = select({
  ts, jobId, identity, workType, taskTokens, risk, reversible,
  events, models, bans, weights, policyHash, routes,
});

// 协调者转述用的瘦身输出：三选项 + decision_id + 分时命中。完整明细仍挂在 models/snapshot。
const out = {
  decision_id: result.decision_id,
  role,
  ts,
  work_type: workType,
  identity,
  job_id: jobId,
  route: result.snapshot.choice.route,
  options: {
    A: result.options.A,
    B: result.options.B,
    C: result.options.C,
  },
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
