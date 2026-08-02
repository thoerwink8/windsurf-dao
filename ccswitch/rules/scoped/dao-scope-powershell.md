---
paths:
  - "**/*.ps1"
  - "**/*.psm1"
---

# 你正在碰 PowerShell 脚本

改动或新建 `.ps1` 之前，先 Read 全文：

`D:/frank/windsurf-dao/ccswitch/rules/dao-powershell.md`

那里是四条判据的正文（`$LASTEXITCODE` 判成败禁看 "error" 字样 / **`Get-Content` 任何形态**读
无 BOM 中文文件即毁内容（不只是那条管道，也不只是"写"的时候）/ 禁 PowerShell 里的 Bash heredoc /
inline 长命令超 300 字符改写脚本文件），
本文件**只是触发器，不复制正文**——副本会漂移。
