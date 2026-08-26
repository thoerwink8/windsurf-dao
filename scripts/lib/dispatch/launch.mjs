// scripts/lib/dispatch/launch.mjs —— 选型/启动域（#762 拆分）
//
// 改这段前必须知道：派工启动 argv 只听 docs/model-routing.toml 的
// [providers.*].launch。scripts/lib/orca-agent-cmds.mjs 只读 Orca Desktop
// 做比较（多的建议补仓内、少的只报不删桌面），不得盖掉仓内旗标。
// 禁止在这里写死 codex / reclaude / grok 的参数。
// Orca 没查成（坏 JSON / 没扫到 settings）仍按仓内起，带 orcaReason；不挡派工。

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { loadRoutingPolicy } from '../model-routing-json.mjs';
import { normalizePipes } from '../next-launch.mjs';
import { applyOrcaAgentCmds, loadOrcaAgentCmds } from '../orca-agent-cmds.mjs';
import { DEFAULT_PROBE_WAIT_MS, ROOT, ROUTING_FILE } from './constants.mjs';

const require = createRequire(import.meta.url);
const { parse: parseToml } = require('../smol-toml.cjs');

/** 探针等屏默认值。一个所有已知情况都不成立的缺省值是陷阱：
 * grok 配 45s、codex 第一项实测 84s，没有任何 TUI 能在 8s 内跑完第一项。
 * 120s 盖住目前最慢的实测；表上仍给各 provider 显式值。
 * #559：waitAndVerify 原默认 8000ms 硬编码，pi 启动加载 skills 常常超过，
 * 派工连续死在这里——默认改为本常量，调用方再按 provider 的 probe_wait_ms 显式覆盖。 */
export function probeWaitMs(routing, provider) {
  const raw = routing?.providers?.[provider]?.probe_wait_ms;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_PROBE_WAIT_MS;
}

export function loadRoutingProviders(file = ROUTING_FILE) {
  if (!existsSync(file)) throw new Error(`路由表不在: ${file}`);
  let doc;
  try {
    doc = parseToml(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`路由表不是合法 TOML: ${String(e.message || e).split(/\r?\n/)[0]}`);
  }
  if (!doc || typeof doc !== 'object' || !doc.providers) {
    throw new Error('路由表缺 [providers] 节');
  }
  return doc;
}

export function loadRouting(file = ROUTING_FILE) {
  const providersDoc = loadRoutingProviders(file);
  const policy = loadRoutingPolicy();
  return {
    ...providersDoc,
    updated: policy.updated || providersDoc.updated,
    models: policy.models,
    routes: policy.routes,
    bans: policy.bans,
    rules: policy.rules,
    reviewerOrder: policy.reviewerOrder,
    policyBans: policy.policyBans,
    rankOrderFor: policy.rankOrderFor.bind(policy),
    pickRanked: policy.pickRanked.bind(policy),
    raw: policy.raw,
  };
}

export function resolveLaunch({
  provider, model, routing, root = ROOT, pipe, orca, orcaFile, skipOrca, env, promptFile,
} = {}) {
  if (!routing) throw new Error('resolveLaunch 没给 routing（读表失败应在 loadRouting 就抛）');
  const providers = routing.providers;
  if (!providers || typeof providers !== 'object') throw new Error('路由表缺 [providers] 节');

  const models = Array.isArray(routing.models) ? routing.models : [];
  const hit = model ? models.find(m => m && m.id === model) : null;
  if (model && !hit) throw new Error(`模型 ${model} 不在路由表`);

  const chosen = pipe || (hit ? normalizePipes(hit)[0] : null);
  let providerName = (chosen && chosen.provider) || provider || (hit && hit.provider) || null;
  if (!providerName && model && hit && !hit.provider) throw new Error(`模型 ${model} 缺 provider`);
  if (!providerName) throw new Error('要 --provider 或 --model');

  const p = providers[providerName];
  if (!p) throw new Error(`providers.${providerName} 不在路由表`);
  if (!p.launch || !String(p.launch).trim()) {
    throw new Error(`providers.${providerName} 缺 launch（启动模板）`);
  }
  const start = String(p.start || '').trim();
  if (start !== 'agent' && start !== 'command') {
    throw new Error(`providers.${providerName} 缺 start=agent|command`);
  }

  let command = String(p.launch).trim();
  let cliModel = null;
  if (command.includes('{model}')) {
    cliModel = (chosen && chosen.cli_model) || (hit && hit.cli_model) || model || p.launch_model || p.default_model;
    if (!cliModel) {
      throw new Error(`providers.${providerName}.launch 含 {model} 但没给模型（--model / launch_model / default_model）`);
    }
    command = command.split('{model}').join(String(cliModel));
  }
  if (command.includes('{prompt_file}')) {
    if (!promptFile) {
      throw new Error(`providers.${providerName}.launch 含 {prompt_file} 但没给任务书文件路径（devin 非交互形态）`);
    }
    command = command.split('{prompt_file}').join(String(promptFile));
  }
  const materialized = materializeLaunch(command, root);
  const routingLaunch = {
    provider: providerName,
    command: materialized,
    template: String(p.launch).trim(),
    pipe: chosen || null,
    agentId: orcaKnownAgentId({ provider: providerName, command: materialized }),
    start,
    launchSource: 'routing',
  };
  if (skipOrca) return routingLaunch;
  const orcaCmds = orca !== undefined ? orca : loadOrcaAgentCmds({ file: orcaFile, env });
  return applyOrcaAgentCmds(routingLaunch, orcaCmds, {
    cliModel,
    root,
    materialize: materializeLaunch,
  });
}

export function materializeLaunch(command, root = ROOT) {
  const parts = String(command).split(' ');
  if (parts[0] && /^(scripts[\\/])/.test(parts[0])) {
    parts[0] = resolve(root, parts[0]);
  }
  return parts.join(' ');
}

export function providerLaunchProblems(doc) {
  const models = Array.isArray(doc?.models) ? doc.models : [];
  const used = new Set();
  for (const m of models) {
    if (m && m.provider) used.add(m.provider);
    for (const pipe of m && Array.isArray(m.pipes) ? m.pipes : []) {
      if (pipe && pipe.provider) used.add(pipe.provider);
    }
  }
  if (used.size === 0) return { unscanned: true, problems: ['没扫到任何带 provider 的模型'] };
  const problems = [];
  for (const name of used) {
    const p = doc.providers?.[name];
    if (!p) { problems.push(`${name} 无 providers 节`); continue; }
    if (!p.launch || !String(p.launch).trim()) { problems.push(`${name} 缺 launch`); continue; }
    const start = String(p.start || '').trim();
    if (start !== 'agent' && start !== 'command') {
      problems.push(`${name} 缺 start=agent|command`);
    }
    if (String(p.launch).includes('{model}') && !p.launch_model && !p.default_model) {
      problems.push(`${name} 的 launch 含 {model} 但缺 launch_model/default_model`);
    }
  }
  return { unscanned: false, problems };
}

/** Orca `--agent` / worktree create --agent 认识的 id。
 * terminal create 没有 --agent，有特殊 argv（模型、--force、reclaude）走 --command。
 * reclaude 不能映射成 claude：`--agent claude` 起官方 claude，凭据不对。 */
export function orcaKnownAgentId({ provider, command } = {}) {
  const bin = String(command || '').trim().split(/\s+/)[0].replace(/\\/g, '/').split('/').pop().toLowerCase();
  const p = String(provider || '').toLowerCase();
  if (bin === 'cursor-agent' || bin === 'agent' || p === 'cursor') return 'cursor';
  if (bin === 'grok' || p === 'grok') return 'grok';
  if (bin === 'pi' || p === 'deepseek' || p === 'opencode-go') return 'pi';
  if (bin === 'codex' || p === 'gpt') return 'codex';
  // 2026-08-26 实测：Orca 原生支持 `--agent devin`（worktree create --agent devin 成功），
  // 不再走 command 型 --command + worker-start --terminal（会 agent_unconfigured）。
  if (bin === 'devin' || p === 'devin') return 'devin';
  return null;
}

export function launchCliModel(command) {
  const s = String(command || '');
  const long = s.match(/--model\s+(\S+)/);
  if (long) return long[1];
  const short = s.match(/(?:^|\s)-m\s+(\S+)/);
  return short ? short[1] : null;
}

/** 起法只读路由表 [providers.*].start（#680）。禁止按二进制名硬编码 agent|command。
 * --model 只传给 Cursor / Codex（orca 只认这几家）。 */
export function agentStartSpec({ provider, command, agentId, start } = {}) {
  const mode = String(start || '').trim();
  if (mode !== 'agent' && mode !== 'command') {
    throw new Error('agentStartSpec 要 start=agent|command（读路由表 [providers.*].start）');
  }
  const id = agentId || orcaKnownAgentId({ provider, command });
  const cliModel = launchCliModel(command);
  if (mode === 'agent') {
    if (!id) {
      throw new Error(`start=agent 但不知道 Orca --agent id（provider=${provider || '?'}）`);
    }
    // 2026-08-26：devin 不透传 cli_model——Orca 实测报「Agent devin does not support launch-time model selection」。
    // devin 的模型由 Orca 侧 devin agent 配置决定（默认 deepseek-v4-flash-max，见 NEW-MACHINE.md「devin 怎么配」）。
    const model = (id === 'cursor' || id === 'codex') ? cliModel : null;
    return { mode: 'agent', agentId: id, model };
  }
  return { mode: 'command', agentId: id, model: cliModel, command: command || null };
}
