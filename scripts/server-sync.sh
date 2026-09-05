#!/usr/bin/env bash
# 服务器主树跟上 origin/master，并让常驻机器人吃到新代码（落地清单第 9 步）。
# 2026-09-04 实咬：总控群对话的 PR 合了，飞书机器人进程还跑着旧码——「合并了」≠「生效了」。
# 由 dao-sync.timer 每 5 分钟跑一次，**以 orca 身份**（2026-09-05 安全修：原来是 root 解释这个
# orca 可写的脚本，等于给每个能写仓的 agent 一条 root 通道）。幂等：没新提交就什么都不做。
# 唯一要 root 的是重启飞书机器人，走 /etc/sudoers.d/dao-sync 里那一条写死的白名单。
set -euo pipefail
REPO=/home/orca/windsurf-dao
BOT_PATHS='^(scripts/feishu-triage\.mjs|scripts/lib/feishu-triage-core\.mjs|scripts/lib/plain-words\.mjs|host/skills/feishu-triage/)'

g() { git -C "$REPO" "$@"; }   # 本进程就是 orca，不再需要 sudo -u

# 错误落 mktemp，不写固定的 /tmp/dao-sync.err：2026-09-05 单元从 root 改成 orca 之后，
# 那个固定名字还是上一轮 root 建的、orca 写不进去，重定向失败让整个 if 判成「合并失败」——
# 于是每一轮都报「主树无法快进」，同步实际停摆，而单元照样 exit 0 看着一切正常。
ERRF=$(mktemp -t dao-sync.XXXXXX)
trap 'rm -f "$ERRF"' EXIT

before=$(g rev-parse HEAD)
g fetch -q --prune origin
if ! g merge -q --ff-only origin/master 2>"$ERRF"; then
  echo "主树无法快进（本地有未推提交或与远端发散），不动：$(head -c 200 "$ERRF")"
  exit 0
fi
after=$(g rev-parse HEAD)
if [ "$before" = "$after" ]; then
  echo "已是最新 ${after:0:7}"
  exit 0
fi
echo "主树 ${before:0:7} → ${after:0:7}"
if g diff --name-only "$before" "$after" | grep -qE "$BOT_PATHS"; then
  # try-restart：只重启「正在跑」的——故意停着的机器人不被拉起，单元缺失也不炸（审官疑问 2）
  sudo -n /usr/bin/systemctl try-restart feishu-triage || echo "机器人重启没成（单元缺失或没权限），代码已更新、进程还跑旧码"
  echo "飞书机器人代码有变，已请求重启让它吃到新码"
fi

# 拉到新码之后重接家目录：新加的 skill、改过的 pi 扩展、动过的全局约定，
# 光 git pull 是不会生效的——它们的落点在 ~/.claude 和 ~/.pi，不在仓里。
# 2026-09-05 实咬：ask-gate skill 合进 master、服务器 5 分钟就拉到了，
# 但 ~/.claude/skills 里没有它的链接，服务器 dao-check 当场红（server-check ⑪），
# 而没有任何东西会自己把它接上——每加一个 skill 就要人上服务器补一次。
# onboard 幂等，没漂移时只打一行「复查全绿」。
# 失败不阻断本轮（机器人吃新码更急），但要在 journal 里说清是「接了」还是「没接成」；
# 真正的报警面是 dao-check 的 skill 发现面硬闸，它红了 server-check ⑪ 就红。
if out=$(cd "$REPO" && node scripts/onboard.mjs 2>&1); then
  echo "家目录接线：已跑 onboard —— $(echo "$out" | tail -n 1)"
else
  echo "家目录接线：onboard 没跑成（退出码 $?），家目录可能还停在旧码上——去看 dao-check 的 skill 发现面"
  echo "$out" | tail -n 5
fi
