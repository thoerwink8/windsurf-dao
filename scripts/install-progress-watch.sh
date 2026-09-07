#!/usr/bin/env bash
# 幂等安装盘面推进量看门狗 timer（#1004）。要 root：sudo bash scripts/install-progress-watch.sh
#
# 不 chmod 仓内文件：可执行位已经在 git 里。装机时再 chmod 会把工作树弄脏，
# 而 dao-sync 走 merge --ff-only——脏树直接 Aborting，服务器同步从此停摆。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：sudo bash $0" >&2
  exit 1
fi

install -m 644 "$UNIT_DIR/dao-progress-watch.service" /etc/systemd/system/dao-progress-watch.service
install -m 644 "$UNIT_DIR/dao-progress-watch.timer" /etc/systemd/system/dao-progress-watch.timer

# 屏面指纹层 2026-09-06 整层退役（用户拍板）。卸载放这里而不是单独一个脚本：
# 装新的那一刻就是旧的该走的时候，分成两条命令就会只跑一条。server-check ⑮ 守着这三件。
systemctl disable --now dao-agent-stall.timer 2>/dev/null || true
systemctl disable --now agent-stall-watch.timer 2>/dev/null || true
rm -f /etc/systemd/system/dao-agent-stall.timer /etc/systemd/system/dao-agent-stall.service
rm -f /etc/systemd/system/agent-stall-watch.timer /etc/systemd/system/agent-stall-watch.service
rm -f /home/orca/bin/agent-stall-watch.mjs

systemctl daemon-reload
systemctl enable --now dao-progress-watch.timer
# enable --now 只起 timer；oneshot + 从未激活的 service 会让 OnUnitActiveSec 空转。
# OnCalendar 不依赖这一步，但当场起一次就能验第一轮，不用等下一个 :13。
systemctl start dao-progress-watch.service || true
systemctl list-timers --all --no-pager | grep dao-progress-watch || true
echo "installed dao-progress-watch.timer"
