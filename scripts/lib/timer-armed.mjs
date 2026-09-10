// scripts/lib/timer-armed.mjs —— 「这个 timer 此刻还会自己响吗」的纯判据。
//
// 为什么需要它（收件箱 2026-09-10「指挥官 timer 停了自检仍绿」实咬）：
// 指挥官自检原本只跑 `systemctl is-enabled`，而 commander-act.timer 当时是
// **enabled + inactive(dead)、NEXT=-**——自动派单那条 20 分钟的腿实际停了 7 小时，
// 自检每轮回「✓ 齐（…enabled）」。`enabled` 说的是「开机时会拉起」，
// 跟「此刻会不会排下一次」是两件事，把前者当后者就是 fail-open。
//
// 判据（全部来自 `systemctl show`，不解析人类可读的 list-timers 文本）：
//   · UnitFileState ≠ enabled        → 红（不在册，永远不响）
//   · ActiveState=active             → 绿。**含 SubState=running 且 NEXT 为空的情形**：
//                                      前一响的服务还在跑，systemd 等它结束才排下一次，
//                                      「没有下一次」在这里是正常，不是停摆。
//   · ActiveState=inactive + NEXT 有值 → 绿（挂起等下一点，正常）
//   · ActiveState=inactive/failed 且 NEXT 空 → 红（不会自己再响；failed 另标）
//
// 三态纪律：探不到（不是 Linux、systemctl 没跑成）一律 unknown，绝不当 ok。

/** 一条 timer 的取样。字段名与 `systemctl show` 对齐，逐键取（它的输出顺序与命令行无关）。 */
export function judgeArmed({ unit, isEnabled, activeState, subState, next } = {}) {
  const u = String(unit || '（没给单元名）');
  const en = String(isEnabled || '').trim();
  const act = String(activeState || '').trim();
  const sub = String(subState || '').trim();
  const nextRaw = String(next ?? '').trim();

  if (!en) return { armed: false, why: `${u} 探不到 UnitFileState` };
  if (en !== 'enabled') return { armed: false, why: `${u} 未启用（UnitFileState=${en}）` };
  if (act === 'active') return { armed: true, why: `${u} ${en}/active${sub ? `(${sub})` : ''}` };
  if (nextRaw) return { armed: true, why: `${u} ${en}/inactive，下一次 ${nextRaw}` };
  return { armed: false, why: `${u} enabled 但 ${act || '状态不明'}${sub ? `(${sub})` : ''} 且没有下一次` };
}

/**
 * 一批 timer 的结论。
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
      detail: `timer 不会自己响：${bad.map((b) => b.why).join('、')}——node scripts/commander.mjs install`,
      bad,
    };
  }
  return { state: 'ok', detail: `${seen.length} 个 timer 在册且会自己响（${seen.join('、')}）` };
}
