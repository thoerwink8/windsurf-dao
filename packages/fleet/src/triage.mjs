// packages/fleet/src/triage.mjs —— T33：一条发现「当场修」还是「进册子」。
//
// 判据在**代码**里，不由模型判（模型只分类与估工作量）：
//   当场修 ⇔ P1 ∪ 类型落在 SLA 的「立即」列（security 可达 / data / contract）
//            ∪ （effort=small ∧ 上下文还热=可续跑同一会话，T7）
// 其余进债册子（P2/P3 的 maintainability/ui/perf 等）。
//
// 为什么要它：返工轮把**全部**发现丢回去，执行者可能去啃大改（贵、还拖长闭环）；
// 而「热上下文里修一行」几乎免费——这正是 Devin「REJECT 当场修」便宜的地方。

export const EFFORTS = Object.freeze(['small', 'medium', 'large']);

// 与 docs/stages/<版本>.json 的 debt.sla.immediate 同口径（类型优先于严重度）。
export const SLA_IMMEDIATE_TYPES = Object.freeze(['security', 'data', 'contract']);

/** @returns {'rework'|'debt'} */
export function triageFinding({ finding, resumable = false } = {}) {
  const severity = String(finding && finding.severity || '').toUpperCase();
  if (severity === 'P1') return 'rework';
  const type = String(finding && finding.type || '').toLowerCase();
  if (SLA_IMMEDIATE_TYPES.includes(type)) return 'rework';
  const effort = String(finding && finding.effort || '').toLowerCase();
  if (effort === 'small' && resumable) return 'rework';
  return 'debt';
}

/** 把一批发现分成「这轮返工带的」与「进册子的」。 */
export function splitFindings({ findings = [], resumable = false } = {}) {
  const rework = [];
  const debt = [];
  for (const f of findings) (triageFinding({ finding: f, resumable }) === 'rework' ? rework : debt).push(f);
  return { rework, debt };
}
