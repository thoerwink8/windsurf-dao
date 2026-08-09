# 「PS 分层标记」判定器：这个 .tests.ps1 的头部有没有一行**块注释之外**的
# `@dao-test-tier: env` 声明。唯一消费方是 `scripts/run-tests.mjs`
# （它是 node，问不到 PowerShell 的语法，故把这一问外包给本脚本）。
#
# ⚠ **本文件的头注刻意用 `#` 行注释而不是 `<# ... #>` 块注释**，理由是现场逮到的：
#   第一版用块注释写，正文里为了讲清楚判据而引用了一个闭合记号（连在一起的井号与大于号），
#   **那个记号当场把块注释关掉了** —— 其后十几行散文被 PowerShell 当成命令去执行，
#   `parse-errors` 却仍然是 0（那些散文碰巧是「合法但找不到的命令」）。
#   ⇒ 这既是本文件存在的理由的又一个实例，也是它自己必须避开的那个坑。
#
# ── 底座是 PowerShell 官方 parser，不是自写的记号扫描 —— 这一格已经翻过两次车 ──
#
#   · PR #200：旧版只锚「行首井号 + 标记名」，不问那一行是不是身处块注释内。
#     `.NOTES` 散文里一句描述句于是被当成真声明（**假阳性**：一套本该在默认层跑的
#     测试被静默摘出去，没人看得见）。
#   · PR #213：修法改成自写的开合记号扫描，**不认行注释、也不认字符串字面量**
#     ⇒ 一行「注释里提到开块记号」或一句 `$re = '<#'` 就把它后面的整段变成死区，
#     死区里的**真**标记一律失效（**假阴性**：一套带 `winget install` 的测试被悄悄
#     拉回默认层真的跑起来，同样没人看得见）。对抗实测：往 `tests/dao-pr-merge.tests.ps1`
#     第 2 行插一条语法完全合法的标记 ⇒ 不起作用，而 116 条回归断言一条都不红。
#
#   两次都是**近似判据补漏—再漏**：补得再细，下一个形态照样在射程外。**换底座才是解法**——
#   「这一行是不是块注释」本来就有唯一权威答案，那个答案属于 PowerShell 自己：
#   `[System.Management.Automation.Language.Parser]::ParseFile` 的 token 流里，
#   行注释与块注释是**两种不同的 Comment token**（块注释那种的 `Text` 以开块记号打头），
#   而 here-string / 字符串字面量 / 续行 一概不会被误认成注释。
#
#   ⚠ **它治的是「谁在块注释里」这一格，不治别的**：标记形态（行首井号 + `@dao-test-tier: env`）、
#   扫描窗口（头 N 行）两件仍是本仓的约定，parser 答不了，也不该由它答。
#
# ── 参数 ──────────────────────────────────────────────────────────────────────
#   -HeadLines <N>   只看头 N 行（由调用方传，真相源是 run-tests.mjs 的
#                    `TIER_MARKER_HEAD_LINES`）。标记是「文件级声明」，写在头注里；
#                    扫全文会把正文里提到这个标记的文字也算进来。
#   <路径> ...       要判定的文件，位置参数、可多个。**刻意走 argv 不走 stdin**：
#                    Windows 的命令行是 UTF-16 传进来的，不经任何代码页；而 stdin 要看
#                    `[Console]::InputEncoding`，那是台机器级设置（同
#                    `ccswitch/rules/dao-powershell.md` 第三条记的那个坑）。
#
# ── 输出 ──────────────────────────────────────────────────────────────────────
#   **一律纯 ASCII**（下面 Write-Output 的每一个字符都在 ASCII 内）—— 消费方是 node，
#   而 PS 5.1 写 stdout 时按 `[Console]::OutputEncoding` 编码、那个值跟着控制台代码页走。
#   只输出下标与数字就绕开了整格编码问题，不必去 dot-source `console-utf8.ps1`。
#
#       PSTIER_SCAN v1 head=<N> files=<M>
#       <idx> decl=<0|1> prose=<0|1> perr=<n|-1>
#       ...
#       PSTIER_SCAN_END
#
#   · decl  —— 头 N 行内有块注释之外、独占一行的标记 ⇒ 1
#   · prose —— 头 N 行内有标记字面量**落在块注释里** ⇒ 1。它不是声明，但**必须出声**：
#              「想标 env 却标进了块注释」与「随口写了一句散文」在盘上长得一模一样，
#              而前者的代价是那套测试被真的跑起来。消费方据此打一行警告。
#   · perr  —— parser 报的语法错误条数；`-1` = 这份文件压根没读成（消费方按「无声明」处理，
#              与它跑起来必然变红的既有行为一致）。**语法有错时 token 流仍是尽力而为的**，
#              故照常给判定 + 把错误条数摆出来，不假装没看见。
#
# ── 单跑 / 谁在验它 ───────────────────────────────────────────────────────────
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scan-ps-tier-marker.ps1 tests\a.tests.ps1
#   回归网 `tests/run-tests-tier.tests.js` 第 ⑪ 节黑盒验它的两个方向，第 ⑬ 节验
#   「它跑不起来时消费方 fail-closed 且出声」（注入口 `DAO_PS_TIER_SCANNER`）。

# `PositionalBinding = $false` 不是装饰：没有它，第一个**位置**参数会去填 `-HeadLines`，
# 于是头注里那条「直接跟一串路径」的单跑命令当场绑定失败（实跑过才发现的，
# 同 dao 官侧条款「写给用户照做的命令必须实跑一遍」）。现在路径一律走 remaining。
[CmdletBinding(PositionalBinding = $false)]
param(
    [int]$HeadLines = 60,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Paths
)

$ErrorActionPreference = 'Stop'

# 标记形态：与 run-tests.mjs 里 JS 侧那条**各写一份，刻意不共用**（两侧语义不同，
# 见那份文件的头注 ①）。`-cmatch` 走大小写敏感，与 JS 正则的默认行为对齐。
$MarkerRe = '^[ \t]*#[ \t]*@dao-test-tier:[ \t]*env\b'

$list = @()
if ($null -ne $Paths) { $list = @($Paths | Where-Object { $_ }) }

Write-Output ("PSTIER_SCAN v1 head={0} files={1}" -f $HeadLines, $list.Count)

for ($i = 0; $i -lt $list.Count; $i++) {
    $decl = 0
    $prose = 0
    $perr = 0
    try {
        # 先分开「文件不在」与「文件在但语法有错」：`ParseFile` 对不存在的路径**不抛异常**，
        # 它回一条 parse error ⇒ 不显式分开的话，这两件在 perr 上长得一样。
        if (-not (Test-Path -LiteralPath $list[$i] -PathType Leaf)) { throw 'not found' }
        $tokens = $null
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($list[$i], [ref]$tokens, [ref]$errors)
        $perr = @($errors).Count
        foreach ($t in @($tokens)) {
            if ($t.Kind -ne [System.Management.Automation.Language.TokenKind]::Comment) { continue }
            $startLine = $t.Extent.StartLineNumber
            if ($startLine -gt $HeadLines) { continue }
            # 下面这个 '<#' 是**字符串字面量**，不是开块 —— PR #213 那版自写扫描恰恰在这里翻车
            # （它会把这一行之后的整段判成块注释内部）。留成直写形态，本文件自己就是那条负控。
            if ($t.Text.StartsWith('<#')) {
                # 块注释：整段都是散文。逐行看有没有标记字面量，**但只算落在头 N 行内的那几行**
                # （一个从第 1 行开到第 500 行的 help 块，第 400 行那句不该惊动谁）。
                $inner = $t.Text -split "`n"
                for ($k = 0; $k -lt $inner.Count; $k++) {
                    if (($startLine + $k) -gt $HeadLines) { break }
                    if ($inner[$k] -cmatch $MarkerRe) { $prose = 1 }
                }
                continue
            }
            # 行注释：token 的 Text 从井号开始，故它自己就能判形态。
            if ($t.Text -cnotmatch $MarkerRe) { continue }
            # 还要求它**独占一行**：`Write-Output 'x'   <行尾标记>` 这种行尾注释历来不算声明
            # （旧正则的行首锚也不认它），换底座不改这一格语义。
            $lineText = $t.Extent.StartScriptPosition.Line
            $before = $lineText.Substring(0, $t.Extent.StartColumnNumber - 1)
            if ($before -cmatch '^[ \t]*$') { $decl = 1 }
        }
    } catch {
        # 读不到/解析器抛了：照旧按「无声明」报，另用 perr=-1 让消费方看得见是哪一种。
        $perr = -1
    }
    Write-Output ("{0} decl={1} prose={2} perr={3}" -f $i, $decl, $prose, $perr)
}

Write-Output 'PSTIER_SCAN_END'
exit 0
