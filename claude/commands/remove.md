---
description: 标记删除当前会话（再按 /clear 即彻底丢弃、不可 resume）
allowed-tools: Bash(node:*)
---

!`node "D:/frank/windsurf-dao/claude/hooks/remove-mark.js"`

上面已把当前会话标记为「删除」。现在请按 **`/clear`** 开新会话——切换的瞬间这条会话的记录会被自动删除，不可 `/resume`。

（只需告诉用户「已标记，按 /clear 即可丢弃」，不要做其它操作。）
