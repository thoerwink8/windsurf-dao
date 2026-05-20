---
trigger: always_on
description: 命令执行的安全性——超时/防卡/交互黑名单/服务命令/PowerShell 假错/SSH 嵌套引号防爆/Inline 长命令陷阱。运行 run_command / shell / PowerShell / Bash / SSH 远程时遵守
---

# Shell · 终端命令安全

> 慎终如始，则无败事。

## 终端安全总则（四原则·动手前必过）

- **非交互**：git 加 `-m` / `--no-edit` / `--no-pager`
- **有超时**：`-m 30` / `-TimeoutSec 15` / `timeout 15s`
- **有界限**：`git log -n 20` / `head -n 50`
- **非阻塞**：耗时 > 30s 用 `Blocking=false` + `WaitMsBeforeAsync=15000`

## 交互命令黑名单（业界共识·会触发 PTY 死锁）

agent 用 wrapper 跑命令时检测不到 fd 等待 stdin 就**永远挂死**。以下命令默认禁用，必须用非交互替代：

| 黑名单 | 非交互替代 |
|---|---|
| `sudo` / `su` / `passwd` | 提前配 NOPASSWD 或让用户手动跑 |
| `apt install` / `dnf install` | `apt install -y` + `DEBIAN_FRONTEND=noninteractive` |
| `git push`（SSH 密码） | 用 ssh-agent 或 HTTPS + token |
| `vim` / `nano` / `emacs` | `edit` 工具改文件，不开编辑器 |
| `less` / `more` / `man` / `top` / `htop` | `cat` / `head -n N` / `--help` |
| `mysql` / `psql`（交互模式） | `mysql -e "SQL"` / `psql -c "SQL"` / `< file.sql` |
| `npm init` / `yarn init`（向导） | `npm init -y` 或写 package.json |
| `gh repo create`（向导） | `gh repo create name --public --confirm` |

## 服务/长进程命令（必 Blocking=false + 必收尾）

`npm start` / `npm run dev` / `flask run` / `uvicorn` / `python -m http.server` / `php -S` 这类**永不退出**的进程：

1. **必 `Blocking=false`** + `WaitMsBeforeAsync=15000`（看 15s 内有没有早期错误）
2. **任务结束必收尾**：用 `command_status` 拿 PID → `Stop-Process -Id $PID` (Windows) / `kill $PID` (Unix)
3. **临时验证用**：套 `timeout 30 npm start` 强行限期，避免遗留
4. **永远不要**直接 `Blocking=true` 跑服务命令——会无限挂

## Inline 长命令陷阱（PowerShell 必踩）

PowerShell 处理 `node -e "..."` / `python -c "..."` **超过 ~300 字符**或含嵌套引号 `${...}` 时，会被 PSReadLine 截断/转义错误，命令卡住或行为异常。

**铁律**：内容 >300 字符 或 含模板字符串/反斜杠转义 → **写脚本文件**：

```powershell
# ❌ 错：长 inline 必卡
node -e "const fs=require('fs');const data=...(几百字符)...console.log(JSON.stringify(x))"

# ✅ 对：写到 _tmp/，跑完即删
"内容..." | Out-File -Encoding utf8 _tmp/probe.mjs
node _tmp/probe.mjs
Remove-Item _tmp/probe.mjs
```

## 环境变量批量降噪（一次性套入）

发现命令易卡时，先看是否能用环境变量降噪：

| 环境变量 | 作用 |
|---|---|
| `PAGER=cat` | 禁 less/man 分页（system prompt 已默认设置）|
| `GIT_PAGER=cat` | 禁 git 分页（log/diff/show） |
| `DEBIAN_FRONTEND=noninteractive` | 禁 apt/dpkg 配置向导 |
| `CI=true` | 让支持 CI 检测的工具走 batch 模式（npm/jest/playwright 等）|
| `NO_COLOR=1` | 禁 ANSI 颜色（避免输出乱码）|
| `TERM=dumb` | 极端降级，禁所有 TTY 特性 |

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

## 背景命令收尾铁律

`Blocking=false` 启动的后台进程**任务结束前必须收尾**，否则遗留僵尸进程：

```powershell
# 启动
$svr = run_command -CommandLine "node server.js" -Blocking $false
# ... 验证、测试 ...
# 收尾（无论成功失败都要）
Stop-Process -Id $svr.PID -Force -ErrorAction SilentlyContinue
```

不确定 PID → `command_status` 拿 → `Stop-Process` 兜底。**没收尾的后台进程 = 下次会话踩雷源**。
