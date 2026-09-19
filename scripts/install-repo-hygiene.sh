#!/usr/bin/env bash
# 幂等安装仓库卫生巡检 timer（2026-09-19，用户：「主分支都有待合入或待拉取的，应该要有制度保证」）。
# 要 root：sudo bash scripts/install-repo-hygiene.sh
#
# 装 dao-repo-hygiene.timer（每天 10:23 跑 scripts/repo-hygiene.mjs，User=orca）。
# 跑的是仓内脚本、仓在 /srv/projects/windsurf-dao——所以必须 User=orca，不能 root
# （以 root 解释一个每个执行体都能写的仓 = 给它们一条 root 通道）。
#
# 装完读回：is-active / is-enabled / list-timers 的 NEXT 必须是时间。
# 单元清单与特权行还钉在 scripts/dao-install-units.sh 的 manifest 里（那份才是上机钩子认的），
# 本脚本只是把这两只单元装到 /etc/systemd/system 并 enable。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"
DEST=/etc/systemd/system

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：sudo bash scripts/install-repo-hygiene.sh" >&2
  exit 1
fi

for unit in dao-repo-hygiene.service dao-repo-hygiene.timer; do
  if [[ ! -f "$UNIT_DIR/$unit" ]]; then
    echo "仓内单元不在：$UNIT_DIR/$unit" >&2
    exit 1
  fi
done

install -m 0644 "$UNIT_DIR/dao-repo-hygiene.service" "$DEST/dao-repo-hygiene.service"
install -m 0644 "$UNIT_DIR/dao-repo-hygiene.timer" "$DEST/dao-repo-hygiene.timer"

systemctl daemon-reload
systemctl enable --now dao-repo-hygiene.timer

echo "=== 读回（装上了不算，要读回在跑）==="
systemctl is-active dao-repo-hygiene.timer
systemctl is-enabled dao-repo-hygiene.timer
if ! systemctl list-timers dao-repo-hygiene.timer --no-pager | grep -qE '[0-9]{4}-[0-9]{2}-[0-9]{2}'; then
  echo "NEXT 不是时间——timer 没武装（只有单调时钟的 timer 会进 active(elapsed) 死态）" >&2
  exit 1
fi
systemctl list-timers dao-repo-hygiene.timer --no-pager | sed -n '2p'
echo "装好了。首轮想立刻看结果：sudo systemctl start dao-repo-hygiene.service && journalctl -u dao-repo-hygiene -n 30 -o cat"
