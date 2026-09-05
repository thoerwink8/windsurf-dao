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

# 每一轮都重接家目录，不只是「有新提交时」：skill 链接、pi 扩展、全局约定的落点在
# ~/.claude 和 ~/.pi，不在仓里，git pull 到了不等于生效；而它们也会因为跟提交无关的原因断
# （手改、删了 skill 没删链接、装别的东西覆盖）。onboard 幂等，没漂移时什么都不做。
# 2026-09-05 实咬：ask-gate skill 合进 master、服务器 5 分钟就拉到了代码，但
# ~/.claude/skills 下没有它的链接，服务器 dao-check 当场红（server-check ⑪ 跟着红），
# 而没有任何东西会自己把它接上——同一轮还查出 pi 扩展和全局约定各漂了一处。
# 安静地绿：没漂移不出声，免得 5 分钟一行把 journal 冲掉；动了手或没跑成才打日志。
# 报警面不在这儿，在 dao-check 的 skill 发现面硬闸——这里只负责修，不负责发现。
relink() {
  local out rc n
  set +e; out=$(cd "$REPO" && node scripts/onboard.mjs 2>&1); rc=$?; set -e
  if [ "$rc" -ne 0 ]; then
    echo "家目录接线：onboard 没跑成（退出码 $rc）——家目录可能还停在旧码上，去看 dao-check 的 skill 发现面"
    echo "$out" | tail -n 5
    return 0
  fi
  n=$(echo "$out" | grep -c '\[修\]' || true)
  if [ "$n" -gt 0 ]; then
    echo "家目录接线：补了 $n 处漂移"
    echo "$out" | grep '\[修\]'
  fi
}

# 错误落 mktemp，不写固定的 /tmp/dao-sync.err：2026-09-05 单元从 root 改成 orca 之后，
# 那个固定名字还是上一轮 root 建的、orca 写不进去，重定向失败让整个 if 判成「合并失败」——
# 于是每一轮都报「主树无法快进」，同步实际停摆，而单元照样 exit 0 看着一切正常。
ERRF=$(mktemp -t dao-sync.XXXXXX)
trap 'rm -f "$ERRF"' EXIT

before=$(g rev-parse HEAD)
g fetch -q --prune origin
if ! g merge -q --ff-only origin/master 2>"$ERRF"; then
  echo "主树无法快进（本地有未推提交或与远端发散），不动：$(head -c 200 "$ERRF")"
  relink
  exit 0
fi
after=$(g rev-parse HEAD)
if [ "$before" = "$after" ]; then
  echo "已是最新 ${after:0:7}"
  relink
  exit 0
fi
echo "主树 ${before:0:7} → ${after:0:7}"
if g diff --name-only "$before" "$after" | grep -qE "$BOT_PATHS"; then
  # try-restart：只重启「正在跑」的——故意停着的机器人不被拉起，单元缺失也不炸（审官疑问 2）
  sudo -n /usr/bin/systemctl try-restart feishu-triage || echo "机器人重启没成（单元缺失或没权限），代码已更新、进程还跑旧码"
  echo "飞书机器人代码有变，已请求重启让它吃到新码"
fi
relink
