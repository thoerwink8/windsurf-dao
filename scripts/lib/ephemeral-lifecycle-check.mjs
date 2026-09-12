// 短命会话闸：交卷停会话、清树接线、老单槽位。检查器自持正则，不 import 被查对象的解析。

/**
 * @param {{files?: Record<string, string>, exists?: (rel: string) => boolean}} args
 * @returns {string[]} 红项；空数组 = 绿
 */
export function inspectEphemeralLifecycleSources({ files = {}, exists = () => false } = {}) {
  const problems = [];
  const dao = files.dao || '';
  const commander = files.commander || '';
  const handoff = files.handoff || '';
  const miraReviewer = files.miraReviewer || '';
  const miraSoldier = files.miraSoldier || '';
  const agents = files.agents || '';
  const nudgeInstall = files.nudgeInstall || '';
  const progressInstall = files.progressInstall || '';
  const core = files.core || '';
  const admit = files.admit || '';
  const reap = files.reap || '';

  if (dao && !/stopSessionsAtCwd/.test(dao)) problems.push('worker-done 热路没调 session-stop');
  if (dao && !(/queued-for-review/.test(dao) || /enqueueOnly:\s*true/.test(dao))) problems.push('worker-done 没入队');
  if (core && !/'reap-tree'/.test(core)) problems.push('指挥官动作表没有 reap-tree');
  if (commander && !/execReapTree/.test(commander)) problems.push('指挥官没有清树执行函数');
  if (admit && !/capNewDispatchSlots/.test(admit)) problems.push('老单优先没有把新单槽位压到 1');
  if (reap && !/planTreeReaps/.test(reap)) problems.push('清树判据 planTreeReaps 丢了');
  if (commander && !/\brunProgressWatch\s*\(/.test(commander)) problems.push('指挥官没并进 progress-watch');
  if (commander && !/soldier-book-mirasim\.md/.test(commander)) problems.push('指挥官派工指针还钉 orca 士兵书');
  if (agents && !/soldier-book-mirasim\.md/.test(agents.split('\n')[0] || '')) problems.push('AGENTS.md 首行还钉 orca 书');
  if (miraReviewer && /pr merge/.test(miraReviewer)) problems.push('审官 mirasim 书还在教 pr merge');
  if (miraSoldier && /按需起审官/.test(miraSoldier)) problems.push('士兵 mirasim 书还在教按需起审官');
  if (handoff && !/merge:\s*\{\s*advisory:\s*\[[^\]]*['"]①['"]/.test(handoff.replace(/\s+/g, ' '))) {
    problems.push('合并闸 ① 没标 advisory');
  }
  if (exists('scripts/nudge-stalled.mjs')) problems.push('已删的 nudge-stalled 垫片还在仓里');
  if (exists('scripts/lib/nudge-stalled.mjs')) problems.push('已删的 nudge-stalled 闸还在仓里');
  if (exists('host/machine/systemd/dao-nudge-stalled.timer')) problems.push('已删的 nudge timer 单元还在仓里');
  if (exists('host/machine/systemd/dao-progress-watch.timer')) problems.push('已删的 progress-watch timer 单元还在仓里');
  if (nudgeInstall && !/disable --now dao-nudge-stalled/.test(nudgeInstall)) problems.push('nudge 安装脚本没改成卸载');
  if (progressInstall && !/disable --now dao-progress-watch/.test(progressInstall)) problems.push('progress-watch 安装脚本没改成卸载');
  if (!exists('scripts/land.mjs') || !exists('scripts/close-issues.mjs')) {
    problems.push('land / close-issues 旁路脚本丢了');
  }
  return problems;
}
