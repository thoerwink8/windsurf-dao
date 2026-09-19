// scripts/lib/stage-board.mjs —— T44：版本视图与伞单索引的**生成**与**一致性判据**。
//
// 用户 2026-09-19 拍板「从零删壳」选 A：不把 GitHub 已有的容器在仓里再抄一遍。
// 三根原生轴：里程碑 = 版本（承诺做）；priority/P0..P2 标签 = 多急；状态 = 做完没。
// ⇒ 视图**算**出来，不手写；手写就会漂（同一件事已漂 4 轮）。
//
// 纯函数：只算与判，不读盘、不联网。三态（绿 / 红 / 没查成）——取不到已发布评论 = 没查成，不是绿。

export const UMBRELLA_MARKER = 'dao-umbrella-index';

/** 版本视图评论的认领标记（发在版本单上，如 #1460）。 */
export function stageViewMarker(stage) {
  return `dao-stage-priority: ${stage}`;
}

/** 现在做 / 紧接着 / 靠后 —— 直接读 priority 标签，不手排（机制类优先 = 机制项拿 P0）。 */
export const BANDS = Object.freeze([
  { label: 'priority/P0', title: '现在做' },
  { label: 'priority/P1', title: '紧接着' },
  { label: 'priority/P2', title: '靠后' },
]);

export function labelNames(issue) {
  if (!issue || !Array.isArray(issue.labels)) return [];
  return issue.labels.map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
}

export function priorityOf(issue) {
  return labelNames(issue).find((n) => /^priority\/P\d+$/.test(n)) || null;
}

export function milestoneTitleOf(issue) {
  const m = issue && issue.milestone;
  if (m == null) return null;
  if (typeof m === 'string') return m;
  return m.title != null ? String(m.title) : null;
}

const issueLine = (i) => `- #${i.number} ${i.title}`;

/** 版本视图正文（发在版本单上的那条评论）。 */
export function renderStageView({ stage, milestone, stageIssue, issues, debt, generatedAt } = {}) {
  const open = (issues || []).filter((i) => String(i.state || '').toUpperCase() === 'OPEN')
    .sort((a, b) => a.number - b.number);
  const closed = (issues || []).filter((i) => String(i.state || '').toUpperCase() === 'CLOSED')
    .sort((a, b) => b.number - a.number);

  const out = [];
  out.push(`<!-- ${stageViewMarker(stage)} -->`);
  out.push(`**[一眼看懂] ${milestone}**（本评论由 \`scripts/stage-board.mjs\` 生成，勿手改）`);
  out.push('');
  // 正文里**不放时间戳**：一致性闸比的是正文，带时间戳就会天天红（确定性优先）。
  out.push(`里程碑「${milestone}」｜ 开放 ${open.length} / 已关 ${closed.length}${generatedAt ? ` ｜ 生成于 ${generatedAt}` : ''}`);
  out.push('');
  for (const band of BANDS) {
    const items = open.filter((i) => priorityOf(i) === band.label);
    out.push(`## ${band.title}（\`${band.label}\`）`);
    out.push(items.length ? items.map(issueLine).join('\n') : '_（空）_');
    out.push('');
  }
  const unlabeled = open.filter((i) => !priorityOf(i));
  out.push(`## 未标优先级（${unlabeled.length} 张——这是缺口，不是「没有」）`);
  out.push(unlabeled.length ? unlabeled.map(issueLine).join('\n') : '_（空）_');
  out.push('');
  out.push('## 已完成（本版内已关，最多列 20 条）');
  out.push(closed.slice(0, 20).length ? closed.slice(0, 20).map(issueLine).join('\n') : '_（空）_');
  out.push('');
  const debtItems = (debt && Array.isArray(debt.items)) ? debt.items : [];
  out.push(`## 债（\`docs/stages/${stage}.json\` 的 debt）`);
  out.push(debtItems.length ? debtItems.map((d) => issueLine({ number: d.id, title: d.what || '' })).join('\n') : '_（空）_');
  out.push('');
  out.push(`指针：伞单索引在 #816；出口判据与规矩在 \`docs/stages/${stage}.json\`；本视图的版本单是 #${stageIssue}。`);
  return `${out.join('\n')}\n`;
}

/** 伞单索引正文（发在伞单 #816 上的那条评论）：只装里程碑与指针，不装具体 issue/T 项（T31）。 */
export function renderUmbrellaIndex({ stage, stageIssue, stageMilestoneNumber, milestones } = {}) {
  const out = [];
  out.push(`<!-- ${UMBRELLA_MARKER} -->`);
  out.push('**里程碑索引（当前）**');
  out.push('');
  out.push('| 里程碑 | 状态 | 一眼看懂的优先级在哪 |');
  out.push('|---|---|---|');
  const open = (milestones || []).filter((m) => String(m.state || '').toLowerCase() === 'open')
    .sort((a, b) => a.number - b.number);
  for (const m of open) {
    const isStage = Number(m.number) === Number(stageMilestoneNumber);
    out.push(`| **${m.title}**（#${m.number}） | ${isStage ? '**在做**' : '顺延池'} | ${isStage ? `#${stageIssue} 的视图评论（标记 \`${stageViewMarker(stage)}\`）` : '—'} |`);
  }
  out.push('');
  out.push('规矩（防伞单膨胀）：**伞单只装里程碑与指针，不装具体 issue/T 项**；每版的视图放那一版的单，出口判据放 `docs/stages/<版本>.json`。');
  return `${out.join('\n')}\n`;
}

/** 网关会在正文尾补一行幂等标记；比对时把它剥掉，否则「生成的」永远不等于「已发的」。 */
export function stripGatewayMarkers(text) {
  return String(text || '')
    .split('\n')
    .filter((l) => !/^\s*<!--\s*dao-idempotency:[^>]*-->\s*$/.test(l))
    .join('\n');
}

const norm = (t) => stripGatewayMarkers(t).replace(/[ \t]+$/gm, '').replace(/\n+$/, '');

/** 已发布评论与生成结果是否一致。三态：取不到清单/没发布 = 没查成（不是绿，也不是红）。 */
export function judgePostedConsistency({ marker, expected, posted } = {}) {
  if (!Array.isArray(posted)) {
    return { state: 'unscanned', why: '评论清单没查成（取不到 ≠ 一致）' };
  }
  const hits = posted.filter((c) => c && typeof c.body === 'string' && c.body.includes(marker));
  if (!hits.length) {
    return { state: 'unscanned', why: `没找到带标记「${marker}」的评论——还没发布，不是一致` };
  }
  const latest = hits[hits.length - 1];
  if (norm(latest.body) === norm(expected)) {
    return { state: 'green', why: `已发布视图与生成结果一致（comment ${latest.id}）` };
  }
  return { state: 'red', why: `已发布视图与生成结果不一致（comment ${latest.id}）——重新生成并发布` };
}
