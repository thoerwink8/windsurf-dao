---
trigger: model_decision
description: 命令执行的安全性——动手前必查超时/防卡/错误判断/PowerShell 假错陷阱/SSH 嵌套引号防爆。运行 run_command / 任何 shell 命令 / PowerShell / Bash / SSH 远程时读取，关注"怎么不卡死"
---

# Shell · 终端命令安全

> 慎终如始，则无败事。

## 终端安全总则（四原则·动手前必过）

- **非交互**：git 加 `-m` / `--no-edit` / `--no-pager`
- **有超时**：`-m 30` / `-TimeoutSec 15` / `timeout 15s`
- **有界限**：`git log -n 20` / `head -n 50`
- **非阻塞**：耗时 > 30s 用 `Blocking=false` + `WaitMsBeforeAsync=15000`

## Windows PowerShell 专项

踩坑血泪——Windows 硬规则：

- **禁用 `2>&1`**：假错源头。混合 stdout/stderr 后，所有 stderr 都被解读为错误
- **用 `$LASTEXITCODE` 判断成功**：不是看输出有没有 "error" 字样
- **stderr 噪音用 `2>$null` 抑制**：不要用 `2>&1` 重定向
- **中文"所在位置 行:X" 是 ErrorRecord，不是真错误**

## SSH 远程命令防卡

`run_command` + ssh + 嵌套引号 = 必炸的三件套。

**三层超时**：
1. 连接层：`-o ConnectTimeout=5 -o ServerAliveInterval=3 -o ServerAliveCountMax=2`
2. 命令层：远端命令用 `timeout <秒>` 包裹（如 `timeout 15 node /tmp/x.js`）
3. 执行层：`run_command` 用 `Blocking=false` + `WaitMsBeforeAsync=15000`

**复杂命令防转义**（PowerShell + ssh + JS/SQL 嵌套引号场景）：
- 首选 heredoc：`ssh srv "cat > /tmp/_q.js << 'SCRIPT' ... SCRIPT; node /tmp/_q.js"`
- heredoc 内禁反引号模板字符串、`$(...)` 插值、嵌套双引号——会被 PowerShell 第一层吃掉
- SQL 用参数绑定 `?`，不字符串拼接
- 远端 node `-e` 必须用绝对路径 require（如 `require('/root/projects/<proj>/server/node_modules/better-sqlite3')`）
