# console-utf8.ps1 — PowerShell **消费侧**的 stdout 解码钉子（dot-source 用）
#
# 一行动作在文件末尾，上面全是判据。别把这一行复制到各处 —— 副本必漂移，而这条规则
# 的射程正在长（本文件 2026-08-05 由 issue #131 立，当时只有一个生产侧脚本钉了 UTF-8）。
#
# ── 治的是什么病 ─────────────────────────────────────────────────────────────
# PS 5.1 捕获**子进程** stdout 时（`$out = & powershell ...`、`& <native>` 的返回值），
# 用 `[Console]::OutputEncoding` 解码，而这个值默认跟着**控制台代码页**走
# —— 中文 Windows 的默认是 CP936。
#
# 与此同时，本仓生产侧已经有脚本**把自己的 stdout 钉成 UTF-8**：
# `ccswitch/scripts/check-clauses-structure.ps1` 开头那行
# `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`（2026-08-01 加，为的是让
# node 消费方 `execFileSync(..., {encoding:'utf8'})` 读得对 —— **那个修法是对的，别去动它**）。
#
# ⇒ **生产侧钉了 UTF-8，消费侧跟着控制台走**：两边只在控制台恰好是 65001 时才对得上。
#   对不上的时候，捕获到的中文是乱码 ⇒ 所有 `-match '<中文>'` 断言不命中 ⇒ 测试红，
#   **而红的报文与退出码全都指向被测对象，没有任何东西指向控制台**。
#
#   issue #131 实测（同一份代码、同一个被测对象、同一台机器）：
#     tests/clause-structure.tests.ps1   CP936 → EXIT=1 / 51 FAIL
#                                        CP65001 → 155 passed / 0 / EXIT=0
#   51 条 FAIL 全部同因，无一是真问题。它至今没被发现，是因为跑它的那个控制台恰好是 65001。
#
# ── 为什么钉消费侧，而不是把生产侧那一钉拆掉 ─────────────────────────────────
# 生产侧那一钉是为 node 消费方服务的，拆掉等于把 node 那半重新打坏（`�� 343������`）。
# 两类消费方要么都跟控制台走、要么都钉 UTF-8 —— node 侧已经钉了，PowerShell 侧跟上。
#
# ── 为什么不做成「入口统一注入」（issue #131 的方向 2）───────────────────────
# ~~那个方向假定有一个统一入口在起 PowerShell。**`scripts/run-tests.mjs` 并不起**~~
# **2026-08-08（issue #179）起这个前提为假**：`scripts/run-tests.mjs` 现在**代跑** `.ps1`
# （`powershell.exe -NoProfile -ExecutionPolicy Bypass -File <绝对路径>`，串行，`--env` 跑全部）。
# ~~更要紧的是：每套 `.ps1` 的头注都写着 `powershell -NoProfile -File tests/xxx.tests.ps1` 这个直跑跑法~~
# **那句话当时就是假的**（2026-08-08 实测坐实）：6 套里 **2 套压根没有跑法头注**
# （`link-codex.tests.ps1` / `link-codex-prompts.tests.ps1`，开头直接是代码），
# 另有 1 套（`pr-body-scan.tests.ps1`）记的是不带 `-ExecutionPolicy Bypass` 的那一版。
#
# **但结论不变，只是理由换了一个**：入口代跑之后仍然管不到**直跑的人**，而直跑正是这些
# 测试被设计成「独立可跑」的那一面（每套头注写着的第一件事就是它）。
# **编码是那份脚本自己的属性，不是调用方的属性** ⇒ 钉在脚本自己身上，直跑与经入口跑
# 才会得到同一个结果。**保留划线原句**：它是「为什么当初没走入口注入」的证据链一环，
# 删掉只会让下一个人重新发明一遍那个方向。
#
# ── 已知副作用，照直写（别读成「无副作用」）─────────────────────────────────
# `[Console]::OutputEncoding` 的 setter 会调 `SetConsoleOutputCP`，那是**整个控制台**的
# 设置而不是本进程的 ⇒ dot-source 之后，调用方所在控制台的代码页就变成 65001 了，
# 且进程退出后不会自己变回去。判为可接受的理由：方向是「变成 UTF-8」，且这正是生产侧
# 脚本每次跑 verify-all 时已经在做的事（**帅那台机器的控制台是 65001，很可能就是这么来的**
# —— 未确证，只是它与「恰好」相比是更省事的解释）。
# 「给子进程另开一个控制台」是唯一能完全不碰调用方的路子，**实测在 node `spawnSync` 下
# 走不通**（`start "<title>" /wait /min` 会挂在 start 上）—— 经过写在
# `tests/ps-console-encoding.tests.js` 头注，别再重走一遍。
#
# ── 射程边界 ─────────────────────────────────────────────────────────────────
# 只钉**解码/输出**这一侧。它不管 `Get-Content` 读无 BOM 文件那个坑（那是
# `[Text.Encoding]::Default`，**恒为本机 ANSI，与 chcp 无关**，实测两种代码页下都是 936）
# —— 判据见 `ccswitch/rules/dao-powershell.md` 第二条。两个坑长得像，处方不同，别混。
#
# try/catch：宿主没有可附着的控制台时赋值会抛（同生产侧那行的处理），那时保持默认即可。
# UTF8Encoding($false)：显式不要 preamble，免得任何框架版本在重定向流首吐一个 BOM。

try { [Console]::OutputEncoding = (New-Object System.Text.UTF8Encoding($false)) } catch { }
