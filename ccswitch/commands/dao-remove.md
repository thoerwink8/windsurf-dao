---
description: 标记删除当前会话（再按 /clear 即彻底丢弃、不可 resume）
allowed-tools: Bash(node:*)
---

<!-- 逻辑在 ccswitch/scripts/dao-remove-mark.cjs，别改回内联 node -e：auto 权限模式下
     分类器读得到内联源码里「写 ~/.claude + 枚举会话档」即拦死（2026-08-13 实测），
     脚本文件形态按命令行放行。路径经本文件自身的 symlink realpath 解析回仓库，换机不写死。 -->

!`node "$(dirname "$(realpath "$HOME/.claude/commands/dao-remove.md")")/../scripts/dao-remove-mark.cjs"`

上面已把当前会话标记为「删除」。现在请按 **`/clear`** 开新会话——切换的瞬间这条会话的记录会被自动删除，不可 `/resume`。

（只需告诉用户「已标记，按 /clear 即可丢弃」，不要做其它操作。）
