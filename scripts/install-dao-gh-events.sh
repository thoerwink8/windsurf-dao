#!/usr/bin/env bash
# 幂等安装 GitHub 事件桥（#956）。要 root：sudo bash scripts/install-dao-gh-events.sh
#
# 「装上了」不等于「会跑」（这仓一天内被咬过三次）。所以本脚本装完不是打印 installed 就走，
# 而是真起服务、等它自己的 ping 从 GitHub 绕一圈回来，回不来就判失败。
# 那个 ping 就是端到端证据：hook 建成了、出站 wss 通了、投递进得来。
#
# 不 chmod 仓内文件：可执行位已经在 git 里。装机时再 chmod 会把工作树弄脏，
# 而 dao-sync 走 merge --ff-only——脏树直接 Aborting，服务器同步从此停摆。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"
SUDOERS_SRC="$ROOT/host/machine/sudoers.d/dao-gh-events"
STATE="/home/orca/.dao/gh-events.json"

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：sudo bash $0" >&2
  exit 1
fi

# ① gh 的 webhook 扩展。桥全靠它拉出站长连接，没有它整条路不存在。
if ! runuser -u orca -- gh extension list 2>/dev/null | grep -q 'gh-webhook'; then
  echo "--- 装 gh webhook 扩展 ---"
  runuser -u orca -- gh extension install cli/gh-webhook
fi
runuser -u orca -- gh webhook forward --help >/dev/null 2>&1 || {
  echo "gh webhook forward 跑不起来——扩展没装成，先修再走。" >&2; exit 1; }

# ② sudoers 白名单。写坏 sudoers 会把整台机器锁死，所以先验语法再落位。
echo "--- sudoers 白名单 ---"
install -m 440 "$SUDOERS_SRC" /etc/sudoers.d/dao-gh-events.new
if ! visudo -c -f /etc/sudoers.d/dao-gh-events.new; then
  rm -f /etc/sudoers.d/dao-gh-events.new
  echo "sudoers 语法不过，没有落位。" >&2; exit 1
fi
mv /etc/sudoers.d/dao-gh-events.new /etc/sudoers.d/dao-gh-events

# ③ 单元
install -m 644 "$UNIT_DIR/dao-gh-events.service" /etc/systemd/system/dao-gh-events.service
systemctl daemon-reload
systemctl enable --now dao-gh-events.service

# ④ 白名单真能用吗：让 orca 走一遍真命令。这一步失败＝事件收到了也叫不动人。
echo "--- 验白名单（该成功）---"
runuser -u orca -- sudo -n /usr/bin/systemctl start --no-block dao-close-issues.service
echo "--- 验白名单没开太宽（该被拒）---"
if runuser -u orca -- sudo -n /usr/bin/systemctl start --no-block orca-serve.service 2>/dev/null; then
  echo "白名单开太宽：orca 竟然能起 orca-serve。停手先收窄。" >&2; exit 1
fi
echo "  被拒，符合预期"

# ⑤ 端到端：等桥自己的 ping 从 GitHub 绕回来。等不到就是没跑通，不许当装好了。
echo "--- 等自证 ping 回来（最多 60 秒）---"
for _ in $(seq 1 30); do
  if [[ -f "$STATE" ]] && runuser -u orca -- node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.exit(s.ping && s.ping.recvAt ? 0 : 1);
  ' "$STATE" 2>/dev/null; then
    echo "  ping 回来了——出站通道通，投递进得来"
    runuser -u orca -- env -C "$ROOT" /usr/bin/node "$ROOT/scripts/gh-event-bridge.mjs" status || true
    systemctl --no-pager --lines=0 status dao-gh-events.service | head -4 || true
    echo "installed dao-gh-events.service"
    exit 0
  fi
  sleep 2
done

echo "60 秒没等到自证 ping——单元起了但事件进不来，先修再走。" >&2
journalctl -u dao-gh-events -n 30 --no-pager >&2 || true
exit 1
