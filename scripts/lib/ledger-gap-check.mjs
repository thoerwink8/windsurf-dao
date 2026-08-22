// scripts/lib/ledger-gap-check.mjs —— 账本断流差集（#581）
//
// 判据是集合差，不是时钟：GitHub 已合并带 model/*+type/* 的 PR 号
// 减去账本 job.closed 的 pr_number。禁 Date.now。
// 时序缓冲用序数：对照集合去掉最新 1 个已合并带标 PR。
// 基准线：只管 baselinePr 之后的单，避免历史空白上线即长红。
//
// 本检查自己 JSON.parse 事件文件、自己抽 GitHub 标签，不调用 event-writer
// （检查逻辑不得复用被检查对象自己的解析逻辑）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 只管这个号之后的已合并带标单。
 * 584→590（#591 追加③）：#585 #587 #590 缺 closed 的成因是常驻 flow 跑旧代码
 * （#595 ①），机械闸已随 #596 上线；#597 手工 squash 后新代码正确写入 closed。
 * 再推必须同时有「成因已修」和「新代码实证会写」——缺一条就是掩盖。
 */
export const LEDGER_GAP_BASELINE_PR = 590;
export const LEDGER_GAP_NEWEST_BUFFER = 1;
/** 推 baseline 收进去的存量缺口。不对照，但输出必须点名，不许静默消失。 */
export const LEDGER_GAP_HISTORICAL_GAPS = [585, 587, 590];
/** 基准之上但确认无法回填的存量（2026-08-22 清零收口核定）：这些单的 model/* 标签写的是
 *  工具/未注册模型（pi、cursor、composer-2.5-fast），backfill「不落幽灵账」设计性跳过；
 *  改标签=伪造历史记录，不取。豁免进差集，但输出必须点名，不许静默消失。 */
export const LEDGER_GAP_UNBACKFILLABLE = [659, 662, 709, 711, 741];

export function labelNames(pr) {
  return (pr && pr.labels ? pr.labels : []).map(l => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
}

export function isLabeledMergedPr(pr) {
  if (!pr || typeof pr.number !== 'number') return false;
  const names = labelNames(pr);
  return names.some(n => n.startsWith('model/')) && names.some(n => n.startsWith('type/'));
}

export function labeledMergedNumbers(prs) {
  return (prs || []).filter(isLabeledMergedPr).map(pr => pr.number);
}

/** 自己扫目录 JSON.parse，不走 event-writer。损坏文件记 unscanned，不当 0。 */
export function readClosedPrNumbers(eventsDir) {
  if (!existsSync(eventsDir)) {
    return { unscanned: true, error: `账本目录不在：${eventsDir}`, numbers: new Set() };
  }
  const files = readdirSync(eventsDir).filter(f => f.endsWith('.json'));
  const numbers = new Set();
  const bad = [];
  for (const f of files) {
    try {
      const e = JSON.parse(readFileSync(join(eventsDir, f), 'utf8'));
      if (e && e.type === 'job.closed' && Number.isInteger(e.pr_number) && e.pr_number > 0) {
        numbers.add(e.pr_number);
      }
    } catch {
      bad.push(f);
    }
  }
  if (bad.length) {
    return { unscanned: true, error: `${bad.length} 个事件不是 JSON（${bad.slice(0, 3).join(',')}）`, numbers };
  }
  return { unscanned: false, numbers };
}

export function closedPrNumbersFromEvents(events) {
  const numbers = new Set();
  for (const e of events || []) {
    if (e && e.type === 'job.closed' && Number.isInteger(e.pr_number) && e.pr_number > 0) {
      numbers.add(e.pr_number);
    }
  }
  return numbers;
}

export function historicalGapNote(baselinePr = LEDGER_GAP_BASELINE_PR) {
  if (Number(baselinePr) !== LEDGER_GAP_BASELINE_PR) return '';
  return `存量缺口 ${LEDGER_GAP_HISTORICAL_GAPS.map(n => `#${n}`).join(' ')}（baseline #${LEDGER_GAP_BASELINE_PR} 之前不对照；成因是常驻 flow 跑旧代码，#596 已闸，#597 实证新代码会写 closed）`;
}

/**
 * @returns {{
 *   kind: 'empty-github'|'ok'|'gap',
 *   missing: number[],
 *   checked: number[],
 *   labeled: number[],
 *   historicalNote: string,
 *   line: string
 * }}
 */
export function inspectLedgerGap({
  githubPrs,
  closedNumbers,
  baselinePr = LEDGER_GAP_BASELINE_PR,
  newestBuffer = LEDGER_GAP_NEWEST_BUFFER,
  unbackfillable = LEDGER_GAP_UNBACKFILLABLE,
} = {}) {
  const labeled = [...new Set(labeledMergedNumbers(githubPrs))].sort((a, b) => a - b);
  const afterBaseline = labeled.filter(n => n > baselinePr);
  const note = historicalGapNote(baselinePr);
  if (afterBaseline.length === 0) {
    return {
      kind: 'empty-github',
      missing: [],
      checked: [],
      labeled,
      historicalNote: note,
      line: `账本断流：基准 PR #${baselinePr} 之后 0 个已合并带标 PR——没扫到样本，不是绿`,
    };
  }
  const buf = Number.isInteger(newestBuffer) && newestBuffer > 0 ? newestBuffer : 0;
  const checked = buf > 0 ? afterBaseline.slice(0, Math.max(0, afterBaseline.length - buf)) : afterBaseline;
  const closed = closedNumbers instanceof Set ? closedNumbers : new Set(closedNumbers || []);
  const exempt = new Set(unbackfillable || []);
  const missingAll = checked.filter(n => !closed.has(n));
  const exempted = missingAll.filter(n => exempt.has(n));
  const missing = missingAll.filter(n => !exempt.has(n));
  const exemptBit = exempted.length
    ? `；豁免点名 ${exempted.map(n => `#${n}`).join(' ')}（标签写工具/未注册模型，不落幽灵账不回填）`
    : '';
  if (checked.length === 0) {
    return {
      kind: 'ok',
      missing: [],
      checked,
      labeled,
      historicalNote: note,
      line: `账本断流：基准 #${baselinePr} 之后 ${afterBaseline.length} 个带标单均在序数缓冲内（最新 ${buf} 个不对照），差集空`,
    };
  }
  if (missing.length) {
    return {
      kind: 'gap',
      missing,
      exempted,
      checked,
      labeled,
      historicalNote: note,
      line: `账本断流：已合并带标但无 job.closed：${missing.map(n => `#${n}`).join(' ')}（对照 ${checked.length} 个，缓冲最新 ${buf} 个）${exemptBit}`,
    };
  }
  return {
    kind: 'ok',
    missing: [],
    exempted,
    checked,
    labeled,
    historicalNote: note,
    line: `账本断流：对照 ${checked.length} 个已合并带标 PR，差集空（基准 #${baselinePr}，缓冲最新 ${buf} 个）${exemptBit}`,
  };
}
