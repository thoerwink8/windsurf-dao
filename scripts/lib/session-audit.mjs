// scripts/lib/session-audit.mjs —— 审计闸纯函数：本轮有实质产出却零相关事件 ⇒ 判「漏记」
//
// ── 这是什么、为什么是「闸」不是「写口」（2026-09-04 用户拍板改向，issue #891）─────
// 原设计是 Stop hook **当写口**：每轮末写一条 `session.state`。已否，两条理由：
//   ① hook 只能事后读 transcript **猜**「我在干什么」，写出来必然是浅的；
//   ② 每轮都写会产生无谓事件，再用 digest 去重掩盖「本来就不该写」——那是反的。
// ⇒ 分工改成：**写内容归 agent 主动写**（挂在已有动作上，相位真变了才写），
//   **防漏记归本文件**。本文件不产内容，只回答一个问题：「这一轮有东西落地了，账上有吗？」
//
// ── 判据全部来自可查事实，零正则猜说话方式 ──────────────────────────────────
// `git show 286c9b3` 砍掉的四支（RECALL/SCAFFOLD/CLOSING/READY）都是**靠正则猜用户说话
// 方式**的概率层软提醒，留下的心跳是确定性触发。本文件属后者：输入只有 git 落地事实
// （commit sha / PR 号 / 改动文件名）与账本目录里真实存在的事件，**没有一条判据看用户说了什么**。
//
// ── 静默是常态（这条是设计目标，不是副作用）─────────────────────────────────
// 无产出、或有产出且账上有事件 ⇒ **零输出、零写入**。
// 一个天天说话的审计闸会被训练成背景噪音，那正是上面那四支的死法。
//
// ── 三态分得开：不许把「没查成」记成「查过没事」──────────────────────────────
// 账本读不成（目录不在 / 有文件不是 JSON）⇒ `verdict:'unscanned'`，**既不判红也不判绿**。
// 采集腿没查成（如 `gh pr list` 超时）由调用方填 `produced.unscanned`，本文件把它带进
// `why` 并**只让它减少产出、绝不把红变绿**（少看见一条产出 ⇒ 顶多漏报；把没查成算成
// 「没有产出」再判绿 ⇒ 谎报，方向不能反）。
//
// ── 幂等 / 不刷屏：一批产出只报一次警、只提示一次 ───────────────────────────
// 判红那轮写一条 `audit.bypass`（类型 schema 里已有，字段 detail + evidence，不新造类型）。
// 之后同一批产出仍未补记时**不重复写**：已有 audit.bypass 的 evidence 覆盖了当前这批
// ⇒ `verdict:'remind'`，只打一句提示；提示过的 event_id 由调用方回填 `reminded`，
// 再之后彻底静默。**自己写的 audit.* 事件不算「相关事件」**——否则闸的报警会被自己当成
// 「账上有了」，一次之后永久失声。

/** 哪些算「实质产出」。默认只认硬产出——见 TIERS 那段注释。 */
export const DEFAULT_TIERS = ['commit', 'pr'];

// ── TIERS：为什么默认不含 'dirty'（工作树改动）────────────────────────────────
// 工作树有改动 = **活干到一半**，那是常态，不是「产出落地」。把它算成红，等于每个编辑
// 会话的第一轮就报警，而那一刻本来就还没到写事件的时候（事件挂在 commit / PR 那些
// **已有动作**上）。判据一旦开始大量误报，读的人就开始忽略它 ⇒ 又一支背景噪音。
// ⇒ 'dirty' 做成可开的第三档（`tiers: ['commit','pr','dirty']`），默认关；
//   关着时它不参与判红，但**照样进 `why`** 当上下文（人能看见「树是脏的」这个事实）。

/** 产出项 → 稳定的 evidence 键。审计闸的去重与复查都认这个键。 */
export function produceKeys(produced, tiers = DEFAULT_TIERS) {
  const keys = [];
  const p = produced || {};
  if (tiers.includes('commit')) {
    for (const c of p.commits || []) {
      const sha = String((c && c.sha) || '').trim();
      if (sha) keys.push(`commit:${sha.slice(0, 7)}`);
    }
  }
  if (tiers.includes('pr')) {
    for (const r of p.prs || []) {
      const n = Number(r && r.number);
      if (Number.isInteger(n) && n > 0) keys.push(`pr:#${n}`);
    }
  }
  if (tiers.includes('dirty')) {
    for (const f of p.dirty || []) {
      const s = String(f || '').trim();
      if (s) keys.push(`file:${s}`);
    }
  }
  return [...new Set(keys)];
}

/** 事件是不是「本轮的相关事件」：窗内 + 不是 audit.*（自己的报警不算账上有了）。 */
function isRelevant(event, since) {
  if (!event || typeof event !== 'object') return false;
  const type = String(event.type || '');
  if (!type || type.startsWith('audit.')) return false;
  const ts = String(event.ts || '');
  if (!ts) return false;
  // 字符串比不了带不同时区的 ISO ⇒ 一律转毫秒再比。转不出来的当窗外（宁漏报不谎报）。
  const t = Date.parse(ts);
  const s = Date.parse(since);
  if (!Number.isFinite(t) || !Number.isFinite(s)) return false;
  return t >= s;
}

/** 已有的 audit.bypass 里，evidence 覆盖了 keys 全集的那些（返回它们的 event_id）。 */
function coveringBypasses(events, keys) {
  const out = [];
  for (const e of events) {
    if (!e || e.type !== 'audit.bypass') continue;
    const ev = Array.isArray(e.evidence) ? e.evidence.map(String) : [];
    if (keys.length && keys.every(k => ev.includes(k))) out.push(String(e.event_id || ''));
  }
  return out.filter(Boolean);
}

/**
 * 审计闸。纯函数：不读盘、不跑 git、不写事件——采集与写入都在调用方。
 *
 * @param {object}   arg
 * @param {object}   arg.produced  采集到的产出 { commits:[{sha,ts,subject}], prs:[{number,ts,title}],
 *                                 dirty:[相对路径], unscanned:[没查成的腿名] }
 * @param {object[]|{unscanned:true,error:string}} arg.events 账本事件（或「没读成」）
 * @param {string}   arg.since     本轮起点 ISO8601
 * @param {string[]} [arg.reminded] 已经提示过的 audit.bypass event_id
 * @param {string[]} [arg.tiers]   哪些算实质产出，默认 DEFAULT_TIERS
 * @returns {{verdict:'unscanned'|'silent'|'missing'|'remind', missing:string[], why:string,
 *            remindFor:string[], detail:string|null}}
 *   verdict: unscanned=没查成（不判红也不判绿）/ silent=静默 / missing=漏记，调用方写 audit.bypass
 *            / remind=已报过警且还没补记，调用方只打一句提示
 */
export function auditTurn({ produced, events, since, reminded = [], tiers = DEFAULT_TIERS } = {}) {
  const nil = { missing: [], remindFor: [], detail: null };

  if (!since || !Number.isFinite(Date.parse(since))) {
    return { verdict: 'unscanned', ...nil, why: `本轮起点无法确定（since=${JSON.stringify(since)}）⇒ 没查成，不判` };
  }
  // 账本没读成 ⇒ 三态里的第三态。这里判绿就是把「没查成」记成「查过没事」。
  if (!Array.isArray(events)) {
    const err = (events && events.error) || '账本事件不是数组';
    return { verdict: 'unscanned', ...nil, why: `账本没读成（${String(err).slice(0, 120)}）⇒ 不判红也不判绿` };
  }

  const keys = produceKeys(produced, tiers);
  const unscannedLegs = (produced && produced.unscanned) || [];
  const legNote = unscannedLegs.length ? `；采集没查成的腿：${unscannedLegs.join('/')}（只会漏报，不会把红变绿）` : '';

  if (keys.length === 0) {
    const dirtyN = ((produced && produced.dirty) || []).length;
    const ctx = !tiers.includes('dirty') && dirtyN ? `（工作树 ${dirtyN} 个文件有改动，但活干到一半不算产出落地）` : '';
    return { verdict: 'silent', ...nil, why: `本轮无实质产出${ctx}${legNote}` };
  }

  const relevant = events.filter(e => isRelevant(e, since));
  if (relevant.length > 0) {
    return {
      verdict: 'silent', ...nil,
      why: `本轮 ${keys.length} 项产出、窗内 ${relevant.length} 条相关事件（${[...new Set(relevant.map(e => e.type))].join('/')}）⇒ 账上有${legNote}`,
    };
  }

  // 到这里：有产出、窗内零相关事件 = 漏记。剩下的只是「报过没有」。
  const covered = coveringBypasses(events, keys);
  const fresh = covered.filter(id => !reminded.includes(id));
  if (covered.length > 0) {
    if (fresh.length === 0) {
      return { verdict: 'silent', ...nil, why: `${keys.length} 项产出仍未补记，但已报警且已提示过 ⇒ 不再刷屏（audit.bypass ${covered.join(',')}）` };
    }
    return {
      verdict: 'remind', missing: keys, remindFor: fresh, detail: null,
      why: `上一轮已判漏记并写了 audit.bypass ${fresh.join(',')}，产出仍未补记 ⇒ 提示一次`,
    };
  }

  return {
    verdict: 'missing', missing: keys, remindFor: [],
    detail: `本轮有实质产出（${keys.join(' ')}）却零相关事件 ⇒ 漏记`,
    why: `本轮 ${keys.length} 项产出、窗内 0 条相关事件、无既有 audit.bypass 覆盖 ⇒ 判漏记${legNote}`,
  };
}

/** 下一轮那句提示。一句话、不刷屏——调用方原样写 stdout。 */
export function remindLine(result) {
  const items = (result && result.missing) || [];
  if (!items.length) return '';
  return `[审计] 上一轮有产出无事件，补记 ${items.join(' ')}（写事件：node scripts/event-write.mjs --type <类型> --ts <ISO>）`;
}
