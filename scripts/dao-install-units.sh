#!/usr/bin/env bash
# /usr/local/sbin/dao-install-units —— 把仓内 host/machine/systemd 推到 /etc。
#
# 来历（#1408）：#1226 合进 master 23 小时，测试绿，机器上还是旧单元。
# dao-sync 跑 orca，写不了 /etc；让它以 root 解释仓内脚本，正是 2026-09-05
# 堵掉的提权路。本文件装到 root 自有目录。
#
# 只 install 单元文件还不够：systemd 会解释那些文件。checkout 可写
# dao-skills-heal-root.service 的 User=/ExecStart=，等于仍有一条 root 通道。
# 所以这份 root 副本里钉一份不可变特权行 manifest（User/Group/Exec*/Unit/
# root 的 Environment 等）。对得上才装；OnCalendar 等非特权行可以跟仓走。
# 特权行要改：改本文件的 manifest，再 sudo bash scripts/install-dao-sync.sh。
#
# 装法：sudo bash scripts/install-dao-sync.sh
# 验：sudo -n /usr/local/sbin/dao-install-units ；dao-check ㊳ 绿
# 测试：DAO_INSTALL_UNITS_TEST=1 且非 root 时才认 SRC/DEST（sudoers 无 SETENV，
# orca 经 sudo 调生产钩子带不进这些变量）。
set -euo pipefail

REPO=/srv/projects/windsurf-dao
SRC="$REPO/host/machine/systemd"
DEST=/etc/systemd/system
TEST_MODE=0

if [[ "${EUID}" -eq 0 ]]; then
  unset DAO_INSTALL_UNITS_TEST DAO_INSTALL_UNITS_SRC DAO_INSTALL_UNITS_DEST || true
elif [[ "${DAO_INSTALL_UNITS_TEST:-}" == 1 ]]; then
  TEST_MODE=1
  SRC="${DAO_INSTALL_UNITS_SRC:?test 要 DAO_INSTALL_UNITS_SRC}"
  DEST="${DAO_INSTALL_UNITS_DEST:?test 要 DAO_INSTALL_UNITS_DEST}"
else
  echo "要 root：应被 install 到 /usr/local/sbin/dao-install-units" >&2
  exit 1
fi
if [[ ! -d "$SRC" ]]; then
  echo "仓内单元目录不在：$SRC" >&2
  exit 1
fi
mkdir -p "$DEST"

# 特权行：决定「以谁、跑什么」。timer 缺 User 不算 root（systemd 也不用 [Service]）。
privilege_fp() {
  local file="$1" name="$2" kind=service
  [[ "$name" == *.timer ]] && kind=timer
  /usr/bin/awk -v kind="$kind" '
    BEGIN {
      n = split("User Group SupplementaryGroups DynamicUser ExecStart ExecStartPre ExecStartPost ExecStop ExecStopPost ExecReload ExecCondition EnvironmentFile WorkingDirectory RootDirectory RootImage BindPaths BindReadOnlyPaths AmbientCapabilities CapabilityBoundingSet Unit", a, " ")
      for (i = 1; i <= n; i++) always[a[i]] = 1
    }
    {
      sub(/\r$/, "")
      if (cont) { line = line $0 } else { line = $0 }
      if (line ~ /\\$/) { sub(/\\$/, "", line); cont = 1; next }
      cont = 0
      gsub(/^[ \t]+|[ \t]+$/, "", line)
      if (line == "" || line ~ /^[#;]/) next
      eq = index(line, "=")
      if (eq == 0) next
      key = substr(line, 1, eq - 1)
      val = substr(line, eq + 1)
      gsub(/[ \t]+$/, "", key)
      sub(/^[ \t]+/, "", val)
      if (key == "User") user = val
      c++
      keys[c] = key
      lines[c] = key "=" val
    }
    END {
      is_root = 0
      if (kind != "timer" && (user == "" || user == "root")) is_root = 1
      for (i = 1; i <= c; i++) {
        k = keys[i]
        if (always[k] || (is_root && k == "Environment")) print lines[i]
      }
    }
  ' "$file"
}

# 这份表跟着本脚本进 /usr/local/sbin，checkout 改不到。
manifest_fp() {
  local name="$1"
  /usr/bin/awk -v name="$name" '
    $0 == "### " name { grab = 1; found = 1; next }
    /^### / { if (grab) exit 0; next }
    grab { print }
    END { if (!found) exit 1 }
  ' <<'MANIFEST'
### dao-board-gc.service
User=orca
WorkingDirectory=/srv/projects/windsurf-dao
ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/board-gc.mjs --apply --say
### dao-board-gc.timer
### dao-board-watch.service
User=orca
WorkingDirectory=/srv/projects/windsurf-dao
ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/board-watch.mjs
### dao-board-watch.timer
### dao-close-issues.service
User=orca
Group=orca
WorkingDirectory=/srv/projects/windsurf-dao
ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/close-issues.mjs --since-hours 6
### dao-close-issues.timer
### dao-execution-usage-export.service
User=root
Group=root
ExecStart=/usr/bin/env -i HOME=/root PATH=/usr/bin:/bin GH_CONFIG_DIR=/var/empty /usr/bin/node /usr/local/lib/dao-execution-usage/execution-usage-export.mjs
Environment=GH_CONFIG_DIR=/var/empty
### dao-execution-usage.service
User=orca
Group=orca
WorkingDirectory=/srv/projects/windsurf-dao
ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/execution-usage.mjs --collect --sync-cursor-account --inbox /var/lib/dao-execution-usage/root-inbox --json
### dao-execution-usage.timer
### dao-gh-events.service
User=orca
Group=orca
WorkingDirectory=/srv/projects/windsurf-dao
ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/gh-event-bridge.mjs
### dao-land.service
User=orca
Group=orca
WorkingDirectory=/srv/projects/windsurf-dao
ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/land.mjs /srv/projects/windsurf-dao
### dao-land.timer
### dao-fleet-temporal.service
User=orca
Group=orca
WorkingDirectory=/home/orca
ExecStart=/usr/local/bin/temporal server start-dev --ip 127.0.0.1 --port 7233 --db-filename /home/orca/.dao/temporal/temporal.db --log-level warn
### dao-fleet-worker.service
User=orca
Group=orca
WorkingDirectory=/srv/projects/windsurf-dao
ExecStart=/usr/bin/node packages/fleet/src/cli.mjs worker
### dao-patrol-failure.service
User=orca
WorkingDirectory=/srv/projects/windsurf-dao
ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/patrol-failure.mjs
### dao-patrol.service
User=orca
WorkingDirectory=/srv/projects/windsurf-dao
ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/commander.mjs patrol
### dao-patrol.timer
### dao-refiner.service
User=orca
Group=orca
WorkingDirectory=/srv/projects/windsurf-dao
ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/refiner.mjs
### dao-refiner.timer
### dao-skills-heal-root.service
User=root
Group=root
Environment=HOME=/root
Environment=DAO_REPO_ROOT=/srv/projects/windsurf-dao
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=GH_CONFIG_DIR=/var/empty
ExecStart=/usr/bin/node /usr/local/lib/dao-skills-heal/skills-heal.mjs
### dao-skills-heal-root.timer
### dao-skills-heal.service
User=orca
Group=orca
WorkingDirectory=/srv/projects/windsurf-dao
ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/skills-heal.mjs
### dao-skills-heal.timer
### dao-sync.service
User=orca
Group=orca
ExecStart=/bin/bash /srv/projects/windsurf-dao/scripts/server-sync.sh
### dao-sync.timer
### feishu-triage.service
User=orca
EnvironmentFile=-/etc/feishu-triage.public.env
EnvironmentFile=/etc/feishu-triage.env
WorkingDirectory=/srv/projects/windsurf-dao
ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/feishu-triage.mjs
### gw-remote-probe.service
User=orca
Group=orca
WorkingDirectory=/srv/projects/windsurf-dao
ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/gw-remote-probe.mjs
### gw-remote-probe.timer
### miraquota-contabo.service
User=orca
Group=orca
WorkingDirectory=/srv/projects/windsurf-dao
ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/miraquota-contabo-sync.mjs --once
### miraquota-contabo.timer
### mirasim-managed-update.service
User=root
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=GH_CONFIG_DIR=/var/empty
ExecStart=/usr/bin/node /usr/local/lib/mirasim-managed-update/mirasim-managed-update.mjs
### mirasim-managed-update.timer
### mirasim-server.service
User=orca
WorkingDirectory=/home/orca/mirasim-server/current
ExecStart=/home/orca/mirasim-server/current/node /home/orca/mirasim-server/current/server.cjs --port 4316 --host 127.0.0.1 --no-open --workdir /home/orca/mirasim-work
### mirasim-ws-probe.service
User=orca
Group=orca
WorkingDirectory=/srv/projects/windsurf-dao
ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/mirasim-ws-probe.mjs
### mirasim-ws-probe.timer
MANIFEST
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

shopt -s nullglob
files=("$SRC"/*.service "$SRC"/*.timer)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "仓内单元目录是空的：$SRC" >&2
  exit 1
fi

changed=()
rejected=0
for f in "${files[@]}"; do
  name="$(basename "$f")"
  case "$name" in
    *[!A-Za-z0-9._-]*|'') echo "跳过非法单元名：$name" >&2; continue ;;
  esac
  got="$WORKDIR/got"
  exp="$WORKDIR/exp"
  if ! manifest_fp "$name" >"$exp"; then
    echo "拒绝未登记单元：$name（特权行要改就改钩子里的 manifest 再装钩子）" >&2
    rejected=$((rejected + 1))
    continue
  fi
  privilege_fp "$f" "$name" >"$got"
  if ! cmp -s "$got" "$exp"; then
    echo "拒绝特权行漂移：$name" >&2
    echo "  仓内：$(tr '\n' '|' <"$got")" >&2
    echo "  登记：$(tr '\n' '|' <"$exp")" >&2
    rejected=$((rejected + 1))
    continue
  fi
  dest="$DEST/$name"
  if [[ -f "$dest" ]] && cmp -s "$f" "$dest"; then
    continue
  fi
  install -m 644 "$f" "$dest"
  changed+=("$name")
done

if [[ ${#changed[@]} -gt 0 && "$TEST_MODE" -eq 0 ]]; then
  systemctl daemon-reload
  for name in "${changed[@]}"; do
    case "$name" in
      *.timer)
        systemctl try-restart "$name" >/dev/null 2>&1 || true
        ;;
    esac
  done
fi

if [[ ${#changed[@]} -gt 0 ]]; then
  echo "上机 ${#changed[@]} 个单元：${changed[*]}"
fi
if [[ "$rejected" -gt 0 ]]; then
  echo "拒绝 $rejected 个单元（特权行对不上或未登记）" >&2
fi
