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
// #966：挂「将来某版」的单不是当前待办——不进派工队列，也不当「已消歧但没派出」停滞。

import { isDeferredIssue } from './ready-queue-check.mjs';

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
    if (isDeferredIssue(it)) continue; // #966：将来某版不该派，不是没派
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

/**
 * 停滞播报的**去重键**——故意是常量，不带指纹。
 *
 * 2026-09-15 实咬：原来的键是 `progress-watch:${stallFingerprint(...)}`，而指纹
 * 就是「轮数 + 每个停滞对象的 key=sig」。于是停滞清单动一个号 = 新键 = 再发一条，
 * 播报账里攒出 **约 300 个 `progress-watch:rounds:5\npr:…` 键**，一周三百条
 * 「这些 PR 没动」——必然被人关掉。
 *
 * 另一头坏得正相反：`digest-stuck:${digest}` 的键是「这一套动作」，而停滞的定义
 * 恰恰是**这套动作一直不变** ⇒ 越是真停住，键越不变，越只发那一条。实测
 * 09-15 03:31 发过一条之后，盘面又冻了 10 小时，一条都没有。
 *
 * 两处同一个病：**去重键跟被报告的事实同构**。抖动的刷屏，真死的静默。
 *
 * 改法是把内容从键里拿掉，只留常量——剩下的节流交给 `HUB_DEDUP_MS`（6 小时）。
 * 净效果：盘面卡着就每 6 小时稳定响一声，卡多久响多久；清单怎么抖都不额外加条数。
 * 严重度不进键，进**文案**（见 stallSeverity），否则「越停越严重」又会变成新键刷屏。
 */
export const STALL_ALERT_KEY = 'progress-watch:stall';
/** 认输唤醒的去重键。跟停滞键分开：wake≠stalled，混用会互相挤占 6 小时窗口。 */
export const EXHAUSTED_WAKE_ALERT_KEY = 'progress-watch:exhausted';
export const DIGEST_STUCK_ALERT_KEY = 'digest-stuck';

function hasExhaustedSurface(pw) {
  if (pw.exhaustedWake === true) return true;
  if (Array.isArray(pw.exhaustedLines) && pw.exhaustedLines.length > 0) return true;
  if (typeof pw.exhaustedReport === 'string' && pw.exhaustedReport.trim()) return true;
  if (pw.exhausted && Number(pw.exhausted.pushed) > 0) return true;
  if (pw.wakeReason === 'exhausted') return true;
  // 历史形状：非停滞的 wake 就是认输推送（runProgressWatch 在没停时只会被认输行叫醒）
  return !!pw.wake && !pw.stalled;
}

function stallTextOf(pw) {
  const s = String(pw.stallReport || '').trim();
  if (s) return pw.stallReport;
  return pw.report;
}

function exhaustedTextOf(pw) {
  if (typeof pw.exhaustedReport === 'string' && pw.exhaustedReport.trim()) return pw.exhaustedReport;
  if (Array.isArray(pw.exhaustedLines) && pw.exhaustedLines.length) return pw.exhaustedLines.join('\n');
  const stall = String(pw.stallReport || '').trim();
  const report = String(pw.report || '');
  if (pw.stalled && stall && report.startsWith(stall)) {
    return report.slice(stall.length).replace(/^\n/, '');
  }
  return pw.report;
}

function withPrimary(surfaces) {
  const primary = surfaces[0] || { kind: 'ok', log: '', key: null, text: '' };
  return { ...primary, surfaces };
}

/**
 * 指挥官把 progress-watch 结果写成一行或多行日志 + 可选播报键。
 *
 * `wake` 不是「停滞」：认输 PR 推送会让 wake=true 而 stalled=false。
 * 两类必须独立分支、独立常量键——进同一个「盘面停滞」分支会把没停的盘面
 * 报成停滞；``progress-watch:${wakeReason}`` 也不是常量键。
 *
 * 同轮可以同时 stalled 和认输。必须返回两条 surface，让指挥官分别对
 * `STALL_ALERT_KEY` 与 `EXHAUSTED_WAKE_ALERT_KEY` 走 hubOnce；先判 stalled
 * 就 return 会把认输并进停滞文案，认输再也走不到自己的 6 小时窗口。
 *
 * 返回 `{ surfaces, ...primary }`。primary 是第一条，方便单面调用方；
 * 指挥官必须迭代 `surfaces`，不能只看 primary。
 */
export function planProgressWatchAlert(progressWatch) {
  const pw = progressWatch || {};
  if (pw.ok !== true) {
    return withPrimary([{
      kind: 'unscanned',
      log: `  盘面推进量没查成：${pw.error || pw.report || '未知'}`,
      key: null,
      text: pw.error || pw.report || '未知',
    }]);
  }
  const surfaces = [];
  if (pw.stalled) {
    const text = stallTextOf(pw);
    surfaces.push({
      kind: 'stalled',
      log: `  盘面停滞：${text}`,
      key: STALL_ALERT_KEY,
      text,
    });
  }
  if (hasExhaustedSurface(pw)) {
    const text = exhaustedTextOf(pw);
    surfaces.push({
      kind: 'exhausted-wake',
      log: `  认输唤醒：${text}`,
      key: EXHAUSTED_WAKE_ALERT_KEY,
      text,
    });
  }
  if (!surfaces.length) {
    surfaces.push({
      kind: 'ok',
      log: `  盘面推进量：${pw.report}`,
      key: null,
      text: pw.report || '',
    });
  }
  return withPrimary(surfaces);
}

/**
 * 停了多久 → 一个给人看的严重度词。只进文案，不进去重键。
 * 一轮 ≈ 20 分钟：阈值内「注意」，翻倍「警告」，四倍以上「故障」。
 *
 * **只能喂真实不封顶的轮数。** 别拿 `runProgressWatch` 的 `rounds` 喂它：
 * 那个值等于快照窗口长度（`readSnapshots(dir, {limit: minRounds})` 只取 5 份），
 * 停 100 轮它也还是 5，分档永远只能得出「注意」——那是个做不到的承诺
 * （#1285 审官当场用 100 份相同快照证伪）。
 * 当前唯一合格的输入是指挥官的 `state.digestStreak`：它逐轮累加，不封顶。
 */
export function stallSeverity(rounds, threshold) {
  const n = Number(rounds) || 0;
  const t = Number(threshold) > 0 ? Number(threshold) : 1;
  if (n >= t * 4) return '故障';
  if (n >= t * 2) return '警告';
  return '注意';
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
/**
 * 同一停滞指纹多久重推一次（毫秒）。默认 6 小时。
 *
 * 2026-09-11 实咬：原来 `fingerprint === prevFingerprint → wake:false`——
 * 同一停滞只推一次，之后永久静音。后果：实测「盘面停滞 5 轮（23 个对象没动）」
 * 在 09:12 推过一次之后，09:32、09:52… 每轮只往 journal 写一行，**不再惊动人**；
 * 23 个对象冻了几小时，用户侧一片安静。
 *
 * 去重的本意是防刷屏（同一件事别每 20 分钟喊一次），但它把
 * 「**一直没解决**」也一起静音了——而那恰恰是最该反复说的事。
 * 所以改成**按墙钟节流**：同一指纹 6 小时内不重复，超过就再喊一次。
 *
 * 为什么是墙钟而不是轮数：轮数取决于 act 跑得多勤（机器忙时会被准入闸推后），
 * 「6 小时没解决」用墙钟说才准确。这里**不是拿墙钟当闸**（那会随机误报），
 * 是拿它当**提醒节奏**——判「有没有停滞」仍然只用确定性的轮数与签名。
 */
export const DEFAULT_REALERT_MS = 6 * 60 * 60 * 1000;

export function planWake({ fingerprint, prevFingerprint, prevAt, stalled, now, realertMs = DEFAULT_REALERT_MS } = {}) {
  if (!stalled) return { wake: false, reason: 'no-stall', fingerprint: fingerprint || null };
  if (!fingerprint) return { wake: false, reason: 'no-fingerprint', fingerprint: null };
  if (fingerprint !== prevFingerprint) {
    return {
      wake: true,
      reason: prevFingerprint ? 'fingerprint-changed' : 'first',
      fingerprint,
    };
  }
  // 指纹没变 = 同一批对象还冻着。按墙钟节流重推——「一直没解决」要说第二遍。
  const prevMs = Date.parse(String(prevAt || '')) || 0;
  const nowMs = Date.parse(String(now || '')) || 0;
  if (!prevMs || !nowMs) {
    // 时间读不出来 → 不重推（宁可少喊一次，也不要每轮都喊）
    return { wake: false, reason: 'prev-at-unscanned', fingerprint };
  }
  const ageMs = nowMs - prevMs;
  if (ageMs >= realertMs) {
    return { wake: true, reason: 'still-stalled', fingerprint, ageMs };
  }
  return { wake: false, reason: 'same-fingerprint', fingerprint, ageMs };
}
