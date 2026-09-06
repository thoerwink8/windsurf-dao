// scripts/lib/progress-detect.mjs —— 盘面推进量判据（chain:progress-stall#0）
//
// 发现层：连续 N 轮同一对象同一状态 ⇒ 卡住，不管日志多漂亮。
// shuai-watchdog 链的发现层被本单替换；执行层（换人）不动。
//
// 2026-09-06 用户拍板：屏面指纹那一整层（agent-stall-watch）退役，本文件成为
// 卡死发现的唯一判据。同时删掉树面——它的采样源是已退役的 orca，留着只会让
// 每一轮都判「没查成」。判据全部落在 GitHub 面（PR / issue / 复审票），这也是
// 行业做法（超时判死，不猜执行体在干什么）。
//
// 树面没了之后，「已消歧的 issue 是否已派出」只按 PR 判。前提是编排态下工人
// 开工即建 draft PR（dispatch skill 硬规矩）——那条规矩没了，这里会误报。
//
// 纯函数：吃一串快照，吐停滞判决。一个 IO 都不碰。
// 「没查成」和「没停滞」必须不同形——读不清就说没查成，不许当成没事。

export const DEFAULT_MIN_ROUNDS = 5;
export const DISAMBIGUATED_LABEL = '已消歧';

const JUDGED = new Set(['APPROVED', 'CHANGES_REQUESTED', 'APPROVE', 'REQUEST_CHANGES']);

function asList(v) {
  return Array.isArray(v) ? v : null;
}

function labelNames(labels) {
  if (!Array.isArray(labels)) return null;
  return labels.map((l) => (typeof l === 'string' ? l : (l && l.name) || '')).filter(Boolean);
}

function normDecision(v) {
  return String(v || '').toUpperCase().replace(/\s+/g, '_');
}

function shortOid(oid) {
  const s = String(oid || '');
  return s.length > 12 ? s.slice(0, 12) : s;
}

function prJudged(snapshot, number) {
  const prs = asList(snapshot?.github?.prs) || [];
  const pr = prs.find((p) => Number(p && p.number) === Number(number));
  const rd = normDecision(pr && pr.reviewDecision);
  if (JUDGED.has(rd)) return true;
  const byPr = snapshot?.prReviews?.byPr;
  if (!byPr || typeof byPr !== 'object') return false;
  const rec = byPr[String(number)] || byPr[number];
  if (!rec || typeof rec !== 'object') return false;
  if (rec.judged === true) return true;
  if (rec.judged === false) return false;
  const reviews = asList(rec.reviews);
  if (!reviews) return false;
  return reviews.some((r) => JUDGED.has(normDecision(r && r.state)));
}

function ticketHead(item) {
  const head = item && item.head;
  if (head == null) return '';
  if (typeof head === 'string') return head;
  if (typeof head === 'object') return String(head.oid || head.name || '');
  return String(head);
}

function issueHasInflight(number, { prs }) {
  const n = Number(number);
  if (!Number.isFinite(n)) return false;
  const needle = new RegExp(`(?:^|[^0-9])#${n}(?:[^0-9]|$)`);
  for (const p of prs) {
    const title = String((p && p.title) || '');
    const body = String((p && p.body) || '');
    if (needle.test(title) || needle.test(body.slice(0, 400))) return true;
  }
  return false;
}

/**
 * 一份快照抽出逐对象签名。任一关键段没查成 → unscanned。
 * 对象：开放 PR / 已消歧且未派出的 issue / 复审票。
 * 快照的 orca 段**故意不读**：它是已退役执行体的采样面，读了就是每轮没查成。
 */
export function extractObjects(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { scanned: false, error: '快照不是对象（没查成）', objects: [], idle: false };
  }
  const github = snapshot.github;
  const rp = snapshot.reviewPending;
  if (!github || github.scanned !== true) {
    return { scanned: false, error: String((github && github.error) || 'github 段没查成'), objects: [], idle: false };
  }
  if (!rp || rp.scanned !== true) {
    return { scanned: false, error: String((rp && rp.error) || 'reviewPending 段没查成'), objects: [], idle: false };
  }
  const prs = asList(github.prs);
  const issues = asList(github.issues);
  const tickets = asList(rp.items);
  if (!prs) return { scanned: false, error: 'github.prs 不是数组（没查成）', objects: [], idle: false };
  if (!issues) return { scanned: false, error: 'github.issues 不是数组（没查成）', objects: [], idle: false };
  if (!tickets) return { scanned: false, error: 'reviewPending.items 不是数组（没查成）', objects: [], idle: false };
  // #1055：orca 运行时已退役，这一段不再是必查节。没扫到 / 扫失败 = 没有 orca 工人树，不是没查成。
  // 仍扫到且 scanned 时，worktrees 必须是数组——形状不对才是没查成。
  let worktrees = [];
  if (orca && orca.scanned === true) {
    worktrees = asList(orca.worktrees);
    if (!worktrees) return { scanned: false, error: 'orca.worktrees 不是数组（没查成）', objects: [], idle: false };
  }

  const prReviews = snapshot.prReviews;
  if (prReviews && typeof prReviews === 'object' && 'scanned' in prReviews && prReviews.scanned !== true) {
    return { scanned: false, error: String(prReviews.error || 'prReviews 段没查成'), objects: [], idle: false };
  }

  const objects = [];
  for (const p of prs) {
    if (!p || p.number == null) continue;
    const judged = prJudged(snapshot, p.number);
    const head = String(p.headRefOid || p.head || '');
    const mergeable = String(p.mergeable || '');
    const draft = p.isDraft ? '1' : '0';
    objects.push({
      kind: 'pr',
      id: String(p.number),
      key: `pr:${p.number}`,
      sig: `${head}|${mergeable}|${draft}|${judged ? '1' : '0'}`,
      number: Number(p.number),
      headOid: head,
      mergeable,
      isDraft: !!p.isDraft,
      judged,
    });
  }

  for (const t of tickets) {
    if (!t || t.pr == null) continue;
    const head = ticketHead(t);
    objects.push({
      kind: 'ticket',
      id: `${t.pr}@${head}`,
      key: `ticket:${t.pr}@${head}`,
      sig: 'queued',
      pr: Number(t.pr),
      headOid: head,
    });
  }

  for (const it of issues) {
    if (!it || it.number == null) continue;
    const names = labelNames(it.labels);
    if (names == null) {
      return { scanned: false, error: `issue #${it.number} 的 label 不是数组（没查成）`, objects: [], idle: false };
    }
    if (!names.includes(DISAMBIGUATED_LABEL)) continue;
    if (issueHasInflight(it.number, { prs })) continue;
    objects.push({
      kind: 'issue',
      id: String(it.number),
      key: `issue:${it.number}`,
      sig: 'idle',
      number: Number(it.number),
    });
  }

  objects.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return { scanned: true, error: null, objects, idle: objects.length === 0 };
}

export function serializeObjects(objects) {
  const list = Array.isArray(objects) ? objects : [];
  return list.map((o) => `${o.key}=${o.sig}`).join('\n');
}

export function stallFingerprint(objects, rounds) {
  const body = serializeObjects(objects);
  return `rounds:${Number(rounds) || 0}\n${body}`;
}

export function formatStallItem(item, rounds) {
  const n = Number(rounds) || 0;
  if (!item) return `不明对象连续 ${n} 轮没动`;
  if (item.kind === 'pr') {
    const bits = [];
    if (item.headOid) bits.push(`head ${shortOid(item.headOid)}`);
    if (item.mergeable) bits.push(item.mergeable === 'CONFLICTING' ? '合不上' : item.mergeable);
    bits.push(item.judged ? '有审官判定' : '无审官判定');
    if (item.isDraft) bits.push('草稿');
    return `PR #${item.id} 连续 ${n} 轮没动（${bits.join('、')}）`;
  }
  if (item.kind === 'issue') {
    return `#${item.id} 已消歧但连续 ${n} 轮没派出工人、也没有在途 PR`;
  }
  if (item.kind === 'ticket') {
    return `复审票 PR #${item.pr}@${shortOid(item.headOid)} 连续 ${n} 轮还在队列`;
  }
  return `${item.key || '对象'} 连续 ${n} 轮没动`;
}

/**
 * 吃一串快照，吐停滞判决。
 * 粒度是逐对象签名，不是整盘、也不是聚合计数：对象 A 停、对象 B 动 ⇒ 只报 A。
 * 票 1↔0 抖动不得把仍冻结的 PR 藏掉。
 * 误报闸：全空闲（0 PR / 0 已消歧 / 0 票）不算停滞。
 */
export function detectProgressStall(snapshots, { minRounds = DEFAULT_MIN_ROUNDS } = {}) {
  if (!Array.isArray(snapshots)) {
    return {
      scanned: false,
      stalled: false,
      error: '快照不是数组（没查成）',
      items: [],
      rounds: 0,
      fingerprint: null,
      reason: 'unscanned',
    };
  }
  const n = Number(minRounds);
  const need = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MIN_ROUNDS;
  if (snapshots.length < need) {
    return {
      scanned: true,
      stalled: false,
      error: null,
      items: [],
      rounds: snapshots.length,
      fingerprint: null,
      reason: snapshots.length === 0 ? 'empty' : 'not-enough-rounds',
    };
  }
  const window = snapshots.slice(-need);
  const extracted = [];
  for (let i = 0; i < window.length; i++) {
    const got = extractObjects(window[i]);
    if (got.scanned !== true) {
      return {
        scanned: false,
        stalled: false,
        error: `第 ${i + 1}/${need} 份${got.error ? '：' + got.error : ''}（没查成）`,
        items: [],
        rounds: 0,
        fingerprint: null,
        reason: 'unscanned',
      };
    }
    extracted.push(got);
  }
  if (extracted.every((e) => e.idle)) {
    return {
      scanned: true,
      stalled: false,
      error: null,
      items: [],
      rounds: need,
      fingerprint: null,
      reason: 'idle',
    };
  }
  // 逐对象独立数连续相同 sig 的轮次。整盘签名变了也要继续看：旁边有推进不能把冻着的对象藏掉。
  const frozen = new Map();
  for (const o of extracted[0].objects) {
    frozen.set(o.key, o);
  }
  for (let i = 1; i < extracted.length; i++) {
    const now = new Map(extracted[i].objects.map((o) => [o.key, o]));
    for (const [key, prev] of frozen) {
      const cur = now.get(key);
      if (!cur || cur.sig !== prev.sig) frozen.delete(key);
    }
  }
  const items = [...frozen.values()].map((o) => ({ ...o, why: formatStallItem(o, need) }));
  if (!items.length) {
    return {
      scanned: true,
      stalled: false,
      error: null,
      items: [],
      rounds: need,
      fingerprint: null,
      reason: 'progress',
    };
  }
  return {
    scanned: true,
    stalled: true,
    error: null,
    items,
    rounds: need,
    fingerprint: stallFingerprint(items, need),
    reason: 'stalled',
  };
}

/**
 * 推帅位去重：同一停滞指纹只推一次；指纹变了允许再推。
 * 账本键 = 指纹（哪个对象 + 停了几轮）。不走 escalate 开单。
 */
export function planWake({ fingerprint, prevFingerprint, stalled } = {}) {
  if (!stalled) return { wake: false, reason: 'no-stall', fingerprint: fingerprint || null };
  if (!fingerprint) return { wake: false, reason: 'no-fingerprint', fingerprint: null };
  if (fingerprint === prevFingerprint) return { wake: false, reason: 'same-fingerprint', fingerprint };
  return {
    wake: true,
    reason: prevFingerprint ? 'fingerprint-changed' : 'first',
    fingerprint,
  };
}
