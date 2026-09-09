#!/bin/bash
# 幂等安装 Mirasim 周期升级 timer。要 root：sudo bash scripts/install-mirasim-update.sh
#
# 升级器本体（/usr/local/lib/mirasim-managed-update/）不由本脚本安装——它随 ai-gateway-stack
# 部署，本脚本只负责「按点唤起它」这一层。装之前先确认它在，否则装出一个必然失败的单元。
set -euo pipefail
cd "$(dirname "$0")/.."
UNIT_DIR=host/machine/systemd
UPDATER=/usr/local/lib/mirasim-managed-update/mirasim-managed-update.mjs

[ -f "$UPDATER" ] || { echo "升级器不在 $UPDATER —— 先部署它再装 timer" >&2; exit 1; }

# 装之前先让它自证能跑：--check-only 只查不动，跑不通就别装定时器
node "$UPDATER" --check-only >/dev/null || { echo "升级器 --check-only 跑不通，不装 timer" >&2; exit 1; }

install -m 644 "$UNIT_DIR/mirasim-managed-update.service" /etc/systemd/system/mirasim-managed-update.service
install -m 644 "$UNIT_DIR/mirasim-managed-update.timer" /etc/systemd/system/mirasim-managed-update.timer
systemctl daemon-reload
systemctl enable --now mirasim-managed-update.timer

# NEXT 为空 = 装了个不会响的闹钟，当场报出来
systemctl list-timers --all | grep mirasim-managed-update || true
next=$(systemctl show mirasim-managed-update.timer -p NextElapseUSecRealtime --value)
[ -n "$next" ] && [ "$next" != "0" ] || { echo "timer 装上了但 NEXT 为空——不算装好" >&2; exit 1; }
echo "installed mirasim-managed-update.timer"
