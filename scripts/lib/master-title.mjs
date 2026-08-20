// scripts/lib/master-title.mjs —— 任务卡 comment 的单号定界区（issue #495 / #684）
//
// 改这段前必须知道：
// 1. 单号只写在末尾定界区 `｜[#N #M]`，加删只动这个区。不要在整段 comment 里子串找 #N
//    （#463/#489 用自由中文 + 子串匹配连打四层补丁全部失守）。
// 2. 落点是卡 `orca worktree set --comment`，不是终端标题。
//    带 agent 的终端 rename 回 ok:true 但 list/show 不变（#502 实测）。
// 3. 写完必回读。投递成功≠送达。
// 4. 任务卡增量：afterDispatchComment / applyRemoveTicket。帅位 master 卡是另一件事：
//    syncMasterTicketZone 在派工/清卡/合并三个事件点全量重写（#684）。不轮询、不 /rename。
//    长静默期内的手改不会被自动纠正——这是拍板取舍。
// 5. 盘面没查成不许当成在途 0：ps 失败 / 数组缺失 → 不写，避免把定界区抹空。

export const TICKET_ZONE_RE = /｜\[((?:#\d+)(?: #\d+)*)?\]$/;

export function normalizeTicket(id) {
  const m = String(id || '').trim().match(/^#?(\d+)$/);
  return m ? `#${m[1]}` : null;
}

export function ticketsFromName(name) {
  const found = [];
  const re = /#(\d+)/g;
  let m;
  while ((m = re.exec(String(name || '')))) {
    const t = `#${m[1]}`;
    if (!found.includes(t)) found.push(t);
  }
  return found;
}

export function parseTicketZone(title) {
  const s = String(title || '');
  const m = s.match(TICKET_ZONE_RE);
  if (!m) return { prefix: s, tickets: [], hasZone: false };
  const inner = m[1] || '';
  const tickets = inner ? inner.split(/\s+/).filter(Boolean) : [];
  return { prefix: s.slice(0, m.index), tickets, hasZone: true };
}

export function formatTitle(prefix, tickets) {
  const unique = [];
  for (const raw of tickets || []) {
    const t = normalizeTicket(raw);
    if (t && !unique.includes(t)) unique.push(t);
  }
  const head = prefix == null ? '' : String(prefix);
  if (unique.length === 0) return head;
  return `${head}｜[${unique.join(' ')}]`;
}

export function addTicket(title, id) {
  const t = normalizeTicket(id);
  if (!t) return String(title || '');
  const { prefix, tickets } = parseTicketZone(title);
  if (tickets.includes(t)) return formatTitle(prefix, tickets);
  return formatTitle(prefix, [...tickets, t]);
}

export function removeTicket(title, id) {
  const t = normalizeTicket(id);
  const { prefix, tickets, hasZone } = parseTicketZone(title);
  if (!t || !hasZone) return String(title || '');
  return formatTitle(prefix, tickets.filter(x => x !== t));
}

export function auditTitleTickets({ title, openIds } = {}) {
  if (title == null) {
    return { ok: false, unscanned: true, error: '没给标题，没查成', stale: [], scanned: 0 };
  }
  if (openIds == null) {
    return { ok: false, unscanned: true, error: '没给 openIds，没查成', stale: [], scanned: 0 };
  }
  const { tickets, hasZone } = parseTicketZone(title);
  if (!hasZone) {
    return { ok: true, unscanned: false, stale: [], scanned: 0, note: '标题无单号区' };
  }
  const open = new Set();
  for (const raw of openIds) {
    const t = normalizeTicket(raw);
    if (t) open.add(t);
  }
  const stale = tickets.filter(t => !open.has(t));
  return { ok: stale.length === 0, unscanned: false, stale, scanned: tickets.length };
}

/** 派工成功后卡 comment 必须有定界区。没给样本 = 没查成；有期望单号却无区 = 报警。 */
export function auditDispatchComment({ comment, expectedTickets } = {}) {
  if (comment == null) {
    return { ok: false, unscanned: true, error: '没给 comment，没查成', missing: [], scanned: 0 };
  }
  if (expectedTickets == null) {
    return { ok: false, unscanned: true, error: '没给 expectedTickets，没查成', missing: [], scanned: 0 };
  }
  const expected = [];
  for (const raw of expectedTickets) {
    const t = normalizeTicket(raw);
    if (t && !expected.includes(t)) expected.push(t);
  }
  if (expected.length === 0) {
    return { ok: true, unscanned: false, missing: [], scanned: 0, note: '没有期望单号' };
  }
  const { tickets, hasZone } = parseTicketZone(comment);
  if (!hasZone) {
    return {
      ok: false,
      unscanned: false,
      missing: expected,
      scanned: 0,
      reason: '派工卡 comment 缺单号定界区',
    };
  }
  const missing = expected.filter(t => !tickets.includes(t));
  return { ok: missing.length === 0, unscanned: false, missing, scanned: tickets.length };
}

function commentFromShow(json) {
  const wt = json?.result?.worktree || json?.worktree;
  return wt && wt.comment != null ? String(wt.comment) : '';
}

export function mutateWorktreeComment({ worktreeId, mutate, runOrca } = {}) {
  if (!worktreeId) return { ok: false, action: 'warn', reason: 'mutateWorktreeComment 没给 worktreeId' };
  if (typeof mutate !== 'function') return { ok: false, action: 'warn', reason: 'mutateWorktreeComment 没给 mutate' };
  if (typeof runOrca !== 'function') return { ok: false, action: 'warn', reason: 'mutateWorktreeComment 没给 runOrca' };

  const shown = runOrca(['worktree', 'show', '--worktree', worktreeId, '--json']);
  if (!shown || !shown.ok) {
    const reason = `worktree show 失败，不改 comment：${shown?.error || '无详情'}`;
    console.error(`[dao] ${reason}`);
    return { ok: false, action: 'warn', reason };
  }
  const current = commentFromShow(shown.json);
  const next = mutate(current);
  if (next === current) {
    return { ok: true, action: 'noop', worktreeId, comment: current };
  }
  const set = runOrca(['worktree', 'set', '--worktree', worktreeId, '--comment', next, '--json']);
  if (!set || !set.ok) {
    const reason = `worktree set --comment 失败：${set?.error || '无详情'}`;
    console.error(`[dao] ${reason}`);
    return { ok: false, action: 'warn', reason, from: current, to: next };
  }
  const shown2 = runOrca(['worktree', 'show', '--worktree', worktreeId, '--json']);
  const actual = commentFromShow(shown2?.json);
  if (actual !== next) {
    const reason = `worktree comment 回读不是所设（投递成功≠送达）：想要「${next}」，实际「${actual || '(空)'}」`;
    console.error(`[dao] ${reason}`);
    return { ok: false, action: 'warn', reason, from: current, to: next, actual };
  }
  return { ok: true, action: 'updated', worktreeId, from: current, comment: next };
}

export function afterDispatchComment({ name, issue, worktreeId, runOrca } = {}) {
  let tickets = ticketsFromName(name);
  const t = normalizeTicket(issue);
  if (t && !tickets.includes(t)) tickets = [...tickets, t];
  if (!tickets.length) {
    return { ok: true, action: 'skip', reason: '派工名与 --issue 里都没有 #单号，comment 不定界区', tickets };
  }
  const r = mutateWorktreeComment({
    worktreeId,
    runOrca,
    mutate: (comment) => tickets.reduce((acc, id) => addTicket(acc, id), comment),
  });
  return { ...r, tickets };
}

export function applyRemoveTicket({ id, worktreeId, runOrca } = {}) {
  const t = normalizeTicket(id);
  if (!t) return { ok: false, action: 'warn', reason: 'applyRemoveTicket 没给合法单号' };
  return mutateWorktreeComment({
    worktreeId,
    runOrca,
    mutate: (comment) => removeTicket(comment, t),
  });
}

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function repoPrefixOf(worktreeId) {
  const id = String(worktreeId || '');
  const i = id.indexOf('::');
  return i > 0 ? id.slice(0, i) : null;
}

export function belongsToRepo(w, selfRepo) {
  if (!selfRepo) return true;
  const id = String((w && (w.worktreeId || w.id)) || '');
  return id === selfRepo || id.startsWith(`${selfRepo}::`) || id.startsWith(selfRepo);
}

function linkedNumber(field) {
  if (field == null) return null;
  if (typeof field === 'number' && Number.isInteger(field) && field > 0) return field;
  if (typeof field === 'string') {
    const t = normalizeTicket(field);
    return t ? Number(t.slice(1)) : null;
  }
  if (typeof field === 'object') return linkedNumber(field.number);
  return null;
}

/** 从一张卡抽单号：linkedPR ∪ linkedIssue ∪ comment 定界区。卡名不算（#589）。 */
export function ticketsFromWorktree(w) {
  const out = [];
  const add = (raw) => {
    const t = normalizeTicket(raw);
    if (t && !out.includes(t)) out.push(t);
  };
  add(linkedNumber(w && w.linkedIssue));
  add(linkedNumber(w && w.linkedPR));
  const { tickets } = parseTicketZone(w && w.comment);
  for (const t of tickets) add(t);
  return out;
}

export function inferSelfRepo(worktrees, { pathHint } = {}) {
  const list = Array.isArray(worktrees) ? worktrees : [];
  const prefixOf = (w) => repoPrefixOf(w && (w.worktreeId || w.id));
  if (pathHint) {
    const want = normPath(pathHint);
    const hit = list.find(w => w && w.isMainWorktree === true && normPath(w.path) === want)
      || list.find(w => w && normPath(w.path) === want);
    if (hit) {
      const p = prefixOf(hit);
      if (p) return p;
    }
  }
  const mains = [...new Set(list.filter(w => w && w.isMainWorktree === true).map(prefixOf).filter(Boolean))];
  if (mains.length === 1) return mains[0];
  const all = [...new Set(list.map(prefixOf).filter(Boolean))];
  if (all.length === 1) return all[0];
  return null;
}

export function findMasterWorktree(worktrees, selfRepo) {
  if (!Array.isArray(worktrees)) {
    return { ok: false, unscanned: true, error: 'worktrees 不是数组，没查成' };
  }
  const hits = worktrees.filter(w => w && w.isMainWorktree === true && belongsToRepo(w, selfRepo));
  if (hits.length === 0) {
    return { ok: false, unscanned: false, error: '本仓 master 卡没找到' };
  }
  if (hits.length > 1) {
    return { ok: false, unscanned: false, error: `本仓 master 卡对上 ${hits.length} 张，不写` };
  }
  const w = hits[0];
  return { ok: true, worktree: w, worktreeId: w.worktreeId || w.id };
}

/**
 * 非 master、非归档、本仓卡的在途单号。卡名不算。
 * 多帅无归属真相源 → 写全体在途单（#684 退化行为）。
 */
export function collectInFlightTickets(worktrees, selfRepo) {
  if (!Array.isArray(worktrees)) {
    return { ok: false, unscanned: true, error: 'worktrees 不是数组，没查成', tickets: [], scanned: 0 };
  }
  const tickets = [];
  let scanned = 0;
  for (const w of worktrees) {
    if (!w || w.isMainWorktree === true || w.isArchived) continue;
    if (!belongsToRepo(w, selfRepo)) continue;
    scanned++;
    for (const t of ticketsFromWorktree(w)) {
      if (!tickets.includes(t)) tickets.push(t);
    }
  }
  tickets.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return { ok: true, unscanned: false, tickets, scanned };
}

export function worktreesFromPs(runOrca) {
  if (typeof runOrca !== 'function') {
    return { ok: false, unscanned: true, error: '没给 runOrca，盘面没查成' };
  }
  const listed = runOrca(['worktree', 'ps', '--json']);
  if (!listed || !listed.ok) {
    return { ok: false, unscanned: true, error: `worktree ps 失败：${listed?.error || '无详情'}` };
  }
  const wts = listed.json?.result?.worktrees;
  if (!Array.isArray(wts)) {
    return { ok: false, unscanned: true, error: 'worktree ps 没有 result.worktrees，没查成' };
  }
  return { ok: true, unscanned: false, worktrees: wts };
}

function warnMaster(reason, extra = {}) {
  console.error(`[dao] 帅位定界区：${reason}`);
  return { ok: false, action: 'warn', reason, ...extra };
}

/**
 * 全量重写 master 卡定界区。前缀保留。没查成不写。
 * dryRun 只算不写。挂点在 dao.mjs / flow.mjs，本函数不自己找挂点。
 */
export function syncMasterTicketZone({ worktrees, selfRepo, pathHint, runOrca, dryRun } = {}) {
  if (!Array.isArray(worktrees)) {
    return warnMaster('worktrees 不是数组，没查成，不定界区', { unscanned: true });
  }
  const repo = selfRepo || inferSelfRepo(worktrees, { pathHint });
  const prefixes = [...new Set(worktrees.map(w => repoPrefixOf(w && (w.worktreeId || w.id))).filter(Boolean))];
  if (!repo && prefixes.length > 1) {
    return warnMaster('多仓盘面分不出本仓（无 selfRepo/pathHint），不定界区', {
      unscanned: true,
      prefixes,
    });
  }
  const collected = collectInFlightTickets(worktrees, repo);
  if (!collected.ok) {
    return warnMaster(collected.error, { unscanned: true, tickets: [] });
  }
  const master = findMasterWorktree(worktrees, repo);
  if (!master.ok) {
    return warnMaster(master.error, {
      unscanned: !!master.unscanned,
      tickets: collected.tickets,
      scanned: collected.scanned,
    });
  }
  if (dryRun) {
    return {
      ok: true,
      action: 'dry-run',
      worktreeId: master.worktreeId,
      tickets: collected.tickets,
      scanned: collected.scanned,
    };
  }
  if (typeof runOrca !== 'function') {
    return warnMaster('syncMasterTicketZone 没给 runOrca', {
      tickets: collected.tickets,
      worktreeId: master.worktreeId,
    });
  }
  const r = mutateWorktreeComment({
    worktreeId: master.worktreeId,
    runOrca,
    mutate: (comment) => {
      const { prefix } = parseTicketZone(comment);
      return formatTitle(prefix, collected.tickets);
    },
  });
  return { ...r, tickets: collected.tickets, scanned: collected.scanned };
}
