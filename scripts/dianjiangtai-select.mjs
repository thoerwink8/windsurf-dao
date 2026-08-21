#!/usr/bin/env node
// scripts/dianjiangtai-select.mjs —— 点将台接线 CLI（包装 dianjiangtai-core）
//
// 协调者派新工位时跑这一条，把 stdout 三选项转述给帅拍板。不替代 scripts/select.mjs
// （后者带 --commit 落账）；本入口只出推荐，并把 docs/model-routing.json 分时路由
// 送进核心参与 A 位计算。
//
// 用法：
//   node scripts/dianjiangtai-select.mjs --role 写码 --ts 2026-08-15T10:00:00+08:00
//   node scripts/dianjiangtai-select.mjs --role 审读 --ts 2026-08-15T15:00:00+08:00 --job-id dj-002
//
// 纪律：选型时刻必须 --ts 传入，禁 Date.now（决策票按它复算）。
// 路由/禁令/审官序读工作区 docs/model-routing.json（2026-08-22 迁 JSON），本地改即生效。
// 三选项模型标识渲染成 provider/model（#533），可直接拷进 pi --model。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseYaml } from './lib/yaml-min.mjs';
import { select, hashOf, EVENT_ORDER_KEY } from './lib/dianjiangtai-core.mjs';
import { pinReviewerSlotA, REVIEWER_SELECT_ROLES } from './lib/dianjiangtai-reviewer-slot.mjs';
import { attachPipes } from './lib/next-launch.mjs';
import { ensureLocalLedger } from './lib/ledger-home.mjs';
import { loadRoutingPolicy } from './lib/model-routing-json.mjs';

const ROOT = resolve(import.meta.dirname, '..');

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
const eventsDir = arg('events-dir') ? resolve(ROOT, arg('events-dir')) : ensureLocalLedger({ root: ROOT }).dir;

let policy;
try {
  policy = loadRoutingPolicy();
} catch (e) {
  process.stderr.write(`选型 JSON 读失败——本次等于没查到路由规则，拒绝出推荐：${String(e.message || e).split(/\r?\n/)[0]}\n`);
  process.exit(1);
}
const routes = policy.routes || [];
if (routes.length === 0) {
  process.stderr.write('docs/model-routing.json 里 0 条分时路由——本次等于没读到路由，拒绝出推荐（没查成 ≠ 查过没事）。\n');
  process.exit(1);
}

const models = parseYaml(readFileSync(join(policyDir, 'models.yml'), 'utf8')).models;
const bans = policy.policyBans || [];
const weights = parseYaml(readFileSync(join(policyDir, 'weights.yml'), 'utf8'));
const policyHash = hashOf({ models, bans, weights, routes });

const providerByModel = new Map();
for (const m of policy.models || []) {
  if (m && m.id && m.provider) providerByModel.set(m.id, m.provider);
}
for (const m of models) {
  if (m && m.id && m.provider && !providerByModel.has(m.id)) providerByModel.set(m.id, m.provider);
}
const renderModel = id => (id == null ? null : providerByModel.has(id) ? `${providerByModel.get(id)}/${id}` : id);

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

if (REVIEWER_SELECT_ROLES.has(role)) {
  const pinned = pinReviewerSlotA({
    models,
    passerIds: result.options.B.models || [],
    order: policy.reviewerOrder,
  });
  if (pinned.model) {
    const detail = result.snapshot && result.snapshot.models
      ? result.snapshot.models[pinned.model]
      : null;
    result.options.A = {
      ...result.options.A,
      model: pinned.model,
      reason: pinned.reason,
      score: detail && detail.score != null ? detail.score : result.options.A.score,
    };
  } else {
    result.options.A = { ...result.options.A, model: null, reason: pinned.reason };
  }
}

const rawA = result.options.A;
const slate = attachPipes(result.slate || [], policy.models || []);
const out = {
  decision_id: result.decision_id,
  role,
  ts,
  work_type: workType,
  identity,
  job_id: jobId,
  route: result.snapshot.choice.route,
  options: {
    A: rawA.model == null
      ? { ...rawA }
      : { ...rawA, provider: providerByModel.get(rawA.model) ?? null, model: renderModel(rawA.model) },
    B: { ...result.options.B, models: result.options.B.models.map(renderModel) },
    C: { ...result.options.C, models: result.options.C.models.map(renderModel) },
  },
  slate,
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
