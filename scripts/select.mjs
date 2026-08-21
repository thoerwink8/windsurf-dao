#!/usr/bin/env node
// scripts/select.mjs —— 点将台在线选型脚本（设计 A.1 规范路径 scripts/select.mjs）
//
// 用法：
//   node scripts/select.mjs --identity 协调者 --work-type 写码 \
//       --ts 2026-08-15T10:00:00+08:00 --job-id dj-001 [--task-tokens 40000] \
//       [--risk 低] [--reversible true] [--availability gpt-5.6-sol=忙]
//
// 纯函数纪律：无 Date.now / Math.random；选型时刻由 --ts 传入（决策票按它复算）。
// 读：policy/{models,bans,weights}.yml + 本机账本 ~/.dao/ledger/events/*.json（事件不进 git，
// 仓内历史首次使用自动种子过来）；不写任何物化文件。
// 输出：单个 JSON 到 stdout（A.4 PR 围栏块直接贴整份 stdout，含 decision_id）。
// --commit A|B|C：按写权矩阵（A.3 在线选型脚本只追加 job.opened/dispatch/handoff/
//   override/explore）把选中项落账：A → job.opened + job.dispatch；
//   B/C → 另加 job.override / job.explore（B/C 需 --pick <model>）。
//   落账事件用 scripts/lib/event-writer.mjs（一事件一文件、写一次即不可变）。
//
// 边界：只做选型 + 账本；「何时派单」归 issue #455 流转器——本脚本 stdout 可被其调用。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { parseYaml } from './lib/yaml-min.mjs';
import { select, hashOf, EVENT_ORDER_KEY } from './lib/dianjiangtai-core.mjs';
import { writeEvent, nextSeq } from './lib/event-writer.mjs';
import { ensureLocalLedger } from './lib/ledger-home.mjs';
import { loadRoutingPolicy } from './lib/model-routing-json.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function has(name) {
  return process.argv.includes(`--${name}`);
}
function usageAndExit(msg) {
  process.stderr.write(`${msg}\n`);
  process.stderr.write(
    '用法: node scripts/select.mjs --identity <帅|协调者|工人|审官> --work-type <写码|判断|查证|审查|UI|…> --ts <ISO8601> --job-id <id> [--task-tokens N] [--risk 低|中|高] [--reversible true|false] [--availability model=状态,...] [--commit A|B|C] [--pick model]\n',
  );
  process.exit(1);
}

const identity = arg('identity');
const workType = arg('work-type');
const ts = arg('ts');
const jobId = arg('job-id');
if (!identity || !workType || !ts || !jobId) usageAndExit('缺必填参数：--identity / --work-type / --ts / --job-id');

const taskTokens = arg('task-tokens') != null ? Number(arg('task-tokens')) : null;
if (taskTokens !== null && !Number.isFinite(taskTokens)) usageAndExit(`--task-tokens 必须为数字，实际 ${arg('task-tokens')}`);
const risk = arg('risk', '低');
const reversible = arg('reversible', 'true') !== 'false';
const commit = arg('commit');
const pick = arg('pick');
if (commit && !['A', 'B', 'C'].includes(commit)) usageAndExit(`--commit 只允许 A|B|C，实际 ${commit}`);
if ((commit === 'B' || commit === 'C') && !pick) usageAndExit('--commit B/C 必须 --pick <model>');
if (!commit && pick) usageAndExit('--pick 只在 --commit B/C 时有意义');

const availability = {};
for (const kv of (arg('availability') || '').split(',')) {
  if (!kv.trim()) continue;
  const [m, st] = kv.split('=');
  availability[m.trim()] = st.trim();
}

const policyDir = resolve(ROOT, arg('policy-dir', 'policy'));
const eventsDir = arg('events-dir') ? resolve(ROOT, arg('events-dir')) : ensureLocalLedger({ root: ROOT }).dir;
const schemaPath = resolve(ROOT, arg('schema', 'schemas/events.schema.json'));

const models = parseYaml(readFileSync(join(policyDir, 'models.yml'), 'utf8')).models;
const weights = parseYaml(readFileSync(join(policyDir, 'weights.yml'), 'utf8'));
const policy = loadRoutingPolicy();
const routes = policy.routes || [];
const bans = policy.policyBans || [];
const policyHash = hashOf({ models, bans, weights, routes });

const events = existsSync(eventsDir)
  ? readdirSync(eventsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(join(eventsDir, f), 'utf8')))
  : [];
events.sort(EVENT_ORDER_KEY);

const result = select({
  ts, jobId, identity, workType, taskTokens, risk, reversible,
  events, models, bans, weights, availability, policyHash, routes,
});

// ── --commit：按写权矩阵把选中项落账 ─────────────────────────────────
if (commit) {
  if (commit === 'B' || commit === 'C') {
    // 红1 修法首选：B/C 自选必须落在门闩通过集合（options.B.models）内——
    // 被 F1 禁令 / F14 上下文 / F15 可用性 剔除的模型拒写、非 0 退出。
    // 依据：设计 C.4「B 自选 = 门闩通过集合内任选（禁令不可绕过）」、E.5「唯一合法绕行口」、
    // policy/bans.yml 自述「自选与尝鲜也不可绕过禁令」。
    if (!result.options.B.models.includes(pick)) {
      process.stderr.write(`--pick ${pick} 不在门闩通过集合（B 自选位 models: ${result.options.B.models.join('/')}）内——禁令/上下文/可用性不可绕过（设计 E.5）。不落账。\n`);
      process.exit(1);
    }
  }
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const machine = os.hostname();
  const chosenModel = commit === 'A' ? result.options.A.model : pick;
  if (!chosenModel) {
    process.stderr.write(`选型无可派模型（门闩全拒？）——请检查 bans/上下文/可用性。不落账。\n`);
    process.exit(1);
  }
  const modelEntry = models.find(m => m.id === chosenModel);
  const dispatchTs = ts; // 落账时刻 = 选型时刻（调用方传入）
  const passers = result.options.B.models;
  const seq = nextSeq(eventsDir, machine);

  const opened = writeEvent({
    dir: eventsDir, type: 'job.opened', ts: dispatchTs, machine, seq,
    schema,
    payload: {
      job_id: jobId,
      task_class: arg('task-class', '未分类'),
      work_type: workType,
      identity,
      scale: arg('scale', '未知'),
      risk,
      reversible,
      task_tokens: taskTokens,
      candidate_models: passers,
      selected: result.options.A.model,
      why: `选型脚本落账（decision_id=${result.decision_id}，reason=${result.options.A.reason}）`,
    },
  });

  const dispatch = writeEvent({
    dir: eventsDir, type: 'job.dispatch', ts: dispatchTs, machine, seq: seq + 1,
    schema,
    payload: {
      job_id: jobId,
      model: chosenModel,
      identity,
      work_type: workType,
      model_version: modelEntry?.version ?? 'unknown',
      terminal: arg('terminal', 'unknown'),
      price_snapshot: result.models[chosenModel]?.cost || {},
      decision_id: result.decision_id,
    },
  });

  const written = [opened.path, dispatch.path];
  if (commit === 'B') {
    const o = writeEvent({
      dir: eventsDir, type: 'job.override', ts: dispatchTs, machine, seq: seq + 2,
      schema,
      payload: { job_id: jobId, model: chosenModel, identity, work_type: workType },
    });
    written.push(o.path);
  }
  if (commit === 'C') {
    const e = writeEvent({
      dir: eventsDir, type: 'job.explore', ts: dispatchTs, machine, seq: seq + 2,
      schema,
      payload: { job_id: jobId, model: chosenModel, identity, work_type: workType },
    });
    written.push(e.path);
  }
  result.commit = { written, note: `${commit} 位落账完成（事件写入见 written）` };
}

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
