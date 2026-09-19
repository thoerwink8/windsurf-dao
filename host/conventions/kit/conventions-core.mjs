// host/conventions/kit/conventions-core.mjs —— T37：约定脊柱的**纯判据**（零依赖，子仓可直接复制）。
//
// 为什么判据单独一个文件：`kit/check-conventions.mjs` 要能原样落到子仓（零依赖），
// 本仓的测试也要能直接喂样本给它——判据只有一份，不在两边各写一遍（写两遍就会漂）。
//
// 三态：绿 / 红 / **没查成**。「取不到 pin」「块里没版本戳」一律落没查成，**不许折算成绿**。

import { createHash } from 'node:crypto';

export const CORE_MARKER = 'dao-conventions-core';
/** 不可协商层的上限：进这层要举证（不加会出什么事），所以条数本身也是判据。 */
export const CORE_RULE_LIMIT = 7;

/** 规范化：CRLF→LF、去掉行尾空白、整体 trim——换行风格不该让版本戳变来变去。 */
export function normalize(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

/** 真相源的版本戳：对 core.md 去掉戳行后的正文算 sha256（戳行本身不参与，否则自己套自己）。 */
export function coreStamp(text) {
  const body = normalize(String(text == null ? '' : text)
    .split('\n')
    .filter((l) => !l.includes('dao-conventions'))
    .join('\n'));
  return { sha256: createHash('sha256').update(body).digest('hex'), body };
}

/** 数不可协商层的条数：`## C1 …` 这样的标题一行一条。 */
export function countCoreRules(text) {
  return (String(text == null ? '' : text).match(/^##\s+C\d+\b/gm) || []).length;
}

/** 解析子仓里的约定块：`<!-- dao-conventions: v1 sha256:<hex> -->`。 */
export function parseConventionBlock(text) {
  const m = String(text == null ? '' : text).match(/<!--\s*dao-conventions:\s*v(\d+)\s+sha256:([0-9a-f]{8,64})\s*-->/);
  if (!m) return { found: false, version: null, sha256: null };
  return { found: true, version: Number(m[1]), sha256: m[2] };
}

/** 解析 `## 豁免` 段：`- C1: 理由`。**没理由的条目原样留在 withoutReason 里**（红由判据下）。 */
export function parseExemptions(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const start = lines.findIndex((l) => /^##\s+豁免\s*$/.test(l));
  if (start < 0) return { entries: [], withoutReason: [] };
  const entries = [], withoutReason = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const m = line.match(/^\s*[-*]\s+(.+)$/);
    if (!m) continue;
    const item = m[1].trim();
    const sep = item.search(/[:：]/);
    const rule = (sep < 0 ? item : item.slice(0, sep)).trim();
    const reason = (sep < 0 ? '' : item.slice(sep + 1)).trim();
    if (reason) entries.push({ rule, reason });
    else withoutReason.push({ rule, reason: '' });
  }
  return { entries, withoutReason };
}

/**
 * 判一个仓的约定符合性。
 * @param {{block:object, pin:object|null, exemptions:{entries:object[],withoutReason:object[]}, expectedVersion?:number}} input
 *   block = parseConventionBlock 的结果；pin = 该仓 `.dao/conventions.json` 的内容（取不到传 null）。
 * @returns {{state:'green'|'red'|'unscanned', why:string, code?:string}}
 */
export function judgeConventions({ block, pin, exemptions, expectedVersion } = {}) {
  const ex = exemptions || { entries: [], withoutReason: [] };
  if (!block) return { state: 'unscanned', why: '约定块没解析（取不到 ≠ 没有块）', code: 'no-block-parsed' };
  if (!block.found) return { state: 'red', why: '没有约定块（`<!-- dao-conventions: vN sha256:… -->`）——子仓未接约定脊柱', code: 'no-block' };
  if (!pin || typeof pin !== 'object' || !pin.sha256 || !pin.version) {
    return { state: 'unscanned', why: 'pin 没取到（`.dao/conventions.json` 缺失或读不成）——没查成，不是绿', code: 'no-pin' };
  }
  if (ex.withoutReason.length) {
    return {
      state: 'red',
      code: 'exemption-without-reason',
      why: `豁免没写理由：${ex.withoutReason.map((e) => e.rule).join('、')}——豁免必须带理由（C2）`,
    };
  }
  if (block.sha256 !== pin.sha256) {
    return { state: 'red', code: 'stale-stamp', why: `约定块版本戳与 pin 不符（块 ${block.sha256.slice(0, 8)} ≠ pin ${String(pin.sha256).slice(0, 8)}）——戳被改旧或被改过` };
  }
  if (Number(block.version) !== Number(pin.version)) {
    return { state: 'red', code: 'version-mismatch', why: `约定块版本 v${block.version} ≠ pin v${pin.version}` };
  }
  if (Number.isFinite(expectedVersion) && Number(block.version) !== Number(expectedVersion)) {
    return { state: 'red', code: 'version-behind', why: `子仓停在 v${block.version}，真相源是 v${expectedVersion}——按脊柱升版` };
  }
  return { state: 'green', why: `约定块 v${block.version} 与 pin 一致（${ex.entries.length} 条豁免，都带理由）` };
}
