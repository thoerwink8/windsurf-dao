# 碰 shell 那一刻

**什么时候读**：你正要写或改一个 `*.ps1`，或者想知道「某条命令能不能跑、是谁拦的」。
Read 任何 `.ps1` 时，宿主会自动把这份手册送到眼前（靠 `ccswitch/rules/scoped/dao-scope-powershell.md`）。

⚠ **那个触发器只覆盖「改一个已存在的脚本」**：从零新建一个 `.ps1` 而全程没 Read 过任何 `.ps1` 时，
下面这几条一条都不会被送到眼前。别把「有触发器」读成「这几条现在有人管了」。

---

## 一、PowerShell 上会咬人的六件事

1. **判成败只看退出码，不看输出里有没有 "error"**：用 `$LASTEXITCODE`
   （`Start-Process -PassThru` 那条路用 `$proc.ExitCode`）。中文的「所在位置 行:X」是错误记录，不是真错。
   **禁 `2>&1`**——它把命令的 stderr 包成 `NativeCommandError`，在 `$ErrorActionPreference='Stop'` 下
   把**正常的进度行**（比如 cargo 的 Locking/Updating）判成终止性错误、中断整个脚本。
   要捕获输出就用 `Start-Process -RedirectStandardOutput/-RedirectStandardError` 落真实文件；
   只想消噪音用 `2>$null`。

2. **`Get-Content` 读无 BOM 的 UTF-8 文件时，中文内容当场就毁了**——**任何形态都毁**，
   含 `-Raw`、含只读不写。PS 5.1 会按本机 ANSI 代码页解码，**写侧再规范也救不回来**。
   连带一个更阴的静默失败：字符串已经成乱码之后，后续 `-replace '<含中文的模式>'`
   **一律不命中、不报错、退出码照样 0**（真实后果：PR 正文里的占位符原样留在了线上）。
   ⇒ 改文件内容一律用编辑工具；非用不可时读侧走 `[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8)`。
   写侧别用 `Set-Content -Encoding utf8`（它会写出带 BOM 的文件，弄坏 JSON/TOML 的消费方）。

3. **脚本文件自己也需要 BOM**——这是上一条的近亲但不是同一件事。
   无 BOM 的 UTF-8 `.ps1` 里含中文字符串时，PowerShell 的解析器会吐出**看起来随机的假语法错**，
   长得像代码坏了，会诱导你去改语法而不是查编码。
   判定：`Get-Content <文件> -Encoding Byte -TotalCount 3`，开头三字节是不是 `EF BB BF`。

4. **生产侧钉了 UTF-8，不等于你读得对**：PS 5.1 捕获**子进程** stdout 时按
   `[Console]::OutputEncoding` 解码，而这个值跟着**控制台代码页**走。两边只在控制台恰好是 65001 时才对得上；
   对不上时捕获到的中文是乱码、所有 `-match '<中文>'` 全部不命中，
   **而红的报文与退出码全都指向被测对象，没有任何东西指向控制台**。
   ⇒ 写会打中文、又会被别人捕获的脚本时，`. (Join-Path $PSScriptRoot '..\lib\console-utf8.ps1')`。
   ⚠ **这一条和第 2 条是两个坑，别混**：第 2 条走 `[Text.Encoding]::Default`（恒为本机 ANSI，与 `chcp` 无关），
   这一条跟着 `chcp` 走，处方也不同。

5. **调 `.ps1` 要拿退出码，一律 `powershell -File`，禁 `-Command "& '<脚本>'"`**：
   `-Command` 模式下只按「最后一条命令成不成」返回 0/1，**不透传脚本里的 `exit N`**。
   多态退出码（0/1/2/3 那种）的消费方拿到的是**被抹平的假值**——
   「跳过了几道」与「硬失败」在它眼里同码。**红了看得见的病是缺陷，绿没绿看不出来的病是失明。**

6. **超长的行内命令会被截断**：`node -e "..."` 超过约 300 字符或含嵌套引号，
   PowerShell 的行编辑器会把它截掉。写成脚本文件再跑。

## 二、三条通用的实操

- **路径锚点**：跨工作区或终端异常之后，用 `git -C <repo>` / `pnpm --dir <repo>` / `npm --prefix <repo>`，
  **不要只依赖当前目录**——工人的当前目录在两次调用之间会被重置。
- **验证加标记**：关键验证用 `VERIFY_BEGIN … VERIFY_EXIT=$LASTEXITCODE` 包起来；
  **标记缺失、或来自错误的目录 ⇒ 判为终端感知异常，不判业务失败**。
- **串行敏感**：测试 / 类型检查 / 安装 / 构建**串行跑**，并行只用于短的只读命令——
  并行时多路输出会串线，你读到的「全绿」可能来自另一条命令。

---

## 三、搜索与读文件：现在谁在拦什么

**判据一句话**：搜索内容用 **Grep**、找路径用 **Glob**、读文件用 **Read 的 `offset`/`limit`**；
不用 shell 里的 `grep` / `find` / `rg` / `sed` / `cat` / `head` / `tail` / `Select-String`。
理由：Grep 底层就是 ripgrep，跨平台、快、内存友好，且不吃 Windows 引号 / 转义 / 编码的亏。

**机器拦截此刻只剩一层**，就是宿主的权限规则 `permissions.deny`：

| 命令 | 有没有机器拦 |
|---|---|
| `grep` · `find` · `rg` · `ag` · `ack` · `Select-String` | **有**（`permissions.deny`） |
| `sed` · `cat` · `head` · `tail` · `awk` | **没有**——只有上面这句判据在管 |
| `ls` · `wc` · `Get-Content` | **没有，而且是刻意的**——内置工具给不出时间戳、权限位、字节计数，收进来是凭空造误伤 |

> 2026-08-12 之前还有第二层（一道 PreToolUse 硬闸，会在拦下时当场把该改用什么打进错误信息里）。
> 那道闸已随钩子精简退役，`sed`/`cat`/`head`/`tail` 因此**失去了它们唯一的机器拦截**。
> 要不要把它们收进 `permissions.deny`，是待用户拍板的一格。

**判据模型照直写**：`permissions.deny` 是**逐字前缀匹配**——它看不懂管道，也看不懂重定向。
所以 `cmd | grep x` 这种写法它拦不住，而那恰恰是最常见的用法。**别把「有一层 deny」读成「已经管住了」。**

🔴 **别相信上面那张表，去问机器**——覆盖面这种会变的事实，写在文档里就会静默过期。
两条复核路，都在 30 秒内跑得完：

1. **读 live 清单**（用 Read 工具读，别用 shell）：`~/.claude/settings.json` → `permissions.deny`。
   仓内的那份源在 `config-sync/common/settings.json`。
2. **最硬的一验：真去撞一次**。`grep -n "x" somefile` 收到宿主的权限拒绝
   （`Permission to use ... has been denied.`）⇒ 这一层还在；跑通了 ⇒ 护栏悄悄回退了，去查是不是切过 provider。

⚠ **live 那份是投影不是源**：真相源是 cc-switch 数据库里的 provider 配置，**切一次 provider 就整体覆盖一次**，
而且不吭声。所以「今天拦得住」不构成「明天也拦得住」。改它属于用户动作。

**一个已知的误伤**：提交信息或 PR 正文里，如果某一行恰好以 `grep` 之类的词开头，
经 heredoc 传给命令时会被当成「在跑那条命令」。**正路不是去绕它，是本来就该走的那条**——
正文落文件，再 `-F <文件>` / `--body-file <文件>`。理由和上面第 2 条一样：正文过任何 shell 字符串都会被静默改写。

---

## 四、改配置之前，先认清源与投影

**投影改了立即生效，但下次下发就被整体覆盖，而且没有告警。** 认源的动作是**追下发链**，
不是「找一个长得像源的文件」。已经踩到过三个面：钩子注册、`settings.json`、MCP 服务器清单
（`claude mcp add` 写的就是投影）。动过任何一层，同一个动作里跑一次漂移检测收尾并贴真退出码。
