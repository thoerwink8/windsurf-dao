---
name: shell-backtick-executes-node-eval
description: bash 里用双引号包 node -e 脚本，脚本内的反引号会被 shell 当命令替换真执行——改文件用 Edit 或单引号包
metadata:
  type: feedback
---

在 Bash 工具里写 `node -e "…"` 时，双引号内的**反引号会被 shell 先做命令替换**：脚本里所有 `` `…` `` 的内容
被当成命令跑掉，然后替换成它们的输出（多数是空），再交给 node。后果有两层：

1. **写出去的文本被掏空**——我用它给 PR 正文做替换，所有反引号包的路径、文件名全变成空串，
   正文里出现「原始事件流已入仓（，3 条 tool_use 在第 8/15/20 行）」这种句子。
2. **真的执行了任意命令**——2026-08-15 那次，被替换掉的内容里有一条
   `node ~/.claude/skills/dao-mode/hooks/dao-mode.mjs park --what "..."`，它跑成功了、没报错、
   悄悄往 `~/.claude/state.json` 写进一条 `what: "..."` 的垃圾暂存。屏面上全是 `command not found`，
   成功的那条反而一声不吭，所以第一眼判断成了「都失败了，无副作用」。

**Why**：反引号是 POSIX 命令替换语法，双引号不阻止它；报错刷屏时，静默成功的那条最容易被漏看。

**How to apply**：
- 改文件内容一律用 Edit / Write 工具，不要用 `node -e` 拼字符串替换——工具不经 shell。
- 非要在 shell 里跑 node 脚本：把脚本写成文件再 `node file.mjs`，或用**单引号**包 `node -e '…'`。
- 大量 `command not found` 刷屏之后，别只看报错：回头核对这段脚本可能触及的**状态文件**有没有被写脏
  （[[report-requires-fresh-state]] 同理——凭印象判断副作用会被抓）。
