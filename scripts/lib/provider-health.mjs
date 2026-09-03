// scripts/lib/provider-health.mjs —— 消费健康表 + 熔断表（#842 F15 插线；#843 熔断）
//
// 健康表 ~/.dao/provider-health.json（Contabo 上由 ai-gateway-stack 探针写，本仓只读）：
//   { updatedAt, intervalMin, targets: { "<key>": { state:green|red|unscanned, code, ms, ... } } }
//   过期（now-updatedAt > 2×intervalMin）或缺失 → unknown：**不拦**，但选型输出注明「健康表没查成」。
//   红 → availability:red：**不直接拦**，只把它排到后面先探绿的（红可能已恢复，照探；消歧记录）。
//   绿 → 空闲。
//
// 熔断表 ~/.dao/provider-breaker.json（#843 熔断单写，本仓只读判）：
//   { updatedAt, targets: { "<key>": { state:closed|open|half-open, cooldownUntil:ISO, why } } }
//   open 且 cooldownUntil 未到 → availability:cooldown(until …)：**直接拦**（区别于健康表红只后置）。
//   half-open → 后置、只探一针。closed / 缺该 key → 无熔断。
//   文件缺失 = 无熔断（不是没查成，不出 note）。
//
// key 与健康表同形（gw:<组短名>/<模型> / direct:codex@pqapi/responses），由 probeTargetOf 算。

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { probeTargetOf } from './provider-probe.mjs';
import { normalizePipes } from './next-launch.mjs';

const HEALTH_PATH = ['.dao', 'provider-health.json'];
const BREAKER_PATH = ['.dao', 'provider-breaker.json'];
const DEFAULT_INTERVAL_MIN = 30;

/** 模型/名单条目 → 落地 { provider, cli_model }。兼容 routing 模型（含 pipes）与裸模型。 */
function landingOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (Array.isArray(entry.pipes) && entry.pipes[0] && entry.pipes[0].provider) {
    return { provider: String(entry.pipes[0].provider), cli_model: entry.pipes[0].cli_model };
  }
  const pipes = normalizePipes(entry);
  return pipes[0] || null;
}

function idOf(entry) {
  if (entry && typeof entry === 'object') return entry.id != null ? String(entry.id) : null;
  return entry != null ? String(entry) : null;
}

/** 读健康表。缺失 / 坏 JSON / 过期 → unknown（不拦，注明）。 */
export function loadHealthTable({ home = os.homedir(), read = readFileSync, exists = existsSync, now = Date.now() } = {}) {
  const path = join(home, ...HEALTH_PATH);
  if (!exists(path)) {
    return { ok: true, present: false, unknown: true, table: null, reason: '健康表文件不在', path };
  }
  let doc;
  try {
    doc = JSON.parse(read(path, 'utf8'));
  } catch (e) {
    return { ok: true, present: true, unknown: true, table: null, reason: `健康表不是 JSON：${String(e.message || e)}`, path };
  }
  const intervalMin = Number(doc.intervalMin) > 0 ? Number(doc.intervalMin) : DEFAULT_INTERVAL_MIN;
  const updatedMs = Date.parse(doc.updatedAt || '');
  if (!Number.isFinite(updatedMs)) {
    return { ok: true, present: true, unknown: true, table: null, reason: '健康表缺 updatedAt', path, intervalMin };
  }
  const ageMs = now - updatedMs;
  const maxAgeMs = 2 * intervalMin * 60 * 1000;
  if (ageMs > maxAgeMs) {
    const ageMin = Math.round(ageMs / 60000);
    return {
      ok: true, present: true, unknown: true, table: null, intervalMin, updatedAt: doc.updatedAt, path,
      reason: `健康表过期（${ageMin}min > 2×${intervalMin}min）`,
    };
  }
  const targets = doc.targets && typeof doc.targets === 'object' ? doc.targets : {};
  return { ok: true, present: true, unknown: false, table: targets, intervalMin, updatedAt: doc.updatedAt, path };
}

/** 读熔断表。缺失 = 无熔断（present:false，不出 note、不是没查成）。 */
export function loadBreaker({ home = os.homedir(), read = readFileSync, exists = existsSync } = {}) {
  const path = join(home, ...BREAKER_PATH);
  if (!exists(path)) return { ok: true, present: false, targets: {}, path };
  let doc;
  try {
    doc = JSON.parse(read(path, 'utf8'));
  } catch (e) {
    // 坏 JSON：当没查成——熔断是「直接拦」的重手，读不清不冒进拦，只出一条 note。
    return { ok: true, present: true, unscanned: true, targets: {}, path, reason: `熔断表不是 JSON：${String(e.message || e)}` };
  }
  const targets = doc.targets && typeof doc.targets === 'object' ? doc.targets : {};
  return { ok: true, present: true, targets, updatedAt: doc.updatedAt, path };
}

/**
 * availabilityFor(models, opts) → {
 *   availability: { modelId: '空闲'|'red'|'cooldown(until …)' },  // 标签（cooldown = 直接拦）
 *   hardBlocked:  { modelId: 'cooldown(until …)' },                // 熔断 open 未到冷却：直接拦
 *   deprioritize: Set<modelId>,                                    // 健康红 / 熔断 half-open：后置照探
 *   reasons:      { modelId: string[] },                           // availability:red / availability:cooldown(...)
 *   notes:        string[],                                        // 「健康表没查成」等
 *   unknown:      bool,
 * }
 * models：routing 模型数组或名单条目数组（各带 id + 落地）。
 */
export function availabilityFor(models, opts = {}) {
  const list = Array.isArray(models) ? models : [];
  const health = opts.health || loadHealthTable(opts);
  const breaker = opts.breaker || loadBreaker(opts);
  const now = opts.now != null ? opts.now : Date.now();

  const availability = {};
  const hardBlocked = {};
  const deprioritize = new Set();
  const reasons = {};
  const notes = [];
  let healthNoteAdded = false;
  let breakerNoteAdded = false;

  for (const entry of list) {
    const id = idOf(entry);
    if (!id) continue;
    const target = probeTargetOf(landingOf(entry));
    const rs = [];

    // 熔断优先：open 未到冷却 = 直接拦。
    if (target && breaker && breaker.targets && breaker.targets[target]) {
      const b = breaker.targets[target];
      const st = String(b.state || '');
      if (st === 'open') {
        const untilMs = Date.parse(b.cooldownUntil || '');
        if (Number.isFinite(untilMs) && untilMs > now) {
          const label = `cooldown(until ${b.cooldownUntil})`;
          availability[id] = label;
          hardBlocked[id] = label;
          rs.push(`availability:${label}`);
          reasons[id] = rs;
          continue; // 直接拦，不再看健康表
        }
        // open 但冷却已到：当 half-open 处理（后置探一针）
        deprioritize.add(id);
        rs.push('breaker:open-cooldown-elapsed');
      } else if (st === 'half-open') {
        deprioritize.add(id);
        rs.push('breaker:half-open');
      }
    }
    if (breaker && breaker.unscanned && !breakerNoteAdded) {
      notes.push(`熔断表没查成（${breaker.reason || '坏 JSON'}），本轮不据它拦`);
      breakerNoteAdded = true;
    }

    // 健康表：unknown 不拦但注明；红后置照探；绿空闲。
    if (health.unknown) {
      availability[id] = '空闲';
      if (!healthNoteAdded) {
        notes.push(`健康表没查成（${health.reason || 'unknown'}），unknown 不拦但也不当绿`);
        healthNoteAdded = true;
      }
    } else {
      const h = target && health.table ? health.table[target] : null;
      const st = h ? String(h.state || '') : '';
      if (st === 'red') {
        availability[id] = availability[id] || 'red';
        deprioritize.add(id);
        rs.push('availability:red');
      } else if (st === 'green') {
        availability[id] = availability[id] || '空闲';
      } else {
        // 该 target 不在表里 / unscanned：不拦，当 unknown 那格处理（不注全局 note，避免刷屏）
        availability[id] = availability[id] || '空闲';
        if (target && !h) rs.push('health:absent');
      }
    }
    if (rs.length) reasons[id] = rs;
  }

  return {
    availability,
    hardBlocked,
    deprioritize,
    reasons,
    notes,
    unknown: !!health.unknown,
    healthPath: health.path,
    breakerPresent: !!(breaker && breaker.present),
  };
}
