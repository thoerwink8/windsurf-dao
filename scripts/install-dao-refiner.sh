#!/usr/bin/env bash
# 幂等安装消歧官 timer（给「已消歧」闸补执行者）。要 root：sudo bash scripts/install-dao-refiner.sh
#
# 装完先自己验一遍：脚本会以 orca 身份跑一次 --dry-run，看得见「这轮会动谁」再交给定时器。
# dry-run 不改任何 issue。
#
# 不 chmod 仓内文件：可执行位已经在 git 里。装机时再 chmod 会把工作树弄脏，
# 而 dao-sync 走的是 merge --ff-only——脏树直接 Aborting，服务器同步从此停摆（2026-09-05 实咬）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：sudo bash $0" >&2
  exit 1
fi

install -m 644 "$UNIT_DIR/dao-refiner.service" /etc/systemd/system/dao-refiner.service
install -m 644 "$UNIT_DIR/dao-refiner.timer" /etc/systemd/system/dao-refiner.timer
systemctl daemon-reload
systemctl enable --now dao-refiner.timer

next="$(systemctl show dao-refiner.timer -p NextElapseUSecRealtime --value || true)"
if [[ -z "$next" || "$next" == "0" || "$next" == "n/a" || "$next" == "infinity" ]]; then
  echo "装上了但没有下一次触发（单元缺 OnCalendar？）：dao-refiner.timer" >&2
  exit 1
fi

echo "--- 预演（dry-run，不改 issue）---"
if ! runuser -u orca -- env -C "$ROOT" \
  PATH=/home/orca/.local/bin:/home/orca/bin:/usr/local/bin:/usr/bin:/bin \
  /usr/bin/node "$ROOT/scripts/refiner.mjs" --dry-run; then
  echo "预演没跑成——timer 已装上但它跑起来也是这个结果，先修再走。" >&2
  exit 1
fi

systemctl list-timers --all --no-pager | grep dao-refiner || true
echo "installed dao-refiner.timer（下一次触发已就位）"
