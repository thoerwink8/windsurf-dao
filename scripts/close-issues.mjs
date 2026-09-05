#!/usr/bin/env node
// scripts/close-issues.mjs —— 关单脚本（issue #657）
//
// 删掉 GitHub `Closes`/`Fixes` 自动关单。关单只认这里：署名 issue 的 PR 已 MERGED
// **且** check 全绿才 `issue close`；合进但 check 红（FAILURE/未完成/无 check/没查成）
// 的不关，若单已关而关它的 PR check 红 → `issue reopen`。没查成 ≠ 绿。
// 判定细节在 scripts/lib/close-issue.mjs。
//
// 生产入口：
//   · node scripts/close-issues.mjs --pr <N>          合并那一刻判一张（commander 的 merge 动作在用）
//   · node scripts/close-issues.mjs --since-hours <H> 补漏：只判「最近 H 小时内合进」的 PR（定时器在用）
//
// 为什么要 --since-hours：2026-08-21 拍板把「唯一生产入口」定为 flow.mjs 合后钩（PR 一合就判这一张），
// 而那个钩子 #807 已删。今天全仓只剩 commander.mjs 的 merge 动作还会调 --pr——**别的路合的 PR
// （人在 GitHub 上点 merge、land.mjs、帅位 gh pr merge）没有任何东西替它关单，延迟是无限大**。
// --since-hours 就是把那个合后钩重建成定时补漏：语义与合后钩一模一样（对每张刚合进的 PR 各判一次），
// 只是发现方式从「合并事件」换成「按合并时间取窗口」。
//
// 它**不是** sweep：sweep 扫全部历史 merged PR（2026-08-21 误重开 58 个远古单的那件事），
// 窗口模式按 mergedAt 卡死上限（MAX_SINCE_HOURS），够不着历史。这条边界是一个会被检查的数字，
// 不是一句命名约定——见 clampSinceHours。
//
// 全量 sweep 制度（含「未经用户当轮授权禁止 agent 跑 sweep」的红线）：
//   docs/decisions/2026-08-21-close-issue-from-zero.md
//
// 用法：
//   node scripts/close-issues.mjs --pr <N>              对单个 PR 判定并关/重开（运维/调试）
//   node scripts/close-issues.mjs --since-hours 6       判最近 6 小时合进的 PR（实跑；定时器用这条）
//   node scripts/close-issues.mjs --since-hours 6 --dry-run   同上但只预览
//   node scripts/close-issues.mjs [--sweep]             扫全部已合并 PR，默认 dry-run（不改 issue）
//   node scripts/close-issues.mjs --sweep --i-know-what-im-doing  实跑 sweep（须留痕说明原因）
//   node scripts/close-issues.mjs --json                输出 JSON 便于脚本消费
//
// 退出码：0 = 全部查成（即使有关/重开动作）；非 0 = 有操作失败（ok:false）或没查成，要报出来。

import { pathToFileURL } from 'node:url';
import { closeIssueForPr } from './lib/close-issue.mjs';
import { ghAs } from './lib/gh.mjs';

const ROOT = process.cwd();
const DECISION = 'docs/decisions/2026-08-21-close-issue-from-zero.md';

// 窗口模式的硬上限。再往上就是 sweep（拍板禁止 agent 自动跑），必须显式走 --sweep --i-know-what-im-doing。
export const MAX_SINCE_HOURS = 72;

// 关/重开 issue 是**帅位的写动作**，必须以 dao-marshal[bot] 身份落。
// 裸 `gh` 走的是用户 thoerwink8 的个人 token：GitHub 历史里「谁关的这张单」会全部记成用户本人，
// 两位帅 + 全部自动化混在同一个名字底下，事后分不清是人拍的还是机器扫的（memory: issues-should-use-marshal-identity）。
// 凭据缺失时 ghAs 直接 fail-loud（「这台机器没装」≠「配置错了」），不退回裸 gh——
// 悄悄退回去就等于这条身份规矩只在装了凭据的机器上生效。
function runGh(args) {
  const r = ghAs('marshal', args, { cwd: ROOT });
  if (!r.ok) return { ok: false, error: String(r.error || 'gh 没跑成').trim().slice(0, 200) };
  let json;
  try { json = JSON.parse(r.out || ''); } catch { return { ok: true, out: r.out || '' }; }
  return { ok: true, json };
}

export function parseArgs(argv) {
  const a = { sweep: false, dryRun: false, json: false, pr: null, limit: 200, iKnowWhatImDoing: false, sinceHours: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--pr') a.pr = argv[++i];
    else if (v === '--sweep') a.sweep = true;
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--json') a.json = true;
    else if (v === '--limit') a.limit = Number(argv[++i]);
    else if (v === '--since-hours') a.sinceHours = Number(argv[++i]);
    else if (v === '--i-know-what-im-doing') a.iKnowWhatImDoing = true;
  }
  return a;
}

/**
 * 窗口大小的闸：1 ≤ H ≤ MAX_SINCE_HOURS，且必须是个数。
 * 这是「补漏」与「sweep」之间唯一的实体边界。把它做成一个会被检查的数字，
 * 是因为命名边界拦不住任何人——`--since-hours 100000` 读起来仍然像补漏，跑起来就是全量 sweep。
 */
export function clampSinceHours(h) {
  const n = Number(h);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: `--since-hours 要正数小时（拿到 ${JSON.stringify(h)}）` };
  }
  if (n > MAX_SINCE_HOURS) {
    return {
      ok: false,
      error: `--since-hours ${n} 超过上限 ${MAX_SINCE_HOURS}——那已经是全量 sweep 了，`
        + `要跑请显式 --sweep --i-know-what-im-doing 并留痕说明原因。见 ${DECISION}`,
    };
  }
  return { ok: true, hours: n };
}

/**
 * sweep 模式 dry-run 强制：无 --i-know-what-im-doing 时禁止实跑改 issue 状态。
 * --pr 与 --since-hours 都**不是** sweep：前者判一张，后者按 mergedAt 卡死窗口（够不着历史），
 * 两者都可以实跑——2026-08-21 拍板禁的是「扫全部历史 merged PR」，不是「关单」本身。
 */
export function enforceSweepPolicy(args) {
  if (args.pr) return { args, notice: null };
  if (args.sinceHours != null) return { args: { ...args, sweep: false }, notice: null };
  const out = { ...args, sweep: true };
  if (!out.iKnowWhatImDoing) {
    out.dryRun = true;
    return {
      args: out,
      notice: `close-issues: sweep 默认 dry-run（不改 issue 状态）。实跑须 --i-know-what-im-doing。见 ${DECISION}`,
    };
  }
  return { args: out, notice: null };
}

function fetchPr(number) {
  const r = runGh(['pr', 'view', String(number), '--json', 'number,title,body,state,statusCheckRollup,mergeCommit,mergedAt']);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, pr: r.json };
}

/** GitHub 搜索串只到「天」，先用它把量砍下来，精确到小时的裁剪交给 selectMergedSince。 */
export function mergedSinceQuery(hours, now = Date.now()) {
  const day = new Date(now - hours * 3600 * 1000).toISOString().slice(0, 10);
  return `merged:>=${day}`;
}

/**
 * 客户端精确裁窗：只留 mergedAt 落在 [now-hours, now] 里的 PR。
 * mergedAt 读不出来的**不当成在窗内**——判不了就不动手，与本脚本「没查成 ≠ 绿」同一条口径。
 */
export function selectMergedSince(prs, { hours, now = Date.now() } = {}) {
  if (!Array.isArray(prs)) return { ok: false, error: 'pr list 不是数组——没查成' };
  const floor = now - hours * 3600 * 1000;
  const picked = [];
  const undated = [];
  for (const p of prs) {
    if (!p || p.number == null) continue;
    const t = Date.parse(p.mergedAt || '');
    if (!Number.isFinite(t)) { undated.push(p.number); continue; }
    if (t >= floor) picked.push(p.number);
  }
  picked.sort((a, b) => a - b);
  return { ok: true, numbers: picked, undated };
}

/**
 * 窗口查询自证：窗口里 0 个 PR 是**常态**（一小时没人合并），不能当异常报；
 * 但「查询本身坏了」返回的也是 0 个，两者长得一模一样。
 * 所以再打一发不带窗口的 `--limit 1`：这个仓一定有已合并 PR，它要是也回 0，就是没查成。
 * 没有这一发，搜索语法哪天被 GitHub 改了，这个定时器会永远绿着、永远不关任何单。
 */
export function classifyWindowScan({ windowed, probeCount }) {
  if (!Array.isArray(windowed)) return { state: 'unscanned', detail: '窗口查询没回数组' };
  if (windowed.length > 0) return { state: 'found', detail: `窗口内 ${windowed.length} 个已合并 PR` };
  if (probeCount == null) return { state: 'unscanned', detail: '窗口 0 个，且自证探针没查成——分不清「没人合并」还是「查询坏了」' };
  if (probeCount === 0) return { state: 'unscanned', detail: '窗口 0 个，且不带窗口也查出 0 个已合并 PR——查询坏了，不是没人合并' };
  return { state: 'zero', detail: '窗口内 0 个已合并 PR（扫完是 0，不是没查成）' };
}

export function main(argv) {
  const { args, notice } = enforceSweepPolicy(parseArgs(argv));
  if (notice && !args.json) console.error(notice);
  const results = [];
  let failed = 0;

  if (args.pr) {
    const f = fetchPr(args.pr);
    if (!f.ok) { console.error(`close-issues: 读 PR #${args.pr} 失败：${f.error}`); process.exit(1); }
    results.push(closeIssueForPr({ pr: f.pr, runGh, dryRun: args.dryRun }));
  } else if (args.sinceHours != null) {
    // 补漏窗口：重建 #807 删掉的合后钩——对每张刚合进的 PR 各判一次。
    const win = clampSinceHours(args.sinceHours);
    if (!win.ok) { console.error(`close-issues: ${win.error}`); process.exit(2); }
    const list = runGh(['pr', 'list', '--state', 'merged', '--search', mergedSinceQuery(win.hours),
      '--limit', String(args.limit), '--json', 'number,mergedAt']);
    if (!list.ok) {
      console.error(`close-issues: 查最近 ${win.hours} 小时合并的 PR 失败：${list.error}`);
      process.exit(1);
    }
    // 自证探针：不带窗口再查一发，把「没人合并」和「查询坏了」分开。
    const probe = runGh(['pr', 'list', '--state', 'merged', '--limit', '1', '--json', 'number']);
    const probeCount = probe.ok && Array.isArray(probe.json) ? probe.json.length : null;
    const scan = classifyWindowScan({ windowed: list.json, probeCount });
    if (scan.state === 'unscanned') {
      console.error(`close-issues: ${scan.detail}`);
      process.exit(1);
    }
    if (scan.state === 'zero') { console.log(`close-issues: ${scan.detail}`); return 0; }
    // 取满 limit = 可能被截断，后面还有没取到的。静默截断是「没查成」装成「查完了」——
    // 窗口里真有那么多合并时，漏掉的那几张会永远没人关，而这一轮照样 exit 0。
    if (Array.isArray(list.json) && list.json.length >= args.limit) {
      console.error(`close-issues: 窗口内取满 ${args.limit} 个（--limit 上限），可能还有没取到的——本轮不算查全`);
      failed += 1;
    }
    const sel = selectMergedSince(list.json, { hours: win.hours });
    if (!sel.ok) { console.error(`close-issues: ${sel.error}`); process.exit(1); }
    if (sel.undated.length) {
      // 读不出合并时间就判不了在不在窗内。不当没事，也不硬判——显形，让人看得见漏了谁。
      console.error(`close-issues: ${sel.undated.length} 个 PR 读不到 mergedAt，本轮跳过（判不了 ≠ 不在窗内）：${sel.undated.map((n) => '#' + n).join(' ')}`);
      failed += 1;
    }
    console.log(`close-issues: 最近 ${win.hours} 小时合进 ${sel.numbers.length} 个 PR，逐张判定`);
    for (const n of sel.numbers) {
      const f = fetchPr(n);
      if (!f.ok) { console.error(`close-issues: 读 PR #${n} 失败：${f.error}`); failed += 1; continue; }
      results.push(closeIssueForPr({ pr: f.pr, runGh, dryRun: args.dryRun }));
    }
  } else {
    const list = runGh(['pr', 'list', '--state', 'merged', '--limit', String(args.limit), '--json', 'number']);
    if (!list.ok) {
      console.error(`close-issues: gh pr list --state merged 失败：${list.error}`);
      process.exit(1);
    }
    const prs = Array.isArray(list.json) ? list.json : [];
    if (prs.length === 0) {
      console.log('close-issues: 0 个已合并 PR，本次等于没查（不是扫完 0 违规）');
      return 0;
    }
    for (const p of prs) {
      const f = fetchPr(p.number);
      if (!f.ok) { console.error(`close-issues: 读 PR #${p.number} 失败：${f.error}`); failed += 1; continue; }
      results.push(closeIssueForPr({ pr: f.pr, runGh, dryRun: args.dryRun }));
    }
  }

  for (const res of results) {
    if (!res.ok) { failed += 1; console.error(`  X ${res.error || '操作失败'}`); continue; }
    if (res.action === 'none') {
      // 署名误中（目标是 PR / 单不存在）不算失败，但要显形——静默跳过会让误中永远藏在水下。
      if (res.reason && /跳过/.test(res.reason)) console.log(`  - PR #${res.pr} ${res.reason}`);
      continue;
    }
    const verb = res.action === 'close' ? 'close' : 'reopen';
    console.log(`  ${res.dryRun ? '[DRY] ' : ''}PR #${res.pr} ${verb} issue #${res.issue}（${res.reason}）`);
  }
  // sweep 用 args.sweep（enforceSweepPolicy 判过），不是 `!args.pr`——窗口模式也没有 --pr，
  // 但它不是 sweep，标错会让读 JSON 的人以为定时器在跑全量扫。
  if (args.json) process.stdout.write(JSON.stringify({ results, failed, dryRun: args.dryRun, sweep: !!args.sweep, sinceHours: args.sinceHours ?? null }, null, 2) + '\n');
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = main(process.argv.slice(2));
  process.exit(code);
}
