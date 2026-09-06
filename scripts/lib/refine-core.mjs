// scripts/lib/refine-core.mjs —— 消歧官判定（#1006）
//
// 改这段前必须知道：
//   「已消歧」在 card.mjs 是 fail-close 入队闸，全仓曾经只有读、没有写。
//   本文件是那道闸的执行者：吃 issue 结构，吐判决。驱动层（scripts/refiner.mjs）只做 IO。
//
// 判定必须保守：不是「我能想出做法」就算无岔路，
// 而是「任何合格执行者读完这张单都会做出同一个东西」才算无岔路。
// 拿不准一律归「要人拍」——判错方向会派出跑偏的单，返工远贵过多问一句。
//
// 三态分开，不许把没查成当成「这轮 0 张待消歧」：
//   clear  —— 确无岔路，可打 已消歧 + model/ + reviewer/
//   forks  —— 要人拍，打 待拍板 + 评论列岔路，不许打 已消歧
//   skip   —— type/体系（走快马）或已过滤（待消歧 / 已消歧）
//   unscanned —— 结构没查成，什么都不打

import { DISAMBIGUATED_LABEL } from './dispatch/card.mjs';
import { PENDING_LABEL } from './pending-disambiguation.mjs';
import { modelsFromJson, rankListFromTree } from './model-routing-json.mjs';
import { assertCrossVendor } from './reviewer-vendor-gate.mjs';
import { threeLines } from './plain-words.mjs';

export { DISAMBIGUATED_LABEL, PENDING_LABEL };

/** 与 now-board / feishu-triage-core 同一张标。这里自持字面量，避免为了四个字去拉整份看板模块。 */
export const AWAITING_CALL_LABEL = '待拍板';

/** 框架活角色。值与 commander-core 的 FRAMEWORK_ROLE 对齐；本单不许改那边，这里不 import。 */
export const FRAMEWORK_ROLE = '体系';
export const FRAMEWORK_LABEL = `type/${FRAMEWORK_ROLE}`;

/** 评论里的幂等钉。同一张单判过一次后看见这颗钉就不再评论。 */
export const REFINER_MARKER = '<!-- dao-refiner -->';

export const VERDICT = Object.freeze({
  clear: 'clear',
  forks: 'forks',
  skip: 'skip',
  unscanned: 'unscanned',
});

function labelNameOf(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && typeof item.name === 'string') return item.name;
  return '';
}

/** labels 不是数组（含缺席）→ null（没查成，不许当「没有标」）。 */
export function labelNames(labels) {
  if (!Array.isArray(labels)) return null;
  return labels.map(labelNameOf).filter(Boolean);
}

export function labelValue(labels, prefix) {
  const names = labelNames(labels);
  if (names == null) return null;
  const hit = names.find((n) => n.startsWith(prefix) && n.length > prefix.length);
  return hit ? hit.slice(prefix.length) : null;
}

/**
 * 每轮该看哪些单。入参不是数组 = 没查成。
 * 过滤：无「已消歧」、无「待消歧」。type/体系留在名单里，交给 classify 标 skip——
 * 这样测试能看见「扫到了、故意不打标」，而不是「没扫到」。
 */
export function selectCandidates(issues) {
  if (!Array.isArray(issues)) {
    return { scanned: false, items: [], skipped: [], error: 'issue 列表没查成——不是 0 张待消歧' };
  }
  const items = [];
  const skipped = [];
  for (const issue of issues) {
    if (!issue || issue.number == null) {
      return { scanned: false, items: [], skipped: [], error: '有 issue 缺单号——没查成，整轮不作数' };
    }
    const names = labelNames(issue.labels);
    if (names == null) {
      return {
        scanned: false, items: [], skipped: [],
        error: `#${issue.number} 的 labels 不是列表——没查成，不许当没有标`,
      };
    }
    if (names.includes(DISAMBIGUATED_LABEL)) {
      skipped.push({ number: issue.number, reason: '已消歧' });
      continue;
    }
    if (names.includes(PENDING_LABEL)) {
      skipped.push({ number: issue.number, reason: '待消歧' });
      continue;
    }
    items.push(issue);
  }
  return { scanned: true, items, skipped };
}

/** 单里点名「要人拍」或列出互斥做法 → 有岔路。宁可多命中。 */
const FORK_SIGNALS = [
  /要你拍/,
  /请你拍/,
  /等你拍/,
  /拍板/,
  /岔路/,
  /几种做法/,
  /二选一|三选一/,
  /选项\s*[123一二三①②③]/,
  /推荐[:：]/,
  /还是.{0,30}还是/,
  /全部仓|所有项目|推广到/,
  /从零重做还会/,
  /归档还是删除/,
  /要不要我/,
];

export function hasForkSignal(text) {
  const s = String(text || '');
  return FORK_SIGNALS.some((re) => re.test(s));
}

/**
 * 无岔路的窄门。只认「单点、可验证、没有第二种合格产物」的机械活。
 * 验收样例：「把 X 函数的错误信息换成人话」。
 * 扩门 = 自己给自己发派工许可，所以默认否。
 */
export function isClearMechanical(title, body) {
  const t = String(title || '');
  const b = String(body || '');
  const text = `${t}\n${b}`;
  if (hasForkSignal(text)) return false;
  if (/[？?]/.test(t) && /要不要|该不该|还是/.test(t)) return false;
  const namedSwap = /把\s*\S[\s\S]{0,60}(换成|改成|改为)/.test(t)
    || /把\s*\S[\s\S]{0,60}(换成|改成|改为)/.test(b);
  const namedTarget = /函数/.test(text) || /\.(mjs|js|cjs)\b/.test(text) || /错误信息/.test(text);
  return namedSwap && namedTarget;
}

/** 从正文抠「要你拍」下面的编号项。抠不出就交 conservativeForks，不许编造细节。 */
export function extractForks(text) {
  const s = String(text || '');
  const lines = s.split(/\r?\n/);
  const items = [];
  let inSection = false;
  for (const line of lines) {
    if (/要你拍/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^\s*#{1,6}\s/.test(line)) break;
    if (!inSection) continue;
    const n = line.match(/^\s*\d+[\.、．)]\s+(.+)/);
    if (n) {
      items.push({
        fork: n[1].replace(/\*\*/g, '').trim(),
        recommend: null,
        why: '单里点名要你拍',
      });
    }
  }
  return items;
}

export function conservativeForks(title) {
  const who = title ? `「${title}」` : '这张单';
  return [{
    fork: `${who}读完后，合格执行者不一定会做出同一个东西`,
    recommend: '先问你怎么做，不让机器自己发派工许可',
    why: '拿不准一律要人拍——判错方向会派出跑偏的单',
  }];
}

function recommendLine(text) {
  const m = String(text || '').match(/推荐[:：]\s*(.+)/);
  return m ? m[1].trim().slice(0, 80) : null;
}

/**
 * 一张单 → 判决。不读盘、不打网。
 * title 缺（null/undefined）= 没查成；空字符串也是没查成（没有可判的东西）。
 * body 缺当空串（标题够清楚时仍可能 clear）。
 */
export function classifyIssue(issue) {
  if (!issue || typeof issue !== 'object') {
    return { verdict: VERDICT.unscanned, error: 'issue 不是对象——没查成' };
  }
  if (issue.number == null) {
    return { verdict: VERDICT.unscanned, error: '缺单号——没查成' };
  }
  const names = labelNames(issue.labels);
  if (names == null) {
    return { verdict: VERDICT.unscanned, error: `#${issue.number} labels 不是列表——没查成` };
  }
  if (names.includes(FRAMEWORK_LABEL) || labelValue(issue.labels, 'type/') === FRAMEWORK_ROLE) {
    return {
      verdict: VERDICT.skip,
      number: issue.number,
      reason: 'type/体系 走快马，不进派单队列，消歧官不打标',
    };
  }
  if (issue.title == null || String(issue.title).trim() === '') {
    return { verdict: VERDICT.unscanned, error: `#${issue.number} 标题没查成` };
  }
  const title = String(issue.title);
  const body = issue.body == null ? '' : String(issue.body);
  const text = `${title}\n${body}`;
  const extracted = extractForks(text);
  if (extracted.length > 0 || hasForkSignal(text)) {
    const forks = extracted.length ? extracted : conservativeForks(title);
    const rec = recommendLine(text);
    if (rec && forks[0] && !forks[0].recommend) forks[0].recommend = rec;
    return {
      verdict: VERDICT.forks,
      number: issue.number,
      title,
      forks,
      reason: extracted.length
        ? '单里列出了要人拍的岔路'
        : '读出分叉信号，或拿不准——一律要人拍',
      recommend: rec || (forks[0] && forks[0].recommend) || null,
    };
  }
  if (isClearMechanical(title, body)) {
    return {
      verdict: VERDICT.clear,
      number: issue.number,
      title,
      forks: [],
      reason: '任何合格执行者读完都会做出同一个东西',
    };
  }
  return {
    verdict: VERDICT.forks,
    number: issue.number,
    title,
    forks: conservativeForks(title),
    reason: '拿不准一律要人拍——不是「能想出做法」就算无岔路',
    recommend: '先问你怎么做，不让机器自己发派工许可',
  };
}

/**
 * 无岔路要打的 model/ + reviewer/。值只读选型 JSON。
 * 工种取 type/，缺省写码。审官必须与工人跨厂，推不出 → 没查成，不许猜同厂。
 */
export function pickDispatchLabels({ labels, routingDoc, models } = {}) {
  if (!routingDoc || typeof routingDoc !== 'object') {
    return { ok: false, unscanned: true, error: '选型 JSON 没查成' };
  }
  const type = labelValue(labels, 'type/') || '写码';
  if (type === FRAMEWORK_ROLE) {
    return { ok: false, skip: true, error: 'type/体系 不打派工标' };
  }
  const primary = rankListFromTree(routingDoc, '工人', type);
  const workers = primary.length ? primary : rankListFromTree(routingDoc, '工人', '写码');
  if (!workers.length) {
    return { ok: false, unscanned: true, error: '工人顺位空——没查成，不许猜模型' };
  }
  const workerId = String(workers[0].id);
  const reviewers = rankListFromTree(routingDoc, '审官', '审查');
  if (!reviewers.length) {
    return { ok: false, unscanned: true, error: '审官顺位空——没查成，不许猜审官' };
  }
  let modelRecords;
  try {
    modelRecords = Array.isArray(models) ? models : modelsFromJson(routingDoc);
  } catch (e) {
    return { ok: false, unscanned: true, error: `选型模型表没查成：${String(e.message || e).slice(0, 120)}` };
  }
  if (!Array.isArray(modelRecords) || modelRecords.length === 0) {
    return { ok: false, unscanned: true, error: '选型模型表是空的——没查成' };
  }
  for (const r of reviewers) {
    const gate = assertCrossVendor({ workerId, reviewerId: r.id, models: modelRecords });
    if (gate.state === 'unscanned') {
      return { ok: false, unscanned: true, error: gate.error || '同厂闸没查成' };
    }
    if (gate.ok) {
      return { ok: true, model: workerId, reviewer: String(r.id), type };
    }
  }
  return { ok: false, unscanned: true, error: `工人 ${workerId} 找不到跨厂审官——不猜同厂` };
}

export function hasRefinerComment(comments) {
  if (!Array.isArray(comments)) return null;
  return comments.some((c) => String(c && c.body || '').includes(REFINER_MARKER));
}

export function buildForkComment({ number, title, forks, reason } = {}) {
  const rows = (forks || []).map((f) => {
    const fork = String(f.fork || '').replace(/\|/g, '\\|');
    const rec = String(f.recommend || '等你拍').replace(/\|/g, '\\|');
    const why = String(f.why || '').replace(/\|/g, '\\|');
    return `| ${fork} | ${rec} | ${why} |`;
  });
  const table = rows.length
    ? ['| 岔路 | 推荐 | 依据 |', '|---|---|---|', ...rows].join('\n')
    : '（正文没列出编号项，按保守默认：先问你）';
  return [
    `## 消歧官：有岔路，要人拍`,
    '',
    REFINER_MARKER,
    '',
    `判定：要人拍。${reason || '不是「能想出做法」就算无岔路。'}`,
    '',
    table,
    '',
    `未打「${DISAMBIGUATED_LABEL}」。你拍了之后再改标，这张单才会进队。`,
    number != null ? `（#${number}${title ? ' ' + title : ''}）` : '',
  ].filter((l) => l !== '').join('\n');
}

export function buildClearComment({ number, title, model, reviewer, reason } = {}) {
  return [
    `## 消歧官：确无岔路`,
    '',
    REFINER_MARKER,
    '',
    `判定：无岔路。${reason || '任何合格执行者读完都会做出同一个东西。'}`,
    '',
    '| 岔路 | 结论 | 依据 |',
    '|---|---|---|',
    '| 无 | 按正文做 | 边界清楚，没有第二种合格产物 |',
    '',
    `已打「${DISAMBIGUATED_LABEL}」+ \`model/${model}\` + \`reviewer/${reviewer}\`（值读选型）。`,
    number != null ? `（#${number}${title ? ' ' + title : ''}）` : '',
  ].filter((l) => l !== '').join('\n');
}

export function buildHubText(plans) {
  const forks = (plans || []).filter((p) => p && p.verdict === VERDICT.forks && p.comment && !p.idempotent);
  if (!forks.length) return null;
  const items = forks.map((p) => threeLines({
    what: `#${p.number}${p.title ? '「' + p.title + '」' : ''}有分叉，还不能派`,
    impact: '在你拍之前这张单不会进队列',
    plan: p.recommend ? `推荐${p.recommend}` : '详细岔路写在该单评论里',
  }));
  if (forks.length === 1) return `有 1 张单要你拍怎么做：\n${items[0]}`;
  return [
    `有 ${forks.length} 张单要你拍怎么做：`,
    ...items.map((t, i) => `${i + 1}）${t.replace(/\n/g, '\n   ')}`),
  ].join('\n');
}

/**
 * 一张单的完整计划。comments 必须是数组（调用方读失败就不要调用）。
 * 幂等：评论里已有钉 → 不再评论；缺的标仍补（标掉了评论还在的情况）。
 */
export function planIssue({ issue, comments, routingDoc, models } = {}) {
  const cls = classifyIssue(issue);
  if (cls.verdict === VERDICT.unscanned) return cls;
  if (cls.verdict === VERDICT.skip) {
    return {
      verdict: VERDICT.skip,
      number: issue.number,
      title: issue.title || '',
      reason: cls.reason,
      labelsToAdd: [],
      comment: null,
      hub: false,
      idempotent: false,
    };
  }
  if (!Array.isArray(comments)) {
    return { verdict: VERDICT.unscanned, error: `#${issue.number} 评论列表没查成` };
  }
  const already = hasRefinerComment(comments);
  if (already == null) {
    return { verdict: VERDICT.unscanned, error: `#${issue.number} 评论列表没查成` };
  }
  const names = labelNames(issue.labels) || [];

  if (cls.verdict === VERDICT.forks) {
    const labelsToAdd = names.includes(AWAITING_CALL_LABEL) ? [] : [AWAITING_CALL_LABEL];
    return {
      verdict: VERDICT.forks,
      number: issue.number,
      title: cls.title,
      forks: cls.forks,
      reason: cls.reason,
      recommend: cls.recommend,
      labelsToAdd,
      comment: already ? null : buildForkComment(cls),
      hub: !already,
      idempotent: already,
    };
  }

  const picked = pickDispatchLabels({ labels: issue.labels, routingDoc, models });
  if (!picked.ok) {
    if (picked.skip) {
      return {
        verdict: VERDICT.skip,
        number: issue.number,
        title: cls.title,
        reason: picked.error,
        labelsToAdd: [],
        comment: null,
        hub: false,
        idempotent: false,
      };
    }
    return {
      verdict: VERDICT.unscanned,
      error: `#${issue.number} ${picked.error || '派工标没查成'}`,
    };
  }
  const want = [
    DISAMBIGUATED_LABEL,
    `model/${picked.model}`,
    `reviewer/${picked.reviewer}`,
  ];
  const labelsToAdd = want.filter((n) => !names.includes(n));
  return {
    verdict: VERDICT.clear,
    number: issue.number,
    title: cls.title,
    reason: cls.reason,
    model: picked.model,
    reviewer: picked.reviewer,
    labelsToAdd,
    comment: already ? null : buildClearComment({
      number: issue.number,
      title: cls.title,
      model: picked.model,
      reviewer: picked.reviewer,
      reason: cls.reason,
    }),
    hub: false,
    idempotent: already,
  };
}

/**
 * 整轮计划。issues 或 commentsByNumber 不是预期结构 → 整轮 unscanned，调用方不得落任何写。
 */
export function planRound({ issues, commentsByNumber, routingDoc, models } = {}) {
  const sel = selectCandidates(issues);
  if (!sel.scanned) {
    return { scanned: false, plans: [], skipped: [], error: sel.error };
  }
  if (commentsByNumber != null && (typeof commentsByNumber !== 'object')) {
    return { scanned: false, plans: [], skipped: sel.skipped, error: '评论表没查成' };
  }
  const plans = [];
  for (const issue of sel.items) {
    const cls = classifyIssue(issue);
    if (cls.verdict === VERDICT.skip) {
      plans.push(planIssue({ issue, comments: [], routingDoc, models }));
      continue;
    }
    if (cls.verdict === VERDICT.unscanned) {
      return { scanned: false, plans: [], skipped: sel.skipped, error: cls.error };
    }
    const comments = commentsByNumber ? commentsByNumber[issue.number] : undefined;
    if (!Array.isArray(comments)) {
      return {
        scanned: false, plans: [], skipped: sel.skipped,
        error: `#${issue.number} 评论没查成——整轮不作数，不许先写下半场`,
      };
    }
    const plan = planIssue({ issue, comments, routingDoc, models });
    if (plan.verdict === VERDICT.unscanned) {
      return { scanned: false, plans: [], skipped: sel.skipped, error: plan.error };
    }
    plans.push(plan);
  }
  return {
    scanned: true,
    plans,
    skipped: sel.skipped,
    hubText: buildHubText(plans),
  };
}
