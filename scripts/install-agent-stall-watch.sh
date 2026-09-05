#!/usr/bin/env bash
# 幂等安装撞限流探测 timer，并退役 Contabo 垫片（#833）。
# 要 root：sudo bash scripts/install-agent-stall-watch.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：sudo bash $0" >&2
  exit 1
fi

install -m 644 "$UNIT_DIR/dao-agent-stall.service" /etc/systemd/system/dao-agent-stall.service
install -m 644 "$UNIT_DIR/dao-agent-stall.timer" /etc/systemd/system/dao-agent-stall.timer

# 垫片退役：timer + 脚本一起删
systemctl disable --now agent-stall-watch.timer 2>/dev/null || true
rm -f /etc/systemd/system/agent-stall-watch.timer /etc/systemd/system/agent-stall-watch.service
rm -f /home/orca/bin/agent-stall-watch.mjs
rm -f /home/orca/.agent-stall-watch.json

systemctl daemon-reload
systemctl enable --now dao-agent-stall.timer
# enable --now 只起 timer；oneshot + 从未激活的 service 会让 OnUnitActiveSec 空转。
# OnCalendar 不依赖这一步，但当场起一次就能验第一轮，不用等下一个 :00/:15。
systemctl start dao-agent-stall.service || true
systemctl list-timers --all | grep -E 'dao-agent-stall|agent-stall-watch' || true
echo "installed dao-agent-stall.timer"
