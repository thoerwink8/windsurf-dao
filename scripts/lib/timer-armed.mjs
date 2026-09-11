// scripts/lib/timer-armed.mjs —— 「这个 timer 此刻还会自己响吗」的纯判据。
//
// 为什么需要它（收件箱 2026-09-10「指挥官 timer 停了自检仍绿」实咬，#1177）：
// 指挥官自检原本只跑 `systemctl is-enabled`，而 commander-act.timer 当时是
// **enabled + inactive(dead)、NEXT=-**——自动派单那条 20 分钟的腿实际停了 7 小时，
// 自检每轮回「✓ 齐（…enabled）」。`enabled` 说的是「开机时会拉起」，
// 跟「此刻会不会排下一次」是两件事，把前者当后者就是 fail-open。
//
// 判据（全部来自 `systemctl show`，不解析人类可读的 list-timers 文本）：
//   · UnitFileState ≠ enabled        → 红（不在册，永远不响）
//   · 两个 NextElapse 任意一个有真值 → 绿（会排下一次）
//   · 没有下一次 + SubState=running  → 绿。前一响的服务还在跑，systemd 等它结束
//                                      才排下一次，「没有下一次」在这里是正常。
//   · 没有下一次 + 其余 SubState
//     （dead / elapsed / waiting / 空）→ 红。含 ActiveState=active(elapsed)：
//                                      那是单调时钟死态，⑭ 不许因 active 放行。
//
// 「没有下一次」= 空 / 0 / n/a / infinity。systemd 在停摆时把
// NextElapseUSecMonotonic 写成 infinity，把它当「有下一次」会漏掉 09-10 那次。
//
// 红的修法指向 start / enable --now，不指向 install：09-10 的单元文件已经对，
// 再写一遍文件解决不了 inactive(dead)。
//
// 三态纪律：探不到（不是 Linux、systemctl 没跑成）一律 unknown，绝不当 ok。
// ⑭（commander 两个 timer）和 ⑱（全机 /etc 的 timer）共用 hasNextElapse，
// 对同一份活数据问同一件事。

const NO_NEXT = new Set(['', '0', 'n/a', 'infinity']);

/** 这一格算不算「有未来触发点」。null/空/0/n/a/infinity 都没有。 */
export function hasNextElapse(next) {
  if (next == null) return false;
  // 取数层可能把 realtime|monotonic 拼成一格；任一截有真值就算有。
  return String(next).split('|').some((part) => {
    const t = part.trim();
    return t !== '' && !NO_NEXT.has(t);
  });
}

/** 两个时钟点位合成一格：空/0/n/a/infinity 丢掉，剩下的用 | 拼。都没有回 ''。 */
export function combineNextElapse(...vals) {
  const ok = vals
    .map((v) => String(v ?? '').trim())
    .filter((t) => t !== '' && !NO_NEXT.has(t));
  return ok.length ? ok.join('|') : '';
}

/** 一条 timer 的取样。字段名与 `systemctl show` 对齐，逐键取（它的输出顺序与命令行无关）。 */
export function judgeArmed({ unit, isEnabled, activeState, subState, next } = {}) {
  const u = String(unit || '（没给单元名）');
  const en = String(isEnabled || '').trim();
  const act = String(activeState || '').trim();
  const sub = String(subState || '').trim();
  const nextRaw = String(next ?? '').trim();

  if (!en) return { armed: false, why: `${u} 探不到 UnitFileState` };
  if (en !== 'enabled') {
    return { armed: false, why: `${u} 未启用（UnitFileState=${en}）——sudo systemctl enable --now ${u}` };
  }
  if (hasNextElapse(nextRaw)) {
    return { armed: true, why: `${u} ${en}/${act || 'unknown'}${sub ? `(${sub})` : ''}，下一次 ${nextRaw}` };
  }
  // 没有下一次：running 是正常（服务还在跑）；其余是停摆。
  // 不看 ActiveState=active 就放行——active(elapsed) 正是 ⑱ 已经在抓、⑭ 曾经漏掉的死态。
  if (sub === 'running') {
    return { armed: true, why: `${u} ${en}/active(running)` };
  }
  return {
    armed: false,
    why: `${u} enabled 但 ${act || '状态不明'}${sub ? `(${sub})` : ''} 且没有下一次——sudo systemctl start ${u}`,
  };
}

/**
 * 一批 timer 的结论（指挥官那两个，⑭ / commander status / 盘点 checkTimers）。
 * @param {{probed:boolean, reason?:string, timers?:Array<object>}} input
 * @returns {{state:'ok'|'red'|'unknown', detail:string, bad?:Array<{unit:string,why:string}>}}
 */
export function classifyTimerArmed({ probed = false, reason = '', timers = [] } = {}) {
  if (!probed) return { state: 'unknown', detail: reason || '没探到 systemctl（本平台无 systemd？）' };
  if (!Array.isArray(timers) || timers.length === 0) {
    return { state: 'unknown', detail: '一个 timer 都没取样到——本次没查成，不是「都正常」' };
  }
  const bad = [];
  const seen = [];
  for (const t of timers) {
    const v = judgeArmed(t);
    if (!v.armed) bad.push({ unit: String(t?.unit || '?'), why: v.why });
    else seen.push(v.why);
  }
  if (bad.length) {
    return {
      state: 'red',
      detail: `timer 不会自己响：${bad.map((b) => b.why).join('、')}`,
      bad,
    };
  }
  return { state: 'ok', detail: `${seen.length} 个 timer 在册且会自己响（${seen.join('、')}）` };
}
