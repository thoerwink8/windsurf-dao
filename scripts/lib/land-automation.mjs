// land 的 systemd 安装规格（#829，orca automations 退役后换这条）。
// 名字只在这里定一份；安装脚本与 server-check 都读这里。

export const LAND_TIMER = 'dao-land.timer';
export const LAND_SERVICE = 'dao-land.service';
export const LAND_INSTALL = 'sudo bash scripts/install-land.sh';

/**
 * 纯函数：land timer 在册且 enabled，list-timers 的 NEXT 不是横杠。
 * 不在=红；systemctl 没探到=没查成。
 */
export function classifyLandTimer({
  probed = false,
  reason = '',
  isEnabled = '',
  timersText = '',
} = {}) {
  if (!probed) {
    return { state: 'unknown', detail: reason || '没探到 systemctl（本平台无 systemd？）' };
  }
  const st = String(isEnabled || '').trim();
  if (st !== 'enabled') {
    return {
      state: 'red',
      detail: `${LAND_TIMER}=${st || 'unknown'}（不在 = 红）——${LAND_INSTALL}`,
    };
  }
  const text = String(timersText || '');
  const line = text.split(/\r?\n/).find((l) => new RegExp(`\\b${LAND_TIMER}\\b`).test(l));
  if (!line) {
    return {
      state: 'red',
      detail: `${LAND_TIMER} enabled 但 list-timers 看不见——${LAND_INSTALL}`,
    };
  }
  const next = line.trim().split(/\s+/)[0];
  if (next === '-' || /^n\/a$/i.test(next)) {
    return {
      state: 'red',
      detail: `${LAND_TIMER} 在册但 NEXT 是横杠（空转）——单元要用 OnCalendar`,
    };
  }
  return { state: 'ok', detail: `${LAND_TIMER} 在册且启用`, count: 1 };
}
