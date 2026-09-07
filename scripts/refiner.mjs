#!/usr/bin/env node
// scripts/refiner.mjs —— 消歧官驱动层（#1006）
//
// 判定在 scripts/lib/refine-core.mjs（纯函数）。本文件只做 IO：
//   读开放单 → 读评论 → 喂给 planRound → 按判决打标 / 评论 / 三行摘要推用户。
//
// 默认身份 marshal（指挥官今天打标走的就是它）。--as <role> 预留给日后 dao-refiner[bot]。
// GitHub 读失败必须报「没查成」并非 0 退出——不许当成「这轮 0 张待消歧」。
//
// 用法：
//   node scripts/refiner.mjs                 实跑一轮
//   node scripts/refiner.mjs --dry-run       只预览，不打标、不评论、不推群
//   node scripts/refiner.mjs --json          机器可读
//   node scripts/refiner.mjs --as marshal    换身份（默认 marshal）
//
// 退出码：0 查成（含真的 0 张） / 1 写下失败 / 2 没查成

import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ghAs, ROLES } from './lib/gh.mjs';
import { loadRoutingJsonRaw, modelsFromJson } from './lib/model-routing-json.mjs';
import { ensureRepoLabels } from './lib/dispatch/card.mjs';
import { ensurePlain } from './lib/plain-words.mjs';
import {
  planRound, VERDICT, FRAMEWORK_ROLE,
} from './lib/refine-core.mjs';
import { recordBroadcast } from './lib/broadcast-io.mjs';

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), '..');
export const DEFAULT_LIMIT = 200;
export const DEFAULT_AS = 'marshal';

export function parseArgs(argv) {
  const a = { dryRun: false, json: false, as: DEFAULT_AS, limit: DEFAULT_LIMIT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--dry-run') a.dryRun = true;
    else if (v === '--json') a.json = true;
    else if (v === '--help' || v === '-h') a.help = true;
    else if (v === '--as') a.as = String(argv[++i] || '').trim();
    else if (v === '--limit') a.limit = Number(argv[++i]);
  }
  return a;
}

export function helpText() {
  return [
    '消歧官：给「已消歧」这道只有读没有写的闸补上执行者。',
    '',
    '  node scripts/refiner.mjs                 实跑一轮',
    '  node scripts/refiner.mjs --dry-run       只预览',
    '  node scripts/refiner.mjs --json          JSON 输出',
    '  node scripts/refiner.mjs --as marshal    身份（默认 marshal；预留给日后 dao-refiner）',
    '',
    '退出码：0 查成 / 1 写下失败 / 2 没查成（读 GitHub 失败不是 0 张）。',
  ].join('\n');
}

function parseJson(out, what) {
  try {
    return { ok: true, value: JSON.parse(out || '') };
  } catch {
    return { ok: false, error: `${what} 返回不是 JSON——没查成` };
  }
}

/** 读开放单。失败与「0 张」必须分得开。 */
export function loadOpenIssues(runGh, { limit = DEFAULT_LIMIT } = {}) {
  if (typeof runGh !== 'function') {
    return { ok: false, unscanned: true, error: '没拿到 gh 执行器——没查成' };
  }
  const n = Number(limit);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, unscanned: true, error: `--limit 要正整数（拿到 ${JSON.stringify(limit)}）` };
  }
  const r = runGh(['issue', 'list', '--state', 'open', '--limit', String(n), '--json', 'number,title,body,labels']);
  if (!r.ok) {
    return {
      ok: false, unscanned: true,
      error: `GitHub 读开放单失败——没查成，不是 0 张待消歧：${r.error || 'gh 没跑成'}`,
    };
  }
  const parsed = parseJson(r.out, 'gh issue list');
  if (!parsed.ok) return { ok: false, unscanned: true, error: parsed.error };
  if (!Array.isArray(parsed.value)) {
    return { ok: false, unscanned: true, error: 'gh issue list 契约变了（不是数组）——没查成' };
  }
  return { ok: true, issues: parsed.value };
}

/** 一张单的评论。失败不许当「没有评论」。 */
export function loadComments(runGh, number) {
  if (typeof runGh !== 'function') {
    return { ok: false, unscanned: true, error: '没拿到 gh 执行器——没查成' };
  }
  const r = runGh(['issue', 'view', String(number), '--json', 'comments']);
  if (!r.ok) {
    return {
      ok: false, unscanned: true,
      error: `GitHub 读 #${number} 评论失败——没查成：${r.error || 'gh 没跑成'}`,
    };
  }
  const parsed = parseJson(r.out, `gh issue view #${number}`);
  if (!parsed.ok) return { ok: false, unscanned: true, error: parsed.error };
  const comments = parsed.value && parsed.value.comments;
  if (!Array.isArray(comments)) {
    return { ok: false, unscanned: true, error: `#${number} 评论字段不是列表——没查成` };
  }
  return { ok: true, comments };
}

export function defaultSay(text) {
  const line = String(text || '');
  if (!line) return { ok: true, skipped: true };
  const r = recordBroadcast(line, { source: 'refiner', now: new Date() });
  if (!r.ok) return { ok: false, error: `推给用户没成：${r.error}` };
  return { ok: true, queued: true, messageId: r.messageId };
}

function commentViaFile(runGh, number, body) {
  const file = join(tmpdir(), `dao-refiner-${number}-${process.pid}.md`);
  try {
    writeFileSync(file, body, 'utf8');
    const r = runGh(['issue', 'comment', String(number), '--body-file', file]);
    if (!r.ok) return { ok: false, error: `#${number} 写评论失败：${r.error || 'gh 没跑成'}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `#${number} 写评论失败：${String(e.message || e).slice(0, 160)}` };
  } finally {
    try { unlinkSync(file); } catch { /* 临时文件清不掉不挡主结果 */ }
  }
}

export function applyPlan(plan, { runGh, dryRun } = {}) {
  if (!plan || plan.verdict === VERDICT.skip) return { ok: true, skipped: true };
  const n = plan.number;
  const writes = [];
  if (dryRun) {
    return { ok: true, dryRun: true, labelsToAdd: plan.labelsToAdd || [], comment: !!plan.comment };
  }
  if ((plan.labelsToAdd || []).length) {
    const ensured = ensureRepoLabels({ names: plan.labelsToAdd, runGh });
    if (!ensured.ok) {
      return { ok: false, error: `#${n} 建标失败：${ensured.error || '没查成'}` };
    }
    const add = [];
    for (const name of plan.labelsToAdd) add.push('--add-label', name);
    const r = runGh(['issue', 'edit', String(n), ...add]);
    if (!r.ok) return { ok: false, error: `#${n} 打标失败：${r.error || 'gh 没跑成'}` };
    writes.push('labels');
  }
  if (plan.comment) {
    const c = commentViaFile(runGh, n, plan.comment);
    if (!c.ok) return c;
    writes.push('comment');
  }
  return { ok: true, writes };
}

/**
 * 一轮。deps 全注入：runGh / say / routingDoc。测试不许打网。
 * 读失败整轮不作数，一个写动作都不做。
 */
export function runRefiner({
  args = {},
  runGh,
  say = defaultSay,
  routingDoc,
  models,
} = {}) {
  if (args.as && !ROLES.includes(args.as)) {
    return {
      scanned: false, exit: 2,
      error: `--as ${args.as} 不是已装身份（现认 ${ROLES.join('/')}；日后 dao-refiner 加进身份表再切）`,
    };
  }
  const loaded = loadOpenIssues(runGh, { limit: args.limit });
  if (!loaded.ok) {
    return { scanned: false, exit: 2, error: loaded.error };
  }
  let doc = routingDoc;
  let modelRecords = models;
  if (doc == null) {
    try { doc = loadRoutingJsonRaw(); }
    catch (e) {
      return { scanned: false, exit: 2, error: `选型 JSON 没查成：${String(e.message || e).slice(0, 160)}` };
    }
  }
  if (modelRecords == null) {
    try { modelRecords = modelsFromJson(doc); }
    catch (e) {
      return { scanned: false, exit: 2, error: `选型模型表没查成：${String(e.message || e).slice(0, 160)}` };
    }
  }

  // 先粗分：体系单不读评论。其余必须评论查成才许写。
  const commentsByNumber = {};
  for (const issue of loaded.issues) {
    const names = Array.isArray(issue?.labels)
      ? issue.labels.map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean)
      : null;
    if (names == null) {
      return { scanned: false, exit: 2, error: `#${issue && issue.number} labels 不是列表——没查成` };
    }
    const type = names.find((n) => n.startsWith('type/'));
    if (type === `type/${FRAMEWORK_ROLE}`) continue;
    if (names.includes('已消歧') || names.includes('待消歧')) continue;
    const c = loadComments(runGh, issue.number);
    if (!c.ok) return { scanned: false, exit: 2, error: c.error };
    commentsByNumber[issue.number] = c.comments;
  }

  const round = planRound({
    issues: loaded.issues,
    commentsByNumber,
    routingDoc: doc,
    models: modelRecords,
  });
  if (!round.scanned) {
    return { scanned: false, exit: 2, error: round.error, skipped: round.skipped };
  }

  const applied = [];
  for (const plan of round.plans) {
    const r = applyPlan(plan, { runGh, dryRun: args.dryRun === true });
    if (!r.ok) {
      return {
        scanned: true, exit: 1, error: r.error, plans: round.plans, applied, skipped: round.skipped,
      };
    }
    applied.push({ number: plan.number, verdict: plan.verdict, ...r });
  }

  let hub = { ok: true, skipped: true };
  if (round.hubText && args.dryRun !== true) {
    const text = ensurePlain(round.hubText, 'refiner-hub');
    hub = say(text);
    if (!hub.ok) {
      return {
        scanned: true, exit: 1,
        error: `标和评论写下了，但推给用户没成：${hub.error}`,
        plans: round.plans, applied, hubText: round.hubText, skipped: round.skipped,
      };
    }
  }

  return {
    scanned: true,
    exit: 0,
    dryRun: args.dryRun === true,
    plans: round.plans,
    applied,
    skipped: round.skipped,
    hubText: round.hubText,
    hub,
  };
}

export function makeRunGh(role, { cwd = REPO_ROOT } = {}) {
  return (args) => {
    const r = ghAs(role, args, { cwd });
    if (!r.ok) return { ok: false, error: String(r.error || 'gh 没跑成').trim().slice(0, 200) };
    return { ok: true, out: r.out || '' };
  };
}

function printResult(result, { json }) {
  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (!result.scanned) {
    process.stderr.write(`没查成：${result.error}\n`);
    return;
  }
  if (result.exit === 1) {
    process.stderr.write(`写下失败：${result.error}\n`);
  }
  const plans = result.plans || [];
  const counts = { clear: 0, forks: 0, skip: 0 };
  for (const p of plans) {
    if (p.verdict === VERDICT.clear) counts.clear += 1;
    else if (p.verdict === VERDICT.forks) counts.forks += 1;
    else if (p.verdict === VERDICT.skip) counts.skip += 1;
  }
  const mode = result.dryRun ? '预览' : '实跑';
  process.stdout.write(
    `${mode}：无岔路 ${counts.clear} · 要人拍 ${counts.forks} · 跳过 ${counts.skip + (result.skipped || []).length}\n`,
  );
  if (result.hubText && result.dryRun) process.stdout.write(`${result.hubText}\n`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(helpText() + '\n');
    return 0;
  }
  const runGh = makeRunGh(args.as || DEFAULT_AS);
  const result = runRefiner({ args, runGh });
  printResult(result, { json: args.json });
  return result.exit == null ? 2 : result.exit;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
