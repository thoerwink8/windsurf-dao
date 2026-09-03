#!/usr/bin/env bash
# 幂等安装 dao-sync timer（主树跟主分支 + 机器人吃新码）。要 root：sudo bash scripts/install-dao-sync.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"
if [[ "${EUID}" -ne 0 ]]; then echo "要 root：sudo bash $0" >&2; exit 1; fi
install -m 644 "$UNIT_DIR/dao-sync.service" /etc/systemd/system/dao-sync.service
install -m 644 "$UNIT_DIR/dao-sync.timer" /etc/systemd/system/dao-sync.timer
chmod +x "$ROOT/scripts/server-sync.sh"
systemctl daemon-reload
systemctl enable --now dao-sync.timer
systemctl list-timers --all | grep -E 'dao-sync' || true
echo "installed dao-sync.timer"
