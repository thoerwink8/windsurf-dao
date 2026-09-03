#!/usr/bin/env bash
# 服务器主树跟上 origin/master，并让常驻机器人吃到新代码（落地清单第 9 步）。
# 2026-09-04 实咬：总控群对话的 PR 合了，飞书机器人进程还跑着旧码——「合并了」≠「生效了」。
# 由 dao-sync.timer 每 5 分钟跑一次（root；git 动作全部以 orca 身份执行）。幂等：没新提交就什么都不做。
set -euo pipefail
REPO=/home/orca/windsurf-dao
BOT_PATHS='^(scripts/feishu-triage\.mjs|scripts/lib/feishu-triage-core\.mjs|scripts/lib/plain-words\.mjs|host/skills/feishu-triage/)'

g() { sudo -u orca git -C "$REPO" "$@"; }

before=$(g rev-parse HEAD)
g fetch -q --prune origin
if ! g merge -q --ff-only origin/master 2>/tmp/dao-sync.err; then
  echo "主树无法快进（本地有未推提交或与远端发散），不动：$(head -c 200 /tmp/dao-sync.err)"
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
  systemctl try-restart feishu-triage || echo "机器人重启没成（单元缺失或没权限），代码已更新、进程还跑旧码"
  echo "飞书机器人代码有变，已请求重启让它吃到新码"
fi
