// scripts/lib/agent-stall-detect.mjs —— 连红账本的路径与僵尸剪除（#833 残留面）
//
// 2026-09-06 用户拍板「删掉整层」：屏面指纹那一套（STALL_FINGERPRINTS / scanRound /
// nextStrike / decideHitAction）连同宿主 scripts/agent-stall-watch.mjs 一起删了。
// 卡死发现改由 scripts/progress-watch.mjs 按盘面推进量判——不猜执行体屏幕上写了什么。
//
// 这里只剩两件与指纹无关、仍有活调用点的东西：
//   - stallWatchPath：连红账本落点，commander.mjs 与 lib/provider-breaker.mjs 都读它
//   - pruneDeadStrikes：撞死条目 × 在世终端交叉核对，commander.mjs 每轮调
// 文件名与账本文件名（~/.dao/agent-stall-watch.json）保持一致，改名会丢历史账。

import { join } from 'node:path';

/** 正式连红账本。指挥官 / 熔断都读这一处，禁止再默认 ~/.agent-stall-watch.json（那是 #833 退役垫片）。 */
export function stallWatchPath(home) {
  return join(home, '.dao', 'agent-stall-watch.json');
}

/** 撞死条目的 key 与在世终端的身份串比对；宽松（后缀相等也算同一个），偏向「留着」。 */
function sameTerminal(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right) return false;
  return left === right || left.endsWith(`::${right}`) || right.endsWith(`::${left}`);
}

/** 一条终端记录里所有可当身份用的串。 */
function identitiesOf(t) {
  if (!t || typeof t !== 'object') return [];
  return [t.handle, t.id, t.terminalId, t.terminal].filter(Boolean).map(String);
}

/**
 * 僵尸条目剪除（#889→#908 实咬）：撞死条目 × 在世终端清单交叉核对。
 *
 * 终端死掉/被关后条目留在状态文件里，指挥官每轮把它当活撞死报帅，关了又开。
 * 剪除只在「清单确实查成了」时做——live.ok=false 一条不剪（「没查成」≠「终端不存在」），
 * 宁可多报一轮，也不能因为读不到清单就把真撞死悄悄抹掉。
 *
 * @param {{ strikes?: object, live?: {ok:boolean, terminals?: any[], error?: any} }} input
 * @returns {{ strikes: object, pruned: string[], changed: boolean, skipped: string|null }}
 */
export function pruneDeadStrikes({ strikes = {}, live = null } = {}) {
  const src = strikes && typeof strikes === 'object' ? strikes : {};
  if (!live || live.ok !== true || !Array.isArray(live.terminals)) {
    const why = live && live.error ? String(live.error) : '终端清单没查成';
    return { strikes: { ...src }, pruned: [], changed: false, skipped: why };
  }
  const alive = live.terminals.flatMap(identitiesOf);
  const kept = {};
  const pruned = [];
  for (const [handle, info] of Object.entries(src)) {
    if (alive.some((id) => sameTerminal(handle, id))) kept[handle] = info;
    else pruned.push(handle);
  }
  return { strikes: kept, pruned, changed: pruned.length > 0, skipped: null };
}
