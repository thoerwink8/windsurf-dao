// scripts/lib/orca-agent-cmds.mjs —— 读 Orca Desktop 的智能体启动命令
//
// 真相源是本机 orca-data.json 的 settings.agentCmdOverrides / agentDefaultArgs。
// 最终启动 ≈ override ?? 内置名（键本身）+ defaultArgs。
// 不复用 Orca 自己的解析，不写回这份文件。
//
// 没查成（文件不在 / JSON 坏 / 没扫到 settings）和「读到 0 条覆盖」必须分开：
// 前者 unscanned=true、overrideCount=null；后者 unscanned=false、overrideCount=0。
// 没查成不许当成「Orca 没有覆盖」。

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ORCA_DATA_REL = join('profiles', 'local-default', 'orca-data.json');

function failScan(reason, error, file) {
  return {
    ok: false,
    unscanned: true,
    reason,
    error,
    file: file || null,
    overrides: null,
    defaultArgs: null,
    agents: null,
    overrideCount: null,
    agentCount: null,
  };
}

/** 路径序：显式 file → ORCA_DATA_JSON → ORCA_HOME → %APPDATA%/orca → ~/AppData/Roaming/orca */
export function resolveOrcaDataPath({ file, env = process.env } = {}) {
  if (file) return String(file);
  if (env.ORCA_DATA_JSON) return String(env.ORCA_DATA_JSON);
  if (env.ORCA_HOME) return join(String(env.ORCA_HOME), ORCA_DATA_REL);
  if (env.APPDATA) return join(String(env.APPDATA), 'orca', ORCA_DATA_REL);
  const home = env.USERPROFILE || env.HOME;
  if (home) return join(String(home), 'AppData', 'Roaming', 'orca', ORCA_DATA_REL);
  return join(homedir(), 'AppData', 'Roaming', 'orca', ORCA_DATA_REL);
}

function asStringMap(raw, label) {
  if (raw == null) return { ok: true, map: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `settings.${label} 不是对象（没查成，不是 0 条覆盖）` };
  }
  const map = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') map[k] = v;
  }
  return { ok: true, map };
}

function assembleAgent(id, overrides, defaultArgs) {
  const command = Object.prototype.hasOwnProperty.call(overrides, id) && String(overrides[id]).trim()
    ? String(overrides[id]).trim()
    : id;
  const args = Object.prototype.hasOwnProperty.call(defaultArgs, id) ? defaultArgs[id] : '';
  const trimmed = String(args).trim();
  return {
    command,
    args,
    launch: trimmed ? `${command} ${trimmed}` : command,
    overridden: Object.prototype.hasOwnProperty.call(overrides, id),
  };
}

/**
 * 读一份 orca-data.json（测试传 file；生产走默认路径）。
 * 禁止拿本机真文件当测试的唯一路径。
 */
export function loadOrcaAgentCmds({ file, env = process.env } = {}) {
  const resolved = resolveOrcaDataPath({ file, env });
  if (!resolved) {
    return failScan('no-path', '没定下 orca-data.json 路径（没查成，不是 0 条覆盖）');
  }
  if (!existsSync(resolved)) {
    return failScan('missing-file', `orca-data.json 不在: ${resolved}（没查成，不是 0 条覆盖）`, resolved);
  }
  let raw;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (e) {
    return failScan('unreadable', `orca-data.json 读失败: ${String(e.message || e)}（没查成，不是 0 条覆盖）`, resolved);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return failScan('bad-json', `orca-data.json 不是合法 JSON: ${String(e.message || e)}（没查成，不是 0 条覆盖）`, resolved);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return failScan('no-settings', 'orca-data.json 根不是对象（没查成，不是 0 条覆盖）', resolved);
  }
  if (!doc.settings || typeof doc.settings !== 'object' || Array.isArray(doc.settings)) {
    return failScan('no-settings', 'orca-data.json 没扫到 settings（没查成，不是 0 条覆盖）', resolved);
  }

  const overridesGot = asStringMap(doc.settings.agentCmdOverrides, 'agentCmdOverrides');
  if (!overridesGot.ok) return failScan('bad-overrides', overridesGot.error, resolved);
  const argsGot = asStringMap(doc.settings.agentDefaultArgs, 'agentDefaultArgs');
  if (!argsGot.ok) return failScan('bad-args', argsGot.error, resolved);

  const overrides = overridesGot.map;
  const defaultArgs = argsGot.map;
  const agents = {};
  for (const id of new Set([...Object.keys(overrides), ...Object.keys(defaultArgs)])) {
    agents[id] = assembleAgent(id, overrides, defaultArgs);
  }
  return {
    ok: true,
    unscanned: false,
    reason: 'ok',
    error: null,
    file: resolved,
    overrides,
    defaultArgs,
    agents,
    overrideCount: Object.keys(overrides).length,
    agentCount: Object.keys(agents).length,
  };
}

/** 仓内 provider → Orca 智能体键。认不出就 null，调用方回落 routing。 */
export function orcaAgentKey({ provider, command, cli } = {}) {
  const p = String(provider || '').toLowerCase();
  if (p === 'gpt') return 'codex';
  if (p === 'claude') return 'claude';
  if (p === 'grok') return 'grok';
  if (p === 'cursor') return 'cursor';
  if (p === 'commandcode' || p === 'command-code') return 'command-code';
  if (p === 'devin') return 'devin';
  if (p === 'deepseek' || p === 'opencode-go') return 'pi';
  const bin = String(cli || command || '').trim().split(/\s+/)[0]
    .replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (bin === 'codex') return 'codex';
  if (bin === 'reclaude' || bin === 'claude') return 'claude';
  if (bin === 'grok') return 'grok';
  if (bin === 'cursor-agent' || bin === 'cursor' || bin === 'agent') return 'cursor';
  if (bin === 'command-code' || bin === 'cmdc') return 'command-code';
  if (bin === 'devin') return 'devin';
  if (bin === 'pi') return 'pi';
  return null;
}

function hasModelFlag(command) {
  return /(?:^|\s)(?:--model|-m)\s+\S+/.test(String(command || ''));
}

/** Orca 串接上 routing 的 {model} 写法；Orca 已带模型旗标则不改。 */
export function mergeOrcaLaunch(hit, { template, cliModel } = {}) {
  if (!hit || !hit.launch) return null;
  let command = hit.launch;
  const model = cliModel ? String(cliModel) : '';
  if (!model || hasModelFlag(command)) return command;
  const tmpl = String(template || '');
  if (/--model\s+\{model\}/.test(tmpl)) return `${command} --model ${model}`;
  if (/(?:^|\s)-m\s+\{model\}/.test(tmpl)) return `${command} -m ${model}`;
  return command;
}

const FLAG_RE = /(?:^|\s)(--[a-z][a-z0-9-]*|-m)(?=\s|$)/gi;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * routing 模板里有、Orca 启动串里没有的旗标（{model} 占位与模型旗标不算——
 * 模型由 mergeOrcaLaunch 单独接）。grok 的 --always-approve、cursor 的 --force --trust、
 * devin 的 --permission-mode 这类保命旗标被静默丢掉时会卡框叫醒帅，必须显形。
 */
export function droppedRoutingFlags({ template, launch } = {}) {
  const tmpl = String(template || '').replace(/\{model\}/g, ' ');
  const cmd = String(launch || '');
  const dropped = [];
  for (const m of tmpl.matchAll(FLAG_RE)) {
    const flag = m[1];
    if (flag === '--model' || flag === '-m') continue;
    if (dropped.includes(flag)) continue;
    if (!new RegExp(`(?:^|\\s)${escapeRe(flag)}(?=\\s|$)`).test(cmd)) dropped.push(flag);
  }
  return dropped;
}

/**
 * 把已解析的 routing launch 叠上 Orca。
 * 文件不在 → 回落 routing（CI / 没装 Orca）。
 * JSON 坏 / 没扫到 settings → 抛，不许当「没有覆盖」。
 */
export function applyOrcaAgentCmds(launch, orcaCmds, { cliModel, root, materialize } = {}) {
  if (!launch) throw new Error('applyOrcaAgentCmds 没给 launch');
  if (!orcaCmds) return { ...launch, launchSource: 'routing' };
  if (orcaCmds.unscanned) {
    if (orcaCmds.reason === 'missing-file') {
      return { ...launch, launchSource: 'routing', orcaReason: 'missing-file' };
    }
    throw new Error(`Orca 启动命令没查成: ${orcaCmds.error || orcaCmds.reason}（没查成不许当没有覆盖）`);
  }
  const key = orcaAgentKey(launch);
  const hit = key ? orcaCmds.agents?.[key] : null;
  if (!hit) {
    return { ...launch, launchSource: 'routing', orcaReason: 'no-agent', orcaAgent: key };
  }
  const merged = mergeOrcaLaunch(hit, { template: launch.template, cliModel });
  const dropped = droppedRoutingFlags({ template: launch.template, launch: merged });
  const command = typeof materialize === 'function' ? materialize(merged, root) : merged;
  return {
    ...launch,
    command,
    launchSource: 'orca',
    orcaAgent: key,
    orcaLaunch: hit.launch,
    ...(dropped.length ? { droppedFlags: dropped } : {}),
  };
}
