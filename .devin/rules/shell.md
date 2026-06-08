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
- **项目流程优先**：改动要生效到插件/客户端/服务时，先读项目根规范（`AGENT_GUIDE.md` / `README` / `package.json scripts` / `ship.*`），执行项目封装的验证/打包/安装脚本；通用 `typecheck` 只作为代码检查证据

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

## 项目本地发布流程优先

用户问“装了吗 / 升级了吗 / 生效了吗”时，判据是项目定义的发布链路完成，而非单个类型检查或构建命令完成。

执行顺序：
1. 读项目根规范入口：`AGENT_GUIDE.md`、`README*`、`package.json` scripts、`ship.*`、`Makefile`、`justfile`。
2. 找到封装脚本后优先执行它，例如 VS Code/Windsurf 插件常见链路是 `build → package → install → sync workbench/script hash → clean old version`。
3. 面向用户的功能新增按项目版本规则 bump；版本号、安装目录、VSIX 文件、同步 hash 是完成证据。
4. 单独 `npm run typecheck`、`npm run build`、`tsc --noEmit` 属于局部验证证据，不能替代安装/发布证据。
5. 发布脚本输出要求完整读取，最终报告包含版本、产物路径、安装路径、同步结果、退出码。

## Inline 长命令陷阱（PowerShell 必踩）

PowerShell 处理 `node -e "..."` / `python -c "..."` **超过 ~300 字符**或含嵌套引号 `${...}` 时，会被 PSReadLine 截断/转义错误，命令卡住或行为异常。

**铁律**：内容 >300 字符 或 含模板字符串/反斜杠转义 → **写脚本文件**。

落点选择：
- 文件工具可写：优先写项目内非 `.gitignore` 路径
- 文件工具提示 `prohibited` / gitignored：不要硬写 `_tmp/`，改用 `apply_patch` / `edit`，或请求批准后写 `$env:TEMP`
- Windows PowerShell 禁止 Bash heredoc（如 `python - <<'PY'`），必须用 here-string + `Set-Content`

```powershell
# ❌ 错：长 inline 必卡
node -e "const fs=require('fs');const data=...(几百字符)...console.log(JSON.stringify(x))"

# ✅ 对：写到 _tmp/，跑完即删
"内容..." | Out-File -Encoding utf8 _tmp/probe.mjs
node _tmp/probe.mjs
Remove-Item _tmp/probe.mjs
```

若 `_tmp/` 被文件工具禁止写入，不代表终端不可写；它代表该路径被工具安全层过滤。此时不要反复重试同一路径，按 `dao-terminal-resilience` 的 C12 降级。

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
- **关键验证命令自带路径锚点**：跨 workspace 或刚发生终端异常时，优先用 `git -C <repo>`、`pnpm --dir <repo>`、`npm --prefix <repo>`，不要只依赖 `Cwd` 或 shell 当前目录
- **禁止并行跑同一终端敏感验证**：测试、typecheck、install、build 这类会产生大量 stdout/stderr 的命令串行执行；并行只用于短小只读命令，避免输出串线导致假结论
- **验证输出加唯一 marker**：关键验证用 `BEGIN/EXIT=$LASTEXITCODE` 包裹；若 marker 缺失或输出来自错误目录，判定为终端感知异常，不判定业务失败
- **禁止 Bash heredoc 幻觉**：PowerShell 中 `python - <<'PY'` 会被当作重定向/比较符解析并报 `ParserError`；用 here-string 写临时脚本
- **工具失败熔断**：同一编辑工具/同一文件连续失败 2 次，立即停手换策略，不得第三次盲试

```powershell
Write-Output 'VERIFY_BEGIN'
pnpm --dir "d:\path\project" test:run -- --reporter=dot
Write-Output "VERIFY_EXIT=$LASTEXITCODE"
exit $LASTEXITCODE
```

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

## 后台命令静默/幽灵运行判定

`Blocking=false` 后 `command_status` 连续返回 RUNNING 且无输出时，按 C7/C9 处理：

1. 读取一次 `command_status`，保留命令 ID 和当前输出。
2. 用有界只读命令查目标进程，查询条件包含脚本名、项目名、产物名；避免被 MCP/npm 噪声淹没。
3. 同时检查项目产物状态：版本号、VSIX/构建文件时间、安装目录、日志文件。
4. 若 OS 进程缺席且产物无变化，判为 wrapper 幽灵后台；重新以同一项目流程启动一次，并立即读取输出。
5. 若 OS 进程存在或产物持续变化，判为真实长任务；继续定期读取，不重复启动同一流程。

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
