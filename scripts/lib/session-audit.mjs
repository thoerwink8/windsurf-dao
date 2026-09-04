// scripts/lib/session-audit.mjs —— 审计闸纯函数：本轮有实质产出却没有**指向它**的事件 ⇒ 判「漏记」
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
// ── 「相关」= 逐项指向，不是「窗内有任意一条事件」（PR #894 审官 P1）──────────
// 首版判据是「窗内有任意一条非 audit.* 事件 ⇒ 放行」。那是错的：一条与本批产出毫无关系的
// `incident`（甚至本轮提交**之前**就写好的事件）就能把「有 commit 没有对应事件」盖掉，
// 而那恰好是本闸唯一要抓的东西。实咬：喂一条无关 `incident` ⇒ `verdict:"silent"`。
// 现在改成**逐项覆盖**：每一项产出都必须有一条窗内事件**指向它自己**才算记上了——
//   · 事件正文里出现该 commit 的 sha（7 位前缀即可，evidence 与 git 短 sha 都是这个形状）
//   · PR：`pr_number` / `issue` / `issue_number` 命中，或正文里出现 `#<号>`
//   · 文件：正文里出现该相对路径
//   · 或者事件带 `session_id` 且等于当前会话 —— 给 agent 侧写的会话级事件留的正门
// 覆盖不全时，**只有没被指向的那几项**进 missing（不是整批），报警的 evidence 因此可复查。
//
// ── 静默是常态（这条是设计目标，不是副作用）─────────────────────────────────
// 无产出、或产出都被指向了 ⇒ **零输出、零写入**。
// 一个天天说话的审计闸会被训练成背景噪音，那正是上面那四支的死法。
//
// ── 三态分得开：不许把「没查成」记成「查过没事」──────────────────────────────
// 账本读不成（目录不在 / 有文件不是 JSON）⇒ `verdict:'unscanned'`，**既不判红也不判绿**。
// 采集腿没查成（如 `gh pr list` 超时）由调用方填 `produced.unscanned`，本文件把它带进
// `why` 并**只让它减少产出、绝不把红变绿**（少看见一条产出 ⇒ 顶多漏报；把没查成算成
// 「没有产出」再判绿 ⇒ 谎报，方向不能反）。
//
// ── 产出必须落在窗口内（PR #894 审官 P2）────────────────────────────────────
// 带时间戳的产出（commit 的 `ts`、PR 的 `updatedAt`）一律按 `since` 过滤**在本文件里**再算键。
// 首版只在采集侧过滤 commit，PR 完全不看时间 ⇒ 一个很久以前仍 open 的 PR 每轮 Stop 都被
// 当成「本轮产出」，制造错误的 audit.bypass。过滤放在纯函数里而不是只放采集侧：判断要可测，
// 且采集侧将来换实现（换 gh 命令 / 换缓存）不该把这条判据带走。
//
// ── 幂等 / 不刷屏 / 未补记的产出要跨轮记住（PR #894 审官 P1）──────────────────
// 判红那轮写一条 `audit.bypass`（类型 schema 里已有，字段 detail + evidence，不新造类型）。
// **但产出只在它落地的那一轮出现在窗口里**：首版把 `since` 无条件推到 now，下一轮
// `git log` 已看不见那个 commit ⇒ 设计中的 `remind` 永远不会发生（实咬：真 hook 连跑三轮，
// 后两轮 stdout 全空）。修法是把没被指向的产出键**存进状态跨轮带着走**（调用方传 `carry`、
// 拿 `pending` 回存），于是：
//   轮 1 判红写事件（不打印）→ 轮 2 提示一句 → 轮 3 起彻底静默 → 有事件指向它了就清掉。
// **自己写的 audit.* 事件永不算「账上有了」**——否则闸的报警会被自己当成覆盖，一次之后永久失声。

/** 哪些算「实质产出」。默认只认硬产出——见 TIERS 那段注释。 */
export const DEFAULT_TIERS = ['commit', 'pr'];
/** pending 上限：没补记的产出跨轮带着走，但不许无限堆积（老的先掉）。 */
export const MAX_PENDING = 20;

// ── TIERS：为什么默认不含 'dirty'（工作树改动）────────────────────────────────
// 工作树有改动 = **活干到一半**，那是常态，不是「产出落地」。把它算成红，等于每个编辑
// 会话的第一轮就报警，而那一刻本来就还没到写事件的时候（事件挂在 commit / PR 那些
// **已有动作**上）。判据一旦开始大量误报，读的人就开始忽略它 ⇒ 又一支背景噪音。
// ⇒ 'dirty' 做成可开的第三档（`tiers: ['commit','pr','dirty']`），默认关；
//   关着时它不参与判红，但**照样进 `why`** 当上下文（人能看见「树是脏的」这个事实）。

function ms(v) {
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? t : null;
}

/** 带 ts 的产出项是否落在窗口内。**没有 ts 的项一律算在内**（如工作树文件，本来就是「现在」）。 */
function inWindow(ts, sinceMs) {
  if (ts === undefined || ts === null || ts === '') return true;
  const t = ms(ts);
  if (t === null) return true; // 时间解析不出来 ⇒ 不因此放行（宁多报不漏报）
  return t >= sinceMs;
}

/** 产出项 → 稳定的 evidence 键。审计闸的去重与复查都认这个键。 */
export function produceKeys(produced, tiers = DEFAULT_TIERS, since = null) {
  const keys = [];
  const p = produced || {};
  const sinceMs = since === null ? null : ms(since);
  const ok = ts => (sinceMs === null ? true : inWindow(ts, sinceMs));
  if (tiers.includes('commit')) {
    for (const c of p.commits || []) {
      const sha = String((c && c.sha) || '').trim();
      if (sha && ok(c && c.ts)) keys.push(`commit:${sha.slice(0, 7)}`);
    }
  }
  if (tiers.includes('pr')) {
    for (const r of p.prs || []) {
      const n = Number(r && r.number);
      // PR 的时间字段两种叫法都认：采集侧给 ts，`gh pr list --json` 原样给 updatedAt。
      if (Number.isInteger(n) && n > 0 && ok((r && r.ts) ?? (r && r.updatedAt))) keys.push(`pr:#${n}`);
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

/** 事件是不是「本轮的候选事件」：窗内 + 不是 audit.*（自己的报警不算账上有了）。 */
function isCandidate(event, sinceMs) {
  if (!event || typeof event !== 'object') return false;
  const type = String(event.type || '');
  if (!type || type.startsWith('audit.')) return false;
  const t = ms(event.ts);
  if (t === null) return false; // 没时间的事件不给任何产出背书
  return t >= sinceMs;
}

/**
 * 这条事件是否**指向**这一项产出。逐项覆盖的判据本体（审官 P1）。
 * 正文匹配用 JSON 序列化后的整条事件：字段名将来怎么变都不影响——只要 sha / PR 号
 * 真的写在事件里某处，就算记上了。反过来，无关事件里不会凭空出现别人的 sha。
 */
function eventCovers(event, key, sessionId) {
  // 会话级正门：agent 侧写的事件带上 session_id，即为本会话的产出背书。
  if (sessionId && String(event.session_id || '') === String(sessionId)) return true;
  const body = JSON.stringify(event);
  if (key.startsWith('commit:')) {
    const sha = key.slice('commit:'.length);
    return sha.length >= 7 && body.includes(sha);
  }
  if (key.startsWith('pr:#')) {
    const n = Number(key.slice('pr:#'.length));
    for (const f of ['pr_number', 'issue', 'issue_number']) {
      if (Number(event[f]) === n) return true;
    }
    return body.includes(`#${n}`);
  }
  if (key.startsWith('file:')) return body.includes(key.slice('file:'.length));
  return false;
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
 * @param {object}   arg.produced  采集到的产出 { commits:[{sha,ts,subject}], prs:[{number,updatedAt,title}],
 *                                 dirty:[相对路径], unscanned:[没查成的腿名] }
 * @param {object[]|{unscanned:true,error:string}} arg.events 账本事件（或「没读成」）
 * @param {string}   arg.since     本轮起点 ISO8601
 * @param {string[]} [arg.carry]   上几轮判过漏记、至今仍没被事件指向的产出键（跨轮带着走）
 * @param {string[]} [arg.reminded] 已经提示过的 audit.bypass event_id
 * @param {string}   [arg.sessionId] 当前会话 id（事件带同一个 session_id 即算指向本会话产出）
 * @param {string[]} [arg.tiers]   哪些算实质产出，默认 DEFAULT_TIERS
 * @returns {{verdict:'unscanned'|'silent'|'missing'|'remind', missing:string[], why:string,
 *            remindFor:string[], detail:string|null, pending:string[]}}
 *   verdict: unscanned=没查成（不判红也不判绿）/ silent=静默 / missing=漏记，调用方写 audit.bypass
 *            / remind=已报过警且还没补记，调用方只打一句提示
 *   pending: 仍没被任何事件指向的产出键，调用方原样回存进状态，下一轮当 carry 传回来
 */
export function auditTurn({
  produced, events, since, carry = [], reminded = [], sessionId = null, tiers = DEFAULT_TIERS,
} = {}) {
  const nil = { missing: [], remindFor: [], detail: null };
  const keepCarry = [...new Set((carry || []).map(String))].slice(-MAX_PENDING);

  const sinceMs = ms(since);
  if (sinceMs === null) {
    return {
      verdict: 'unscanned', ...nil, pending: keepCarry,
      why: `本轮起点无法确定（since=${JSON.stringify(since)}）⇒ 没查成，不判`,
    };
  }
  // 账本没读成 ⇒ 三态里的第三态。这里判绿就是把「没查成」记成「查过没事」。
  // pending 原样带走：没读成不等于补记了。
  if (!Array.isArray(events)) {
    const err = (events && events.error) || '账本事件不是数组';
    return {
      verdict: 'unscanned', ...nil, pending: keepCarry,
      why: `账本没读成（${String(err).slice(0, 120)}）⇒ 不判红也不判绿`,
    };
  }

  const fresh = produceKeys(produced, tiers, since);
  // 本轮新落地的 + 之前判过漏记还没补的。顺序：老的在前，超上限时老的先掉。
  const keys = [...new Set([...keepCarry, ...fresh])].slice(-MAX_PENDING);
  const unscannedLegs = (produced && produced.unscanned) || [];
  const legNote = unscannedLegs.length ? `；采集没查成的腿：${unscannedLegs.join('/')}（只会漏报，不会把红变绿）` : '';

  if (keys.length === 0) {
    const dirtyN = ((produced && produced.dirty) || []).length;
    const ctx = !tiers.includes('dirty') && dirtyN ? `（工作树 ${dirtyN} 个文件有改动，但活干到一半不算产出落地）` : '';
    return { verdict: 'silent', ...nil, pending: [], why: `本轮无实质产出${ctx}${legNote}` };
  }

  // 逐项覆盖：每一项产出都要有一条窗内事件**指向它自己**。
  const candidates = events.filter(e => isCandidate(e, sinceMs));
  const uncovered = keys.filter(k => !candidates.some(e => eventCovers(e, k, sessionId)));

  if (uncovered.length === 0) {
    return {
      verdict: 'silent', ...nil, pending: [],
      why: `${keys.length} 项产出全部有事件指向（窗内 ${candidates.length} 条候选）⇒ 账上有${legNote}`,
    };
  }

  // 到这里：有产出没被指向 = 漏记。剩下的只是「报过没有」。
  const covered = coveringBypasses(events, uncovered);
  const notYet = covered.filter(id => !reminded.includes(id));
  if (covered.length > 0) {
    if (notYet.length === 0) {
      return {
        verdict: 'silent', ...nil, pending: uncovered,
        why: `${uncovered.length} 项产出仍未补记，但已报警且已提示过 ⇒ 不再刷屏（audit.bypass ${covered.join(',')}）`,
      };
    }
    return {
      verdict: 'remind', missing: uncovered, remindFor: notYet, detail: null, pending: uncovered,
      why: `上一轮已判漏记并写了 audit.bypass ${notYet.join(',')}，产出仍未补记 ⇒ 提示一次`,
    };
  }

  return {
    verdict: 'missing', missing: uncovered, remindFor: [], pending: uncovered,
    detail: `本轮有实质产出（${uncovered.join(' ')}）却没有指向它的事件 ⇒ 漏记`,
    why: `${keys.length} 项产出、${uncovered.length} 项没有事件指向（窗内 ${candidates.length} 条候选）、`
      + `无既有 audit.bypass 覆盖 ⇒ 判漏记${legNote}`,
  };
}

/** 下一轮那句提示。一句话、不刷屏——调用方原样写 stdout。 */
export function remindLine(result) {
  const items = (result && result.missing) || [];
  if (!items.length) return '';
  return `[审计] 上一轮有产出无事件，补记 ${items.join(' ')}（写事件：node scripts/event-write.mjs --type <类型> --ts <ISO>）`;
}
