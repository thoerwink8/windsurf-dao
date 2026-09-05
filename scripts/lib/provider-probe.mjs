// scripts/lib/provider-probe.mjs —— 派前探一针（#842）
//
// 改这段前必须知道：探针必须拼出和 agent **一模一样**的请求路径，
// 否则「探绿了但 agent 起来还是打不通」。落地路径的真相源是服务器上
// pi 的网关扩展 ~/.pi/agent/extensions/pi-gateway.ts 与 codex 的 ~/.codex：
//   - pi 网关组：openai iff 组 id === "gw"（grok 组，走 /v1/chat/completions）；
//     其余组（gw-dspool / gw-gptpool …）走 anthropic-messages /v1/messages。
//     （issue #842 正文把 gw 系一律写成 /v1/chat/completions，是简化；
//      本实现按 pi-gateway.ts 的真实路由分流——「拼一模一样的请求」优先于简化描述。）
//   - codex（gpt-5.6-sol）：pqapi 直连，wire_api=responses → /v1/responses，
//     key 在 ~/.codex/auth.json 的 OPENAI_API_KEY，base_url 在 config.toml。
//   - 其它 provider（grok Build / cursor / opencode-go / devin）：没有可对齐的
//     网关端点 → unscanned，**不许当绿**。
//
// 判据两条都要满足：**收到真内容** + **流正常收尾**（#953）。四态互不合并：
//   green     = 2xx + 至少一段非空 content/reasoning/text + 见到本口的收尾事件；
//   no_finish = 2xx + 有真内容，但没见到收尾事件（上游掐断 / 只发半截 / 等收尾等到超时）；
//   red       = 非 2xx / 2xx 空流 / 流内 error 事件 / 没拿到内容就超时或断网；
//   unscanned = 没探成（不认识的 provider、拼不出凭据、运行时没 fetch）——不许当绿。
// 收尾事件按口分（FINISH_WANTED）：anthropic 认 message_stop；openai 认 finish_reason 或
// [DONE]；responses 认 response.completed / response.incomplete。只认 `data:` 里的 JSON，
// 因为客户端认的就是这个。
// no_finish 必须单独一态：客户端报的 `Anthropic stream ended before message_stop` 就长这样
// ——2xx、有 delta、就是跑不完；混进 green 它隐形，混进 red 又和「上游挂了」分不开。
// 所以这里不许一见内容就 cancel reader（那正是 #953 的洞），必须读到收尾事件或流尾才收口。
//
// key 永不进返回值、不进日志：planProbe 的 headers 只放**打码描述**，
// 真 key 由 runProbe 起请求时现读现用（resolveProbeAuth），只存在于内存里那一瞬。

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const DEFAULT_TIMEOUT_MS = 5000;
const PROBE_MESSAGE = 'ping';
const PROBE_MAX_TOKENS = 8;

/** 组 id → 健康表短名：gw（grok 组）→ grok，gw-dspool → dspool。 */
function groupShort(groupId) {
  const g = String(groupId || '');
  if (g === 'gw') return 'grok';
  return g.replace(/^gw-/, '');
}

/** 拆 gw 的 cli_model：`gw-dspool/deepseek-v4-flash` → { group:'gw-dspool', model:'deepseek-v4-flash' }。 */
function splitGwModel(cliModel) {
  const s = String(cliModel || '');
  const i = s.indexOf('/');
  if (i < 0) return null;
  return { group: s.slice(0, i), model: s.slice(i + 1) };
}

/**
 * 落地 → 健康表 target key（两仓共用契约，见 issue #842）。
 * gw:  `gw:<组短名>/<模型>`；codex 直连： `direct:codex@pqapi/responses`。
 * 认不出的 provider → null（调用方据此判 unscanned）。
 */
export function probeTargetOf(landing) {
  if (!landing || typeof landing !== 'object') return null;
  const provider = String(landing.provider || '');
  const cliModel = String(landing.cli_model || '');
  if (provider === 'gw') {
    const parts = splitGwModel(cliModel);
    if (!parts) return null;
    return `gw:${groupShort(parts.group)}/${parts.model}`;
  }
  if (provider === 'gpt') {
    return 'direct:codex@pqapi/responses';
  }
  return null;
}

/** pi 网关配置：~/.pi/agent/pi-gateway.json（v2：{ gateway, providers:[{id,keyFile,key/token,models}] }）。 */
export function loadGatewayConfig({ home = os.homedir(), read = readFileSync, exists = existsSync } = {}) {
  const path = join(home, '.pi', 'agent', 'pi-gateway.json');
  if (!exists(path)) return { ok: false, unscanned: true, error: `网关配置不在：${path}（没查成）`, path };
  let doc;
  try {
    doc = JSON.parse(read(path, 'utf8'));
  } catch (e) {
    return { ok: false, unscanned: true, error: `网关配置不是 JSON：${String(e.message || e)}`, path };
  }
  const gateway = String(doc.gateway || '').replace(/\/+$/, '');
  let providers = Array.isArray(doc.providers) ? doc.providers : [];
  if (!providers.length && Array.isArray(doc.models) && doc.models.length) {
    providers = [{ id: 'gw', keyFile: doc.keyFile, token: doc.token, models: doc.models }];
  }
  if (!gateway || !providers.length) {
    return { ok: false, unscanned: true, error: '网关配置缺 gateway / providers', path };
  }
  return { ok: true, gateway, providers, path };
}

/** codex 直连配置：~/.codex/config.toml 的 base_url + ~/.codex/auth.json 的 OPENAI_API_KEY。 */
export function loadCodexConfig({ home = os.homedir(), read = readFileSync, exists = existsSync } = {}) {
  const cfgPath = join(home, '.codex', 'config.toml');
  const authPath = join(home, '.codex', 'auth.json');
  if (!exists(cfgPath)) return { ok: false, unscanned: true, error: `codex config 不在：${cfgPath}（没查成）` };
  let baseUrl = '';
  try {
    const { parse: parseToml } = require('./smol-toml.cjs');
    const doc = parseToml(read(cfgPath, 'utf8'));
    const providers = doc && doc.model_providers ? doc.model_providers : {};
    const name = doc && doc.model_provider ? String(doc.model_provider) : 'custom';
    const prov = providers[name] || providers.custom || null;
    baseUrl = prov && prov.base_url ? String(prov.base_url).replace(/\/+$/, '') : '';
  } catch (e) {
    return { ok: false, unscanned: true, error: `codex config 解析失败：${String(e.message || e)}` };
  }
  if (!baseUrl) return { ok: false, unscanned: true, error: 'codex config 缺 base_url' };
  return { ok: true, baseUrl, authPath };
}

/**
 * planProbe(landing) → { kind, url, headers（打码描述，不含 key 明文）, body, target, provider, model }。
 * kind ∈ gw-openai | gw-anthropic | codex-responses | unscanned。
 * gatewayConfig / codexConfig 可注入（测试用）；不给则现读盘（url 用真值，key 仍不进返回）。
 */
export function planProbe(landing, { gatewayConfig, codexConfig, home, read, exists } = {}) {
  if (!landing || typeof landing !== 'object') {
    return { kind: 'unscanned', why: '没给落地方式（landing）' };
  }
  const provider = String(landing.provider || '');
  const cliModel = String(landing.cli_model || '');
  const target = probeTargetOf(landing);

  if (provider === 'gw') {
    const parts = splitGwModel(cliModel);
    if (!parts) {
      return { kind: 'unscanned', provider, target, why: `gw cli_model 缺组前缀：${cliModel || '(空)'}` };
    }
    const gw = gatewayConfig || loadGatewayConfig({ home, read, exists });
    if (!gw.ok) {
      return { kind: 'unscanned', provider, target, why: gw.error };
    }
    const openai = parts.group === 'gw';
    const url = openai ? `${gw.gateway}/v1/chat/completions` : `${gw.gateway}/v1/messages`;
    const body = openai
      ? { model: parts.model, stream: true, max_tokens: PROBE_MAX_TOKENS, messages: [{ role: 'user', content: PROBE_MESSAGE }] }
      : { model: parts.model, stream: true, max_tokens: PROBE_MAX_TOKENS, messages: [{ role: 'user', content: PROBE_MESSAGE }] };
    return {
      kind: openai ? 'gw-openai' : 'gw-anthropic',
      url,
      headers: openai
        ? { Authorization: `Bearer <网关组 ${parts.group} token>`, 'Content-Type': 'application/json' }
        : { 'x-api-key': `<网关组 ${parts.group} token>`, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body,
      target,
      provider,
      group: parts.group,
      model: parts.model,
    };
  }

  if (provider === 'gpt') {
    const cx = codexConfig || loadCodexConfig({ home, read, exists });
    if (!cx.ok) {
      return { kind: 'unscanned', provider, target, why: cx.error };
    }
    const model = cliModel && cliModel.indexOf('/') < 0 ? cliModel : 'gpt-5.6-sol';
    return {
      kind: 'codex-responses',
      url: `${cx.baseUrl}/responses`,
      headers: { Authorization: 'Bearer <codex OPENAI_API_KEY>', 'Content-Type': 'application/json' },
      body: { model, stream: true, max_output_tokens: 16, input: PROBE_MESSAGE },
      target,
      provider,
      model,
      authPath: cx.authPath,
    };
  }

  // grok Build / cursor / opencode-go / devin：没有可对齐的网关端点 → 不许当绿。
  return { kind: 'unscanned', provider, target, why: `provider ${provider || '(空)'} 没有可对齐的探测端点` };
}

/**
 * 现读现用地把真 key 拼进 headers（只在起请求前那一瞬，不返回给调用方、不落日志）。
 * gw：读 pi-gateway.json 里该组的 keyFile（优先）或 key/token 字段。
 * codex：读 ~/.codex/auth.json 的 OPENAI_API_KEY。
 */
export function resolveProbeAuth(plan, { home = os.homedir(), read = readFileSync, exists = existsSync, gatewayConfig } = {}) {
  if (!plan || typeof plan !== 'object') return { ok: false, error: '没给 plan' };
  if (plan.kind === 'gw-openai' || plan.kind === 'gw-anthropic') {
    const gw = gatewayConfig || loadGatewayConfig({ home, read, exists });
    if (!gw.ok) return { ok: false, unscanned: true, error: gw.error };
    const prov = gw.providers.find(p => p && p.id === plan.group);
    if (!prov) return { ok: false, error: `网关配置里没有组 ${plan.group}` };
    let key = '';
    if (prov.keyFile) {
      try { key = String(read(prov.keyFile, 'utf8')).trim(); } catch { /* 回退下面 */ }
    }
    if (!key) key = String(prov.token || prov.key || '').trim();
    if (!key) return { ok: false, error: `网关组 ${plan.group} 取不到 key` };
    const headers = plan.kind === 'gw-openai'
      ? { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Connection: 'close' }
      : { 'x-api-key': key, Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', Connection: 'close' };
    return { ok: true, headers };
  }
  if (plan.kind === 'codex-responses') {
    const authPath = plan.authPath || join(home, '.codex', 'auth.json');
    if (!exists(authPath)) return { ok: false, unscanned: true, error: `codex auth 不在：${authPath}` };
    let key = '';
    try {
      const doc = JSON.parse(read(authPath, 'utf8'));
      key = String(doc.OPENAI_API_KEY || '').trim();
    } catch (e) {
      return { ok: false, unscanned: true, error: `codex auth 解析失败：${String(e.message || e)}` };
    }
    if (!key) return { ok: false, error: 'codex auth 缺 OPENAI_API_KEY' };
    return { ok: true, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Connection: 'close' } };
  }
  return { ok: false, error: `不认识的 plan.kind：${plan.kind}` };
}

/** 从一段 SSE data JSON 里抽真内容（各 API 形不同）。任一非空即算收到真内容。 */
export function extractDeltaContent(kind, obj) {
  if (!obj || typeof obj !== 'object') return '';
  const nonEmpty = (...vals) => {
    for (const v of vals) {
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return '';
  };
  if (kind === 'gw-openai') {
    const d = obj.choices && obj.choices[0] && obj.choices[0].delta ? obj.choices[0].delta : {};
    return nonEmpty(d.content, d.reasoning_content, d.reasoning);
  }
  if (kind === 'gw-anthropic') {
    // content_block_delta: { delta: { text | thinking | partial_json } }
    const d = obj.delta || {};
    return nonEmpty(d.text, d.thinking, d.reasoning, d.partial_json);
  }
  if (kind === 'codex-responses') {
    // response.output_text.delta: { delta: "..." }；也认 reasoning delta
    if (typeof obj.delta === 'string') return obj.delta;
    const d = obj.delta || {};
    return nonEmpty(typeof d === 'string' ? d : '', d.text, d.content);
  }
  return '';
}

/** 各口的收尾事件（「跑完了」的证据）；no_finish 的 why 也拿它说「本来该见到什么」。 */
const FINISH_WANTED = {
  'gw-openai': 'finish_reason 或 [DONE]',
  'gw-anthropic': 'message_stop',
  'codex-responses': 'response.completed',
};

/** 从一段 SSE data JSON 里认收尾事件 → { event, reason } 或 null（#953）。
 * openai 的 finish_reason 在正常流里每段都是 null，只有最后一段才有值——所以必须判「非空」而不是「有这个键」。 */
export function extractFinish(kind, obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (kind === 'gw-openai') {
    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    for (const c of choices) {
      const fr = c && c.finish_reason;
      if (fr !== undefined && fr !== null && fr !== '') return { event: 'finish_reason', reason: String(fr) };
    }
    return null;
  }
  if (kind === 'gw-anthropic') {
    // stop_reason 在 message_delta 里，message_stop 自己不带；分开抓（见 scanLine）才答得出「怎么停的」。
    if (obj.type === 'message_stop') return { event: 'message_stop', reason: null };
    return null;
  }
  if (kind === 'codex-responses') {
    if (obj.type === 'response.completed') return { event: 'response.completed', reason: null };
    if (obj.type === 'response.incomplete') {
      const d = obj.response && obj.response.incomplete_details;
      return { event: 'response.incomplete', reason: d && d.reason ? String(d.reason) : null };
    }
    return null;
  }
  return null;
}

/** 流内错误事件（2xx 起流后中途失败）：codex response.failed / 各 API 的 error 体。
 * 返回错误一句话（截短）或 null。
 * DECISIONS §61 教训：pqapi sol 排队时先发 `: PING` 心跳、~30s 后才 response.failed；识别它才能
 * 早判红，而不是傻等到超时（也不会把心跳误当真内容当绿）。 */
function errorOf(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const err = obj.error
    || (obj.response && obj.response.error)
    || (obj.type === 'response.failed' && obj.response && obj.response.error)
    || (obj.type === 'error' && obj.error);
  if (err && (err.message || err.code || err.type)) {
    const code = err.code || err.type || '';
    return `${code ? `${code}: ` : ''}${String(err.message || '').slice(0, 120)}`.trim();
  }
  if (obj.type === 'response.failed') return 'response.failed';
  return null;
}

/** 一条流扫到哪儿了。dataLines / lastEvent 只为回答「断在哪一步」，不参与判态。 */
export function newScan() {
  return { gotContent: false, finishEvent: null, finishReason: null, error: null, lastEvent: null, dataLines: 0 };
}

/**
 * 扫一行 SSE，把内容 / 收尾 / 流内错误记进 scan。返回 true = 可以停读了（出错或已收尾）。
 * 停读条件里没有「收到内容」：一见内容就停就永远看不到有没有收尾（#953）。
 */
export function scanLine(kind, line, scan) {
  const isData = String(line).startsWith('data:');
  const raw = isData ? String(line).slice(5).trim() : String(line).trim();
  if (!raw || raw.startsWith(':')) return false;   // 空行 / `:` 开头是 SSE 注释、心跳
  if (!isData && /^(event|id|retry):/.test(raw)) return false; // 非 data 字段行不当判据（客户端也只认 data）
  if (raw === '[DONE]') {
    if (kind === 'gw-anthropic') return false;     // anthropic 口的收尾是 message_stop，[DONE] 不顶数
    scan.finishEvent = '[DONE]';
    return true;
  }
  let obj;
  try { obj = JSON.parse(raw); } catch { return false; }
  scan.dataLines += 1;
  if (obj && typeof obj.type === 'string') scan.lastEvent = obj.type;
  const err = errorOf(obj);
  if (err) { scan.error = err; return true; }
  if (extractDeltaContent(kind, obj).length > 0) scan.gotContent = true;
  if (kind === 'gw-anthropic' && obj && obj.type === 'message_delta' && obj.delta && obj.delta.stop_reason) {
    scan.finishReason = String(obj.delta.stop_reason);
  }
  const fin = extractFinish(kind, obj);
  if (fin) {
    scan.finishEvent = fin.event;
    if (fin.reason) scan.finishReason = fin.reason;
    return true;
  }
  return false;
}

/**
 * 扫完（或扫不下去）之后收口成态。纯函数，判据全在这里，测试直接喂 scan 就能验。
 * aborted = 超时打断；netError = 非超时的连接错。两者都可能发生在「已经收到内容之后」，
 * 那就是上游把流掐了 —— 属 no_finish，不是 red（#953）。
 */
export function settleScan(kind, scan, { code = null, ms = 0, timeoutMs = null, aborted = false, netError = null } = {}) {
  const s = scan || newScan();
  const tail = { finish: s.finishEvent || null, finishReason: s.finishReason || null };
  // 上游自己报的失败最硬，先判。
  if (s.error) return { state: 'red', code, ms, why: `流内失败：${s.error}`, ...tail };
  if (!s.gotContent) {
    if (aborted) return { state: 'red', code, ms, why: `超时（>${timeoutMs}ms）`, ...tail };
    if (netError) return { state: 'red', code, ms, why: `网络错：${netError}`, ...tail };
    return { state: 'red', code, ms, why: `2xx 空流（${code} 但没收到真内容）`, ...tail };
  }
  if (!s.finishEvent) {
    const how = aborted ? `等收尾等到超时（>${timeoutMs}ms）` : (netError ? `连接断了（${netError}）` : '流已结束');
    const at = s.lastEvent ? `最后事件 ${s.lastEvent}` : `共 ${s.dataLines} 段 data`;
    return { state: 'no_finish', code, ms, why: `有真内容但没收尾：${how}，要 ${FINISH_WANTED[kind] || '收尾事件'}，${at}`, ...tail };
  }
  const rs = s.finishReason ? `/${s.finishReason}` : '';
  return { state: 'green', code, ms, why: `流式收到真内容且正常收尾（${s.finishEvent}${rs}）`, ...tail };
}

/**
 * runProbe(plan, opts) → { state:'green'|'no_finish'|'red'|'unscanned', code, ms, why, finish, finishReason }。
 * 真发一针流式，读到收尾事件或流尾才收口（判据见文件头与 settleScan）。
 * fetchImpl 可注入（测试用 fake server）。
 */
export async function runProbe(plan, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, home, read, exists, gatewayConfig } = {}) {
  if (!plan || plan.kind === 'unscanned' || !plan.url) {
    return { state: 'unscanned', code: null, ms: 0, why: plan?.why || '未知 provider，不探（不许当绿）' };
  }
  const auth = resolveProbeAuth(plan, { home, read, exists, gatewayConfig });
  if (!auth.ok) {
    // 拼不出 key = 没查成（不许当绿，也不武断判红上游挂了）。
    return { state: 'unscanned', code: null, ms: 0, why: `拼不出凭据：${auth.error}` };
  }
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { state: 'unscanned', code: null, ms: 0, why: '运行时没有 fetch' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
  const t0 = Date.now();
  // scan / code 提到 try 外：超时或断线也要看得见「已经收到内容了吗」——有内容却没收尾是 no_finish。
  const scan = newScan();
  let code = null;
  try {
    const res = await doFetch(plan.url, {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify(plan.body),
      signal: ctrl.signal,
    });
    code = res.status;
    if (code < 200 || code >= 300) {
      // 读一点错误体帮排障（不含 key），截短。
      let snippet = '';
      try { snippet = (await res.text()).slice(0, 160).replace(/\s+/g, ' '); } catch { /* 忽略 */ }
      return { state: 'red', code, ms: Date.now() - t0, why: `HTTP ${code}${snippet ? ` ${snippet}` : ''}` };
    }
    // 2xx：一路读到收尾事件或流尾；中途 error 事件（如 pqapi response.failed）立即判红。
    const body = res.body;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let stop = false;
      while (!stop) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (scanLine(plan.kind, line, scan)) { stop = true; break; }
        }
      }
      if (stop) { try { await reader.cancel(); } catch { /* 忽略 */ } }
      else if (buf) scanLine(plan.kind, buf, scan); // 最后一行可能没有收尾换行
    } else {
      // 没有可读流（fake / 非流式）→ 退化成整体文本逐行判定。
      let text = '';
      try { text = await res.text(); } catch { /* 忽略 */ }
      for (const line of String(text).split('\n')) {
        if (scanLine(plan.kind, line, scan)) break;
      }
    }
    return settleScan(plan.kind, scan, { code, ms: Date.now() - t0, timeoutMs });
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)));
    return settleScan(plan.kind, scan, {
      code,
      ms: Date.now() - t0,
      timeoutMs,
      aborted: Boolean(aborted),
      netError: aborted ? null : String(e.message || e).slice(0, 120),
    });
  } finally {
    clearTimeout(timer);
    // 【垫片，等调用方退出路径改完就删】Windows + TLS 专属：本函数读到流尾才收口（#953），
    // 连接因此刚好在返回那一瞬关闭；调用方 dao.mjs 的 emit() 紧接着 process.exit() 硬退，
    // 撞上还没关完的 TLS socket 就触发 libuv 断言崩溃：
    //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
    // 现象是 JSON 已正确打印、退出码却成 127。实测（真网关，dao.mjs dispatch --dry-run）：
    //   HEAD 旧读法 0/10 崩 · 本判据不等 8/10 崩 · 等 200ms 0/12 崩；
    //   ctrl.abort() 2/10、abort+setImmediate 8/10（tick 不是真时间，没用）。
    // 本地明文 HTTP 假网关 0/8 崩 ⇒ 只有 TLS 会中招；Linux 无此断言 ⇒ 只在 win32 上等。
    // 真正的解在调用方（emit 别 process.exit 硬退），不在探针，所以这里是垫片不是设计。
    if (process.platform === 'win32' && String(plan.url || '').startsWith('https:')) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** 探一个落地：plan + run 合起来，返回 { state, code, ms, why, finish, finishReason, target, kind }。 */
export async function probeLanding(landing, opts = {}) {
  const plan = planProbe(landing, opts);
  const r = await runProbe(plan, opts);
  return { ...r, target: plan.target || probeTargetOf(landing) || null, kind: plan.kind };
}
