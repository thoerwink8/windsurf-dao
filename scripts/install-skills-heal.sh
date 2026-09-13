#!/usr/bin/env bash
# 幂等安装 skills 装载面自愈 timer（#1146）。要 root：sudo bash scripts/install-skills-heal.sh
#
# 不 chmod 仓内任何东西：可执行位归 git 记（100755）。装机时再 chmod 会把工作树弄脏，
# 而主树同步走的是 merge --ff-only——脏树直接 Aborting，同步从此停摆（2026-09-05 实咬）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：sudo bash $0" >&2
  exit 1
fi

install -m 644 "$UNIT_DIR/dao-skills-heal.service" /etc/systemd/system/dao-skills-heal.service
install -m 644 "$UNIT_DIR/dao-skills-heal.timer" /etc/systemd/system/dao-skills-heal.timer
systemctl daemon-reload
systemctl enable --now dao-skills-heal.timer

# 装完必须验「有没有下一次触发」，不是验「在不在册」：只显示 active+enabled 的 timer
# 也可能已经进了 active(elapsed) 死态，永不再跑而无人报警。NEXT 为空就当场报错退出。
next="$(systemctl show dao-skills-heal.timer -p NextElapseUSecRealtime --value || true)"
if [[ -z "$next" || "$next" == "0" || "$next" == "n/a" || "$next" == "infinity" ]]; then
  echo "装上了但没有下一次触发（单元缺 OnCalendar？）：dao-skills-heal.timer" >&2
  exit 1
fi
systemctl list-timers --all --no-pager | grep dao-skills-heal || true
echo "installed dao-skills-heal.timer（下一次触发已就位）"
