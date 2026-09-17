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
  const lease = files.lease || '';
  const sessions = files.sessions || '';

  if (dao && !/stopSessionsAtCwd/.test(dao)) problems.push('worker-done 热路没调 session-stop');
  if (dao && !(/queued-for-review/.test(dao) || /enqueueOnly:\s*true/.test(dao))) problems.push('worker-done 没入队');
  if (dao) {
    const wdStart = dao.indexOf('async function cmdWorkerDoneMirasim');
    const wdEnd = dao.indexOf('async function cmdStartMirasim', wdStart);
    const wd = wdStart >= 0 && wdEnd > wdStart ? dao.slice(wdStart, wdEnd) : '';
    const haltAt = wd.search(/if \(plan\.halt === REVIEW_ROUNDS_HALT \|\| plan\.halt === REVIEW_ROUNDS_UNSCANNED\)/);
    if (haltAt < 0) {
      problems.push('worker-done 超限早退分支丢了');
    } else {
      const rest = wd.slice(haltAt);
      const nextIf = rest.search(/\n  if \(plan\.round === 'first'\)/);
      const haltBlock = nextIf >= 0 ? rest.slice(0, nextIf) : rest.slice(0, 1600);
      if (!/stopSessionsAtCwd/.test(haltBlock)) {
        problems.push('worker-done 超限/unscanned 早退没停会话');
      }
      if (!/\bstopped\b/.test(haltBlock)) {
        problems.push('worker-done 超限早退输出没带 stopped');
      }
      if (!/stopped\.ok !== true/.test(haltBlock) && !/stopped\.ok === false/.test(haltBlock)) {
        problems.push('worker-done 超限早退停会话失败没有 fail-visible');
      }
    }
  }
  if (core && !/'reap-tree'/.test(core)) problems.push('指挥官动作表没有 reap-tree');
  if (commander && !/execReapTree/.test(commander)) problems.push('指挥官没有清树执行函数');
  if (core && !/planOrphanReaps/.test(core)) problems.push('指挥官没产幽灵进程回收');
  if (commander && !/execReapOrphan/.test(commander)) problems.push('指挥官没执行幽灵进程回收');
  if (lease && !/export function planOrphanReaps/.test(lease)) problems.push('租约闸没有幽灵回收纯函数');
  if (sessions && !/export function normalizeExecutionSession[\s\S]{0,900}cleanupVerified/.test(sessions)) {
    problems.push('会话投影没把 cleanupVerified 带到消费端');
  }
  if (core && !/cleanupVerified\s*===\s*true/.test(core)) {
    problems.push('指挥官 stop 候选没认已确认清退证据');
  }
  if (admit && !/capNewDispatchSlots/.test(admit)) problems.push('老单优先没有把新单槽位压到 1');
  if (reap && !/planTreeReaps/.test(reap)) problems.push('清树判据 planTreeReaps 丢了');
  if (commander && !/leftoverIncompleteAfterStops/.test(commander)) {
    problems.push('交卷残留没按 stop-session 结果重算');
  }
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
