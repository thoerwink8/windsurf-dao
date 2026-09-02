// scripts/lib/feishu-triage-core.mjs —— 飞书 triage 块 B 逻辑（#801 消歧记录 + 补充 2）
//
// 职责：判重 → 三问 → 建单 → 两档放行。纯函数 + 注入 deps：不做网络 I/O、
// 不读环境变量；persona.md 在模块装载时读一次（静态配置，算常量不算副作用）。
//
// Inbound（块 A 产出，块 B 只读）：
//   { chatId, rootId /*话题根消息 id*/, messageId, senderOpenId, senderName,
//     text, ts, repo /*由映射表填，hub 群为 null*/ }
// deps（块 A 注入）：
//   { ghSearch(repo, query) -> [{number,title,url}],
//     ghCreateIssue(repo,{title,body,labels}) -> {number,url},
//     ghComment(repo,number,body),
//     llm({system,user,json?:true}) -> string|object,
//     now() -> number,
//     state /* Map<rootId, ThreadState>，由 A 持久化 */,
//     allowOpenIds: [] }
// 返回：
//   { replies: [{ rootId, text }],
//     actions: [ {type:'issue_created', repo, number, url, gate:'已消歧'|'待拍板'}
//              | {type:'hub_card', repo, number, url, title, from} ],
//     state }
//
// 流程（每个话题 rootId 一条状态机）：
//   dedup 阶段：ghSearch 取候选 → llm 逐条判 同一件事/相关/无关。
//     命中 → ghComment 追评到最像的单 + 回执（已在 #N 下补充了你的反馈）→ done。
//     未命中 → asking，问三问缺项。
//   asking 阶段：llm 判定三问哪些已答、生成缺项追问；一轮最多追问 2 条，合并成一条消息。
//     三问齐 → llm 渲染 issue 正文 → ghCreateIssue → 回链接；放行两档按 allowOpenIds。
//   done 阶段：同话题新消息 → 追评到已建/已命中单。
// 任何 deps 调用抛错 → 回「机器人暂时没法判断，稍后重试。」，不编造（补充 2）。

import { readFileSync } from 'node:fs';

/** persona.md 全文 = deps.llm 的 system 段（补充 2：「prompt 的 system 段 = 此文件全文」）。 */
export const PERSONA = readFileSync(
  new URL('../../host/skills/feishu-triage/persona.md', import.meta.url),
  'utf8',
);

export const GATE_ALLOWED = '已消歧';
export const GATE_PENDING = '待拍板';
export const LLM_DOWN_REPLY = '机器人暂时没法判断，稍后重试。';
export const HUB_GUIDANCE = '这里是总控群，需求请发到项目群。';

/** 三问固定表：key 进 llm JSON 与 ThreadState.answers，fallback 是 llm 没给追问时的兜底问法。 */
export const THREE_QUESTIONS = [
  { key: 'done', label: '做到什么算做完', fallback: '做到什么算做完？需要可验证的结果。' },
  { key: 'batch', label: '这批做还是以后', fallback: '这批做还是以后做？' },
  { key: 'docs', label: '是否 docs/memory 该记', fallback: '要记进 docs/memory 吗？' },
];

const MAX_ASK_PER_ROUND = 2;
const MAX_RELATED_LISTED = 3;
const MAX_RELATED_ON_MISS = 2;
const MAX_QUERY_LEN = 300;
const MAX_SUMMARY_LEN = 60;

/** 块 A 入口：一次入站消息 → 回复 + 动作 + 新状态。 */
export async function triage(inbound, deps) {
  try {
    return await triageInner(inbound, deps);
  } catch {
    // 任何失败（llm/gh 抛错、JSON 不合法）→ 不编造，回兜底话；状态不动，下条消息重试。
    return {
      replies: [{ rootId: inbound.rootId, text: LLM_DOWN_REPLY }],
      actions: [],
      state: deps.state,
    };
  }
}

async function triageInner(inbound, deps) {
  const { rootId, repo } = inbound;
  if (!repo) {
    // hub 群只收卡片，不建单：指路，不留状态。
    return { replies: [{ rootId, text: HUB_GUIDANCE }], actions: [], state: deps.state };
  }

  const next = new Map(deps.state);
  const thread = next.get(rootId) ?? freshThread(inbound);
  next.set(rootId, thread);
  thread.msgs.push({
    messageId: inbound.messageId,
    senderOpenId: inbound.senderOpenId,
    senderName: inbound.senderName,
    text: inbound.text,
    ts: inbound.ts,
  });
  thread.updatedAt = deps.now();

  let dedupRanHere = false;
  if (thread.phase === 'dedup') {
    const dedup = await runDedup(inbound, deps);
    thread.dedup = dedup;
    dedupRanHere = true;
    if (dedup.matched.length > 0) {
      const top = dedup.matched[0];
      await deps.ghComment(repo, top.number, commentBodyFor(inbound));
      thread.phase = 'done';
      thread.issue = { number: top.number, url: top.url, existing: true };
      return { replies: [{ rootId, text: hitReply(dedup) }], actions: [], state: next };
    }
    thread.phase = 'asking';
  }

  if (thread.phase === 'asking') {
    const q = await runQuestions(thread, deps);
    thread.answers = q.answers;
    const missing = THREE_QUESTIONS.filter(x => !q.answers[x.key]?.answered);
    if (missing.length > 0) {
      const related = dedupRanHere ? (thread.dedup?.related ?? []) : [];
      return {
        replies: [{ rootId, text: askReply({ related, missing, questions: q.questions }) }],
        actions: [],
        state: next,
      };
    }

    const rendered = await runRender(inbound, thread, deps);
    const gate = deps.allowOpenIds.includes(inbound.senderOpenId) ? GATE_ALLOWED : GATE_PENDING;
    const title = `[飞书] ${rendered.title}`;
    const created = await deps.ghCreateIssue(repo, {
      title,
      body: issueBody({ inbound, sections: rendered.sections, answers: q.answers }),
      labels: ['任务', gate],
    });
    thread.phase = 'done';
    thread.issue = { number: created.number, url: created.url, existing: false };
    const actions = [
      { type: 'issue_created', repo, number: created.number, url: created.url, gate },
    ];
    if (gate === GATE_PENDING) {
      actions.push({
        type: 'hub_card',
        repo,
        number: created.number,
        url: created.url,
        title,
        from: inbound.senderName || inbound.senderOpenId,
      });
    }
    return { replies: [{ rootId, text: createdReply(created, rendered.title, gate) }], actions, state: next };
  }

  // done：同一话题新消息 = 补充信息 → 追评到已建/已命中单（决策文档「新信息追评」）。
  if (thread.issue) {
    await deps.ghComment(repo, thread.issue.number, commentBodyFor(inbound));
    return {
      replies: [{
        rootId,
        text: `已在 #${thread.issue.number} 下补充了你的反馈：${sentence(oneSentence(inbound.text))}`,
      }],
      actions: [],
      state: next,
    };
  }
  return { replies: [{ rootId, text: LLM_DOWN_REPLY }], actions: [], state: next };
}

// ── 判重 ──────────────────────────────────────────────────────────────

async function runDedup(inbound, deps) {
  const candidates = await deps.ghSearch(inbound.repo, searchQuery(inbound.text));
  const data = await llmJson(() => deps.llm({
    system: PERSONA,
    user: dedupPrompt(inbound, candidates),
    json: true,
  }));
  const verdictByNumber = new Map(
    (Array.isArray(data.verdicts) ? data.verdicts : [])
      .map(v => [Number(v?.number), normalizeVerdict(v?.verdict)]),
  );
  const scored = candidates.map(c => ({
    number: c.number,
    title: c.title,
    url: c.url,
    verdict: verdictByNumber.get(c.number) ?? '无关',
  }));
  return {
    verdicts: scored,
    matched: scored.filter(s => s.verdict === '同一件事'),
    related: scored.filter(s => s.verdict === '相关'),
    summary: String(data.summary ?? '').trim(),
  };
}

function dedupPrompt(inbound, candidates) {
  const list = candidates.map(c => `#${c.number} ${c.title}`).join('\n');
  return [
    `群里新需求（来自 ${inbound.senderName || inbound.senderOpenId}）：`,
    inbound.text,
    '',
    '历史候选单：',
    list || '（无）',
    '',
    '逐条判定候选单与本需求的关系，只能给这三个词之一：同一件事 / 相关 / 无关。',
    '同时给这条新需求一句概括，用于回执。',
    '返回 JSON：{"verdicts":[{"number":1436,"verdict":"同一件事","reason":"一句话理由"}],"summary":"一句概括"}',
  ].join('\n');
}

// ── 三问 ──────────────────────────────────────────────────────────────

async function runQuestions(thread, deps) {
  const data = await llmJson(() => deps.llm({
    system: PERSONA,
    user: questionsPrompt(thread),
    json: true,
  }));
  const answers = {};
  for (const q of THREE_QUESTIONS) {
    const a = data.answers?.[q.key];
    answers[q.key] = { answered: Boolean(a?.answered), text: String(a?.text ?? '') };
  }
  const questions = (Array.isArray(data.questions) ? data.questions : [])
    .filter(x => typeof x === 'string' && x.trim())
    .map(x => x.trim());
  return { answers, questions };
}

function questionsPrompt(thread) {
  return [
    '飞书同一话题的会话记录：',
    transcriptOf(thread),
    '',
    '三问：① 做到什么算做完（要可验证）② 这批做还是以后 ③ 是否 docs/memory 该记。',
    '判断每条是否已在口语里答了（答了就别再问）；没答的生成一句追问。',
    '返回 JSON：{"answers":{"done":{"answered":true,"text":"答案原文"},"batch":{"answered":false,"text":""},"docs":{"answered":true,"text":"答案原文"}},"questions":["没答的追问1","没答的追问2"]}',
  ].join('\n');
}

// ── 建单 ──────────────────────────────────────────────────────────────

async function runRender(inbound, thread, deps) {
  const data = await llmJson(() => deps.llm({
    system: PERSONA,
    user: renderPrompt(inbound, thread),
    json: true,
  }));
  const title = String(data.title ?? '').trim();
  if (!title) throw new Error('llm 没给标题，不编造');
  const sections = {};
  for (const k of ['现象', '复现或来源', '期望']) {
    sections[k] = String(data.sections?.[k] ?? '').trim() || '（未填写）';
  }
  return { title, sections };
}

function renderPrompt(inbound, thread) {
  const answers = thread.answers ?? {};
  const answerLines = THREE_QUESTIONS
    .map(q => `- ${q.label}：${answers[q.key]?.answered ? answers[q.key].text : '未明确'}`)
    .join('\n');
  return [
    '把下面的口语需求渲染成 issue 正文。',
    '标题给动宾短语，不带 [飞书] 前缀；正文三段：现象 / 复现或来源 / 期望。',
    '',
    '会话记录：',
    transcriptOf(thread),
    '',
    '三问答案：',
    answerLines,
    '',
    '返回 JSON：{"title":"动宾短语","sections":{"现象":"…","复现或来源":"…","期望":"…"}}',
  ].join('\n');
}

// ── 回复/正文拼装（纯函数，格式按 persona 规则） ──────────────────────

function hitReply(dedup) {
  const top = dedup.matched[0];
  const list = [...dedup.matched, ...dedup.related].slice(0, MAX_RELATED_LISTED);
  const lines = [
    `这条跟 #${top.number} 是同一件事，已在 #${top.number} 下补充了你的反馈：${sentence(dedup.summary)}`,
  ];
  if (list.length > 0) {
    lines.push('历史相关单：');
    for (const c of list) lines.push(`#${c.number} ${c.title}`);
  }
  lines.push('需要某一条的具体状态可以告诉我编号。');
  return lines.join('\n');
}

function askReply({ related, missing, questions }) {
  const askNow = missing.slice(0, MAX_ASK_PER_ROUND);
  const lines = [];
  if (related.length > 0) {
    lines.push('这条跟历史单不重复。历史相关单：');
    for (const c of related.slice(0, MAX_RELATED_ON_MISS)) lines.push(`#${c.number} ${c.title}`);
    lines.push('');
  }
  lines.push(`还需要确认 ${askNow.length} 件事：`);
  askNow.forEach((q, i) => lines.push(`${i + 1}. ${questions[i]?.trim() || q.fallback}`));
  return lines.join('\n');
}

function createdReply(created, title, gate) {
  const note = gate === GATE_ALLOWED ? '已消歧' : '待拍板，总控群已通知用户确认';
  return `已建单 #${created.number}：${title}（${note}）\n${created.url}`;
}

function issueBody({ inbound, sections, answers }) {
  return [
    '## 现象',
    sections['现象'],
    '## 复现或来源',
    sections['复现或来源'],
    '## 期望',
    sections['期望'],
    '## 三问答案',
    ...THREE_QUESTIONS.map(q => `- ${q.label}：${answers[q.key]?.answered ? answers[q.key].text : '未明确'}`),
    '## 来源消息',
    '- 渠道：飞书',
    `- chat_id：${inbound.chatId}`,
    `- message_id：${inbound.messageId}`,
  ].join('\n');
}

// ── 小工具 ────────────────────────────────────────────────────────────

function freshThread(inbound) {
  return {
    repo: inbound.repo,
    chatId: inbound.chatId,
    phase: 'dedup',
    msgs: [],
    dedup: null,
    answers: null,
    issue: null,
    createdTs: inbound.ts,
    updatedAt: inbound.ts,
  };
}

function transcriptOf(thread) {
  return thread.msgs
    .map(m => `${m.senderName || m.senderOpenId}：${m.text}`)
    .join('\n');
}

function commentBodyFor(inbound) {
  return `（飞书来源：chat_id ${inbound.chatId} / message_id ${inbound.messageId}）\n${inbound.text}`;
}

function searchQuery(text) {
  return String(text ?? '').trim().slice(0, MAX_QUERY_LEN);
}

function normalizeVerdict(v) {
  return ['同一件事', '相关', '无关'].includes(v) ? v : '无关';
}

/** llm 的 json:true 结果可以是 object 或 string；string 按 JSON 解析，解析不了就抛（→ 兜底话）。 */
function llmJson(call) {
  const raw = call();
  return Promise.resolve(raw).then(asJson);
}

function asJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('llm 返回不是 JSON');
    }
  }
  throw new Error('llm 返回不是 JSON');
}

/** 保证句子以句号结尾（回执句式用）。 */
function sentence(s) {
  const t = String(s ?? '').trim();
  if (!t) return '（无内容）';
  return /[。！？!?]$/.test(t) ? t : `${t}。`;
}

/** 取第一句（截到第一个句末标点/换行），超长截断。 */
export function oneSentence(text) {
  const t = String(text ?? '').trim();
  const m = t.match(/^.*?[。！？!?；;\n]/);
  const first = (m ? m[0] : t).replace(/\s*\n\s*/g, ' ').trim();
  return first.length > MAX_SUMMARY_LEN ? `${first.slice(0, MAX_SUMMARY_LEN)}…` : first;
}
