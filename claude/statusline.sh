#!/usr/bin/env bash
# Claude Code 状态栏 — 两行布局
# 行1: 会话名 · 目录 · git 分支
# 行2: 上下文进度条+已用% · token数 · 成本 · 总时长(API注解)
input=$(cat)

NAME=$(echo "$input"  | jq -r '.session_name // "—"')
DIR=$(echo "$input"   | jq -r '.workspace.current_dir')
PCT=$(echo "$input"   | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
IN_TOK=$(echo "$input"| jq -r '.context_window.total_input_tokens // 0')
SIZE=$(echo "$input"  | jq -r '.context_window.context_window_size // 200000')
COST=$(echo "$input"  | jq -r '.cost.total_cost_usd // 0')
DUR_MS=$(echo "$input"| jq -r '.cost.total_duration_ms // 0')
API_MS=$(echo "$input"| jq -r '.cost.total_api_duration_ms // 0')

CYAN='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; GRAY='\033[90m'; RESET='\033[0m'

# git 分支(可能不在仓库 / detached HEAD → 留空)
BRANCH=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH=$(git --no-optional-locks branch --show-current 2>/dev/null)
fi

# 钳制百分比 0..100,避免进度条算术越界
[ "$PCT" -gt 100 ] 2>/dev/null && PCT=100
[ "$PCT" -lt 0   ] 2>/dev/null && PCT=0

# 进度条按阈值变色
if   [ "$PCT" -ge 90 ]; then BAR_COLOR="$RED"
elif [ "$PCT" -ge 70 ]; then BAR_COLOR="$YELLOW"
else                         BAR_COLOR="$GREEN"; fi
FILLED=$((PCT / 10)); EMPTY=$((10 - FILLED))
printf -v FILL "%${FILLED}s"; printf -v PAD "%${EMPTY}s"
BAR="${FILL// /█}${PAD// /░}"

# token / 上限 取千位
TOK_K=$(awk "BEGIN{printf \"%.0f\", $IN_TOK/1000}")
SIZE_K=$(awk "BEGIN{printf \"%.0f\", $SIZE/1000}")
COST_FMT=$(printf '$%.2f' "$COST")

# 时长:总墙钟人性化,API 取秒
fmt_dur() {
  local s=$(( $1 / 1000 ))
  if   [ "$s" -ge 3600 ]; then printf '%dh%dm' $((s/3600)) $(((s%3600)/60))
  elif [ "$s" -ge 60   ]; then printf '%dm%ds' $((s/60)) $((s%60))
  else                         printf '%ds' "$s"; fi
}
TOTAL_FMT=$(fmt_dur "$DUR_MS")
API_S=$(awk "BEGIN{printf \"%.1f\", $API_MS/1000}")

printf '%b\n' "${CYAN}${NAME}${RESET}  📁 ${DIR##*/}${BRANCH:+  🌿 $BRANCH}"
printf '%b\n' "${BAR_COLOR}${BAR}${RESET} ${PCT}% ${GRAY}${TOK_K}k/${SIZE_K}k${RESET} · ${YELLOW}${COST_FMT}${RESET} · ⏱ ${TOTAL_FMT} ${GRAY}(API ${API_S}s)${RESET}"
