// scripts/lib/orca-agent-cmds.mjs —— 读 Orca Desktop 的智能体启动命令
//
// 派工启动 argv 只听仓内 docs/model-routing.toml 的 [providers.*].launch。
// 本文件只读本机 orca-data.json（settings.agentCmdOverrides / agentDefaultArgs）
// 做比较：桌面多的建议补进仓内，少的只报不删桌面。不写回这份文件。
// 不复用 Orca 自己的解析。
//
// 没查成（文件不在 / JSON 坏 / 没扫到 settings）和「读到 0 条覆盖」必须分开：
// 前者 unscanned=true、overrideCount=null；后者 unscanned=false、overrideCount=0。
// 没查成不许当成「已经比过」；派工仍按仓内 launch 起，不挡。

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
  if (p === 'deepseek' || p === 'opencode-go' || p === 'gw') return 'pi';
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
const SKIP_COMPARE_FLAGS = new Set(['--model', '-m']);

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

/** 把启动串拆成旗标+值。模型旗标不算进比较。 */
export function parseLaunchFlagPairs(command) {
  const tokens = String(command || '').trim().split(/\s+/).filter(Boolean);
  const pairs = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (i === 0 && !t.startsWith('-')) continue;
    if (!(t.startsWith('--') || t === '-m' || /^-[A-Za-z]$/.test(t))) continue;
    let flag = t;
    let value = true;
    const eq = t.indexOf('=');
    if (eq > 1) {
      flag = t.slice(0, eq);
      value = t.slice(eq + 1);
    } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
      value = tokens[++i];
    }
    if (SKIP_COMPARE_FLAGS.has(flag)) continue;
    pairs.push({ flag, value });
  }
  return pairs;
}

/** 仓内 argv vs 桌面 argv：多的 / 少的 / 同旗标不同值。不改任何一边。 */
export function compareLaunchFlags({ routingCommand, desktopCommand } = {}) {
  const routingBy = new Map();
  for (const p of parseLaunchFlagPairs(routingCommand)) {
    if (!routingBy.has(p.flag)) routingBy.set(p.flag, p.value);
  }
  const desktopBy = new Map();
  for (const p of parseLaunchFlagPairs(desktopCommand)) {
    if (!desktopBy.has(p.flag)) desktopBy.set(p.flag, p.value);
  }
  const extraDesktopFlags = [];
  const droppedFlags = [];
  const desktopFlagDiffs = [];
  for (const [flag, value] of routingBy) {
    if (!desktopBy.has(flag)) droppedFlags.push(flag);
    else if (String(desktopBy.get(flag)) !== String(value)) {
      desktopFlagDiffs.push({ flag, routing: String(value), desktop: String(desktopBy.get(flag)) });
    }
  }
  for (const [flag] of desktopBy) {
    if (!routingBy.has(flag)) extraDesktopFlags.push(flag);
  }
  return { extraDesktopFlags, droppedFlags, desktopFlagDiffs };
}

export function formatDesktopLaunchNotes(launch = {}) {
  const lines = [];
  if (Array.isArray(launch.droppedFlags) && launch.droppedFlags.length) {
    lines.push(`Orca 桌面比仓内少这些旗标（只报，不删桌面）：${launch.droppedFlags.join(' ')}。派工已按仓内 launch 起。`);
  }
  if (Array.isArray(launch.extraDesktopFlags) && launch.extraDesktopFlags.length) {
    lines.push(`Orca 桌面比仓内多这些旗标（建议补进仓内 docs/model-routing.toml）：${launch.extraDesktopFlags.join(' ')}。派工仍按仓内起，没改桌面文件。`);
  }
  if (Array.isArray(launch.desktopFlagDiffs) && launch.desktopFlagDiffs.length) {
    const bits = launch.desktopFlagDiffs.map((d) => `${d.flag} 仓内=${d.routing} 桌面=${d.desktop}`);
    lines.push(`Orca 桌面与仓内同旗标不同值（不覆盖仓内）：${bits.join('；')}。`);
  }
  return lines;
}

/**
 * 比较桌面启动串，不改仓内 argv。
 * 文件不在 / JSON 坏 / 没扫到 settings → 仍走仓内，带 orcaReason；不挡派工。
 */
export function applyOrcaAgentCmds(launch, orcaCmds, { cliModel, root, materialize } = {}) {
  if (!launch) throw new Error('applyOrcaAgentCmds 没给 launch');
  if (!orcaCmds) return { ...launch, launchSource: 'routing' };
  if (orcaCmds.unscanned) {
    return { ...launch, launchSource: 'routing', orcaReason: orcaCmds.reason || 'unscanned' };
  }
  const key = orcaAgentKey(launch);
  const hit = key ? orcaCmds.agents?.[key] : null;
  if (!hit) {
    return { ...launch, launchSource: 'routing', orcaReason: 'no-agent', orcaAgent: key };
  }
  const compared = compareLaunchFlags({
    routingCommand: launch.command,
    desktopCommand: hit.launch,
  });
  return {
    ...launch,
    launchSource: 'routing',
    orcaCompared: true,
    orcaAgent: key,
    orcaLaunch: hit.launch,
    extraDesktopFlags: compared.extraDesktopFlags,
    droppedFlags: compared.droppedFlags,
    desktopFlagDiffs: compared.desktopFlagDiffs,
  };
}
