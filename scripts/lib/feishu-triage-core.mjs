// scripts/lib/feishu-triage-core.mjs —— 飞书 triage 块 B 逻辑（#801 消歧记录 + 补充 2；#852 总帅入口）
//
// 职责：判重 → 三问 → 建单 → 两档放行；hub 群走总帅对话路径（#852）。纯函数 + 注入 deps：
// 不做网络 I/O、不读环境变量；persona.md 在模块装载时读一次（静态配置，算常量不算副作用）。
//
// Inbound（块 A 产出，块 B 只读）：
//   { chatId, rootId /*话题根消息 id*/, messageId, senderOpenId, senderName,
//     text, ts, repo /*由映射表填，hub 群为 null*/, kind /*'project'|'hub'|null（未映射群）*/,
//     hubPending? /*{repo,number}，块 A 从 hubPending 表查到的待拍板归属*/,
//     threadRoot? /*{text,fromBot}，hub thread 回复时块 A 取的话题根消息*/ }
// deps（块 A 注入）：
//   { ghSearch(repo, query) -> [{number,title,url}],
//     ghCreateIssue(repo,{title,body,labels}) -> {number,url},
//     ghComment(repo,number,body),
//     llm({system,user,json?:true}) -> string|object,
//     now() -> number,
//     state /* Map<rootId, ThreadState>，由 A 持久化 */,
//     allowOpenIds: [],
//     hubChat /* docs/dispatch-policy.json 的 hubChat 节（#852），缺省关 */,
//     hubContext() -> {projects:[{repo,situation,error}],health,breaker,…} /* #852 聚合读盘 */ }
// 返回：
//   { replies: [{ rootId, text }],
//     actions: [ {type:'issue_created', repo, number, url, gate:'已消歧'|'待拍板'}
//              | {type:'hub_card', repo, number, url, title, from}
//              | {type:'hub_chat_record', record} /* #852 消费记录，块 A 落 ndjson */ ],
//     state }
//
// 流程（每个话题 rootId 一条状态机）：
//   hub 群（#852）：hubChat.enabled 才走对话路径（无状态，一条消息一答）——
//     待拍板 thread 回复 → 拍板直落对应单（不走 LLM，不猜）；其余 LLM 分类：
//     new_request → HUB_GUIDANCE（唯一保留的指路分支）；decision → 写回对应单；
//     situation/other → 聚合盘面（projects[]+健康表+熔断表）作答。未开 hubChat/未映射群照旧指路。
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
/** #852：拍板意图但定位不到单号时问清，不猜。 */
export const HUB_DECISION_ASK = '要拍板哪张单？回我编号（比如 #846）或那张单的链接，我把结论记上去。';
/** #852：hub 对话意图集合（LLM 分类只认这四个，其余归 other）。 */
export const HUB_INTENTS = ['situation', 'decision', 'new_request', 'other'];

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
const MAX_PENDING_LISTED = 5;

// 报帅单标题里的内部代号（commander-core 的 escalate reason）。标题是给机器查重用的，
// 原样喂给 LLM 会被直译成「唤醒用尽」这种谁也看不懂的词（2026-09-05 实咬：用户问「现状怎么样了」，
// 机器人答「#918 唤醒用尽」）。喂上下文之前先换成人话——改在源头，LLM 就看不到代号。
const REASON_PLAIN = [
  ['two-red', '审官连着判红'],
  ['wake-exhausted', '反复推了都没动静'],
  ['approved-without-review', '判绿记录对不上'],
  ['missing-labels', '缺派工标签'],
  ['unscanned', '没查成'],
];

/** 把标题里的内部代号换成人话。认不出的代号原样留着（不猜、不吞）。 */
export function plainTitle(title) {
  let t = String(title ?? '');
  for (const [code, human] of REASON_PLAIN) {
    t = t.replace(new RegExp(code.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'), 'gi'), human);
  }
  return t;
}
/** 消歧记录：判重候选 = gh search 返回的「前 10 条」。块 B 自己再截一道，A 多返回也不越界。 */
const MAX_DEDUP_CANDIDATES = 10;

/** 块 A 入口：一次入站消息 → 回复 + 动作 + 新状态。 */
export async function triage(inbound, deps) {
  try {
    return await triageInner(inbound, deps);
  } catch (e) {
    // 任何失败（llm/gh 抛错、JSON 不合法）→ 不编造，回兜底话；状态不动，下条消息重试。
    // 错误本身要留痕，不然只能猜（2026-09-03 实咬：--json 不存在、env 没带，日志都一片安静）。
    console.log(JSON.stringify({ type: 'error', where: 'triage', rootId: inbound.rootId, message: String(e?.message || e) }));
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
    // #852 总帅入口：hub 群且 hubChat 开着 → 对话路径。
    // 未映射群 / hubChat 关着 → 维持旧行为：指路，不留状态。
    if (inbound.kind === 'hub' && deps.hubChat?.enabled === true) {
      return triageHub(inbound, deps);
    }
    return { replies: [{ rootId, text: HUB_GUIDANCE }], actions: [], state: deps.state };
  }

  const next = new Map(deps.state);
  // #801 审官实证点：new Map 是浅拷贝，已有话题的 thread 对象与 deps.state 共享引用——
  // 直接改会在后续 deps 失败时污染入参（失败必须不留痕，测试「已有话题失败回滚」）。
  const thread = next.get(rootId) ? cloneThread(next.get(rootId)) : freshThread(inbound);
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
    // 两档放行按「话题发起人」定（审官实证点）：名单内的人补答三问 ≠ 认可外人的需求；
    // 只有发起人自己在名单里，建单才直接 已消歧。
    const gate = deps.allowOpenIds.includes(thread.originOpenId) ? GATE_ALLOWED : GATE_PENDING;
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
        from: thread.originName || thread.originOpenId,
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

// ── 总帅入口（#852）：hub 群对话，先做薄 = 路由 + 聚合 ────────────────
// 无状态：一条消息一答，不进 ThreadState 状态机（拍板留痕在 issue/PR 评论，
// 消费记录在 hub_chat_record → ~/.dao/hub-chat/*.ndjson，由块 A 落盘）。

async function triageHub(inbound, deps) {
  const { rootId } = inbound;
  const allowed = a => Array.isArray(deps.hubChat?.allowedActions) && deps.hubChat.allowedActions.includes(a);
  const reply = (text, rec) => ({
    replies: [{ rootId, text }],
    actions: [hubChatRecord(inbound, deps, { ...rec, reply: text })],
    state: deps.state,
  });

  // ① 机器人在 hub 发起的待拍板 thread：回复即拍板，直落对应单（确定性，不走 LLM，不猜）。
  //    归属两条腿：块 A 的 hubPending 表（本进程发过的卡片）；话题根消息是机器人发的且带单链接（hub-say 旁路）。
  const pending = inbound.hubPending
    || (inbound.threadRoot?.fromBot ? extractIssueRef(inbound.threadRoot.text) : null);
  if (pending?.repo && pending?.number) {
    if (!allowed('decision')) {
      return reply('总控群现在不收拍板，请直接到那张单下面留言。', { intent: 'decision' });
    }
    await deps.ghComment(pending.repo, pending.number, hubDecisionComment(inbound));
    return reply(
      `已记到 #${pending.number}（${shortRepo(pending.repo)}）：${sentence(oneSentence(inbound.text))}`,
      { intent: 'decision', landedTo: `${pending.repo}#${pending.number}` },
    );
  }

  // ② LLM 分类意图（与项目群同款调用：PERSONA system + json；X-Dao-* 溯源头由块 A 的 llm 注入）。
  const cls = await llmJson(() => deps.llm({
    system: PERSONA, user: hubClassifyPrompt(inbound), json: true, daoTask: 'hub-chat',
  }));
  const intent = HUB_INTENTS.includes(cls.intent) ? cls.intent : 'other';

  // 新需求建单仍归项目群——HUB_GUIDANCE 唯一保留的分支（#852）。
  if (intent === 'new_request') return reply(HUB_GUIDANCE, { intent });

  const context = await readHubContextVia(deps);

  if (intent === 'decision') {
    if (!allowed('decision')) {
      return reply('总控群现在不收拍板，请直接到那张单下面留言。', { intent });
    }
    const fallbackRepo = context.projects?.[0]?.repo || null;
    const ref = extractIssueRef(inbound.text, fallbackRepo)
      || (Number.isInteger(cls.issueNumber) && fallbackRepo
        ? { repo: fallbackRepo, number: cls.issueNumber } : null);
    if (!ref) return reply(HUB_DECISION_ASK, { intent });
    await deps.ghComment(ref.repo, ref.number, hubDecisionComment(inbound));
    return reply(
      `已记到 #${ref.number}（${shortRepo(ref.repo)}）：${sentence(oneSentence(inbound.text))}`,
      { intent, landedTo: `${ref.repo}#${ref.number}` },
    );
  }

  // situation / other：聚合盘面作答（只读，不新增动词——#852 后台管理接线③）。
  if (!allowed('situation')) {
    return reply('总控群现在不答盘面。', { intent });
  }
  const answer = await deps.llm({
    system: PERSONA, user: hubAnswerPrompt(inbound, buildHubContextBlock(context)), daoTask: 'hub-chat',
  });
  const text = String(answer ?? '').trim();
  if (!text) throw new Error('llm 空回答，不编造');
  return reply(text, { intent });
}

async function readHubContextVia(deps) {
  if (typeof deps.hubContext !== 'function') return { projects: [], health: null, breaker: null };
  const c = await deps.hubContext();
  return c && typeof c === 'object' ? c : { projects: [], health: null, breaker: null };
}

function hubChatRecord(inbound, deps, { intent, reply, landedTo = null }) {
  return {
    type: 'hub_chat_record',
    record: {
      updatedAt: new Date(deps.now()).toISOString(),
      chatId: inbound.chatId,
      rootId: inbound.rootId,
      messageId: inbound.messageId,
      from: inbound.senderName || inbound.senderOpenId || '',
      question: inbound.text,
      intent,
      reply,
      landedTo,
    },
  };
}

/** 回执里 owner/ 前缀是黑话（2026-09-04 说人话）：只留仓名。 */
function shortRepo(repo) {
  const s = String(repo || '');
  return s.includes('/') ? s.split('/').pop() : s;
}

function hubDecisionComment(inbound) {
  // 溯源（chat_id/message_id）进 HTML 注释：留痕不刷屏（2026-09-04 说人话审官项 9）。
  return [
    `【飞书拍板】${inbound.senderName || inbound.senderOpenId}：${inbound.text}`,
    `<!-- feishu chat_id ${inbound.chatId} / message_id ${inbound.messageId} -->`,
  ].join('\n');
}

function hubClassifyPrompt(inbound) {
  return [
    `总控群里 ${inbound.senderName || inbound.senderOpenId} @机器人 说：`,
    inbound.text,
    '',
    '判断意图，四选一：',
    '- situation：问盘面/进展/供应商健康/某张单的状态（只读问答）',
    '- decision：对某张待拍板的单给出拍板/确认/选择',
    '- new_request：提出要建单的新需求（要做新东西/改代码）',
    '- other：其他（临时指令、问用法、闲聊）',
    '返回 JSON：{"intent":"situation","issueNumber":846,"reason":"一句话"}（没提到单号则 issueNumber 为 null）',
  ].join('\n');
}

function hubAnswerPrompt(inbound, contextBlock) {
  return [
    `总控群里 ${inbound.senderName || inbound.senderOpenId} 问：`,
    inbound.text,
    '',
    '机读盘面（聚合自各项目指挥官态势 + 供应商健康表 + 熔断表）：',
    contextBlock,
    '',
    '用盘面数据回答；数据里没有的就说没查到，不编造。提到单子带编号。',
    '说人话（对方是老板不是运维）：三段式——出了什么事 / 对他有什么影响 / 打算怎么办（要不要他拍）。',
    '不出现路径、命令、pid、timer、gw:/leg:/direct: 这类内部代号；供应商线路用日常叫法（如「grok 模型池」「codex 审官直连」）。一条回复 ≤ 8 行。',
  ].join('\n');
}

/** #852 聚合层：盘面上下文 → 文本块。projects[] 逐项目渲染——多项目即多段（结构留好接口）。
 *  没读到的面明说「没查成」，与「查过没事」分开形（CLAUDE.md）。 */
export function buildHubContextBlock(context = {}) {
  const lines = [];
  const projects = Array.isArray(context.projects) ? context.projects : [];
  if (projects.length === 0) lines.push('【项目态势】没查成：一个项目的态势文件都没读到。');
  for (const p of projects) {
    const repo = p?.repo || '（未知项目）';
    const s = p?.situation;
    if (!s || typeof s !== 'object') {
      lines.push(`【项目 ${repo} 态势】没查成：${p?.error || '无态势文件'}`);
      continue;
    }
    lines.push(`【项目 ${s.repo || repo} 态势 @ ${s.at || '未知时间'}】`);
    const gh = s.github;
    if (gh?.scanned) {
      const issues = Array.isArray(gh.issues) ? gh.issues : [];
      const prs = Array.isArray(gh.prs) ? gh.prs : [];
      lines.push(`开放 issues ${issues.length} 张 / PRs ${prs.length} 张`);
      const pending = issues.filter(i => (Array.isArray(i.labels) ? i.labels : [])
        .some(l => (l && typeof l === 'object' ? l.name : l) === GATE_PENDING));
      if (pending.length > 0) {
        lines.push(`待拍板 ${pending.length} 张：`);
        for (const i of pending.slice(0, MAX_PENDING_LISTED)) lines.push(`  #${i.number} ${plainTitle(i.title)}`);
      } else {
        lines.push('待拍板 0 张');
      }
    } else {
      lines.push(`github 面没查成：${gh?.error || '未扫'}`);
    }
    for (const [key, label] of [['orca', '工人树'], ['reviewPending', '复审队列'], ['stall', '卡死探测']]) {
      const sec = s[key];
      if (sec && sec.scanned === false) lines.push(`${label} 面没查成：${sec.error || ''}`);
    }
  }
  const h = context.health;
  if (h && typeof h === 'object' && h.targets && typeof h.targets === 'object') {
    const entries = Object.entries(h.targets);
    const red = entries.filter(([, v]) => v?.state === 'red');
    lines.push(`【供应商健康 @ ${h.updatedAt || '未知'}】共 ${entries.length} 路，红 ${red.length} 路${red.length ? '：' : ''}`);
    for (const [name, v] of red) lines.push(`  ${name}（${v.why || v.code || '原因未知'}）`);
  } else {
    lines.push(`【供应商健康】没查成：${context.healthError || '健康表没读到'}`);
  }
  const b = context.breaker;
  if (b && typeof b === 'object' && b.targets && typeof b.targets === 'object') {
    const open = Object.entries(b.targets).filter(([, v]) => v?.state && v.state !== 'closed');
    lines.push(open.length
      ? `【熔断 @ ${b.updatedAt || '未知'}】非 closed ${open.length} 路：${open.map(([n, v]) => `${n}=${v.state}`).join('、')}`
      : `【熔断 @ ${b.updatedAt || '未知'}】全部 closed`);
  } else {
    lines.push(`【熔断】没查成：${context.breakerError || '熔断表没读到'}`);
  }
  return lines.join('\n');
}

/** #852：从文本抽 issue/PR 引用。优先级：完整 URL > owner/repo#N > 裸 #N（要 fallbackRepo）。
 *  抽不到返回 null——问编号，不猜。 */
export function extractIssueRef(text, fallbackRepo = null) {
  const t = String(text ?? '');
  let m = t.match(/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/);
  if (m) return { repo: m[1], number: Number(m[2]) };
  m = t.match(/([\w.-]+\/[\w.-]+)#(\d+)/);
  if (m) return { repo: m[1], number: Number(m[2]) };
  m = t.match(/#(\d+)/);
  if (m && fallbackRepo) return { repo: fallbackRepo, number: Number(m[1]) };
  return null;
}

// ── 判重 ──────────────────────────────────────────────────────────────

async function runDedup(inbound, deps) {
  const candidates = (await deps.ghSearch(inbound.repo, searchQuery(inbound.text)))
    .slice(0, MAX_DEDUP_CANDIDATES);
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
    originOpenId: inbound.senderOpenId,
    originName: inbound.senderName || '',
    createdTs: inbound.ts,
    updatedAt: inbound.ts,
  };
}

/** 深拷 ThreadState：triage 只改自己的副本，失败时入参 Map 原样归还（不污染）。 */
function cloneThread(t) {
  if (!t || typeof t !== 'object') return freshThread({ repo: null, chatId: null, ts: 0 });
  const clone = { ...t, msgs: [], dedup: null, answers: null, issue: null };
  clone.msgs = Array.isArray(t.msgs) ? t.msgs.map(m => ({ ...m })) : [];
  if (t.dedup) {
    clone.dedup = {
      ...t.dedup,
      verdicts: Array.isArray(t.dedup.verdicts) ? t.dedup.verdicts.map(v => ({ ...v })) : [],
      matched: Array.isArray(t.dedup.matched) ? t.dedup.matched.map(v => ({ ...v })) : [],
      related: Array.isArray(t.dedup.related) ? t.dedup.related.map(v => ({ ...v })) : [],
    };
  }
  if (t.answers) {
    clone.answers = {};
    for (const q of THREE_QUESTIONS) {
      const a = t.answers[q.key];
      clone.answers[q.key] = a ? { answered: !!a.answered, text: String(a.text ?? '') } : { answered: false, text: '' };
    }
  }
  if (t.issue) clone.issue = { ...t.issue };
  return clone;
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
