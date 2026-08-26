// scripts/lib/dispatch/batch.mjs —— 批派域（#762 拆分）
//
// 改这段前必须知道：#620 一批只读工人共享 1 张卡：建 1 棵树，循环 N 次
// task-create + worker-start。不产 PR，硬编码跳过审官与 --split。
// 失败不自己回滚——调用方拿 created 走 failCreated / planDispatchRollback。

import { readFileSync } from 'node:fs';
import { assembleCardName } from './card.mjs';
import { buildBatchInject } from './template.mjs';

/** #620：batch JSON → `[{name, spec}, ...]`。数组或 `{workers|items|batch: [...]}` 都收。 */
export function parseDispatchBatchItems(raw) {
  if (raw == null) return { ok: false, error: 'batch 文件是空的' };
  let list = raw;
  if (!Array.isArray(raw)) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'batch 要 JSON 数组 [{name, spec}, ...]' };
    list = raw.workers || raw.items || raw.batch;
  }
  if (!Array.isArray(list)) return { ok: false, error: 'batch 要 JSON 数组 [{name, spec}, ...]' };
  if (list.length === 0) return { ok: false, error: 'batch 至少要 1 个工人' };
  const items = [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, error: `batch[${i}] 不是对象` };
    }
    const name = String(row.name ?? '').trim();
    const spec = String(row.spec ?? '').trim();
    if (!name) return { ok: false, error: `batch[${i}] 缺 name` };
    if (!spec) return { ok: false, error: `batch[${i}] 缺 spec` };
    items.push({ name, spec });
  }
  return { ok: true, items };
}

export function loadDispatchBatchFile(filePath, { readFile } = {}) {
  const p = String(filePath ?? '').trim();
  if (!p) return { ok: false, error: 'dispatch --batch 要 JSON 文件路径' };
  let text;
  try {
    text = (readFile || readFileSync)(p, 'utf8');
  } catch (e) {
    return { ok: false, error: `batch 文件读不到: ${p}（${String(e.message || e)}）` };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `batch 文件不是合法 JSON: ${String(e.message || e)}` };
  }
  return parseDispatchBatchItems(raw);
}

/** #620：一批只读工人的计划。不调审官，卡名就是 --name，不带 --no-parent。 */
export function planDispatchBatch({ name, issue, model, items } = {}) {
  const n = String(name ?? '').trim();
  const issueText = String(issue ?? '').trim();
  const modelId = String(model ?? '').trim();
  if (!n) return { ok: false, error: 'dispatch --batch 要 --name（批卡名）' };
  if (!issueText) return { ok: false, error: 'dispatch --batch 要 --issue（整批共享）' };
  if (!modelId) return { ok: false, error: 'dispatch --batch 要 --model' };

  let parsed;
  if (items && items.ok === true && Array.isArray(items.items)) parsed = items;
  else parsed = parseDispatchBatchItems(items);
  if (!parsed.ok) return parsed;

  const cardName = assembleCardName({ name: n, issue: issueText });
  const workers = [];
  for (let i = 0; i < parsed.items.length; i++) {
    const item = parsed.items[i];
    let inject;
    try {
      inject = buildBatchInject({ spec: item.spec, issue: issueText });
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
    workers.push({
      index: i,
      name: item.name,
      spec: item.spec,
      inject,
      handle: `<handle:${i}>`,
      worktree: cardName,
    });
  }
  return {
    ok: true,
    batch: true,
    cardName,
    issue: issueText,
    model: modelId,
    noParent: false,
    reviewerCreate: false,
    workers,
  };
}

/**
 * #620：批量原子编排。effects 由调用方注入（真路径走 orca，单测走假对象）。
 * 失败不自己回滚——调用方拿 created 走 failCreated / planDispatchRollback。
 */
export function runDispatchBatch({ plan, effects } = {}) {
  const created = { handles: [], workers: [], dispatchIds: [], taskIds: [] };
  if (!plan || !Array.isArray(plan.workers)) {
    return { ok: false, error: 'runDispatchBatch 要 plan.workers', created, workers: [] };
  }
  if (!effects) {
    return { ok: false, error: 'runDispatchBatch 要 effects', created, workers: [] };
  }
  const fail = (error) => ({ ok: false, error, created, workers: created.workers });

  const wt = effects.createWorktree({
    name: plan.cardName,
    issue: plan.issue,
    noParent: false,
  });
  if (wt && wt.id) created.workerId = wt.id;
  if (wt && wt.path) created.workerPath = wt.path;
  if (!wt || !wt.ok) return fail(`工人卡创建失败: ${(wt && wt.error) || '未知'}`);

  // #633 agent-first：第一个 worker 复用建树 first terminal（agent-first），后续走原 fallback。
  let firstTerminalUsed = false;
  for (const w of plan.workers) {
    const preexisting = (wt && wt.firstTerminalHandle && !firstTerminalUsed) ? wt.firstTerminalHandle : null;
    const term = effects.startTerminal({
      worktree: created.workerId,
      title: w.name,
      model: plan.model,
      ...(preexisting ? { preexistingHandle: preexisting } : {}),
    });
    if (preexisting) firstTerminalUsed = true;
    if (term && term.handle) created.handles.push(term.handle);
    if (!term || !term.ok) return fail(`工人终端创建失败（${w.name}）: ${(term && term.error) || '未知'}`);

    const task = effects.createTask({
      spec: w.inject || w.spec,
      name: w.name,
      issue: plan.issue,
    });
    if (!task || !task.ok) return fail(`task-create 失败（${w.name}）: ${(task && task.error) || '未知'}`);
    if (task.taskId) created.taskIds.push(task.taskId);

    const started = effects.startWorker({
      task: task.taskId,
      terminal: term.handle,
      worktree: created.workerId,
      issue: plan.issue,
      model: term.model || plan.model,
      agent: term.agentId,
      deferred: term.deferred === true,
    });
    if (started && started.dispatchId) created.dispatchIds.push(started.dispatchId);
    if (!started || !started.ok) {
      return fail(`worker-start 失败（${w.name}）: ${(started && started.error) || '未知'}`);
    }

    created.workers.push({
      index: w.index,
      name: w.name,
      spec: w.spec,
      inject: w.inject || w.spec,
      handle: started.handle || term.handle,
      taskId: task.taskId,
      dispatchId: started.dispatchId,
    });
  }
  return { ok: true, created, workers: created.workers };
}
