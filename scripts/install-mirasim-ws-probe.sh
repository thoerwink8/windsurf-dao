#!/usr/bin/env bash
# 幂等安装 mirasim-server ws 探活 timer + 收 unit 进 /etc（#1151）。要 root：
#   sudo bash scripts/install-mirasim-ws-probe.sh
#
# 不 chmod 仓内文件：可执行位已经在 git 里。装机时再 chmod 会把工作树弄脏，
# 而 dao-sync 走 merge --ff-only——脏树直接 Aborting，服务器同步从此停摆。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"
SUDOERS_SRC="$ROOT/host/machine/sudoers.d/mirasim-ws-probe"

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：sudo bash $0" >&2
  exit 1
fi

# ① sudoers 白名单。写坏 sudoers 会把整台机器锁死，所以先验语法再落位。
echo "--- sudoers 白名单 ---"
install -m 440 "$SUDOERS_SRC" /etc/sudoers.d/mirasim-ws-probe.new
if ! visudo -c -f /etc/sudoers.d/mirasim-ws-probe.new; then
  rm -f /etc/sudoers.d/mirasim-ws-probe.new
  echo "sudoers 语法不过，没有落位。" >&2; exit 1
fi
mv /etc/sudoers.d/mirasim-ws-probe.new /etc/sudoers.d/mirasim-ws-probe

# ② mirasim-server unit（含 MemoryHigh/MemoryMax 垫片，ExecStart 走 current）。
# 手搓 drop-in memory-guard.conf 合进 unit 了，留下会盖出一份重复上限，
# ⑳ 也只比对 .service 看不到 .d——删掉才算收进仓。
# 升级器自己的 managed-update.conf 不是本仓的，不准删。
echo "--- mirasim-server.service ---"
install -m 644 "$UNIT_DIR/mirasim-server.service" /etc/systemd/system/mirasim-server.service
rm -f /etc/systemd/system/mirasim-server.service.d/memory-guard.conf
# rmdir 只在目录空时成功。升级器的 managed-update.conf 还在就留下 .d，不准 rm -rf。
rmdir /etc/systemd/system/mirasim-server.service.d 2>/dev/null || true

# ③ 探活 oneshot + timer
echo "--- mirasim-ws-probe ---"
install -m 644 "$UNIT_DIR/mirasim-ws-probe.service" /etc/systemd/system/mirasim-ws-probe.service
install -m 644 "$UNIT_DIR/mirasim-ws-probe.timer" /etc/systemd/system/mirasim-ws-probe.timer

systemctl daemon-reload
systemctl enable --now mirasim-server.service
systemctl enable --now mirasim-ws-probe.timer
# enable --now 只起 timer；oneshot + 从未激活的 service 会让 OnUnitActiveSec 空转。
# OnCalendar 不依赖这一步，但当场起一次就能验第一轮，不用等下一个 :08。
systemctl start mirasim-ws-probe.service || true

# ④ 白名单真能列出来。不要真 try-restart：装机脚本把活着的会话杀掉，比没装更糟。
echo "--- 验白名单（该能列出这条）---"
if ! runuser -u orca -- sudo -n -l | grep -q 'systemctl try-restart mirasim-server.service'; then
  echo "白名单没装成：orca 列不出 try-restart mirasim-server。" >&2; exit 1
fi
echo "--- 验白名单没开太宽（该被拒）---"
if runuser -u orca -- sudo -n /usr/bin/systemctl restart ssh.service 2>/dev/null; then
  echo "白名单开太宽：orca 竟然能 restart ssh.service。停手先收窄。" >&2; exit 1
fi

# 装完必须验「有没有下一次触发」，不是验「在不在册」。
next="$(systemctl show mirasim-ws-probe.timer -p NextElapseUSecRealtime --value || true)"
if [[ -z "$next" || "$next" == "0" || "$next" == "n/a" || "$next" == "infinity" ]]; then
  echo "装上了但没有下一次触发（单元缺 OnCalendar？）：mirasim-ws-probe.timer" >&2
  exit 1
fi

systemctl list-timers --all --no-pager | grep mirasim-ws-probe || true
echo "installed mirasim-ws-probe.timer（下一次触发已就位）"
