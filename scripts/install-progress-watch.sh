#!/usr/bin/env bash
# 退役盘面推进量独立 timer（ephemeral-lifecycle：并进 commander-act）。
# 要 root：sudo bash scripts/install-progress-watch.sh
#
# 幂等：没装过也 exit 0。不要再 enable 这个单元。
# 顺手卸屏面指纹层（2026-09-06 退役）——装新的那一刻就是旧的该走的时候。
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：sudo bash $0" >&2
  exit 1
fi

systemctl disable --now dao-progress-watch.timer 2>/dev/null || true
systemctl stop dao-progress-watch.service 2>/dev/null || true
rm -f /etc/systemd/system/dao-progress-watch.timer /etc/systemd/system/dao-progress-watch.service
rm -f /etc/systemd/system/timers.target.wants/dao-progress-watch.timer

systemctl disable --now dao-agent-stall.timer 2>/dev/null || true
systemctl disable --now agent-stall-watch.timer 2>/dev/null || true
rm -f /etc/systemd/system/dao-agent-stall.timer /etc/systemd/system/dao-agent-stall.service
rm -f /etc/systemd/system/agent-stall-watch.timer /etc/systemd/system/agent-stall-watch.service
rm -f /home/orca/bin/agent-stall-watch.mjs

systemctl daemon-reload || true
echo "retired dao-progress-watch.timer（已并进 commander-act）"
