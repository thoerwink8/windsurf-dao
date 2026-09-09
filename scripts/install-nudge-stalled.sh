#!/usr/bin/env bash
# 退役「推一把」timer（ephemeral-lifecycle：会话不常驻，不再往 incomplete 树上堆人）。
# 要 root：sudo bash scripts/install-nudge-stalled.sh
#
# 幂等：没装过也 exit 0。不要再 enable 这个单元。
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：sudo bash $0" >&2
  exit 1
fi

systemctl disable --now dao-nudge-stalled.timer 2>/dev/null || true
systemctl stop dao-nudge-stalled.service 2>/dev/null || true
rm -f /etc/systemd/system/dao-nudge-stalled.timer /etc/systemd/system/dao-nudge-stalled.service
rm -f /etc/systemd/system/timers.target.wants/dao-nudge-stalled.timer
systemctl daemon-reload || true
echo "retired dao-nudge-stalled.timer"
