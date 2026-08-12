# console-utf8.ps1 — 把本脚本的 stdout 解码钉成 UTF-8（dot-source 用）
#
# 治的病：PowerShell 5.1 捕获子进程 stdout 时按 `[Console]::OutputEncoding` 解码，
# 而这个值跟着控制台代码页走（中文 Windows 默认 CP936）。于是同一份代码、同一个被测对象、
# 同一台机器，控制台是 65001 就全绿、是 936 就大批 FAIL——**而红的报文与退出码全都指向
# 被测对象，没有任何东西指向控制台**。
#
# 已知副作用，照直写：这个 setter 改的是**整个控制台**的代码页，不是本进程的，
# 且进程退出后不会自己变回去。判为可接受——方向是「变成 UTF-8」。
#
# 射程只到解码/输出这一侧。它**不管** `Get-Content` 读无 BOM 文件那个坑
# （那一个走 `[Text.Encoding]::Default`，恒为本机 ANSI、与 chcp 无关）——
# 两个坑长得像，处方不同，别混。判据见 `ccswitch/rules/dao-shell.md`。
#
# try/catch：宿主没有可附着的控制台时赋值会抛，那时保持默认即可。
# UTF8Encoding($false)：显式不要 preamble，免得重定向流首吐一个 BOM。

try { [Console]::OutputEncoding = (New-Object System.Text.UTF8Encoding($false)) } catch { }
