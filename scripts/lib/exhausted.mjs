// scripts/lib/exhausted.mjs —— 自动化认输是 PR 的属性，不是待发送的事件（#1000）
//
// 来历：exhausted 走 escalate 开单，开单去重把同一 key 吃掉 → 零日志永久卡死（PR #909）。
// 再动去重 = 「怎么喊人」第四层。本文件把认输做成状态：打标、跳过、看门狗按 @head 推一次。
//
// 零 IO。调用方填 PR / 账本，这里只判。

export const EXHAUSTED_LABEL = '卡死/自动化认输';
export const WAITING_USER_LABEL = '卡死/等用户';
export const EXHAUSTED_VERBS = new Set(['drain', 'rework', 'rereview', 'pump-draft']);
export const EXHAUSTED_COMMENT_MARK = '[commander-exhausted]';

/** 账本键必须带 @head。只用 pr 会把修好的新局面永久挡住（PR #909 / df87014a）。 */
export function exhaustedPushKey(pr, head) {
  const n = pr == null ? '' : String(pr).trim();
  const h = typeof head === 'string' ? head.trim() : '';
  if (!n || !h) return null;
  return `pushed:${n}@${h}`;
}

export function exhaustedPushPath(home) {
  return `${String(home || '').replace(/\/+$/, '')}/.dao/exhausted-push.json`;
}

function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  const out = [];
  for (const l of labels) {
    if (typeof l === 'string') { if (l) out.push(l); continue; }
    if (l && typeof l.name === 'string' && l.name) out.push(l.name);
  }
  return out;
}

/** 指挥官见到这两个标都跳过重试。等用户 = 已经升级给人，不再机械推。 */
export function prHasStuckLabel(pr) {
  const names = labelNames(pr && pr.labels);
  return names.includes(EXHAUSTED_LABEL) || names.includes(WAITING_USER_LABEL);
}

export function prHasExhaustedLabel(pr) {
  return labelNames(pr && pr.labels).includes(EXHAUSTED_LABEL);
}

export function prHasWaitingUserLabel(pr) {
  return labelNames(pr && pr.labels).includes(WAITING_USER_LABEL);
}

export function waitingUserComment({ pr, verb, tries, head } = {}) {
  const v = EXHAUSTED_VERBS.has(verb) ? verb : String(verb || '?');
  const n = pr == null ? '?' : String(pr);
  const h = typeof head === 'string' && head.trim() ? head.trim() : null;
  const triesN = Number.isFinite(Number(tries)) ? Number(tries) : '?';
  return [
    `${EXHAUSTED_COMMENT_MARK} ${v} PR #${n}${h ? '@' + h : ''}`,
    '',
    `draft 收口泵试了 ${triesN} 次仍是 draft。已打「${WAITING_USER_LABEL}」，指挥官不再泵。`,
    h ? `当前 head：${h}` : '当前 head 没查成，标打在 PR 上（属性不依赖 head）。',
    '',
    '帅位三选一：',
    '1. 去掉该标——已解决，下轮可再泵',
    '2. 补验收 / 转正式 / 关掉 PR',
    '3. 保持等用户，看门狗不再推',
  ].join('\n');
}

export function exhaustedComment({ pr, verb, tries, head } = {}) {
  const v = EXHAUSTED_VERBS.has(verb) ? verb : String(verb || '?');
  const n = pr == null ? '?' : String(pr);
  const h = typeof head === 'string' && head.trim() ? head.trim() : null;
  const triesN = Number.isFinite(Number(tries)) ? Number(tries) : '?';
  return [
    `${EXHAUSTED_COMMENT_MARK} ${v} PR #${n}${h ? '@' + h : ''}`,
    '',
    `自动化认输：动词 ${v} 试了 ${triesN} 次仍没推动。`,
    h ? `当前 head：${h}` : '当前 head 没查成，标打在 PR 上（属性不依赖 head）。',
    '',
    '指挥官从此跳过这张 PR，不再重试。帅位三选一：',
    '1. 去掉「卡死/自动化认输」——已解决，下轮可再试',
    '2. 换成「卡死/等用户」——升级给人，看门狗不再推',
    '3. 关掉 PR',
    '',
    '新 head 允许看门狗再推一次（工人推了新东西 = 新局面）。',
  ].join('\n');
}

export function buildMarkExhausted({ pr, verb, tries, head, why, label } = {}) {
  const n = pr == null ? null : Number.isFinite(Number(pr)) ? Number(pr) : pr;
  const v = EXHAUSTED_VERBS.has(verb) ? verb : String(verb || '');
  const useWaiting = label === WAITING_USER_LABEL || v === 'pump-draft';
  return {
    kind: 'mark-exhausted',
    pr: n,
    verb: v,
    tries: Number(tries) || 0,
    head: typeof head === 'string' && head.trim() ? head.trim() : null,
    label: useWaiting ? WAITING_USER_LABEL : EXHAUSTED_LABEL,
    why: why || (useWaiting
      ? `PR #${n} draft 收口泵试满，打「${WAITING_USER_LABEL}」交帅`
      : `PR #${n} 自动化认输（${verb} 试满）`),
    comment: useWaiting
      ? waitingUserComment({ pr: n, verb, tries, head })
      : exhaustedComment({ pr: n, verb, tries, head }),
  };
}

/**
 * 看门狗：带「卡死/自动化认输」的开放 PR，同一 (pr, head) 只推一次。
 * 换成「卡死/等用户」/摘标/关掉 → 不再推。head 没查成 → 不推、不写无 head 键。
 */
export function planExhaustedPush({ prs = [], ledger = {} } = {}) {
  const book = ledger && typeof ledger === 'object' ? ledger : {};
  const pushes = [];
  const skipped = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (!pr || pr.number == null) continue;
    const n = pr.number;
    if (!Array.isArray(pr.labels)) {
      skipped.push({ pr: n, why: 'labels-unscanned' });
      continue;
    }
    const names = labelNames(pr.labels);
    if (names.includes(WAITING_USER_LABEL)) {
      skipped.push({ pr: n, why: 'waiting-user' });
      continue;
    }
    if (!names.includes(EXHAUSTED_LABEL)) continue;
    const head = typeof pr.headRefOid === 'string' && pr.headRefOid.trim() ? pr.headRefOid.trim() : null;
    if (!head) {
      skipped.push({ pr: n, why: 'head-unscanned' });
      continue;
    }
    const key = exhaustedPushKey(n, head);
    if (book[key]) {
      skipped.push({ pr: n, why: 'already-pushed', key });
      continue;
    }
    pushes.push({
      pr: n,
      head,
      key,
      title: pr.title || '',
      text: `PR #${n} 自动化认输（${EXHAUSTED_LABEL}），head ${head.slice(0, 8)}。帅位三选一：去掉该标 / 换成「${WAITING_USER_LABEL}」 / 关掉 PR。新 head 会再推一次。`,
    });
  }
  return { pushes, skipped };
}

/**
 * 「自动化认输」是**带 head** 的判据，不是一个永久标签——过期就摘。
 *
 * 2026-09-11 实咬（自主运转验收的第一个死点）：这个标被写成**单向闩**。
 * 写它有好几处，摘它的代码路径**一处都没有**，而 `prHasStuckLabel` 一票否决该 PR
 * 的全部动作。于是 12 张 PR 被永久焊死：`decide` 对它们零动作，连报帅都没有。
 *
 * 但设计意图本来就不是永久的——本文件自己的注释写着
 * 「账本键必须带 @head。只用 pr 会把修好的新局面永久挡住（PR #909 / df87014a）」
 * 以及「新 head 允许看门狗再推一次（工人推了新东西 = 新局面）」。
 * 账本键是 `pushed:<pr>@<head>`（带 head），**标签却是无头的**——这就是那个不对称。
 *
 * 所以：**工人推了新 head = 新局面**，旧认输对新局面不成立，把标摘掉让它重回流水线。
 * 与账本同一套语义（`exhaustedPushKey` 带 head），不再另立一套。
 *
 * 只摘「自动化认输」，**不动「等用户」**——那个是「已升级给人」，人没回话之前机器不该自己动。
 *
 * @param {Array} prs  开放 PR（要带 number / headRefOid / labels）
 * @param {Object} ledger  `pushed:<pr>@<head>` → { at, pr, head }
 * @param {Object} pushedThisRound  本轮刚推过的键（刚认输的别当场又摘掉）
 */
export function planExhaustedLabelClear({ prs = [], ledger = {}, pushedThisRound = [] } = {}) {
  const book = ledger && typeof ledger === 'object' ? ledger : {};
  const justPushed = new Set((Array.isArray(pushedThisRound) ? pushedThisRound : []).map(String));
  const clears = [];
  const skipped = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (!pr || pr.number == null) continue;
    const n = pr.number;
    if (!Array.isArray(pr.labels)) { skipped.push({ pr: n, why: 'labels-unscanned' }); continue; }
    const names = labelNames(pr.labels);
    if (!names.includes(EXHAUSTED_LABEL)) continue;          // 没这个标，不是本函数的事
    if (names.includes(WAITING_USER_LABEL)) { skipped.push({ pr: n, why: 'waiting-user' }); continue; }
    const head = typeof pr.headRefOid === 'string' && pr.headRefOid.trim() ? pr.headRefOid.trim() : null;
    if (!head) { skipped.push({ pr: n, why: 'head-unscanned' }); continue; }  // 没查成不动手（摘错要重认输一轮）
    // 找这张 PR 在账本里的认输记录：key 是 pushed:<pr>@<head>
    const recorded = Object.keys(book).find((k) => {
      const v = book[k];
      return v && Number(v.pr) === Number(n);
    });
    const recordedHead = recorded ? String(book[recorded].head || '') : '';
    if (!recordedHead) { skipped.push({ pr: n, why: 'no-ledger-head' }); continue; }
    if (recordedHead === head) { skipped.push({ pr: n, why: 'same-head' }); continue; }
    if (justPushed.has(exhaustedPushKey(n, head) || '')) { skipped.push({ pr: n, why: 'just-pushed' }); continue; }
    clears.push({
      pr: n,
      head,
      recordedHead,
      why: `PR #${n} 认输记录在 head ${recordedHead.slice(0, 8)}，现在已是 ${head.slice(0, 8)}`
        + `——工人推了新东西 = 新局面，旧认输不成立，摘标让它重回流水线`,
    });
  }
  return { clears, skipped };
}
