// dao-check 第 ⑭ 项：open 未在做单数量阈值（#556 / #564 / #966）
//
// 单独成文件：tests / 夹具喂样本验判别力，不必跑整个 dao-check（会递归）。
// 署名正则是本检查自己的，不调用 dao-cmd；推迟档认 isDeferredIssue（#966 共用件）。
// 快档 live 不出网，所以红/绿夹具必须能单独证明：超阈会拦、将来某版不进分母。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeferredIssue } from './ready-queue-check.mjs';

/** PR/标题/正文里的署名 issue 号（新规范「署名 issue #N」+ 旧 GitHub 关闭关键词）。 */
export function closesNumbers(text) {
  const found = [];
  const re = /署名\s+issue\s*#?\s*(\d+)|(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const t = Number(m[1] ?? m[2]);
    if (Number.isInteger(t) && !found.includes(t)) found.push(t);
  }
  return found;
}

function cardNumbersFrom(worktrees) {
  const cards = [];
  for (const w of worktrees || []) {
    if (!w || w.isMainWorktree || w.isArchived) continue;
    const name = String(w.displayName || '');
    const linked = typeof w.linkedIssue === 'number' ? w.linkedIssue
      : (w.linkedIssue && typeof w.linkedIssue.number === 'number' ? w.linkedIssue.number : null);
    const zone = String(w.comment || '').match(/｜\[([^\]]*)\]/);
    const zoneN = zone && zone[1].match(/#(\d+)/);
    const issueName = name.match(/ISSUE-#?(\d+)/);
    const oldName = name.match(/^#(\d+)/);
    const n = linked || (zoneN ? Number(zoneN[1]) : null) || (issueName ? Number(issueName[1]) : null)
      || (oldName ? Number(oldName[1]) : null);
    if (n) cards.push(n);
  }
  return cards;
}

/**
 * @param {{
 *   issues?: { unscanned?: boolean, error?: string, array?: unknown[] },
 *   prs?: { unscanned?: boolean, error?: string, array?: unknown[] },
 *   worktrees?: { unscanned?: boolean, error?: string, worktrees?: unknown[] },
 *   max?: number,
 *   maxRaw?: string,
 * }} board
 * @returns {{
 *   kind: 'unscanned'|'invalid'|'red'|'ok',
 *   line: string,
 *   n?: number,
 *   max?: number,
 *   open?: number,
 *   inPr?: number,
 *   inCard?: number,
 *   backlog?: number[],
 *   howToFix?: string,
 *   evidence?: string,
 * }}
 */
export function inspectOpenIssueCount({ issues, prs, worktrees, max, maxRaw } = {}) {
  if (!Number.isFinite(max) || max < 0) {
    return {
      kind: 'invalid',
      line: 'open 单阈值没查成',
      howToFix: `DAO_CHECK_OPEN_ISSUE_MAX 不是非负数: ${maxRaw !== undefined ? maxRaw : max}`,
    };
  }
  if (issues && issues.unscanned) {
    return {
      kind: 'unscanned',
      line: `open 单数量阈值：gh issue list 没查成（${issues.error}），本次没查成，不是绿`,
    };
  }
  if (prs && prs.unscanned) {
    return {
      kind: 'unscanned',
      line: `open 单数量阈值：open PR 面没查成（${prs.error}）——在途排除做不全，不是绿`,
    };
  }
  if (worktrees && worktrees.unscanned) {
    return {
      kind: 'unscanned',
      line: 'open 单数量阈值：worktree 卡面没查成（orca 不可用或输出畸形）——少这张卡面会把在途单算成积压，本次没查成，不是绿',
    };
  }

  const issueArr = issues && Array.isArray(issues.array) ? issues.array : null;
  const prArr = prs && Array.isArray(prs.array) ? prs.array : null;
  const wtArr = worktrees && Array.isArray(worktrees.worktrees) ? worktrees.worktrees : null;
  if (!issueArr || !prArr || !wtArr) {
    return {
      kind: 'invalid',
      line: 'open 单数量没查成',
      howToFix: 'issues/prs/worktrees 面不完整（要 {array}/{array}/{worktrees}）',
    };
  }

  const cards = cardNumbersFrom(wtArr);
  const inPr = new Set();
  for (const p of prArr) {
    for (const n of closesNumbers(`${p.title || ''}\n${p.body || ''}`)) inPr.add(n);
  }
  const inCard = new Set(cards);
  if (issueArr.some(i => !i || typeof i.number !== 'number')) {
    return {
      kind: 'invalid',
      line: 'open 单数量没查成',
      howToFix: 'gh issue list 输出形态不对（要 number 对象数组）',
      evidence: `拿到 ${typeof issueArr[0]}`,
    };
  }
  // #966：挂「将来某版」的单保持 OPEN 以便一次列全，但不算当前待办——不进积压阈值。
  const backlog = issueArr.filter(i => !inPr.has(i.number) && !inCard.has(i.number) && !isDeferredIssue(i));
  const n = backlog.length;
  const open = issueArr.length;
  if (n > max) {
    return {
      kind: 'red',
      n,
      max,
      open,
      inPr: inPr.size,
      inCard: inCard.size,
      backlog: backlog.map(i => i.number),
      line: `open 未在做单 ${n} 张，超阈值 ${max}（共 ${open} 张 open，${inPr.size} 张有在途 PR、${inCard.size} 张有本地卡）`,
      howToFix: '过一遍 ideas 分流：每张单答开单三问（#556），排不上队的转 docs/ideas.md',
      evidence: 'gh issue list --state open --limit 500 --json number,title,body',
    };
  }
  return {
    kind: 'ok',
    n,
    max,
    open,
    inPr: inPr.size,
    inCard: inCard.size,
    backlog: backlog.map(i => i.number),
    line: `open 未在做单 ${n}/${max}（共 ${open} 张 open，在途排除：PR ${inPr.size} 张 / 卡 ${inCard.size} 张）`,
  };
}

function boardFromFixture(doc) {
  return {
    issues: { array: doc.issues },
    prs: { array: doc.prs },
    worktrees: { worktrees: doc.worktrees },
    max: doc.max,
  };
}

/**
 * 夹具判别力：至少一份超阈红、一份「将来某版不进分母所以绿」。
 * 0 个样本 = 没查成，不是绿。
 */
export function inspectOpenIssueCountFixtures(root) {
  if (!root) return { ok: false, unscanned: true, error: '没给样本根目录' };
  if (!existsSync(root)) return { ok: false, unscanned: true, error: `样本目录不在：${root}` };
  const files = readdirSync(root).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) {
    return { ok: false, unscanned: true, error: '一套样本都没扫到', kinds: { red: 0, ok: 0 }, problems: [] };
  }
  const kinds = { red: 0, ok: 0 };
  const problems = [];
  const results = [];
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(join(root, f), 'utf8')); }
    catch { problems.push(`${f} 不是 JSON`); continue; }
    if (!doc || !Array.isArray(doc.issues) || !Array.isArray(doc.prs) || !Array.isArray(doc.worktrees)
      || !('max' in doc) || (doc.expect !== 'red' && doc.expect !== 'ok')) {
      problems.push(`${f} 缺 issues/prs/worktrees/max/expect(red|ok)`);
      continue;
    }
    const r = inspectOpenIssueCount(boardFromFixture(doc));
    kinds[doc.expect] += 1;
    results.push({ file: f, expect: doc.expect, got: r });
    if (doc.expect === 'red' && r.kind !== 'red') {
      problems.push(`${f} 自称超阈红但判成 ${r.kind}：${r.line}`);
    }
    if (doc.expect === 'ok' && r.kind !== 'ok') {
      problems.push(`${f} 自称绿但判成 ${r.kind}：${r.line}`);
    }
    if (Number.isInteger(doc.expectN) && r.n !== doc.expectN) {
      problems.push(`${f} 分母该是 ${doc.expectN} 却是 ${r.n}（推迟档进没进分母）`);
    }
  }
  if (kinds.red === 0 || kinds.ok === 0) {
    return {
      ok: false,
      unscanned: true,
      error: `样本种类不够 red=${kinds.red} ok=${kinds.ok}（要超阈红 + 推迟不进分母的绿）`,
      kinds,
      problems,
      results,
    };
  }
  if (problems.length) {
    return { ok: false, unscanned: false, error: problems[0], kinds, problems, results };
  }
  return { ok: true, unscanned: false, kinds, results };
}
