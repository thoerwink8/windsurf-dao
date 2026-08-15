// scripts/lib/dao-cmd.mjs —— 统一命令库的纯函数层（issue #482）
//
// 改这段前必须知道：启动命令模板只存在 docs/model-routing.toml 的 [providers.*].launch，
// 这里禁止写死 codex / reclaude / grok 的参数。读表失败必须抛，不许静默回退。
// --help 自检的比对函数不调用 orca 自己的 schema（agent-context），只解析 --help 文本。

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse: parseToml } = require('./smol-toml.cjs');

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const ROUTING_FILE = join(ROOT, 'docs', 'model-routing.toml');
export const ESCAPE_LOG = join(ROOT, '_flow', 'cmd-escape.jsonl');
export const HELP_FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'orca-help');

export const DEFAULT_THINK_GRACE_MS = 20 * 60 * 1000;
export const DEFAULT_PROCESS_ALIVE_MS = 2 * 60 * 1000;

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '_flow', '_tmp', '_scratch', '.codegraph',
  '__pycache__', 'derived', '.playwright-mcp',
]);

// 漏 -a never 时 codex 会停在确认条。验开工认这些屏面，不靠「看起来在干活」。
export const CONFIRM_PATTERNS = [
  /allow this command/i,
  /allow command\??/i,
  /approval required/i,
  /ask for approval/i,
  /waiting for approval/i,
  /do you want to (allow|approve|run)/i,
  /run this command\??/i,
  /always allow/i,
  /\[y\/n\]/i,
  /待确认/,
  /批准这次/,
  /允许执行/,
];

// ── 路由表 ──────────────────────────────────────────────────────────

export function loadRouting(file = ROUTING_FILE) {
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

export function resolveLaunch({ provider, model, routing, root = ROOT } = {}) {
  if (!routing) throw new Error('resolveLaunch 没给 routing（读表失败应在 loadRouting 就抛）');
  const providers = routing.providers;
  if (!providers || typeof providers !== 'object') throw new Error('路由表缺 [providers] 节');

  let providerName = provider || null;
  if (!providerName && model) {
    const models = Array.isArray(routing.models) ? routing.models : [];
    const hit = models.find(m => m && m.id === model);
    if (!hit) throw new Error(`模型 ${model} 不在路由表`);
    if (!hit.provider) throw new Error(`模型 ${model} 缺 provider`);
    providerName = hit.provider;
  }
  if (!providerName) throw new Error('要 --provider 或 --model');

  const p = providers[providerName];
  if (!p) throw new Error(`providers.${providerName} 不在路由表`);
  if (!p.launch || !String(p.launch).trim()) {
    throw new Error(`providers.${providerName} 缺 launch（启动模板）`);
  }

  let command = String(p.launch).trim();
  if (command.includes('{model}')) {
    const models = Array.isArray(routing.models) ? routing.models : [];
    const hit = model ? models.find(m => m && m.id === model) : null;
    const cliModel = (hit && hit.cli_model) || model || p.launch_model || p.default_model;
    if (!cliModel) {
      throw new Error(`providers.${providerName}.launch 含 {model} 但没给模型（--model / launch_model / default_model）`);
    }
    command = command.split('{model}').join(String(cliModel));
  }
  return {
    provider: providerName,
    command: materializeLaunch(command, root),
    template: String(p.launch).trim(),
  };
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
  const used = [...new Set(models.map(m => m && m.provider).filter(Boolean))];
  if (used.length === 0) return { unscanned: true, problems: ['没扫到任何带 provider 的模型'] };
  const problems = [];
  for (const name of used) {
    const p = doc.providers?.[name];
    if (!p) { problems.push(`${name} 无 providers 节`); continue; }
    if (!p.launch || !String(p.launch).trim()) { problems.push(`${name} 缺 launch`); continue; }
    if (String(p.launch).includes('{model}') && !p.launch_model && !p.default_model) {
      problems.push(`${name} 的 launch 含 {model} 但缺 launch_model/default_model`);
    }
  }
  return { unscanned: false, problems };
}

// ── orca 参数表（从 builder 扫，不另抄清单） ────────────────────────

export function argsTerminalCreate({ worktree, title, command } = {}) {
  const a = ['terminal', 'create'];
  if (worktree) a.push('--worktree', worktree);
  if (title) a.push('--title', title);
  if (command) a.push('--command', command);
  a.push('--json');
  return a;
}

export function argsTerminalRead({ terminal, limit, cursor } = {}) {
  const a = ['terminal', 'read'];
  if (terminal) a.push('--terminal', terminal);
  if (limit != null) a.push('--limit', String(limit));
  if (cursor != null) a.push('--cursor', String(cursor));
  a.push('--json');
  return a;
}

export function argsTerminalSend({ terminal, text, enter } = {}) {
  const a = ['terminal', 'send'];
  if (terminal) a.push('--terminal', terminal);
  if (text != null) a.push('--text', text);
  if (enter) a.push('--enter');
  a.push('--json');
  return a;
}

export function argsWorktreeCreate({
  name, noParent, setup, parentWorktree, baseBranch, comment,
} = {}) {
  const a = ['worktree', 'create'];
  if (name) a.push('--name', name);
  if (noParent) a.push('--no-parent');
  if (setup) a.push('--setup', setup);
  if (parentWorktree) a.push('--parent-worktree', parentWorktree);
  if (baseBranch) a.push('--base-branch', baseBranch);
  if (comment) a.push('--comment', comment);
  a.push('--json');
  return a;
}

export function argsWorktreeRm({ worktree, force } = {}) {
  const a = ['worktree', 'rm'];
  if (worktree) a.push('--worktree', worktree);
  if (force) a.push('--force');
  a.push('--json');
  return a;
}

export function argsTaskCreate({ spec } = {}) {
  const a = ['orchestration', 'task-create'];
  if (spec != null) a.push('--spec', spec);
  a.push('--json');
  return a;
}

export function argsWorkerStart({ task, worktree, terminal, retryOf } = {}) {
  const a = ['orchestration', 'worker-start'];
  if (task) a.push('--task', task);
  if (worktree) a.push('--worktree', worktree);
  if (terminal) a.push('--terminal', terminal);
  if (retryOf) a.push('--retry-of', retryOf);
  a.push('--json');
  return a;
}

export function argsTerminalClose({ terminal, tab } = {}) {
  const a = ['terminal', 'close'];
  if (terminal) a.push('--terminal', terminal);
  if (tab) a.push('--tab');
  a.push('--json');
  return a;
}

function flagsOf(args) {
  return args.filter(x => typeof x === 'string' && x.startsWith('--'));
}

export function commandKey(args) {
  if (!args || !args.length) return '';
  if (args[0] === 'orchestration' || args[0] === 'worktree' || args[0] === 'terminal') {
    return `${args[0]} ${args[1] || ''}`.trim();
  }
  return args[0];
}

export function extractWorktreeId(json) {
  return json?.result?.worktree?.id
    || json?.result?.id
    || json?.worktree?.id
    || null;
}

export function extractWorktreePath(json) {
  return json?.result?.worktree?.path
    || json?.result?.worktree?.git?.path
    || json?.worktree?.path
    || json?.path
    || null;
}

export function extractHandleFromCreate(json) {
  return json?.result?.handle
    || json?.result?.terminal?.handle
    || json?.handle
    || json?.result?.startupTerminal?.handle
    || json?.result?.agentTerminalHandle
    || null;
}

/** 库实际会发出的 orca 命令 + 参数。用「全开」调用 builder 扫出来，不另维护清单。 */
export function catalogUsedFlags() {
  const samples = [
    argsTerminalCreate({ worktree: 'w', title: 't', command: 'c' }),
    argsTerminalRead({ terminal: 't', limit: 80, cursor: 1 }),
    argsTerminalSend({ terminal: 't', text: 'x', enter: true }),
    argsWorktreeCreate({
      name: 'n', noParent: true, setup: 'skip',
      parentWorktree: 'p', baseBranch: 'b', comment: 'c',
    }),
    argsWorktreeRm({ worktree: 'w', force: true }),
    argsTaskCreate({ spec: 's' }),
    argsWorkerStart({ task: 't', worktree: 'w', terminal: 'h', retryOf: 'd' }),
    argsTerminalClose({ terminal: 't', tab: true }),
  ];
  return samples.map(args => ({
    cmd: commandKey(args),
    flags: flagsOf(args),
    args,
  }));
}

export function parseHelpFlags(helpText) {
  const flags = new Set();
  const re = /(--[a-z0-9][a-z0-9-]*)/gi;
  let m;
  const text = String(helpText || '');
  while ((m = re.exec(text))) flags.add(m[1]);
  return flags;
}

export function isCiEnv(env = process.env) {
  return env.GITHUB_ACTIONS === 'true' || env.CI === 'true';
}

export function orcaHelpAvailable(spawn = spawnSync) {
  const r = spawn('orca', ['--help'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (r.error) {
    const msg = r.error.message || String(r.error);
    const missing = r.error.code === 'ENOENT' || /ENOENT/i.test(msg);
    return { ok: false, missing, error: msg };
  }
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  if (!String(text).trim()) return { ok: false, missing: false, error: 'orca --help 无输出' };
  return { ok: true, missing: false };
}

/**
 * --help 自检是 local-only：真跑 orca --help。
 * CI 无 orca → SKIP（可见，不计失败）；本机无 orca → FAIL（不许悄悄跳过）。
 * 静默跳过会把「没查成」当成「查过没事」；直接 FAIL 会让 CI 永远红。
 */
export function helpCheckPolicy({ ci, orca } = {}) {
  if (orca && orca.ok) return { action: 'run' };
  if (ci && orca && orca.missing) {
    return { action: 'skip', reason: '本项需本机 orca，CI 无法验证' };
  }
  return { action: 'fail', reason: (orca && orca.error) || '本机 orca 不在 PATH，--help 自检没查成' };
}

export function fetchOrcaHelp(cmd, spawn = spawnSync) {
  const parts = String(cmd).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error('fetchOrcaHelp 没给命令');
  const r = spawn('orca', [...parts, '--help'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (r.error) throw new Error(r.error.message || 'spawn orca 失败');
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  if (!String(text).trim()) throw new Error(`orca ${cmd} --help 无输出`);
  return text;
}

export function helpFixturePath(cmd, root = ROOT) {
  return join(root, 'tests', 'fixtures', 'orca-help', `${String(cmd).trim().replace(/\s+/g, '-')}.txt`);
}

/** 先跑真 --help；orca 不在 PATH 时才用语料夹具（夹具必须是某次真 --help 落盘）。 */
export function fetchHelpPreferLive(cmd, { spawn = spawnSync, root = ROOT } = {}) {
  try {
    return { text: fetchOrcaHelp(cmd, spawn), source: 'live' };
  } catch (e) {
    const p = helpFixturePath(cmd, root);
    if (!existsSync(p)) throw new Error(`orca ${cmd} --help 没查成（${e.message}）且无夹具`);
    const text = readFileSync(p, 'utf8');
    if (!String(text).trim()) throw new Error(`${p} 夹具是空的`);
    return { text, source: 'fixture' };
  }
}

export function checkHelpLiveness({ catalog, fetchHelp }) {
  if (!catalog || catalog.length === 0) {
    return { ok: false, unscanned: true, missing: [], scanned: [], error: '没扫到任何库命令' };
  }
  const missing = [];
  const scanned = [];
  for (const item of catalog) {
    let text;
    try {
      text = fetchHelp(item.cmd);
    } catch (e) {
      return {
        ok: false, unscanned: true, missing: [], scanned,
        error: `${item.cmd} --help 没查成: ${e.message}`,
      };
    }
    if (!text || !String(text).trim()) {
      return {
        ok: false, unscanned: true, missing: [], scanned,
        error: `${item.cmd} --help 无输出`,
      };
    }
    const available = parseHelpFlags(text);
    if (available.size === 0) {
      return {
        ok: false, unscanned: true, missing: [], scanned,
        error: `${item.cmd} --help 一个参数都没解析到`,
      };
    }
    scanned.push(item.cmd);
    for (const flag of item.flags || []) {
      if (!available.has(flag)) missing.push(`${item.cmd} ${flag}`);
    }
  }
  return { ok: missing.length === 0, unscanned: false, missing, scanned };
}

// ── 验开工 / 活性 ───────────────────────────────────────────────────

export function extractTerminalText(readJson) {
  if (readJson == null) return '';
  if (typeof readJson === 'string') return readJson;
  const result = readJson.result ?? readJson;
  if (typeof result === 'string') return result;
  const chunks = [];
  if (typeof result.text === 'string') chunks.push(result.text);
  if (typeof result.output === 'string') chunks.push(result.output);
  if (typeof result.preview === 'string') chunks.push(result.preview);
  if (Array.isArray(result.lines)) {
    for (const line of result.lines) {
      if (typeof line === 'string') chunks.push(line);
      else if (line && typeof line.text === 'string') chunks.push(line.text);
    }
  }
  if (Array.isArray(result.output)) {
    for (const line of result.output) {
      if (typeof line === 'string') chunks.push(line);
    }
  }
  if (chunks.length) return chunks.join('\n');
  if (typeof readJson.preview === 'string') return readJson.preview;
  return '';
}

/** 分得开「没读成」和「读了是空的」。unread 不能当成 empty。 */
export function classifyRead(readJson) {
  if (readJson == null) return { kind: 'unread', reason: '没读成', error: 'read 结果为空' };
  if (typeof readJson === 'string') {
    return String(readJson).trim()
      ? { kind: 'text', text: readJson }
      : { kind: 'empty', reason: '读了是空的', text: '' };
  }
  if (readJson.error) {
    return { kind: 'unread', reason: '没读成', error: readJson.error };
  }
  const text = extractTerminalText(readJson);
  if (!String(text).trim()) return { kind: 'empty', reason: '读了是空的', text: '' };
  return { kind: 'text', text };
}

export function verifyStarted(readJson) {
  const cls = classifyRead(readJson);
  if (cls.kind === 'unread') {
    return { ok: false, reason: '没读成', error: cls.error, unscanned: true, text: '' };
  }
  if (cls.kind === 'empty') {
    return { ok: false, reason: '读了是空的', unscanned: false, text: '' };
  }
  const text = cls.text;
  for (const re of CONFIRM_PATTERNS) {
    const m = String(text).match(re);
    if (m) return { ok: false, reason: '有待确认提示', evidence: m[0], text, unscanned: false };
  }
  return { ok: true, text, unscanned: false };
}

export function waitAndVerify({ readOnce, timeoutMs = 8000, intervalMs = 400, sleep = sleepSync } = {}) {
  if (typeof readOnce !== 'function') throw new Error('waitAndVerify 要 readOnce');
  const t0 = Date.now();
  let last = { ok: false, reason: '读了是空的', text: '', unscanned: false };
  while (Date.now() - t0 < timeoutMs) {
    last = verifyStarted(readOnce());
    if (last.ok) return last;
    if (last.reason === '有待确认提示' || last.reason === '没读成') return last;
    sleep(intervalMs);
  }
  return last;
}

export const CODEX_CAPABLE_FLAG = '--dangerously-bypass-approvals-and-sandbox';
export const PROBE_LABELS = { write: '能写文件', node: '能跑 node', gh: '能调 gh' };
/** 只在真执行的 stdout 里出现；命令原文里不能有这个形态（否则回显即自证）。 */
export const PROBE_MARK_RE = {
  write: /\bW\d{13}\b/,
  node: /\bN\d{13}\b/,
  gh: /gh version \d/i,
};

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

export function planDispatchRollback({ workerId, workerHandle, reviewerId, reviewerHandle } = {}) {
  const steps = [];
  if (reviewerHandle) steps.push(argsTerminalClose({ terminal: reviewerHandle, tab: true }));
  if (reviewerId) steps.push(argsWorktreeRm({ worktree: reviewerId, force: true }));
  if (workerHandle) steps.push(argsTerminalClose({ terminal: workerHandle, tab: true }));
  if (workerId) steps.push(argsWorktreeRm({ worktree: workerId, force: true }));
  return steps;
}

export function sleepSync(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, Math.max(1, ms));
}

export function isProcessFile(rel) {
  const n = String(rel || '').replace(/\\/g, '/').toLowerCase();
  if (n === 'state.json' || n.endsWith('/state.json')) return true;
  if (n === '.pi' || n.startsWith('.pi/') || n.includes('/.pi/')) return true;
  if (n.endsWith('.lease')) return true;
  if (/(^|\/)sessions?(\/|$)/.test(n)) return true;
  return false;
}

export function isWorkFile(rel) {
  const n = String(rel || '').replace(/\\/g, '/');
  if (!n || n.endsWith('/')) return false;
  if (isProcessFile(n)) return false;
  return true;
}

export function scanWorktreeTimes(root) {
  if (!root || !existsSync(root)) throw new Error(`工作树不在: ${root}`);
  let processNewestMtime = 0;
  let processStartedMs = Infinity;
  let workNewestMtime = 0;
  const walk = (dir) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of ents) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = join(dir, ent.name);
      const rel = relative(root, full);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!ent.isFile()) continue;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (isProcessFile(rel)) {
        processNewestMtime = Math.max(processNewestMtime, st.mtimeMs);
        const birth = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
        processStartedMs = Math.min(processStartedMs, birth);
      } else if (isWorkFile(rel)) {
        workNewestMtime = Math.max(workNewestMtime, st.mtimeMs);
      }
    }
  };
  walk(root);
  return {
    processNewestMtime,
    processStartedMs: Number.isFinite(processStartedMs) ? processStartedMs : 0,
    workNewestMtime,
  };
}

export function readGitTimes(cwd) {
  const log = spawnSync('git', ['log', '-1', '--format=%ct'], { cwd, encoding: 'utf8', windowsHide: true });
  if (log.error || log.status !== 0) {
    throw new Error(`git log 失败: ${String(log.stderr || log.error?.message || `exit ${log.status}`).trim()}`);
  }
  const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', windowsHide: true });
  if (status.error || status.status !== 0) {
    throw new Error(`git status 失败: ${String(status.stderr || status.error?.message || `exit ${status.status}`).trim()}`);
  }
  const gitHeadMs = Number(String(log.stdout || '').trim()) * 1000;
  if (!Number.isFinite(gitHeadMs) || gitHeadMs <= 0) throw new Error('git log 没给出提交时间');
  return { gitHeadMs, gitDirty: String(status.stdout || '').trim().length > 0 };
}

export function assessLiveness({
  now = Date.now(),
  processNewestMtime = 0,
  processStartedMs = 0,
  workNewestMtime = 0,
  gitHeadMs = 0,
  gitDirty = false,
  thinkGraceMs = DEFAULT_THINK_GRACE_MS,
  processAliveMs = DEFAULT_PROCESS_ALIVE_MS,
} = {}) {
  const processAlive = processNewestMtime > 0 && (now - processNewestMtime) <= processAliveMs;
  const hasRecentWork = workNewestMtime > 0 && (now - workNewestMtime) <= thinkGraceMs;
  const hasWorkSinceCommit = gitHeadMs > 0 && workNewestMtime > gitHeadMs + 2000;
  const hasOutput = hasRecentWork || (gitDirty && hasWorkSinceCommit);
  const started = processStartedMs > 0 ? processStartedMs : processNewestMtime;
  const aliveFor = started > 0 ? now - started : 0;

  if (hasOutput) return { verdict: 'working', processAlive, hasOutput: true, aliveFor };
  if (processAlive && aliveFor < thinkGraceMs) return { verdict: 'thinking', processAlive, hasOutput: false, aliveFor };
  if (processAlive && aliveFor >= thinkGraceMs) return { verdict: 'fake-alive', processAlive, hasOutput: false, aliveFor };
  return { verdict: 'dead', processAlive: false, hasOutput: false, aliveFor };
}

export function assessWorktreeLiveness(root, opts = {}) {
  const times = scanWorktreeTimes(root);
  const git = readGitTimes(root);
  return { ...assessLiveness({ now: opts.now ?? Date.now(), ...times, ...git, ...opts }), ...times, ...git };
}

// ── 派工约束（CLI 是约束载体，不是提醒。issue #482 规格重定义）────────
// 缺参数就跑不起来。不靠 hook：2026-08-12 df217ee 已写明「提醒值一行偏好，不值一个进程」。

export const MERGE_POLICIES = ['auto', 'manual'];
export const DISPATCH_VERBS = ['dispatch', 'worker-start'];

export function minutesInBeijing(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date instanceof Date ? date : new Date(date));
  const h = Number(parts.find(p => p.type === 'hour')?.value);
  const m = Number(parts.find(p => p.type === 'minute')?.value);
  if (!Number.isFinite(h) || !Number.isFinite(m)) throw new Error('算不出北京时间');
  return h * 60 + m;
}

export function windowContains(beijing, minutes) {
  const windows = String(beijing || '').split(',').map(s => s.trim()).filter(Boolean);
  if (windows.length === 0) return false;
  return windows.some((w) => {
    const [a, b] = w.split('-');
    if (!a || !b) return false;
    const toMin = (t) => {
      const [hh, mm] = t.split(':').map(Number);
      return hh * 60 + mm;
    };
    const start = toMin(a);
    const end = toMin(b);
    return minutes >= start && minutes < end;
  });
}

export function recommendModel({ role, routing, now = new Date() } = {}) {
  if (!role) return { ok: false, error: 'recommendModel 要 role' };
  if (!routing) return { ok: false, error: 'recommendModel 要 routing' };
  const routes = (Array.isArray(routing.routes) ? routing.routes : []).filter(r => r && r.role === role);
  if (routes.length === 0) {
    return { ok: false, error: `角色 ${role} 没有分时路由，请显式 --model` };
  }
  const mins = minutesInBeijing(now);
  const hit = routes.find(r => windowContains(r.beijing, mins));
  if (!hit) {
    return { ok: false, error: `角色 ${role} 此刻没有匹配的分时路由，请显式 --model` };
  }
  return {
    ok: true,
    model: hit.model,
    fallback: hit.fallback,
    role,
    beijing: hit.beijing,
    why: hit.why || '',
  };
}

/**
 * 派工三参数硬闸。缺一即失败，并列出缺什么。
 * --role 而无 --model：读分时路由给推荐，必须 --confirm，禁静默默认。
 */
export function resolveDispatchConstraints({
  mergePolicy, model, role, reviewer, confirm, routing, now = new Date(),
} = {}) {
  const missing = [];
  if (!mergePolicy) missing.push('--merge-policy');
  else if (!MERGE_POLICIES.includes(mergePolicy)) {
    return {
      ok: false,
      missing: [],
      error: `--merge-policy 只允许 auto|manual，实际 ${mergePolicy}`,
    };
  }

  if (!model && !role) missing.push('--model 或 --role');
  if (!reviewer) missing.push('--reviewer');

  if (missing.length) {
    return { ok: false, missing, error: `缺 ${missing.join('、')}` };
  }

  if (!routing) {
    return { ok: false, missing: [], error: '读路由表失败（无 routing）' };
  }

  const models = Array.isArray(routing.models) ? routing.models : [];
  let resolvedModel = model || null;
  let recommendation = null;

  if (!model && role) {
    recommendation = recommendModel({ role, routing, now });
    if (!recommendation.ok) {
      return { ok: false, missing: ['--model'], error: recommendation.error, recommendation };
    }
    if (!confirm) {
      return {
        ok: false,
        needsConfirm: true,
        missing: ['--confirm'],
        recommendation,
        error: `分时路由推荐 ${recommendation.model}（角色 ${role}，北京 ${recommendation.beijing}）。加 --confirm 采用，或显式 --model。禁静默默认`,
      };
    }
    resolvedModel = recommendation.model;
  }

  if (resolvedModel && !models.some(m => m && m.id === resolvedModel)) {
    return { ok: false, missing: [], error: `模型 ${resolvedModel} 不在路由表` };
  }
  if (reviewer && !models.some(m => m && m.id === reviewer)) {
    return { ok: false, missing: [], error: `审官 --reviewer ${reviewer} 不在路由表` };
  }

  return {
    ok: true,
    mergePolicy,
    model: resolvedModel,
    role: role || null,
    reviewer,
    recommendation,
  };
}

export function reviewerCardName(reviewerId) {
  return `审官·${reviewerId}`;
}

export function dispatchComment({ mergePolicy, model, reviewer }) {
  return `merge-policy:${mergePolicy} · model:${model} · reviewer:${reviewer}`;
}

// ── 逃生口留痕 ──────────────────────────────────────────────────────

export function recordEscape({ argv, ts = new Date().toISOString(), cwd = process.cwd() } = {}, logPath = ESCAPE_LOG) {
  if (!argv || !argv.length) throw new Error('逃生口没给命令');
  mkdirSync(dirname(logPath), { recursive: true });
  const line = JSON.stringify({ ts, cwd, argv: [...argv] });
  appendFileSync(logPath, `${line}\n`, 'utf8');
  return logPath;
}

// ── CLI 参数 ────────────────────────────────────────────────────────

export const VERBS = [
  'dispatch', 'start', 'worktree-create', 'worktree-rm', 'task-create',
  'worker-start', 'send', 'liveness', 'check-help', 'raw',
];

const BOOL_FLAGS = new Set(['no-parent', 'force', 'enter', 'dry-run', 'json', 'confirm']);

export const FLAGS_BY_VERB = {
  start: new Set(['--provider', '--model', '--worktree', '--title', '--dry-run', '--json', '--help', '-h']),
  dispatch: new Set([
    '--name', '--merge-policy', '--model', '--role', '--reviewer', '--confirm',
    '--spec', '--task', '--now', '--dry-run', '--json', '--help', '-h',
  ]),
  'worktree-create': new Set([
    '--name', '--no-parent', '--setup', '--parent-worktree', '--base-branch',
    '--comment', '--json', '--help', '-h',
  ]),
  'worktree-rm': new Set(['--worktree', '--force', '--json', '--help', '-h']),
  'task-create': new Set(['--spec', '--json', '--help', '-h']),
  'worker-start': new Set([
    '--task', '--worktree', '--terminal', '--retry-of', '--merge-policy',
    '--model', '--role', '--reviewer', '--confirm', '--now', '--json', '--help', '-h',
  ]),
  send: new Set(['--terminal', '--text', '--enter', '--json', '--help', '-h']),
  liveness: new Set(['--path', '--json', '--help', '-h']),
  'check-help': new Set(['--json', '--help', '-h']),
};

export function verbFlagGaps(verbs = VERBS, table = FLAGS_BY_VERB) {
  return verbs.filter(v => v !== 'raw' && !table[v]);
}

function camelFlag(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function parseArgs(argv) {
  const rest = argv.slice(2);
  if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
    return { verb: 'help' };
  }
  const verb = rest[0];
  if (verb === 'raw') {
    const dd = rest.indexOf('--', 1);
    const cmd = dd >= 0 ? rest.slice(dd + 1) : rest.slice(1);
    if (cmd.length === 0) throw new Error('raw 后面要有命令（dao raw -- <命令>）');
    return { verb: 'raw', cmd };
  }
  if (!VERBS.includes(verb)) throw new Error(`未知动词: ${verb}（只要 ${VERBS.join(' / ')}）`);
  const allowed = FLAGS_BY_VERB[verb];
  if (!allowed) throw new Error(`动词 ${verb} 没登记参数表`);
  const args = { verb };
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    const flag = a.split('=')[0];
    if (flag === '--help' || flag === '-h') { args.help = true; continue; }
    if (!flag.startsWith('--')) throw new Error(`未知参数: ${a}`);
    if (!allowed.has(flag)) throw new Error(`未知参数: ${flag}`);
    const key = flag.slice(2);
    if (BOOL_FLAGS.has(key)) { args[camelFlag(key)] = true; continue; }
    const val = rest[++i];
    if (val == null || String(val).startsWith('--')) throw new Error(`参数 --${key} 缺值`);
    args[camelFlag(key)] = val;
  }
  return args;
}

export const USAGE = `用法: node scripts/dao.mjs <verb> [args]

派工（约束载体，缺一即退）：
  dispatch --name <名> --merge-policy auto|manual --reviewer <模型id> --spec <文> (--model <id> | --role <角色> [--confirm]) [--dry-run]
启动:
  start --provider <名> | --model <id> --worktree <sel> [--title <名>] [--dry-run]
编排:
  worktree-create --name <名> [--no-parent] [--setup skip] [--parent-worktree <sel>] [--base-branch <ref>] [--comment <文>]
  worktree-rm --worktree <sel> [--force]
  task-create --spec <文>
  worker-start --task <id> --worktree <sel> --terminal <handle> --merge-policy auto|manual --reviewer <id> (--model <id> | --role <角色> [--confirm]) [--retry-of <id>]
  send --terminal <handle> --text <文> [--enter]
其他:
  liveness [--path <工作树>]
  check-help
  raw -- <任意命令...>     逃生口，必须留痕

启动模板只读 docs/model-routing.toml [providers.*].launch，读失败非零退出。
派工不给 --model 时只推荐、要 --confirm，禁静默默认。未知 --参数 一律非零。
`;
