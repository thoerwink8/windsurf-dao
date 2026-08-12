# tests/dao-path-boundary.tests.ps1 — Test-PathUnderRoot 边界判据 + 调用点运行时自测
#
# 背景（issue #340 对抗审必修①）：dao.ps1 三处 prune/unlink/status 判据原本用
# `-like "$claudeSrc*"`（字符串前缀，非路径边界），会把 <Root>-old 这类同名前缀兄弟
# 目录判成"在 Root 下"，prune 段据此会误删外来链（对抗审实证 wouldPrune=true）。
# 第二发（修红轮）：三处调用点上一版写成 `A -or B` 无各自括号的命令调用形态，
# PowerShell 会把 -or 及后续整串吞成第一个调用的实参，运行时抛 ParameterAlreadyBound，
# prune/unlink 段静默失效。
# 第三发（复审必修 N1）：字面穿越 <Root>\..\<兄弟>-old 不折叠 .. 段可骗过前缀匹配；
# 挂账 G8：调用点抽取正则只认同形双调用，异形态新调用点静默漏 —— 核数对账守射程本身。
# 本套钉住：函数边界语义（含 .. 折叠 + 四个回归 fail-safe 构造）、调用点「真的能跑」、
# 调用点数对账、以及各层 mutation 反证。
# 第四发（收口轮）：R6 mutation 隔离 / R2 核数剔注释 / R1 注释与实现对齐 / R8 相对路径负控。
#
# ⚠ mutation 隔离为什么必须做（R6）：重定义 Test-PathUnderRoot 的 mutation 块（N1 / R8 / 函数级）
# 用 Invoke-Expression 就地重定义被测函数来验证变异体行为。若不做隔离（& { } 独立作用域 + 跑完
# 重定义回原版），文件末尾将来追加的任何断言测到的会是最后一个变异体（-like 版），可能错绿——
# 这正是「测试自己坏了却绿着」的母题。所有功能断言必须永远测原版函数；mutation 只在自己块内生效。
#
# ⚠ 核数对账的射程边界（R2，只声明不修）：只数 `Test-PathUnderRoot -Path` 字面，且先剔注释行。
# 位置参数调用（Test-PathUnderRoot $a $b，不写 -Path）与续行写法（把 -Path 挪到下一行）都能静默
# 漏出射程；dao.ps1 现风格全命名参数、单行调用，漂移概率低——将来若出现这两种形态，需扩核数
# 正则或补断言，本断言不会替你发现。

$ErrorActionPreference = "Stop"
$failCount = 0

function Test-Pass {
    param([string]$What)
    Write-Host "  PASS  $What"
}

function Test-Fail {
    param([string]$What)
    Write-Host "  FAIL  $What" -ForegroundColor Red
    $script:failCount++
}

$daoPs1 = Join-Path $PSScriptRoot "..\dao.ps1"
if (-not (Test-Path $daoPs1)) {
    Test-Fail "dao.ps1 不在 $daoPs1"
    exit 1
}

# ── 从 dao.ps1 抽 Test-PathUnderRoot 函数体（不执行整个文件的主流程；\r?$ 兼容 CRLF）──
$src = Get-Content -Raw -Encoding UTF8 $daoPs1
$funcRe = '(?ms)^function Test-PathUnderRoot \{.*?^\}\r?$'
$funcMatch = [regex]::Match($src, $funcRe)
if (-not $funcMatch.Success) {
    Test-Fail "从 dao.ps1 抽不到 Test-PathUnderRoot 函数体"
    exit 1
}
Invoke-Expression $funcMatch.Value

function Assert-PathCheck {
    param([object]$Path, [string]$Root, [bool]$Expected, [string]$What)
    $actual = Test-PathUnderRoot -Path $Path -Root $Root
    if ($actual -eq $Expected) {
        Test-Pass "$What (got $actual)"
    } else {
        Test-Fail "$What (expected $Expected, got $actual)"
    }
}

$R = 'C:\repo\windsurf-dao\ccswitch'

# ── 正控 ──
Assert-PathCheck -Path "$R\skills\dao-loop"          -Root $R -Expected $true  -What "正控：<root>\skills\dao-loop 在 <root> 下 => true"
Assert-PathCheck -Path $R                             -Root $R -Expected $true  -What "正控：<root> 自己 => true"
Assert-PathCheck -Path 'C:\X\Root'                   -Root 'c:\x\root' -Expected $true -What "正控：Root 自身大小写不同 => true"

# ── 负控（-old 这条是第一发先破再验的核心）──
Assert-PathCheck -Path "$R-old\skills\foreign-skill" -Root $R -Expected $false -What "负控：<root>-old\skills\foreign 不在 <root> 下 => false"
Assert-PathCheck -Path 'D:\other\skills\x'           -Root $R -Expected $false -What "负控：完全不相干路径 => false"
Assert-PathCheck -Path ("$R" + 'ed\skills\a')       -Root $R -Expected $false -What "负控：<root>ed 前缀兄弟（rooted）=> false"

# ── N1：.. 段折叠（复审必修；第二条负控是本轮先破再验的核心）──
Assert-PathCheck -Path "$R\..\ccswitch-old\skills\foreign-skill" -Root $R -Expected $false -What "N1：<root>\..\<兄弟>-old\skills\foreign 字面穿越 => false"
Assert-PathCheck -Path "$R\skills\..\skills\dao-loop" -Root $R -Expected $true  -What "N1：<root>\skills\..\skills\dao-loop 折叠后仍在 root 下 => true"

# ── 回归钉住：四个 fail-safe 构造修 .. 前后都必须 false（防修 A 放开 B）──
Assert-PathCheck -Path '\\server\share\ccswitch\skills\foreign' -Root $R -Expected $false -What "回归：UNC \\server\share\... 非本机 root => false"
Assert-PathCheck -Path '\\?\UNC\server\share\ccswitch\skills\foreign' -Root $R -Expected $false -What "回归：长路径前缀 \\?\UNC\... => false"
Assert-PathCheck -Path 'C:\repo\WINDSU~1\ccswitch\skills\foreign' -Root $R -Expected $false -What "回归：8.3 短路径（不做文件系统展开）=> false"
Assert-PathCheck -Path "$R.\skills\foreign"          -Root $R -Expected $false -What "回归：尾点兄弟 <root>. => false"

# ── 规范化 ──
Assert-PathCheck -Path 'c:/x/root/skills/a'          -Root 'C:\X\Root' -Expected $true  -What "规范化：正斜杠 + 大小写 => true"
Assert-PathCheck -Path 'C:\x\root\skills\a'          -Root 'C:\x\root\' -Expected $true -What "规范化：Root 带尾斜杠 => 与不带同结果"
Assert-PathCheck -Path '\\?\C:\x\root\skills\a'      -Root 'C:\X\Root' -Expected $true  -What "规范化：\\?\ 长路径前缀 => true"

# ── 空 / null / 数组 ──
Assert-PathCheck -Path ''      -Root $R -Expected $false -What "空 Path => false"
Assert-PathCheck -Path $null   -Root $R -Expected $false -What "null Path => false"
Assert-PathCheck -Path 'C:\x\root\skills\a' -Root '' -Expected $false -What "空 Root => false"
Assert-PathCheck -Path $null   -Root '' -Expected $false  -What "Path/Root 双空 => false"
Assert-PathCheck -Path @('C:\x\root\skills\a') -Root 'C:\x\root' -Expected $true -What "数组 Path（Junction Target 形态）取第一项 => true"

# ── R8：非绝对路径 ⇒ 直接 false 分支（相对路径负控；该分支的存在理由是「不许基于 cwd 解析」）──
Assert-PathCheck -Path 'skills\dao-loop' -Root $R -Expected $false -What "R8：相对 skills\dao-loop => false"
Assert-PathCheck -Path '..\ccswitch\skills\x' -Root $R -Expected $false -What "R8：相对 ..\ccswitch\skills\x => false"
Assert-PathCheck -Path '..\..\C:\repo\windsurf-dao\ccswitch\skills\x' -Root $R -Expected $false -What "R8：相对但折叠可进盘符形态（若绝对分支被删会翻绿）=> false"

# ── 调用点运行时断言：三处含 Test-PathUnderRoot 的表达式在假数据上真的能跑 ──
# 这格钉的是「调用点写法」：函数对不等于调用点能跑。上一版 A -or B 无各自括号，
# 语法 PARSE-OK 抓不到，运行时抛 ParameterAlreadyBound，prune/unlink 静默失效。
$callRe = 'Test-PathUnderRoot -Path \$_\.Target -Root \$[A-Za-z]+[^\r\n]*?Test-PathUnderRoot -Path \$_\.Target -Root \$[A-Za-z]+'
$callMatches = [regex]::Matches($src, $callRe)
if ($callMatches.Count -ne 3) {
    Test-Fail ("调用点表达式应抽到 3 处，实际 {0} 处（抽到 0 条必须判 FAIL，不许静默通过）" -f $callMatches.Count)
} else {
    Test-Pass "从 dao.ps1 抽到 3 处 Test-PathUnderRoot 调用点表达式"
    $i = 0
    foreach ($m in $callMatches) {
        $i++
        $expr = $m.Value
        $claudeSrc = $R
        $statusOldSrc = 'C:\repo\windsurf-dao\claude'
        $oldClaudeSrc = 'C:\repo\windsurf-dao\claude'
        $srcNames = @('x')
        # 正控：target 指向 <root>\skills\x ⇒ 表达式为 true 且是布尔
        $_ = [pscustomobject]@{ Target = "$R\skills\x"; Name = 'x'; LinkType = 'Junction' }
        try {
            $eval = & ([scriptblock]::Create("($expr)"))
            if ($eval -isnot [bool]) {
                Test-Fail "调用点 $i：结果不是布尔（调用点写法坏了，命令调用把 -or 吞成实参）got [$($eval -as [string])]"
            } elseif ($eval -ne $true) {
                Test-Fail "调用点 $i：<root>\skills\x 应求值为 true，got $eval"
            } else {
                Test-Pass "调用点 $i：<root>\skills\x ⇒ true（布尔，无绑定错）"
            }
        } catch {
            Test-Fail ("调用点 $i：求值抛异常：" + $_.Exception.Message)
        }
        # 负控：target 指向 <root>-old\skills\x ⇒ 表达式为 false 且是布尔
        $_ = [pscustomobject]@{ Target = "$R-old\skills\x"; Name = 'x'; LinkType = 'Junction' }
        try {
            $eval = & ([scriptblock]::Create("($expr)"))
            if ($eval -isnot [bool]) {
                Test-Fail "调用点 $i：结果不是布尔 got [$($eval -as [string])]"
            } elseif ($eval -ne $false) {
                Test-Fail "调用点 $i：<root>-old\skills\x 应求值为 false，got $eval"
            } else {
                Test-Pass "调用点 $i：<root>-old\skills\x ⇒ false（布尔，无绑定错）"
            }
        } catch {
            Test-Fail ("调用点 $i：求值抛异常：" + $_.Exception.Message)
        }
        # mutation：去掉每个调用自己的括号（还原 bug 形态），必须抛异常或返回 null
        if (-not $expr.Contains(') -or (')) {
            Test-Fail ("调用点 $i：锚点 ') -or (' 未在表达式里命中（锚点落空不许静默通过）")
        } else {
            $mutExpr = $expr.Replace(') -or (', ' -or ')
            $_ = [pscustomobject]@{ Target = "$R\skills\x"; Name = 'x'; LinkType = 'Junction' }
            try {
                $mr = & ([scriptblock]::Create("($mutExpr)"))
                if ($null -eq $mr) {
                    Test-Pass "调用点 $i：去括号变异体返回 null（调用点断言确实在管事）"
                } else {
                    Test-Fail ("调用点 $i：去括号变异体返回了 [$($mr -as [string])]（断言没拦住）")
                }
            } catch {
                Test-Pass "调用点 $i：去括号变异体抛绑定错（调用点断言确实在管事）"
            }
        }
    }
}

# ── 核数对账（挂账 G8）：dao.ps1 里 Test-PathUnderRoot -Path 出现总次数 vs 被运行时断言验证的条数 ──
# 抽取正则只认「同形双调用 + $_.Target」；异形态新调用点（单调用 / 其他属性）会静默漏进射程外。
# 这条守「射程本身」：总数 ≠ 已验证数 即红，消息指出去扩正则或补断言。
$totalCallCount = 0
foreach ($l in $src -split "`r?`n") {
    if ($l -match '^\s*#') { continue }                                  # R2：先剔注释行（注释里写调用字面会让核数虚增 ⇒ 误红）
    if ($l -match '^\s*function Test-PathUnderRoot\s*\{') { continue }   # 排除函数定义自身那一行
    $totalCallCount += ([regex]::Matches($l, 'Test-PathUnderRoot -Path')).Count
}
$verifiedCallCount = $callMatches.Count * 2   # 每条抽出的表达式含两次调用，均被上面的运行时断言验证
if ($totalCallCount -ne $verifiedCallCount) {
    Test-Fail ("核数对账：dao.ps1 里 Test-PathUnderRoot -Path 共 {0} 处，被运行时断言验证 {1} 处——新增了调用点但没进断言射程，去扩抽取正则或补断言" -f $totalCallCount, $verifiedCallCount)
} else {
    Test-Pass ("核数对账：{0} 处 Test-PathUnderRoot -Path 调用全部进断言射程" -f $totalCallCount)
}

$mutDir = Join-Path (Split-Path $PSScriptRoot -Parent) "_tmp"
if (-not (Test-Path $mutDir)) { New-Item -ItemType Directory -Path $mutDir -Force | Out-Null }

# ── G8 mutation：往副本注入异形态调用点，核数对账必须红（证明射程断言真的在管事）──
$g8File = Join-Path $mutDir ("dao-callsite-inject-{0}.ps1" -f $PID)
try {
    Copy-Item $daoPs1 $g8File -Force
    $g8Src = Get-Content -Raw -Encoding UTF8 $g8File
    $injectLine = 'if (Test-PathUnderRoot -Path $_.FullName -Root $claudeSrc) { $x = 1 }'
    $injectAnchor = 'function Invoke-LinkClaude {'
    if (-not $g8Src.Contains($injectAnchor)) {
        Test-Fail "G8 mutation：注入锚点 function Invoke-LinkClaude 未命中（锚点落空不许静默通过）"
    } else {
        $g8Src = $g8Src.Replace($injectAnchor, $injectLine + "`r`n" + $injectAnchor)
        [System.IO.File]::WriteAllText($g8File, $g8Src, (New-Object System.Text.UTF8Encoding $true))
        $g8Total = 0
        foreach ($l in $g8Src -split "`r?`n") {
            if ($l -match '^\s*#') { continue }                          # R2：与主核数逻辑一致，先剔注释行
            if ($l -match '^\s*function Test-PathUnderRoot\s*\{') { continue }
            $g8Total += ([regex]::Matches($l, 'Test-PathUnderRoot -Path')).Count
        }
        if ($g8Total -ne $verifiedCallCount) {
            Test-Pass "G8 mutation：注入异形态调用点后总数 $g8Total ≠ 已验证 $verifiedCallCount ⇒ 核数对账红（射程缺口被钉住）"
        } else {
            Test-Fail "G8 mutation：注入异形态调用点后总数仍等于已验证数 ⇒ 核数断言没拦住（失效）"
        }
    }
} finally {
    Remove-Item $g8File -Force -ErrorAction SilentlyContinue
}

# ── R2 mutation：注释里写调用字面不得让核数虚增（剔除注释行的判别力实证）──
# S1 修法：期望用动态基线——先数 dao.ps1 已有注释行里的调用字面数 base，
# 不剔计数期望 = verified + base + 注入的 1 条，而不是写死 verified+1
# （写死的话，dao.ps1 注释里出现任何调用字面——写文档注释示例是自然事——本 mutation 即误红）。
$r2File = Join-Path $mutDir ("dao-comment-inject-{0}.ps1" -f $PID)
try {
    Copy-Item $daoPs1 $r2File -Force
    $r2Src = Get-Content -Raw -Encoding UTF8 $r2File
    $r2Base = 0
    foreach ($l in $r2Src -split "`r?`n") {
        if ($l -match '^\s*#') { $r2Base += ([regex]::Matches($l, 'Test-PathUnderRoot -Path')).Count }
    }
    $r2Comment = '# 示例：Test-PathUnderRoot -Path $_.Target -Root $claudeSrc（注释里的调用字面，不应被核数）'
    $r2Anchor = 'function Test-PathUnderRoot {'
    if (-not $r2Src.Contains($r2Anchor)) {
        Test-Fail "R2 mutation：注入锚点 function Test-PathUnderRoot 未命中（锚点落空不许静默通过）"
    } else {
        $r2Src = $r2Src.Replace($r2Anchor, $r2Comment + "`r`n" + $r2Anchor)
        $r2WithSkip = 0
        $r2NoSkip = 0
        foreach ($l in $r2Src -split "`r?`n") {
            $isComment = $l -match '^\s*#'
            $isDefLine = $l -match '^\s*function Test-PathUnderRoot\s*\{'
            if (-not $isComment -and -not $isDefLine) { $r2WithSkip += ([regex]::Matches($l, 'Test-PathUnderRoot -Path')).Count }
            if (-not $isDefLine) { $r2NoSkip += ([regex]::Matches($l, 'Test-PathUnderRoot -Path')).Count }
        }
        if ($r2WithSkip -eq $verifiedCallCount -and $r2NoSkip -eq ($verifiedCallCount + $r2Base + 1)) {
            Test-Pass "R2 mutation：注释含调用字面（已有 $r2Base 条 + 注入 1 条）时，剔注释计数仍 $verifiedCallCount（不虚增）、不剔则 +$($r2Base + 1) ⇒ 动态基线在管事"
        } else {
            Test-Fail ("R2 mutation：期望剔注释 $verifiedCallCount / 不剔 $($verifiedCallCount + $r2Base + 1)，实际 $r2WithSkip / $r2NoSkip")
        }
    }
} finally {
    Remove-Item $r2File -Force -ErrorAction SilentlyContinue
}

# ── N1 mutation：把 .. 折叠的弹回步去掉 ⇒ .. 负控必须翻绿（证明 N1 负控真的在管事）──
# R6 隔离：mutation 用 Invoke-Expression 就地重定义 Test-PathUnderRoot，必须放进 & { } 独立作用域
# 并在跑完后重定义回原版——否则文件末尾追加的断言会测到变异体（详见文件头注）。
& {
$n1File = Join-Path $mutDir ("dao-path-fold-mutation-{0}.ps1" -f $PID)
try {
    Copy-Item $daoPs1 $n1File -Force
    $n1Src = Get-Content -Raw -Encoding UTF8 $n1File
    $n1Anchor = '$stack.RemoveAt($stack.Count - 1)'
    $n1Occurrences = ([regex]::Matches($n1Src, [regex]::Escape($n1Anchor))).Count
    if ($n1Occurrences -ne 1) {
        Test-Fail ("N1 mutation 锚点命中 {0} 次（应为 1），锚点落空不许静默通过" -f $n1Occurrences)
    } else {
        $n1Src = $n1Src.Replace($n1Anchor, '$null')
        [System.IO.File]::WriteAllText($n1File, $n1Src, (New-Object System.Text.UTF8Encoding $true))
        $n1FuncMatch = [regex]::Match($n1Src, $funcRe)
        if (-not $n1FuncMatch.Success) {
            Test-Fail "从 N1 变异副本抽不到 Test-PathUnderRoot 函数体"
        } else {
            Invoke-Expression $n1FuncMatch.Value
            $n1Mut = Test-PathUnderRoot -Path "$R\..\ccswitch-old\skills\foreign-skill" -Root $R
            if ($n1Mut) {
                Test-Pass "N1 mutation：去掉 .. 折叠后字面穿越负控翻绿 => 负控确实在管事"
            } else {
                Test-Fail "N1 mutation：去掉 .. 折叠后字面穿越负控未翻绿（负控失效或锚点未替换）"
            }
        }
    }
} finally {
    Remove-Item $n1File -Force -ErrorAction SilentlyContinue
}
}
Invoke-Expression $funcMatch.Value   # R6：mutation 跑完重定义回原版（双保险，& 作用域隔离是第一层）

# ── R8 mutation：把「非绝对 ⇒ false」分支去掉 ⇒ 相对穿越构造翻绿（证明 R8 负控在管事）──
& {
$r8File = Join-Path $mutDir ("dao-nonabs-mutation-{0}.ps1" -f $PID)
try {
    Copy-Item $daoPs1 $r8File -Force
    $r8Src = Get-Content -Raw -Encoding UTF8 $r8File
    $r8Anchor = 'if (-not ($isAbsDrive -or $isAbsUnc)) { return $false }'
    $r8Occurrences = ([regex]::Matches($r8Src, [regex]::Escape($r8Anchor))).Count
    if ($r8Occurrences -ne 1) {
        Test-Fail ("R8 mutation 锚点命中 {0} 次（应为 1），锚点落空不许静默通过" -f $r8Occurrences)
    } else {
        $r8Src = $r8Src.Replace($r8Anchor, '# R8 mutation：非绝对路径分支去掉')
        [System.IO.File]::WriteAllText($r8File, $r8Src, (New-Object System.Text.UTF8Encoding $true))
        $r8FuncMatch = [regex]::Match($r8Src, $funcRe)
        if (-not $r8FuncMatch.Success) {
            Test-Fail "从 R8 变异副本抽不到 Test-PathUnderRoot 函数体"
        } else {
            Invoke-Expression $r8FuncMatch.Value
            $r8Mut = Test-PathUnderRoot -Path '..\..\C:\repo\windsurf-dao\ccswitch\skills\x' -Root $R
            if ($r8Mut) {
                Test-Pass "R8 mutation：去掉非绝对分支后相对穿越构造翻绿 => R8 负控确实在管事"
            } else {
                Test-Fail "R8 mutation：去掉非绝对分支后相对穿越构造未翻绿（负控失效或锚点未替换）"
            }
        }
    }
} finally {
    Remove-Item $r8File -Force -ErrorAction SilentlyContinue
}
}
Invoke-Expression $funcMatch.Value   # R6：mutation 跑完重定义回原版

# ── mutation（函数级）：把判定改回 -like "$Root*"，-old 负控必须翻绿 ──
& {
$mutFile = Join-Path $mutDir ("dao-path-boundary-mutation-{0}.ps1" -f $PID)
try {
    Copy-Item $daoPs1 $mutFile -Force
    $mutSrc = Get-Content -Raw -Encoding UTF8 $mutFile
    $anchor = 'return $p -eq $r -or $p.StartsWith($r + ''\'', [StringComparison]::OrdinalIgnoreCase)'
    $occurrences = ([regex]::Matches($mutSrc, [regex]::Escape($anchor))).Count
    if ($occurrences -ne 1) {
        Test-Fail ("函数级 mutation 锚点命中 {0} 次（应为 1），锚点落空不许静默通过" -f $occurrences)
    } else {
        $replacement = 'return $p -like "$r*"'
        $mutSrc = $mutSrc.Replace($anchor, $replacement)
        # 写回临时副本（UTF8 带 BOM，与 dao.ps1 原编码一致；只影响 _tmp 下的临时文件）
        [System.IO.File]::WriteAllText($mutFile, $mutSrc, (New-Object System.Text.UTF8Encoding $true))
        $mutFuncMatch = [regex]::Match($mutSrc, $funcRe)
        if (-not $mutFuncMatch.Success) {
            Test-Fail "从变异副本抽不到 Test-PathUnderRoot 函数体"
        } else {
            Invoke-Expression $mutFuncMatch.Value
            $mutOld = Test-PathUnderRoot -Path "$R-old\skills\foreign-skill" -Root $R
            if ($mutOld) {
                Test-Pass "函数级 mutation：判定改回 -like 后 -old 负控翻绿 => 负控确实在管事"
            } else {
                Test-Fail "函数级 mutation：判定改回 -like 后 -old 负控未翻绿（负控失效或锚点未替换）"
            }
        }
    }
} finally {
    Remove-Item $mutFile -Force -ErrorAction SilentlyContinue
}
}
Invoke-Expression $funcMatch.Value   # R6：mutation 跑完重定义回原版

# ── R6 隔离验证：三个重定义 mutation 块全部跑完后，Test-PathUnderRoot 必须是原版 ──
$afterMutations = Test-PathUnderRoot -Path "$R-old\skills\foreign-skill" -Root $R
if ($afterMutations -eq $false) {
    Test-Pass "R6：mutation 块跑完函数仍是原版（-old 负控仍 false，隔离有效；文件尾追加断言安全）"
} else {
    Test-Fail "R6：mutation 块跑完函数被变异体污染（隔离失效，文件尾追加断言会错绿）"
}

if ($failCount -gt 0) {
    Write-Host ("`n=== dao-path-boundary: FAIL={0} ===" -f $failCount) -ForegroundColor Red
    exit 1
}
Write-Host "`n=== dao-path-boundary: ALL PASS ===" -ForegroundColor Green
exit 0
