#!/usr/bin/env bash
# 幂等安装「推一把卡住的会话」timer（垫片，随 issue #1056 退役）。
# 要 root：sudo bash scripts/install-nudge-stalled.sh
#
# 不 chmod 仓内文件：可执行位已经在 git 里。装机时再 chmod 会把工作树弄脏，
# 而 dao-sync 走 merge --ff-only——脏树直接 Aborting，服务器同步从此停摆。
#
# 退役怎么做（#1056 落地时）：
#   sudo systemctl disable --now dao-nudge-stalled.timer
#   sudo rm -f /etc/systemd/system/dao-nudge-stalled.{timer,service}
#   git rm scripts/nudge-stalled.mjs scripts/install-nudge-stalled.sh host/machine/systemd/dao-nudge-stalled.*
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：sudo bash $0" >&2
  exit 1
fi

install -m 644 "$UNIT_DIR/dao-nudge-stalled.service" /etc/systemd/system/dao-nudge-stalled.service
install -m 644 "$UNIT_DIR/dao-nudge-stalled.timer" /etc/systemd/system/dao-nudge-stalled.timer

systemctl daemon-reload
systemctl enable --now dao-nudge-stalled.timer
# enable --now 只起 timer；oneshot + 从未激活的 service 会让 OnUnitActiveSec 空转。
# 当场跑一次就能验第一轮，不用等下一个 :17。
systemctl start dao-nudge-stalled.service || true

# NEXT 是 `-` 就等于没装上（active elapsed 死态），当场报出来而不是留给明天。
if systemctl list-timers --all --no-pager | grep dao-nudge-stalled | grep -q '^-'; then
  echo "装上了但 NEXT 是 '-'——timer 进了死态，不会再触发" >&2
  exit 1
fi
systemctl list-timers --all --no-pager | grep dao-nudge-stalled || true
echo "installed dao-nudge-stalled.timer"
