#!/usr/bin/env bash
# 幂等安装 skills 装载面自愈 timer（#1146）。要 root：sudo bash scripts/install-skills-heal.sh
#
# 装两只钟：
#   dao-skills-heal.timer       User=orca，修自己够得着的家（通常 /home/orca；跑仓内脚本）
#   dao-skills-heal-root.timer  User=root，按 passwd 枚举本机每个有 .claude/ 的家
#                               （跑 /usr/local 下的安装副本；不钉 DAO_SKILL_HOMES）
# 2026-09-13 实咬：只有 orca 那只时，root 那份装载面被劫走后没人接，dao-check ㉚ 红了三天。
# 第三个用户的家 orca 同样够不着，全部目标由 root 那只接。只有 .mirasim/ 的家不纳入。
# 详见 scripts/lib/skill-homes.mjs 文件头。
#
# 不 chmod 仓内任何东西：可执行位归 git 记（100755）。装机时再 chmod 会把工作树弄脏，
# 而主树同步走的是 merge --ff-only——脏树直接 Aborting，同步从此停摆（2026-09-05 实咬）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"
HEAL_LIB="/usr/local/lib/dao-skills-heal"

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：sudo bash $0" >&2
  exit 1
fi

# 脚本可能长在 worktree 里（有人直接 `bash .claude/worktrees/x/scripts/install-skills-heal.sh`），
# 而装载面的链接必须指**活得比会话久**的那棵树：worktree 删了就全悬空。
#
# 主树怎么反查：全手工读 .git，不 shell git——`git worktree list` 会在两处栽跟头
# （2026-09-13 实咬）：① 以 root 跑时装机源常在 orca 的仓里，git 直接
# `dubious ownership` 拒答；② safe.directory 的通配 `*` 在 git 2.43 上不跨 `/`，
# `/srv/projects/windsurf-dao/*` 盖不到 `.claude/worktrees/<名>`。
# 布局是死的：worktree 的 `.git` 是文件（`gitdir: <主仓>/.git/worktrees/<名>`），
# 那目录里的 commondir 指回主仓的 `.git`，它的父目录就是主树。
main_tree_of() {
  local wt="$1" gitent gitdir common
  gitent="$wt/.git"
  [[ -f "$gitent" ]] || return 1                 # 不是 worktree（.git 是目录 = 它自己就是主树）
  gitdir="$(sed -n 's/^gitdir: *//p' "$gitent" | head -n 1)"
  [[ -n "$gitdir" ]] || return 1
  [[ "$gitdir" = /* ]] || gitdir="$wt/$gitdir"
  common="$(cat "$gitdir/commondir" 2>/dev/null)" || return 1
  [[ -n "$common" ]] || return 1
  [[ "$common" = /* ]] || common="$gitdir/$common"
  # resolve 到绝对、去尾斜杠：common 就是主仓的 .git，它父目录是主树
  (cd "$common" 2>/dev/null && printf '%s' "$(cd .. && pwd)")
}
MAIN_TREE="$(main_tree_of "$ROOT" || true)"
if [[ -n "$MAIN_TREE" && "$MAIN_TREE" != "/" && -d "$MAIN_TREE/host/machine/systemd" ]]; then
  if [[ "$MAIN_TREE" != "$ROOT" ]]; then
    echo "注意：脚本在 $ROOT，装载面按主树 $MAIN_TREE 接（worktree 一删链接就悬空）" >&2
  fi
  ROOT="$MAIN_TREE"
  UNIT_DIR="$ROOT/host/machine/systemd"
fi
for f in "$ROOT/scripts/skills-heal.mjs" "$UNIT_DIR/dao-skills-heal.service" "$UNIT_DIR/dao-skills-heal-root.service"; do
  [[ -f "$f" ]] || { echo "装机源不在：$f（这个目录不是本仓的 checkout？）" >&2; exit 1; }
done

# ── orca 那只：跑仓内脚本（User=orca，仓内脚本可写但不提权）──
install -m 644 "$UNIT_DIR/dao-skills-heal.service" /etc/systemd/system/dao-skills-heal.service
install -m 644 "$UNIT_DIR/dao-skills-heal.timer" /etc/systemd/system/dao-skills-heal.timer

# ── root 那只：跑 root 自有目录里的安装副本 ──
# 以 root 解释仓内脚本等于给每个能写仓的执行体一条 root 通道；所以副本落在
# /usr/local/lib（root 755），与 dao-execution-usage-export 同一条安全前提。
# 只装它要的两份，余下靠相对 import 解析不出仓外的东西（skills-mount 与
# onboard-check/dao-memory-link-check 是它的依赖，一并装）。
install -d -o root -g root -m 755 "$HEAL_LIB" "$HEAL_LIB/lib"
install -o root -g root -m 644 "$ROOT/scripts/skills-heal.mjs" "$HEAL_LIB/skills-heal.mjs"
for f in skills-mount.mjs skill-homes.mjs onboard-check.mjs dao-memory-link-check.mjs; do
  install -o root -g root -m 644 "$ROOT/scripts/lib/$f" "$HEAL_LIB/lib/$f"
done
install -m 644 "$UNIT_DIR/dao-skills-heal-root.service" /etc/systemd/system/dao-skills-heal-root.service
install -m 644 "$UNIT_DIR/dao-skills-heal-root.timer" /etc/systemd/system/dao-skills-heal-root.timer
# 仓根按实际路径写进单元（模板里写的是本仓默认路径）：换目录克隆时手改单元必漏
# （判例 memory hand-typed-constant-will-be-wrong），装的时候现算一次最省事。
# 改不到就报错退出——静默留着错的仓根，单元会一直对空气建链。
grep -q '^Environment=DAO_REPO_ROOT=' /etc/systemd/system/dao-skills-heal-root.service \
  || { echo "dao-skills-heal-root.service 里没有 DAO_REPO_ROOT 行，装法与本脚本对不上" >&2; exit 1; }
sed -i "s#^Environment=DAO_REPO_ROOT=.*#Environment=DAO_REPO_ROOT=$ROOT#" /etc/systemd/system/dao-skills-heal-root.service

systemctl daemon-reload
systemctl enable --now dao-skills-heal.timer dao-skills-heal-root.timer

# 装完必须验「有没有下一次触发」，不是验「在不在册」：只显示 active+enabled 的 timer
# 也可能已经进了 active(elapsed) 死态，永不再跑而无人报警。NEXT 为空就当场报错退出。
# 两只钟都要验——只验一只的话第二只死了没人知道（正是这次要堵的洞）。
#
# enable --now 之后 systemd 填 NextElapseUSecRealtime 有几百毫秒的延迟，紧接着读会读到空串
# 而误判「没装上」（2026-09-13 实咬：单元明明已 armed，脚本报「缺 OnCalendar」谎报失败）。
# 所以先等它填上，等到超时才判红。
arm_next() {
  local unit="$1" next="" i
  for i in $(seq 1 20); do
    next="$(systemctl show "$unit" -p NextElapseUSecRealtime --value 2>/dev/null || true)"
    case "$next" in ''|0|n/a|infinity) sleep 0.25 ;; *) printf '%s' "$next"; return 0 ;; esac
  done
  printf '%s' "$next"
  return 1
}
for unit in dao-skills-heal.timer dao-skills-heal-root.timer; do
  if ! next="$(arm_next "$unit")"; then
    echo "装上了但没有下一次触发（单元缺 OnCalendar？）：$unit（读到 '$next'）" >&2
    exit 1
  fi
done

# 立即各跑一次：光装上不等于接得上（副本里少一个依赖文件也照样 list-timers 绿）。
# 被劫是它该修的状态，修完 oneshot 仍是 Result=success / ExecMainStatus=0；
# 缺依赖、脚本非零才是失败——任一失败就点名退出，不许再印 installed。
start_oneshot() {
  local unit="$1" result="" status=""
  if ! systemctl start "$unit"; then
    result="$(systemctl show "$unit" -p Result --value 2>/dev/null || echo unknown)"
    status="$(systemctl show "$unit" -p ExecMainStatus --value 2>/dev/null || echo unknown)"
    echo "启动失败：$unit（Result=$result ExecMainStatus=$status）——副本缺依赖或脚本非零退出，不能报 installed" >&2
    exit 1
  fi
  result="$(systemctl show "$unit" -p Result --value 2>/dev/null || echo unknown)"
  status="$(systemctl show "$unit" -p ExecMainStatus --value 2>/dev/null || echo unknown)"
  if [[ "$result" != success ]] || [[ "$status" != 0 ]]; then
    echo "启动失败：$unit（Result=$result ExecMainStatus=$status）——副本缺依赖或脚本非零退出，不能报 installed" >&2
    exit 1
  fi
}
start_oneshot dao-skills-heal.service
start_oneshot dao-skills-heal-root.service

systemctl list-timers --all --no-pager | grep -E 'dao-skills-heal(-root)?\.timer' || true
echo "installed dao-skills-heal.timer + dao-skills-heal-root.timer（两只都有下一次触发）"
echo "验：dao-check ㉚ 对每个有 .claude/ 的家目录都必须绿（只有 .mirasim/ 的家不纳入；判据 scripts/lib/skill-homes.mjs）"

