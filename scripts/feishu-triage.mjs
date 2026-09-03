#!/usr/bin/env node
// scripts/feishu-triage.mjs —— 飞书适配器 块A（issue #801 Phase 2；#852 总帅入口）
//
// 职责（按 #801 消歧记录 + 补充2；hub 对话按 #852）：
//   · live 模式：读凭据 ~/.mirasim/keys/feishu-app.json（600，不进 git）与群映射表
//     host/machine/feishu-groups.json；用官方 SDK 的 WSClient.start 长连接订阅
//     im.message.receive_v1（无公网回调）。
//   · --fixture <events.jsonl> 模式：用文件事件源代替长连接（测试/无凭据开发用），
//     处理完全部事件后退出。
//   · 每条入站消息归一化成 Inbound 后调块B `triage(inbound, deps)`；对返回的
//     replies 用 im.v1.message.reply 回到同一话题，对 actions 逐条执行
//     （hub_card → 总控群卡片；issue_created → 留账，回执已在 replies 里；
//      hub_chat_record → 落 ~/.dao/hub-chat/<日期>.ndjson，#852 消费记录）。
//   · deps 按记录：{ghSearch, ghCreateIssue, ghComment, now, state(Map),
//     allowOpenIds, llm, hubChat, hubContext}；llm 按补充2：HK 网关 ANTHROPIC_BASE_URL +
//     /v1/chat/completions、model grok-4.6、key 读 ~/.mirasim/keys/feishu-triage.key
//     （#823，专用 token，不进聊天/不进仓）、超时 60s、失败抛错（块B 收到错误回「稍后重试」，不编造）。
//     fetch 带 X-Dao-Actor / X-Dao-Task / X-Dao-Run，网关落 logs.other。
//   · hub 对话（#852）：开关/允许动作读 docs/dispatch-policy.json 的 hubChat 节
//     （loadHubChatPolicy）；聚合读盘 readHubContext（projects[] 各自 situation 文件，
//     现在一个项目，结构上支持多个）+ 健康表 + 熔断表；待拍板 thread 归属先查
//     state 的 hubPending 表（本进程发过的卡），查不到再取话题根消息判「机器人发起 + 带单链接」。
//   · 话题状态 Map 由本文件持久化到 ~/.dao/feishu-threads.json（每次事件后落盘）。
//
// 块A/块B 并行（#801 记录）：B 缺席时本文件自动用空 triage 桩（stubTriage），
// --fixture 照常跑通；B 落地（scripts/lib/feishu-triage-core.mjs 出现）后启动时
// 自动换真 core，先合谁都不破 master。
//
// SDK 依赖策略：本仓是纯 Node 工具仓（无 node_modules，CI/测试不装任何包）。
// 官方 SDK（@larksuiteoapi/node-sdk，live 长连接才需要）惰性加载——
// 服务器上装一次：cd host/machine/feishu-triage && npm install --omit=dev。
// fixture 模式与全部测试都不碰 SDK。
//
// 用法：
//   node scripts/feishu-triage.mjs                           live 长连接常驻
//   node scripts/feishu-triage.mjs --fixture <events.jsonl>  文件事件源，处理完退出
//   node scripts/feishu-triage.mjs --help                    本帮助
//
// 参数：
//   --fixture <file>  用 JSONL 事件文件代替长连接（每行一个 im.message.receive_v1
//                     事件；# 开头为注释行）
//   --groups <file>   群映射表（默认 host/machine/feishu-groups.json）
//   --creds <file>    凭据（默认 ~/.mirasim/keys/feishu-app.json；fixture 模式可缺）
//   --state <file>    话题状态文件（默认 ~/.dao/feishu-threads.json）
//
// 环境变量：
//   ANTHROPIC_BASE_URL  llm 网关（补充2：与 claude 同一网关；systemd drop-in 注入）
//   FEISHU_GH           假 gh 可执行（测试用；默认 gh）
//   FEISHU_CORE_MODULE  块B core 模块覆盖（测试用；默认 scripts/lib/feishu-triage-core.mjs）
//   FEISHU_SDK_ROOT     SDK 安装目录（默认 host/machine/feishu-triage/node_modules）
//   HUB_CHAT_DIR        hub 对话消费记录目录（测试用；默认 ~/.dao/hub-chat）
//
// stdout 契约：JSON Lines（fixture 模式机器可读；live 模式进 journal）。
//   每事件：{"type":"inbound","inbound":{...}}
//   每回执：{"type":"reply","rootId":...,"text":...}
//   每动作：{"type":"action","action":{...}}
//   结束：  {"type":"done","lines":N,"processed":N,"skipped":N,"replies":N,"actions":N}
// 诊断一律走 stderr，不进 stdout 契约。

import { spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), '..');

export const DEFAULT_GROUPS = join(REPO_ROOT, 'host', 'machine', 'feishu-groups.json');
export const DEFAULT_CREDS = join(homedir(), '.mirasim', 'keys', 'feishu-app.json');
export const DEFAULT_STATE = join(homedir(), '.dao', 'feishu-threads.json');
export const SDK_DIR = join(REPO_ROOT, 'host', 'machine', 'feishu-triage', 'node_modules');
export const FEISHU_TRIAGE_KEY = join(homedir(), '.mirasim', 'keys', 'feishu-triage.key');
/** @deprecated #823 飞书 llm 改读 feishu-triage.key */
export const GROK_KEY = FEISHU_TRIAGE_KEY;
/** #852：策略真相源与聚合读盘落点。 */
export const DEFAULT_POLICY = join(REPO_ROOT, 'docs', 'dispatch-policy.json');
export const DEFAULT_HUB_CHAT_DIR = join(homedir(), '.dao', 'hub-chat');
/** 机器人自己判重/分类/作答用的模型。必须在网关白名单里（ai-gateway-stack §68 大扫除砍了 253 条，
 *  砍掉的模型请求会 503「No available channel」）。换模型改这里，别散落。 */
export const LLM_MODEL = process.env.FEISHU_LLM_MODEL || 'grok-4.6';
/** llm 单次预算。2026-09-04 实咬：非流式 + 60s 在 grok 排队时必超时（单次大 prompt 实测 26s，
 *  盘面问答两跳）。导出成常量是为了测试能把 180000 这个数**读回来**验，而不是只验「有个信号量」。 */
export const LLM_TIMEOUT_MS = Number(process.env.FEISHU_LLM_TIMEOUT_MS || 180000);
export const COMMANDER_DIR = join(homedir(), '.dao', 'commander');
export const PROVIDER_HEALTH_FILE = join(homedir(), '.dao', 'provider-health.json');
export const PROVIDER_BREAKER_FILE = join(homedir(), '.dao', 'provider-breaker.json');

function log(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function warn(msg) {
  process.stderr.write(`[feishu-triage] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// 归一化：飞书事件 → Inbound（块B 只读这份契约）
//   { chatId, rootId, messageId, senderOpenId, senderName, text, ts, repo, kind }
// 群映射表填 repo（hub 群 / 未映射群为 null）与 kind（'project'|'hub'|null）。
// 返回 null = 本事件不处理（机器人自己的消息 / 非文本 / 空文本 / 缺关键字段）。
export function normalizeInbound(event, groups = {}) {
  // webhook 结构 {schema,header,event:{message,sender}}；SDK WSClient 长连接推的是扁平 {schema,event_type,message,sender}
  // （2026-09-03 实咬：只认前者时长连接事件全被静默丢弃，日志一片安静）
  const ev = event && typeof event === 'object' ? (event.event || (event.message ? event : {})) : {};
  const sender = ev.sender || {};
  const senderId = sender.sender_id || {};
  const msg = ev.message || {};
  const chatId = msg.chat_id;
  const messageId = msg.message_id;
  if (!chatId || !messageId) return null;
  // 机器人自己的消息不处理（防回声环；飞书群里 app 发的消息也会被推送）
  if (sender.sender_type === 'app') return null;
  // MVP：只收文本消息；图片/富文本/文件等先跳过（#801 记录：口语 → triage）
  if (msg.message_type !== 'text') return null;
  let text = '';
  try {
    text = String(JSON.parse(msg.content || '{}').text || '').replace(/@_user_[0-9]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  } catch {
    text = '';
  }
  if (!text) return null;
  const mapping = groups[chatId];
  const repo = mapping && mapping.kind === 'project' ? mapping.repo : null;
  return {
    chatId,
    rootId: msg.root_id || messageId,
    parentId: msg.parent_id || '',
    messageId,
    senderOpenId: senderId.open_id || '',
    senderName: String(sender.sender_name || '').trim(),
    text,
    ts: Number(msg.create_time) || Date.now(),
    repo,
    kind: mapping ? mapping.kind : null,
  };
}

// ---------------------------------------------------------------------------
// 群映射表：{ "<chat_id>": { "repo": "...", "kind": "project" } | { "kind": "hub" } }
// `_` 开头的键是注释（模板占位），不参与映射。
export function loadGroups(file) {
  let j;
  try {
    j = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`群映射表读不了（${file}）：${e.message}`);
  }
  const groups = {};
  for (const [chatId, v] of Object.entries(j || {})) {
    if (chatId.startsWith('_')) continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error(`群 ${chatId} 的映射不是对象`);
    }
    if (v.kind === 'project') {
      if (typeof v.repo !== 'string' || !v.repo) {
        throw new Error(`群 ${chatId} 是 project 但缺 repo`);
      }
      groups[chatId] = { repo: v.repo, kind: 'project' };
    } else if (v.kind === 'hub') {
      groups[chatId] = { kind: 'hub' };
    } else {
      throw new Error(`群 ${chatId} 的 kind 不认识：${v.kind}`);
    }
  }
  return groups;
}

// 凭据：{appId, appSecret, hubChatId, allowOpenIds:[]}（#801 记录；600，不进 git）
export function loadCredentials(file) {
  let j;
  try {
    j = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`凭据读不了（${file}）：${e.message}`);
  }
  const { appId, appSecret, hubChatId, allowOpenIds } = j || {};
  if (typeof appId !== 'string' || !appId) throw new Error('凭据缺 appId');
  if (typeof appSecret !== 'string' || !appSecret) throw new Error('凭据缺 appSecret');
  return {
    appId,
    appSecret,
    hubChatId: typeof hubChatId === 'string' ? hubChatId : '',
    allowOpenIds: Array.isArray(allowOpenIds) ? allowOpenIds : [],
  };
}

// ---------------------------------------------------------------------------
// #852：hub 对话策略，真相源 docs/dispatch-policy.json 的 hubChat 节（取值范围归 dao-check）。
// 读不到 / 缺节 = 关（hub 一律指路，旧行为），不猜。
export function loadHubChatPolicy(file = DEFAULT_POLICY) {
  let j;
  try {
    j = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { enabled: false, allowedActions: [], upstream: {} };
  }
  const h = j?.hubChat;
  if (!h || typeof h !== 'object') return { enabled: false, allowedActions: [], upstream: {} };
  return {
    enabled: h.enabled === true,
    allowedActions: Array.isArray(h.allowedActions) ? h.allowedActions.filter(x => typeof x === 'string') : [],
    upstream: h.upstream && typeof h.upstream === 'object' ? h.upstream : {},
  };
}

// #852 聚合层：projects[] 逐项目读最新 situation-*.json（#800 指挥官的眼睛，不造第二套）；
// 健康表/熔断表全局一份。现在一个项目（~/.dao/commander），结构上支持多个：
// 多项目 = 传多个 {repo, dir}。repo 缺省从态势文件自己的 repo 字段读。
// 读不到的面记 error/…Error 字段——「没查成」与「查过没事」分开形。
export function readHubContext({
  projects = [{ repo: null, dir: COMMANDER_DIR }],
  healthFile = PROVIDER_HEALTH_FILE,
  breakerFile = PROVIDER_BREAKER_FILE,
} = {}) {
  const out = { projects: [], health: null, healthError: null, breaker: null, breakerError: null };
  for (const p of projects) {
    let situation = null;
    let error = null;
    try {
      const files = readdirSync(p.dir).filter(f => /^situation-.*\.json$/.test(f)).sort();
      const latest = files[files.length - 1];
      if (!latest) error = `没有 situation 文件（${p.dir}）`;
      else situation = JSON.parse(readFileSync(join(p.dir, latest), 'utf8'));
    } catch (e) {
      error = `态势读失败：${e.message}`;
    }
    out.projects.push({ repo: p.repo || situation?.repo || null, situation, error });
  }
  try {
    out.health = JSON.parse(readFileSync(healthFile, 'utf8'));
  } catch (e) {
    out.healthError = `健康表读失败：${e.message}`;
  }
  try {
    out.breaker = JSON.parse(readFileSync(breakerFile, 'utf8'));
  } catch (e) {
    out.breakerError = `熔断表读失败：${e.message}`;
  }
  return out;
}

// #852：hub 对话消费记录（谁问/答了什么/落到哪个单），NDJSON 按天一个文件，行带 updatedAt。
export function appendHubChatRecord(record, dir = process.env.HUB_CHAT_DIR || DEFAULT_HUB_CHAT_DIR) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const day = String(record?.updatedAt || new Date().toISOString()).slice(0, 10);
  appendFileSync(join(dir, `${day}.ndjson`), JSON.stringify(record) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// 话题状态：Map<rootId, ThreadState>，持久化到 ~/.dao/feishu-threads.json。
// 块B 直接读写 map（deps.state 就是它）；本文件每次事件后落盘（tmp+rename 防半写）。
export function createStateStore(file) {
  let map = new Map();
  // aliases：机器人回过的每条消息 id → 原话题根 id。飞书网页端对机器人那条「回复」会另开话题
  // （root_id 变成机器人消息），不建这张表状态机就把追答当成新需求重问（2026-09-03 实咬）。
  let aliases = {};
  // hubPending（#852）：机器人在 hub 发的待拍板卡片消息 id → {repo, number}。
  // 用户在该 thread 回复即拍板，直落对应单。
  let hubPending = {};
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      const threads = (j && typeof j === 'object' && j.threads) || {};
      for (const [k, v] of Object.entries(threads)) map.set(k, v);
      if (j && typeof j.aliases === 'object' && j.aliases) aliases = j.aliases;
      if (j && typeof j.hubPending === 'object' && j.hubPending) hubPending = j.hubPending;
    } catch (e) {
      warn(`状态文件读不了（${file}），从空开始：${e.message}`);
    }
  }
  const store = {
    map,
    aliases,
    hubPending,
    // 把消息 id 顺着别名表归到原话题根（最多走 5 跳，防环）
    canonicalRoot(...ids) {
      for (const id0 of ids) {
        if (!id0) continue;
        let id = id0;
        for (let i = 0; i < 5 && store.aliases[id]; i++) id = store.aliases[id];
        if (id !== id0 || store.map.has(id)) return id;
      }
      return ids.find(Boolean) || '';
    },
    save() {
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        threads: Object.fromEntries(store.map),
        aliases: store.aliases,
        hubPending: store.hubPending,
      };
      const dir = dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(tmp, file);
    },
  };
  return store;
}

// ---------------------------------------------------------------------------
// 块B core 载入：B 缺席 → 空 triage 桩（#801 记录：A 在 B 缺席时以 --fixture
// 跑通空 triage 桩）。FEISHU_CORE_MODULE 只给测试/开发覆盖用。
export async function stubTriage(inbound, deps) {
  return { replies: [], actions: [], state: deps.state };
}

export async function loadCore() {
  const override = process.env.FEISHU_CORE_MODULE;
  if (override) {
    try {
      const mod = await import(override.startsWith('file:') ? override : `file://${resolve(override).replace(/\\/g, '/')}`);
      if (typeof mod.triage !== 'function') throw new Error('缺 triage');
      return { triage: mod.triage, source: 'override' };
    } catch (e) {
      warn(`FEISHU_CORE_MODULE 载入失败（${e.message}），回落默认`);
    }
  }
  try {
    const mod = await import('./lib/feishu-triage-core.mjs');
    if (typeof mod.triage !== 'function') throw new Error('core 缺 triage');
    return { triage: mod.triage, source: 'core' };
  } catch (e) {
    warn(`块B（lib/feishu-triage-core.mjs）未就绪：${e.message}。用空 triage 桩（fixture 可跑通）`);
    return { triage: stubTriage, source: 'stub' };
  }
}

// ---------------------------------------------------------------------------
// deps.llm（补充2）：HK 网关 grok。
//   POST ${ANTHROPIC_BASE_URL}/v1/chat/completions，model grok-4.6，
//   key 读 ~/.mirasim/keys/feishu-triage.key（#823），超时 60s；失败抛错（块B 收到错误回「稍后重试」）。
//   三头：X-Dao-Actor=feishu-triage，X-Dao-Task=<repo>#<已建单号或 triage>，X-Dao-Run=<chatId>。
export function daoTraceHeaders({ repo, issueNumber, chatId, actor, daoTask, daoRun, daoActor } = {}) {
  const r = String(repo || '').trim();
  const n = issueNumber == null || String(issueNumber).trim() === '' ? '' : String(issueNumber).trim();
  const task = daoTask
    || (r ? `${r}#${n || 'triage'}` : (n || 'triage'));
  return {
    'X-Dao-Actor': daoActor || actor || 'feishu-triage',
    'X-Dao-Task': task,
    'X-Dao-Run': daoRun || String(chatId || '').trim() || 'feishu-triage',
  };
}

/** SSE 流累积成整段文本。只认 choices[0].delta.content，忽略心跳与其它字段。 */
export async function readSseText(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const d = j?.choices?.[0]?.delta?.content;
        if (typeof d === 'string') out += d;
      } catch { /* 半截 JSON：下一轮拼齐再解析 */ }
    }
  }
  return out;
}

export function makeLlm({
  gateway, keyPath = FEISHU_TRIAGE_KEY, fetchImpl = fetch,
  // 2026-09-04 实咬：非流式 + 60s 在 grok 排队时必超时（单次大 prompt 实测 26s，盘面问答两跳）——
  // 与「探针一律流式」同一条教训：走流式（首字节就开始收，不被网关空闲切断），预算给足。
  timeoutMs = LLM_TIMEOUT_MS, traceRef = null,
} = {}) {
  return async function llm({ system, user, json = false, daoTask, daoRun, daoActor } = {}) {
    if (!gateway) throw new Error('ANTHROPIC_BASE_URL 未设置——llm 不可用（补充2：网关与 claude 同源，systemd drop-in 注入）');
    let key;
    try {
      key = readFileSync(keyPath, 'utf8').trim();
    } catch (e) {
      throw new Error(`feishu-triage key 读不到（${keyPath}）：${e.message}`);
    }
    if (!key) throw new Error('feishu-triage key 为空');
    let resp;
    try {
      const inbound = traceRef && traceRef.current;
      const store = traceRef && traceRef.store;
      const thread = inbound && store && store.map && store.map.get(inbound.rootId);
      const headers = { 'content-type': 'application/json' };
      headers.authorization = `Bearer ${key}`;
      Object.assign(headers, daoTraceHeaders({
        repo: inbound && inbound.repo,
        issueNumber: thread && thread.issue && thread.issue.number,
        chatId: inbound && inbound.chatId,
        daoTask,
        daoRun,
        daoActor,
      }));
      resp = await fetchImpl(`${gateway}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: LLM_MODEL,
          stream: true,
          messages: [
            { role: 'system', content: String(system ?? '') },
            { role: 'user', content: String(user ?? '') },
          ],
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`llm 调用失败：${e.message}`);
    }
    if (!resp.ok) throw new Error(`llm HTTP ${resp.status}`);
    let text;
    if (resp.body && typeof resp.body.getReader === 'function') {
      try {
        text = await readSseText(resp.body);
      } catch (e) {
        throw new Error(`llm 流读失败：${e.message}`);
      }
    } else {
      // 非流式回退（伪 fetch / 网关不给流）：读整段 JSON。
      let data;
      try {
        data = await resp.json();
      } catch (e) {
        throw new Error(`llm 响应不是 JSON：${e.message}`);
      }
      text = data?.choices?.[0]?.message?.content;
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error('llm 空返回');
    if (!json) return text;
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`llm JSON 解析失败：${e.message}`);
    }
  };
}

// ---------------------------------------------------------------------------
// deps 的 gh 三件套：判重搜索 / 建单 / 追评。
// 判重用 `gh search issues` 前 10 条（#801 红线②：不上向量库）。
// 适配器进程本身不持 GitHub 凭据——shell 出去的 gh 用本机登录态（#801 记录）。
export function runGh(ghBin, args, { timeout = 60000 } = {}) {
  // 不 shell:true：Windows 上 cmd 会把带换行的 --body 拆开（#573 教训）
  const r = spawnSync(ghBin, args, { encoding: 'utf8', timeout, shell: false });
  if (r.error) return { ok: false, reason: `spawn 失败：${r.error.code || r.error.message}` };
  if (r.signal) return { ok: false, reason: `被信号打断：${r.signal}` };
  return { ok: r.status === 0, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function makeGhDeps({ ghBin = process.env.FEISHU_GH || 'gh', run = runGh } = {}) {
  async function ghSearch(repo, query) {
    const r = await run(ghBin, ['search', 'issues', String(query), '--repo', repo, '--limit', '10', '--json', 'number,title,url']);
    if (!r.ok) throw new Error(`gh search 失败：${r.reason || r.stderr || r.code}`);
    let list;
    try {
      list = JSON.parse(r.stdout);
    } catch (e) {
      throw new Error(`gh search 输出不是 JSON：${e.message}`);
    }
    return (Array.isArray(list) ? list : []).map((x) => ({ number: x.number, title: x.title, url: x.url }));
  }

  async function ghCreateIssue(repo, { title, body, labels = [] } = {}) {
    const args = ['issue', 'create', '--repo', repo, '--title', String(title ?? ''), '--body', String(body ?? '')];
    for (const l of labels) args.push('--label', String(l));
    // gh issue create 没有 --json（gh 2.99 实测 unknown flag）：stdout 最后一行是 issue URL，从里面取号
    const r = await run(ghBin, args);
    if (!r.ok) throw new Error(`gh issue create 失败：${r.reason || r.stderr || r.code}`);
    const lines = String(r.stdout || '').trim().split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
    const url = lines.pop() || '';
    const m = url.match(new RegExp('/issues/([0-9]+)$'));
    if (!m) throw new Error(`gh issue create 输出里没有 issue URL：${url.slice(0, 200)}`);
    return { number: Number(m[1]), url };
  }

  async function ghComment(repo, number, body) {
    const r = await run(ghBin, ['issue', 'comment', String(number), '--repo', repo, '--body', String(body ?? '')]);
    if (!r.ok) throw new Error(`gh issue comment 失败：${r.reason || r.stderr || r.code}`);
    return true;
  }

  return { ghSearch, ghCreateIssue, ghComment };
}

// ---------------------------------------------------------------------------
// deps 装配（记录：{ghSearch, ghCreateIssue, ghComment, now, state, allowOpenIds, llm}
// + #852：hubChat 策略与 hubContext 聚合读盘）
export function buildDeps({
  creds = null, store, gateway = process.env.ANTHROPIC_BASE_URL || '', ghBin, run, fetchImpl,
  hubChat = null, hubContext = null,
} = {}) {
  const gh = makeGhDeps({ ghBin, run });
  const daoTraceRef = { current: null, store };
  return {
    ...gh,
    now: () => new Date(),
    // getter 不是快照：handleEvent 会把 store.map 换成 core 返回的新 Map，快照会让下一条消息读到旧状态
    // （2026-09-03 实咬：三问答过的又被重问）。
    get state() { return store.map; },
    allowOpenIds: Array.isArray(creds?.allowOpenIds) ? creds.allowOpenIds : [],
    llm: makeLlm({ gateway, fetchImpl, traceRef: daoTraceRef }),
    hubChat: hubChat ?? loadHubChatPolicy(),
    hubContext: hubContext ?? (async () => readHubContext()),
    daoTraceRef,
  };
}

// ---------------------------------------------------------------------------
// live 模式：官方 SDK 的 WSClient 长连接（惰性加载；见文件头 SDK 依赖策略）
export function loadSdk({ sdkRoot = process.env.FEISHU_SDK_ROOT || SDK_DIR } = {}) {
  try {
    const req = createRequire(import.meta.url);
    const resolved = req.resolve('@larksuiteoapi/node-sdk', { paths: [sdkRoot] });
    return req(resolved);
  } catch (e) {
    throw new Error(
      `飞书 SDK 没装上：${e.message}。服务器上装一次：`
      + `cd ${dirname(SDK_DIR)} && npm install --omit=dev（测试/CI 不需要，fixture 模式不碰）`,
    );
  }
}

export function makeFeishuClient(sdk, creds) {
  const lark = sdk;
  const { appId, appSecret } = creds;
  const client = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  });
  const nameCache = new Map();
  return {
    // node-sdk：长连接是独立的 WSClient，事件经 EventDispatcher 注册（帅 2026-09-03 实况热修；正式修复见 PR #806 红项）
    _handler: null,
    async start() {
      const ws = new lark.WSClient({ appId, appSecret, loggerLevel: lark.LoggerLevel.info, domain: lark.Domain.Feishu });
      const dispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => { if (this._handler) await this._handler(data); },
      });
      await ws.start({ eventDispatcher: dispatcher });
    },
    onEvent(handler) { this._handler = handler; },
    // 回同一话题：reply 到话题根消息（rootId）
    async reply(rootId, text) {
      const r = await client.im.v1.message.reply({
        path: { message_id: rootId },
        data: { content: JSON.stringify({ text }), msg_type: 'text' },
      });
      if (r.code !== 0) throw new Error(`im.v1.message.reply 失败：code=${r.code} msg=${r.msg}`);
      return r.data?.message_id || '';
    },
    // 总控群卡片（hub_card action）。返回卡片消息 id——#852 hubPending 表要用它对回 thread。
    async sendCard(chatId, card) {
      const r = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
      });
      if (r.code !== 0) throw new Error(`im.v1.message.create 失败：code=${r.code} msg=${r.msg}`);
      return r.data?.message_id || '';
    },
    // #852：取单条消息（hub thread 回复时判话题根归属：机器人发的 + 带单链接 = 待拍板 thread）。
    async fetchMessage(messageId) {
      const r = await client.im.v1.message.get({ path: { message_id: messageId } });
      if (r.code !== 0) throw new Error(`im.v1.message.get 失败：code=${r.code} msg=${r.msg}`);
      const item = (r.data?.items || [])[0] || {};
      let text = '';
      try {
        text = String(JSON.parse(item.body?.content || '{}').text || '');
      } catch {
        text = '';
      }
      // 卡片消息的 content 是卡片 JSON——原样给下游抽 issue 链接够用
      if (!text) text = String(item.body?.content || '');
      return { text, fromBot: item.sender?.sender_type === 'app' };
    },
    // 说话人名字（contact 只读权限；失败返回 ''，块B 用 open_id 兜底）
    async userName(openId) {
      if (!openId) return '';
      if (nameCache.has(openId)) return nameCache.get(openId);
      try {
        const r = await client.contact.v3.user.get({
          params: { user_id_type: 'open_id' },
          path: { user_id: openId },
        });
        const name = r?.data?.user?.name || '';
        nameCache.set(openId, name);
        return name;
      } catch (e) {
        warn(`取用户名失败（open_id=${openId}）：${e.message}`);
        nameCache.set(openId, '');
        return '';
      }
    },
  };
}

// hub_card → 总控群互动卡片（待拍板）
export function buildHubCard({ repo, number, url, title, from } = {}) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `待拍板：${repo || ''}#${number ?? ''}` },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${title || ''}**\n来自：${from || '未知'}\n仓库：${repo || '-'}\n[查看 issue](${url || ''})`,
        },
      },
      {
        tag: 'action',
        actions: [{ tag: 'button', text: { tag: 'plain_text', content: '去拍板' }, type: 'primary', url: url || '' }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// actions 逐条执行（记录：issue_created / hub_card；hub_chat_record 在 handleEvent 落盘不进这里）
export async function executeAction(client, creds, action, store = null) {
  switch (action?.type) {
    case 'issue_created':
      // 回执已由 replies 发回话题；这里只留账（块A 不做别的飞书动作）
      log({ type: 'action-executed', actionType: 'issue_created', repo: action.repo, number: action.number, gate: action.gate });
      return;
    case 'hub_card': {
      const hubChatId = creds?.hubChatId;
      if (!hubChatId) {
        log({ type: 'action-skipped', reason: '凭据无 hubChatId', actionType: 'hub_card' });
        return;
      }
      const cardMsgId = await client.sendCard(hubChatId, buildHubCard(action));
      // #852：记卡片消息 id → 单号；该 thread 里的回复即拍板，直落对应单
      if (cardMsgId && store && store.hubPending && action.repo && action.number) {
        store.hubPending[cardMsgId] = { repo: action.repo, number: action.number };
      }
      log({ type: 'action-executed', actionType: 'hub_card', chatId: hubChatId });
      return;
    }
    default:
      log({ type: 'action-skipped', reason: '未知类型', actionType: action?.type });
  }
}

// ---------------------------------------------------------------------------
// 事件处理主链：归一化 → triage → replies 回话题 → actions 逐条执行 → 状态落盘
// 返回 null = 事件不处理；否则返回 { inbound, replies, actions }（fixture 计数用）。
export async function handleEvent(event, { groups, store, deps, triage, client, creds = null }) {
  const inbound = normalizeInbound(event, groups);
  if (!inbound) {
    if (client) log({ type: 'skip', reason: 'normalize-null', eventType: event?.event_type || event?.header?.event_type || '', chatId: event?.message?.chat_id || event?.event?.message?.chat_id || '' });
    return null;
  }
  if (client?.userName && !inbound.senderName) {
    inbound.senderName = await client.userName(inbound.senderOpenId);
  }
  if (store?.canonicalRoot) {
    const canon = store.canonicalRoot(inbound.rootId, inbound.parentId);
    if (canon && canon !== inbound.rootId) { inbound.aliasedFrom = inbound.rootId; inbound.rootId = canon; }
  }
  // #852 hub 待拍板 thread 归属：先查 hubPending 表（本进程发过的卡）；查不到且是 thread 回复，
  // 取话题根消息给块B 判（机器人发起 + 带单链接 = 拍板直落）。取不到 = 没查成，走 LLM 分类不猜归属。
  if (inbound.kind === 'hub') {
    const pend = store?.hubPending?.[inbound.rootId];
    if (pend) {
      inbound.hubPending = pend;
    } else if (client?.fetchMessage && inbound.rootId !== inbound.messageId) {
      try {
        inbound.threadRoot = await client.fetchMessage(inbound.rootId);
      } catch (e) {
        warn(`hub 话题根消息取不到（${inbound.rootId}）：${e.message}`);
      }
    }
  }
  log({ type: 'inbound', inbound });
  if (deps && deps.daoTraceRef) deps.daoTraceRef.current = inbound;
  let out;
  try {
    out = await triage(inbound, deps);
  } finally {
    if (deps && deps.daoTraceRef) deps.daoTraceRef.current = null;
  }
  const replies = out.replies || [];
  const actions = out.actions || [];
  for (const r of replies) {
    const root = r.rootId || inbound.rootId;
    if (client) {
      const botMsgId = await client.reply(root, r.text);
      if (botMsgId && store?.aliases) store.aliases[botMsgId] = root;
      // live 也记一行：不然「机器人到底回了没」只能猜（2026-09-04 实咬：总控群两条提问，日志里只有 inbound）
      log({ type: 'reply', rootId: root, botMsgId: botMsgId || null, text: String(r.text).slice(0, 200) });
    } else log({ type: 'reply', rootId: root, text: r.text });
  }
  for (const a of actions) {
    if (a?.type === 'hub_chat_record') {
      // #852 消费记录：fixture 与 live 都落盘（谁问/答了什么/落到哪个单）
      try {
        appendHubChatRecord(a.record);
        log({ type: 'hub_chat_record', intent: a.record?.intent || '', landedTo: a.record?.landedTo || null });
      } catch (e) {
        warn(`hub-chat 记录写失败：${e.message}`);
      }
      continue;
    }
    if (client) await executeAction(client, creds, a, store);
    else log({ type: 'action', action: a });
  }
  if (out.state instanceof Map && out.state !== store.map) store.map = out.state;
  store.save();
  return { inbound, replies, actions };
}

// ---------------------------------------------------------------------------
// fixture 模式：文件事件源，处理完退出（测试/无凭据开发用）
export async function runFixture({ file, groups, store, deps, triage }) {
  if (!existsSync(file)) {
    console.error(`fixture 文件不在：${file}`);
    return 1;
  }
  const lines = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  let processed = 0;
  let skipped = 0;
  let replies = 0;
  let actions = 0;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (e) {
      warn(`fixture 行不是 JSON，跳过：${e.message}`);
      skipped += 1;
      continue;
    }
    const res = await handleEvent(event, { groups, store, deps, triage, client: null, creds: null });
    if (!res) {
      log({ type: 'skip', reason: 'normalize-failed' });
      skipped += 1;
      continue;
    }
    processed += 1;
    replies += res.replies.length;
    actions += res.actions.length;
  }
  log({ type: 'done', lines: lines.length, processed, skipped, replies, actions });
  return 0;
}

// ---------------------------------------------------------------------------
// live 模式：WSClient 长连接常驻
export async function runLive({ groups, store, deps, creds, triage, coreSource }) {
  let sdk;
  try {
    sdk = loadSdk();
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  const client = makeFeishuClient(sdk, creds);
  try {
    await client.start();
  } catch (e) {
    console.error(`WSClient.start 失败：${e.message}`);
    return 1;
  }
  log({
    type: 'start',
    mode: 'live',
    coreSource,
    groups: Object.keys(groups).length,
    hubChat: deps?.hubChat?.enabled === true,
    allowOpenIds: (creds?.allowOpenIds || []).length,
  });

  // 事件串行处理：状态落盘不被并发交错（飞书事件推流是异步的）
  let chain = Promise.resolve();
  client.onEvent((event) => {
    chain = chain
      .then(() => handleEvent(event, { groups, store, deps, triage, client, creds }))
      .catch((e) => log({ type: 'error', message: String(e.message || e) }));
  });

  const stop = () => {
    log({ type: 'stopping' });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const opts = { help: false, fixture: null, groups: null, creds: null, state: null };
  const rest = [...argv];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => {
      const v = rest[i + 1];
      if (v === undefined) throw new Error(`参数 ${a} 缺值`);
      i += 1;
      return v;
    };
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--fixture') opts.fixture = val();
    else if (a === '--groups') opts.groups = val();
    else if (a === '--creds') opts.creds = val();
    else if (a === '--state') opts.state = val();
    else throw new Error(`不认识参数：${a}`);
  }
  return opts;
}

export function printHelp() {
  console.log(`飞书适配器 块A（issue #801；hub 对话 #852）
用法：
  node scripts/feishu-triage.mjs                           live 长连接常驻（读凭据 + 群映射）
  node scripts/feishu-triage.mjs --fixture <events.jsonl>  文件事件源，处理完退出（测试/无凭据开发）
  node scripts/feishu-triage.mjs --help                    本帮助
参数：
  --fixture <file>  用 JSONL 事件文件代替长连接（每行一个 im.message.receive_v1 事件；# 注释）
  --groups <file>   群映射表（默认 host/machine/feishu-groups.json）
  --creds <file>    凭据（默认 ~/.mirasim/keys/feishu-app.json；fixture 模式可缺）
  --state <file>    话题状态文件（默认 ~/.dao/feishu-threads.json）
环境：
  ANTHROPIC_BASE_URL  llm 网关（补充2，与 claude 同源；systemd drop-in 注入）
  FEISHU_GH           假 gh 可执行（测试用；默认 gh）
  FEISHU_CORE_MODULE  块B core 覆盖（测试用；默认 scripts/lib/feishu-triage-core.mjs）
  FEISHU_SDK_ROOT     SDK 安装目录（默认 host/machine/feishu-triage/node_modules）
  HUB_CHAT_DIR        hub 对话消费记录目录（测试用；默认 ~/.dao/hub-chat）
stdout：JSON Lines（fixture 模式机器可读）——inbound / reply / action / hub_chat_record / skip / done；
诊断走 stderr。hub 对话开关在 docs/dispatch-policy.json 的 hubChat 节（#852）。`);
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    printHelp();
    return 1;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }

  let groups;
  try {
    groups = loadGroups(opts.groups || DEFAULT_GROUPS);
  } catch (e) {
    console.error(e.message);
    return 1;
  }

  const store = createStateStore(opts.state || DEFAULT_STATE);

  let creds = null;
  const credsFile = opts.creds || DEFAULT_CREDS;
  if (opts.fixture) {
    if (existsSync(credsFile)) {
      try {
        creds = loadCredentials(credsFile);
      } catch (e) {
        warn(`凭据读不了（fixture 继续跑）：${e.message}`);
      }
    } else {
      warn(`fixture 模式无凭据（${credsFile} 不在），allowOpenIds 为空`);
    }
  } else {
    try {
      creds = loadCredentials(credsFile);
    } catch (e) {
      console.error(e.message);
      return 1;
    }
  }

  const core = await loadCore();
  const deps = buildDeps({ creds, store });

  if (opts.fixture) {
    return runFixture({ file: opts.fixture, groups, store, deps, triage: core.triage });
  }
  return runLive({ groups, store, deps, creds, triage: core.triage, coreSource: core.source });
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === HERE;
if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e.message || String(e));
      process.exit(1);
    });
}
