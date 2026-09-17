// scripts/lib/retired-gateway-probe.mjs —— #1174 T7
//
// 改这段前必须知道：派工选型已经不读 newapi（#1213）。周期探针若仍对
// https://156.224.28.95.sslip.io 发流式 /v1/chat/completions，就是「实际模型
// 请求还在用旧 2 核网关」。本机 127.0.0.1:4317 的 responses-chat-bridge 上游
// 写死同一台机 + gptpool.key，不是 pqapi 直连。
//
// 人工诊断保留 --include-retired-gw。不要在 gateway-policy.json 给退役池开白名单。

export const RETIRED_NEWAPI_HOSTS = Object.freeze([
  '156.224.28.95',
  '156.224.28.95.sslip.io',
]);

/** 本机 responses-chat-bridge 端口。上游就是退役 newapi，不是现役 GPT 路。 */
export const RETIRED_BRIDGE_PORT = 4317;

export const SKIP_RETIRED_POOL_WHY =
  'newapi 池已从派工退役，默认不发模型请求（#1174 T7）；人工诊断加 --include-retired-gw';

export function includeRetiredGateway(argv = process.argv.slice(2)) {
  return Array.isArray(argv) && argv.includes('--include-retired-gw');
}

/**
 * URL / host 是否退役 newapi 或它的本机桥。
 * 认不出的输入返回 false（调用方对「没 URL」另判，不把垃圾字符串当退役）。
 */
export function isRetiredNewApiUrl(value) {
  if (value == null) return false;
  const raw = String(value).trim();
  if (!raw) return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    try { u = new URL(`http://${raw}`); } catch { return false; }
  }
  const host = String(u.hostname || '').toLowerCase();
  if (RETIRED_NEWAPI_HOSTS.includes(host)) return true;
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (port === RETIRED_BRIDGE_PORT && (host === '127.0.0.1' || host === 'localhost' || host === '::1')) {
    return true;
  }
  return false;
}

/** 从健康表里拿掉本轮故意没探的 key，避免表级 updatedAt 把旧绿装成刚探过。 */
export function pruneHealthKeys(targets, keys) {
  const src = targets && typeof targets === 'object' ? targets : {};
  const drop = new Set(Array.isArray(keys) ? keys.filter(Boolean).map(String) : []);
  if (drop.size === 0) return { ...src };
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (drop.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 默认周期探测面：跳过 gw: 池。direct 是否跳过看 URL（读到配置之后）。
 * only 仍过滤；includeRetired=true 时池全部留下。
 */
export function selectPoolProbes(pools, { includeRetired = false, only = null } = {}) {
  const list = Array.isArray(pools) ? pools : [];
  const jobs = [];
  const skipped = [];
  for (const t of list) {
    if (!t || !t.key) continue;
    if (only && t.key !== only) continue;
    if (!includeRetired) {
      skipped.push({ key: t.key, kind: 'pool', why: SKIP_RETIRED_POOL_WHY });
      continue;
    }
    jobs.push(t);
  }
  return { jobs, skipped };
}
