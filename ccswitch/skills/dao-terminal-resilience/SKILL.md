---
name: dao-terminal-resilience
description: 终端/工具链卡死诊断与Agent五感降级恢复。当终端命令无响应、交互式prompt阻塞、连续工具调用失败、编辑工具反复失败、命令输出异常、或用户反馈"卡住了"时自动触发。
---

# 终端韧性术 · Terminal Resilience

> 上善若水。水善利万物而不争，处众人之所恶。

**与规则层的关系**：`ccswitch/dao.md` 「Shell · dao 独有项」段 是按场景触发的命令安全规则（动手前必过），本技能是诊断知识（工具链卡死模式+五感降级恢复链）。规则=何时检查，技能=如何恢复。

## 适用场景

- 终端命令无响应、超时
- 交互式 prompt 阻塞 Agent
- Edit 工具连续失败
- 终端脚本因 Shell 方言不匹配报解析错误
- 文件工具因 `.gitignore` / 权限限制无法写入目标临时路径
- 用户反馈"卡住了"
- 命令执行结果异常

## Agent 五感模型

Agent 通过五种感官与系统交互，每种感官有不同的可靠性：

| 感     | 域        | 可靠性 | 降级方案                     |
| ------ | --------- | ------ | ---------------------------- |
| 视(☲) | 搜索·读取 | ★★★★★  | 文件工具总返回，最可靠       |
| 听(☵) | 命令·终端 | ★★★☆☆  | 可能挂起，需超时保护         |
| 触(☳) | 编辑·写入 | ★★★★☆  | 文件写入可靠，终端写入有风险 |
| 嗅(☴) | 外部·网络 | ★★☆☆☆  | 依赖外部系统，需代理/超时    |
| 味(☶) | 计划·交互 | ★★★★★  | 内部能力，总可用             |

**核心原则**：文件工具(无状态,总返回) ≫ 终端(有状态,可能永久挂起)

## 工具链卡死模式

| 类型             | 症状              | 根因                        | 恢复                                 |
| ---------------- | ----------------- | --------------------------- | ------------------------------------ |
| C1 交互阻塞      | 命令等待键盘输入  | git/ssh/npm 的交互式 prompt | 加 `-m`/`--no-edit`/`--yes` 重试     |
| C2 Shell集成故障 | 命令发出无回响    | IDE shell integration 断开  | 新建终端重试                         |
| C3 无界递归      | 命令跑很久不返回  | 递归遍历大目录              | 用 Glob/Grep 替代 |
| C4 网络超时      | 网络请求挂起      | 无超时参数 / 需要代理       | 加超时 + 判断是否需代理              |
| C5 进程冲突      | 端口占用 / 锁文件 | 上一个进程未退出            | 查进程 → kill → 重试                 |
| C6 权限不足      | 操作被拒绝        | 文件/目录权限               | 检查权限 → 告知用户                  |
| C7 长任务误判    | 以为卡了其实在跑  | 命令确实需要很长时间        | 非阻塞模式 + 定期检查                |
| C8 大文件内存阻塞  | 命令发出后长时间无输出 | 内联加载 >1MB 文件到内存 | 写查询脚本到 `_tmp/`，`node` 执行后删除 |
| C9 目录/输出错位 | 命令声称在 A 项目执行，但输出来自 B 项目；并行命令回显互串 | shell 当前目录漂移、IDE shell integration 串线、并行 stdout/stderr 混流 | 串行重跑；命令自带路径锚点；加唯一 marker；不用该次输出判定业务失败 |
| C10 编辑工具卡死/反复失败 | Edit 工具连续 2 次失败，或同一文件匹配失败后仍重试 | 上下文锚点不稳、CRLF/不可见字符、工具语法误判、一次 patch 过大 | 立即停止同法重试；重读目标行；拆成单文件/单 hunk；优先用更小锚点或整文件重写；必要时让用户批准外部脚本 |
| C11 Shell 方言错配 | PowerShell 报 `ParserError`、`MissingExpressionAfterToken`，或 bash heredoc 语法失效 | 把 Bash 写法用于 PowerShell，如 `python - <<'PY'` | 改为 PowerShell 原生 here-string + `Set-Content`，或使用文件工具创建脚本；命令前先确认当前 OS/Shell |
| C12 临时文件落点被拒 | Write 工具提示 gitignored / prohibited，或临时脚本无法创建 | 文件工具不能写 `.gitignore` 覆盖路径；项目 `_tmp/` 被忽略 | 不再坚持该路径；改用非忽略的项目 scratch、系统临时目录（需命令批准），或直接用编辑工具；完成后清理 |

## 诊断协议（到第一个匹配停下）

```
1. 命令是否需要交互输入？ → C1 → 加非交互参数重试
2. 终端本身能响应吗？ → 否 → C2 → 切文件工具模式
3. 是否在遍历大目录？ → C3 → 用文件搜索工具替代
4. 是否涉及网络？ → C4 → 加超时 + 判断代理
5. 是否有进程冲突？ → C5 → 查进程状态
6. 是否权限问题？ → C6 → 检查并报告
7. 是否同一编辑方式连续失败 ≥2 次？ → C10 → 停止同法重试，切小 hunk/整文件/脚本委托
8. 是否在 PowerShell 中使用 Bash 写法？ → C11 → 改 PowerShell 原生写法
9. 临时文件路径是否被 `.gitignore` / 权限拒绝？ → C12 → 换落点或改工具
10. 是否在读取 >1MB 或二进制文件？ → C8 → 写脚本到可写临时路径
11. 输出路径、prompt、marker 是否与目标项目不一致？ → C9 → 路径锚定串行重跑
12. 以上都不是 → C7 → 非阻塞等待
```

## 发命令前必检清单

每条终端命令发出前，过以下 5 项：

1. **非交互**: 确保命令不会弹出等待输入的 prompt
2. **有超时**: 网络请求必须有超时参数
3. **有界限**: 禁止无界遍历，限制输出量
4. **非阻塞**: 耗时>30s 用非阻塞模式
5. **路径锚定**: 跨 workspace 或关键验证用 `git -C` / `pnpm --dir` / `npm --prefix`
6. **短且简**: 一次 3-6 条命令，禁止长管道
7. **方言匹配**: Windows PowerShell 禁用 Bash heredoc；复杂脚本先落文件
8. **失败熔断**: 同一工具/同一文件连续失败 2 次，必须换策略，不得第三次盲试

## Windows 编码诊断（C9 配套命令）

遇到中文乱码、测试快照变更、CLI 输出变问号、文件读写后编码漂移时，先采样，不要立刻全局改环境：

```powershell
$PSVersionTable.PSVersion
[Console]::InputEncoding.WebName
[Console]::OutputEncoding.WebName
chcp
$OutputEncoding.WebName
```

判断规则：

- Windows PowerShell 5.1 默认文本编码常不是 UTF-8，`Set-Content`/`Out-File`/重定向尤其要显式 `-Encoding UTF8`。
- PowerShell 7+ 默认更接近 UTF-8，但外部程序仍受 Console code page 和程序自身编码影响。
- Console code page `65001` 表示 UTF-8；输入和输出编码可独立影响 native 命令。
- 不要为修一个命令永久改用户系统设置；优先在当前进程或当前命令作用域设置。

当前会话 UTF-8 边界 + 常见运行时开关：

```powershell
[Console]::InputEncoding  = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding           = [Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null
$env:PYTHONUTF8 = '1'; $env:PYTHONIOENCODING = 'utf-8'
$env:LC_ALL = 'C.UTF-8'; $env:LANG = 'C.UTF-8'
```

## 非交互命令模板（C1 配套命令）

先关分页器、编辑器、凭据 prompt 和动态输出：

```powershell
$env:CI = '1'; $env:NO_COLOR = '1'
$env:GIT_TERMINAL_PROMPT = '0'; $env:GIT_PAGER = 'cat'; $env:PAGER = 'cat'
```

各工具非交互写法：

```powershell
# Git
git -c core.pager=cat -c credential.interactive=false status --short
git -c core.pager=cat commit -m "message"
git -c core.pager=cat merge --no-edit branch-name

# npm/pnpm/yarn
$env:npm_config_yes = 'true'
npm install --no-audit --no-fund --foreground-scripts=false
pnpm install --config.confirmModulesPurge=false

# Python/pip
python -X utf8 -m pip install --disable-pip-version-check --no-input package

# 网络请求必须设超时
Invoke-WebRequest -Uri $url -TimeoutSec 20
curl.exe --connect-timeout 10 --max-time 60 -L $url
```

## 降级路径

当终端不可用时，按以下顺序降级：

```
正常终端执行
  ↓ 失败
文件工具模式（Read/Edit/Write 替代终端）
  ↓ 编辑工具连续失败或文件工具受限
更小编辑单元 / 整文件重写 / 非忽略路径脚本
  ↓ 仍不够
脚本委托（写 .ps1/.sh/.py 脚本让用户执行，或请求批准在系统临时目录执行）
  ↓ 不够
用户指挥（告知"请做X"，不问"是不是Y"）
```

## 反模式

| 病       | 症                   | 治                            |
| -------- | -------------------- | ----------------------------- |
| 盲重试   | 同一命令反复执行     | 先诊断类型，再选恢复方案      |
| 不降级   | 终端不通还坚持用终端 | 立即切文件工具                |
| 无超时   | 网络命令不加超时     | 铁律：所有网络请求必须有超时  |
| 交互幻想 | 以为自己能输入       | Agent无法与交互式prompt对话   |
| 递归贪心 | 用终端遍历整个项目   | 用 Glob / Grep |
| 内联大文件 | PowerShell `ReadAllBytes` 加载 5MB 二进制 | 写 `_tmp/query.js` + `node _tmp/query.js` 、用后删除 |
| 目录幻觉 | `Cwd` 写了 A，但输出像 B | 用工具自带路径参数串行重跑，不信 shell prompt |
| 并行验错 | 并行 test/typecheck/install 后输出互串 | 关键验证串行 + marker + exit code |
| 编辑撞墙 | Edit 工具失败后继续用同样上下文重试 | 两次失败即 C10 熔断，重读目标行并换策略 |
| Bash 幻觉 | 在 PowerShell 里写 `python - <<'PY'` | 使用 PowerShell here-string 写临时脚本 |
| `_tmp` 执念 | 文件工具不能写 gitignored `_tmp/` 仍坚持 | 改可写非忽略路径或系统临时目录，必要时请求批准 |
