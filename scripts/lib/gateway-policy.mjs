#!/usr/bin/env node
// 探针用的策略读取 + 探测面派生（#967 从 /home/orca/bin 收进本仓）。
//
// 策略 JSON 的真相源仍是 ai-gateway-stack（pools / 降级腿 / probe.targets）。
// 本文件只放探针要的两件事：把 JSON 读进来校验、算出 probePlan。
// 部署脚本、drift 审计、熔断阈值那些派生规则不在这里——它们跟着 JSON 住在网关仓。
import fs from 'node:fs';
import path from 'node:path';

// 六节里探针只用 pools + probe；其余节网关仓会继续加，多了不挡、少了这两节才抛。
const SECTIONS = ['pools', 'probe'];

/** 策略文件候选：显式参数 / 环境变量优先，再按机器上的已知落点找。 */
export function policyCandidates(file) {
  const raw = [
    file,
    process.env.GW_POLICY,
    '/opt/gateway-policy.json',
    '/srv/projects/ai-gateway-stack/docs/gateway-policy.json',
    '/home/orca/bin/gateway-policy.json',
  ].filter(Boolean);
  const seen = new Set();
  return raw.filter((f) => (seen.has(f) ? false : (seen.add(f), true)));
}

export function loadPolicy(file) {
  const candidates = policyCandidates(file);
  const found = candidates.find((f) => fs.existsSync(f));
  if (!found) throw new Error(`gateway-policy.json 不在（试过 ${candidates.join('、')}）`);
  const policy = JSON.parse(fs.readFileSync(found, 'utf8'));
  const missing = SECTIONS.filter((s) => policy[s] == null);
  if (missing.length) throw new Error(`gateway-policy 缺节：${missing.join('、')}（${found}）`);
  const noWhy = SECTIONS.filter((s) => typeof policy[s].why !== 'string' || !policy[s].why);
  if (noWhy.length) throw new Error(`gateway-policy 这些节缺 why：${noWhy.join('、')}`);
  if (!Array.isArray(policy.pools.list) || !policy.pools.list.length) throw new Error('pools.list 不能为空');
  for (const pool of policy.pools.list) {
    if (!pool.alias || !pool.group || !Array.isArray(pool.legs) || !pool.legs.length) {
      throw new Error(`池 ${pool.group || pool.alias || '?'} 缺 alias/group/legs`);
    }
    for (const leg of pool.legs) {
      if (!leg.nameLike || typeof leg.priority !== 'number') {
        throw new Error(`池 ${pool.group} 有腿缺 nameLike 或 priority 不是数字`);
      }
    }
  }
  checkPriorityGradient(policy);
  return policy;
}

// priority 是渠道级全局字段：同一渠道跨池必须同值，不同渠道不许撞值。
export function checkPriorityGradient(policy) {
  const byChannel = new Map();
  const byPriority = new Map();
  for (const pool of policy.pools.list) {
    for (const leg of pool.legs) {
      const prev = byChannel.get(leg.nameLike);
      if (prev && prev.priority !== leg.priority) {
        throw new Error(`priority 冲突：渠道 ${leg.nameLike} 在 ${prev.pool} 是 ${prev.priority}、在 ${pool.group} 是 ${leg.priority}`);
      }
      byChannel.set(leg.nameLike, { priority: leg.priority, pool: pool.group });
      const holder = byPriority.get(leg.priority);
      if (holder && holder !== leg.nameLike) {
        throw new Error(`priority 撞值：${holder} 与 ${leg.nameLike} 都是 ${leg.priority}`);
      }
      byPriority.set(leg.priority, leg.nameLike);
    }
  }
}

// 探针探测面从策略派生：pool / leg / direct 三类 target 一处算。
// 健康表 key 前缀（gw:/leg:/direct:）是两仓共用契约，本仓 #842 按前缀分类消费。
export function probePlan(policy) {
  const p = policy.probe || {};
  const pools = (p.targets || []).map((t) => ({
    key: `gw:${t.group}/${t.model}`, kind: 'pool', group: t.group, model: t.model,
  }));
  const legs = [];
  const seen = new Set();
  for (const pool of policy.pools.list) {
    for (const leg of pool.legs) {
      if (seen.has(leg.nameLike)) continue;
      seen.add(leg.nameLike);
      legs.push({
        key: `leg:${leg.nameLike}`, kind: 'leg', nameLike: leg.nameLike,
        model: leg.real || pool.alias,
      });
    }
  }
  const direct = (p.direct || []).map((d) => ({ ...d, kind: 'direct' }));
  return {
    intervalMin: p.intervalMin, strikesToAlert: p.strikesToAlert, heartbeatDays: p.heartbeatDays,
    healthFile: p.healthFile, legsEndpoint: p.legsEndpoint, channel: p.channel,
    pools, legs, direct,
  };
}
