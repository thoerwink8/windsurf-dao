// scripts/lib/exhausted.mjs —— 自动化认输是 PR 的属性，不是待发送的事件（#1000）
//
// 来历：exhausted 走 escalate 开单，开单去重把同一 key 吃掉 → 零日志永久卡死（PR #909）。
// 再动去重 = 「怎么喊人」第四层。本文件把认输做成状态：打标、跳过、看门狗按 @head 推一次。
//
// 零 IO。调用方填 PR / 账本，这里只判。

export const EXHAUSTED_LABEL = '卡死/自动化认输';
export const WAITING_USER_LABEL = '卡死/等用户';
export const EXHAUSTED_VERBS = new Set(['drain', 'rework', 'rereview']);
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

export function buildMarkExhausted({ pr, verb, tries, head, why } = {}) {
  const n = pr == null ? null : Number.isFinite(Number(pr)) ? Number(pr) : pr;
  return {
    kind: 'mark-exhausted',
    pr: n,
    verb: EXHAUSTED_VERBS.has(verb) ? verb : String(verb || ''),
    tries: Number(tries) || 0,
    head: typeof head === 'string' && head.trim() ? head.trim() : null,
    why: why || `PR #${n} 自动化认输（${verb} 试满）`,
    comment: exhaustedComment({ pr: n, verb, tries, head }),
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
