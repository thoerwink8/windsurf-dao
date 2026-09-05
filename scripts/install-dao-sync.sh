#!/usr/bin/env bash
# 幂等安装 dao-sync timer（主树跟主分支 + 机器人吃新码）。要 root：sudo bash scripts/install-dao-sync.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"
if [[ "${EUID}" -ne 0 ]]; then echo "要 root：sudo bash $0" >&2; exit 1; fi
install -m 644 "$UNIT_DIR/dao-sync.service" /etc/systemd/system/dao-sync.service
install -m 644 "$UNIT_DIR/dao-sync.timer" /etc/systemd/system/dao-sync.timer
# 不 chmod：可执行位已经在 git 里（100755）。装机时再 chmod 会把工作树弄脏，
# 而 dao-sync 自己走的是 merge --ff-only——脏树直接 Aborting，同步从此停摆。
# 2026-09-05 实咬：装完安全修，下一次同步就卡在这里。
# sudoers 先验语法再落位——写坏了整台机器的 sudo 都用不了。
visudo -cf "$ROOT/host/machine/sudoers.d/dao-sync"
install -m 440 "$ROOT/host/machine/sudoers.d/dao-sync" /etc/sudoers.d/dao-sync

systemctl daemon-reload
systemctl enable --now dao-sync.timer
systemctl list-timers --all | grep -E 'dao-sync' || true
echo "installed dao-sync.timer"
