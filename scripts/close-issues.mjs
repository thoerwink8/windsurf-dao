#!/usr/bin/env node
// scripts/close-issues.mjs —— 关单脚本（issue #657）
//
// 删掉 GitHub `Closes`/`Fixes` 自动关单。关单只认这里：署名 issue 的 PR 已 MERGED
// **且** check 全绿才 `issue close`；合进但 check 红（FAILURE/未完成/无 check/没查成）
// 的不关，若单已关而关它的 PR check 红 → `issue reopen`。没查成 ≠ 绿。
// 相对绿：PR 硬红项全属「合并时 master 基线硬红」（基线确实查成）也视为可关，
// 判定细节在 scripts/lib/close-issue.mjs 头注。
//
// 可手动跑，也可由合后钩 / watchdog 定期挂（本仓 production 合后钩在
// scripts/flow.mjs 的 MERGED 退役处理里调用 closeIssueForPr）。
//
// 用法：
//   node scripts/close-issues.mjs --pr <N>         对单个 PR 判定并关/重开
//   node scripts/close-issues.mjs                  扫已合并 PR 逐一判定（默认 --sweep）
//   node scripts/close-issues.mjs --sweep --limit 200 --dry-run  预览，不动 issue
//   node scripts/close-issues.mjs --json           输出 JSON 便于脚本消费
//
// 退出码：0 = 全部查成（即使有关/重开动作）；非 0 = 有操作失败（ok:false），要报出来。

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { closeIssueForPr } from './lib/close-issue.mjs';

const ROOT = process.cwd();

function runGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', cwd: ROOT, timeout: 30000 });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return { ok: false, error: String(r.error?.message || r.stderr || `gh exit ${r.status}`).trim().slice(0, 200) };
  }
  let json;
  try { json = JSON.parse(r.stdout || ''); } catch { return { ok: true, out: r.stdout || '' }; }
  return { ok: true, json };
}

function parseArgs(argv) {
  const a = { sweep: false, dryRun: false, json: false, pr: null, limit: 200 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--pr') a.pr = argv[++i];
    else if (v === '--sweep') a.sweep = true;
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--json') a.json = true;
    else if (v === '--limit') a.limit = Number(argv[++i]);
  }
  return a;
}

function fetchPr(number) {
  const r = runGh(['pr', 'view', String(number), '--json', 'number,title,body,state,statusCheckRollup,mergeCommit']);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, pr: r.json };
}

function main(argv) {
  const args = parseArgs(argv);
  const results = [];
  let failed = 0;

  if (args.pr) {
    const f = fetchPr(args.pr);
    if (!f.ok) { console.error(`close-issues: 读 PR #${args.pr} 失败：${f.error}`); process.exit(1); }
    results.push(closeIssueForPr({ pr: f.pr, runGh, dryRun: args.dryRun }));
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
    if (res.action === 'none') continue;
    const verb = res.action === 'close' ? 'close' : 'reopen';
    console.log(`  ${res.dryRun ? '[DRY] ' : ''}PR #${res.pr} ${verb} issue #${res.issue}（${res.reason}）`);
  }
  if (args.json) process.stdout.write(JSON.stringify({ results, failed }, null, 2) + '\n');
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = main(process.argv.slice(2));
  process.exit(code);
}
