// scripts/lib/dispatch/template.mjs —— 闭环任务书模板域（#762 拆分）
//
// 改这段前必须知道：士兵 / 审官任务书模板在 host/skills/dispatch/templates/，
// 不硬编码进代码——模板要能被读、被改（#507 教训）。
// 占位符 {{KEY}} 填充失败（模板缺文件 / 占位符没被换掉）必须失败退出。
// 注入硬闸 = UTF-8 字节 ≤500；Orca worker-start preamble 单独就会触发
// Codex/Grok 粘贴块（实测约 4600 字节），那一层不在我们手里，量不到。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './constants.mjs';

export const DISPATCH_TEMPLATE_DIR = join(ROOT, 'host', 'skills', 'dispatch', 'templates');

export function listDispatchTemplates() {
  if (!existsSync(DISPATCH_TEMPLATE_DIR)) return [];
  return readdirSync(DISPATCH_TEMPLATE_DIR)
    .filter(f => f.endsWith('.md'))
    .sort();
}

/** 读模板原文。拿不到就抛（同 dao 全局：不许静默当成空模板）。 */
export function readDispatchTemplate(name) {
  if (!/^[a-z0-9-]+\.md$/.test(String(name || ''))) throw new Error(`模板名不合法: ${name}`);
  const p = join(DISPATCH_TEMPLATE_DIR, name);
  if (!existsSync(p)) throw new Error(`任务书模板不在: ${p}`);
  return readFileSync(p, 'utf8');
}

/** 填充 {{KEY}} 占位符。所有占位符必须全部被替换，剩一个就是失败。
 * #559 审官红项：占位符填成字面量 "undefined"/"null"（如 String(missingId)）等于没填，
 * 必须抛——否则渲染出 dispatch:undefined，士兵/审官把消息发进不存在的收件箱。 */
export function renderDispatchTemplate(name, vars = {}) {
  const text = readDispatchTemplate(name);
  const out = String(text).replace(/\{\{(\w+)\}\}/g, (m, key) => {
    const v = vars[key];
    if (v === undefined || v === null) throw new Error(`模板 ${name} 占位符 {{${key}}} 没给值`);
    const s = String(v);
    if (/^(undefined|null)$/i.test(s.trim())) {
      throw new Error(`模板 ${name} 占位符 {{${key}}} 填了无效值（${s.trim()}）——真 id 缺失，不许渲染出 dispatch:undefined`);
    }
    return s;
  });
  if (/\{\{\w+\}\}/.test(out)) throw new Error(`模板 ${name} 还有未替换占位符`);
  return out;
}

// ── 注入闸（#602 / #619）：主约束 = 一行指针。换行按 agent 转码（grok 转 ESC+CR），不禁换行。
// 唯一硬闸 = UTF-8 字节 ≤500。模板文件末尾允许一个 EOF 换行，渲染后剥掉。
// 二分实测（2026-08-17，grok 探针 term + 帅 701 截断）：
//   orca terminal send 单行 200/350/450/550/650/701 均送达（模型回出末尾标记）
//   帅经 TUI 输入框提交 701 字节：前半进消息、后半留输入框
// 安全值取 500：低于 TUI 截断点，高于目标 100，send 路径 550 仍绿。
//
// #619：本闸只量我们拼的 spec。Orca worker-start 还会再包一层 preamble（实测约 4600 字节），
// 那一层不在我们手里，量不到。preamble 单独就会触发 Codex/Grok 粘贴块，所以短指针仍要走提交第二拍。
export const INJECT_MAX_BYTES = 500;
export const INJECT_OVER_LIMIT_HINT = '正文挪去仓内文件或 GitHub，注入只给指针';
export const INJECT_GATE_SCOPE = 'our-spec-only';
export const ORCA_WORKER_PREAMBLE_BYTES_MEASURED = 4600;
export const INJECT_GATE_NOTE = '本闸只量我们拼的 spec，量不到 Orca worker-start preamble（实测约 4600 字节）。preamble 单独就会触发 Codex/Grok 粘贴块。';

export function injectUtf8Bytes(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

export function stripInjectEof(text) {
  return String(text ?? '').replace(/(?:\r\n|\n|\r)+$/g, '');
}

export function assertInjectText(text, { label } = {}) {
  const s = String(text ?? '');
  const bytes = injectUtf8Bytes(s);
  if (bytes > INJECT_MAX_BYTES) {
    return {
      ok: false,
      length: s.length,
      bytes,
      newlines: /[\r\n]/.test(s),
      limit: INJECT_MAX_BYTES,
      scope: INJECT_GATE_SCOPE,
      note: INJECT_GATE_NOTE,
      preambleBytesMeasured: ORCA_WORKER_PREAMBLE_BYTES_MEASURED,
      error: `注入 ${bytes} 字节超过上限 ${INJECT_MAX_BYTES}（${label || 'task spec'}）。${INJECT_OVER_LIMIT_HINT}。${INJECT_GATE_NOTE}`,
    };
  }
  return {
    ok: true,
    length: s.length,
    bytes,
    newlines: /[\r\n]/.test(s),
    limit: INJECT_MAX_BYTES,
    scope: INJECT_GATE_SCOPE,
    note: INJECT_GATE_NOTE,
    preambleBytesMeasured: ORCA_WORKER_PREAMBLE_BYTES_MEASURED,
  };
}

/** 兼容旧名：与 assertInjectText 相同，唯一硬闸是 UTF-8 字节上限。 */
export function assertInjectLen(text, opts) {
  return assertInjectText(text, opts);
}

function renderInjectTemplate(name, vars) {
  return stripInjectEof(renderDispatchTemplate(name, vars));
}

export function buildSoldierInject({ spec, issue } = {}) {
  const text = renderInjectTemplate('soldier-inject.md', {
    SPEC: spec,
    ISSUE_REF: issue ? ` #${issue}` : '',
  });
  const gate = assertInjectText(text, { label: '士兵注入' });
  if (!gate.ok) throw new Error(gate.error);
  return text;
}

export function buildBatchInject({ spec, issue } = {}) {
  const text = renderInjectTemplate('batch-inject.md', {
    SPEC: spec,
    ISSUE_REF: issue ? ` #${issue}` : '',
  });
  const gate = assertInjectText(text, { label: 'batch 注入' });
  if (!gate.ok) throw new Error(gate.error);
  return text;
}

export function buildReviewerInject({ spec, issue, pr, soldierDispatchId, mergePolicy, mergeReason, skipWait } = {}) {
  const policy = mergePolicy == null ? mergePolicy : String(mergePolicy);
  const text = renderInjectTemplate('reviewer-inject.md', {
    SPEC: spec,
    ISSUE_REF: issue ? ` #${issue}` : '',
    PR: pr,
    // #631：skip-wait（帅手动补审官）时 d 可以空——调用方显式传 ''（渲染成 `d=`，任务书认空 = 红项上帅）；
    // undefined/null 仍抛（dispatch:undefined 硬闸，worker-done 路径不许丢）。
    SOLDIER_DISPATCH_ID: soldierDispatchId,
    MERGE_POLICY: policy,
    MERGE_REASON_REF: policy === 'manual' && mergeReason ? ` r=${mergeReason}` : '',
    SKIP_WAIT_REF: skipWait ? ' s=1' : '',
  });
  const gate = assertInjectText(text, { label: '审官注入' });
  if (!gate.ok) throw new Error(gate.error);
  return text;
}
