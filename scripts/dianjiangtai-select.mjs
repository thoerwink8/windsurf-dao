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
// 路由真相源只读 origin/master 版本（issue #533），不读工作区；读不到就拒绝出推荐。
// 三选项模型标识渲染成 provider/model（#533），可直接拷进 pi --model。
//
// 选项：--routing 默认 docs/model-routing.toml，指 git 仓内 blob 路径（git show origin/master:<它>），
//       不是本地文件路径——留这个口子是为了让「读 master 失败」可构造（#533 验收样本）。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parseYaml } from './lib/yaml-min.mjs';
import { select, hashOf, EVENT_ORDER_KEY } from './lib/dianjiangtai-core.mjs';
import { pinReviewerSlotA, REVIEWER_SELECT_ROLES } from './lib/dianjiangtai-reviewer-slot.mjs';
import { attachPipes } from './lib/next-launch.mjs';

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
// 路由真相源只读 master 版本（issue #533 拍板）：选型结果不许取决于主树碰巧切在谁的分支上。
// 工作区可能在途分支（如改过 provider 的 #519）时，读工作区 = 拿一条还没生效的规则出推荐。
// 读不到 master 版本 = 本次没查成，拒绝出推荐，绝不静默回退工作区（同 [[routes]] 为 0 条的写法）。
const routingBlob = arg('routing', 'docs/model-routing.toml');
let routing;
try {
  routing = parseToml(execFileSync('git', ['show', `origin/master:${routingBlob}`], {
    encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  }));
} catch (e) {
  const detail = String(e.stderr || e.message || e).trim().split(/\r?\n/)[0].slice(0, 300);
  process.stderr.write(`路由真相源读 master 没查成（git show origin/master:${routingBlob}）——本次等于没读 master 规则，拒绝出推荐，不静默回退工作区（#533）：${detail}\n`);
  process.exit(1);
}
const routes = routing.routes || [];
if (routes.length === 0) {
  process.stderr.write('docs/model-routing.toml 里 0 条 [[routes]]——本次等于没读到分时路由，拒绝出推荐（没查成 ≠ 查过没事）。\n');
  process.exit(1);
}

const models = parseYaml(readFileSync(join(policyDir, 'models.yml'), 'utf8')).models;
const bans = parseYaml(readFileSync(join(policyDir, 'bans.yml'), 'utf8')).bans || [];
const weights = parseYaml(readFileSync(join(policyDir, 'weights.yml'), 'utf8'));
const policyHash = hashOf({ models, bans, weights, routes });

// 模型标识一律 provider/model 全称（issue #533 拍板）：显示值 = pi --model 启动参数值，
// 一个串三处同源，不可能对不上；不另造别名映射层（那层会漂移）。
// 通道来源以刚读的 master 路由表 [[models]].provider 为准（两条通道同模型名的场景只看它）；
// policy/models.yml 的 provider 只兜底主表没收录的模型（理论上两者同源一致）。
const providerByModel = new Map();
for (const m of routing.models || []) {
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

// #581→#648：审读/审查 A 位锁 GLM-5.2（GPT 暂时不可用）；B/C 仍是评分结果。
// GLM-5.2 被 UI 类 ban 剔出门闩集合时按选型序顺延。
if (REVIEWER_SELECT_ROLES.has(role)) {
  const pinned = pinReviewerSlotA({
    models,
    passerIds: result.options.B.models || [],
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

// 协调者转述用的瘦身输出：三选项 + decision_id + 分时命中。完整明细仍挂在 models/snapshot。
// 三选项的模型标识渲染成 provider/model（#533）；decision_id 与 snapshot 照旧记裸 id，不受影响。
const rawA = result.options.A;
const slate = attachPipes(result.slate || [], routing.models || []);
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
