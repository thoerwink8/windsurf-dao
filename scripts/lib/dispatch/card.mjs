// scripts/lib/dispatch/card.mjs —— 卡名/消歧门/label 域（#762 拆分）
//
// 改这段前必须知道：卡名格式唯一真相源是 assembleCardName（#589）。
// 消歧门三态必须分得开（#565）：查成且有 label / 查成但没 label / 没查成。
// label 记「决定」：dispatch 记 issue，帅合并时同步到 PR（#564 + #586）。

import { dispatchLabelNames, linkedIssueNumbers } from './worker-done.mjs';
import { PENDING_LABEL } from '../pending-disambiguation.mjs';

/** 卡名给人眼看（#589；号前带 #，2026-08-18 拍板）。
 * 组装只产出 `ISSUE-#589 工人·模型 短语` / `PR-#616 审官·模型`。
 * 解析认 `-#?(\d+)`，旧的 `PR-616` / `ISSUE-589` 仍读得懂。
 * 给了 pr 就升级前缀。没给号则原样返回。这是卡名格式的唯一真相源。 */
const CARD_ROLE_DOT = /^(工人|审官|辅助)·(\S+)(?:\s+(.*))?$/;
const CARD_NEW = /^(PR|ISSUE)-#?(\d+)\s+(.*)$/;
const CARD_OLD = /^#(\d+)\s*[-–—]\s*(.*)$/;

export function assembleCardName({ name, issue, pr, role, model } = {}) {
  const raw = String(name ?? '').trim();
  const prText = String(pr ?? '').trim();
  const issueText = String(issue ?? '').trim();
  const kind = /^\d+$/.test(prText) ? 'PR' : (/^\d+$/.test(issueText) ? 'ISSUE' : null);
  const num = kind === 'PR' ? prText : issueText;
  let stem = raw;
  let roleText = String(role ?? '').trim();
  let modelId = String(model ?? '').trim();

  const asNew = raw.match(CARD_NEW);
  if (asNew) stem = asNew[3];
  else {
    const asOld = raw.match(CARD_OLD);
    if (asOld) stem = asOld[2];
  }

  const roleDot = stem.match(CARD_ROLE_DOT);
  if (roleDot) {
    if (!roleText) roleText = roleDot[1];
    if (!modelId) modelId = roleDot[2];
    stem = (roleDot[3] || '').trim();
  }

  if (!kind) return raw;
  const mid = roleText && modelId ? `${roleText}·${modelId}` : (roleText || '');
  return [`${kind}-#${num}`, mid, stem].filter(Boolean).join(' ');
}

// ── 消歧门（#565）：项化派工前的硬门控 ────────────────────────────────────
// dao-project skill 第二节：待拍板不是停车场，是所有项都要过的一道门，过不了不许派。
// dispatch / worker-start 带 --issue 时，目标 issue 必须已打「已消歧」label，读不到拒派（fail-close）。
// 三态必须分得开（#565 硬约束）：查成且有 label / 查成但没 label / 没查成（gh 失败）。
// 没查成不许当有 label 放行——「没查成」当「查过没事」是事故类（#532 通用原则）。
// #876：反向标「待消歧」与「已消歧」互斥且优先——带「待消歧」的单一律拒派，
// 就算故意双标也拒（还没定怎么做的事，落了盘不等于可做）。到时机由盘点端上来请用户拍。
export const DISAMBIGUATED_LABEL = '已消歧'; // 只认这一张；近义标（已拍板 / 已澄清 / disambiguated / 待拍板）不算过门（#565）
export function checkIssueDisambiguated({ issue, runGh } = {}) {
  const n = String(issue ?? '').trim();
  if (!n) return { ok: true, gated: false, issue: null };
  if (!/^\d+$/.test(n)) {
    return { ok: false, gated: true, issue: n, error: `--issue 必须是 issue 号，实际「${n}」` };
  }
  if (typeof runGh !== 'function') {
    return { ok: false, gated: true, issue: n, unscanned: true, error: '消歧门没拿到 gh 执行器——没查成，不许放行' };
  }
  const r = runGh(['issue', 'view', n, '--json', 'labels']);
  if (!r.ok) {
    return {
      ok: false, gated: true, issue: n, unscanned: true,
      error: `gh 读 issue #${n} labels 失败——不是查过没事，是没查成：${r.error}`,
    };
  }
  let labels = [];
  try {
    const parsed = JSON.parse(r.out);
    labels = Array.isArray(parsed?.labels) ? parsed.labels : [];
  } catch {
    return {
      ok: false, gated: true, issue: n, unscanned: true,
      error: `gh 读 issue #${n} labels 返回不是 JSON——没查成，不许放行：${String(r.out).slice(0, 120)}`,
    };
  }
  const names = labels.map(l => l && l.name).filter(Boolean);
  if (names.includes(PENDING_LABEL)) {
    return {
      ok: false, gated: true, issue: n, pending: true, labels: names,
      error: `issue #${n} 带「${PENDING_LABEL}」label，拒派（#876：还没定怎么做的事，落了盘也不等于可做）。`
        + `两个标同时在也按拒派算。等它到讨论时机、你拍了怎么消歧，把标换成「${DISAMBIGUATED_LABEL}」再派。`,
    };
  }
  if (!names.includes(DISAMBIGUATED_LABEL)) {
    return {
      ok: false, gated: true, issue: n, hasLabel: false, labels: names,
      error: `issue #${n} 缺「${DISAMBIGUATED_LABEL}」label，拒派（fail-close，忘打标是拦住不是放行）。`
        + `去该 issue 补消歧记录（岔路清单 + 结论 + 依据，依据要用户拍的或有旧拍板可依，见 dao-project skill 第二节），`
        + `再打「${DISAMBIGUATED_LABEL}」label 后重试派工。`,
    };
  }
  return { ok: true, gated: true, issue: n, hasLabel: true, labels: names };
}

/** 仓内现有 label 名。没查成返回 null（不许当「没有」去瞎建）。 */
export function ghLabelNames(runGh) {
  if (typeof runGh !== 'function') return null;
  const r = runGh(['label', 'list', '--limit', '1000', '--json', 'name']);
  if (!r.ok) return null;
  try {
    const arr = JSON.parse(r.out);
    return Array.isArray(arr) ? arr.map(x => x && x.name).filter(Boolean) : null;
  } catch { return null; }
}

/** 确保仓里存在这些 label（缺的建，已存在不动）。建 label 是仓库级一次性动作，幂等。 */
export function ensureRepoLabels({ names, runGh } = {}) {
  if (!Array.isArray(names) || !names.length) return { ok: true, created: [] };
  if (typeof runGh !== 'function') return { ok: false, unscanned: true, error: 'ensureRepoLabels 没拿到 gh 执行器' };
  const existing = ghLabelNames(runGh);
  if (existing === null) return { ok: false, unscanned: true, error: 'gh label list 没查成——不知道该建哪些' };
  const missing = names.filter(n => !existing.includes(n));
  const created = [];
  for (const name of missing) {
    const c = runGh(['label', 'create', name]);
    if (!c.ok) return { ok: false, error: `建 label「${name}」失败：${c.error}` };
    created.push(name);
  }
  return { ok: true, created, existing };
}

function labelNameOf(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && typeof item.name === 'string') return item.name;
  return '';
}

/**
 * 接手派单不重挂 model/*（#815/#810）：issue 上已有任意 model/* 就不再加第二条。
 * existingNames 没拿到 → unscanned，不许猜着再挂。
 */
export function planStampIssueLabels({ existingNames, model, role, reviewer } = {}) {
  if (existingNames == null || !Array.isArray(existingNames)) {
    return { ok: false, unscanned: true, error: 'issue 现有 label 没查成（没查成，不许再挂）' };
  }
  const names = dispatchLabelNames({ model, role, reviewer });
  const existing = existingNames.map(labelNameOf).filter(Boolean);
  const existingModel = existing.filter(n => n.startsWith('model/'));
  const add = [];
  const skipped = [];
  for (const name of names) {
    if (existing.includes(name)) {
      skipped.push({ name, reason: 'already' });
      continue;
    }
    if (name.startsWith('model/') && existingModel.length > 0) {
      skipped.push({ name, reason: 'handoff-keep-existing-model', existing: existingModel });
      continue;
    }
    add.push(name);
  }
  return { ok: true, names, add, skipped, existingModel };
}

/** 派工成功侧：把 model/<模型> type/<角色> reviewer/<审官> 打到目标 issue（best-effort：失败只报告，不翻转派工结果）。 */
export function stampIssueLabels({ issue, model, role, reviewer, runGh } = {}) {
  const n = String(issue ?? '').trim();
  if (!/^\d+$/.test(n)) {
    return { ok: false, skipped: true, issue: n, error: '没给合法 issue 号，label 不打' };
  }
  if (typeof runGh !== 'function') {
    return { ok: false, issue: n, unscanned: true, error: 'stampIssueLabels 没拿到 gh 执行器——label 没打' };
  }
  const view = runGh(['issue', 'view', n, '--json', 'labels']);
  if (!view.ok) {
    return { ok: false, issue: n, unscanned: true, error: `gh 读 issue #${n} labels 失败——没查成，不许再挂：${view.error}` };
  }
  let existingNames = [];
  try {
    const parsed = JSON.parse(view.out);
    existingNames = Array.isArray(parsed?.labels) ? parsed.labels : [];
  } catch {
    return { ok: false, issue: n, unscanned: true, error: `gh 读 issue #${n} labels 返回非 JSON——没查成，不许再挂` };
  }
  const planned = planStampIssueLabels({ existingNames, model, role, reviewer });
  if (!planned.ok) return { ...planned, issue: n };
  if (!planned.add.length) {
    return {
      ok: true, issue: n, names: planned.names, add: [], skipped: planned.skipped,
      created: [], labels: planned.names,
    };
  }
  const ensured = ensureRepoLabels({ names: planned.add, runGh });
  if (!ensured.ok) return { ok: false, issue: n, unscanned: ensured.unscanned === true, error: ensured.error };
  const add = [];
  for (const name of planned.add) add.push('--add-label', name);
  const r = runGh(['issue', 'edit', n, ...add]);
  if (!r.ok) return { ok: false, issue: n, error: `issue #${n} 打 label 失败：${r.error}` };
  return {
    ok: true, issue: n, names: planned.names, add: planned.add, skipped: planned.skipped,
    created: ensured.created, labels: planned.add,
  };
}

/** 合并侧（帅合并时跑）：PR 正文署名的 issue 上取 model/* type/* reviewer/* label，抄到 PR。
 * PR 上没署名 issue / 署名 issue 缺 model/* 或 type/* / gh 没查成——三种都要说清楚，不许静默。
 * reviewer/* 有则抄、没有不挡；但只有 reviewer/*、缺校准标签，不许 pr edit。 */
export function syncPrLabelsFromIssue({ pr, runGh } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'syncPrLabelsFromIssue 没给 PR 号' };
  if (typeof runGh !== 'function') return { ok: false, unscanned: true, error: 'syncPrLabelsFromIssue 没拿到 gh 执行器' };
  const view = runGh(['pr', 'view', n, '--json', 'title,body']);
  if (!view.ok) return { ok: false, unscanned: true, error: `gh pr view #${n} 失败：${view.error}` };
  let meta;
  try { meta = JSON.parse(view.out); }
  catch { return { ok: false, unscanned: true, error: `gh pr view #${n} 返回非 JSON：${String(view.out).slice(0, 120)}` }; }
  const refs = linkedIssueNumbers(`${meta.title || ''}\n${meta.body || ''}`);
  if (!refs.length) {
    return { ok: false, unscanned: false, error: `PR #${n} 正文/标题里没有「署名 issue #N」/关单词署名单号——label 无从同步，需人工补` };
  }
  const from = [];
  for (const issueNum of refs) {
    const iv = runGh(['issue', 'view', String(issueNum), '--json', 'labels']);
    if (!iv.ok) return { ok: false, unscanned: true, error: `gh issue view #${issueNum} 失败：${iv.error}` };
    let labels = [];
    try {
      const parsed = JSON.parse(iv.out);
      labels = Array.isArray(parsed?.labels) ? parsed.labels : [];
    } catch { return { ok: false, unscanned: true, error: `gh issue view #${issueNum} 返回非 JSON` }; }
    const names = labels
      .map(l => (l && typeof l === 'object' ? l.name : l))
      .filter(name => typeof name === 'string' && /^(model\/|type\/|reviewer\/)/.test(name));
    if (names.length) from.push({ issue: issueNum, labels: names });
  }
  const want = [...new Set(from.flatMap(f => f.labels))];
  const hasModel = want.some(name => name.startsWith('model/'));
  const hasType = want.some(name => name.startsWith('type/'));
  if (!hasModel || !hasType) {
    const missing = [!hasModel && 'model/*', !hasType && 'type/*'].filter(Boolean).join(' 和 ');
    return {
      ok: false,
      unscanned: false,
      error: `PR #${n} 的署名 issue 上缺 ${missing} label（派工漏打？）——需人工补，不许只靠 reviewer/* 过关`,
      refs,
      labels: want,
    };
  }
  const ensured = ensureRepoLabels({ names: want, runGh });
  if (!ensured.ok) return { ok: false, unscanned: ensured.unscanned === true, error: ensured.error };
  const add = [];
  for (const name of want) add.push('--add-label', name);
  const edit = runGh(['pr', 'edit', n, ...add]);
  if (!edit.ok) return { ok: false, error: `PR #${n} 打 label 失败：${edit.error}` };
  return { ok: true, pr: n, labels: want, refs, from, created: ensured.created };
}

export function dispatchComment({ mergePolicy, mergeReason, model, reviewer, split, splitReason } = {}) {
  const parts = [`merge-policy:${mergePolicy}`, `model:${model}`, `reviewer:${reviewer}`];
  if (split != null && String(split).trim() !== '') {
    parts.push(`split:${split}`);
    if (String(split).toLowerCase() === 'no' && splitReason) {
      parts.push(`split 理由: ${splitReason}`);
    }
  }
  const base = parts.join(' · ');
  if (mergePolicy === 'manual' && mergeReason) {
    return `${base} · manual 理由: ${mergeReason}`;
  }
  return base;
}

const TICKET_ZONE_TAIL = /｜\[(?:#\d+(?: #\d+)*)?\]$/;

function isDispatchMetaPart(part) {
  const p = String(part || '').trim();
  if (!p) return false;
  return /^(merge-policy:(auto|manual)|model:\S+|reviewer:\S+|split:\S+)$/.test(p)
    || /^split 理由:\s*\S/.test(p)
    || /^manual 理由:\s*\S/.test(p);
}

function splitCommentBody(comment) {
  const text = String(comment || '');
  const zoneHit = text.match(TICKET_ZONE_TAIL);
  const zone = zoneHit ? text.slice(zoneHit.index) : '';
  const prefix = zoneHit ? text.slice(0, zoneHit.index) : text;
  const parts = prefix.split(/\s*·\s*/).map(s => s.trim()).filter(Boolean);
  const meta = [];
  const rest = [];
  for (const p of parts) {
    if (isDispatchMetaPart(p)) meta.push(p);
    else rest.push(p);
  }
  return { meta, rest, zone };
}

/** 从任务卡 comment 读回 dispatchComment 写下的 merge-policy。无样本返回 null，不猜。
 * 按 ` · ` 分段，不让后面的人话进度吞掉 manual 理由。 */
export function parseDispatchComment(comment) {
  const { meta } = splitCommentBody(comment);
  let mergePolicy = null;
  let mergeReason = null;
  for (const p of meta) {
    const pol = p.match(/^merge-policy:(auto|manual)$/);
    if (pol) mergePolicy = pol[1];
    const reason = p.match(/^manual 理由:\s*(.+)$/);
    if (reason) mergeReason = reason[1].trim();
  }
  return { mergePolicy, mergeReason };
}

/**
 * #799：写人话进度时保留派工结构化前缀（merge-policy / model / reviewer / 理由）和定界区。
 * worker-done 不得把唯一策略载体盖成「待终审」——旧账本无 merge_policy 时 attach 全靠这段 comment。
 */
export function progressDispatchComment(existing, progress) {
  const { meta, zone } = splitCommentBody(existing);
  const next = String(progress || '').trim();
  const body = [...meta, next].filter(Boolean).join(' · ');
  return `${body}${zone}`;
}
