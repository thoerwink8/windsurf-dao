#!/usr/bin/env node
// scripts/stage-board.mjs —— T44：版本视图与伞单索引的生成、一致性检查与发布。
//
//   node scripts/stage-board.mjs            # 人读报告：生成两份投影，与已发布评论比一致性（三态）
//   node scripts/stage-board.mjs --json     # 机器读
//   node scripts/stage-board.mjs --render   # 只打印两份生成正文（不查已发布）
//   node scripts/stage-board.mjs --write    # 重新生成并发布（走 issue 网关的 comment-upsert）
//
// 判据全在 scripts/lib/stage-board.mjs（纯函数，单测覆盖）；本文件只负责取数：
//   · 里程碑清单 + 当前版本里程碑里的 issue（状态/标签/里程碑三根原生轴）
//   · 版本单（#1460）与伞单（#816）上已发布的评论
//
// 三态：绿 / 红 / 没查成。**没查成不许当绿**（gh 取不到、评论没发布都算没查成）。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderStageView, renderUmbrellaIndex, judgePostedConsistency, stageViewMarker, UMBRELLA_MARKER,
} from './lib/stage-board.mjs';
import { issueCommentUpsert } from './lib/issue-gateway.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.DAO_STAGE_REPO || 'thoerwink8/windsurf-dao';
const UMBRELLA_ISSUE = 816;

function gh(args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'gh-as.mjs'), 'marshal', '--', ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return { ok: false, error: String(r.stderr || r.stdout || '').trim().slice(0, 140) };
  return { ok: true, out: String(r.stdout || '') };
}

function ghJson(args) {
  const r = gh(args);
  if (!r.ok) return r;
  try { return { ok: true, json: JSON.parse(r.out) }; } catch { return { ok: false, error: `不是 JSON：${r.out.slice(0, 80)}` }; }
}

function loadStage(stage) {
  try {
    return { ok: true, doc: JSON.parse(readFileSync(join(ROOT, 'docs', 'stages', `${stage}.json`), 'utf8')) };
  } catch (e) {
    return { ok: false, error: `读 docs/stages/${stage}.json 失败：${String(e.message || e).slice(0, 120)}` };
  }
}

function build(stage, doc) {
  const ms = ghJson(['api', `repos/${REPO}/milestones?state=all&per_page=100`]);
  if (!ms.ok) return { ok: false, error: `里程碑清单没查成：${ms.error}` };
  const milestone = doc.milestone;
  const hit = (ms.json || []).find((m) => m && m.title === milestone);
  if (!hit) return { ok: false, error: `里程碑清单里没有「${milestone}」——不猜` };

  const issues = ghJson(['issue', 'list', '--state', 'all', '--milestone', milestone, '--json', 'number,title,state,labels,milestone', '--limit', '500']);
  if (!issues.ok) return { ok: false, error: `issue 清单没查成：${issues.error}` };

  const stageIssue = doc.stageIssue;
  const expectedView = renderStageView({ stage, milestone, stageIssue, issues: issues.json, debt: doc.debt });
  const expectedIndex = renderUmbrellaIndex({ stage, stageIssue, stageMilestoneNumber: hit.number, milestones: ms.json });
  return { ok: true, expectedView, expectedIndex, milestoneNumber: hit.number, issueCount: issues.json.length };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const renderOnly = argv.includes('--render');
  const write = argv.includes('--write');
  const i = argv.indexOf('--stage');
  const stage = i >= 0 ? argv[i + 1] : 'v2.11';

  const loaded = loadStage(stage);
  if (!loaded.ok) { console.error(loaded.error); process.exit(1); }
  const doc = loaded.doc;
  if (!doc.milestone || !doc.stageIssue) {
    console.error(`docs/stages/${stage}.json 缺 milestone 或 stageIssue——取不到就明说，不猜`);
    process.exit(1);
  }

  const built = build(stage, doc);
  if (!built.ok) {
    console.error(`阶段盘面：没查成 —— ${built.error}`);
    process.exit(1);
  }

  if (renderOnly) {
    process.stdout.write(`===== 版本视图（发在 #${doc.stageIssue}）=====\n${built.expectedView}\n`);
    process.stdout.write(`===== 伞单索引（发在 #${UMBRELLA_ISSUE}）=====\n${built.expectedIndex}\n`);
    return;
  }

  const checks = [];
  const viewComments = ghJson(['api', `repos/${REPO}/issues/${doc.stageIssue}/comments?per_page=100`]);
  checks.push({
    id: `版本视图 #${doc.stageIssue}`,
    marker: stageViewMarker(stage),
    verdict: viewComments.ok
      ? judgePostedConsistency({ marker: stageViewMarker(stage), expected: built.expectedView, posted: viewComments.json })
      : { state: 'unscanned', why: `评论清单没查成：${viewComments.error}` },
  });
  const umbComments = ghJson(['api', `repos/${REPO}/issues/${UMBRELLA_ISSUE}/comments?per_page=100`]);
  checks.push({
    id: `伞单索引 #${UMBRELLA_ISSUE}`,
    marker: UMBRELLA_MARKER,
    verdict: umbComments.ok
      ? judgePostedConsistency({ marker: UMBRELLA_MARKER, expected: built.expectedIndex, posted: umbComments.json })
      : { state: 'unscanned', why: `评论清单没查成：${umbComments.error}` },
  });

  if (write) {
    const writes = [];
    for (const [issue, body, key] of [
      [doc.stageIssue, built.expectedView, `stage-view-${stage}`],
      [UMBRELLA_ISSUE, built.expectedIndex, `umbrella-index-${stage}`],
    ]) {
      const r = issueCommentUpsert({
        repo: REPO, issue: String(issue), marker: body.match(/<!--\s*(dao-stage-priority:[^>]*?|dao-umbrella-index)\s*-->/)[1],
        body, host: 'devin', idempotency_key: key,
      });
      writes.push({ issue, ok: !!r.ok, updated: !!r.updated, commentId: r.commentId || null, stage: r.stage || null, error: r.error || null });
    }
    if (json) process.stdout.write(`${JSON.stringify({ stage, writes }, null, 2)}\n`);
    else for (const w of writes) process.stdout.write(`${w.ok ? '✓' : '✗'} 发布 #${w.issue}：${w.ok ? (w.updated ? '已更新' : '新建') : `${w.stage}: ${w.error}`}\n`);
    process.exit(writes.every((w) => w.ok) ? 0 : 1);
  }

  const counts = { green: 0, red: 0, unscanned: 0 };
  for (const c of checks) counts[c.verdict.state] += 1;
  const state = counts.red ? 'red' : counts.unscanned ? 'unscanned' : 'green';

  if (json) {
    process.stdout.write(`${JSON.stringify({ stage, milestoneNumber: built.milestoneNumber, issueCount: built.issueCount, state, counts, checks }, null, 2)}\n`);
  } else {
    for (const c of checks) {
      const mark = c.verdict.state === 'green' ? '✓' : c.verdict.state === 'red' ? '✗' : '?';
      process.stdout.write(`${mark} ${c.id} — ${c.verdict.why}\n`);
    }
    process.stdout.write(`\n阶段盘面：绿 ${counts.green} / 红 ${counts.red} / 没查成 ${counts.unscanned}\n`);
    if (counts.unscanned) process.stdout.write('「没查成」不是绿：还没发布或取不到评论，先看为什么（发布用 --write）。\n');
  }
  process.exit(state === 'green' ? 0 : 1);
}

main();
