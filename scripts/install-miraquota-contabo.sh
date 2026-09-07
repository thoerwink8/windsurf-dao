#!/usr/bin/env bash
# 幂等安装 Contabo → MiraQuota 多机页采样器 timer。要 root：sudo bash scripts/install-miraquota-contabo.sh
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

install -m 644 "$UNIT_DIR/miraquota-contabo.service" /etc/systemd/system/miraquota-contabo.service
install -m 644 "$UNIT_DIR/miraquota-contabo.timer" /etc/systemd/system/miraquota-contabo.timer
systemctl daemon-reload
systemctl enable --now miraquota-contabo.timer

# 装完必须验「有没有下一次触发」，不是验「在不在册」：只显示 active+enabled 的 timer
# 也可能已经进了 active(elapsed) 死态，永不再跑而无人报警。NEXT 为空就当场报错退出。
next="$(systemctl show miraquota-contabo.timer -p NextElapseUSecRealtime --value || true)"
if [[ -z "$next" || "$next" == "0" || "$next" == "n/a" || "$next" == "infinity" ]]; then
  echo "装上了但没有下一次触发（单元缺 OnCalendar？）：miraquota-contabo.timer" >&2
  exit 1
fi

# 装上不等于采得动。以 orca（不是 root）预演一次 dry-run，令牌不在 / 协议不符当场看得见。
echo "--- 预演（dry-run，不推 git）---"
if ! runuser -u orca -- env -C "$ROOT" \
  PATH=/home/orca/.local/bin:/home/orca/bin:/usr/local/bin:/usr/bin:/bin \
  /usr/bin/node "$ROOT/scripts/miraquota-contabo-sync.mjs" --dry-run; then
  echo "预演没跑成——timer 已装上但它跑起来也是这个结果，先修再走。" >&2
  exit 1
fi

systemctl list-timers --all --no-pager | grep miraquota-contabo || true
echo "installed miraquota-contabo.timer（下一次触发已就位）"
