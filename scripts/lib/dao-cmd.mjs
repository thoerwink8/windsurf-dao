// scripts/lib/dao-cmd.mjs —— 统一命令库的纯函数层（issue #482）
//
// 改这段前必须知道：启动命令模板只存在 docs/model-routing.toml 的 [providers.*].launch，
// 这里禁止写死 codex / reclaude / grok 的参数。读表失败必须抛，不许静默回退。
// --help 自检的比对函数不调用 orca 自己的 schema（agent-context），只解析 --help 文本。

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ghAs } from './gh.mjs';

const require = createRequire(import.meta.url);
const { parse: parseToml } = require('./smol-toml.cjs');

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const ROUTING_FILE = join(ROOT, 'docs', 'model-routing.toml');
export const ESCAPE_LOG = join(ROOT, '_flow', 'cmd-escape.jsonl');
export const HELP_FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'orca-help');

export const DEFAULT_THINK_GRACE_MS = 20 * 60 * 1000;
export const DEFAULT_PROCESS_ALIVE_MS = 2 * 60 * 1000;
/** 探针等屏默认值。一个所有已知情况都不成立的缺省值是陷阱：
 * grok 配 45s、codex 第一项实测 84s，没有任何 TUI 能在 8s 内跑完第一项。
 * 120s 盖住目前最慢的实测；表上仍给各 provider 显式值。
 * #559：waitAndVerify 原默认 8000ms 硬编码，pi 启动加载 skills 常常超过，
 * 派工连续死在这里——默认改为本常量，调用方再按 provider 的 probe_wait_ms 显式覆盖。 */
export const DEFAULT_PROBE_WAIT_MS = 120000;

export function probeWaitMs(routing, provider) {
  const raw = routing?.providers?.[provider]?.probe_wait_ms;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_PROBE_WAIT_MS;
}

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
  name, noParent, setup, parentWorktree, baseBranch, comment, issue,
} = {}) {
  const a = ['worktree', 'create'];
  if (name) a.push('--name', name);
  if (noParent) a.push('--no-parent');
  if (setup) a.push('--setup', setup);
  if (parentWorktree) a.push('--parent-worktree', parentWorktree);
  if (baseBranch) a.push('--base-branch', baseBranch);
  if (issue != null && String(issue).trim() !== '') a.push('--issue', String(issue).trim());
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

export function argsWorkerList() {
  return ['orchestration', 'worker-list', '--json'];
}

/** 从 worker-list JSON 里找某棵树的士兵 dispatch。没查成与查到 0 条分开。 */
export function findDispatchForWorktree(workerListJson, worktreeSel) {
  const workers = workerListJson?.result?.workers;
  if (!Array.isArray(workers)) {
    return { ok: false, unscanned: true, error: 'worker-list 结构不认识（缺 result.workers 数组）' };
  }
  const sel = String(worktreeSel || '').trim();
  if (!sel) return { ok: false, error: 'findDispatchForWorktree 没给 worktree' };
  const hits = workers.filter(w => {
    const id = String(w?.resource?.worktreeId || '');
    return id === sel || id.endsWith(`::${sel}`) || id.endsWith(sel);
  });
  if (hits.length === 0) {
    return { ok: false, error: `worker-list 里找不到 worktree=${sel} 的士兵 dispatch`, scanned: workers.length };
  }
  const live = hits.filter(w => w.dispatchStatus !== 'completed' && w.workerState !== 'succeeded');
  const pick = live[0] || hits[0];
  if (!pick?.dispatchId) {
    return { ok: false, error: `worktree=${sel} 的记账没有 dispatchId`, scanned: workers.length };
  }
  return { ok: true, dispatchId: pick.dispatchId, taskId: pick.taskId || null, scanned: workers.length };
}

export function argsWorkerShow({ dispatch } = {}) {
  const a = ['orchestration', 'worker-show'];
  if (dispatch) a.push('--dispatch', dispatch);
  a.push('--json');
  return a;
}

export function argsWorkerRelease({ dispatch, retryRequest } = {}) {
  const a = ['orchestration', 'worker-release'];
  if (dispatch) a.push('--dispatch', dispatch);
  if (retryRequest) a.push('--retry-request', retryRequest);
  a.push('--json');
  return a;
}

export function argsWorkerRead({ dispatch, source, cursor, limit } = {}) {
  const a = ['orchestration', 'worker-read'];
  if (dispatch) a.push('--dispatch', dispatch);
  if (source) a.push('--source', source);
  if (cursor != null) a.push('--cursor', String(cursor));
  if (limit != null) a.push('--limit', String(limit));
  a.push('--json');
  return a;
}

export function argsOrchestrationReply({ id, body, from } = {}) {
  const a = ['orchestration', 'reply'];
  if (id) a.push('--id', id);
  if (body != null) a.push('--body', body);
  if (from) a.push('--from', from);
  a.push('--json');
  return a;
}

export function argsGateCreate({ task, question, options, from } = {}) {
  const a = ['orchestration', 'gate-create'];
  if (task) a.push('--task', task);
  if (question != null) a.push('--question', question);
  if (options != null) a.push('--options', options);
  if (from) a.push('--from', from);
  a.push('--json');
  return a;
}

export function argsGateResolve({ id, resolution, from } = {}) {
  const a = ['orchestration', 'gate-resolve'];
  if (id) a.push('--id', id);
  if (resolution != null) a.push('--resolution', resolution);
  if (from) a.push('--from', from);
  a.push('--json');
  return a;
}

export function argsGateList({ task, status, run } = {}) {
  const a = ['orchestration', 'gate-list'];
  if (task) a.push('--task', task);
  if (status) a.push('--status', status);
  if (run) a.push('--run', run);
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

/** terminal send --json 的回执。真返回在 result.send；accepted=true 才算送达。
 * 不带 --json 的人读回执由 parseOrcaStdout 归一成同一形状（#580）。 */
export function extractTerminalSend(json) {
  const s = json?.result?.send;
  if (!s || s.accepted !== true) return null;
  return {
    handle: s.handle ?? null,
    accepted: true,
    bytesWritten: Number.isFinite(s.bytesWritten) ? s.bytesWritten : null,
  };
}

/** 真返回在 result.task.id。result.id / 顶层 id 是 RPC id，不能当 taskId（#497/#502）。 */
export function extractTaskId(json) {
  return json?.result?.task?.id || null;
}

/** worker-start / dispatch-show / worker-show 的 Dispatch id。
 * 真返回位置：worker-start 的 result.dispatchId（CLI 源码 worker-start 格式化器直接读它）；
 * dispatch-show / worker-show 的 result.dispatch.id；worker-show 的 worker 对象另有 worker.dispatch_id。
 * 顶层 id 是 RPC id，不能当 dispatchId（#502 同款教训）。
 * #559：闭环发信改用 --to dispatch:<id>，派工流程从 worker-start 返回里取它。 */
export function extractDispatchId(json) {
  return json?.result?.dispatchId
    || json?.result?.worker?.dispatchId
    || json?.result?.worker?.dispatch_id
    || json?.result?.dispatch?.id
    || null;
}

export function isRunRequired(error) {
  const text = typeof error === 'object' && error
    ? `${error.code || ''} ${error.message || ''}`
    : String(error || '');
  return /run_required/i.test(text);
}

export const RUN_REQUIRED_HINT = '未绑 orchestration Run，先跑 orca orchestration run-create 或 run-use';

export function rollbackErrorAlreadyGone(error) {
  const text = typeof error === 'object' && error
    ? `${error.code || ''} ${error.message || ''}`
    : String(error || '');
  return /tab_not_found|terminal_handle_stale/i.test(text);
}

/** 库实际会发出的 orca 命令 + 参数。用「全开」调用 builder 扫出来，不另维护清单。 */
export function catalogUsedFlags() {
  const samples = [
    argsTerminalCreate({ worktree: 'w', title: 't', command: 'c' }),
    argsTerminalRead({ terminal: 't', limit: 80, cursor: 1 }),
    argsTerminalSend({ terminal: 't', text: 'x', enter: true }),
    argsWorktreeCreate({
      name: 'n', noParent: true, setup: 'skip',
      parentWorktree: 'p', baseBranch: 'b', comment: 'c', issue: 559,
    }),
    argsWorktreeRm({ worktree: 'w', force: true }),
    argsTaskCreate({ spec: 's' }),
    argsWorkerStart({ task: 't', worktree: 'w', terminal: 'h', retryOf: 'd' }),
    argsWorkerShow({ dispatch: 'd' }),
    argsWorkerRelease({ dispatch: 'd' }),
    argsWorkerRead({ dispatch: 'd', source: 'auto', limit: 50 }),
    argsTerminalClose({ terminal: 't', tab: true }),
    argsOrchestrationSend({ to: 'h', subject: 's', body: 'b', type: 'status', outcome: 'succeeded' }),
    argsOrchestrationReply({ id: 'm', body: 'b' }),
    argsGateCreate({ task: 't', question: 'q', options: '["a"]' }),
    argsGateResolve({ id: 'g', resolution: 'r' }),
    argsGateList({ task: 't', status: 'pending' }),
    argsOrchestrationInbox({ terminal: 'h', limit: 50, full: true }),
    argsRunShow({ id: 'r' }),
    argsRunCurrent(),
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
  const pushLines = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const line of arr) {
      if (typeof line === 'string') chunks.push(line);
      else if (line && typeof line.text === 'string') chunks.push(line.text);
    }
  };
  // 2026-08-15 真返回：文本在 result.terminal.tail（字符串数组），不在 result.text/output/lines。
  if (result.terminal && typeof result.terminal === 'object') {
    pushLines(result.terminal.tail);
    if (typeof result.terminal.preview === 'string') chunks.push(result.terminal.preview);
  }
  pushLines(result.tail);
  if (typeof result.text === 'string') chunks.push(result.text);
  if (typeof result.output === 'string') chunks.push(result.output);
  if (typeof result.preview === 'string') chunks.push(result.preview);
  pushLines(result.lines);
  pushLines(Array.isArray(result.output) ? result.output : null);
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

export function waitAndVerify({ readOnce, timeoutMs = DEFAULT_PROBE_WAIT_MS, intervalMs = 400, sleep = sleepSync } = {}) {
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

export function gitCapture(cwd, args) {
  if (!cwd) return { ok: false, error: 'git 没给工作区路径' };
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return { ok: false, error: String(r.error?.message || r.stderr || `git exit ${r.status}`).trim().slice(0, 200) };
  }
  return { ok: true, out: String(r.stdout || '').trim() };
}

export function gitHeadOid(cwd) {
  const r = gitCapture(cwd, ['rev-parse', 'HEAD']);
  if (!r.ok) return r;
  if (!/^[0-9a-f]{7,40}$/i.test(r.out)) return { ok: false, error: `git HEAD 不是 oid：${r.out.slice(0, 80)}` };
  return { ok: true, oid: r.out };
}

export function gitBranchName(cwd) {
  const r = gitCapture(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!r.ok) return r;
  if (!r.out || r.out === 'HEAD') return { ok: false, error: '工作区处于 detached HEAD，推不出分支名' };
  return { ok: true, branch: r.out };
}

/**
 * #575 ⑦：审官开审前对齐 master。
 * rebase 会改 commit sha → review.commit_id != headRefOid → APPROVED 当场失效
 * （判例 review-green-must-match-head）。所以只能先对齐 → 再审 → 再合。
 *
 * mergeable 三态必须分开：MERGEABLE / CONFLICTING / UNKNOWN。
 * UNKNOWN 是「GitHub 还在算」，不是绿——没查成，不许当 MERGEABLE 放行。
 */
export function assessPrMergeable(raw) {
  const v = String(raw ?? '').trim().toUpperCase();
  if (v === 'MERGEABLE') return { ok: true, mergeable: 'MERGEABLE' };
  if (v === 'CONFLICTING') {
    return {
      ok: false,
      mergeable: 'CONFLICTING',
      error: '先让工人 rebase master，别派审官白审（mergeable=CONFLICTING）',
    };
  }
  if (!v || v === 'UNKNOWN') {
    return {
      ok: false,
      unscanned: true,
      mergeable: v || null,
      error: `mergeable=${v || '空'}——GitHub 还在算或没查成，不许当 MERGEABLE 放行`,
    };
  }
  return {
    ok: false,
    unscanned: true,
    mergeable: v,
    error: `mergeable 值不认识：${v}——没查成，不许当绿放行`,
  };
}

function gitRun(cwd, args, runGit) {
  if (typeof runGit === 'function') return runGit(args);
  return gitCapture(cwd, args);
}

/**
 * 试合 origin/master（或 origin/main），记录落后数/冲突/触及文件，然后 --abort。
 * 树必须停在原 HEAD：审官审的是 PR head，expectedOid 校验才有意义。
 *
 * 顺序陷阱：rebase 会改 commit sha，导致 review.commit_id != headRefOid、
 * 审官的 APPROVED 失效（判例 review-green-must-match-head）。
 * 只能「先对齐 master → 再审 → 再合」，不能审完再 rebase。
 */
export function trialMergeMaster({ cwd, runGit } = {}) {
  if (!cwd && typeof runGit !== 'function') {
    return { ok: false, unscanned: true, error: 'trialMergeMaster 没给工作区' };
  }
  const run = (args) => gitRun(cwd, args, runGit);
  const head = run(['rev-parse', 'HEAD']);
  if (!head.ok) return { ok: false, unscanned: true, error: `试合前 HEAD 没查成：${head.error}` };
  const before = head.out;

  let base = 'origin/master';
  const hasMaster = run(['rev-parse', '--verify', 'origin/master']);
  if (!hasMaster.ok) {
    const hasMain = run(['rev-parse', '--verify', 'origin/main']);
    if (!hasMain.ok) {
      return { ok: false, unscanned: true, error: 'origin/master 与 origin/main 都没有——试合没查成' };
    }
    base = 'origin/main';
  }

  const behindR = run(['rev-list', '--count', `HEAD..${base}`]);
  if (!behindR.ok) return { ok: false, unscanned: true, error: `落后 commit 数没查成：${behindR.error}` };
  const behind = Number(behindR.out);
  if (!Number.isFinite(behind)) {
    return { ok: false, unscanned: true, error: `落后 commit 数不是数字：${behindR.out}` };
  }

  const touchedR = run(['diff', '--name-only', `HEAD...${base}`]);
  const masterFiles = touchedR.ok
    ? String(touchedR.out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    : [];

  const merge = run(['merge', base, '--no-commit', '--no-ff']);
  // 冲突只认未合并文件。merge 非零可能是没配 user.name（CI 实证 #578）——那是没查成，不是冲突。
  const unmerged = run(['diff', '--name-only', '--diff-filter=U']);
  const conflict = !!(unmerged.ok && String(unmerged.out || '').trim());
  if (!merge.ok && !conflict) {
    run(['merge', '--abort']);
    return {
      ok: false,
      unscanned: true,
      behind,
      masterFiles,
      error: `试合没跑成（不是冲突）：${merge.error}`,
    };
  }
  const abort = run(['merge', '--abort']);
  // 没进合并时 abort 会失败——只要 HEAD 还原且工作区干净就算成功。
  const after = run(['rev-parse', 'HEAD']);
  if (!after.ok) {
    return { ok: false, error: `试合后 HEAD 没查成：${after.error}`, behind, conflict, masterFiles };
  }
  if (after.out !== before) {
    return {
      ok: false,
      error: `试合后 HEAD ${after.out} ≠ 原 ${before}（--abort 没还原，审官树漂了）`,
      behind, conflict, masterFiles, head: after.out, expectedOid: before,
    };
  }
  const st = run(['status', '--porcelain']);
  if (!st.ok) return { ok: false, error: `试合后 git status 没查成：${st.error}`, behind, conflict };
  if (String(st.out || '').trim()) {
    return {
      ok: false,
      error: `试合后工作区不干净（--abort 有残留）：${String(st.out).slice(0, 120)}`,
      behind, conflict, masterFiles,
    };
  }
  return {
    ok: true,
    behind,
    conflict,
    clean: true,
    base,
    masterFiles,
    head: before,
    abortOk: abort.ok,
    hint: behind === 0
      ? '与 master 同步'
      : conflict
        ? `落后 ${behind} 个 commit，试合有冲突——工人应先 rebase`
        : `落后 ${behind} 个 commit，试合无冲突。重点核这 ${behind} 个 commit 碰过的文件与本 PR 的交集`,
  };
}

export function verifyReviewerTree({ workerPath, reviewerPath, expectedOid } = {}) {
  const rev = gitHeadOid(reviewerPath);
  if (!rev.ok) return { ok: false, error: `审官树 HEAD 没查成：${rev.error}` };
  let want = expectedOid || null;
  if (!want) {
    const w = gitHeadOid(workerPath);
    if (!w.ok) return { ok: false, error: `工人树 HEAD 没查成：${w.error}` };
    want = w.oid;
  }
  if (rev.oid !== want) {
    return {
      ok: false,
      error: `审官树 HEAD ${rev.oid} ≠ 期望 ${want}（在审空气）`,
      reviewerHead: rev.oid,
      expectedOid: want,
    };
  }
  return { ok: true, reviewerHead: rev.oid, expectedOid: want };
}

export function verifyReviewerFiles({ reviewerPath, files } = {}) {
  if (!Array.isArray(files)) {
    return { ok: false, error: '被审文件清单没查成', missing: [], unscanned: true };
  }
  const missing = [];
  for (const f of files) {
    if (!existsSync(join(reviewerPath, f))) missing.push(f);
  }
  if (missing.length) return { ok: false, error: `审官树缺被审文件 ${missing.length} 个`, missing };
  return { ok: true, checked: files.length, missing: [] };
}

/** GitHub pull file 列表：跳过 removed，取 filename。没查成时返回 null。 */
export function parseGhPullFiles(json) {
  if (!Array.isArray(json)) return null;
  return json
    .filter(f => f && f.status !== 'removed' && f.filename)
    .map(f => f.filename);
}

/** 注入没生效的现场指纹（#543 / #524）：任务书折在输入框里从未提交。 */
export const PASTED_CONTENT_RE = /\[Pasted Content \d+ chars?\]/i;

/** #565 时序 bug 的 TUI 启动占位态指纹（同款在 scripts/flow.mjs waitTerminalReady）：
 * 命中这些屏面文本 = TUI 还在加载（MCP servers 0/5 之类），任务书还没渲染——
 * 绝不判绿，稳定轮数归零，继续等 proof/marker。 */
export const TUI_LOADING_RE = /Starting MCP servers \(\d+\/\d+\)|Connecting|正在启动|初始化|配置同步|请稍候|加载中|登录/i;

/** proof 不可用的可辨识 reason（#568 回归修法）：这两个值是 provider 级别不支持
 * transcript 证明（pi 实测 provider_unsupported / session_not_reported），
 * **不是「工人没开工」**——此时降级到屏面判据（连续稳定轮）判绿。
 * 其他值（null / no_hook_report 等）不降级：宁可继续等，不许假绿。 */
export function proofUnavailableReason(p) {
  const reason = String((p && p.fallbackReason) || '');
  return /provider_unsupported|session_not_reported/.test(reason) ? reason : null;
}

export function verifyInjection({ text, readError } = {}) {
  if (readError) return { ok: false, reason: '没读成', error: readError, unscanned: true };
  if (text == null) return { ok: false, reason: '没读成', error: '注入后读屏结果为空', unscanned: true };
  const t = String(text);
  if (!t.trim()) return { ok: false, reason: '注入后屏面是空的', unscanned: false, text: '' };
  const m = t.match(PASTED_CONTENT_RE);
  if (m) {
    return {
      ok: false,
      reason: '任务书停在输入框（Pasted Content），没有进上下文',
      evidence: m[0],
      unscanned: false,
      text: t,
    };
  }
  return { ok: true, text: t, unscanned: false };
}

/**
 * 注入后开工验证，轮询版（#565 追加，用户 2026-08-16 当场要求）。
 *
 * 时序 bug（同型第二次发作；判例 memory probe-checks-env-not-startup）：worker-start 返回
 * 那一刻 codex TUI 还在加载 MCP servers（同屏可见 Starting MCP servers (0/5)），任务书还没
 * 渲染出来——「立即读一次」读到非空且无 Pasted Content 的屏面就判通过，实际任务书折在输入框里
 * 几十分钟没人处理（#565 实测：审官任务书坐输入框 40 分钟）。
 *
 * 处置三件（只改注入后验证这一段；任务书太长是模板问题归 #554）：
 *   1. 轮询等开工，不是注入后读一次；超时走调用方给的 probe_wait_ms（表上 provider 显式值），不硬编码；
 *   2. 命中 [Pasted Content N chars] 先自动补一记回车（terminal send --enter）再重读；
 *   3. 重读后 Pasted Content 消失 = 提交成功（继续正常流程）；仍在 = 真失败（这时才回滚）。
 *
 * 三态分开（第二种必须留痕，否则「补救生效过多少次」永远没人知道）：
 *   started（worker-read 官方证明，或 proof 不可用时屏面连续稳定轮）/ startedAfterEnter（补回车救活，enter 留痕）/ failed。
 * worker-read 官方开工证明（#559 ⑥ 判开工优先用它；source≠terminal = 任务书进 transcript = 已提交）
 * 是权威信号，也覆盖「paste 自动提交快到没被看见 marker」的路径；#565 实测补回车后 proof 立刻 proven。
 *
 * #568 回归（本函数 2026-08-16 被挡死的正常提交路径）：pi 工人正常提交时 proof.proven 恒为 false
 * （provider_unsupported，pi 不给 transcript 证明）且全程无 Pasted Content——原实现两条出口都走不到，
 * 必然超时回滚。修法：区分「TUI 加载期」和「已提交」，不用「有没有补过回车」当区分——
 *   1. 加载期有自己的指纹（Starting MCP servers (N/5) 等，见 TUI_LOADING_RE），加载期内不算稳定轮、不判绿；
 *   2. proof 不可用（fallbackReason = provider_unsupported / session_not_reported，见 proofUnavailableReason）
 *      时降级到屏面判据：非空 + 无 marker + 连续 stableRoundsNeeded 轮稳定 = 已提交（proofFallback 留痕）；
 *   3. 「从没出现过 marker」不再永远不绿；TUI 加载期防误判的意图仍在（加载指纹清零稳定轮）。
 */
export function verifyInjectionPolling({
  dispatchId, readOnce, sendEnter, proofOnce, timeoutMs,
  intervalMs = 400, sleep = sleepSync, label = '',
  stableRoundsNeeded = 3,
} = {}) {
  if (typeof readOnce !== 'function' || typeof sendEnter !== 'function') {
    throw new Error('verifyInjectionPolling 要 readOnce + sendEnter');
  }
  const t0 = Date.now();
  let reads = 0;
  let enter = null; // 补回车留痕：{ ok, error?, elapsedMs }；没补过是 null
  let unscanned = null; // 最后一次「没读成/没送成」记录（不许当「查过没事」）
  let lastText = '';
  let proofUnavailable = null; // proof 不可用确认记录（provider 不支持证明，见 proofUnavailableReason）
  let stableRounds = 0;        // 屏面「非空 + 无 marker + 非加载期」连续轮数（降级判绿用）
  while (Date.now() - t0 < timeoutMs) {
    // ① worker-read 官方开工证明：任务书进 transcript = 已提交（权威信号）。
    if (dispatchId && typeof proofOnce === 'function') {
      const proof = proofOnce(dispatchId);
      if (proof && proof.ok && proof.proven) {
        return {
          ok: true,
          state: enter ? 'startedAfterEnter' : 'started',
          proof, enter, reads,
          elapsedMs: Date.now() - t0,
          text: lastText,
        };
      }
      if (proof && proof.unscanned) unscanned = proof;
      // #568：proof 不可用（provider 不支持证明）是降级触发条件，不是失败——先记下来。
      if (proof && proof.proven === false && proofUnavailableReason(proof)) {
        proofUnavailable = proof;
      }
    }
    // ② 屏面指纹轮询。
    reads++;
    const read = readOnce();
    if (read && read.error) unscanned = { reason: '没读成', error: read.error };
    const text = read && !read.error ? extractTerminalText(read) : '';
    lastText = text;
    const v = verifyInjection({ text, readError: read && read.error });
    if (v.ok) {
      // 屏面非空且无 Pasted Content。补过回车后的这个形态 = 提交成功（#565：消失 = 提交成功）。
      if (enter) {
        return {
          ok: true,
          state: 'startedAfterEnter',
          enter, reads,
          elapsedMs: Date.now() - t0,
          text,
        };
      }
      // 没补过回车时可能是 TUI 加载期（MCP servers 0/5 等指纹）——不算稳定轮，继续等 proof/marker。
      if (TUI_LOADING_RE.test(text)) {
        stableRounds = 0;
      } else {
        // #568 回归修法：proof 不可用（provider_unsupported / session_not_reported）时降级到屏面判据——
        // 非空 + 无 marker + 连续稳定轮 = 任务书已进上下文（pi 正常提交路径，全程无 marker 也必须判绿）。
        stableRounds++;
        if (proofUnavailable && stableRounds >= stableRoundsNeeded) {
          return {
            ok: true,
            state: 'started',
            proofFallback: true,
            proof: proofUnavailable,
            enter, reads, stableRounds,
            elapsedMs: Date.now() - t0,
            text,
          };
        }
      }
    } else if (v.reason && /Pasted Content/.test(v.reason)) {
      if (!enter) {
        const sent = sendEnter();
        enter = sent && sent.ok
          ? { ok: true, elapsedMs: Date.now() - t0 }
          : { ok: false, error: sent && !sent.ok ? String(sent.error || 'send 失败') : 'sendEnter 无返回', elapsedMs: Date.now() - t0 };
        if (!enter.ok) unscanned = { reason: '补回车没送出去', error: enter.error };
        // 送没送出去都重读定论：下轮 marker 仍在 = 真失败（这时才回滚）。
      } else {
        const reason = enter.ok
          ? `补回车后任务书仍停在输入框（${label}）——真没开工`
          : `补回车没送出去（${enter.error}），任务书仍停在输入框（${label}）`;
        return {
          ok: false,
          state: 'failed',
          reason,
          evidence: v.evidence,
          enter, reads,
          elapsedMs: Date.now() - t0,
          text,
        };
      }
    }
    sleep(intervalMs);
  }
  return {
    ok: false,
    state: 'failed',
    reason: `超时没等到任务书进上下文（${label || '注入'}，${timeoutMs}ms）`,
    unscanned: unscanned ? { unscanned: true, reason: unscanned.reason || '未记录', error: unscanned.error } : undefined,
    enter, reads,
    stableRounds,
    elapsedMs: Date.now() - t0,
    text: lastText,
  };
}

/**
 * worker-read 的开工证明（#559 ⑥）。官方可靠源：source ≠ 'terminal' = hook 报告的
 * Codex/Claude/Grok transcript（可证明 worker session）；source = 'terminal' = 只给了
 * 有界终端输出（老式屏面证据，会假阳）。没读成必须标 unscanned——不许当成「没开工」。
 * 判开工优先用它；证明不了时降级回 verifyInjection 屏面检查兜底（③单接上后删）。
 */
export function verifyWorkerStarted(readJson) {
  if (readJson == null) return { ok: false, reason: '没读成', unscanned: true, error: 'worker-read 结果为空' };
  if (readJson.error) return { ok: false, reason: '没读成', unscanned: true, error: orcaErrText(readJson.error) };
  const r = readJson.result ?? readJson;
  const source = r.source ?? 'terminal';
  if (source !== 'terminal') {
    return { ok: true, proven: true, source, reason: '官方 transcript 源（source=' + String(source) + '）' };
  }
  return {
    ok: false,
    proven: false,
    source: 'terminal',
    fallbackReason: r.fallbackReason ?? null,
    reason: 'worker-read 只给终端输出（source=terminal），没证明 worker session——降级回屏面验开工',
  };
}

export function parseDiffNameStatus(text) {
  const mustExist = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const status = line.slice(0, tab).trim();
    const rest = line.slice(tab + 1);
    if (!status || status[0] === 'D') continue;
    const parts = rest.split('\t');
    mustExist.push(parts[parts.length - 1]);
  }
  return mustExist;
}

export function runGh(args, { cwd, role } = {}) {
  // role 有值 → 走 GitHub App 身份（#573）。其余裸调用先保持本人 gh，全量替换另开单。
  if (role) return ghAs(role, args, { cwd });
  const r = spawnSync('gh', args, {
    encoding: 'utf8', windowsHide: true, timeout: 30000, cwd,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return { ok: false, error: String(r.error?.message || r.stderr || `gh exit ${r.status}`).trim().slice(0, 240) };
  }
  return { ok: true, out: String(r.stdout || '') };
}

export function envProbeWorktree(cwd) {
  return runCapabilityProbes({ exec: hostProbeExec(cwd) });
}

export function planDispatchRollback({ workerId, workerHandle, reviewerId, reviewerHandle } = {}) {
  const steps = [];
  if (reviewerHandle) steps.push(argsTerminalClose({ terminal: reviewerHandle, tab: true }));
  if (reviewerId) steps.push(argsWorktreeRm({ worktree: reviewerId, force: true }));
  if (workerHandle) steps.push(argsTerminalClose({ terminal: workerHandle, tab: true }));
  if (workerId) steps.push(argsWorktreeRm({ worktree: workerId, force: true }));
  return steps;
}

/** 回滚步骤跑完后的可见性：失败必须单独叫，不能只埋在返回 JSON 里。 */
export function rollbackReport(steps) {
  const list = (Array.isArray(steps) ? steps : []).map((s) => {
    if (!s || s.ok) return s;
    if (s.alreadyGone || rollbackErrorAlreadyGone(s.error)) {
      return { ...s, ok: true, alreadyGone: true, error: undefined };
    }
    return s;
  });
  const failed = list.filter(s => s && s.ok === false);
  if (failed.length === 0) {
    return { rollbackFailed: false, alarm: null, failed: [], steps: list };
  }
  const detail = failed.map(s => `${s.cmd || '?'} → ${s.error || '失败'}`).join('; ');
  return {
    rollbackFailed: true,
    alarm: `回滚失败，可能留下孤儿终端/树：${detail}`,
    failed,
    steps: list,
  };
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
// 缺参数就跑不起来。拦旁路的闸门在 dispatch-gate.mjs（#546）：载体只有在「唯一入口」时才是约束。

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
 * 派工约束硬闸。缺一即失败，并列出缺什么。
 * --role 而无 --model：读分时路由给推荐，必须 --confirm，禁静默默认。
 * --merge-policy 默认 auto（拍板 issue #511：帅不再是合并关口）；选 manual 必须
 * 同时给 --merge-reason（例外留痕，理由为空即退出，不靠记性）。
 */
export function resolveDispatchConstraints({
  mergePolicy, mergeReason, model, role, reviewer, confirm, routing, now = new Date(),
} = {}) {
  const missing = [];
  const policy = mergePolicy || 'auto';
  if (!MERGE_POLICIES.includes(policy)) {
    return {
      ok: false,
      missing: [],
      error: `--merge-policy 只允许 auto|manual，实际 ${policy}`,
    };
  }
  if (policy === 'manual' && !String(mergeReason || '').trim()) {
    return {
      ok: false,
      missing: ['--merge-reason'],
      error: '--merge-policy manual 必须给 --merge-reason（例外留痕；只限改协作约定 / 改 model-routing.toml 决策字段 / 花钱，见 #511）',
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
    mergePolicy: policy,
    mergeReason: policy === 'manual' ? String(mergeReason || '').trim() : null,
    model: resolvedModel,
    role: role || null,
    reviewer,
    recommendation,
  };
}

export function reviewerCardName(reviewerId) {
  return `审官·${reviewerId}`;
}

// ── 消歧门（#565）：项化派工前的硬门控 ────────────────────────────────────
// dao-project skill 第二节：待拍板不是停车场，是所有项都要过的一道门，过不了不许派。
// dispatch / worker-start 带 --issue 时，目标 issue 必须已打「已消歧」label，读不到拒派（fail-close）。
// 三态必须分得开（#565 硬约束）：查成且有 label / 查成但没 label / 没查成（gh 失败）。
// 没查成不许当有 label 放行——「没查成」当「查过没事」是事故类（#532 通用原则）。
export const DISAMBIGUATED_LABEL = '已消歧';
export function checkIssueDisambiguated({ issue, runGh } = {}) {
  const n = String(issue ?? '').trim();
  if (!n) return { ok: true, gated: false, issue: null };
  if (!/^\d+$/.test(n)) {
    return { ok: false, gated: true, issue: n, error: `--issue 必须是 issue 号，实际「${n}」` };
  }
  if (typeof runGh !== 'function') {
    return { ok: false, gated: true, issue: n, unscanned: true, error: '消歧门没拿到 gh 执行器——没查成，不许放行' };
  }
  const r = runGh(['issue', 'view', n, '--json', 'labels']);
  if (!r.ok) {
    return {
      ok: false, gated: true, issue: n, unscanned: true,
      error: `gh 读 issue #${n} labels 失败——不是查过没事，是没查成：${r.error}`,
    };
  }
  let labels = [];
  try {
    const parsed = JSON.parse(r.out);
    labels = Array.isArray(parsed?.labels) ? parsed.labels : [];
  } catch {
    return {
      ok: false, gated: true, issue: n, unscanned: true,
      error: `gh 读 issue #${n} labels 返回不是 JSON——没查成，不许放行：${String(r.out).slice(0, 120)}`,
    };
  }
  const names = labels.map(l => l && l.name).filter(Boolean);
  if (!names.includes(DISAMBIGUATED_LABEL)) {
    return {
      ok: false, gated: true, issue: n, hasLabel: false, labels: names,
      error: `issue #${n} 缺「${DISAMBIGUATED_LABEL}」label，拒派（fail-close，忘打标是拦住不是放行）。`
        + `去该 issue 补消歧记录（岔路清单 + 结论 + 依据，依据要用户拍的或有旧拍板可依，见 dao-project skill 第二节），`
        + `再打「${DISAMBIGUATED_LABEL}」label 后重试派工。`,
    };
  }
  return { ok: true, gated: true, issue: n, hasLabel: true, labels: names };
}

/** 卡名组装（#559 追加：派工那一刻 PR 不存在，卡名先带 issue 号）。
 * 给了 --issue N：`#N - <动宾短语>`（name 已带 #N 前缀则去重）；子卡 `#N - 审官·<模型>`。
 * 没给 --issue：原样返回 name。 */
export function assembleCardName({ name, issue } = {}) {
  const issueText = String(issue ?? '').trim();
  if (!issueText || !/^\d+$/.test(issueText)) return String(name ?? '').trim();
  const n = String(name ?? '').trim();
  const prefix = `#${issueText}`;
  let stem = n;
  if (n.startsWith(prefix)) stem = n.slice(prefix.length).replace(/^\s*[-–—]\s*/, '').trim();
  return [prefix, stem].filter(Boolean).join(' - ');
}

// ── #564 label 自动打：dispatch 记 issue，帅合并时同步到 PR ─────────
// calibrate 读的是 PR 上的 model/* 与 type/*（每 label 必须有程序读它）；派工时 PR 还不存在，
// 所以：dispatch 成功时把 model/<模型> type/<角色> 打到目标 issue；帅合并时由
// `dao pr-sync-labels --pr <N>` 从 issue 同步到 PR。角色缺省写码（dispatch 默认写码类派工）。
// #586：审官选型另记 reviewer/<模型>。label 记「决定」，工人完工时用 pickReviewer 复算。

export const DEFAULT_DISPATCH_TYPE = '写码';
export const REVIEWER_LABEL_PREFIX = 'reviewer/';

export function dispatchLabelNames({ model, role, reviewer } = {}) {
  const names = [];
  if (model && String(model).trim()) names.push(`model/${String(model).trim()}`);
  names.push(`type/${String(role || DEFAULT_DISPATCH_TYPE).trim()}`);
  if (reviewer && String(reviewer).trim()) names.push(`${REVIEWER_LABEL_PREFIX}${String(reviewer).trim()}`);
  return names;
}

function labelNameOf(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && typeof item.name === 'string') return item.name;
  return '';
}

/**
 * 从 label 列表读出唯一的审官模型。无 IO、可复算。
 * 三态必须输出不同的话：查到一个 / 没有 reviewer/* / 有多个。
 * 后两者都算没查成，不许猜一个。没拿到列表（null/非数组）和「扫完 0 条」也要分开。
 */
export function pickReviewer(labels) {
  if (labels == null || !Array.isArray(labels)) {
    return {
      ok: false,
      state: 'unscanned',
      error: 'pickReviewer 没拿到 label 列表（没查成，不许猜）',
    };
  }
  const hits = labels
    .map(labelNameOf)
    .filter(name => name.startsWith(REVIEWER_LABEL_PREFIX) && name.length > REVIEWER_LABEL_PREFIX.length);
  if (hits.length === 0) {
    return {
      ok: false,
      state: 'none',
      error: '没有 reviewer/* label（扫完 0 条，不许猜一个）',
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      state: 'many',
      labels: hits,
      error: `有多个 reviewer/* label（${hits.join('、')}，不许猜一个）`,
    };
  }
  return {
    ok: true,
    state: 'one',
    modelId: hits[0].slice(REVIEWER_LABEL_PREFIX.length),
    label: hits[0],
  };
}

/** 读 PR 署名 issue 上的 label，再走 pickReviewer。传了 explicit 就用它（工人路径不传）。 */
export function resolveReviewerFromPr({ pr, reviewer, runGh } = {}) {
  if (reviewer && String(reviewer).trim()) {
    return { ok: true, source: 'flag', modelId: String(reviewer).trim() };
  }
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'resolveReviewerFromPr 没给 PR 号' };
  if (typeof runGh !== 'function') {
    return { ok: false, unscanned: true, error: 'resolveReviewerFromPr 没拿到 gh 执行器（没查成，不许猜）' };
  }
  const view = runGh(['pr', 'view', n, '--json', 'title,body']);
  if (!view.ok) return { ok: false, unscanned: true, error: `gh pr view #${n} 失败：${view.error}` };
  let meta;
  try { meta = JSON.parse(view.out); }
  catch { return { ok: false, unscanned: true, error: `gh pr view #${n} 返回非 JSON：${String(view.out).slice(0, 120)}` }; }
  const refs = linkedIssueNumbers(`${meta.title || ''}\n${meta.body || ''}`);
  if (!refs.length) {
    return { ok: false, unscanned: false, error: `PR #${n} 没有署名单号，读不到 reviewer/*（没查成，不许猜）` };
  }
  const collected = [];
  for (const issueNum of refs) {
    const iv = runGh(['issue', 'view', String(issueNum), '--json', 'labels']);
    if (!iv.ok) return { ok: false, unscanned: true, error: `gh issue view #${issueNum} 失败：${iv.error}` };
    let parsed;
    try { parsed = JSON.parse(iv.out); }
    catch { return { ok: false, unscanned: true, error: `gh issue view #${issueNum} 返回非 JSON` }; }
    const names = (Array.isArray(parsed?.labels) ? parsed.labels : []).map(labelNameOf).filter(Boolean);
    collected.push(...names);
  }
  const picked = pickReviewer(collected);
  if (!picked.ok) return { ...picked, source: 'label', refs };
  return { ...picked, source: 'label', refs };
}

/** 阶段一骨架：发完工 comment 的计划 + 自读选型。不建审官卡。 */
export function planWorkerDone({ pr, body, runGh } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'worker-done 要 --pr' };
  const resolved = resolveReviewerFromPr({ pr: n, runGh });
  if (!resolved.ok) return resolved;
  const issue = Array.isArray(resolved.refs) && resolved.refs[0] ? resolved.refs[0] : null;
  if (!issue) {
    return { ok: false, unscanned: false, error: `PR #${n} 没有署名单号，完工 comment 没处可发` };
  }
  const custom = body == null ? '' : String(body);
  if (custom && !/^完工/.test(custom)) {
    return { ok: false, unscanned: false, error: 'worker-done --body 首行必须以「完工」开头（流转器只认这个）' };
  }
  const comment = custom || [
    `完工：PR #${n} 阶段一骨架（未起审官）`,
    '',
    `自读选型：${resolved.modelId}`,
    '阶段一不接线：调 reviewer-create --dry-run，不建树。',
  ].join('\n');
  return {
    ok: true,
    wired: false,
    pr: n,
    issue,
    reviewer: resolved.modelId,
    reviewerSource: resolved.source,
    comment,
    reviewerCreate: {
      verb: 'reviewer-create',
      pr: n,
      args: ['--pr', n, '--dry-run'],
      invoked: false,
      reason: '阶段一骨架：要调 reviewer-create --dry-run（不建树），由 cmdWorkerDone 执行',
    },
  };
}

export function postIssueComment({ issue, body, runGh } = {}) {
  const n = String(issue ?? '').trim();
  if (!/^\d+$/.test(n)) return { ok: false, unscanned: true, error: 'postIssueComment 没给合法 issue 号' };
  if (!String(body || '').trim()) return { ok: false, error: 'postIssueComment 没给正文' };
  if (typeof runGh !== 'function') return { ok: false, unscanned: true, error: 'postIssueComment 没拿到 gh 执行器' };
  const r = runGh(['issue', 'comment', n, '--body', String(body)]);
  if (!r.ok) return { ok: false, error: `issue #${n} 发评论失败：${r.error}` };
  return { ok: true, issue: n };
}

export function postPrComment({ pr, body, runGh } = {}) {
  const n = String(pr ?? '').trim();
  if (!/^\d+$/.test(n)) return { ok: false, unscanned: true, error: 'postPrComment 没给合法 PR 号' };
  if (!String(body || '').trim()) return { ok: false, error: 'postPrComment 没给正文' };
  if (typeof runGh !== 'function') return { ok: false, unscanned: true, error: 'postPrComment 没拿到 gh 执行器' };
  const r = runGh(['pr', 'comment', n, '--body', String(body)]);
  if (!r.ok) return { ok: false, error: `PR #${n} 发评论失败：${r.error}` };
  return { ok: true, pr: n };
}

/** 仓内现有 label 名。没查成返回 null（不许当「没有」去瞎建）。 */
export function ghLabelNames(runGh) {
  if (typeof runGh !== 'function') return null;
  const r = runGh(['label', 'list', '--limit', '1000', '--json', 'name']);
  if (!r.ok) return null;
  try {
    const arr = JSON.parse(r.out);
    return Array.isArray(arr) ? arr.map(x => x && x.name).filter(Boolean) : null;
  } catch { return null; }
}

/** 确保仓里存在这些 label（缺的建，已存在不动）。建 label 是仓库级一次性动作，幂等。 */
export function ensureRepoLabels({ names, runGh } = {}) {
  if (!Array.isArray(names) || !names.length) return { ok: true, created: [] };
  if (typeof runGh !== 'function') return { ok: false, unscanned: true, error: 'ensureRepoLabels 没拿到 gh 执行器' };
  const existing = ghLabelNames(runGh);
  if (existing === null) return { ok: false, unscanned: true, error: 'gh label list 没查成——不知道该建哪些' };
  const missing = names.filter(n => !existing.includes(n));
  const created = [];
  for (const name of missing) {
    const c = runGh(['label', 'create', name]);
    if (!c.ok) return { ok: false, error: `建 label「${name}」失败：${c.error}` };
    created.push(name);
  }
  return { ok: true, created, existing };
}

/** 派工成功侧：把 model/<模型> type/<角色> reviewer/<审官> 打到目标 issue（best-effort：失败只报告，不翻转派工结果）。 */
export function stampIssueLabels({ issue, model, role, reviewer, runGh } = {}) {
  const n = String(issue ?? '').trim();
  if (!/^\d+$/.test(n)) {
    return { ok: false, skipped: true, issue: n, error: '没给合法 issue 号，label 不打' };
  }
  const names = dispatchLabelNames({ model, role, reviewer });
  if (typeof runGh !== 'function') {
    return { ok: false, issue: n, unscanned: true, error: 'stampIssueLabels 没拿到 gh 执行器——label 没打' };
  }
  const ensured = ensureRepoLabels({ names, runGh });
  if (!ensured.ok) return { ok: false, issue: n, unscanned: ensured.unscanned === true, error: ensured.error };
  const add = [];
  for (const name of names) add.push('--add-label', name);
  const r = runGh(['issue', 'edit', n, ...add]);
  if (!r.ok) return { ok: false, issue: n, error: `issue #${n} 打 label 失败：${r.error}` };
  return { ok: true, issue: n, names, created: ensured.created, labels: names };
}

/** PR 正文/标题里的署名单号：只认 GitHub 的关闭关键词（Closes/Fixes/Resolves…），
 * 正文里随手引用的 #单号 不是署名，不许拿去抄 label（会串到别的单的 model/type）。 */
export function linkedIssueNumbers(text) {
  const found = [];
  const re = /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const t = Number(m[1]);
    if (!found.includes(t)) found.push(t);
  }
  return found;
}

/** 合并侧（帅合并时跑）：PR 正文 Closes 到的 issue 上取 model/* type/* reviewer/* label，抄到 PR。
 * PR 上没署名 issue / 署名 issue 缺 model/* 或 type/* / gh 没查成——三种都要说清楚，不许静默。
 * reviewer/* 有则抄、没有不挡；但只有 reviewer/*、缺校准标签，不许 pr edit。 */
export function syncPrLabelsFromIssue({ pr, runGh } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'syncPrLabelsFromIssue 没给 PR 号' };
  if (typeof runGh !== 'function') return { ok: false, unscanned: true, error: 'syncPrLabelsFromIssue 没拿到 gh 执行器' };
  const view = runGh(['pr', 'view', n, '--json', 'title,body']);
  if (!view.ok) return { ok: false, unscanned: true, error: `gh pr view #${n} 失败：${view.error}` };
  let meta;
  try { meta = JSON.parse(view.out); }
  catch { return { ok: false, unscanned: true, error: `gh pr view #${n} 返回非 JSON：${String(view.out).slice(0, 120)}` }; }
  const refs = linkedIssueNumbers(`${meta.title || ''}\n${meta.body || ''}`);
  if (!refs.length) {
    return { ok: false, unscanned: false, error: `PR #${n} 正文/标题里没有 Closes/Fixes 署名单号——label 无从同步，需人工补` };
  }
  const from = [];
  for (const issueNum of refs) {
    const iv = runGh(['issue', 'view', String(issueNum), '--json', 'labels']);
    if (!iv.ok) return { ok: false, unscanned: true, error: `gh issue view #${issueNum} 失败：${iv.error}` };
    let labels = [];
    try {
      const parsed = JSON.parse(iv.out);
      labels = Array.isArray(parsed?.labels) ? parsed.labels : [];
    } catch { return { ok: false, unscanned: true, error: `gh issue view #${issueNum} 返回非 JSON` }; }
    const names = labels
      .map(l => (l && typeof l === 'object' ? l.name : l))
      .filter(name => typeof name === 'string' && /^(model\/|type\/|reviewer\/)/.test(name));
    if (names.length) from.push({ issue: issueNum, labels: names });
  }
  const want = [...new Set(from.flatMap(f => f.labels))];
  const hasModel = want.some(name => name.startsWith('model/'));
  const hasType = want.some(name => name.startsWith('type/'));
  if (!hasModel || !hasType) {
    const missing = [!hasModel && 'model/*', !hasType && 'type/*'].filter(Boolean).join(' 和 ');
    return {
      ok: false,
      unscanned: false,
      error: `PR #${n} 的署名 issue 上缺 ${missing} label（派工漏打？）——需人工补，不许只靠 reviewer/* 过关`,
      refs,
      labels: want,
    };
  }
  const ensured = ensureRepoLabels({ names: want, runGh });
  if (!ensured.ok) return { ok: false, unscanned: ensured.unscanned === true, error: ensured.error };
  const add = [];
  for (const name of want) add.push('--add-label', name);
  const edit = runGh(['pr', 'edit', n, ...add]);
  if (!edit.ok) return { ok: false, error: `PR #${n} 打 label 失败：${edit.error}` };
  return { ok: true, pr: n, labels: want, refs, from, created: ensured.created };
}


export function dispatchComment({ mergePolicy, mergeReason, model, reviewer }) {
  const base = `merge-policy:${mergePolicy} · model:${model} · reviewer:${reviewer}`;
  if (mergePolicy === 'manual' && mergeReason) {
    return `${base} · manual 理由: ${mergeReason}`;
  }
  return base;
}

// ── 闭环任务书模板（#546 追加第五件）──────────────────────────
// 士兵 / 审官任务书模板在 host/skills/dispatch/templates/，不硬编码进代码——
// 模板要能被读、被改（#507 教训：写原则 + 「以当时的任务书为准」，别写死会过时的具体职责）。
// 占位符 {{KEY}} 填充失败（模板缺文件 / 占位符没被换掉）必须失败退出，不许带着空位派出去。

export const DISPATCH_TEMPLATE_DIR = join(ROOT, 'host', 'skills', 'dispatch', 'templates');

export function listDispatchTemplates() {
  if (!existsSync(DISPATCH_TEMPLATE_DIR)) return [];
  return readdirSync(DISPATCH_TEMPLATE_DIR)
    .filter(f => f.endsWith('.md'))
    .sort();
}

/** 读模板原文。拿不到就抛（同 dao 全局：不许静默当成空模板）。 */
export function readDispatchTemplate(name) {
  if (!/^[a-z0-9-]+\.md$/.test(String(name || ''))) throw new Error(`模板名不合法: ${name}`);
  const p = join(DISPATCH_TEMPLATE_DIR, name);
  if (!existsSync(p)) throw new Error(`任务书模板不在: ${p}`);
  return readFileSync(p, 'utf8');
}

/** 填充 {{KEY}} 占位符。所有占位符必须全部被替换，剩一个就是失败。
 * #559 审官红项：占位符填成字面量 "undefined"/"null"（如 String(missingId)）等于没填，
 * 必须抛——否则渲染出 dispatch:undefined，士兵/审官把消息发进不存在的收件箱。 */
export function renderDispatchTemplate(name, vars = {}) {
  const text = readDispatchTemplate(name);
  const out = String(text).replace(/\{\{(\w+)\}\}/g, (m, key) => {
    const v = vars[key];
    if (v === undefined || v === null) throw new Error(`模板 ${name} 占位符 {{${key}}} 没给值`);
    const s = String(v);
    if (/^(undefined|null)$/i.test(s.trim())) {
      throw new Error(`模板 ${name} 占位符 {{${key}}} 填了无效值（${s.trim()}）——真 id 缺失，不许渲染出 dispatch:undefined`);
    }
    return s;
  });
  if (/\{\{\w+\}\}/.test(out)) throw new Error(`模板 ${name} 还有未替换占位符`);
  return out;
}

// ── 闭环投递（发不到必须炸，#548 红项 1）──────────────────────────
//
// 为什么判据放在「发之前」而不是 delivered_at：
// orca orchestration send 对**不存在的 handle** 也返回 exit 0 / ok:true / delivered_at:null；
// 而对**活着的 handle**（自发自收实测）返回的同样是 delivered_at:null。
// 也就是说 delivered_at 在本机这版 Orca 上分不开「链断了」和「刚发出去」，
// 拿它当门 = 每条都判红的假守卫。真正能分辨收件人在不在的只有两处：
//   term_ handle → terminal read 报 terminal_handle_stale
//   run: 信箱    → run-show 报 run_not_found
// 所以：投递前先证收件人在，投递后核回执与落库，delivered_at 只如实报出、不当唯一判据。

export function argsOrchestrationSend({ to, subject, body, type, outcome } = {}) {
  const a = ['orchestration', 'send'];
  if (to) a.push('--to', to);
  if (subject != null) a.push('--subject', subject);
  if (body != null) a.push('--body', body);
  if (type) a.push('--type', type);
  if (outcome) a.push('--outcome', outcome);
  a.push('--json');
  return a;
}

export function argsOrchestrationInbox({ terminal, limit, full } = {}) {
  const a = ['orchestration', 'inbox'];
  if (terminal) a.push('--terminal', terminal);
  if (limit != null) a.push('--limit', String(limit));
  if (full) a.push('--full');
  a.push('--json');
  return a;
}

export function argsRunShow({ id } = {}) {
  const a = ['orchestration', 'run-show'];
  if (id) a.push('--id', id);
  a.push('--json');
  return a;
}

export function argsRunCurrent() {
  return ['orchestration', 'run-current', '--json'];
}

/** 收件人形态。闭环三跳只有四种合法收件人，其余一律拒发（发出去没人负责 = 静默断链）。
 * term_… = 终端 handle（低层通道）；run:… = Run 信箱；dispatch:… = 受监督工人的结构化收件箱
 * （#559 官方通道优先：`send --to dispatch:<id>` 是结构化收件箱邮件，不是 prompt injection，
 * worker 的下一步 orchestration check 会收到它）；省略 = 自己那条 Run 信箱。 */
export function classifyNotifyTarget(to) {
  const t = String(to ?? '').trim();
  if (!t) return { kind: 'own-run', id: null };
  if (/^term_/.test(t)) return { kind: 'terminal', id: t };
  if (/^run:/.test(t)) return { kind: 'run', id: t.slice(4) };
  if (/^dispatch:/.test(t)) return { kind: 'dispatch', id: t.slice('dispatch:'.length) };
  if (t.startsWith('@')) {
    return { kind: 'unsupported', error: `闭环通知不发组播（${t}）：组播没人负责签收，收不到也看不出来` };
  }
  return { kind: 'unsupported', error: `收件人形态不认识: ${t}（只收 term_… / run:… / dispatch:… / 省略=自己那条 Run 信箱）` };
}

function orcaErrText(error) {
  if (typeof error === 'object' && error) {
    const code = String(error.code || '').trim();
    const msg = String(error.message || '').trim();
    return code && msg && code !== msg ? `${code}: ${msg}` : (code || msg);
  }
  return String(error || '').trim();
}

/** 投递前证收件人真的在。拿不到 ≠ 没有：分不开就标 unscanned，一样非零。 */
export function probeRecipient(target, orca) {
  if (typeof orca !== 'function') throw new Error('probeRecipient 要 orca 执行器');
  if (target.kind === 'terminal') {
    const r = orca(argsTerminalRead({ terminal: target.id, limit: 1 }));
    if (r.ok) return { ok: true, kind: 'terminal', id: target.id, status: r.json?.result?.terminal?.status ?? null };
    const text = orcaErrText(r.error);
    if (/terminal_handle_stale|not_found/i.test(text)) {
      return { ok: false, kind: 'terminal', id: target.id, error: `收件人终端不存在或已失效（${text}）：${target.id}` };
    }
    return { ok: false, unscanned: true, kind: 'terminal', id: target.id, error: `收件人活性没查成（不等于收件人不在）：${text}` };
  }
  if (target.kind === 'run') {
    const r = orca(argsRunShow({ id: target.id }));
    if (r.ok && r.json?.result?.run) return { ok: true, kind: 'run', id: target.id };
    if (r.ok) return { ok: false, kind: 'run', id: target.id, error: `Run 信箱查无此 Run: ${target.id}` };
    const text = orcaErrText(r.error);
    if (/run_not_found/i.test(text)) {
      return { ok: false, kind: 'run', id: target.id, error: `Run 信箱不存在（run_not_found）：${target.id}` };
    }
    return { ok: false, unscanned: true, kind: 'run', id: target.id, error: `Run 信箱没查成: ${text}` };
  }
  if (target.kind === 'dispatch') {
    // #559 官方通道：dispatch:<id> 是受监督工人的结构化收件箱。
    // 活性判据 = worker-show 能查到该 Dispatch（dispatch_not_found = 收件人不在，链断当场炸）。
    const r = orca(argsWorkerShow({ dispatch: target.id }));
    if (r.ok && r.json?.result?.dispatch?.id === target.id) {
      return {
        ok: true, kind: 'dispatch', id: target.id,
        status: r.json?.result?.worker?.state ?? null,
        assigneeHandle: r.json?.result?.dispatch?.assignee_handle ?? null,
      };
    }
    if (r.ok) {
      return { ok: false, kind: 'dispatch', id: target.id, error: `Dispatch 查无此 id: ${target.id}` };
    }
    const text = orcaErrText(r.error);
    if (/dispatch_not_found|not_found|stale/i.test(text)) {
      return { ok: false, kind: 'dispatch', id: target.id, error: `收件人 Dispatch 不存在或已失效（${text}）：${target.id}` };
    }
    return { ok: false, unscanned: true, kind: 'dispatch', id: target.id, error: `收件人 Dispatch 活性没查成（不等于收件人不在）：${text}` };
  }
  const r = orca(argsRunCurrent());
  if (!r.ok) {
    const text = orcaErrText(r.error);
    return { ok: false, unscanned: true, kind: 'own-run', error: `本终端绑的 Run 没查成: ${text}` };
  }
  const run = r.json?.result?.run;
  if (!run) return { ok: false, kind: 'own-run', error: '本终端没绑 orchestration Run，省略收件人 = 发进真空' };
  return { ok: true, kind: 'own-run', id: run.id || null };
}

/** send 的回执。真返回在 result.message，顶层 id 是 RPC id，不能当消息 id。
 * to_handle / to_dispatch 都可能是收件人落点（send --to dispatch:<id> 的消息字段形态以当时返回为准）。 */
export function extractSentMessage(json) {
  const m = json?.result?.message || json?.message || null;
  if (!m || !m.id) return null;
  return {
    id: m.id,
    toHandle: m.to_handle ?? null,
    toDispatch: m.to_dispatch ?? null,
    deliveredAt: m.delivered_at ?? null,
  };
}

/** 落库复核。扫不到任何样本 → unscanned（「没查成」不许当「查过没事」）。 */
export function findInboxMessage(inboxJson, messageId) {
  const list = inboxJson?.result?.messages;
  if (!Array.isArray(list)) return { scanned: false, found: false, message: null };
  const hit = list.find(m => m && m.id === messageId) || null;
  return { scanned: true, found: !!hit, message: hit, sampled: list.length };
}

/**
 * 闭环一跳的投递：收件人在 → 发 → 有回执 → 落库可查。四关缺一即失败。
 * 失败一律返回 ok:false（调用方非零退出并升级），不许当「发成功了只是还没读」。
 *
 * 边界（别误读）：**四关验的是投递，不是结算**。`ok:true` 只说明这条消息确实进了
 * 收件人的信箱，不代表对面读了、更不代表事情办完了——编排里那条任务不会因为
 * 发过一条消息就变 completed。要「发出即结算」的信号（worker_done 那类）另有一套
 * Dispatch 身份要求，notify 目前不提供，见 issue #551；在那之前不要给 notify 加
 * `--type worker_done` 来假装结算：面板会显示成结算了而实际没有，比不发更糟。
 */
export function deliverMessage({
  to = null, subject, body = '', type, outcome, hop = '闭环通知', orca, inboxLimit = 50,
} = {}) {
  if (typeof orca !== 'function') throw new Error('deliverMessage 要 orca 执行器');
  if (!subject) return { ok: false, hop, stage: '参数', error: `${hop}：缺 --subject，没主题的通知等于没通知` };

  const target = classifyNotifyTarget(to);
  if (target.kind === 'unsupported') return { ok: false, hop, stage: '收件人', error: `${hop}：${target.error}` };

  const pre = probeRecipient(target, orca);
  if (!pre.ok) {
    return { ok: false, hop, stage: '收件人', unscanned: !!pre.unscanned, error: `${hop}：${pre.error}`, recipient: pre };
  }

  const sent = orca(argsOrchestrationSend({ to, subject, body, type, outcome }));
  if (!sent.ok) {
    const text = orcaErrText(sent.error);
    return { ok: false, hop, stage: '发送', error: `${hop}：orca send 失败: ${text}`, recipient: pre };
  }

  const msg = extractSentMessage(sent.json);
  if (!msg) {
    return { ok: false, hop, stage: '回执', error: `${hop}：orca 说发出去了却没给消息回执 —— 拿不到回执就当没送到`, recipient: pre };
  }
  if (to) {
    const expected = String(to);
    const badHandle = msg.toHandle && msg.toHandle !== expected;
    const badDispatch = msg.toDispatch
      && (expected.startsWith('dispatch:')
        ? msg.toDispatch !== expected && msg.toDispatch !== expected.slice('dispatch:'.length)
        : msg.toDispatch !== expected);
    if (badHandle || badDispatch) {
      return {
        ok: false, hop, stage: '回执', messageId: msg.id,
        error: `${hop}：回执收件人是 ${msg.toHandle || msg.toDispatch}，与请求的 ${expected} 不一致（错投）`, recipient: pre,
      };
    }
  }

  const inbox = orca(argsOrchestrationInbox({ limit: inboxLimit, full: true }));
  if (!inbox.ok) {
    const text = orcaErrText(inbox.error);
    return { ok: false, hop, stage: '复核', unscanned: true, messageId: msg.id, error: `${hop}：投递复核没查成: ${text}`, recipient: pre };
  }
  const found = findInboxMessage(inbox.json, msg.id);
  if (!found.scanned) {
    return { ok: false, hop, stage: '复核', unscanned: true, messageId: msg.id, error: `${hop}：复核没扫到任何消息样本，这次没查成`, recipient: pre };
  }
  if (!found.found) {
    return { ok: false, hop, stage: '复核', messageId: msg.id, error: `${hop}：回执给了 ${msg.id}，编排里却查不到这条消息`, recipient: pre };
  }

  return {
    ok: true, hop, stage: '已送达', messageId: msg.id,
    to: msg.toHandle ?? (pre.id || null),
    deliveredAt: found.message?.delivered_at ?? null,
    recipient: pre,
    sampled: found.sampled,
  };
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
  'worker-start', 'worker-release', 'worker-read', 'worker-done', 'reviewer-create', 'reviewer-attach', 'send', 'notify', 'reply',
  'gate-create', 'gate-resolve', 'gate-list', 'liveness', 'check-help', 'pr-sync-labels', 'raw',
];

const BOOL_FLAGS = new Set(['no-parent', 'force', 'enter', 'dry-run', 'json', 'confirm']);

export const FLAGS_BY_VERB = {
  start: new Set(['--provider', '--model', '--worktree', '--title', '--dry-run', '--json', '--help', '-h']),
  dispatch: new Set([
    '--name', '--merge-policy', '--merge-reason', '--model', '--role', '--reviewer', '--confirm',
    '--spec', '--task', '--issue', '--now', '--dry-run', '--json', '--help', '-h',
  ]),
  'worktree-create': new Set([
    '--name', '--no-parent', '--setup', '--parent-worktree', '--base-branch',
    '--issue', '--comment', '--json', '--help', '-h',
  ]),
  'worktree-rm': new Set(['--worktree', '--force', '--json', '--help', '-h']),
  'task-create': new Set(['--spec', '--json', '--help', '-h']),
  'worker-start': new Set([
    '--task', '--worktree', '--terminal', '--retry-of', '--issue', '--merge-policy', '--merge-reason',
    '--model', '--role', '--reviewer', '--confirm', '--now', '--json', '--help', '-h',
  ]),
  'worker-release': new Set(['--dispatch', '--retry-request', '--json', '--help', '-h']),
  'worker-read': new Set(['--dispatch', '--source', '--cursor', '--limit', '--json', '--help', '-h']),
  'worker-done': new Set(['--pr', '--body', '--dry-run', '--json', '--help', '-h']),
  'reviewer-create': new Set([
    '--pr', '--name', '--reviewer', '--parent-worktree', '--comment', '--dry-run', '--json', '--help', '-h',
  ]),
  'reviewer-attach': new Set([
    '--pr', '--worktree', '--reviewer', '--name', '--soldier-dispatch', '--spec',
    '--merge-policy', '--merge-reason', '--comment', '--issue', '--dry-run', '--json', '--help', '-h',
  ]),
  send: new Set(['--terminal', '--text', '--enter', '--json', '--help', '-h']),
  notify: new Set([
    '--to', '--subject', '--body', '--type', '--outcome', '--hop', '--json', '--help', '-h',
  ]),
  reply: new Set(['--id', '--body', '--from', '--json', '--help', '-h']),
  'gate-create': new Set(['--task', '--question', '--options', '--from', '--json', '--help', '-h']),
  'gate-resolve': new Set(['--id', '--resolution', '--from', '--json', '--help', '-h']),
  'gate-list': new Set(['--task', '--status', '--run', '--json', '--help', '-h']),
  liveness: new Set(['--path', '--json', '--help', '-h']),
  'check-help': new Set(['--json', '--help', '-h']),
  'pr-sync-labels': new Set(['--pr', '--json', '--help', '-h']),
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

派工（约束载体，缺一即退；merge-policy 默认 auto）：
  dispatch --name <动宾短语> [--issue <issue号>] [--merge-policy auto|manual] [--merge-reason <文>] --reviewer <模型id> --spec <文> (--model <id> | --role <角色> [--confirm]) [--dry-run]
启动:
  start --provider <名> | --model <id> --worktree <sel> [--title <名>] [--dry-run]
编排:
  worktree-create --name <动宾短语> [--issue <issue号>] [--no-parent] [--setup skip] [--parent-worktree <sel>] [--base-branch <ref>] [--comment <文>]
  reviewer-create --pr <N> [--name <名>] [--reviewer <模型id>] [--parent-worktree <sel>] [--comment <文>] [--dry-run]
                  # 不传 --reviewer 时自读署名 issue 的 reviewer/*（#586）；--dry-run 只打印选型不建树
                  # #575 ⑦：mergeable!=MERGEABLE 拒建树；建树后试合 master 再 abort，HEAD 仍停在 PR head
  worker-done --pr <N> [--body <文>] [--dry-run]
                  # 阶段一骨架：发完工 comment（issue+PR）+ 调 reviewer-create --dry-run；不建审官卡
  reviewer-attach --pr <N> --worktree <工人卡> --reviewer <模型id> [--name <名>] [--soldier-dispatch <id>] [--spec <文>]
                  # 给已有工人卡补派审官（#575）：建树+起终端+注入+验开工，一条命令，不碰 raw
  pr-sync-labels --pr <N>   # 合并前把署名 issue 的 model/* type/* reviewer/* label 同步到 PR（#564 + #586）
  worktree-rm --worktree <sel> [--force]
  task-create --spec <文>
  worker-start --task <id> --terminal <handle> [--worktree <sel>] [--issue <issue号>] [--merge-policy auto|manual] [--merge-reason <文>] --reviewer <id> (--model <id> | --role <角色> [--confirm]) [--retry-of <id>]
  worker-release --dispatch <id>   # 结算后收尾：release 或转移所有权（#559 ⑤），不 release 会留孤儿工位
  worker-read --dispatch <id> [--source auto|transcript|terminal] [--limit <n>]   # 读工人输出/开工证明（#559 ⑥）
  send --terminal <handle> --text <文> [--enter]
  notify --subject <文> [--to <term_…|run:…|dispatch:…>] [--body <文>] [--type <类>] [--outcome succeeded|failed] [--hop <跳名>]
  reply --id <消息id> --body <回答> [--from <handle>]   # 帅回答工人的 ask 提问，回答进编排记录（#559 ③）
  gate-create --task <task_id> --question <问题> [--options <json数组>]   # 上帅裁定建原生决策门（#559 ④）
  gate-resolve --id <gate_id> --resolution <裁定>                          # 帅裁定决议门
  gate-list [--task <task_id>] [--status <状态>]
其他:
  liveness [--path <工作树>]
  check-help
  raw -- <任意命令...>     逃生口，必须留痕

notify 是闭环三跳（士兵→审官 / 审官→士兵 / 审官→帅）唯一的发信口：收件人不在、回执拿不到、
落库查不到，一律非零退出并在 stderr 打「链断」，不许当「发成功了只是还没读」。
收件人形态：dispatch:<id>（官方结构化收件箱，士兵↔审官互发用；#559 ①）、run:…（审官→帅）、
term_…（低层通道）、省略（自己那条 Run 信箱）。
delivered_at 只如实报出，不当判据（本机 Orca 对活着的收件人也常留 null，当门就是天天假红）。
notify 验的是**投递**不是**结算**：ok:true 只说明消息进了收件人信箱，不代表对面读了、
更不代表编排里那条任务变 completed。别加 --type worker_done 假装结算（见 issue #551）。

启动模板只读 docs/model-routing.toml [providers.*].launch，读失败非零退出。
派工不给 --model 时只推荐、要 --confirm，禁静默默认。未知 --参数 一律非零。
merge-policy 默认 auto（#511 拍板：帅只感知不再是关口）；选 manual 必须给 --merge-reason，
理由写进任务卡 comment 留痕，只限改协作约定 / 改 model-routing.toml 决策字段 / 花钱三类。
worker-start 的 --worktree 可省略：复用已存在终端续 Dispatch（worker_done 后同一终端绑到新 Task，
#559 ②）时工作区由终端决定；新开工人位仍建议显式给 --worktree。
换人（乒乓两轮仍红）走 worker-start --task <同单> --retry-of <旧 dispatch id>，不重开一单（#559 ⑦）。
续活/审官场景的 merge-policy 约束：新开派工语义；flow.mjs 内部与 reviewer-create 不归本动词管，见 dispatch skill。
给了 --issue <issue号> 时卡名自动组装成「#<issue号> - <动宾短语>」（子卡「#<issue号> - 审官·<模型>」），
并把 --issue 透传给 orca worktree create 把卡链到 GitHub issue（#559 追加：派工那一刻 PR 不存在，卡名先带 issue 号）。
dispatch / worker-start 带 --issue 时走消歧门（#565）：目标 issue 缺「已消歧」label 拒派（非 0 退出，fail-close）——
去该 issue 补消歧记录再打「已消歧」label（dao-project skill 第二节）；gh 查失败单独报「没查成」，不许当有 label 放行。
dispatch --dry-run 不走门控（不实际派工，disambiguation 只作报告，不影响退出码；#565 返工）。无 --issue 的派工不受门控（辅助终端不经 dispatch）。
`;
