#!/usr/bin/env bash
# 幂等安装 dao-sync timer（主树跟主分支 + 机器人吃新码）。要 root：sudo bash scripts/install-dao-sync.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"
if [[ "${EUID}" -ne 0 ]]; then echo "要 root：sudo bash $0" >&2; exit 1; fi
install -m 644 "$UNIT_DIR/dao-sync.service" /etc/systemd/system/dao-sync.service
install -m 644 "$UNIT_DIR/dao-sync.timer" /etc/systemd/system/dao-sync.timer
# #1408：上机钩子落到 root 自有目录（含特权行 manifest）。不 chmod 仓内文件
# （可执行位归 git；装机时再 chmod 会把工作树弄脏，ff-only 同步 Aborting，
# 2026-09-05 实咬）。User/ExecStart/root Environment 变了必须重跑本脚本。
install -o root -g root -m 755 "$ROOT/scripts/dao-install-units.sh" /usr/local/sbin/dao-install-units
# sudoers 先验语法再落位——写坏了整台机器的 sudo 都用不了。
visudo -cf "$ROOT/host/machine/sudoers.d/dao-sync"
install -m 440 "$ROOT/host/machine/sudoers.d/dao-sync" /etc/sudoers.d/dao-sync

systemctl daemon-reload
systemctl enable --now dao-sync.timer
systemctl list-timers --all | grep -E 'dao-sync' || true
echo "installed dao-sync.timer"
