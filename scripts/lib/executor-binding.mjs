// scripts/lib/executor-binding.mjs —— 执行体绑定层（#880；本副本由卡 C 最小实现）
//
// ⚠ 合并归一：卡 B（/home/orca/wt-880b，dispatch / worktree-create / worker-start 的 mirasim
//   路径）是本层的主实现。本文件是卡 C 为 reviewer-create / worker-done 的 mirasim 路径写的
//   最小同形实现，四个导出（readExecutorPolicy / judgeExecutorName / judgeAgentRoute /
//   bindExecutor）签名与卡 B 对齐、旗标名一致。**合并时以卡 B 为准，删本文件**，
//   reviewer-mirasim.mjs 的 import 改指卡 B；若签名有出入按本文件的调用点对齐。
//
// 策略节：docs/model-routing.json 的「执行体」——默认 orca；mirasim 钉版本 / 族 / 模型前缀族 /
// agentRoutes（家族 → {agent, mode}）。判据出自 #880 issue「额度路由」拍板：
// claude 族=relay、pi=direct、gpt/kimi 云端腿=relay。

import { createRuntime, PINNED_VERSION } from './mirasim-runtime.mjs';

export const EXECUTORS = ['orca', 'mirasim'];

/** 读「执行体」策略节。吃 routing（有 .raw）或直接吃 raw doc。缺节 → 默认 orca、mirasim=null。 */
export function readExecutorPolicy(routingOrRaw) {
  const raw = routingOrRaw && routingOrRaw.raw ? routingOrRaw.raw : routingOrRaw;
  const node = raw && typeof raw === 'object' ? raw['执行体'] : null;
  const def = (node && typeof node['默认'] === 'string' && node['默认']) || 'orca';
  const mirasim = node && node.mirasim && typeof node.mirasim === 'object' ? node.mirasim : null;
  return {
    ok: EXECUTORS.includes(def),
    default: def,
    scanned: !!node,
    mirasim,
    orca: (node && node.orca) || { 说明: '现役运行时（Orca worktree + terminal）' },
    why: node ? null : '路由表没有「执行体」节（回退默认 orca；mirasim 未登记）',
  };
}

/** 执行体名判官。空 → 用默认。不认识 / mirasim 未登记 → 报错（拒派，不静默降级）。 */
export function judgeExecutorName(name, policy) {
  const def = (policy && policy.default) || 'orca';
  const n = name == null || String(name).trim() === '' ? def : String(name).trim();
  if (!EXECUTORS.includes(n)) {
    return { ok: false, name: n, error: `执行体 ${JSON.stringify(name)} 不认识（只认 ${EXECUTORS.join(' / ')}）` };
  }
  if (n === 'mirasim' && (!policy || !policy.mirasim)) {
    return { ok: false, name: n, error: 'executor=mirasim 但路由表「执行体.mirasim」没登记（没查成，拒派）' };
  }
  return { ok: true, name: n };
}

/**
 * 模型 id → mirasim 执行体的 agent 名与额度腿。
 * 家族取法：先按「模型前缀族」显式映射（最长前缀优先），取不到再退到 id 第一段
 * （gpt-5.6-luna → gpt）。agentRoutes[家族] = {agent, mode}；查不到 → 报错（拒派，不猜）。
 */
export function judgeAgentRoute(modelId, mirasimPolicy) {
  const id = modelId == null ? '' : String(modelId).trim();
  if (!id) return { ok: false, error: '判 agent 路由要模型 id（没给）' };
  if (!mirasimPolicy || typeof mirasimPolicy !== 'object') {
    return { ok: false, error: 'mirasim 策略没查成（没拿到 agentRoutes）' };
  }
  const routes = mirasimPolicy.agentRoutes && typeof mirasimPolicy.agentRoutes === 'object'
    ? mirasimPolicy.agentRoutes : null;
  if (!routes) return { ok: false, error: 'mirasim.agentRoutes 没登记（没查成，拒派）' };
  const prefixMap = mirasimPolicy['模型前缀族'] && typeof mirasimPolicy['模型前缀族'] === 'object'
    ? mirasimPolicy['模型前缀族'] : {};
  let family = null;
  let bestLen = -1;
  for (const [prefix, fam] of Object.entries(prefixMap)) {
    if ((id === prefix || id.startsWith(prefix)) && prefix.length > bestLen) {
      family = fam; bestLen = prefix.length;
    }
  }
  if (!family) family = id.split(/[-.]/)[0];
  const route = routes[family];
  if (!route || typeof route !== 'object' || !route.agent) {
    return { ok: false, family, error: `模型 ${id}（族 ${family}）在 mirasim.agentRoutes 里没有 agent 落点（没查成，拒派）` };
  }
  return { ok: true, family, agent: String(route.agent), mode: route.mode ? String(route.mode) : 'relay' };
}

/** 绑执行体。mirasim → 起一个契约钉版本的 runtime；orca → 交回调用方走原路（runtime=null）。 */
export function bindExecutor({ executor, routing, runtimeFactory = createRuntime, runtimeOpts = {} } = {}) {
  const policy = readExecutorPolicy(routing);
  const named = judgeExecutorName(executor, policy);
  if (!named.ok) return { ok: false, error: named.error, policy };
  if (named.name === 'orca') {
    return { ok: true, executor: 'orca', runtime: null, policy };
  }
  const pinned = (policy.mirasim && policy.mirasim['钉版本']) || PINNED_VERSION;
  const runtime = runtimeFactory({ pinnedVersion: pinned, ...runtimeOpts });
  return { ok: true, executor: 'mirasim', runtime, policy, mirasim: policy.mirasim, pinnedVersion: pinned };
}
