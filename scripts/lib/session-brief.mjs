// 会话开场简报（2026-09-08 用户拍板：任务清单对新会话不可见是读取面缺失，不再造第二本账）。
// 纯函数层：解析/判定不碰 IO，hook 与 dao-check 各自喂数据。
// 读取面与退出机制共用同一个字段（status / issues）——见 docs/README.md「联动退出」。

/** decisions/ 计划文档的 frontmatter（YAML-lite：只认 status 与 issues 两个键，容错不抛）。 */
export function parseFrontmatter(text) {
  const t = String(text || '');
  if (!t.startsWith('---')) return null;
  const end = t.indexOf('\n---', 3);
  if (end < 0) return null;
  const head = t.slice(3, end);
  const out = {};
  const st = head.match(/^status:\s*([\w-]+)\s*(?:#.*)?$/m);
  if (st) out.status = st[1];
  const is = head.match(/^issues:\s*\[([^\]]*)\]/m);
  if (is) {
    out.issues = is[1].split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  }
  return (out.status || out.issues) ? out : null;
}

/** 西瓜清单 active 条目 → 开场念的行（一条一行，WIP 上限本身 ≤3，不再截断）。 */
export function initiativeLines(doc) {
  const list = Array.isArray(doc && doc.initiatives) ? doc.initiatives : [];
  return list
    .filter((i) => i && i.status === 'active')
    .map((i) => {
      const asOf = String(i.next_action_as_of || '').trim();
      const next = String(i.next_action || '').trim() || '（没写下一步——本条清单答不出「现在干什么」）';
      return `[清单] ${i.name}：${next}${asOf ? `（${asOf} 写）` : ''}`;
    });
}

/** 进行中的计划文档 → 开场念的行。entries: [{ file, fm }]。 */
export function planDocLines(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.fm && e.fm.status === 'in-progress')
    .map((e) => `[计划] ${e.file} 未收口${e.fm.issues && e.fm.issues.length ? `（挂 #${e.fm.issues.join(' #')}）` : ''}`);
}

/**
 * 把 decisions/*.md 的读结果收成闸/简报输入。
 * 单文件读失败必须标 unscanned，不许当「没这份文件」——否则 in-progress 计划读不出
 * 会从退场闸和开场简报同时消失，闸把「没扫到」当零目标放行。
 * results: [{ file, ok, text?, error? }]
 */
export function ingestPlanDocs(results) {
  const list = Array.isArray(results) ? results : [];
  const entries = [];
  const unread = [];
  for (const r of list) {
    if (!r || r.ok !== true) {
      unread.push({ file: (r && r.file) || '?', error: (r && r.error) || '读失败' });
      continue;
    }
    entries.push({ file: r.file, fm: parseFrontmatter(r.text) });
  }
  if (unread.length) {
    return {
      unscanned: true,
      error: `有 ${unread.length} 个计划文档没读成：${unread.map((u) => u.file).join('、')}`,
      entries,
      unread,
    };
  }
  return { unscanned: false, entries, unread: [] };
}

/** 开场简报：读失败的计划文档打「没查成」，不许静默。 */
export function unreadPlanLines(ingested) {
  if (!ingested || !ingested.unscanned) return [];
  return [`[清单] 计划文档没查成：${ingested.error}（≠ 没有进行中的计划）`];
}

/** 从正文抽 #单号，去重保序。只认 #123，不认没井号的数字。 */
export function issueRefsInText(text) {
  const found = [];
  const re = /#(\d+)/g;
  const s = String(text || '');
  let m;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0 && !found.includes(n)) found.push(n);
  }
  return found;
}

function uniquePosInts(nums) {
  const found = [];
  for (const raw of nums) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && !found.includes(n)) found.push(n);
  }
  return found;
}

/**
 * 西瓜条目的退场挂钩：`issues` 字段 ∪ `done_when` 里的 #单号。
 * 2026-09-16 实咬：scale-dozens 的 issues 只挂了已关前置单，统领 #1174 写在 done_when 里，
 * live 闸把仍在推的目标误报 stale。done_when 是完成判据，里面点名的单不得被漏挂。
 */
export function hookedIssues(initiative) {
  const listed = Array.isArray(initiative && initiative.issues) ? initiative.issues : [];
  return uniquePosInts([...listed, ...issueRefsInText(initiative && initiative.done_when)]);
}

/**
 * 清单退场闸（联动退出）的挂钩对象：active 西瓜 + in-progress 计划文档里带 issues 的。
 * 西瓜挂钩含 issues 字段和 done_when 里的 #单号；两者都空的不进闸（退出走各自 done_when / 人工）。
 * 闸只咬「单全关了还赖着」——漏挂统领单不得把仍在推的目标误报该收摊。
 */
export function collectExitTargets({ initiativesDoc = null, planDocs = [] } = {}) {
  const targets = [];
  const list = Array.isArray(initiativesDoc && initiativesDoc.initiatives) ? initiativesDoc.initiatives : [];
  for (const i of list) {
    if (!i || i.status !== 'active') continue;
    const issues = hookedIssues(i);
    if (issues.length) targets.push({ kind: 'initiative', name: i.id || i.name, issues });
  }
  for (const e of (Array.isArray(planDocs) ? planDocs : [])) {
    if (e && e.fm && e.fm.status === 'in-progress' && Array.isArray(e.fm.issues) && e.fm.issues.length) {
      targets.push({ kind: 'plan', name: e.file, issues: e.fm.issues });
    }
  }
  return targets;
}

/**
 * 纯判官：states 是 { 单号 → 'OPEN'|'CLOSED' }。缺号 = 没查成（fail-close，判 unscanned 不判过）。
 * 返回 stale = 挂的单全关了却还标着 active/in-progress 的对象——该收摊（人工核 done_when 后一行 commit 翻状态）。
 */
export function judgeListExit({ targets = [], states = {} } = {}) {
  const missing = [];
  const stale = [];
  for (const t of targets) {
    const st = t.issues.map((n) => states[n]);
    if (st.some((s) => s !== 'OPEN' && s !== 'CLOSED')) { missing.push(t); continue; }
    if (st.every((s) => s === 'CLOSED')) stale.push(t);
  }
  if (missing.length) {
    return { ok: false, unscanned: true, stale: [], error: `有 ${missing.length} 个对象的挂钩单状态没查成：${missing.map((t) => t.name).join('、')}` };
  }
  return { ok: stale.length === 0, unscanned: false, stale };
}
