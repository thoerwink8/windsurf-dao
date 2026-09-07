#!/usr/bin/env bash
# 幂等安装 land timer（合并后清树）。要 root：sudo bash scripts/install-land.sh
#
# orca automations 那条路已随 orca 产品退役。本脚本是唯一装法。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：sudo bash $0" >&2
  exit 1
fi

install -m 644 "$UNIT_DIR/dao-land.service" /etc/systemd/system/dao-land.service
install -m 644 "$UNIT_DIR/dao-land.timer" /etc/systemd/system/dao-land.timer
systemctl daemon-reload
systemctl enable --now dao-land.timer
systemctl list-timers --all --no-pager | grep dao-land || true
echo "installed dao-land.timer"
