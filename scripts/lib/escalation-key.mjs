// scripts/lib/escalation-key.mjs —— 报帅开单的 idempotency-key 规范化
//
// 来历（2026-09-10 实咬）：mirasim 升级后派工全失败，指挥官每次都想「报帅开单」把故障
// 报出来，但那条路同时报 `missing_idempotency`——key 回落到 title，而失败单的 title 是
// 「#1146 自动派工失败：{"ok":false,"error":"..."}」，带空白和引号，网关判据不收。
//
// 于是**故障与告警同源失效**：一晚 96 条派工失败，一条都没报出来，静默瘫痪。
// 这比故障本身更危险——故障会被下一轮重试，静默不会。
//
// 判据：key 必须是 1–200 个可见字符、不含空白。所以这里不指望调用方给的字符串正好合法，
// 一律规范化：可读前缀（便于人看出是哪件事）+ 全文摘要（保证同一件事得到同一个 key）。

import { createHash } from 'node:crypto';

/**
 * 网关真闸是 **ASCII 可见字符**（issue-gateway 的 KEY_RE：\x21-\x7E），不是「可见字符」。
 * 第一版这里写 \p{L}\p{N}（收件箱 2026-09-10「报帅规范化闸比真闸松」实咬）：\p{L} 含汉字，
 * 于是「待拍板」这类 key 过了本层规范化、照样被网关拒，refiner 29 连败——测试闸比真闸松，
 * 绿灯全亮着生产全瘫。可读前缀只留 ASCII 安全集，中文交给摘要保证稳定与区分。
 */
const UNSAFE = /[^A-Za-z0-9_.:#/-]+/g;

/**
 * 把任意文本折成合法且稳定的 key 片段。
 *
 * 摘要不可省：只截前缀的话，「#1146 自动派工失败：…」和「#1151 自动派工失败：…」
 * 在前 N 字符内可能完全相同，两件不同的事会共用一个 key，第二条被当成重复丢掉。
 *
 * @param {string} seed 原始文本（title 或查重标记）
 * @param {number} keep 可读前缀保留多少字符
 */
export function escalationKeyOf(seed, keep = 80) {
  const raw = String(seed ?? '').trim();
  if (!raw) return 'unnamed-' + createHash('sha256').update('').digest('hex').slice(0, 12);
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const readable = raw.replace(UNSAFE, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, keep);
  return readable ? `${readable}-${digest}` : digest;
}

/**
 * 网关那侧的判据，独立实现供测试正控（不 import 网关的 KEY_RE——自己查自己查不出错）：
 * 1–200 个字符，每个都是 ASCII 可见字符（0x21–0x7E）。
 * 第一版只查「非空、无空白、≤200」，比真闸松——中文 key 在这里绿、在网关红。
 */
export function isGatewayKeySafe(key) {
  const s = String(key ?? '');
  if (s.length < 1 || s.length > 200) return false;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}
