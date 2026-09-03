// scripts/lib/dispatch/worktree.mjs —— worktree 生命周期域（#762 拆分）
//
// 改这段前必须知道：worktree-rm 一条命令整树后序删（子卡先于父卡）。
// 占用中 / 子卡失踪 / 主树 → ok:false，调用方不得开删。
// 树内 ledger/events 有未进本机账本的事件文件 → 整树不删（删树前闸）。
// #835：闸过后再收该树 agent 进程（先 terminal stop，不退则 SIGTERM）；
// 收不掉报 pid 非零，不许静默留下。占用闸一条都不放宽。

import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { orcaErrorText } from '../orca-error.mjs';

export const REAP_POLL_MS = 200;
export const REAP_STOP_WAIT_MS = 2000;
export const REAP_TERM_WAIT_MS = 2000;

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
 * #826：PR 已 MERGED 且审官已 APPROVED 时，working/waiting 不再挡删（审官 d= 空无法结算，树永远 working）。
 * archive 没查成 ≠ 可归档：unscanned 仍拦占用。
 */
export function planWorktreeRm(worktrees, selector, { archive } = {}) {
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
    if (archive && archive.unscanned) {
      return {
        ok: false,
        error: `占用中且归档状态没查成，未删任何树：${archive.error || '没查成'}`,
        order: [],
        occupied,
        archive,
      };
    }
    if (archive && archive.ok && archive.merged && archive.approved) {
      return {
        ok: true,
        order,
        occupied,
        waivedOccupancy: true,
        archive,
        root: { id: worktreeKey(root), name: root.displayName || worktreeKey(root) },
        reason: 'PR 已合并且审官已 approve，working/waiting 不挡归档（#826）',
      };
    }
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
  return `删树前拦住：树内有未进本机账本的账本事件（${list}）——先把它们拷进 ~/.dao/ledger/events/ 再删`;
}

/** 工人树 ledger/events 里有、本机账本（~/.dao/ledger/events）没有的事件文件。读失败 = 没查成，不许当 0。 */
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
export function prepareWorktreeRm(worktrees, selector, { mainEventsDir, readdir, exists, archive } = {}) {
  const plan = planWorktreeRm(worktrees, selector, { archive });
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

/** 树选择符匹配：全等 / `id::<sel>` 后缀 / 末段后缀（worker-list 与 worktree list 同款 id 形态）。 */
export function worktreeSelMatches(id, sel) {
  const s = String(sel || '').trim();
  const i = String(id || '');
  if (!s || !i) return false;
  return i === s || i.endsWith(`::${s}`) || i.endsWith(s);
}

/** 从 worktree list 数组里找选择符对应的树。找不到返回 null（不是没查成）。 */
export function findWorktreeBySel(worktrees, sel) {
  if (!Array.isArray(worktrees)) return null;
  const s = String(sel || '').trim();
  if (!s) return null;
  return worktrees.find(w => {
    if (!w) return false;
    return worktreeSelMatches(w.id || w.worktreeId, s) || worktreeSelMatches(w.path, s);
  }) || null;
}

function stripDeletedSuffix(p) {
  return String(p || '').replace(/\s*\(deleted\)\s*$/i, '');
}

/** cwd 是否就是这棵树（含 Linux `(deleted)` 后缀）。不匹配父路径。 */
export function cwdBelongsToTree(cwd, treePath) {
  const c = normPath(stripDeletedSuffix(cwd));
  const t = normPath(treePath);
  return Boolean(c && t && c === t);
}

function asPidList(result) {
  return (result && Array.isArray(result.pids) ? result.pids : [])
    .map(p => (typeof p === 'number' ? p : Number(p && p.pid)))
    .filter(pid => Number.isFinite(pid) && pid > 0);
}

/** 扫 /proc 找 cwd 落在这棵树上的 pid。没有 /proc（Windows）= 本平台不可用，不是没查成。 */
export function pidsOnTreePath(treePath, {
  procDir = '/proc',
  readdir = readdirSync,
  readlink = readlinkSync,
  exists = existsSync,
  selfPid = process.pid,
} = {}) {
  if (!treePath) return { ok: false, error: '缺 tree path，进程没查成', pids: [], details: [] };
  if (!exists(procDir)) return { ok: true, available: false, pids: [], details: [] };
  let names;
  try { names = readdir(procDir); }
  catch (e) {
    return {
      ok: false,
      unscanned: true,
      error: `读 ${procDir} 失败：${e && e.message ? e.message : e}`,
      pids: [],
      details: [],
    };
  }
  const details = [];
  for (const name of names) {
    if (!/^\d+$/.test(String(name))) continue;
    const pid = Number(name);
    if (pid === selfPid) continue;
    let cwd;
    try { cwd = readlink(join(procDir, String(pid), 'cwd')); }
    catch { continue; }
    if (!cwdBelongsToTree(cwd, treePath)) continue;
    details.push({ pid, cwd: String(cwd) });
  }
  return { ok: true, available: true, pids: details.map(d => d.pid), details };
}

export function formatReapPidError({ pids, node } = {}) {
  const list = (pids || []).join(',') || '（未列出 pid）';
  const name = (node && (node.name || node.id)) || '?';
  return `收不掉 agent 进程，未删树：pid ${list}（${name}）`;
}

function snapshotReapState({ listTerminals, listPids, node }) {
  const listed = listTerminals(node.id);
  if (!listed || listed.ok !== true) {
    return { ok: false, error: (listed && listed.error) || 'terminal list 没查成' };
  }
  if (!Array.isArray(listed.terminals)) {
    return { ok: false, error: 'terminal list 没有 terminals 数组，没查成' };
  }
  const agentHandles = listed.terminals
    .filter(t => t && t.agentIdentity)
    .map(t => t.handle || t.ptyId || '?');
  const pidsRes = listPids(node.path);
  if (!pidsRes || pidsRes.ok !== true) {
    return { ok: false, error: (pidsRes && pidsRes.error) || '进程没查成' };
  }
  const pids = asPidList(pidsRes);
  const available = pidsRes.available !== false;
  const gone = (available ? pids.length === 0 : true) && agentHandles.length === 0;
  return {
    ok: true,
    gone,
    pids,
    available,
    agentHandles,
    terminalCount: listed.terminals.length,
  };
}

function waitForGone(io, { timeoutMs, pollMs, now, sleep }) {
  const t0 = now();
  let last = snapshotReapState(io);
  if (!last.ok || last.gone) return last;
  while (now() - t0 < timeoutMs) {
    sleep(pollMs);
    last = snapshotReapState(io);
    if (!last.ok || last.gone) return last;
  }
  return last;
}

/**
 * 占用闸已经放行之后：先 terminal stop，确认 agent/pid 退出；
 * 没退再 SIGTERM。收不掉报 pid（或 agent handle）非零。
 * 空壳终端不在这里当失败——删树后另核对本树登记有没有跟着掉。
 */
export function reapWorktreeAgents({
  node,
  stop,
  listTerminals,
  listPids,
  killPid,
  sleep = () => {},
  now = () => Date.now(),
  stopWaitMs = REAP_STOP_WAIT_MS,
  termWaitMs = REAP_TERM_WAIT_MS,
  pollMs = REAP_POLL_MS,
} = {}) {
  const evidence = [];
  if (!node || !node.id) return { ok: false, error: '收进程缺 worktree id', evidence, killed: [] };
  if (typeof stop !== 'function') return { ok: false, error: 'reapWorktreeAgents 没给 stop', evidence, killed: [] };
  if (typeof listTerminals !== 'function') return { ok: false, error: 'reapWorktreeAgents 没给 listTerminals', evidence, killed: [] };
  if (typeof listPids !== 'function') return { ok: false, error: 'reapWorktreeAgents 没给 listPids', evidence, killed: [] };
  if (typeof killPid !== 'function') return { ok: false, error: 'reapWorktreeAgents 没给 killPid', evidence, killed: [] };

  const io = { listTerminals, listPids, node };
  const before = snapshotReapState(io);
  if (!before.ok) return { ok: false, error: `收进程前没查成，未删树：${before.error}`, evidence, killed: [] };
  evidence.push({
    step: 'before',
    pids: before.pids,
    agentHandles: before.agentHandles,
    terminalCount: before.terminalCount,
  });

  const stopped = stop(node.id);
  evidence.push({
    step: 'terminal-stop',
    ok: !!(stopped && stopped.ok),
    error: (stopped && stopped.error) || null,
  });

  const afterStop = waitForGone(io, { timeoutMs: stopWaitMs, pollMs, now, sleep });
  if (!afterStop.ok) return { ok: false, error: `收进程时没查成，未删树：${afterStop.error}`, evidence, killed: [] };
  evidence.push({
    step: 'after-stop',
    gone: afterStop.gone,
    pids: afterStop.pids,
    agentHandles: afterStop.agentHandles,
    terminalCount: afterStop.terminalCount,
  });
  if (afterStop.gone) return { ok: true, evidence, killed: [] };

  const leftoverPids = afterStop.pids || [];
  const killed = [];
  if (leftoverPids.length) {
    for (const pid of leftoverPids) {
      const k = killPid(pid);
      killed.push({ pid, ok: !!(k && k.ok), alreadyGone: !!(k && k.alreadyGone), error: (k && k.error) || null });
      if (!k || (k.ok !== true && !k.alreadyGone)) {
        return {
          ok: false,
          error: `SIGTERM pid ${pid} 失败：${(k && k.error) || '未知'}`,
          pids: leftoverPids,
          evidence,
          killed,
        };
      }
    }
    evidence.push({ step: 'sigterm', killed: killed.map(k => k.pid) });
    const afterTerm = waitForGone(io, { timeoutMs: termWaitMs, pollMs, now, sleep });
    if (!afterTerm.ok) return { ok: false, error: `SIGTERM 后没查成，未删树：${afterTerm.error}`, evidence, killed };
    evidence.push({
      step: 'after-term',
      gone: afterTerm.gone,
      pids: afterTerm.pids,
      agentHandles: afterTerm.agentHandles,
      terminalCount: afterTerm.terminalCount,
    });
    if (afterTerm.gone) return { ok: true, evidence, killed };
    if ((afterTerm.pids || []).length) {
      return {
        ok: false,
        error: formatReapPidError({ pids: afterTerm.pids, node }),
        pids: afterTerm.pids,
        evidence,
        killed,
      };
    }
    if ((afterTerm.agentHandles || []).length) {
      return {
        ok: false,
        error: `收不掉 agent 终端，未删树：${afterTerm.agentHandles.join(',')}（${node.name || node.id}）`,
        handles: afterTerm.agentHandles,
        evidence,
        killed,
      };
    }
    return { ok: true, evidence, killed };
  }

  if ((afterStop.agentHandles || []).length) {
    const stopHint = stopped && stopped.ok === false && stopped.error
      ? `；terminal stop：${stopped.error}`
      : '';
    return {
      ok: false,
      error: `收不掉 agent 终端，未删树：${afterStop.agentHandles.join(',')}（${node.name || node.id}）${stopHint}`,
      handles: afterStop.agentHandles,
      evidence,
      killed,
    };
  }

  // 只剩空壳：本单不清全局空壳（#633），删树后核对本树登记。
  return { ok: true, evidence, killed };
}

/** 删树后核对本树终端登记是否跟着掉。list 报找不到树 = 已掉。 */
export function verifyWorktreeTerminalsGone({ node, listTerminals } = {}) {
  if (!node || !node.id) return { ok: false, error: '核对终端缺 worktree id' };
  if (typeof listTerminals !== 'function') return { ok: false, error: 'verifyWorktreeTerminalsGone 没给 listTerminals' };
  const listed = listTerminals(node.id);
  if (!listed || listed.ok !== true) {
    const err = String((listed && listed.error) || '');
    if (/not found|找不到|unknown worktree|no such|selector_not_found/i.test(err)) {
      return { ok: true, gone: true, missingWorktree: true };
    }
    return { ok: false, error: `删树后 terminal list 没查成：${(listed && listed.error) || '未知'}` };
  }
  if (!Array.isArray(listed.terminals)) {
    return { ok: false, error: '删树后 terminal list 没有 terminals 数组，没查成' };
  }
  if (listed.terminals.length) {
    const handles = listed.terminals.map(t => (t && (t.handle || t.ptyId)) || '?');
    return {
      ok: false,
      error: `删树后终端登记还在：${handles.join(',')}（${node.name || node.id}）`,
      handles,
    };
  }
  return { ok: true, gone: true };
}
