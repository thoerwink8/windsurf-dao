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

## 交互命令黑名单（PTY 死锁）

agent 检测不到 stdin 等待就**永远挂死**。禁用：`sudo/su/passwd`（配 NOPASSWD 或用户手动）、`apt/dnf install`（加 `-y` + `DEBIAN_FRONTEND=noninteractive`）、`git push` SSH 密码（用 ssh-agent/HTTPS+token）、`vim/nano/emacs`（用 edit 工具）、`less/more/man/top`（用 `cat`/`head -n N`/`--help`）、`mysql/psql` 交互（用 `-e`/`-c`/`< file.sql`）、`npm/yarn init` 向导（用 `-y`）、`gh repo create` 向导（加 `--confirm`）。

## 服务/长进程命令（必 Blocking=false + 必收尾）

永不退出的进程（`npm start`/`dev`/`flask run`/`uvicorn` 等）：必 `Blocking=false` + `WaitMsBeforeAsync=15000`；任务结束必 `command_status` 拿 PID → kill；临时验证套 `timeout 30`。**永不** `Blocking=true` 跑服务。

## 项目本地发布流程优先

用户问”装了吗/生效了吗” → 判据是**项目发布链路完成**，非单个 typecheck/build。先读根规范入口（AGENT_GUIDE/README/package.json scripts/ship.*），找到封装脚本优先执行。版本号+安装目录+产物路径+同步结果是完成证据；单独 `tsc --noEmit` 属局部验证，不能替代。

## Inline 长命令陷阱（PowerShell 必踩）

PowerShell 处理 `node -e "..."` / `python -c "..."` **超过 ~300 字符**或含嵌套引号 `${...}` 时，会被 PSReadLine 截断/转义错误，命令卡住或行为异常。

**铁律**：内容 >300 字符 或 含模板字符串/反斜杠转义 → **写脚本文件**。

落点选择：
- 文件工具可写：优先写项目内非 `.gitignore` 路径
- 文件工具提示 `prohibited` / gitignored：不要硬写 `_tmp/`，改用 `apply_patch` / `edit`，或请求批准后写 `$env:TEMP`
- Windows PowerShell 禁止 Bash heredoc（如 `python - <<'PY'`），必须用 here-string + `Set-Content`

例：❌ `node -e "..."` 超长必卡 → ✅ 内容写 `_tmp/probe.mjs` → `node _tmp/probe.mjs` → `Remove-Item`。若 `_tmp/` 被工具安全层禁止，改用 `$env:TEMP` 降级（不要反复重试同一路径）。

## 环境变量降噪

命令易卡时先降噪：`PAGER=cat`（禁分页）、`GIT_PAGER=cat`（禁 git 分页）、`DEBIAN_FRONTEND=noninteractive`（禁 apt 向导）、`CI=true`（batch 模式）、`NO_COLOR=1`（禁 ANSI）、`TERM=dumb`（极端降级）。

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

模板：`Write-Output 'VERIFY_BEGIN'; <验证命令>; Write-Output "VERIFY_EXIT=$LASTEXITCODE"; exit $LASTEXITCODE`

## SSH 远程命令防卡

三层超时：连接层 `ConnectTimeout=5`、命令层远端 `timeout <秒>`、执行层 `Blocking=false`。复杂命令首选 heredoc 落远端文件（禁反引号模板/`$()` 插值），SQL 用参数绑定 `?`，远端 `node -e` 用绝对路径 require。

## 后台命令收尾

`Blocking=false` 后 `command_status` 连续 RUNNING 无输出 → 查进程+产物（进程缺席+产物无变化 = 幽灵，重启一次；否则继续读取）。**任务结束前必须 kill 后台进程**（`Stop-Process -Id $PID`），否则遗留僵尸。
