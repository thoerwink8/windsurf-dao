#!/usr/bin/env bash
# /usr/local/sbin/dao-install-units —— 把仓内 host/machine/systemd 推到 /etc。
#
# 来历（#1408）：#1226 合进 master 23 小时，测试绿，机器上还是旧单元。
# dao-sync 跑 orca，写不了 /etc；让它以 root 解释仓内脚本，正是 2026-09-05
# 堵掉的提权路。所以本文件装到 root 自有目录，只 `install` 单元文件，
# 不执行 checkout 里任何东西。
#
# 装法：sudo bash scripts/install-dao-sync.sh
# 验：sudo -n /usr/local/sbin/dao-install-units ；dao-check ㊳ 绿
set -euo pipefail

REPO=/srv/projects/windsurf-dao
SRC="$REPO/host/machine/systemd"
DEST=/etc/systemd/system

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：应被 install 到 /usr/local/sbin/dao-install-units" >&2
  exit 1
fi
if [[ ! -d "$SRC" ]]; then
  echo "仓内单元目录不在：$SRC" >&2
  exit 1
fi

shopt -s nullglob
changed=()
for f in "$SRC"/*.service "$SRC"/*.timer; do
  name="$(basename "$f")"
  case "$name" in
    *[!A-Za-z0-9._-]*|'') echo "跳过非法单元名：$name" >&2; continue ;;
  esac
  dest="$DEST/$name"
  if [[ -f "$dest" ]] && cmp -s "$f" "$dest"; then
    continue
  fi
  install -m 644 "$f" "$dest"
  changed+=("$name")
done

if [[ ${#changed[@]} -eq 0 ]]; then
  exit 0
fi

systemctl daemon-reload
for name in "${changed[@]}"; do
  case "$name" in
    *.timer)
      systemctl try-restart "$name" >/dev/null 2>&1 || true
      ;;
  esac
done
echo "上机 ${#changed[@]} 个单元：${changed[*]}"
