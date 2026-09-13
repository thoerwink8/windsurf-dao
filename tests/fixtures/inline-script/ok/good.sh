#!/usr/bin/env bash
# 样本：判据不经过外壳的引号层 —— 单引号里没有 `$`，或代码写进文件再跑。
# 这几种都不该报：报了就是「红得没有道理」，红得没道理的闸最后一定被关掉。
node /tmp/verify.mjs
node -e 'process.stdout.write("N"+Date.now())'
git log -1 --format='%h %s'
node -e "process.stdout.write('ok')"
python3 -c 'import sys; print(len(sys.argv))'
printf 'DIROK\t%s\n' "$d" >/dev/null   # 变量放进 printf 的**参数**里，不放进引号层的判据里

