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
import { orcaErrorText } from './orca-error.mjs';
import { isModelRejectText, normalizePipes } from './next-launch.mjs';
import { assertCrossVendor } from './reviewer-vendor-gate.mjs';
import { nextReviewerAfter } from './dianjiangtai-reviewer-slot.mjs';

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

export function resolveLaunch({ provider, model, routing, root = ROOT, pipe } = {}) {
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

  let command = String(p.launch).trim();
  if (command.includes('{model}')) {
    const cliModel = (chosen && chosen.cli_model) || (hit && hit.cli_model) || model || p.launch_model || p.default_model;
    if (!cliModel) {
      throw new Error(`providers.${providerName}.launch 含 {model} 但没给模型（--model / launch_model / default_model）`);
    }
    command = command.split('{model}').join(String(cliModel));
  }
  const materialized = materializeLaunch(command, root);
  return {
    provider: providerName,
    command: materialized,
    template: String(p.launch).trim(),
    pipe: chosen || null,
    agentId: orcaKnownAgentId({ provider: providerName, command: materialized }),
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

/** #602 四家对照：只有 grok 要把 LF 转成 Alt+Enter（ESC+CR）。claude/pi 原样；codex 换行留不住，不打补丁。 */
export function newlineCodec(agentOrProvider) {
  const a = String(agentOrProvider || '').toLowerCase();
  if (/grok|xai/.test(a)) return 'esc-cr';
  if (/gpt|codex/.test(a)) return 'passthrough-lost';
  return 'passthrough';
}

export function encodeSendText(text, agentOrProvider) {
  const s = String(text ?? '');
  if (newlineCodec(agentOrProvider) === 'esc-cr') {
    return s.replace(/\r\n|\n|\r/g, '\x1b\r');
  }
  return s;
}

export function argsTerminalSend({ terminal, text, enter, agent } = {}) {
  const a = ['terminal', 'send'];
  if (terminal) a.push('--terminal', terminal);
  if (text != null) a.push('--text', encodeSendText(text, agent));
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

export function argsWorktreeSet({ worktree, displayName, comment, workspaceStatus } = {}) {
  const a = ['worktree', 'set'];
  if (worktree) a.push('--worktree', worktree);
  if (displayName) a.push('--display-name', displayName);
  if (comment != null) a.push('--comment', comment);
  if (workspaceStatus) a.push('--workspace-status', workspaceStatus);
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

export function argsWorktreePs({ limit } = {}) {
  const a = ['worktree', 'ps'];
  if (limit != null) a.push('--limit', String(limit));
  a.push('--json');
  return a;
}

function worktreeKey(w) {
  return (w && (w.worktreeId || w.id)) || null;
}

export function occupyingAgents(w) {
  return (Array.isArray(w && w.agents) ? w.agents : [])
    .filter(a => a && (a.state === 'working' || a.state === 'waiting'));
}

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function branchTail(b) {
  return String(b || '').replace(/^refs\/heads\//, '');
}

/** 把 --worktree 选择器落到盘面上一棵卡。对不上 / 对上多棵都 fail-visible。 */
export function resolveWorktreeSelector(worktrees, selector) {
  const list = Array.isArray(worktrees) ? worktrees.filter(Boolean) : [];
  const raw = String(selector || '').trim();
  if (!raw) return { ok: false, error: 'worktree-rm 要 --worktree' };
  if (!list.length) return { ok: false, error: '盘面一张卡都没有，未删' };

  const hits = [];
  const wantIssue = raw.startsWith('issue:') ? Number(raw.slice(6)) : null;
  const wantName = raw.startsWith('name:') ? raw.slice(5) : null;
  const wantPath = raw.startsWith('path:') ? raw.slice(5) : null;
  const wantBranch = raw.startsWith('branch:') ? raw.slice(7) : null;
  const wantId = raw.startsWith('id:') ? raw.slice(3) : raw;

  for (const w of list) {
    const id = worktreeKey(w);
    if (raw === 'active' || raw === 'current') {
      if (w.isActive) hits.push(w);
      continue;
    }
    if (wantIssue != null && Number.isFinite(wantIssue) && Number(w.linkedIssue) === wantIssue) {
      hits.push(w);
      continue;
    }
    if (wantName != null && String(w.displayName || '') === wantName) {
      hits.push(w);
      continue;
    }
    if (wantPath != null && normPath(w.path) === normPath(wantPath)) {
      hits.push(w);
      continue;
    }
    if (wantBranch != null && (branchTail(w.branch) === branchTail(wantBranch) || w.branch === wantBranch)) {
      hits.push(w);
      continue;
    }
    if (id && (id === raw || id === wantId)) {
      hits.push(w);
      continue;
    }
    if (String(w.displayName || '') === raw) {
      hits.push(w);
      continue;
    }
    if (normPath(w.path) === normPath(raw)) {
      hits.push(w);
      continue;
    }
  }

  const uniq = [];
  const seen = new Set();
  for (const w of hits) {
    const id = worktreeKey(w) || String(w.path || '');
    if (seen.has(id)) continue;
    seen.add(id);
    uniq.push(w);
  }
  if (uniq.length === 0) return { ok: false, error: `找不到卡：${raw}` };
  if (uniq.length > 1) {
    return {
      ok: false,
      error: `选择器对上 ${uniq.length} 棵（${uniq.map(w => w.displayName || worktreeKey(w)).join('、')}），未删`,
    };
  }
  return { ok: true, worktree: uniq[0] };
}

function childrenOf(w, byId, all) {
  const ids = Array.isArray(w.childWorktreeIds) ? w.childWorktreeIds : [];
  const kids = [];
  const missing = [];
  const seen = new Set();
  for (const id of ids) {
    const child = byId.get(id);
    if (!child) missing.push({ id, name: id });
    else {
      kids.push(child);
      seen.add(worktreeKey(child));
    }
  }
  const selfId = worktreeKey(w);
  for (const other of all) {
    const oid = worktreeKey(other);
    if (!oid || seen.has(oid)) continue;
    if (other.parentWorktreeId === selfId) {
      kids.push(other);
      seen.add(oid);
    }
  }
  return { kids, missing };
}

/**
 * 整树后序删除计划：先查占用，再给出叶子→根的顺序。
 * 占用中 / 子卡失踪 / 主树 → ok:false，调用方不得开删。
 */
export function planWorktreeRm(worktrees, selector) {
  if (!Array.isArray(worktrees)) {
    return { ok: false, error: '盘面没查成（不是数组），未删任何树', order: [], occupied: [] };
  }
  const found = resolveWorktreeSelector(worktrees, selector);
  if (!found.ok) return { ok: false, error: found.error, order: [], occupied: [] };
  const root = found.worktree;
  if (root.isMainWorktree) {
    return {
      ok: false,
      error: `拒绝删主树（${root.displayName || worktreeKey(root)}）`,
      order: [],
      occupied: [],
    };
  }
  const byId = new Map();
  for (const w of worktrees) {
    const id = worktreeKey(w);
    if (id) byId.set(id, w);
  }
  const order = [];
  const occupied = [];
  const missing = [];
  const visiting = new Set();

  function walk(w) {
    const id = worktreeKey(w);
    if (!id) {
      missing.push({ id: '(无 id)', name: w.displayName || '?' });
      return;
    }
    if (visiting.has(id)) return;
    visiting.add(id);
    const rel = childrenOf(w, byId, worktrees);
    for (const m of rel.missing) missing.push(m);
    for (const c of rel.kids) walk(c);
    const occ = occupyingAgents(w);
    if (occ.length) {
      occupied.push({
        id,
        name: w.displayName || id,
        states: occ.map(a => a.state),
      });
    }
    order.push({ id, name: w.displayName || id, path: w.path || null });
  }

  walk(root);

  if (missing.length) {
    return {
      ok: false,
      error: `子卡在名单里但盘面找不到，占用没查成，未删任何树：${missing.map(m => m.name || m.id).join('、')}`,
      order: [],
      occupied,
      missing,
    };
  }
  if (occupied.length) {
    const detail = occupied.map(o => `${o.name}（agent=${o.states.join(',')}）`).join('；');
    return {
      ok: false,
      error: `占用中，未删任何树：${detail}`,
      order: [],
      occupied,
    };
  }
  return { ok: true, order, occupied: [], root: { id: worktreeKey(root), name: root.displayName || worktreeKey(root) } };
}

/** 按计划逐个删。中途失败必须带上已删名单，不许装成「没动过」。 */
export function applyWorktreeRmPlan(plan, { rm } = {}) {
  if (!plan || plan.ok !== true) {
    return { ok: false, error: (plan && plan.error) || '没有可执行的删除计划', removed: [] };
  }
  if (typeof rm !== 'function') {
    return { ok: false, error: 'applyWorktreeRmPlan 没给 rm', removed: [] };
  }
  const removed = [];
  for (const node of plan.order) {
    const r = rm(node);
    if (!r || r.ok !== true) {
      const raw = r && (r.error || r.err);
      const why = raw != null && raw !== '' ? (orcaErrorText(raw) || 'rm 失败') : 'rm 失败';
      const done = removed.length ? `已删 ${removed.map(n => n.name).join('、')}；` : '一棵都还没删；';
      return {
        ok: false,
        error: `删到一半停了：${done}失败在 ${node.name}：${why}。盘面可能半删，先处理再重跑`,
        removed,
        failed: node,
      };
    }
    removed.push(node);
  }
  return { ok: true, removed };
}

function samePath(a, b) {
  return normPath(a) === normPath(b);
}

export function formatStrayLedgerError(stray) {
  const list = (stray || []).map(s => s.file).join('、') || '（未列出文件名）';
  return `删树前拦住：树内有未进主树的账本事件（${list}）——先把它们拷回主树 ledger/events/ 再删`;
}

/** 工人树 ledger/events 里有、主树没有的事件文件。读失败 = 没查成，不许当 0。 */
export function listStrayLedgerEvents({ treePaths, mainEventsDir, readdir = readdirSync, exists = existsSync } = {}) {
  if (!mainEventsDir) {
    return { ok: false, unscanned: true, stray: [], error: '主树账本目录没给，兜底没查成' };
  }
  const paths = Array.isArray(treePaths) ? treePaths.filter(Boolean) : [];
  const stray = [];
  const scanned = [];
  const mainRoot = resolve(mainEventsDir, '..', '..');
  for (const treePath of paths) {
    if (samePath(treePath, mainRoot)) continue;
    const dir = join(treePath, 'ledger', 'events');
    scanned.push(dir);
    if (!exists(dir)) continue;
    let names;
    try { names = readdir(dir); }
    catch (e) {
      return { ok: false, unscanned: true, stray: [], error: `读 ${dir} 失败：${e && e.message ? e.message : e}` };
    }
    for (const name of names) {
      if (!String(name).endsWith('.json')) continue;
      if (!exists(join(mainEventsDir, name))) {
        stray.push({ tree: treePath, file: name, path: join(dir, name) });
      }
    }
  }
  return { ok: true, unscanned: false, stray, scanned };
}

/** 计划 + 账本孤本闸。占用/缺 path/落点没查成/有孤本 → 整树不删。 */
export function prepareWorktreeRm(worktrees, selector, { mainEventsDir, readdir, exists } = {}) {
  const plan = planWorktreeRm(worktrees, selector);
  if (!plan.ok) return plan;
  const paths = [];
  for (const node of plan.order) {
    if (!node.path) {
      return {
        ok: false,
        error: `盘面卡 ${node.name} 缺 path，账本兜底没查成，未删任何树`,
        order: [],
        occupied: [],
      };
    }
    paths.push(node.path);
  }
  const stray = listStrayLedgerEvents({
    treePaths: paths,
    mainEventsDir,
    readdir,
    exists,
  });
  if (!stray.ok) {
    return {
      ok: false,
      error: `账本兜底没查成，未删任何树：${stray.error}`,
      order: [],
      occupied: [],
    };
  }
  if (stray.stray.length) {
    return {
      ok: false,
      error: formatStrayLedgerError(stray.stray),
      order: [],
      occupied: [],
      stray: stray.stray,
    };
  }
  return plan;
}

export function argsTaskCreate({ spec, run, from } = {}) {
  const a = ['orchestration', 'task-create'];
  if (spec != null) a.push('--spec', spec);
  if (run) a.push('--run', run);
  if (from) a.push('--from', from);
  a.push('--json');
  return a;
}

export function argsTaskUpdate({ id, status, result, run, from } = {}) {
  const a = ['orchestration', 'task-update'];
  if (id) a.push('--id', id);
  if (status) a.push('--status', status);
  if (result != null) a.push('--result', typeof result === 'string' ? result : JSON.stringify(result));
  if (run) a.push('--run', run);
  if (from) a.push('--from', from);
  a.push('--json');
  return a;
}

export function argsWorkerStart({ task, worktree, terminal, retryOf, agent, model, from, run } = {}) {
  const a = ['orchestration', 'worker-start'];
  if (task) a.push('--task', task);
  if (worktree) a.push('--worktree', worktree);
  if (terminal) a.push('--terminal', terminal);
  if (agent) a.push('--agent', agent);
  if (model) a.push('--model', model);
  if (retryOf) a.push('--retry-of', retryOf);
  if (run) a.push('--run', run);
  if (from) a.push('--from', from);
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
  const live = hits.filter(w => isLiveDispatchRecipient({
    workerState: w.workerState, dispatchStatus: w.dispatchStatus,
  }));
  const ready = live.filter(w => w.workerState === 'ready' || w.workerState === 'working'
    || w.dispatchStatus === 'dispatched' || w.dispatchStatus === 'running');
  const pick = ready[0] || live[0];
  if (!pick) {
    return {
      ok: false,
      unscanned: false,
      error: `worktree=${sel} 只有已结算 dispatch，禁止当收件人（#552：下一跳必须新 Dispatch）`,
      scanned: workers.length,
      deadCount: hits.length,
    };
  }
  if (!pick.dispatchId) {
    return { ok: false, error: `worktree=${sel} 的记账没有 dispatchId`, scanned: workers.length };
  }
  return { ok: true, dispatchId: pick.dispatchId, taskId: pick.taskId || null, runId: pick.runId || null, scanned: workers.length };
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

export function argsWorkerStop({ dispatch, retryRequest } = {}) {
  const a = ['orchestration', 'worker-stop'];
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

export function argsOrchestrationReply({ id, body, from, run } = {}) {
  const a = ['orchestration', 'reply'];
  if (id) a.push('--id', id);
  if (body != null) a.push('--body', body);
  if (run) a.push('--run', run);
  if (from) a.push('--from', from);
  a.push('--json');
  return a;
}

export function argsOrchestrationCheck({ run, terminal, peek, ack, wait, timeoutMs } = {}) {
  const a = ['orchestration', 'check'];
  if (run) a.push('--run', run);
  if (terminal) a.push('--terminal', terminal);
  if (peek) a.push('--peek');
  if (ack) a.push('--ack', ack);
  if (wait) a.push('--wait');
  if (timeoutMs != null) a.push('--timeout-ms', String(timeoutMs));
  a.push('--json');
  return a;
}

export function argsRunList() {
  return ['orchestration', 'run-list', '--json'];
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

export function argsTerminalList({ worktree } = {}) {
  const a = ['terminal', 'list'];
  if (worktree) a.push('--worktree', worktree);
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

/** 认识的 agent 走 worker-start --agent（.cmd shim 的 --command 进程仍是 cmd，Orca 报 agent_unconfigured）。
 * reclaude 不能 --agent claude，仍走 terminal create --command。
 * --model 只传给 Cursor / Codex（orca 只认这几家）。 */
export function agentStartSpec({ provider, command, agentId } = {}) {
  const id = agentId || orcaKnownAgentId({ provider, command });
  const model = launchCliModel(command);
  if (id === 'cursor' || id === 'codex') {
    return { mode: 'agent', agentId: id, model };
  }
  if (id === 'grok' || id === 'pi') {
    return { mode: 'agent', agentId: id, model: null };
  }
  return { mode: 'command', agentId: id, model, command: command || null };
}

export function extractHandleFromWorkerStart(json) {
  return json?.result?.worker?.agent_terminal_handle
    || json?.result?.dispatch?.assignee_handle
    || json?.result?.handle
    || json?.result?.terminal?.handle
    || extractHandleFromCreate(json);
}

/** worker-done 起审官遇 consumer_fenced：扫到 0 次 和 没扫到样本 必须分开。 */
export function inspectConsumerFence(error) {
  if (error === undefined || error === null) {
    return { unscanned: true, scanned: false, fenced: false, count: null, error: '没给错误文本（没扫到样本，不是扫到 0 次 fence）' };
  }
  const text = String(error);
  const fenced = /consumer_fenced/i.test(text);
  return { unscanned: false, scanned: true, fenced, count: fenced ? 1 : 0 };
}

/** retire → 再起 → ensure。起不成不许当成功。 */
export function planFenceHeal({ error, runId, retired, retried, ensured } = {}) {
  const inspect = inspectConsumerFence(error);
  if (inspect.unscanned) {
    return { ok: false, unscanned: true, action: 'unscanned', fences: null, error: inspect.error };
  }
  if (!inspect.fenced) {
    return { ok: true, unscanned: false, action: 'none', fences: 0 };
  }
  if (!runId) {
    return { ok: false, unscanned: false, action: 'retire', fences: 1, error: 'consumer_fenced 但没 Run id，没法 retire 信箱台' };
  }
  if (!retired || (retired.ok !== true && retired.alreadyGone !== true && retired.state !== 'run_not_found')) {
    return { ok: false, unscanned: false, action: 'retire', fences: 1, error: retired?.error || 'retire 信箱台没做成' };
  }
  if (!retried || retried.ok !== true) {
    return { ok: false, unscanned: false, action: 'retry', fences: 1, error: retried?.error || 'retire 后再起审官失败' };
  }
  if (!ensured || ensured.ok !== true) {
    return { ok: false, unscanned: false, action: 'ensure', fences: 1, error: ensured?.error || '审官已起但 ensure 信箱台失败' };
  }
  return { ok: true, unscanned: false, action: 'healed', fences: 1 };
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
  return /run_required/i.test(orcaErrorText(error));
}

export const RUN_REQUIRED_HINT = '未绑 orchestration Run：本 TUI 自己 run-create（不要 --from 信箱台，会 consumer_fenced）。不要先试 run-use（#667：人用窗口永不当 coordinator，派工不从帅窗 run-use）';

export function rollbackErrorAlreadyGone(error) {
  return /tab_not_found|terminal_handle_stale|dispatch_not_found|already_stopped|already_fenced|already_released|task_not_found|already_failed/i.test(orcaErrorText(error));
}

/** 库实际会发出的 orca 命令 + 参数。用「全开」调用 builder 扫出来，不另维护清单。 */
export function catalogUsedFlags() {
  const samples = [
    argsTerminalCreate({ worktree: 'w', title: 't', command: 'c' }),
    argsTerminalList({ worktree: 'w' }),
    argsTerminalRead({ terminal: 't', limit: 80, cursor: 1 }),
    argsTerminalSend({ terminal: 't', text: 'x', enter: true }),
    argsWorktreeCreate({
      name: 'n', noParent: true, setup: 'skip',
      parentWorktree: 'p', baseBranch: 'b', comment: 'c', issue: 559,
    }),
    argsWorktreeSet({ worktree: 'w', displayName: 'n', comment: 'c', workspaceStatus: 'in-progress' }),
    argsWorktreeRm({ worktree: 'w', force: true }),
    argsWorktreePs(),
    argsTaskCreate({ spec: 's', run: 'r', from: 'h' }),
    argsTaskUpdate({ id: 't', status: 'failed' }),
    argsWorkerStart({ task: 't', worktree: 'w', terminal: 'h', retryOf: 'd', from: 'h', run: 'r' }),
    argsWorkerStart({ task: 't', worktree: 'w', agent: 'cursor', model: 'kimi-k3-high' }),
    argsWorkerShow({ dispatch: 'd' }),
    argsWorkerRelease({ dispatch: 'd' }),
    argsWorkerStop({ dispatch: 'd' }),
    argsWorkerRead({ dispatch: 'd', source: 'auto', limit: 50 }),
    argsTerminalClose({ terminal: 't', tab: true }),
    argsOrchestrationSend({ to: 'h', subject: 's', body: 'b', type: 'status', outcome: 'succeeded' }),
    argsOrchestrationSend({
      subject: 's', body: 'b', type: 'worker_done', outcome: 'succeeded',
      taskId: 't', dispatchId: 'd', dispatchCapability: 'c', from: 'h',
      filesModified: 'a.js', reportPath: 'r.md',
    }),
    argsOrchestrationReply({ id: 'm', body: 'b' }),
    argsGateCreate({ task: 't', question: 'q', options: '["a"]' }),
    argsGateResolve({ id: 'g', resolution: 'r' }),
    argsGateList({ task: 't', status: 'pending' }),
    argsOrchestrationInbox({ terminal: 'h', limit: 50, full: true }),
    argsOrchestrationCheck({ run: 'r', terminal: 't', peek: true }),
    argsRunShow({ id: 'r' }),
    argsRunCurrent({ from: 'h' }),
    argsRunUse({ id: 'r', from: 'h' }),
    argsRunCreate({ objective: 'dao-dispatch', from: 'h' }),
    argsRunCreateSelf({ objective: 'dao dispatch' }),
    argsRunList(),
    argsOrchestrationReply({ id: 'm', body: 'b', run: 'r', from: 'h' }),
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
  if (isModelRejectText(text)) {
    return { ok: false, reason: '拒模', text, unscanned: false };
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
    if (last.reason === '有待确认提示' || last.reason === '没读成' || last.reason === '拒模') return last;
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

/** 注入没生效的现场指纹（#543 / #524）：任务书折在输入框里从未提交。Grok 形态。 */
export const PASTED_CONTENT_RE = /\[Pasted Content \d+ chars?\]/i;

/** #651：Cursor 粘贴块折叠形态（#634 实证屏面）：[Pasted text #N +M lines]。 */
export const CURSOR_PASTE_RE = /\[Pasted text(?: #\d+)? \+?\d+ lines?\]/i;

/** #651：Cursor 已提交后在干活的屏面形态——只认状态行（行首 Running:/Reading/Thinking 等），
 * 禁止无锚单词扫任务书正文（审红 2：正文含 Reading/Working 不得当已提交）。 */
export const CURSOR_WORKING_RE = /(?:^|\n)\s*(?:Running|Reading|Thinking|Working|处理中)[:：\s.…]/i;

/** #651：Cursor 未发出的 follow-up（第二条指纹）：→ 行带字 / N follow-ups。
 * 不是粘贴块的前置条件（审红 1），单独出现也算未提交。 */
export const CURSOR_FOLLOWUP_RE = /(?:^|\n)\s*→[^\n]*[^\s\n]|\d+\s*follow-ups?/i;

/** #619/#661：未提交粘贴与「超时/环境」必须分开。垫片已退役：
 * 粘贴进输入框 ≠ 开工，屏幕上有未提交粘贴（Pasted Content / [Pasted text] / 未发 follow-up）
 * 一律立刻红并回滚，不补回车、不假装开工（#661 拍板）。 */
export const UNSUBMITTED_PASTE_REASON = '注入未提交（Pasted Content / Pasted text）——任务书停在输入框未发出，禁止粘贴当开工（#661）';

/** #651：Cursor 粘贴块等价 Grok 的 Pasted Content——单独出现且后面没有在干活（状态行）
 * 就算未提交（审红 1）。已提交（粘贴块后面有干活状态行）不当未提交，避免死循环误杀。 */
export function cursorUnsubmittedPaste(text) {
  const t = String(text ?? '');
  const m = t.match(CURSOR_PASTE_RE);
  if (!m) return null;
  const tail = t.slice(m.index + m[0].length);
  if (CURSOR_WORKING_RE.test(tail)) return null;
  return m[0];
}

/** #651：未发出的 follow-up 单独也是未提交指纹；已在干活（状态行）不当未提交。 */
export function cursorFollowupEvidence(text) {
  const t = String(text ?? '');
  if (CURSOR_WORKING_RE.test(t)) return null;
  const m = t.match(CURSOR_FOLLOWUP_RE);
  return m ? m[0] : null;
}

/** #651：Cursor 任一未提交指纹（粘贴块 / follow-up）。#633：只当没开工证据，禁止补回车。 */
export function cursorUnsubmittedEvidence(text) {
  return cursorUnsubmittedPaste(text) || cursorFollowupEvidence(text);
}

export function pastedContentMatch(text) {
  const t = String(text ?? '');
  const g = t.match(PASTED_CONTENT_RE);
  if (g) return g[0];
  const c = cursorUnsubmittedPaste(t);
  if (c) return c;
  return cursorFollowupEvidence(t);
}

/** #633：框里躺着的派活字（返工/复核指令）。看门狗只报不回车。 */
export const LEFTOVER_DISPATCH_RE = /【返工指令|【复核指令/;
export function leftoverDispatchMatch(text) {
  const t = String(text ?? '');
  const m = t.match(LEFTOVER_DISPATCH_RE);
  if (m) return m[0];
  const paste = pastedContentMatch(t);
  if (paste && /返工|复核/.test(t)) return paste;
  return null;
}

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
  const g = t.match(PASTED_CONTENT_RE);
  if (g) {
    return {
      ok: false,
      reason: '任务书停在输入框（Pasted Content），没有进上下文',
      evidence: g[0],
      unscanned: false,
      text: t,
    };
  }
  const cm = cursorUnsubmittedPaste(t);
  if (cm) {
    return {
      ok: false,
      reason: '任务书停在输入框（Cursor Pasted text 未发出），没有进上下文',
      evidence: cm,
      unscanned: false,
      text: t,
    };
  }
  const cf = cursorFollowupEvidence(t);
  if (cf) {
    return {
      ok: false,
      reason: '任务书停在输入框（Cursor follow-up 未发出），没有进上下文',
      evidence: cf,
      unscanned: false,
      text: t,
    };
  }
  return { ok: true, text: t, unscanned: false };
}

/**
 * #661/#633：退役「补一记回车」垫片（completePendingPaste 已删除）。
 * 往输入框粘贴 ≠ 开工：未提交粘贴（Pasted Content / [Pasted text] / 未发 follow-up）
 * 只证明任务书停在输入框，不证明 agent 真接过它。开工只认外部证据——
 *   - worker-read 官方 transcript（source≠terminal）= 真 session（调 verifyWorkerStarted）；
 *   - GitHub 已有 review（调用方另查，不在这里）；
 *   - proof 不可用（provider_unsupported / session_not_reported）时降级到屏面连续稳定轮
 *     （= agent 真在干活：屏上没有未提交粘贴）。
 *
 * 仍轮询的只有开工证明本身：
 *   1. worker-read 官方 transcript（source≠terminal）→ started；
 *   2. 任一拍看到未提交粘贴（Pasted Content / [Pasted text] / 未发 follow-up）→
 *      立刻红 unsubmitted-paste、pasteSubmitted:false，不许垫片提交、不许假装开工；
 *   3. TUI 加载期（Starting MCP servers 等）不算绿；
 *   4. proof 不可用（provider_unsupported / session_not_reported）时降级到屏面连续稳定轮。
 */
export function verifyStartedPolling({
  dispatchId, readOnce, proofOnce, timeoutMs,
  intervalMs = 400, sleep = sleepSync, label = '',
  stableRoundsNeeded = 3,
} = {}) {
  if (typeof readOnce !== 'function') {
    throw new Error('verifyStartedPolling 要 readOnce');
  }
  const t0 = Date.now();
  let reads = 0;
  let unscanned = null;
  let lastText = '';
  let proofUnavailable = null;
  let stableRounds = 0;
  while (Date.now() - t0 < timeoutMs) {
    if (dispatchId && typeof proofOnce === 'function') {
      const proof = proofOnce(dispatchId);
      if (proof && proof.ok && proof.proven) {
        return {
          ok: true,
          state: 'started',
          proof, reads,
          elapsedMs: Date.now() - t0,
          text: lastText,
        };
      }
      if (proof && proof.unscanned) unscanned = proof;
      if (proof && proof.proven === false && proofUnavailableReason(proof)) {
        proofUnavailable = proof;
      }
    }
    reads++;
    const read = readOnce();
    if (read && read.error) unscanned = { reason: '没读成', error: read.error };
    const text = read && !read.error ? extractTerminalText(read) : '';
    lastText = text;
    const leftover = pastedContentMatch(text);
    if (leftover) {
      // #661/#633：粘贴不等于开工。屏上只有 [Pasted text] / Pasted Content / 未发 follow-up
      // → 任务书没进上下文，立刻红并交给调用方回滚，不补回车、不假装开工。
      return {
        ok: false,
        state: 'unsubmitted-paste',
        reason: UNSUBMITTED_PASTE_REASON,
        evidence: leftover,
        reads,
        elapsedMs: Date.now() - t0,
        text,
        pasteSubmitted: false,
      };
    }
    const v = verifyInjection({ text, readError: read && read.error });
    if (v.ok) {
      if (TUI_LOADING_RE.test(text)) {
        stableRounds = 0;
      } else {
        stableRounds++;
        if (proofUnavailable && stableRounds >= stableRoundsNeeded) {
          return {
            ok: true,
            state: 'started',
            proofFallback: true,
            proof: proofUnavailable,
            reads, stableRounds,
            elapsedMs: Date.now() - t0,
            text,
          };
        }
      }
    }
    sleep(intervalMs);
  }
  return {
    ok: false,
    state: 'failed',
    reason: `超时没等到开工证明（${label || '注入'}，${timeoutMs}ms）`,
    unscanned: unscanned ? { unscanned: true, reason: unscanned.reason || '未记录', error: unscanned.error } : undefined,
    reads,
    stableRounds,
    elapsedMs: Date.now() - t0,
    text: lastText,
  };
}

/**
 * worker-read 的开工证明（#559 ⑥）。官方可靠源：source ≠ 'terminal' = hook 报告的
 * Codex/Claude/Grok transcript（可证明 worker session）；source = 'terminal' = 只给了
 * 有界终端输出（老式屏面证据，会假阳）。没读成必须标 unscanned——不许当成「没开工」。
 * 判开工优先用它；证明不了时降级回 verifyStartedPolling 的屏面稳定轮。
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

export function unboundTaskIds({ taskIds, workers } = {}) {
  const bound = new Set((Array.isArray(workers) ? workers : []).map(w => w && w.taskId).filter(Boolean));
  return (Array.isArray(taskIds) ? taskIds : []).filter(id => id && !bound.has(id));
}

export function planDispatchFence({ dispatchIds, taskIds, workers } = {}) {
  const steps = [];
  const seenId = new Set();
  for (const id of (Array.isArray(dispatchIds) ? dispatchIds : []).filter(Boolean).slice().reverse()) {
    if (seenId.has(id)) continue;
    seenId.add(id);
    steps.push(argsWorkerStop({ dispatch: id }));
  }
  const seenTask = new Set();
  for (const id of unboundTaskIds({ taskIds, workers }).slice().reverse()) {
    if (seenTask.has(id)) continue;
    seenTask.add(id);
    steps.push(argsTaskUpdate({ id, status: 'failed' }));
  }
  return steps;
}

export function planDispatchDestroy({
  workerId, workerHandle, reviewerId, reviewerHandle, handles, childIds, childHandles,
} = {}) {
  const steps = [];
  if (reviewerHandle) steps.push(argsTerminalClose({ terminal: reviewerHandle, tab: true }));
  if (reviewerId) steps.push(argsWorktreeRm({ worktree: reviewerId, force: true }));
  for (const handle of Array.isArray(childHandles) ? childHandles : []) {
    if (handle) steps.push(argsTerminalClose({ terminal: handle, tab: true }));
  }
  const extra = Array.isArray(handles) ? handles.filter(Boolean) : [];
  const seen = new Set();
  for (const h of extra.slice().reverse()) {
    if (seen.has(h) || h === workerHandle || h === reviewerHandle) continue;
    if (Array.isArray(childHandles) && childHandles.includes(h)) continue;
    seen.add(h);
    steps.push(argsTerminalClose({ terminal: h, tab: true }));
  }
  if (workerHandle) steps.push(argsTerminalClose({ terminal: workerHandle, tab: true }));
  for (const id of Array.isArray(childIds) ? childIds : []) {
    if (id) steps.push(argsWorktreeRm({ worktree: id, force: true }));
  }
  if (workerId) steps.push(argsWorktreeRm({ worktree: workerId, force: true }));
  return steps;
}

export function planDispatchRollback(created = {}) {
  return [...planDispatchFence(created), ...planDispatchDestroy(created)];
}

export function execRollbackStep(args, exec) {
  let r = exec(args);
  const step = {
    cmd: args.join(' '),
    ok: !!r.ok,
    error: r.ok ? undefined : orcaErrorText(r.error),
  };
  if (!r.ok && rollbackErrorAlreadyGone(r.error)) {
    step.ok = true;
    step.alreadyGone = true;
    step.error = undefined;
  } else if (!r.ok && args[0] === 'terminal' && args[1] === 'close' && args.includes('--tab')) {
    const retryArgs = args.filter(a => a !== '--tab');
    const retry = exec(retryArgs);
    step.retryWithoutTab = {
      cmd: retryArgs.join(' '),
      ok: !!retry.ok,
      error: retry.ok ? undefined : orcaErrorText(retry.error),
    };
    if (retry.ok || rollbackErrorAlreadyGone(retry.error)) {
      step.ok = true;
      step.alreadyGone = !retry.ok;
      step.recovered = !!retry.ok;
      step.error = undefined;
    }
  }
  return step;
}

export function inspectRollbackResidue(created, exec) {
  const ids = Array.isArray(created?.dispatchIds) ? created.dispatchIds.filter(Boolean) : [];
  if (ids.length === 0) return { ok: true, leftover: [], skipped: true, unscanned: false };
  const listed = exec(argsWorkerList());
  if (!listed || !listed.ok) {
    return {
      ok: false,
      unscanned: true,
      leftover: [],
      error: `回滚后 worker-list 没查成：${orcaErrorText(listed && listed.error)}`,
    };
  }
  const workers = listed.json?.result?.workers;
  return classifyDispatchResidue({ dispatchIds: ids, workers });
}

/**
 * 生产回滚：先 fence（worker-stop + 未绑定 task 置 failed），再 worker-list 核残留。
 * 没查成或仍有活动 Dispatch → fail-visible，不删树。
 */
export function applyDispatchRollback(created, { exec } = {}) {
  if (typeof exec !== 'function') {
    return {
      ok: false,
      rollback: [],
      rollbackFailed: true,
      residue: { ok: false, unscanned: true, leftover: [], error: 'applyDispatchRollback 没拿到 exec（没查成）' },
      alarm: 'applyDispatchRollback 没拿到 exec（没查成）',
    };
  }
  const rollback = [];
  for (const args of planDispatchFence(created)) {
    rollback.push(execRollbackStep(args, exec));
  }
  const residue = inspectRollbackResidue(created, exec);
  if (!residue.ok) {
    for (const args of planDispatchDestroy(created)) {
      if (args[0] === 'worktree') continue;
      rollback.push(execRollbackStep(args, exec));
    }
    const report = rollbackReport(rollback);
    const alarm = residue.error || report.alarm;
    return { ok: false, rollback, rollbackFailed: true, residue, alarm };
  }
  for (const args of planDispatchDestroy(created)) {
    rollback.push(execRollbackStep(args, exec));
  }
  const report = rollbackReport(rollback);
  return {
    ok: !report.rollbackFailed,
    rollback,
    rollbackFailed: report.rollbackFailed,
    residue,
    alarm: report.alarm,
  };
}

/** #620：batch JSON → `[{name, spec}, ...]`。数组或 `{workers|items|batch: [...]}` 都收。 */
export function parseDispatchBatchItems(raw) {
  if (raw == null) return { ok: false, error: 'batch 文件是空的' };
  let list = raw;
  if (!Array.isArray(raw)) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'batch 要 JSON 数组 [{name, spec}, ...]' };
    list = raw.workers || raw.items || raw.batch;
  }
  if (!Array.isArray(list)) return { ok: false, error: 'batch 要 JSON 数组 [{name, spec}, ...]' };
  if (list.length === 0) return { ok: false, error: 'batch 至少要 1 个工人' };
  const items = [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, error: `batch[${i}] 不是对象` };
    }
    const name = String(row.name ?? '').trim();
    const spec = String(row.spec ?? '').trim();
    if (!name) return { ok: false, error: `batch[${i}] 缺 name` };
    if (!spec) return { ok: false, error: `batch[${i}] 缺 spec` };
    items.push({ name, spec });
  }
  return { ok: true, items };
}

export function loadDispatchBatchFile(filePath, { readFile } = {}) {
  const p = String(filePath ?? '').trim();
  if (!p) return { ok: false, error: 'dispatch --batch 要 JSON 文件路径' };
  let text;
  try {
    text = (readFile || readFileSync)(p, 'utf8');
  } catch (e) {
    return { ok: false, error: `batch 文件读不到: ${p}（${String(e.message || e)}）` };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `batch 文件不是合法 JSON: ${String(e.message || e)}` };
  }
  return parseDispatchBatchItems(raw);
}

/** #620：一批只读工人的计划。不调审官，卡名就是 --name，不带 --no-parent。 */
export function planDispatchBatch({ name, issue, model, items } = {}) {
  const n = String(name ?? '').trim();
  const issueText = String(issue ?? '').trim();
  const modelId = String(model ?? '').trim();
  if (!n) return { ok: false, error: 'dispatch --batch 要 --name（批卡名）' };
  if (!issueText) return { ok: false, error: 'dispatch --batch 要 --issue（整批共享）' };
  if (!modelId) return { ok: false, error: 'dispatch --batch 要 --model' };

  let parsed;
  if (items && items.ok === true && Array.isArray(items.items)) parsed = items;
  else parsed = parseDispatchBatchItems(items);
  if (!parsed.ok) return parsed;

  const cardName = assembleCardName({ name: n, issue: issueText });
  const workers = [];
  for (let i = 0; i < parsed.items.length; i++) {
    const item = parsed.items[i];
    let inject;
    try {
      inject = buildBatchInject({ spec: item.spec, issue: issueText });
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
    workers.push({
      index: i,
      name: item.name,
      spec: item.spec,
      inject,
      handle: `<handle:${i}>`,
      worktree: cardName,
    });
  }
  return {
    ok: true,
    batch: true,
    cardName,
    issue: issueText,
    model: modelId,
    noParent: false,
    reviewerCreate: false,
    workers,
  };
}

/**
 * #620：批量原子编排。effects 由调用方注入（真路径走 orca，单测走假对象）。
 * 失败不自己回滚——调用方拿 created 走 failCreated / planDispatchRollback。
 */
export function runDispatchBatch({ plan, effects } = {}) {
  const created = { handles: [], workers: [], dispatchIds: [], taskIds: [] };
  if (!plan || !Array.isArray(plan.workers)) {
    return { ok: false, error: 'runDispatchBatch 要 plan.workers', created, workers: [] };
  }
  if (!effects) {
    return { ok: false, error: 'runDispatchBatch 要 effects', created, workers: [] };
  }
  const fail = (error) => ({ ok: false, error, created, workers: created.workers });

  const wt = effects.createWorktree({
    name: plan.cardName,
    issue: plan.issue,
    noParent: false,
  });
  if (wt && wt.id) created.workerId = wt.id;
  if (wt && wt.path) created.workerPath = wt.path;
  if (!wt || !wt.ok) return fail(`工人卡创建失败: ${(wt && wt.error) || '未知'}`);

  for (const w of plan.workers) {
    const term = effects.startTerminal({
      worktree: created.workerId,
      title: w.name,
      model: plan.model,
    });
    if (term && term.handle) created.handles.push(term.handle);
    if (!term || !term.ok) return fail(`工人终端创建失败（${w.name}）: ${(term && term.error) || '未知'}`);

    const task = effects.createTask({
      spec: w.inject || w.spec,
      name: w.name,
      issue: plan.issue,
    });
    if (!task || !task.ok) return fail(`task-create 失败（${w.name}）: ${(task && task.error) || '未知'}`);
    if (task.taskId) created.taskIds.push(task.taskId);

    const started = effects.startWorker({
      task: task.taskId,
      terminal: term.handle,
      worktree: created.workerId,
      issue: plan.issue,
      model: term.model || plan.model,
      agent: term.agentId,
      deferred: term.deferred === true,
    });
    if (started && started.dispatchId) created.dispatchIds.push(started.dispatchId);
    if (!started || !started.ok) {
      return fail(`worker-start 失败（${w.name}）: ${(started && started.error) || '未知'}`);
    }

    created.workers.push({
      index: w.index,
      name: w.name,
      spec: w.spec,
      inject: w.inject || w.spec,
      handle: started.handle || term.handle,
      taskId: task.taskId,
      dispatchId: started.dispatchId,
    });
  }
  return { ok: true, created, workers: created.workers };
}

/** 回滚后还剩没有结算的 Dispatch 吗。没查成与「扫完 0 条残留」分开。 */
export function classifyDispatchResidue({ dispatchIds, workers } = {}) {
  const ids = (Array.isArray(dispatchIds) ? dispatchIds : []).filter(Boolean).map(String);
  if (workers == null) {
    return {
      ok: false,
      unscanned: true,
      leftover: [],
      error: 'classifyDispatchResidue 没拿到 worker-list（没查成）',
    };
  }
  if (!Array.isArray(workers)) {
    return {
      ok: false,
      unscanned: true,
      leftover: [],
      error: 'classifyDispatchResidue 的 workers 不是数组（没查成）',
    };
  }
  const leftover = [];
  for (const id of ids) {
    const hit = workers.find(w => String(w?.dispatchId || '') === id);
    if (!hit) continue;
    const status = String(hit.dispatchStatus || '');
    const state = String(hit.workerState || '');
    const settled = /^(completed|failed|cancelled|stopped|fenced)$/i.test(status)
      || /^(succeeded|failed|cancelled|stopped)$/i.test(state);
    if (!settled) leftover.push({ dispatchId: id, dispatchStatus: status, workerState: state });
  }
  if (leftover.length) {
    return {
      ok: false,
      unscanned: false,
      leftover,
      error: `回滚后仍有活动 Dispatch：${leftover.map(x => x.dispatchId).join(',')}`,
    };
  }
  return { ok: true, unscanned: false, leftover: [] };
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

  const vendorGate = assertCrossVendor({
    workerId: resolvedModel,
    reviewerId: reviewer,
    models,
  });
  if (!vendorGate.ok) {
    let error = vendorGate.error;
    if (vendorGate.state === 'same_vendor') {
      const next = nextReviewerAfter({
        currentId: reviewer,
        models,
        passerIds: models
          .filter(m => m && Array.isArray(m.roles) && m.roles.some(r => r === '审查' || r === '审读'))
          .map(m => m.id),
        workerId: resolvedModel,
      });
      error = next.ok && next.next ? `${error}；下一位 ${next.next}` : `${error}；${next.error}`;
    }
    return { ok: false, missing: [], error, vendorGate };
  }

  return {
    ok: true,
    mergePolicy: policy,
    mergeReason: policy === 'manual' ? String(mergeReason || '').trim() : null,
    model: resolvedModel,
    role: role || null,
    reviewer,
    recommendation,
    vendorGate,
  };
}

/** --split 判据的真相源（#611）。skill 只留指针，勿在别处复制一份。 */
export const SPLIT_CRITERION = '产出物能不能按文件切开？能切 + 块数 ≥2 + 每块够一个工人干 → --split N；切不开（同几个文件反复改）→ --split no + --split-reason';

/**
 * dispatch --split 硬闸。取值只允许 no 或 ≥2 的整数；缺了就退。
 * --split no 必须同时给非空 --split-reason（入账本，防仪式化）。
 */
export function resolveSplitConstraint({ split, splitReason } = {}) {
  const raw = split == null ? '' : String(split).trim();
  if (!raw) {
    return {
      ok: false,
      missing: ['--split'],
      error: `dispatch 要 --split <no|N>（N≥2）。${SPLIT_CRITERION}`,
    };
  }
  if (/^no$/i.test(raw)) {
    const reason = String(splitReason || '').trim();
    if (!reason) {
      return {
        ok: false,
        missing: ['--split-reason'],
        error: '--split no 必须给 --split-reason（理由入账本，防仪式化）',
      };
    }
    return { ok: true, split: 'no', splitReason: reason, childCount: 0 };
  }
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      missing: [],
      error: `--split 只允许 no 或 ≥2 的整数，实际「${raw}」`,
    };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 2) {
    return {
      ok: false,
      missing: [],
      error: `--split N 必须 ≥2，实际 ${n}（切不开请用 --split no --split-reason）`,
    };
  }
  const reason = String(splitReason || '').trim();
  return { ok: true, split: n, splitReason: reason || null, childCount: n };
}

const FILE_TOKEN = /[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+/g;

export function sliceFileTokens(text) {
  return [...String(text || '').matchAll(FILE_TOKEN)].map(m => m[0].replace(/\\/g, '/').toLowerCase());
}

/**
 * --split N 必须给 N 份非空、互不重叠的 --slice。
 * 重叠：两份原文相同，或抽到的文件路径出现在两块里（a.js / b.js 反例）。
 */
export function resolveSliceAssignments({ childCount = 0, slices } = {}) {
  const list = Array.isArray(slices)
    ? slices.map(s => String(s == null ? '' : s).trim())
    : (slices == null || String(slices).trim() === '' ? [] : [String(slices).trim()]);
  if (!childCount) {
    if (list.length) {
      return { ok: false, missing: [], error: '--split no 不要给 --slice' };
    }
    return { ok: true, slices: [] };
  }
  if (list.length !== childCount) {
    return {
      ok: false,
      missing: ['--slice'],
      error: `--split ${childCount} 必须给 ${childCount} 个 --slice（每块一份非空分块说明），实际 ${list.length}`,
    };
  }
  if (list.some(s => !s)) {
    return { ok: false, missing: ['--slice'], error: '--slice 不能为空' };
  }
  if (list.some(s => !/[\p{L}\p{N}]/u.test(s))) {
    return { ok: false, missing: ['--slice'], error: '--slice 必须有实质内容（字母或数字）' };
  }
  const seenText = new Set();
  for (const s of list) {
    if (seenText.has(s)) {
      return { ok: false, error: `--slice 边界重叠：两块说明相同「${s}」` };
    }
    seenText.add(s);
  }
  const owner = new Map();
  for (let i = 0; i < list.length; i++) {
    for (const file of sliceFileTokens(list[i])) {
      if (owner.has(file)) {
        return {
          ok: false,
          error: `--slice 边界重叠：${file} 同时出现在第 ${owner.get(file)} 块和第 ${i + 1} 块`,
        };
      }
      owner.set(file, i + 1);
    }
  }
  return { ok: true, slices: list };
}

/**
 * 三单回归用的那条可判定规则（#611）。
 * 只回答「该不该拆」：能按文件切开且块数≥2 且每块够干 → N；否则 no。
 * N 由调用方给（#608 是 24 个文件拆 4 工人），函数不猜块怎么切。
 */
export function decideSplit({ filesSeparable, chunkCount, eachChunkEnoughWork, n } = {}) {
  if (filesSeparable === true && Number(chunkCount) >= 2 && eachChunkEnoughWork === true) {
    const workers = n != null ? Number(n) : Number(chunkCount);
    if (Number.isInteger(workers) && workers >= 2) return { split: workers };
  }
  return { split: 'no' };
}

export function planSplitCards({
  name, issue, childCount = 0,
  role, model,
  parentSelector = '<父卡>',
  baseBranch = '<任务分支>',
} = {}) {
  const parentName = assembleCardName({ name, issue, role, model });
  const children = [];
  const n = Number(childCount) || 0;
  for (let i = 1; i <= n; i++) {
    children.push({
      name: parentName ? `${parentName} · ${i}` : String(i),
      parentWorktree: parentSelector,
      baseBranch,
      flags: ['--parent-worktree', parentSelector, '--base-branch', baseBranch],
    });
  }
  return {
    parent: { name: parentName, noParent: true },
    children,
  };
}

/** --split N 时给头工人 / 子工人可执行的分块职责。子块必须带调用方给的 --slice 原文。 */
export function buildSplitRoleSpec({ spec, role, index, total, slice } = {}) {
  const base = String(spec || '').trim();
  const n = Number(total) || 0;
  if (role === 'head') {
    return `${base}｜头工人：协调${n}块，不独占文件块`;
  }
  const part = String(slice || '').trim();
  if (!part) {
    throw new Error(`块${index}/${n} 缺 --slice，不能用同一份 spec 冒充分块`);
  }
  return `块${index}/${n}：${part}`;
}

/**
 * 真路径起 N 个独立子工人。startOne 负责终端/Task/Dispatch/验开工。
 * 任一子工人失败时返回已起的那些（含已有 handle 的失败者），供完整回滚。
 */
export function startSplitChildren({ children, spec, slices, startOne } = {}) {
  if (typeof startOne !== 'function') {
    return { ok: false, started: [], error: 'startSplitChildren 没拿到 startOne' };
  }
  const list = Array.isArray(children) ? children : [];
  const parts = Array.isArray(slices) ? slices : [];
  const total = list.length;
  if (parts.length !== total) {
    return { ok: false, started: [], error: `startSplitChildren 要 ${total} 个 slice，实际 ${parts.length}` };
  }
  const started = [];
  for (let i = 0; i < total; i++) {
    const child = list[i] || {};
    let sliceSpec;
    try {
      sliceSpec = buildSplitRoleSpec({ spec, role: 'child', index: i + 1, total, slice: parts[i] });
    } catch (e) {
      return { ok: false, started, error: String(e.message || e) };
    }
    const r = startOne({
      worktreeId: child.id,
      path: child.path,
      title: child.name,
      spec: sliceSpec,
      slice: parts[i],
      index: i + 1,
      total,
    }) || {};
    const record = {
      id: child.id,
      name: child.name,
      handle: r.handle || null,
      dispatchId: r.dispatchId || null,
      taskId: r.taskId || null,
      spec: sliceSpec,
    };
    if (record.handle || record.dispatchId) started.push(record);
    if (!r.ok) {
      return {
        ok: false,
        started,
        error: `子工人 ${i + 1}/${total} 没起成: ${r.error || '未知错误'}`,
      };
    }
  }
  return { ok: true, started };
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

/** 卡名给人眼看（#589；号前带 #，2026-08-18 拍板）。
 * 组装只产出 `ISSUE-#589 工人·模型 短语` / `PR-#616 审官·模型`。
 * 解析认 `-#?(\d+)`，旧的 `PR-616` / `ISSUE-589` 仍读得懂。
 * 给了 pr 就升级前缀。没给号则原样返回。这是卡名格式的唯一真相源。 */
const CARD_ROLE_DOT = /^(工人|审官|辅助)·(\S+)(?:\s+(.*))?$/;
const CARD_NEW = /^(PR|ISSUE)-#?(\d+)\s+(.*)$/;
const CARD_OLD = /^#(\d+)\s*[-–—]\s*(.*)$/;

export function assembleCardName({ name, issue, pr, role, model } = {}) {
  const raw = String(name ?? '').trim();
  const prText = String(pr ?? '').trim();
  const issueText = String(issue ?? '').trim();
  const kind = /^\d+$/.test(prText) ? 'PR' : (/^\d+$/.test(issueText) ? 'ISSUE' : null);
  const num = kind === 'PR' ? prText : issueText;
  let stem = raw;
  let roleText = String(role ?? '').trim();
  let modelId = String(model ?? '').trim();

  const asNew = raw.match(CARD_NEW);
  if (asNew) stem = asNew[3];
  else {
    const asOld = raw.match(CARD_OLD);
    if (asOld) stem = asOld[2];
  }

  const roleDot = stem.match(CARD_ROLE_DOT);
  if (roleDot) {
    if (!roleText) roleText = roleDot[1];
    if (!modelId) modelId = roleDot[2];
    stem = (roleDot[3] || '').trim();
  }

  if (!kind) return raw;
  const mid = roleText && modelId ? `${roleText}·${modelId}` : (roleText || '');
  return [`${kind}-#${num}`, mid, stem].filter(Boolean).join(' ');
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

const MODEL_LABEL_PREFIX = 'model/';

/** 从 label 列表读出唯一的工人模型。三态同分：一个 / 没有 / 多个。 */
export function pickModel(labels) {
  if (labels == null || !Array.isArray(labels)) {
    return { ok: false, state: 'unscanned', error: 'pickModel 没拿到 label 列表（没查成，不许猜）' };
  }
  const hits = labels
    .map(labelNameOf)
    .filter(name => name.startsWith(MODEL_LABEL_PREFIX) && name.length > MODEL_LABEL_PREFIX.length);
  if (hits.length === 0) {
    return { ok: false, state: 'none', error: '没有 model/* label（扫完 0 条，不许猜一个）' };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      state: 'many',
      labels: hits,
      error: `有多个 model/* label（${hits.join('、')}，不许猜一个）`,
    };
  }
  return {
    ok: true,
    state: 'one',
    modelId: hits[0].slice(MODEL_LABEL_PREFIX.length),
    label: hits[0],
  };
}

/** 起审官前查工人模型。没拿到列表 ≠ 扫完没有 model/*，两者都拒绝起审官。 */
export function requireWorkerModel(labels) {
  const pick = pickModel(labels);
  if (pick.ok) return pick;
  if (pick.state === 'unscanned') {
    return { ...pick, error: '工人模型列表没拿到（没查成），拒绝起审官' };
  }
  if (pick.state === 'none') {
    return { ...pick, error: '扫完没有 model/*，拒绝起审官' };
  }
  return { ...pick, error: `${pick.error}，拒绝起审官` };
}

export function collectIssueLabelsFromPr({ pr, runGh } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'collectIssueLabelsFromPr 没给 PR 号' };
  if (typeof runGh !== 'function') {
    return { ok: false, unscanned: true, error: 'collectIssueLabelsFromPr 没拿到 gh 执行器（没查成，不许猜）' };
  }
  const view = runGh(['pr', 'view', n, '--json', 'title,body']);
  if (!view.ok) return { ok: false, unscanned: true, error: `gh pr view #${n} 失败：${view.error}` };
  let meta;
  try { meta = JSON.parse(view.out); }
  catch { return { ok: false, unscanned: true, error: `gh pr view #${n} 返回非 JSON：${String(view.out).slice(0, 120)}` }; }
  const refs = linkedIssueNumbers(`${meta.title || ''}\n${meta.body || ''}`);
  if (!refs.length) {
    return { ok: false, unscanned: false, error: `PR #${n} 没有署名单号，读不到 issue label（没查成，不许猜）` };
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
  return { ok: true, unscanned: false, refs, labels: collected };
}

export function resolveWorkerFromPr({ pr, runGh } = {}) {
  const collected = collectIssueLabelsFromPr({ pr, runGh });
  if (!collected.ok) return collected;
  const picked = requireWorkerModel(collected.labels);
  if (!picked.ok) return { ...picked, source: 'label', refs: collected.refs, labels: collected.labels };
  return { ...picked, source: 'label', refs: collected.refs, labels: collected.labels };
}

/** 读 PR 署名 issue 上的 label，再走 pickReviewer。传了 explicit 就用它（工人路径不传）。 */
export function resolveReviewerFromPr({ pr, reviewer, runGh } = {}) {
  if (reviewer && String(reviewer).trim()) {
    return { ok: true, source: 'flag', modelId: String(reviewer).trim() };
  }
  const collected = collectIssueLabelsFromPr({ pr, runGh });
  if (!collected.ok) {
    if (!collected.unscanned && /没有署名单号/.test(collected.error || '')) {
      const n = String(pr ?? '').trim();
      return { ...collected, error: `PR #${n} 没有署名单号，读不到 reviewer/*（没查成，不许猜）` };
    }
    return collected;
  }
  const picked = pickReviewer(collected.labels);
  if (!picked.ok) return { ...picked, source: 'label', refs: collected.refs, labels: collected.labels };
  return { ...picked, source: 'label', refs: collected.refs, labels: collected.labels };
}

/** 读 PR 上的 review 条数。没查成和「0 条」分开。 */
export function listPrReviews({ pr, runGh } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'listPrReviews 没给 PR 号' };
  if (typeof runGh !== 'function') {
    return { ok: false, unscanned: true, error: 'listPrReviews 没拿到 gh 执行器（没查成，不许猜）' };
  }
  const view = runGh(['pr', 'view', n, '--json', 'reviews']);
  if (!view.ok) return { ok: false, unscanned: true, error: `gh pr view #${n} reviews 失败：${view.error}` };
  let parsed;
  try { parsed = JSON.parse(view.out); }
  catch { return { ok: false, unscanned: true, error: `gh pr view #${n} reviews 返回非 JSON` }; }
  if (!parsed || !Array.isArray(parsed.reviews)) {
    return { ok: false, unscanned: true, error: `gh pr view #${n} 缺 reviews 数组（没查成，不许当 0 条）` };
  }
  return { ok: true, reviews: parsed.reviews, count: parsed.reviews.length };
}

/** 完工计划：按已有 review 条数分首审 / 返工。首审才建审官。 */
export function planWorkerDone({ pr, body, runGh } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'worker-done 要 --pr' };
  const resolved = resolveReviewerFromPr({ pr: n, runGh });
  if (!resolved.ok) return resolved;
  const issue = Array.isArray(resolved.refs) && resolved.refs[0] ? resolved.refs[0] : null;
  if (!issue) {
    return { ok: false, unscanned: false, error: `PR #${n} 没有署名单号，完工 comment 没处可发` };
  }
  const listed = listPrReviews({ pr: n, runGh });
  if (!listed.ok) return listed;
  const round = listed.count > 0 ? 'rework' : 'first';
  const prefix = round === 'rework' ? '返工完成' : '完工';
  const custom = body == null ? '' : String(body);
  if (custom && !new RegExp(`^${prefix}`).test(custom)) {
    return { ok: false, unscanned: false, error: `worker-done --body 首行必须以「${prefix}」开头（${round === 'rework' ? '已有 review，这是返工轮' : '流转器只认这个'}）` };
  }
  const shouldCreate = round === 'first';
  const workerPick = shouldCreate
    ? requireWorkerModel(resolved.labels)
    : pickModel(resolved.labels || []);
  if (shouldCreate && !workerPick.ok) return { ...workerPick, pr: n, issue, reviewer: resolved.modelId };
  const comment = custom || (round === 'rework'
    ? [`返工完成：PR #${n}`, '', `自读选型：${resolved.modelId}`, '已有 review，不起第二个审官。'].join('\n')
    : [`完工：PR #${n}`, '', `自读选型：${resolved.modelId}`, '将调 reviewer-create 按需起审官。'].join('\n'));
  return {
    ok: true,
    wired: true,
    round,
    shouldCreate,
    reviewCount: listed.count,
    pr: n,
    issue,
    reviewer: resolved.modelId,
    reviewerSource: resolved.source,
    workerModel: workerPick.ok ? workerPick.modelId : null,
    comment,
    reviewerCreate: shouldCreate
      ? {
        verb: 'reviewer-create',
        pr: n,
        args: ['--pr', n],
        invoked: false,
        reason: '首审：真调 reviewer-create（自读选型、建树、起终端、注入）',
      }
      : {
        verb: 'reviewer-create',
        pr: n,
        invoked: false,
        skipped: true,
        reason: '已有 review，返工轮不起第二个审官',
      },
  };
}

/**
 * 士兵→审官 完工/返工投递决策。无 IO：投递走传入的 deliver。
 * 首审、返工都必须送到审官 dispatch；缺 id 或投失败一律 ok:false（fail-visible）。
 */
export function completeWorkerDoneNotify({
  round,
  pr,
  comment,
  reviewerDispatchId,
  shouldCreate,
  deliver,
  orca,
} = {}) {
  const prefix = round === 'rework' ? '返工完成' : '完工';
  const id = reviewerDispatchId == null ? '' : String(reviewerDispatchId).trim();
  if (!id) {
    if (round === 'rework') {
      return { ok: false, notified: null, error: '返工找不到现有审官 dispatch，返工完成消息没处可投（没查成）' };
    }
    if (shouldCreate) {
      return { ok: false, notified: null, error: 'reviewer-create 没返回 reviewerDispatchId，完工消息没处可投（没查成）' };
    }
    return { ok: false, notified: null, error: `${prefix}找不到审官 dispatch，完工消息没处可投（没查成）` };
  }
  if (typeof deliver !== 'function') {
    return { ok: false, notified: null, error: 'completeWorkerDoneNotify 没拿到投递器（没查成）' };
  }
  const notified = deliver({
    to: `dispatch:${id}`,
    subject: `${prefix}：PR #${pr}`,
    body: comment,
    hop: '士兵→审官',
    orca,
  });
  if (!notified || !notified.ok) {
    return {
      ok: false,
      notified: notified || null,
      error: `${prefix}通知没送到审官：${notified && notified.error ? notified.error : '投递器没返回'}`,
    };
  }
  return { ok: true, notified: { ...notified, dispatchId: id } };
}

/**
 * 返工/首审投递目标：只认新建或复用返回的新 id。
 * #552：复用失败禁止回退已有 dispatch（可能已结算，信箱 inspect-only）。
 */
export function pickWorkerDoneDispatchId({ create, reused, existingDispatchId } = {}) {
  const fromCreate = create && create.reviewerDispatchId ? String(create.reviewerDispatchId).trim() : '';
  if (fromCreate) return { ok: true, reviewerDispatchId: fromCreate, source: 'create' };
  const fromReuse = reused && reused.reviewerDispatchId ? String(reused.reviewerDispatchId).trim() : '';
  if (fromReuse) return { ok: true, reviewerDispatchId: fromReuse, source: 'reuse' };
  if (reused && reused.reuseFailed) {
    return {
      ok: false, reviewerDispatchId: null, source: null,
      error: '复用审官失败，禁止回退已有 dispatch（可能已结算、信箱 inspect-only）。应重试 worker-start --terminal 开新 Dispatch，或升级给帅。',
    };
  }
  const existing = existingDispatchId == null ? '' : String(existingDispatchId).trim();
  if (existing) {
    return {
      ok: false, reviewerDispatchId: null, source: 'existing-blocked',
      error: `禁止回退已有审官 dispatch ${existing}（#552：可能已结算）。第二轮复审必须新 Dispatch。`,
    };
  }
  return { ok: false, reviewerDispatchId: null, source: null, error: '没有审官 dispatch 可投' };
}

function worktreeIdMatches(workerWtId, sel) {
  const id = String(workerWtId || '');
  const want = String(sel || '');
  if (!id || !want) return false;
  return id === want || id.endsWith(`::${want}`) || id.endsWith(want);
}

function reviewerHandleFromWorker(w) {
  return w?.agentTerminalHandle || w?.resource?.terminalHandle || null;
}

function terminalIsLive(handle, terminals) {
  if (!handle) return false;
  if (!Array.isArray(terminals)) return false;
  const t = terminals.find(x => x && x.handle === handle);
  if (!t) return false;
  if (t.connected === false || t.writable === false || t.orphaned === true) return false;
  const st = String(t.status || t.state || '').toLowerCase();
  if (!st) return true;
  return !/^(exited|closed|stopped|stale|dead)$/.test(st);
}

function isActiveDispatch(w) {
  return w && w.dispatchStatus !== 'completed' && w.workerState !== 'succeeded';
}

function pickHandleFromHits(hits, terminals) {
  const prefer = hits.filter(isActiveDispatch);
  const ordered = prefer.concat(hits.filter(w => !prefer.includes(w)));
  const seen = [];
  for (const w of ordered) {
    const h = reviewerHandleFromWorker(w);
    if (!h || seen.includes(h)) continue;
    seen.push(h);
    if (terminalIsLive(h, terminals)) return { handle: h, live: true };
  }
  return { handle: seen[0] || null, live: false };
}

/**
 * 找可复用审官：工人卡子卡（parentWorktreeId）∩ dispatch 记账。
 * 不看卡名、不看 PR 号。终端还在 → reuse；没有子卡或终端已关 → create 并写明原因。
 */
export function resolveReviewerReuse({
  parentId,
  worktrees,
  workers,
  terminals,
} = {}) {
  if (!parentId) return { ok: false, unscanned: true, error: 'resolveReviewerReuse 没给工人卡 id' };
  if (!Array.isArray(worktrees)) {
    return { ok: false, unscanned: true, error: 'worktree list 没查成（没查成，不许猜有没有审官卡）' };
  }
  if (!Array.isArray(workers)) {
    return { ok: false, unscanned: true, error: 'worker-list 没查成（没查成，不许猜 dispatch 记账）' };
  }
  if (!Array.isArray(terminals)) {
    return { ok: false, unscanned: true, error: 'terminal list 没查成（没查成，不许猜终端死活）' };
  }

  const children = worktrees.filter(w => (w.parentWorktreeId || null) === parentId);
  const candidates = [];
  for (const child of children) {
    const cid = child.id || child.worktreeId;
    if (!cid) continue;
    const hits = workers.filter(w => worktreeIdMatches(w?.resource?.worktreeId, cid));
    if (hits.length === 0) continue;
    const picked = pickHandleFromHits(hits, terminals);
    candidates.push({
      worktreeId: cid,
      handle: picked.handle,
      live: picked.live,
      createdAt: Number(child.createdAt) || 0,
    });
  }

  if (candidates.length === 0) {
    return {
      ok: true,
      action: 'create',
      reason: '工人卡下没有带 dispatch 记账的审官子卡（parentWorktreeId + 记账，不按卡名/PR 号）',
    };
  }

  const live = candidates.filter(c => c.live && c.handle).sort((a, b) => b.createdAt - a.createdAt);
  if (live.length) {
    const pick = live[0];
    return {
      ok: true,
      action: 'reuse',
      worktreeId: pick.worktreeId,
      handle: pick.handle,
      reason: '复用工人卡下已有审官终端（parentWorktreeId + dispatch 记账，不按 PR 号）',
    };
  }

  return {
    ok: true,
    action: 'create',
    reason: '老审官终端已关闭/不存在，允许新建',
    closedWorktrees: candidates.map(c => c.worktreeId),
  };
}

/** #675：起审官失败三态。terminal create 超时 / 注入未提交 / 没查成 必须分开。 */
export function classifyReviewerSpawnError(error) {
  const t = String(error || '');
  if (/Timed out waiting for terminal handle|terminal create 失败|terminal create 超时/i.test(t)) {
    return { kind: 'terminal-timeout', label: 'terminal create 超时' };
  }
  if (/注入未提交|Pasted Content|Pasted text/i.test(t)) {
    return { kind: 'inject-unsubmitted', label: '注入未提交' };
  }
  return { kind: 'unscanned', label: '没查成' };
}

export function reviewerSpawnFailComment({ error, retried = false } = {}) {
  const cls = classifyReviewerSpawnError(error);
  return [
    `交卷没开成审官下一跳：${cls.label}`,
    '',
    `worker-done 起审官失败（${cls.label}）。完工评论已落到 GitHub。${retried ? '同一命令已重试一次仍失败。' : ''}`.trim(),
    String(error || ''),
  ].join('\n');
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

/** PR 正文/标题里的署名单号：认「署名 issue #N」（#657）、「关联 issue #N」（#633）
 * 与旧的 GitHub 关闭关键词（Closes/Fixes/Resolves…）。正文随手引用的 #单号 仍不算。 */
export function linkedIssueNumbers(text) {
  const found = [];
  const re = /(?:署名\s+issue\s*#?\s*|关联(?:\s*issue)?\s+#|(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#)(\d+)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const t = Number(m[1]);
    if (Number.isInteger(t) && !found.includes(t)) found.push(t);
  }
  return found;
}

/** 合并侧（帅合并时跑）：PR 正文署名的 issue 上取 model/* type/* reviewer/* label，抄到 PR。
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
    return { ok: false, unscanned: false, error: `PR #${n} 正文/标题里没有「署名 issue #N」/关单词署名单号——label 无从同步，需人工补` };
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


export function dispatchComment({ mergePolicy, mergeReason, model, reviewer, split, splitReason } = {}) {
  const parts = [`merge-policy:${mergePolicy}`, `model:${model}`, `reviewer:${reviewer}`];
  if (split != null && String(split).trim() !== '') {
    parts.push(`split:${split}`);
    if (String(split).toLowerCase() === 'no' && splitReason) {
      parts.push(`split 理由: ${splitReason}`);
    }
  }
  const base = parts.join(' · ');
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

// ── 注入闸（#602 / #619）：主约束 = 一行指针。换行按 agent 转码（grok 转 ESC+CR），不禁换行。
// 唯一硬闸 = UTF-8 字节 ≤500。模板文件末尾允许一个 EOF 换行，渲染后剥掉。
// 二分实测（2026-08-17，grok 探针 term + 帅 701 截断）：
//   orca terminal send 单行 200/350/450/550/650/701 均送达（模型回出末尾标记）
//   帅经 TUI 输入框提交 701 字节：前半进消息、后半留输入框
// 安全值取 500：低于 TUI 截断点，高于目标 100，send 路径 550 仍绿。
//
// #619：本闸只量我们拼的 spec。Orca worker-start 还会再包一层 preamble（实测约 4600 字节），
// 那一层不在我们手里，量不到。preamble 单独就会触发 Codex/Grok 粘贴块，所以短指针仍要走提交第二拍。
export const INJECT_MAX_BYTES = 500;
export const INJECT_OVER_LIMIT_HINT = '正文挪去仓内文件或 GitHub，注入只给指针';
export const INJECT_GATE_SCOPE = 'our-spec-only';
export const ORCA_WORKER_PREAMBLE_BYTES_MEASURED = 4600;
export const INJECT_GATE_NOTE = '本闸只量我们拼的 spec，量不到 Orca worker-start preamble（实测约 4600 字节）。preamble 单独就会触发 Codex/Grok 粘贴块。';

export function injectUtf8Bytes(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

export function stripInjectEof(text) {
  return String(text ?? '').replace(/(?:\r\n|\n|\r)+$/g, '');
}

export function assertInjectText(text, { label } = {}) {
  const s = String(text ?? '');
  const bytes = injectUtf8Bytes(s);
  if (bytes > INJECT_MAX_BYTES) {
    return {
      ok: false,
      length: s.length,
      bytes,
      newlines: /[\r\n]/.test(s),
      limit: INJECT_MAX_BYTES,
      scope: INJECT_GATE_SCOPE,
      note: INJECT_GATE_NOTE,
      preambleBytesMeasured: ORCA_WORKER_PREAMBLE_BYTES_MEASURED,
      error: `注入 ${bytes} 字节超过上限 ${INJECT_MAX_BYTES}（${label || 'task spec'}）。${INJECT_OVER_LIMIT_HINT}。${INJECT_GATE_NOTE}`,
    };
  }
  return {
    ok: true,
    length: s.length,
    bytes,
    newlines: /[\r\n]/.test(s),
    limit: INJECT_MAX_BYTES,
    scope: INJECT_GATE_SCOPE,
    note: INJECT_GATE_NOTE,
    preambleBytesMeasured: ORCA_WORKER_PREAMBLE_BYTES_MEASURED,
  };
}

/** 兼容旧名：与 assertInjectText 相同，唯一硬闸是 UTF-8 字节上限。 */
export function assertInjectLen(text, opts) {
  return assertInjectText(text, opts);
}

function renderInjectTemplate(name, vars) {
  return stripInjectEof(renderDispatchTemplate(name, vars));
}

export function buildSoldierInject({ spec, issue } = {}) {
  const text = renderInjectTemplate('soldier-inject.md', {
    SPEC: spec,
    ISSUE_REF: issue ? ` #${issue}` : '',
  });
  const gate = assertInjectText(text, { label: '士兵注入' });
  if (!gate.ok) throw new Error(gate.error);
  return text;
}

export function buildBatchInject({ spec, issue } = {}) {
  const text = renderInjectTemplate('batch-inject.md', {
    SPEC: spec,
    ISSUE_REF: issue ? ` #${issue}` : '',
  });
  const gate = assertInjectText(text, { label: 'batch 注入' });
  if (!gate.ok) throw new Error(gate.error);
  return text;
}

export function buildReviewerInject({ spec, issue, pr, soldierDispatchId, mergePolicy, mergeReason } = {}) {
  const policy = mergePolicy == null ? mergePolicy : String(mergePolicy);
  const text = renderInjectTemplate('reviewer-inject.md', {
    SPEC: spec,
    ISSUE_REF: issue ? ` #${issue}` : '',
    PR: pr,
    SOLDIER_DISPATCH_ID: soldierDispatchId,
    MERGE_POLICY: policy,
    MERGE_REASON_REF: policy === 'manual' && mergeReason ? ` r=${mergeReason}` : '',
  });
  const gate = assertInjectText(text, { label: '审官注入' });
  if (!gate.ok) throw new Error(gate.error);
  return text;
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

export function argsOrchestrationSend({
  to, subject, body, type, outcome,
  from, taskId, dispatchId, dispatchCapability,
  filesModified, reportPath, phase, run,
} = {}) {
  const a = ['orchestration', 'send'];
  if (to) a.push('--to', to);
  if (from) a.push('--from', from);
  if (run) a.push('--run', run);
  if (subject != null) a.push('--subject', subject);
  if (body != null) a.push('--body', body);
  if (type) a.push('--type', type);
  if (outcome) a.push('--outcome', outcome);
  if (taskId) a.push('--task-id', taskId);
  if (dispatchId) a.push('--dispatch-id', dispatchId);
  if (dispatchCapability) a.push('--dispatch-capability', dispatchCapability);
  if (filesModified) a.push('--files-modified', filesModified);
  if (reportPath) a.push('--report-path', reportPath);
  if (phase) a.push('--phase', phase);
  a.push('--json');
  return a;
}

/** #551：worker_done 是 exact-Dispatch 结算口，不是普通投递。 */
export function planWorkerDoneSend({ type, to, outcome, taskId, dispatchId, from, dispatchCapability } = {}) {
  const t = type == null ? '' : String(type).trim();
  if (t !== 'worker_done') {
    return { ok: true, kind: 'notify', settle: false };
  }
  const missing = [];
  if (!String(taskId || '').trim()) missing.push('task-id');
  if (!String(dispatchId || '').trim()) missing.push('dispatch-id');
  const oc = String(outcome || '').trim();
  if (oc !== 'succeeded' && oc !== 'failed') missing.push('outcome');
  if (missing.length) {
    return {
      ok: false, kind: 'settle', settled: false, unscanned: false,
      error: `未结算：worker_done 缺 ${missing.join('/')}（exact-Dispatch 信号必须带身份，不能省略）`,
    };
  }
  const dest = to == null ? '' : String(to).trim();
  if (dest) {
    return {
      ok: false, kind: 'settle', settled: false, unscanned: false,
      error: '未结算：worker_done 不能带 --to（exact-Dispatch 信号须省略 --to，走活动 Dispatch 的 Run 信箱）',
    };
  }
  return {
    ok: true, kind: 'settle', settle: true, omitTo: true,
    taskId: String(taskId).trim(),
    dispatchId: String(dispatchId).trim(),
    outcome: oc,
    from: from ? String(from).trim() : null,
    dispatchCapability: dispatchCapability ? String(dispatchCapability).trim() : null,
  };
}

/**
 * 读 worker-show 判断 Dispatch 是否真的 completed。
 * 没查成（缺信封/缺 status）和「查到了但未 completed」必须分开。
 */
export function readDispatchSettlement(json) {
  if (!json || typeof json !== 'object') {
    return { ok: false, unscanned: true, settled: false, error: 'worker-show 返回空（没查成，不许当未结算）' };
  }
  const dispatch = json.result && json.result.dispatch;
  if (!dispatch || typeof dispatch !== 'object') {
    return { ok: false, unscanned: true, settled: false, error: 'worker-show 没有 result.dispatch（没查成，不许当未结算）' };
  }
  const status = dispatch.status == null ? null : String(dispatch.status);
  const workerState = json.result?.worker?.state == null ? null : String(json.result.worker.state);
  if (status == null) {
    return {
      ok: false, unscanned: true, settled: false,
      error: 'worker-show 查到了但没有 dispatch.status（没查成，不许当未结算）',
      dispatchId: dispatch.id || null, workerState,
    };
  }
  const settled = String(status).toLowerCase() === 'completed';
  return {
    ok: true, unscanned: false, settled,
    status, workerState,
    dispatchId: dispatch.id || null,
    taskId: dispatch.task_id || null,
    assigneeHandle: dispatch.assignee_handle || null,
    completedAt: dispatch.completed_at || null,
  };
}

export function isWrongPaneWorkerDoneError(error) {
  const text = orcaErrorText(error);
  return /not the Dispatch pane|not_dispatch_pane|caller is not the Dispatch|assignee|exact-Dispatch|stable pane|pane identity/i.test(text);
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

export function argsRunCurrent({ from } = {}) {
  const a = ['orchestration', 'run-current'];
  if (from) a.push('--from', from);
  a.push('--json');
  return a;
}

/**
 * run-use：`--from` 冒充其它终端会 consumer_fenced（orca 校验证书）。
 * 省略 --from = 绑调用窗自己。#667 帅窗派工不许走这条；
 * 工人起审官本终端已解绑时允许 self:true 绑自己。
 */
export function argsRunUse({ id, from, self } = {}) {
  if (!from && !self) {
    throw new Error('run-use 要 --from（冒充会 fenced）或 self:true 绑调用窗（#667 帅窗派工不许）');
  }
  const a = ['orchestration', 'run-use'];
  if (id) a.push('--id', id);
  if (from) a.push('--from', from);
  a.push('--json');
  return a;
}

/** run-create 必须带 --from 信箱台，否则新建 Run 会把帅窗绑成 coordinator。 */
export function argsRunCreate({ objective, from } = {}) {
  if (!from) throw new Error('run-create 必须 --from 信箱台，不许从帅窗当 coordinator（#667）');
  const a = ['orchestration', 'run-create'];
  if (objective != null) a.push('--objective', objective);
  a.push('--from', from, '--json');
  return a;
}

/** #675：工人 TUI 自己开 Run（不 --from 信箱台，会 consumer_fenced）。帅窗不许走这条。 */
export function argsRunCreateSelf({ objective } = {}) {
  const a = ['orchestration', 'run-create'];
  if (objective != null) a.push('--objective', objective);
  a.push('--json');
  return a;
}

/** run-current 三态：没查成 / 已有 Run / 查到 null 需要本窗自开。 */
export function planCallerRun({ currentOk, currentJson, currentError } = {}) {
  if (!currentOk) {
    return { ok: false, unscanned: true, error: `run-current 没查成：${currentError || ''}`.trim() };
  }
  const runId = extractRunId(currentJson);
  if (runId) return { ok: true, runId, needCreate: false };
  return { ok: true, runId: null, needCreate: true };
}

/** 真返回在 result.run.id。顶层 id 是 RPC id，不能当 runId。 */
export function extractRunId(json) {
  return json?.result?.run?.id || null;
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
  return orcaErrorText(error);
}

/** 从 worker-show JSON 取出士兵终端。已完工时 result.terminal 常为 null，退到 handle 字段。 */
export function extractSoldierTerminal(showJson) {
  const r = showJson?.result || {};
  return r.terminal?.handle
    || r.worker?.agent_terminal_handle
    || r.dispatch?.assignee_handle
    || r.terminalResource?.terminalHandle
    || null;
}

export function extractDispatchRunId(showJson) {
  return showJson?.result?.dispatch?.run_id || null;
}

export function extractDispatchWorktreeId(showJson) {
  const r = showJson?.result || {};
  return r.worker?.worktree_id
    || r.terminal?.worktreeId
    || r.terminalResource?.worktreeId
    || null;
}

/** hop 是不是「审官把红项打回士兵」这一跳。 */
export function isSoldierReworkHop(hop) {
  return /审官\s*→\s*士兵/.test(String(hop || ''));
}

/** probeRecipient 失败是不是「查到了、已完工」（不是没查成、不是不存在）。 */
export function isCompletedDispatchProbe(pre) {
  if (!pre || pre.kind !== 'dispatch' || pre.ok || pre.unscanned) return false;
  return !isLiveDispatchRecipient({ workerState: pre.status, dispatchStatus: pre.dispatchStatus })
    && !!(pre.status || pre.dispatchStatus);
}

function dispatchProbeExtras(showJson) {
  return {
    assigneeHandle: showJson?.result?.dispatch?.assignee_handle ?? null,
    agentTerminalHandle: showJson?.result?.worker?.agent_terminal_handle ?? null,
    terminalHandle: extractSoldierTerminal(showJson),
    runId: extractDispatchRunId(showJson),
    worktreeId: extractDispatchWorktreeId(showJson),
  };
}

/** dispatch 收件人必须还活着。completed/succeeded/failed 不是收件人。 */
export function isLiveDispatchRecipient({ workerState, dispatchStatus } = {}) {
  const live = new Set(['ready', 'working', 'waiting']);
  const dead = new Set(['completed', 'succeeded', 'failed', 'cancelled', 'canceled', 'released', 'stopped']);
  const w = String(workerState || '').toLowerCase();
  const d = String(dispatchStatus || '').toLowerCase();
  if (dead.has(w) || dead.has(d)) return false;
  if (live.has(w)) return true;
  return false;
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
      const workerState = r.json?.result?.worker?.state ?? null;
      const dispatchStatus = r.json?.result?.dispatch?.status ?? null;
      const extras = dispatchProbeExtras(r.json);
      if (workerState == null && dispatchStatus == null) {
        return {
          ok: false, unscanned: true, kind: 'dispatch', id: target.id,
          error: `收件人 Dispatch 查到了但没有 state/status（没查成，不许当活人）：${target.id}`,
          ...extras,
        };
      }
      if (!isLiveDispatchRecipient({ workerState, dispatchStatus })) {
        return {
          ok: false, kind: 'dispatch', id: target.id,
          status: workerState,
          dispatchStatus,
          error: `收件人 Dispatch 已完工（state=${workerState} status=${dispatchStatus}）：禁止往已结算信箱发工作指令（#677：士兵没审完不该下班）。人走了 → 新开工人。`,
          ...extras,
        };
      }
      return {
        ok: true, kind: 'dispatch', id: target.id,
        status: workerState,
        dispatchStatus,
        ...extras,
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
  if (!run) return { ok: false, kind: 'own-run', error: '本终端没绑 orchestration Run（run-current 为 null），省略收件人 = 发进真空。工人/审官用 worker-show 的 dispatch.run_id 写成 --to run:<id>' };
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
 * 普通 notify 四关验的是投递，不是结算：ok:true 只说明消息进了收件人信箱。
 * --type worker_done 是结算口（#551）：必须带 task-id/dispatch-id/outcome、省略 --to，
 * 发出后核 worker-show Dispatch 为 completed。落库但未 completed、缺身份、错 pane
 * 一律 ok:false 并报「未结算」。没查成（unscanned）和查到未 completed 分开。
 *
 * #677：hop 审官→士兵 打进还活着的 id。已完工 fail-visible，不开下一跳救人。
 */
export function deliverMessage({
  to = null, subject, body = '', type, outcome, hop = '闭环通知', orca, inboxLimit = 50,
  taskId, dispatchId, dispatchCapability, from, filesModified, reportPath,
} = {}) {
  if (typeof orca !== 'function') throw new Error('deliverMessage 要 orca 执行器');
  if (!subject) return { ok: false, hop, stage: '参数', error: `${hop}：缺 --subject，没主题的通知等于没通知` };

  const settlePlan = planWorkerDoneSend({ type, to, outcome, taskId, dispatchId, from, dispatchCapability });
  if (!settlePlan.ok) {
    return { ok: false, hop, stage: '结算', settled: false, unscanned: !!settlePlan.unscanned, error: `${hop}：${settlePlan.error}` };
  }
  if (settlePlan.kind === 'settle') {
    return settleDispatch({
      hop, subject, body, outcome: settlePlan.outcome,
      taskId: settlePlan.taskId, dispatchId: settlePlan.dispatchId,
      from: settlePlan.from, dispatchCapability: settlePlan.dispatchCapability,
      filesModified, reportPath, orca,
    });
  }

  const target = classifyNotifyTarget(to);
  if (target.kind === 'unsupported') return { ok: false, hop, stage: '收件人', error: `${hop}：${target.error}` };

  const pre = probeRecipient(target, orca);
  if (!pre.ok) {
    if (isSoldierReworkHop(hop) && isCompletedDispatchProbe(pre)) {
      return {
        ok: false, hop, stage: '收件人',
        error: `${hop}：士兵已下班（过早 worker_done），红项打不进活人。不要开下一跳救人（#677）。人走了才升级给帅。`,
        recipient: pre,
      };
    }
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

/** #551：发 worker_done 后必须核 Dispatch 变成 completed，落库无效力 = 未结算。 */
export function settleDispatch({
  hop = '闭环结算', subject, body = '', outcome, taskId, dispatchId,
  from, dispatchCapability, filesModified, reportPath, orca,
} = {}) {
  if (typeof orca !== 'function') throw new Error('settleDispatch 要 orca 执行器');

  const shown = orca(argsWorkerShow({ dispatch: dispatchId }));
  if (!shown.ok) {
    const text = orcaErrText(shown.error);
    if (/dispatch_not_found|not_found/i.test(text)) {
      return { ok: false, hop, stage: '结算', settled: false, error: `${hop}：未结算：Dispatch 不存在（${text}）` };
    }
    return {
      ok: false, hop, stage: '结算', settled: false, unscanned: true,
      error: `${hop}：未结算：Dispatch 状态没查成（没查成 ≠ 未 completed）：${text}`,
    };
  }
  const before = readDispatchSettlement(shown.json);
  if (!before.ok) {
    return { ok: false, hop, stage: '结算', settled: false, unscanned: true, error: `${hop}：未结算：${before.error}` };
  }
  if (before.settled) {
    return {
      ok: false, hop, stage: '结算', settled: false,
      error: `${hop}：未结算：Dispatch 已经 completed，不能再发 worker_done`,
    };
  }
  const sender = from || before.assigneeHandle;
  if (!sender) {
    return {
      ok: false, hop, stage: '结算', settled: false,
      error: `${hop}：未结算：缺 --from，且 worker-show 没有 assignee_handle（错 pane 无法对齐）`,
    };
  }

  const sent = orca(argsOrchestrationSend({
    subject, body, type: 'worker_done', outcome,
    taskId, dispatchId, dispatchCapability, from: sender,
    filesModified, reportPath,
  }));
  if (!sent.ok) {
    const text = orcaErrText(sent.error);
    const pane = isWrongPaneWorkerDoneError(sent.error);
    return {
      ok: false, hop, stage: '结算', settled: false, wrongPane: pane,
      error: `${hop}：未结算：${pane ? '错误 pane 发送（发送方不是 Dispatch 本人）' : 'orca send 失败'}：${text}`,
    };
  }
  const msg = extractSentMessage(sent.json);

  const afterShow = orca(argsWorkerShow({ dispatch: dispatchId }));
  if (!afterShow.ok) {
    const text = orcaErrText(afterShow.error);
    return {
      ok: false, hop, stage: '结算', settled: false, unscanned: true, messageId: msg?.id || null,
      error: `${hop}：未结算：发出后 Dispatch 状态没查成（没查成 ≠ 未变 completed）：${text}`,
    };
  }
  const after = readDispatchSettlement(afterShow.json);
  if (!after.ok) {
    return {
      ok: false, hop, stage: '结算', settled: false, unscanned: true, messageId: msg?.id || null,
      error: `${hop}：未结算：${after.error}`,
    };
  }
  if (!after.settled) {
    return {
      ok: false, hop, stage: '结算', settled: false, messageId: msg?.id || null,
      status: after.status, workerState: after.workerState,
      error: `${hop}：未结算：消息已落库但 Dispatch 仍是 ${after.status || after.workerState || '非 completed'}（落库无结算效力）`,
    };
  }
  return {
    ok: true, hop, stage: '已结算', settled: true,
    messageId: msg?.id || null,
    dispatchId, taskId, outcome,
    status: after.status, workerState: after.workerState,
    from: sender,
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
  'gate-create', 'gate-resolve', 'gate-list', 'liveness', 'check-help', 'pr-sync-labels', 'ledger-query', 'amend',
  'inbox-collect', 'run-gc', 'ask', 'raw',
];

const BOOL_FLAGS = new Set(['no-parent', 'force', 'enter', 'dry-run', 'json', 'confirm', 'unclosed', 'apply', 'peek']);
const MULTI_FLAGS = new Set(['slice']);

export const FLAGS_BY_VERB = {
  start: new Set(['--provider', '--model', '--worktree', '--title', '--dry-run', '--json', '--help', '-h']),
  dispatch: new Set([
    '--name', '--merge-policy', '--merge-reason', '--split', '--split-reason', '--slice', '--model', '--role', '--reviewer', '--confirm',
    '--spec', '--task', '--issue', '--now', '--batch', '--dry-run', '--json', '--help', '-h',
  ]),
  'worktree-create': new Set([
    '--name', '--no-parent', '--setup', '--parent-worktree', '--base-branch',
    '--issue', '--comment', '--json', '--help', '-h',
  ]),
  'worktree-rm': new Set(['--worktree', '--force', '--json', '--help', '-h']),
  'task-create': new Set(['--spec', '--run', '--agent', '--json', '--help', '-h']),
  'worker-start': new Set([
    '--task', '--worktree', '--terminal', '--retry-of', '--issue', '--merge-policy', '--merge-reason',
    '--model', '--role', '--reviewer', '--confirm', '--now', '--json', '--help', '-h',
  ]),
  'worker-release': new Set(['--dispatch', '--retry-request', '--json', '--help', '-h']),
  'worker-read': new Set(['--dispatch', '--source', '--cursor', '--limit', '--json', '--help', '-h']),
  'worker-done': new Set([
    '--pr', '--body', '--body-file', '--parent-worktree', '--soldier-dispatch', '--dry-run', '--json', '--help', '-h',
  ]),
  'reviewer-create': new Set([
    '--pr', '--name', '--reviewer', '--parent-worktree', '--comment', '--issue',
    '--soldier-dispatch', '--merge-policy', '--merge-reason', '--dry-run', '--json', '--help', '-h',
  ]),
  'reviewer-attach': new Set([
    '--pr', '--worktree', '--reviewer', '--name', '--soldier-dispatch', '--spec',
    '--merge-policy', '--merge-reason', '--comment', '--issue', '--dry-run', '--json', '--help', '-h',
  ]),
  send: new Set(['--terminal', '--text', '--enter', '--agent', '--json', '--help', '-h']),
  notify: new Set([
    '--to', '--subject', '--body', '--type', '--outcome', '--hop',
    '--task-id', '--dispatch-id', '--dispatch-capability', '--from',
    '--files-modified', '--report-path',
    '--json', '--help', '-h',
  ]),
  reply: new Set(['--id', '--body', '--from', '--run', '--json', '--help', '-h']),
  'inbox-collect': new Set(['--peek', '--json', '--help', '-h']),
  'run-gc': new Set(['--apply', '--json', '--help', '-h']),
  ask: new Set(['--question', '--options', '--timeout-ms', '--run', '--json', '--help', '-h']),
  'gate-create': new Set(['--task', '--question', '--options', '--from', '--json', '--help', '-h']),
  'gate-resolve': new Set(['--id', '--resolution', '--from', '--json', '--help', '-h']),
  'gate-list': new Set(['--task', '--status', '--run', '--json', '--help', '-h']),
  liveness: new Set(['--path', '--json', '--help', '-h']),
  'check-help': new Set(['--json', '--help', '-h']),
  'pr-sync-labels': new Set(['--pr', '--json', '--help', '-h']),
  'ledger-query': new Set(['--recent', '--issue', '--unclosed', '--json', '--help', '-h']),
  amend: new Set(['--issue', '--pr', '--why', '--by', '--model', '--dry-run', '--json', '--help', '-h']),
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
    const ck = camelFlag(key);
    if (MULTI_FLAGS.has(key)) {
      if (!Array.isArray(args[ck])) args[ck] = [];
      args[ck].push(val);
      continue;
    }
    args[ck] = val;
  }
  return args;
}

export const USAGE = `用法: node scripts/dao.mjs <verb> [args]

派工（约束载体，缺一即退；merge-policy 默认 auto）：
  dispatch --name <动宾短语> [--issue <issue号>] [--merge-policy auto|manual] [--merge-reason <文>] --split <no|N> [--split-reason <文>] [--slice <分块>]... --reviewer <模型id> --spec <文> (--model <id> | --role <角色> [--confirm]) [--dry-run]
  dispatch --batch <file.json> --name <批名> --issue <号> --model <id> [--dry-run]
                  # 一批只读工人共享 1 张卡：建 1 棵树，循环 N 次 task-create + worker-start
                  # 不产 PR，硬编码跳过审官与 --split；--dry-run 只打印 N 条计划（name/spec/handle 占位）
启动:
  start --provider <名> | --model <id> --worktree <sel> [--title <名>] [--dry-run]
                  # #633：空壳先关；认识的 agent 走 worker-start --agent；reclaude 走 --command；禁止 send 进 pwsh
编排:
  worktree-create --name <动宾短语> [--issue <issue号>] [--no-parent] [--setup skip] [--parent-worktree <sel>] [--base-branch <ref>] [--comment <文>]
  reviewer-create --pr <N> [--name <名>] [--reviewer <模型id>] [--parent-worktree <sel>] [--comment <文>] [--issue <号>] [--soldier-dispatch <id>] [--dry-run]
                  # 不传 --reviewer 时自读署名 issue 的 reviewer/*（#586）；工人路径不传模型
                  # 建树后空壳先关再 create --command（#633）；--dry-run 只打印选型不建树
                  # #575 ⑦：mergeable!=MERGEABLE 拒建树；建树后试合 master 再 abort，HEAD 仍停在 PR head
                  # #679：工人审官同厂当场拒；工人模型没查成 / 扫完没有 model/* 都拒绝起审官
  worker-done --pr <N> [--body <文> | --body-file <文件>] [--parent-worktree <工人卡>] [--soldier-dispatch <id>] [--dry-run]
                  # 交卷：发完工/返工 comment；无审官卡才 reviewer-create；有卡且终端还在则新 task 注入老终端；终端已关才允许新建并写原因；两条路径都 notify 审官（投失败即停）
                  # #677：成功路径不结算士兵 Dispatch。判定绿才允许 notify --type worker_done。失败不得假装已下班。
  reviewer-attach --pr <N> --worktree <工人卡> --reviewer <模型id> [--name <名>] [--soldier-dispatch <id>] [--spec <文>]
                  # 给已有工人卡补派审官（#575）：建树+空壳先关再 create --command（#633）+验开工，一条命令，不碰 raw
                  # #679：与工人同厂当场拒（#678 实咬的口），不许 attach 成工人那一厂
  pr-sync-labels --pr <N>   # 合并前把署名 issue 的 model/* type/* reviewer/* label 同步到 PR（#564 + #586）
  worktree-rm --worktree <sel> [--force]
                  # 一条命令整树后序删（子卡先于父卡）。任一棵有 working/waiting agent 则整树不删，报清是哪棵
                  # #595：树内 ledger/events 有未进主树的事件文件 → 整树不删，报清是哪几条
                  # #593：同一动作退役该单不再被其它在途树占用的 Run（关信箱台 + 删租约）
  inbox-collect [--peek]
                  # 按在途单的 Run 收信箱。三态：empty / unscanned / run_not_found。默认 --peek 不标已读
  run-gc [--apply]
                  # 列出无在途单对应的 Run；--apply 才关台退役。在途的不许退役
  ask --question <文> [--options <csv>] [--timeout-ms <n>] [--run <id>]
                  # 替代 orca orchestration ask：超时打 ASK_TIMEOUT 非零退出，不许空转
  task-create --spec <文>
  worker-start --task <id> --terminal <handle> [--worktree <sel>] [--issue <issue号>] [--merge-policy auto|manual] [--merge-reason <文>] --reviewer <id> (--model <id> | --role <角色> [--confirm]) [--retry-of <id>]
  worker-release --dispatch <id>   # 结算后收尾：release 或转移所有权（#559 ⑤），不 release 会留孤儿工位
  worker-read --dispatch <id> [--source auto|transcript|terminal] [--limit <n>]   # 读工人输出/开工证明（#559 ⑥）
  send --terminal <handle> --text <文> [--enter] [--agent grok|claude|pi|codex]
                  # grok 发送前把 \\n 转成 ESC+CR（Alt+Enter）；claude/pi 原样；codex 不转（换行留不住）
  notify --subject <文> [--to <term_…|run:…|dispatch:…>] [--body <文>] [--type <类>] [--outcome succeeded|failed] [--hop <跳名>]
                  [--task-id <id> --dispatch-id <id> --from <handle> --dispatch-capability <token>]
                  # 普通通知：dispatch: 活人直接投递。hop 审官→士兵 打进还活着的 id；已完工 fail-visible，不开下一跳救人（#677）
                  # --type worker_done：省略 --to，必须带 --task-id/--dispatch-id/--outcome；发出后核 Dispatch 变 completed（#551）。士兵侧判定绿才允许发。
  reply --id <消息id> --body <回答> [--from <handle>] [--run <id>]
                  # 帅回答工人的 ask。不抢信箱台：缺 --from 时自动用该 Run 的 coordinator_handle
  gate-create --task <task_id> --question <问题> [--options <json数组>]   # 上帅裁定建原生决策门（#559 ④）
  gate-resolve --id <gate_id> --resolution <裁定>                          # 帅裁定决议门
  gate-list [--task <task_id>] [--status <状态>]
其他:
  liveness [--path <工作树>]
  check-help
  ledger-query (--recent <n> | --issue <号> | --unclosed)
                  # 按事件 ts 查账本，不按文件 mtime、不 grep 数字。查到 0 条 ≠ 没查成
  amend --issue <号> --why <一句话> [--pr <号>] [--by 帅|用户] [--model <id>]
                  # 帅追加职责：写 job.override(scope) 并往 issue 发正文。不靠「记得记一条」
  raw -- <任意命令...>     逃生口，必须留痕

notify 是闭环三跳（士兵→审官 / 审官→士兵 / 审官→帅）唯一的发信口：收件人不在、回执拿不到、
落库查不到，一律非零退出并在 stderr 打「链断」，不许当「发成功了只是还没读」。
收件人形态：dispatch:<id>（官方结构化收件箱，士兵↔审官互发用；#559 ①）、run:…（审官→帅）、
term_…（低层通道）、省略（自己那条 Run 信箱）。
delivered_at 只如实报出，不当判据（本机 Orca 对活着的收件人也常留 null，当门就是天天假红）。
普通 notify 验的是**投递**不是**结算**：ok:true 只说明消息进了收件人信箱。
--type worker_done 是结算口（#551）：必须带 --task-id/--dispatch-id/--outcome，省略 --to，
发出后核 worker-show Dispatch 为 completed。缺身份、错 pane、落库但未 completed
一律非零并报「未结算」。状态没查成标 unscanned，不许当成「查过仍是 dispatched」。

启动模板只读 docs/model-routing.toml [providers.*].launch，读失败非零退出。
派工不给 --model 时只推荐、要 --confirm，禁静默默认。未知 --参数 一律非零。
merge-policy 默认 auto（#511 拍板：帅只感知不再是关口）；选 manual 必须给 --merge-reason，
理由写进任务卡 comment 留痕，只限改协作约定 / 改 model-routing.toml 决策字段 / 花钱三类。
--split 必填（#611）：no 或 ≥2 的整数；两个都不给 → 非零退出。--split no 必须给 --split-reason（理由入账本）。
--split N 建父卡 + N 张子卡（子卡 --parent-worktree 挂父卡、--base-branch 用任务分支），父卡工人是头工人。
--split N 必须给 N 个 --slice（每块一份非空、互不重叠的分块说明；抽到的文件路径不得跨块）。失败回滚先 worker-stop / task-update failed，再关终端删树。
判据：产出物能不能按文件切开？能切 + 块数 ≥2 + 每块够一个工人干 → --split N；切不开（同几个文件反复改）→ --split no + 理由。
worker-start 的 --worktree 可省略：复用已存在终端续 Dispatch（worker_done 后同一终端绑到新 Task，
#559 ②）时工作区由终端决定；新开工人位仍建议显式给 --worktree。
换人（乒乓两轮仍红）走 worker-start --task <同单> --retry-of <旧 dispatch id>，不重开一单（#559 ⑦）。
续活/审官场景的 merge-policy 约束：新开派工语义；flow.mjs 内部与 reviewer-create 不归本动词管，见 dispatch skill。
给了 --issue 时卡名走 assembleCardName（#589：格式只认那一处，本页不复制；号对不上也不拿名字当钥匙）。
并把 --issue 透传给 orca worktree create 把卡链到 GitHub issue（派工那一刻 PR 不存在，卡名先带 ISSUE-）。
dispatch / worker-start 带 --issue 时走消歧门（#565）：目标 issue 缺「已消歧」label 拒派（非 0 退出，fail-close）——
去该 issue 补消歧记录再打「已消歧」label（dao-project skill 第二节）；gh 查失败单独报「没查成」，不许当有 label 放行。
dispatch --dry-run 不走门控（不实际派工，disambiguation 只作报告，不影响退出码；#565 返工）。无 --issue 的派工不受门控（辅助终端不经 dispatch）。
`;
