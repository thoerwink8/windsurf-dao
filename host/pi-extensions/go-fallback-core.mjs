// go-fallback-core.mjs —— go-fallback 的纯决策层（node 22 可测，不 import .ts——CI 是 node 22）。
// 运行时接线在 go-fallback.ts；本文件做两类判断：
//   1. 看到当前默认值 → 决定恢复动作
//   2. 看到一次 agent 错误 → 决定要不要切通道（#841：网关不归本扩展管）
//
// restoreDefaults 的修复背景（审查发现两处错）：
//   1. 旧逻辑把「当前值 == 原值」当成「已恢复过」直接清掉 pendingRestore。
//      但 setModel 的 settings 写队列是异步落盘——恢复刀跑在落盘前时读到的就是原值，
//      pending 被误清，随后降级值落盘，补刀（agent_settled/session_shutdown）变 no-op，
//      settings.json 永远停在降级通道（#519 主通道被静默改掉）。
//   2. 旧逻辑对「当前值既非原值也非降级值」（用户在降级后手动改了默认）也无条件写回原值，
//      覆盖用户修改。
//
// 修复后的判定（pending 里同时记原值与降级写入值）：
//   - 当前值 == 降级值 → restore：降级写已落盘，写回原值，清 pending。
//   - 当前值 == 原值   → wait：要么已恢复、要么降级写还没落盘——区分不开，但两种情形
//     正确动作都是「不写文件、保留 pending 等下一刀」（幂等，无副作用）。
//   - 当前值是其它值   → respect-user：用户手动改过默认，尊重用户，清 pending 不再补刀。

/**
 * @param {{pending: ?{provider: string, model: string, fallbackProvider: string, fallbackModel: string},
 *          current: {provider: *, model: *}}} input
 * @returns {{action: 'noop'|'restore'|'wait'|'respect-user', from?: {provider: *, model: *}}}
 */
export function planRestore({ pending, current }) {
  if (!pending) return { action: "noop" };
  const from = { provider: current.provider, model: current.model };
  const atFallback = current.provider === pending.fallbackProvider && current.model === pending.fallbackModel;
  if (atFallback) return { action: "restore", from };
  const atOriginal = current.provider === pending.provider && current.model === pending.model;
  if (atOriginal) return { action: "wait" };
  return { action: "respect-user", from };
}

// #841：渠道级降级唯一归网关。默认主通道不含 gw/grok/xai——那些错误交给网关池
// 自己的 priority / next-launch 换模型。扩展只服务 opencode-go（及仍在用的 mirasim）。
// 这是删掉一层，不是再加 SKIP_GW 开关；环境变量覆盖留给测试（fake-go）和旧垫片，
// 默认值才是生产真相。2026-09-03 的 PI_GO_FALLBACK_PRIMARIES=opencode-go 垫片合并后退役。
export const DEFAULT_PRIMARIES = "opencode-go,mirasim";
// 直连 deepseek 仍是 og 撞顶时的唯一备用；切之前必须探余额，402 / 没钱不算降级。
export const DEFAULT_FALLBACK_PROVIDERS = "deepseek";
export const DEFAULT_TRANSIENT_AFTER = 2;

export function parseProviderList(value, fallback) {
  const src = value == null || String(value).trim() === "" ? fallback : value;
  return String(src).split(",").map((s) => s.trim()).filter(Boolean);
}

export function resolveProviderLists(env = {}) {
  return {
    primaries: parseProviderList(
      env.PI_GO_FALLBACK_PRIMARIES || env.PI_GO_FALLBACK_PRIMARY,
      DEFAULT_PRIMARIES
    ),
    fallbacks: parseProviderList(
      env.PI_GO_FALLBACK_PROVIDERS || env.PI_GO_FALLBACK_PROVIDER,
      DEFAULT_FALLBACK_PROVIDERS
    ),
  };
}

/**
 * 看到一次已分类的 agent 错误，决定扩展动不动手。
 * ignore：不是本扩展的主通道 / 错误未分类——网关错误走这里（#841 判别性：gw 连续 403 不切）。
 * wait：瞬时错误还没到阈值，先让 pi 内置重试。
 * switch：og 额度顶或瞬时连撞，进入找备用通道。
 */
export function planSwitch({
  provider, primaries, kind, consecutive, transientAfter,
} = {}) {
  if (!provider || !Array.isArray(primaries) || !primaries.includes(provider)) {
    return { action: "ignore", reason: "not-primary" };
  }
  if (!kind) return { action: "ignore", reason: "unclassified" };
  const n = Number(transientAfter);
  const after = Number.isFinite(n) && n > 0 ? n : DEFAULT_TRANSIENT_AFTER;
  if (kind === "transient" && Number(consecutive) < after) {
    return { action: "wait", reason: "transient-retry" };
  }
  return { action: "switch" };
}

/** 直连 deepseek 切之前必须探余额。别的备用（测试用 fake-ds）不探。 */
export function needsBalanceProbe(provider) {
  return provider === "deepseek";
}

/**
 * 读 DeepSeek /user/balance 的结果。402、没钱、探不成 → 都不算可用备用。
 * 缺 balance_infos 也 fail-closed：看不清余额就当没钱，避免再踩 2026-09-03 的 402。
 */
export function interpretBalanceProbe({ status, body } = {}) {
  const code = Number(status);
  if (code === 402) return { ok: false, reason: "insufficient-balance" };
  if (!Number.isFinite(code) || code < 200 || code >= 300) {
    return { ok: false, reason: `http-${Number.isFinite(code) ? code : "na"}` };
  }
  let data = body;
  if (typeof body === "string") {
    try { data = JSON.parse(body); } catch { return { ok: false, reason: "bad-json" }; }
  }
  if (!data || typeof data !== "object") return { ok: false, reason: "bad-json" };
  const nested = data.error && typeof data.error === "object" ? data.error.message : "";
  const msg = String(data.message || nested || "");
  if (/insufficient balance/i.test(msg)) return { ok: false, reason: "insufficient-balance" };
  if (data.is_available === false) return { ok: false, reason: "unavailable" };
  const infos = data.balance_infos;
  if (!Array.isArray(infos)) return { ok: false, reason: "no-balance-info" };
  const hasMoney = infos.some((i) => Number(i && i.total_balance) > 0);
  if (!hasMoney) return { ok: false, reason: "zero-balance" };
  return { ok: true };
}

export async function probeDeepseekBalance({ fetchFn, apiKey, url } = {}) {
  if (!apiKey) return { ok: false, reason: "no-key" };
  const fetchImpl = fetchFn || globalThis.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, reason: "no-fetch" };
  const endpoint = url || "https://api.deepseek.com/user/balance";
  try {
    const res = await fetchImpl(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const text = typeof res.text === "function" ? await res.text() : "";
    return interpretBalanceProbe({ status: res.status, body: text });
  } catch (e) {
    return { ok: false, reason: "probe-error", detail: String(e && e.message || e) };
  }
}

/**
 * 选定一个备用 provider 之后：同通道跳过；deepseek 必须有成功的余额探针才用。
 * probe 缺省 = 没探过 → skip（fail-closed，切到 402 账号不算降级）。
 */
export function planFallbackTarget({ provider, currentProvider, probe } = {}) {
  if (!provider || provider === currentProvider) return { action: "skip", reason: "same-provider" };
  if (!needsBalanceProbe(provider)) return { action: "use" };
  if (!probe) return { action: "skip", reason: "unprobed" };
  if (probe.ok === true) return { action: "use" };
  return { action: "skip", reason: probe.reason || "probe-failed" };
}

/**
 * 判断一次 agent 错误是否值得进入备用通道。
 * 这是纯逻辑，供扩展和回归测试复用；只把明确的额度/认证失败视为 hard，
 * 把网关过载、超时、连接中断和 5xx 视为 transient。
 */
export function classifyFallbackError(text) {
  const value = String(text || "");
  const hard = [
    /GoUsageLimitError/i, /FreeUsageLimitError/i, /Monthly usage limit/i,
    /insufficient[_ ]quota/i, /insufficient balance/i, /available balance/i,
    /quota exceeded/i, /out of budget/i, /billing/i, /usage limit reached/i,
    /5-hour usage limit/i, /cloud credit is spent/i,
  ];
  if (hard.some((re) => re.test(value))) return "hard";
  const transient = [
    /overloaded/i, /rate.?limit/i, /too many requests/i, /(^|[^0-9])429([^0-9]|$)/i,
    /(^|[^0-9])5[0-9][0-9]([^0-9]|$)/i, /service.?unavailable/i, /server.?error/i,
    /internal.?error/i, /request timed out/i, /timed out/i, /timeout/i,
    /connection error/i, /connection reset/i, /econn(reset|refused|aborted)/i,
    /operation was aborted/i, /this operation was aborted/i,
    /fetch failed/i, /socket hang up/i, /no_events/i,
  ];
  return transient.some((re) => re.test(value)) ? "transient" : null;
}
