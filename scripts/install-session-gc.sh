#!/bin/bash
# 幂等安装会话目录对账 timer。要 root：sudo bash scripts/install-session-gc.sh
set -euo pipefail
cd "$(dirname "$0")/.."
UNIT_DIR=host/machine/systemd

install -m 644 "$UNIT_DIR/dao-session-gc.service" /etc/systemd/system/dao-session-gc.service
install -m 644 "$UNIT_DIR/dao-session-gc.timer" /etc/systemd/system/dao-session-gc.timer
systemctl daemon-reload
systemctl enable --now dao-session-gc.timer
systemctl list-timers --all | grep dao-session-gc || true
echo "installed dao-session-gc.timer"
