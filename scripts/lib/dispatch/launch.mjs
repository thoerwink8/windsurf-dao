// scripts/lib/dispatch/launch.mjs —— 选型/启动域（#768 从 dao-cmd.mjs 拆出，对外 API 不变）
//
// 改这段前必须知道：派工启动 argv 只听 docs/model-routing.toml 的
// [providers.*].launch。scripts/lib/orca-agent-cmds.mjs 只读 Orca Desktop
// 做比较（多的建议补仓内、少的只报不删桌面），不得盖掉仓内旗标。
// 禁止在这里写死 codex / reclaude / grok 的参数。
// Orca 没查成（坏 JSON / 没扫到 settings）仍按仓内起，带 orcaReason；不挡派工。
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadRoutingPolicy } from '../model-routing-json.mjs';
import { normalizePipes } from '../next-launch.mjs';
import { applyOrcaAgentCmds, loadOrcaAgentCmds } from '../orca-agent-cmds.mjs';
import { ROOT, ROUTING_FILE } from './constants.mjs';

const require = createRequire(import.meta.url);
const { parse: parseToml } = require('../smol-toml.cjs');

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
  provider, model, routing, root = ROOT, pipe, orca, orcaFile, skipOrca, env,
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
/** #633：worktree create 回包经常没有 startupTerminal，要用 terminal list 找默认空壳。 */

export function unwrapTerminalList(json) {
  const list = json?.result?.terminals;
  if (!Array.isArray(list)) {
    return { ok: false, unscanned: true, error: 'terminal list 结构不认识', terminals: [] };
  }
  return { ok: true, unscanned: false, terminals: list };
}

export function looksLikeAgentPreview(text) {
  return /Grok Build|always-approve|ctrl\+q|╭─|╰─/i.test(String(text || ''));
}

export function looksLikeShellPrompt(text) {
  const s = String(text || '').trimEnd();
  if (!s) return false;
  if (looksLikeAgentPreview(s)) return false;
  return /(?:^|\n)PS .*>\s*$/.test(s)
    || /(?:^|\n)[A-Z]:\\[^>\n]*>\s*$/.test(s)
    || /(?:^|\n)\$\s*$/.test(s);
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
    const model = (id === 'cursor' || id === 'codex') ? cliModel : null;
    return { mode: 'agent', agentId: id, model };
  }
  return { mode: 'command', agentId: id, model: cliModel, command: command || null };
}
/** 建卡默认空壳：title 为 null / 空 / "Terminal N"；已是 agent 的不碰。
 * 只拿来关，禁止 send 启动命令进去。 */
export function isReusableDefaultTerminal(term) {
  if (!term || !term.handle) return false;
  if (term.orphaned) return false;
  if (term.connected === false || term.writable === false) return false;
  const title = term.title;
  const titleOk = title == null || title === '' || /^Terminal\s+\d+$/i.test(String(title).trim());
  if (!titleOk) return false;
  const preview = String(term.preview || '');
  if (preview && looksLikeAgentPreview(preview)) return false;
  return true;
}

export function findReusableDefaultTerminal(listJson, { worktreeId } = {}) {
  const unwrapped = unwrapTerminalList(listJson);
  if (!unwrapped.ok) {
    return { ok: false, unscanned: true, error: unwrapped.error, handle: null };
  }
  let terms = unwrapped.terminals;
  if (worktreeId && String(worktreeId).includes('::')) {
    terms = terms.filter(t => t.worktreeId === worktreeId);
  }
  const hits = terms.filter(isReusableDefaultTerminal);
  if (hits.length === 0) {
    return { ok: true, unscanned: false, handle: null, reason: '没有默认空壳终端' };
  }
  return { ok: true, unscanned: false, handle: hits[0].handle, terminal: hits[0] };
}
/**
 * #633：空壳一律先关再 create，禁止 send 进 pwsh 当复用。
 * leftoverIfCreateNow=true 表示「现在直接 create 会留下第二个终端」。
 */
export function planLaunchFallback({ foundHandle } = {}) {
  if (foundHandle) {
    return { action: 'close-then-create', closeHandle: foundHandle, leftoverIfCreateNow: true };
  }
  return { action: 'create', closeHandle: null, leftoverIfCreateNow: false };
}
/** 按启动计划演算终态 handle 列表。用来证明 close-then-create 不会留第二个终端。 */

export function terminalsAfterLaunchPlan({ existingHandles, plan, createdHandle } = {}) {
  const next = new Set(Array.isArray(existingHandles) ? existingHandles : []);
  if (!plan || plan.action === 'reuse') return [...next];
  if (plan.closeHandle) next.delete(plan.closeHandle);
  if (createdHandle) next.add(createdHandle);
  return [...next];
}

export const CODEX_CAPABLE_FLAG = '--dangerously-bypass-approvals-and-sandbox';

export const PROBE_LABELS = { write: '能写文件', node: '能跑 node', gh: '能调 gh' }
/** 只在真执行的 stdout 里出现；命令原文里不能有这个形态（否则回显即自证）。 */

export const PROBE_MARK_RE = {
  write: /\bW\d{13}\b/,
  node: /\bN\d{13}\b/,
  gh: /gh version \d/i,
}

export function probeMarkFound(name, text) {
  const re = PROBE_MARK_RE[name];
  return !!(re && re.test(String(text || '')));
}
/** 任何 codex launch 都必须带 danger 旗标。工人和审官同一把尺子。 */

export function assertCodexLaunch({ command } = {}) {
  const cmd = String(command || '');
  if (!/\bcodex\b/.test(cmd)) return { ok: true };
  if (!cmd.includes(CODEX_CAPABLE_FLAG)) {
    return {
      ok: false,
      error: `codex launch 缺 ${CODEX_CAPABLE_FLAG}，会起成哑终端（-a never 单用会拦 gh/node）`,
    };
  }
  return { ok: true };
}

export function assertReviewerLaunch(opts) {
  return assertCodexLaunch(opts);
}

export const WRITE_PROBE_FILE = '_dao_probe_w';
/** 写→读回核对→finally 必删。成功才打 W+时间戳。 */

export function writeProbeScript() {
  return [
    "var t=Date.now(),f=require('fs'),ok=false;",
    "try{f.writeFileSync('_dao_probe_w',String(t));",
    "ok=f.readFileSync('_dao_probe_w','utf8')===String(t)}",
    "finally{try{f.unlinkSync('_dao_probe_w')}catch(e){}}",
    "if(ok)process.stdout.write('W'+t)",
  ].join('');
}

export function probeCommand(name) {
  if (name === 'write') return `node -e ${JSON.stringify(writeProbeScript())}`;
  if (name === 'node') {
    return `node -e "process.stdout.write('N'+Date.now())"`;
  }
  if (name === 'gh') {
    return 'gh --version';
  }
  throw new Error(`未知探针 ${name}`);
}
/**
 * 探针必须走目标终端：send 命令，在屏面找「只有真执行才会出现」的标记。
 * 不能找命令原文里的字面量——回显/Ran xxx 会自证。
 * sendAndRead(cmd, name) → { text, error }。
 */
export function terminalProbeExec({ sendAndRead } = {}) {
  if (typeof sendAndRead !== 'function') throw new Error('terminalProbeExec 要 sendAndRead');
  return (name) => {
    let cmd;
    try { cmd = probeCommand(name); }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
    const r = sendAndRead(cmd, name);
    if (!r || r.error) return { ok: false, unread: true, error: r?.error || '没读成' };
    const text = String(r.text || '');
    const ok = probeMarkFound(name, text);
    return {
      ok,
      text,
      error: ok ? undefined : '终端没有真执行标记（命令回显或 policy 拦截都不算）',
    };
  };
}

export function runCapabilityProbes({ exec } = {}) {
  if (typeof exec !== 'function') throw new Error('runCapabilityProbes 要 exec');
  const failed = [];
  const details = {};
  for (const name of ['write', 'node', 'gh']) {
    const r = exec(name);
    details[name] = r;
    if (!r || !r.ok) failed.push(name);
  }
  return {
    ok: failed.length === 0,
    failed,
    details,
    error: failed.length ? `能力探针失败：缺 ${failed.map(k => PROBE_LABELS[k]).join('、')}` : null,
  };
}

export function hostProbeExec(cwd = process.cwd()) {
  return (name) => {
    if (name === 'write') {
      const p = join(cwd, '_dao_probe_write.txt');
      try {
        writeFileSync(p, 'ok\n');
        const ok = existsSync(p);
        try { unlinkSync(p); } catch { /* ignore */ }
        return { ok };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    }
    if (name === 'node') {
      const r = spawnSync(process.execPath, ['-e', "process.stdout.write('ok')"], {
        cwd, encoding: 'utf8', windowsHide: true, timeout: 15000,
      });
      return {
        ok: !r.error && r.status === 0 && /ok/.test(r.stdout || ''),
        error: r.error?.message || r.stderr || undefined,
      };
    }
    if (name === 'gh') {
      const r = spawnSync('gh', ['--version'], {
        cwd, encoding: 'utf8', windowsHide: true, timeout: 15000,
      });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      return {
        ok: !r.error && r.status === 0 && /gh version/i.test(out),
        error: r.error?.message || r.stderr || undefined,
      };
    }
    return { ok: false, error: `未知探针 ${name}` };
  };
}
