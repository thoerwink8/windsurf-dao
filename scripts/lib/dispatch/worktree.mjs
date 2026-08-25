// scripts/lib/dispatch/worktree.mjs —— worktree 生命周期域（#762 拆分）
//
// 改这段前必须知道：worktree-rm 一条命令整树后序删（子卡先于父卡）。
// 占用中 / 子卡失踪 / 主树 → ok:false，调用方不得开删。
// 树内 ledger/events 有未进本机账本的事件文件 → 整树不删（删树前闸）。

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { orcaErrorText } from '../orca-error.mjs';

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
