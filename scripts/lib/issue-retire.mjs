// scripts/lib/issue-retire.mjs —— 落后单的机械清退（用户 2026-09-19：「以后落后都要有机制清退，
// 而不是人工肉眼」）。与「清单退场闸（联动退出）」同精神，但管的是**单张 issue 的落后**。
//
// 两段式，纯函数、配置驱动：
//   ① 闲置 ≥ warnIdleDays → 进「待清退」名单（打标签，不关）；
//   ② 已带「待清退」且闲置 ≥ retireIdleDays → 判**清退**。
// 三态：绿 / 红 / 没查成。**没查成不许当绿**（取不到 issue/PR 面就不许说「没有落后单」）。
//
// 阈值是**配置**不是常量：`docs/release-policy.json` 的 `retire` 段（缺省值在这里）。

import { milestoneTitleOf } from './ready-queue-check.mjs';

export const RETIRE_DEFAULTS = Object.freeze({
  warnIdleDays: 14,
  retireIdleDays: 30,
  label: '待清退',
  exemptMilestones: ['将来某版'],
  exemptPriorities: ['priority/P0'],
  exemptIssues: [816, 1460],
});

export function labelNames(issue) {
  if (!issue || !Array.isArray(issue.labels)) return [];
  return issue.labels.map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
}

/** PR 认领的 issue 号（「署名 issue #N」+ GitHub 关闭关键词）。本检查自己解析，不借别的检查的解析器。 */
export function claimedIssueNumbers(pr) {
  const text = `${pr && pr.title || ''}\n${pr && pr.body || ''}`;
  const found = [];
  const re = /署名\s+issue\s*#?\s*(\d+)|(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/gi;
  let m;
  while ((m = re.exec(text))) {
    const n = Number(m[1] ?? m[2]);
    if (Number.isInteger(n) && !found.includes(n)) found.push(n);
  }
  return found;
}

const days = (ms) => ms / 86400000;

/**
 * @param {{ issues?: unknown[], prs?: unknown[], config?: object, now?: number }} input
 * @returns {{ state:'green'|'red'|'unscanned', why:string, warn?:object[], retire?:object[], exempt?:object[] }}
 */
export function judgeIssueStaleness({ issues, prs, config, now } = {}) {
  if (!Array.isArray(issues)) return { state: 'unscanned', why: 'issue 清单没查成（取不到 ≠ 没有落后单）' };
  if (!Array.isArray(prs)) return { state: 'unscanned', why: 'PR 面没查成（在途认领查不全，不许当没在途）' };
  if (!Number.isFinite(now)) return { state: 'unscanned', why: 'now 没给（算不出闲置天数）' };
  const cfg = { ...RETIRE_DEFAULTS, ...(config || {}) };

  const claimed = new Set();
  for (const p of prs) for (const n of claimedIssueNumbers(p)) claimed.add(n);

  const warn = [], retire = [], exempt = [];
  for (const it of issues) {
    const num = it && it.number;
    if (!Number.isInteger(num)) return { state: 'unscanned', why: 'issue 输出形态不对（要带 number）' };
    const labels = labelNames(it);
    const reasons = [];
    if ((cfg.exemptIssues || []).includes(num)) reasons.push('容器（伞单/版本单）');
    if ((cfg.exemptMilestones || []).includes(milestoneTitleOf(it))) reasons.push('挂「将来某版」（明确顺延）');
    if (labels.some((l) => (cfg.exemptPriorities || []).includes(l))) reasons.push('P0（在做）');
    if (claimed.has(num)) reasons.push('有在途 PR 认领');
    if (reasons.length) { exempt.push({ number: num, why: reasons.join('、') }); continue; }

    const t = Date.parse(it.updatedAt || '');
    if (!Number.isFinite(t)) return { state: 'unscanned', why: `#${num} 的 updatedAt 读不到（算不出闲置）` };
    const idleDays = days(now - t);
    if (labels.includes(cfg.label) && idleDays >= cfg.retireIdleDays) {
      retire.push({ number: num, idleDays: Math.round(idleDays) });
    } else if (idleDays >= cfg.warnIdleDays) {
      warn.push({ number: num, idleDays: Math.round(idleDays) });
    }
  }

  if (retire.length) {
    return {
      state: 'red',
      warn,
      retire,
      exempt,
      why: `${retire.length} 张单闲置超 ${cfg.retireIdleDays} 天且已标「${cfg.label}」，该清退（${retire.map((r) => `#${r.number}`).join(' ')}）`,
    };
  }
  return {
    state: 'green',
    warn,
    retire,
    exempt,
    why: warn.length
      ? `没有该清退的；${warn.length} 张闲置超 ${cfg.warnIdleDays} 天进「待清退」观察（${warn.map((r) => `#${r.number}`).join(' ')}）`
      : `没有落后单（豁免 ${exempt.length} 张）`,
  };
}
