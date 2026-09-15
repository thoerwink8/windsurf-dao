#!/usr/bin/env bash
# 样本 1：内联代码里含 `$`，外壳先展开一轮 —— 2026-09-13 实咬的原形。
# 判据（`$/` 行尾锚点）在到达 node 之前就被 bash 吃掉了，命令仍 exit 0、输出仍像模像样。
head=$(git rev-parse HEAD)
node -e "const m=/@e([0-9a-f]{12})$/.exec('$head'); console.log(m)"

# 样本 2：`${...}` 形状，一样先展开。
node -e "console.log(process.env.${HOME})"
