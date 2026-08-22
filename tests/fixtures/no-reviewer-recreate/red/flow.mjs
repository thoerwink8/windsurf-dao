// 故意违规：结算后自动 reviewer-create（#730 那种洞）
if (settled) {
  const createR = source.runDao(['reviewer-create', '--pr', String(pr.number)]);
  events.push(`[flow] 自愈：#${pr.number} 审官 dispatch 已结算，自动 reviewer-create 起新审官（notify 链断自愈）`);
  events.push(`[flow] 自愈：#${pr.number}（dry-run）审官 dispatch 已结算，将自动 reviewer-create`);
}
