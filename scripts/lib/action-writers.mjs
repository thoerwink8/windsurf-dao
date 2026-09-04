// scripts/lib/action-writers.mjs —— 动作触发写口的纯判官（#891 W5）
//
// 改这个文件前必须知道的六条：
//
// 1. 写口挂在**具体动作**上，不靠 agent 记性、也不靠每轮末事后猜（2026-09-04 用户拍板）。
//    判据只来自 PreToolUse / PostToolUse 的 tool_name / tool_input / 出参与退出码。
//    **零正则猜用户说话方式**——本文件一条匹配用户自然语言的正则都没有（admit-push 的
//    callout-detect 那种概率层不在这里：那条守「用户说出口的点破」，本文件守「动作真发生了」）。
// 2. 本文件**纯**：不读盘、不写盘、不 spawn。时间（ts）、脱敏函数（redact）、git 探头
//    （gitProbe）全部由调用方注入 ⇒ 测试不必造环境。落盘在 action-writers-hook.mjs。
// 3. 事件类型闭集与必填字段的唯一权威是 schemas/events.schema.json。本文件只**声明想写哪个
//    类型**（下面三个常量），不断言它在闭集内——那由 event-writer.buildEvent 派生自 schema 去
//    判。类型不在闭集内时上层优雅降级（不写、不报错），不许在这里另抄一份清单。
// 4. **不产生绝对路径**比「产生了再脱」便宜（#891 要求 key/token/绝对路径不进事件）：payload
//    里一律只放 basename / 分支名 / 短 sha / 单行标题。绝对路径的过滤本身归 W2 的 redact.mjs，
//    本文件不重复实现（两份安全过滤器必然漂移，见 redact.js 头注）。
// 5. 「没查成」与「查过没事」必须分开形：拿不到退出码 ⇒ bashOutcome().known=false ⇒
//    **不写里程碑**（fail-closed），不是「当成功写」。里程碑 payload 的 evidence 字段永远
//    写清这条 ✓ 是从哪读回来的。
// 6. 宿主字段名有两套说法（PostToolUse 的出参：官方文档写 tool_response，本机 hook 文档缓存
//    写 tool_result），且 MCP 侧回包形状与内置工具不同 ⇒ 本文件对出参**逐形状试**，并把命中
//    的形状名写进事件（chosen_source / evidence），读账的人因此分得清「读到了」与「读成什么样」。
//    一条都读不出来就 ok:false，绝不拿空值当答案。

import { hashOf } from './dianjiangtai-core.mjs';
import { splitShellStatements } from './dispatch-gate.mjs';

// ── 匹配面（工具名，宿主给的结构化事实）─────────────────────────────────

/** 问用户的工具：本机内置 + mirasim MCP 侧，两个都要匹配（缺一即半瞎）。 */
export const ASK_TOOLS = Object.freeze(['AskUserQuestion', 'mcp__mirasim__im_ask_user']);

export const DECISION_PENDING_TYPE = 'decision.pending';
export const DECISION_RESOLVED_TYPE = 'decision.resolved';
/** 里程碑：schema 现无此类型（本 PR 提议，交帅位/W1 落 schema）；不在闭集内时上层跳过。 */
export const MILESTONE_TYPE = 'session.milestone';

export function isAskTool(name) {
  return ASK_TOOLS.includes(String(name || ''));
}

/** stdin 容错解析：不是 JSON 一律当「没读到」，绝不抛（hook 不许因输入脏而炸）。 */
export function parseHookEvent(stdinText) {
  const t = String(stdinText == null ? '' : stdinText).trim();
  if (!t || t[0] !== '{') {
    return { ok: false, event: {}, reason: 'stdin 不是 JSON 对象（没读到 hook 入参）' };
  }
  try {
    const doc = JSON.parse(t);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, event: {}, reason: 'hook 入参不是对象' };
    }
    return { ok: true, event: doc, reason: null };
  } catch (e) {
    return { ok: false, event: {}, reason: `hook 入参 JSON 坏了：${String(e.message || e).slice(0, 80)}` };
  }
}

/** 出参取值：两套字段名都认（见头注第 6 条）。 */
export function toolOutputOf(event) {
  const e = event && typeof event === 'object' ? event : {};
  for (const k of ['tool_response', 'toolResponse', 'tool_result', 'toolResult']) {
    if (e[k] !== undefined) return e[k];
  }
  return undefined;
}

// ── 脱敏（注入式，不自实现）─────────────────────────────────────────────

/** 深度过 redact：只动字符串叶子，结构与键名不动。redact 不是函数即抛（fail-closed）。 */
export function redactDeep(value, redact) {
  if (typeof redact !== 'function') throw new Error('redactDeep 缺 redact 函数（拒绝裸写）');
  const walk = v => {
    if (typeof v === 'string') {
      const out = redact(v);
      if (typeof out !== 'string') throw new Error('redact 返回了非字符串（拒绝裸写）');
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    return v;
  };
  return walk(value);
}

// ── 写口 1/2 共用：问用户的工具入参归一 ─────────────────────────────────

function optionsOf(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(o => (typeof o === 'string'
      ? { label: o, description: null }
      : (o && typeof o === 'object'
        ? {
          label: o.label == null ? null : String(o.label),
          description: o.description == null ? null : String(o.description),
        }
        : { label: null, description: null })))
    .filter(o => o.label !== null && o.label !== '');
}

/**
 * 两种入参形状归一成 items（AskUserQuestion 一次可问多题 ⇒ 一题一条事件）。
 *   AskUserQuestion:           { questions: [{ question, header, multiSelect, options }] }
 *   mcp__mirasim__im_ask_user: { question, header, hint, options, allow_freeform }
 * urgency / why 两个字段在两种工具的入参里**都没有固定位**（2026-09-04 核过两边工具定义）：
 *   urgency 取入参同名字段，没有就 null（不猜；播报闸对 decision.pending 本就即时插播）。
 *   why 取 hint，退到推荐项的 description（AGENTS.md 要求「介绍」写来龙去脉，落点就在那里），
 *   都没有就 null —— 并用 why_source 记清它从哪来。null 就是「没查成」，不许伪造一句 why。
 * recommend 按约定 = 第一个选项（AGENTS.md：推荐项放第一项）；label 原样留，不剥
 * `(Recommended)` 后缀——那是用户眼里看到的真相。
 */
export function normalizeAsk(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  let rawItems = null;
  if (Array.isArray(input.questions)) rawItems = input.questions;
  else if (typeof input.question === 'string' && input.question.trim()) rawItems = [input];
  if (!rawItems || rawItems.length === 0) {
    return { ok: false, items: [], reason: '入参里没有 question / questions（没查成，不写事件）' };
  }
  const items = [];
  for (let i = 0; i < rawItems.length; i++) {
    const q = rawItems[i] && typeof rawItems[i] === 'object' ? rawItems[i] : {};
    const question = q.question == null ? '' : String(q.question).trim();
    if (!question) continue;
    const options = optionsOf(q.options);
    const recommend = options.length ? options[0].label : null;
    const rawHint = q.hint != null ? q.hint : input.hint;
    const hint = rawHint == null ? '' : String(rawHint).trim();
    let why = null;
    let whySource = null;
    if (hint) {
      why = hint;
      whySource = 'hint';
    } else if (options.length && options[0].description) {
      why = options[0].description;
      whySource = 'recommend_description';
    }
    const rawUrgency = q.urgency != null ? q.urgency : input.urgency;
    items.push({
      index: i,
      question,
      header: q.header == null ? null : String(q.header),
      options,
      recommend,
      urgency: rawUrgency == null ? null : String(rawUrgency),
      why,
      why_source: whySource,
      tool: String(toolName || ''),
    });
  }
  if (items.length === 0) {
    return { ok: false, items: [], reason: 'questions 里没有一条有 question 文本（没查成）' };
  }
  return { ok: true, items, reason: null };
}

/**
 * decision_id：只由「同一次提问 Pre / Post 两侧都拿得到的东西」算 —— session_id + 工具名 +
 * 题干 + 选项 label + 题序。**刻意不含 ts**（Pre 与 Post 的 ts 必然不同，含了就对不上）。
 */
export function decisionIdOf({ sessionId, toolName, item } = {}) {
  const it = item || {};
  const h = hashOf({
    session_id: sessionId == null ? '' : String(sessionId),
    tool_name: String(toolName || ''),
    question: String(it.question || ''),
    options: (it.options || []).map(o => o.label),
    index: Number(it.index || 0),
  });
  return `dec-${h.slice(0, 16)}`;
}

// ── 写口 1：待拍板（PreToolUse）────────────────────────────────────────

/**
 * → { ok, writes: [{ type, decision_id, payload }], reason }。
 * writes 为空一律带 reason（调用方照原样落进降级说明，不许静默）。
 */
export function buildDecisionPending({ event, ts, redact } = {}) {
  const e = event && typeof event === 'object' ? event : {};
  const toolName = e.tool_name || e.toolName || '';
  if (!isAskTool(toolName)) {
    return { ok: false, writes: [], reason: `工具 ${JSON.stringify(String(toolName))} 不是问用户的工具，不写` };
  }
  if (!ts) return { ok: false, writes: [], reason: '缺 ts（调用方必须注入时间）' };
  const norm = normalizeAsk(toolName, e.tool_input || e.toolInput);
  if (!norm.ok) return { ok: false, writes: [], reason: norm.reason };
  const writes = norm.items.map(item => {
    const decisionId = decisionIdOf({ sessionId: e.session_id || e.sessionId, toolName, item });
    return {
      type: DECISION_PENDING_TYPE,
      decision_id: decisionId,
      payload: redactDeep({
        decision_id: decisionId,
        question: item.question,
        options: item.options,
        recommend: item.recommend,
        urgency: item.urgency,
        why: item.why,
        why_source: item.why_source,
        asked_by: item.tool,
        session_id: e.session_id || e.sessionId || null,
        repo: repoNameOf(e.cwd),
      }, redact),
    };
  });
  return { ok: true, writes, reason: null };
}

// ── 写口 2：拍板结果（PostToolUse）──────────────────────────────────────

const ANSWER_KEYS = ['answer', 'chosen', 'selected', 'choice', 'label', 'value', 'response'];

function labelsOfSelected(raw) {
  if (!Array.isArray(raw)) return null;
  const out = raw
    .map(o => (typeof o === 'string' ? o : (o && typeof o === 'object' && o.label != null ? String(o.label) : null)))
    .filter(x => x && x.trim());
  return out.length ? out : null;
}

function pickFromRow(row) {
  if (row == null) return null;
  if (typeof row === 'string') return row.trim() ? [row.trim()] : null;
  if (typeof row !== 'object') return null;
  // AskUserQuestion 的权威形状：{ responses: [{ selectedOptions: [{ label }] }] }
  const sel = labelsOfSelected(row.selectedOptions) || labelsOfSelected(row.selected_options);
  if (sel) return sel;
  for (const k of ANSWER_KEYS) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    if (Array.isArray(v)) {
      const list = labelsOfSelected(v);
      if (list) return list;
    }
  }
  return null;
}

/**
 * 从出参里读用户答了什么。命中的形状名一并返回（写进事件的 chosen_source）。
 * 一条都读不出来 ⇒ ok:false（不写 resolved；不许拿空数组当「用户选了空」）。
 */
export function extractChosen(toolOutput, index = 0) {
  const idx = Number(index) || 0;
  if (toolOutput == null) return { ok: false, chosen: [], shape: null, reason: '出参为空（没查成）' };
  if (typeof toolOutput === 'string') {
    const t = toolOutput.trim();
    if (!t) return { ok: false, chosen: [], shape: null, reason: '出参是空串（没查成）' };
    return { ok: true, chosen: [t], shape: 'string', reason: null };
  }
  if (Array.isArray(toolOutput)) {
    const hit = pickFromRow(toolOutput[idx]) || pickFromRow(toolOutput[0]);
    if (hit) return { ok: true, chosen: hit, shape: 'array', reason: null };
  }
  if (typeof toolOutput === 'object' && !Array.isArray(toolOutput)) {
    for (const key of ['responses', 'questions', 'answers', 'results']) {
      const rows = toolOutput[key];
      if (!Array.isArray(rows)) continue;
      const hit = pickFromRow(rows[idx]) || pickFromRow(rows[0]);
      if (hit) return { ok: true, chosen: hit, shape: `${key}[]`, reason: null };
    }
    const flat = pickFromRow(toolOutput);
    if (flat) return { ok: true, chosen: flat, shape: 'flat', reason: null };
    // MCP 侧回包：{ content: [{ type:'text', text:'...' }] }
    if (Array.isArray(toolOutput.content)) {
      const texts = toolOutput.content
        .filter(c => c && c.type === 'text' && typeof c.text === 'string' && c.text.trim())
        .map(c => c.text.trim());
      if (texts.length) return { ok: true, chosen: [texts.join('\n')], shape: 'mcp-content', reason: null };
    }
  }
  return { ok: false, chosen: [], shape: null, reason: '出参里认不出答案字段（没查成，不写 resolved）' };
}

/** 用户答的是不是选项之外的自由输入（选项 label 精确比对，不做模糊匹配）。 */
export function isFreeform(chosen, options) {
  const labels = new Set((options || []).map(o => String(o.label)));
  if (labels.size === 0) return true;
  return (chosen || []).some(c => !labels.has(String(c)));
}

export function buildDecisionResolved({ event, ts, redact } = {}) {
  const e = event && typeof event === 'object' ? event : {};
  const toolName = e.tool_name || e.toolName || '';
  if (!isAskTool(toolName)) {
    return { ok: false, writes: [], reason: `工具 ${JSON.stringify(String(toolName))} 不是问用户的工具，不写` };
  }
  if (!ts) return { ok: false, writes: [], reason: '缺 ts（调用方必须注入时间）' };
  const norm = normalizeAsk(toolName, e.tool_input || e.toolInput);
  if (!norm.ok) return { ok: false, writes: [], reason: norm.reason };
  const out = toolOutputOf(e);
  const writes = [];
  const missed = [];
  for (const item of norm.items) {
    const target = decisionIdOf({ sessionId: e.session_id || e.sessionId, toolName, item });
    const got = extractChosen(out, item.index);
    if (!got.ok) {
      missed.push(`${target}: ${got.reason}`);
      continue;
    }
    writes.push({
      type: DECISION_RESOLVED_TYPE,
      decision_id: target,
      payload: redactDeep({
        target_decision_id: target,
        chosen: got.chosen,
        chosen_source: got.shape,
        freeform: isFreeform(got.chosen, item.options),
        by: '用户',
        question: item.question,
        asked_by: item.tool,
        session_id: e.session_id || e.sessionId || null,
        repo: repoNameOf(e.cwd),
      }, redact),
    });
  }
  if (writes.length === 0) {
    return { ok: false, writes: [], reason: missed.length ? missed.join('；') : '没有一题读出答案（没查成）' };
  }
  return { ok: true, writes, reason: missed.length ? `部分没查成：${missed.join('；')}` : null };
}

// ── 写口 3：里程碑（PostToolUse Bash，命令真成功才写）────────────────────

/** 只留末段目录名当 repo 标识：绝对路径不产生，就不必依赖脱敏去补（头注第 4 条）。 */
export function repoNameOf(cwd) {
  const s = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!s) return null;
  const seg = s.split('/').filter(Boolean).pop();
  return seg || null;
}

/** 引号感知分词：只为看清「这条语句的头是不是 git/gh/node」，不求还原 shell 语义。 */
export function tokenize(statement) {
  const s = String(statement || '');
  const out = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else buf += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      continue;
    }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
}

// git 的全局选项里带值的那几个（跳过它们才能看到真正的子命令）
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

function gitSubcommand(tokens) {
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t.startsWith('-')) return t;
    if (GIT_OPTS_WITH_VALUE.has(t)) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * 一条语句是不是里程碑动作。返回 null 或 { kind, statement, pr_number }。
 * kind ∈ commit / land / pr-merge。--dry-run 一律不算（它什么都没落地）。
 */
export function classifyStatement(statement) {
  const tokens = tokenize(statement);
  if (tokens.length === 0) return null;
  // 前缀环境变量赋值与 sudo 跳过（FOO=bar git commit ...）
  let head = 0;
  while (head < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[head]) || tokens[head] === 'sudo')) head += 1;
  const t = tokens.slice(head);
  if (t.length === 0) return null;
  const exe = String(t[0]).replace(/\\/g, '/').split('/').pop();
  const dryRun = t.includes('--dry-run');
  if (exe === 'git' || exe === 'git.exe') {
    if (gitSubcommand(t) === 'commit' && !dryRun) {
      return { kind: 'commit', statement: String(statement), pr_number: null };
    }
    return null;
  }
  if (exe === 'gh' || exe === 'gh.exe') {
    if (t[1] === 'pr' && t[2] === 'merge' && !dryRun) {
      const num = t.slice(3).find(x => /^\d+$/.test(x));
      return { kind: 'pr-merge', statement: String(statement), pr_number: num ? Number(num) : null };
    }
    return null;
  }
  if (exe === 'node' || exe === 'node.exe') {
    if (t.slice(1).some(x => /(^|[\\/])land\.mjs$/.test(String(x))) && !dryRun) {
      return { kind: 'land', statement: String(statement), pr_number: null };
    }
    return null;
  }
  return null;
}

/**
 * 整条命令里的里程碑动作。多于一条时**不写**：一条命令只有一个退出码，归不到具体动作上
 * ⇒「没查成」不许当「都成功了」。
 */
export function classifyMilestoneCommand(command) {
  const cmd = String(command || '');
  if (!cmd.trim()) return { ok: false, matches: [], reason: '命令为空（没查成）' };
  const matches = [];
  for (const st of splitShellStatements(cmd)) {
    const hit = classifyStatement(st);
    if (hit) matches.push(hit);
  }
  if (matches.length === 0) {
    return { ok: false, matches: [], reason: '命令里没有里程碑动作（git commit / land.mjs / gh pr merge）' };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      matches,
      reason: `一条命令里 ${matches.length} 个里程碑动作（${matches.map(m => m.kind).join('+')}），单个退出码归不到具体动作，不写`,
    };
  }
  return { ok: true, matches, reason: null };
}

/**
 * 命令到底成没成。**这条是本写口的判据核心**：拿不到退出码 / 失败标记 ⇒ known:false ⇒ 不写。
 * 顺序有意义：被中断与显式错误标记优先于退出码（exit_code 为 0 但被中断，仍算没成）。
 */
export function bashOutcome(toolOutput) {
  const r = toolOutput;
  if (r == null) return { known: false, ok: false, evidence: '出参为空（退出码没查成）' };
  if (typeof r !== 'object' || Array.isArray(r)) {
    return {
      known: false,
      ok: false,
      evidence: `出参是 ${Array.isArray(r) ? 'array' : typeof r}，没有退出码字段（没查成）`,
    };
  }
  if (r.interrupted === true) return { known: true, ok: false, evidence: 'interrupted=true' };
  for (const k of ['is_error', 'isError', 'error']) {
    const v = r[k];
    if (v === true) return { known: true, ok: false, evidence: `${k}=true` };
    if (typeof v === 'string' && v.trim()) return { known: true, ok: false, evidence: `${k} 非空` };
  }
  for (const k of ['exit_code', 'exitCode', 'returnCode', 'return_code', 'code', 'status']) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return { known: true, ok: v === 0, evidence: `${k}=${v}` };
    }
  }
  return {
    known: false,
    ok: false,
    evidence: '出参里没有退出码，也没有 interrupted/error 标记（没查成）',
  };
}

/**
 * → { ok, writes, reason }。gitProbe 可选，形如 ({ cwd }) => { branch, commit, subject } |
 * { error }；拿不到就把 evidence 里写清「git 探头没查成」，不留假 ✓。
 */
export function buildMilestone({ event, ts, redact, gitProbe } = {}) {
  const e = event && typeof event === 'object' ? event : {};
  const toolName = String(e.tool_name || e.toolName || '');
  if (toolName !== 'Bash') return { ok: false, writes: [], reason: `工具 ${JSON.stringify(toolName)} 不是 Bash，不写` };
  if (!ts) return { ok: false, writes: [], reason: '缺 ts（调用方必须注入时间）' };
  const input = e.tool_input || e.toolInput || {};
  const command = typeof input === 'string'
    ? input
    : (input && typeof input.command === 'string' ? input.command : '');
  const cls = classifyMilestoneCommand(command);
  if (!cls.ok) return { ok: false, writes: [], reason: cls.reason };
  const outcome = bashOutcome(toolOutputOf(e));
  if (!outcome.known) return { ok: false, writes: [], reason: `命令成没成没查成（${outcome.evidence}），不写里程碑` };
  if (!outcome.ok) return { ok: false, writes: [], reason: `命令没成功（${outcome.evidence}），不写里程碑` };
  const hit = cls.matches[0];
  let git = null;
  if (typeof gitProbe === 'function') {
    try {
      git = gitProbe({ cwd: e.cwd });
    } catch (err) {
      git = { error: String(err && err.message ? err.message : err) };
    }
  }
  const probeNote = typeof gitProbe !== 'function'
    ? 'git 探头没给（不查）'
    : (git && git.error ? `git 探头没查成：${String(git.error).slice(0, 80)}` : 'git 探头查到了');
  const anchor = (git && git.commit)
    || (hit.pr_number != null ? `pr-${hit.pr_number}` : hashOf({ command, ts }).slice(0, 12));
  return {
    ok: true,
    reason: null,
    writes: [{
      type: MILESTONE_TYPE,
      milestone_key: `${hit.kind}:${anchor}`,
      payload: redactDeep({
        kind: hit.kind,
        repo: repoNameOf(e.cwd),
        branch: (git && git.branch) || null,
        commit: (git && git.commit) || null,
        subject: (git && git.subject) || null,
        pr_number: hit.pr_number,
        milestone_key: `${hit.kind}:${anchor}`,
        session_id: e.session_id || e.sessionId || null,
        evidence: `${outcome.evidence}；${probeNote}`,
      }, redact),
    }],
  };
}
