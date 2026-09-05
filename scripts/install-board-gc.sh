#!/usr/bin/env bash
# 幂等安装僵尸卡回收 timer。要 root：sudo bash scripts/install-board-gc.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：sudo bash $0" >&2
  exit 1
fi

install -m 644 "$UNIT_DIR/dao-board-gc.service" /etc/systemd/system/dao-board-gc.service
install -m 644 "$UNIT_DIR/dao-board-gc.timer" /etc/systemd/system/dao-board-gc.timer
systemctl daemon-reload
systemctl enable --now dao-board-gc.timer
systemctl list-timers --all | grep dao-board-gc || true
echo "installed dao-board-gc.timer"
