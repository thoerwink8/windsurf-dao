#!/usr/bin/env bash
# 幂等安装关单 timer（刚合进的 PR 自动关单）。要 root：sudo bash scripts/install-dao-close-issues.sh
#
# 装完先自己验一遍：脚本会以 orca 身份跑一次 --dry-run，看得见「窗口里有几张、会关谁」再交给定时器。
# dry-run 不改任何 issue 状态。
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

install -m 644 "$UNIT_DIR/dao-close-issues.service" /etc/systemd/system/dao-close-issues.service
install -m 644 "$UNIT_DIR/dao-close-issues.timer" /etc/systemd/system/dao-close-issues.timer
systemctl daemon-reload
systemctl enable --now dao-close-issues.timer

# 装上不等于跑得通。以 orca（不是 root）预演一次，凭据没装 / 搜索语法坏了当场就看得见。
echo "--- 预演（dry-run，不改 issue）---"
if ! runuser -u orca -- env -C "$ROOT" \
  PATH=/home/orca/.local/bin:/home/orca/bin:/usr/local/bin:/usr/bin:/bin \
  /usr/bin/node "$ROOT/scripts/close-issues.mjs" --since-hours 6 --dry-run; then
  echo "预演没跑成——timer 已装上但它跑起来也是这个结果，先修再走。" >&2
  exit 1
fi

systemctl list-timers --all --no-pager | grep dao-close-issues || true
echo "installed dao-close-issues.timer"
