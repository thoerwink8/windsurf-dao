---
name: bash-path-conv-breaks-slash-text
description: Git Bash 的 MSYS 路径转换会把以 / 开头的 --text 参数改写成 Windows 路径，发 /rename 等斜杠命令必须走 PowerShell
metadata: 
  node_type: memory
  type: reference
  originSessionId: d702bd60-19b9-4036-9ffc-973a75a4c0c8
  modified: 2026-08-15T16:36:25.691Z
---

2026-08-16 实测：在 Bash 工具里跑

```
orca terminal send --terminal <handle> --enter --text '/rename 帅·B｜空闲'
```

终端收到的是 `C:/Program Files/Git/rename 帅·B｜空闲`——MSYS2 把任何看起来像 POSIX 绝对路径的参数（以 `/` 开头）自动转成 Windows 路径，单引号也挡不住，这是 shell 传参层的转换，不是引号问题。

改用 PowerShell 工具跑同一条命令，文本原样送达，标题即时更新。

**How to apply:** 凡是要把**斜杠开头的文本**当参数传给外部程序（`/rename`、`/clear`、`/model` 这类 CC 斜杠命令，或任何 `/xxx` 字面量），一律走 PowerShell 工具，不走 Bash。非要用 Bash 就前置 `MSYS_NO_PATHCONV=1`（未在本机验证）。症状很好认：目标程序收到的文本前面多出 `C:/Program Files/Git/`。相关：[[cc-session-name-terminal-title]]（帅位自维护标题要反复发 `/rename`，是本坑的高频触发点）、[[shell-backtick-executes-node-eval]]（同属 Bash 传参层改写文本的坑）。
