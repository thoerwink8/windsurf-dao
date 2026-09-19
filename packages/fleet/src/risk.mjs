// packages/fleet/src/risk.mjs —— T34：风险分层。严格程度**正比于爆炸半径**，不是一刀切。
//
// 现在每个改动都付整条闭环（lead→execute→verify→review→integrate）——这是「困局」的主因之一。
// 按爆炸半径分层（纯函数，只判，不读盘）：
//   T0 文档/注释   → CI 即过（不派审查）
//   T1 孤立代码    → CI + 一条异厂审查（不做 lead 自审）
//   T2 机制/协议/安全 → 全流程（lead 自审 + 异厂审查）
//
// 「没查成」（文件清单取不到/为空）**不许当 T0**——保守按 T2 走全流程。

const DOC_PATH = /(^|\/)(docs?|documentation)\//i;
const DOC_EXT = /\.(md|mdx|txt|rst)$/i;
// 规则类文档改了等于改了规则 → 算机制（T2），不是普通文档。
const RULE_DOC = /(^|\/)(CLAUDE\.md|AGENTS\.md|release-policy\.json|model-routing\.json|global-CLAUDE\.md)$/i;
const MECHANISM = [
  /^scripts\/lib\//,
  /^scripts\/[^/]*gateway/,
  /^scripts\/githooks\//,
  /^host\/machine\/(systemd|sudoers\.d)\//,
  /^host\/skills\//,
  /^packages\/fleet\/src\/(workflows|runner|contract|activities|triage)\.mjs$/,
  /\.(service|timer|socket)$/i,
  /(secret|token|credential|auth|permission|sudoer)/i,
];

export const RISK_TIERS = Object.freeze(['T0', 'T1', 'T2']);

export const isDocFile = (p) => DOC_EXT.test(p) || DOC_PATH.test(p);
export const isMechanismFile = (p) => RULE_DOC.test(p) || MECHANISM.some((re) => re.test(p));

/** @returns {'T0'|'T1'|'T2'|null} null = 没查成（文件清单取不到/为空），调用方按 T2 保守走。 */
export function classifyRisk(input) {
  const files = input && input.files;
  if (!Array.isArray(files) || files.length === 0) return null;
  const paths = files.map((p) => String(p || '').replace(/\\/g, '/')).filter(Boolean);
  if (!paths.length) return null;
  // 顺序要紧：空数组的 `every` 恒真，不先挡掉会把它判成 T0。
  if (paths.some(isMechanismFile)) return 'T2';
  if (paths.every(isDocFile)) return 'T0';
  return 'T1';
}

/** 各层要不要 lead 自审 / 异厂审查。没查成（null）按 T2 走。 */
export function tierPlan(tier) {
  if (tier === 'T0') return { selfReview: false, review: false };
  if (tier === 'T1') return { selfReview: false, review: true };
  return { selfReview: true, review: true };
}
