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
// 判据固定「流式 + 收到真内容」（DECISIONS §61，ai-gateway-stack 探针同款）：
//   2xx 且至少收到一段非空 content/reasoning/text = green；
//   2xx 但空流 = red；非 2xx = red；超时/网络错 = red。
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

/** 收到一段真内容？兼容三种 API 的流式 chunk。 */
function chunkHasContent(kind, line) {
  const s = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
  if (!s || s === '[DONE]') return false;
  let obj;
  try { obj = JSON.parse(s); } catch { return false; }
  return extractDeltaContent(kind, obj).length > 0;
}

/**
 * runProbe(plan, opts) → { state:'green'|'red'|'unscanned', code, ms, why }。
 * 真发一针流式；判据：2xx + 收到真内容 = green；2xx 空流 = red；非 2xx / 超时 / 网络 = red。
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
  try {
    const res = await doFetch(plan.url, {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify(plan.body),
      signal: ctrl.signal,
    });
    const code = res.status;
    if (code < 200 || code >= 300) {
      // 读一点错误体帮排障（不含 key），截短。
      let snippet = '';
      try { snippet = (await res.text()).slice(0, 160).replace(/\s+/g, ' '); } catch { /* 忽略 */ }
      return { state: 'red', code, ms: Date.now() - t0, why: `HTTP ${code}${snippet ? ` ${snippet}` : ''}` };
    }
    // 2xx：读流，收到真内容才算绿。
    let gotContent = false;
    const body = res.body;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (chunkHasContent(plan.kind, line)) { gotContent = true; break; }
        }
        if (gotContent) { try { await reader.cancel(); } catch { /* 忽略 */ } break; }
      }
      if (!gotContent && buf) {
        for (const line of buf.split('\n')) {
          if (chunkHasContent(plan.kind, line)) { gotContent = true; break; }
        }
      }
    } else {
      // 没有可读流（fake / 非流式）→ 退化成整体文本判定。
      let text = '';
      try { text = await res.text(); } catch { /* 忽略 */ }
      for (const line of String(text).split('\n')) {
        if (chunkHasContent(plan.kind, line)) { gotContent = true; break; }
      }
    }
    if (gotContent) return { state: 'green', code, ms: Date.now() - t0, why: '流式收到真内容' };
    return { state: 'red', code, ms: Date.now() - t0, why: `2xx 空流（${code} 但没收到真内容）` };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)));
    return {
      state: 'red',
      code: null,
      ms: Date.now() - t0,
      why: aborted ? `超时（>${timeoutMs}ms）` : `网络错：${String(e.message || e).slice(0, 120)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 探一个落地：plan + run 合起来，返回 { state, code, ms, why, target }。 */
export async function probeLanding(landing, opts = {}) {
  const plan = planProbe(landing, opts);
  const r = await runProbe(plan, opts);
  return { ...r, target: plan.target || probeTargetOf(landing) || null, kind: plan.kind };
}
