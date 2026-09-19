#!/usr/bin/env node
// scripts/break-link.mjs —— T48：断链闸（#1460 的 `[断链]` 评论有没有人管）。
//
//   node scripts/break-link.mjs           # 查：断链评论没有 OPEN 单或显式处置 → 红
//   node scripts/break-link.mjs --json
//
// 判据全在 scripts/lib/break-link-check.mjs（纯函数，单测覆盖）；本文件只取数（两条 gh 只读查询）。
// 退出码三态分得开：0=绿 / 1=红 / 2=没查成。**取不到 ≠ 没有断链。**
//
// 处置怎么写（评论改不了，所以允许后补一条）：
//   · 在同一条里写 `已修：<证据>` / `不修：<理由>` / `已开单：#N` / `起因：<slug>`；
//   · 或在**任何**一条评论里写一行 `断链已处置：<slug> → <结论>`。

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { causeSlugOf } from './lib/cause-slug-check.mjs';
import { judgeBreakLinks } from './lib/break-link-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.DAO_BREAK_REPO || 'thoerwink8/windsurf-dao';
const TRACKING_ISSUE = process.env.DAO_BREAK_ISSUE || '1460';

function ghJson(args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'gh-as.mjs'), 'marshal', '--', ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return { ok: false, error: String(r.stderr || r.stdout || '').trim().slice(0, 140) };
  try { return { ok: true, json: JSON.parse(String(r.stdout || '')) }; } catch { return { ok: false, error: `不是 JSON：${String(r.stdout).slice(0, 80)}` }; }
}

const argv = process.argv.slice(2);
const json = argv.includes('--json');

const comments = ghJson(['api', `repos/${REPO}/issues/${TRACKING_ISSUE}/comments?per_page=100`]);
const open = ghJson(['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,body']);

const verdict = !comments.ok
  ? { state: 'unscanned', breaks: 0, unresolved: [], why: `#${TRACKING_ISSUE} 评论没取到：${comments.error}` }
  : !open.ok
    ? { state: 'unscanned', breaks: 0, unresolved: [], why: `OPEN 单列表没取到：${open.error}` }
    : judgeBreakLinks({
      comments: comments.json,
      openNumbers: new Set((open.json || []).map((i) => i.number)),
      openSlugs: new Set((open.json || []).map((i) => causeSlugOf(i.body)).filter(Boolean)),
    });

if (json) process.stdout.write(`${JSON.stringify({ repo: REPO, trackingIssue: Number(TRACKING_ISSUE), verdict }, null, 2)}\n`);
else {
  const mark = verdict.state === 'green' ? '✓' : verdict.state === 'red' ? '✗' : '?';
  process.stdout.write(`${mark} 断链闸 — ${verdict.why}\n`);
  for (const u of verdict.unresolved || []) process.stdout.write(`   ${u.slug ? `起因 ${u.slug}` : '（无 slug）'}：${u.why}${u.url ? `（${u.url}）` : ''}\n`);
}
process.exit(verdict.state === 'green' ? 0 : verdict.state === 'red' ? 1 : 2);
