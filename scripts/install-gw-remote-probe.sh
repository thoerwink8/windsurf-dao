#!/usr/bin/env bash
# 幂等安装供应商探活 timer（#967）。要 root：sudo bash scripts/install-gw-remote-probe.sh
#
# 不 chmod 仓内文件：可执行位已经在 git 里。装机时再 chmod 会把工作树弄脏，
# 而 dao-sync 走 merge --ff-only——脏树直接 Aborting，服务器同步从此停摆。
#
# 旧路径：脚本自己 --install 写 /etc，模板没有 OnCalendar。本脚本是唯一装法。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：sudo bash $0" >&2
  exit 1
fi

install -m 644 "$UNIT_DIR/gw-remote-probe.service" /etc/systemd/system/gw-remote-probe.service
install -m 644 "$UNIT_DIR/gw-remote-probe.timer" /etc/systemd/system/gw-remote-probe.timer

# 2026-09-05 止血时加过 drop-in（OnCalendar=*:07/30，撞 dao-board-gc）。
# 仓内单元已经带 *:09/30，drop-in 留下会盖掉仓里的点位，⑳ 也会报漂移。
rm -f /etc/systemd/system/gw-remote-probe.timer.d/oncalendar.conf
rmdir /etc/systemd/system/gw-remote-probe.timer.d 2>/dev/null || true

systemctl daemon-reload
systemctl enable --now gw-remote-probe.timer
# enable --now 只起 timer；oneshot + 从未激活的 service 会让 OnUnitActiveSec 空转。
# OnCalendar 不依赖这一步，但当场起一次就能验第一轮，不用等下一个 :09。
systemctl start gw-remote-probe.service || true

# 装完必须验「有没有下一次触发」，不是验「在不在册」：只显示 active+enabled 的 timer
# 也可能已经进了 active(elapsed) 死态，永不再跑而无人报警。NEXT 为空就当场报错退出。
next="$(systemctl show gw-remote-probe.timer -p NextElapseUSecRealtime --value || true)"
if [[ -z "$next" || "$next" == "0" || "$next" == "n/a" || "$next" == "infinity" ]]; then
  echo "装上了但没有下一次触发（单元缺 OnCalendar？）：gw-remote-probe.timer" >&2
  exit 1
fi

systemctl list-timers --all --no-pager | grep gw-remote-probe || true
echo "installed gw-remote-probe.timer（下一次触发已就位）"
