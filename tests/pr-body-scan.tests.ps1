# @dao-test-tier: env   # 整套只在 --env 跑：沙盒用固定路径 _tmp/pr-body-scan-test（未随机化 ⇒ 并行必互踩）
<#
.SYNOPSIS
    `ccswitch/lib/pr-body-scan.ps1` + `ccswitch/scripts/check-pr-body-mojibake.ps1` 的纯断言
    自测（无 Pester 依赖）。**canonical（2026-08-02 随判据库一并由 mousse-cli
    `scripts/test-pr-body-scan.ps1` 上移；那边只留「接线还在不在」的 3 条，
    判据网整份住这里——判据搬家而回归网留在原地，等于把网留给了一个空位置）。**
    退出码 0 = 全部通过。

.DESCRIPTION
    ## 本文件最要紧的那一段是场景 1（零样本），别的都可以后补

    被测对象是一个**观察线**，观察线最典型的死法不是报错，是**在什么都没看见的
    时候报「通过」**。已记过一例：某检查在新 worktree 里因 `_tmp/` 不存在而
    重定向失败、**脚本一行没跑**，通知层却报 `completed (exit code 0)`。
    issue #285 是同一个病的另一面：检测器数到 0 个违例，与检测器根本没看到样本，
    输出**逐字节相同**。

    故场景 1 不只断言「ZeroSample 为真」，还断言**输出里不出现通过措辞**——
    「返回值对了但打印说通过了」照样是这个病，而人只读打印。

    ## 判别力：本测试是**行为型**，不是文本匹配型

    除场景 8（静态扫描）外，全部断言都跑真实函数、看真实返回值/输出。
    条款库对抗验证官节「mutation 的『改坏』本身要试不止一种形态」实证：出处仓 14 份
    读源码文本做断言的守护里 **8 份对「注释掉」形态失明**。行为型断言对
    ①移除 与 ②保留字面但不执行 通常都敏感，这是刻意的选型。
    **场景 8 是那个例外**：它读 `verify-all.ps1` 的源码文本，故改用 **PowerShell
    解析器**取 token 流并剔除 Comment token —— 井号行注释与块注释**两种**「注释掉」
    形态都盖得住（两者各有一个 mutation 实证，见 PR）。仍盖不住的（`if ($false)`
    包裹 / 改变量名）写在那一段的注释里，不假称已覆盖。

    （本段刻意不写块注释的那对定界符字面：写进去会**当场终止这个 help 块**，
      后面的 `.NOTES` 直接变成代码、`&&` 那一行报 ParserError。2026-07-29 实测踩到。）

.NOTES
    独立可运行：powershell -NoProfile -File tests/pr-body-scan.tests.ps1
    退出码：0 = 全部通过；1 = 存在失败。
    夹具落 `_tmp/pr-body-scan-test/`（运行期生成、不入库，`_tmp/` 已在 .gitignore）。
    **夹具是 `_tmp/` 的子目录，而被测扫描面不递归** ⇒ 夹具永远不会污染
    `check-pr-body-mojibake.ps1` 的默认扫描面。这不是巧合，是选非递归的收益之一。
    PS 5.1 兼容：无三元运算符、无 && 链、禁 2>&1。本文件须以 BOM UTF-8 存盘。
#>

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\ccswitch\lib\console-utf8.ps1')  # pin child-stdout decode to UTF-8 -- see that file (issue #131)
$repoRoot  = Split-Path -Parent $PSScriptRoot
$targetPs1 = Join-Path $repoRoot 'ccswitch/scripts/check-pr-body-mojibake.ps1'
$libPs1    = Join-Path $repoRoot 'ccswitch/lib/pr-body-scan.ps1'
$psExe     = (Get-Command powershell.exe).Source
$workDir   = Join-Path $repoRoot '_tmp/pr-body-scan-test'

foreach ($p in @($targetPs1, $libPs1)) {
    if (-not (Test-Path $p)) { Write-Host "被测脚本不存在：$p"; exit 1 }
}
. $libPs1

if (Test-Path $workDir) { Remove-Item -Path $workDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

$results = New-Object System.Collections.Generic.List[object]

function Assert-True {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    $status = 'FAIL'
    if ($Condition) { $status = 'PASS' }
    $script:results.Add([PSCustomObject]@{ Name = $Name; Status = $status; Detail = $Detail })
    Write-Host ("  [{0}] {1} {2}" -f $status, $Name, $Detail)
}

function New-Case {
    <#
      造一个独立的夹具目录（每个场景一个，互不干扰），把 `$Files` 写进去。
      `$Files` 是 名→内容 的有序对数组；内容一律 **无 BOM UTF-8** 落盘
      （被测脚本用 `[IO.File]::ReadAllLines(..., UTF8)` 读，与真实 `_tmp/` 里
      由 `gh`/Bash 重定向产出的文件同形态）。
    #>
    param([string]$Case, [object[]]$Files = @())
    $dir = Join-Path $workDir $Case
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    foreach ($f in @($Files)) {
        $path = Join-Path $dir $f.Name
        $parent = Split-Path -Parent $path
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        [System.IO.File]::WriteAllText($path, $f.Text, (New-Object System.Text.UTF8Encoding($false)))
    }
    return $dir
}

function F { param([string]$Name, [string]$Text) return [PSCustomObject]@{ Name = $Name; Text = $Text } }

function Invoke-Check {
    param([string]$Root, [int]$MaxList = -1)
    $psArgs = @('-NoProfile', '-File', $targetPs1, '-ScanRoot', $Root)
    # -1 是**哨兵**，语义"不传这个参数"⇒ 走被测脚本自己的默认值。不写成 `= 5`
    # 是刻意的：那样测试会把默认值抄一份，被测脚本改默认时测试静默跟不上，
    # 而"默认路径"就再也没人验了（形态照抄 test-clauses-date.ps1 的 Invoke-Check）。
    if ($MaxList -ge 0) { $psArgs += @('-MaxListPerSignal', $MaxList) }
    $out = & $psExe @psArgs
    return [PSCustomObject]@{ ExitCode = $LASTEXITCODE; Text = ($out -join "`n") }
}

Write-Host ''
Write-Host '== check-pr-body-mojibake / pr-body-scan 回归测试 =='
Write-Host ''

# ============================================================================
# 场景 1：零样本 —— **本批的关键测试点**
# ============================================================================
# 病灶（实证）：观察线在「什么都没看见」时报出与「全都看过且没问题」一模一样
# 的输出。故这里的断言分三层，缺一层都留着病：
#   ① 返回值层：ZeroSample 必须为真
#   ② 打印层：必须出现「零样本」且必须出现「这不是「通过」」
#   ③ 打印层的**否定断言**：必须**不**出现零命中式通过措辞
# ③ 是最容易被忘的一层——一个「先报零样本、再顺手报一句均零命中」的实现能过 ①②。
Write-Host '场景 1：零样本（空目录 / 目录不存在 / 只有超限文件）'

$c1empty = New-Case -Case 'zero-empty'
$s1empty = Invoke-PrBodyScan -Root $c1empty
$r1empty = Invoke-Check -Root $c1empty

Assert-True '1a 空目录 ⇒ ZeroSample 为真' ($s1empty.ZeroSample -eq $true) `
    ("Files={0}" -f @($s1empty.Files).Count)
Assert-True '1b 空目录 ⇒ RootExists 仍为真（目录在、只是没东西，与 1e 是两种状态）' `
    ($s1empty.RootExists -eq $true) ''
Assert-True '1c 空目录 ⇒ 输出显式报「零样本」' `
    ($r1empty.Text -match '零样本') ''
Assert-True '1d 空目录 ⇒ 输出显式否认「通过」（未扫任何样本 ≠ 通过）' `
    ($r1empty.Text -match '这不是「通过」') ''
Assert-True '1e 空目录 ⇒ **不**出现零命中式通过措辞（③ 层：报了零样本还顺手报通过同样是病）' `
    (-not ($r1empty.Text -match '均零命中')) ''
Assert-True '1f 空目录 ⇒ 退出码仍为 0（观察线不阻断）' ($r1empty.ExitCode -eq 0) `
    ("exit={0}" -f $r1empty.ExitCode)
Assert-True '1g 空目录 ⇒ 顺带给出「怎么产出回读记录」的可复制命令（零样本不是死路）' `
    ($r1empty.Text -match 'gh pr view <n> --json body') ''

$c1missing = Join-Path $workDir 'zero-missing-never-created'
$s1missing = Invoke-PrBodyScan -Root $c1missing
$r1missing = Invoke-Check -Root $c1missing

Assert-True '1h 目录不存在 ⇒ RootExists 为假、ZeroSample 为真（新 worktree 里 _tmp/ 常常压根没有）' `
    (($s1missing.RootExists -eq $false) -and ($s1missing.ZeroSample -eq $true)) ''
Assert-True '1i 目录不存在 ⇒ 不崩、退出码 0、且照样报零样本（不是静默 OK）' `
    (($r1missing.ExitCode -eq 0) -and ($r1missing.Text -match '零样本') -and `
     ($r1missing.Text -match '这不是「通过」')) ("exit={0}" -f $r1missing.ExitCode)

# 只有一个超限文件：文件在、但**一个字节都没读** ⇒ 仍是零样本，且那个文件必须被列出。
$bigText = ('x' * 3000) + "`n"
$c1big = New-Case -Case 'zero-oversized' -Files @((F 'pr-1-readback.md' $bigText))
$s1big = Invoke-PrBodyScan -Root $c1big -MaxFileKB 1
$r1big = Invoke-Check -Root $c1big

Assert-True '1j 唯一的文件超限 ⇒ 仍判零样本（"有文件"不等于"读过内容"）' `
    (($s1big.ZeroSample -eq $true) -and (@($s1big.Oversized).Count -eq 1)) `
    ("Files={0} Oversized={1}" -f @($s1big.Files).Count, @($s1big.Oversized).Count)
Assert-True '1k 超限文件被**列出**而非静默跳过（静默跳过正是这类检查要防的病）' `
    ($s1big.Oversized[0].Name -eq 'pr-1-readback.md') ''
Assert-True '1l 默认 2MB 上限下同一文件是正常样本（证明 1j 来自阈值，不是恒判零样本）' `
    ($r1big.Text -notmatch '零样本') ''

# 判别力负控：有真样本时**必须不**报零样本。没有这一条，上面全部断言都可能只是
# "恒报零样本"也照样绿（同 test-verify-exit 场景 9 的用意）。
$c1has = New-Case -Case 'zero-negative' -Files @((F 'pr-9-readback.md' "## 正常正文`n没有任何异常。`n"))
$s1has = Invoke-PrBodyScan -Root $c1has
$r1has = Invoke-Check -Root $c1has
Assert-True '1m 负控：有可读样本 ⇒ ZeroSample 为假，且输出改报「均零命中」' `
    (($s1has.ZeroSample -eq $false) -and ($r1has.Text -match '均零命中') -and `
     (-not ($r1has.Text -match '零样本'))) ''

# ============================================================================
# 场景 1x：**空行**（2026-07-29 真实数据实测捞出的首版缺陷，回归钉）
# ============================================================================
# 首版 47 条断言全绿，而在出处仓 `_tmp/` 的 16 份真实 PR 正文上**一份都没扫成**：
# PowerShell 的 Mandatory 校验对集合参数是**逐元素**判「非空」的 ⇒ 正文里只要有
# 一个空行，`Get-PrBodyLineHits -Lines` 就绑定失败。而调用方是观察线、
# `$ErrorActionPreference='Continue'` 一路继承下来 ⇒ 错误被打到屏幕上然后当没发生，
# 末尾照报「均零命中」、退出码 0。**这正是本批要治的那个病，在检测器自己身上重演。**
#
# 首版为什么没测出来：**合成夹具全是紧凑的两三行，一个空行都没有**。真实 PR body
# 全是段落。条款库对抗验证官节「近似手段的验证语料禁只来自本轮构造的形态」讲的就是
# 这件事——本场景之后，正例夹具一律带空行。
Write-Host '场景 1x：正文含空行（真实 PR body 的常态）不得导致静默全跳过'

$blank = "# 标题`n`n第一段，正文里有空行。`n`n`n含 锛 签名字的一行`n`n末段。`n"
$c1blank = New-Case -Case 'blank-lines' -Files @((F 'pr-16-readback.md' $blank))
$s1blank = Invoke-PrBodyScan -Root $c1blank
$r1blank = Invoke-Check -Root $c1blank

Assert-True '1x-a 含空行的正文被**成功扫完**（首版：0 个成功、报错却报零命中）' `
    ((@($s1blank.Scanned).Count -eq 1) -and (@($s1blank.Unreadable).Count -eq 0)) `
    ("Scanned={0} Unreadable={1}" -f @($s1blank.Scanned).Count, @($s1blank.Unreadable).Count)
Assert-True '1x-b 空行不影响命中：A1 照样报 1 处，行号是第 6 行（空行参与计数）' `
    ((@($s1blank.Signature4).Count -eq 1) -and ($s1blank.Signature4[0].LineNo -eq 6)) `
    ("命中 {0} 处，行号 {1}" -f @($s1blank.Signature4).Count, $(if (@($s1blank.Signature4).Count -gt 0) { $s1blank.Signature4[0].LineNo } else { '-' }))
Assert-True '1x-c 不是零样本（首版在这里会判成"有文件"但一个都没扫成）' `
    ($s1blank.ZeroSample -eq $false) ''
Assert-True '1x-d 脚本输出里不出现参数绑定错误（错误若发生也必须变成可见的失败条目）' `
    (-not ($r1blank.Text -match 'Cannot bind argument')) ''

# 「扫描失败」这一档必须与「本批没发 PR」分得开：目录里明明有正文、却一个都没扫成时，
# 输出要说清是**检测器坏了**，不是没东西可看。首版这一档整个是哑的（错误打在屏幕上、
# 结论照报零命中），故这里要造一个**真的会失败**的样本，不能靠手搓一个假返回值断言
# ——那种"断言"只是把期望写了两遍。
# 造法：用 `FileShare::None` 独占打开那个文件，锁在父进程手里、子进程照样读不到
# （Windows 上确定性成立；同进程内第二个句柄也一样被拒）。
Write-Host '  （造一个真的扫不成的样本：FileShare::None 独占锁）'
$c1lock = New-Case -Case 'scan-fail' -Files @((F 'pr-17-readback.md' "正文`n`n第二段`n"))
$lockPath = Join-Path $c1lock 'pr-17-readback.md'
$fs = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::Open,
                             [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
try {
    $s1lock = Invoke-PrBodyScan -Root $c1lock
    $r1lock = Invoke-Check -Root $c1lock
} finally {
    $fs.Dispose()
}

Assert-True '1x-e 扫描面有文件但一个都没扫成 ⇒ Scanned=0 / Unreadable=1 / ZeroSample 为真' `
    ((@($s1lock.Files).Count -eq 1) -and (@($s1lock.Scanned).Count -eq 0) -and `
     (@($s1lock.Unreadable).Count -eq 1) -and ($s1lock.ZeroSample -eq $true)) `
    ("Files={0} Scanned={1} Unreadable={2} Zero={3}" -f @($s1lock.Files).Count, `
        @($s1lock.Scanned).Count, @($s1lock.Unreadable).Count, $s1lock.ZeroSample)
Assert-True '1x-f 输出必须说清是**扫描失败**而不是"没东西"（否则零样本会被读成没什么事）' `
    (($r1lock.Text -match '扫描失败') -and ($r1lock.Text -match 'pr-17-readback\.md')) ''
Assert-True '1x-g 全军覆没时**不**报零命中式通过措辞（守卫全盲 ≠ 干净）' `
    (-not ($r1lock.Text -match '均零命中')) ''
Assert-True '1x-h 即便如此仍恒 exit 0（观察线不阻断，但话说清楚了）' `
    ($r1lock.ExitCode -eq 0) ("exit={0}" -f $r1lock.ExitCode)

# ============================================================================
# 场景 2：信号 A1 —— 条款原文那四个签名字
# ============================================================================
# 逐字分别断言，不合成一条：只测其中一个字的话，删掉另外三个字的测试照样全绿。
Write-Host '场景 2：A1 四个签名字（逐字断言 + 负控）'

$a1cases = @(
    @{ Ch = '锛'; Src = '：(U+FF1A)' },
    @{ Ch = '銆'; Src = '。/、' },
    @{ Ch = '馃'; Src = 'emoji 前导 F0 9F' },
    @{ Ch = '鈥'; Src = '—(U+2014)' }
)
foreach ($a in $a1cases) {
    $dir = New-Case -Case ("a1-" + [int][char]$a.Ch) -Files @((F 'pr-2-readback.md' ("第一行正常`n第二行含 " + $a.Ch + " 签名字`n")))
    $s = Invoke-PrBodyScan -Root $dir
    Assert-True ("2a[{0}] 命中 A1（源：{1}）" -f $a.Ch, $a.Src) `
        (@($s.Signature4).Count -eq 1) ("命中 {0} 处" -f @($s.Signature4).Count)
    Assert-True ("2b[{0}] 行号正确（第 2 行）" -f $a.Ch) `
        ((@($s.Signature4).Count -eq 1) -and ($s.Signature4[0].LineNo -eq 2)) ''
}

$c2neg = New-Case -Case 'a1-negative' -Files @(
    (F 'pr-3-readback.md' "## 这是什么`n托管各类 AI CLI agent 的原生桌面工作台。`n📸 真机验证：见评论 https://example.invalid/x.png`n")
)
$s2neg = Invoke-PrBodyScan -Root $c2neg
Assert-True '2c 负控：正常中文正文（含全角冒号/句号/emoji）零命中 A1' `
    (@($s2neg.Signature4).Count -eq 0) ("命中 {0} 处" -f @($s2neg.Signature4).Count)
Assert-True '2d 负控：同一份正常正文四个信号全部零命中（整体零误伤）' `
    ((@($s2neg.EuroAdjCjk).Count -eq 0) -and (@($s2neg.Placeholder).Count -eq 0) -and `
     (@($s2neg.Evidence).Count -eq 0)) ''

# ============================================================================
# 场景 3：信号 A2 —— € 紧贴汉字（含「为什么需要 A2」的反证与已知假阳性）
# ============================================================================
Write-Host '场景 3：A2（€ 贴 CJK）+ A1 在同一行上是哑的（这就是 A2 存在的理由）'

# 这一行逐字取自条款正文引用的实测结果：`## 这是什么` 经 Get-Content -Raw 所得。
$realMojibake = "## 杩欐槸浠€涔?`n"
$c3 = New-Case -Case 'a2-real' -Files @((F 'pr-269-readback.md' $realMojibake))
$s3 = Invoke-PrBodyScan -Root $c3
Assert-True '3a A2 命中条款自己引的那一行真实乱码（`## 杩欐槸浠€涔?`）' `
    (@($s3.EuroAdjCjk).Count -eq 1) ("命中 {0} 处" -f @($s3.EuroAdjCjk).Count)
Assert-True '3b **A1 对同一行零命中** —— 删掉 A2 就等于对这个真实样本失明（A2 的存在理由，删 A2 即此条红）' `
    (@($s3.Signature4).Count -eq 0) ("A1 命中 {0} 处" -f @($s3.Signature4).Count)

$c3neg = New-Case -Case 'a2-negative' -Files @((F 'pr-4-readback.md' "价格 €100 元`n定价 € 200`n"))
$s3neg = Invoke-PrBodyScan -Root $c3neg
Assert-True '3c 负控：`价格 €100 元`（€ 两侧有空格）不命中 A2' `
    (@($s3neg.EuroAdjCjk).Count -eq 0) ("命中 {0} 处" -f @($s3neg.EuroAdjCjk).Count)

# **已知假阳性也要钉住**：不钉的话，下一个读输出的人会以为它不会误报。
# 这条断言的意思不是"这样是对的"，是"这个代价是已知且被记录的"（见 lib 文件头）。
$c3fp = New-Case -Case 'a2-known-fp' -Files @((F 'pr-5-readback.md' "售价€100`n"))
$s3fp = Invoke-PrBodyScan -Root $c3fp
Assert-True '3d 已知假阳性形态被钉住：`售价€100`（汉字紧贴 €）会响 —— 代价已知，不是"它不会误报"' `
    (@($s3fp.EuroAdjCjk).Count -eq 1) ("命中 {0} 处" -f @($s3fp.EuroAdjCjk).Count)

# ============================================================================
# 场景 4：信号 B1 —— 未替换占位符
# ============================================================================
Write-Host '场景 4：B1 未替换占位符 <ALLCAPS>'

$c4 = New-Case -Case 'b1-pos' -Files @(
    (F 'pr-269-body.md' "📸 真机验证：见评论 <PLACEHOLDER>`n正文第二行`n")
)
$s4 = Invoke-PrBodyScan -Root $c4
Assert-True '4a `<PLACEHOLDER>` 命中 B1（#269 实证：-replace 不命中且不报错，它原样上线了）' `
    ((@($s4.Placeholder).Count -eq 1) -and ($s4.Placeholder[0].Hit -eq '<PLACEHOLDER>')) `
    ("命中 {0} 处" -f @($s4.Placeholder).Count)

$c4neg = New-Case -Case 'b1-neg' -Files @(
    (F 'pr-6-readback.md' "小写 <placeholder> 不算`n短标签 <AB> 不算`n单字母 <A> 不算`n链接 <https://example.invalid/a> 不算`n")
)
$s4neg = Invoke-PrBodyScan -Root $c4neg
Assert-True '4b 负控：小写 / <AB> / <A> / URL 尖括号 全部不命中 B1' `
    (@($s4neg.Placeholder).Count -eq 0) `
    ("命中 {0} 处：{1}" -f @($s4neg.Placeholder).Count, ((@($s4neg.Placeholder) | ForEach-Object { $_.Hit }) -join ','))

# ============================================================================
# 场景 5：信号 B2 —— 📸 证据行的三态
# ============================================================================
Write-Host '场景 5：B2 📸 证据行（待补/TBD/随后补）+ 两个负控'

$c5 = New-Case -Case 'b2-pos' -Files @(
    (F 'pr-7-body.md' "📸 真机验证：降级挂账：#待补`n")
)
$s5 = Invoke-PrBodyScan -Root $c5
Assert-True '5a 📸 行写「待补」⇒ 命中 B2（三态第三态必须是真实 issue 编号）' `
    (@($s5.Evidence).Count -eq 1) ("命中 {0} 处" -f @($s5.Evidence).Count)

# 负控①：同样的词出现在**没有 📸** 的行上 —— 必须不响。这一条防的是把本信号
# 做成全文件扫，那样任何一份含「待补」的调研笔记都会响，随即整道检查被静音。
$c5neg1 = New-Case -Case 'b2-neg-noicon' -Files @(
    (F 'notes.md' "这个结论待补，TBD，随后补一份数据。`n")
)
$s5neg1 = Invoke-PrBodyScan -Root $c5neg1
Assert-True '5b 负控①：非 📸 行上的「待补/TBD/随后补」不响（否则任何笔记都会触发，检查必被静音）' `
    (@($s5neg1.Evidence).Count -eq 0) ("命中 {0} 处" -f @($s5neg1.Evidence).Count)

# 负控②：📸 行填了合规内容 —— 必须不响。
$c5neg2 = New-Case -Case 'b2-neg-ok' -Files @(
    (F 'pr-8-body.md' "📸 真机验证：豁免：纯脚本 + 测试，零 UI 面`n")
)
$s5neg2 = Invoke-PrBodyScan -Root $c5neg2
Assert-True '5c 负控②：📸 行走合规的「豁免」态 ⇒ 不响' `
    (@($s5neg2.Evidence).Count -eq 0) ("命中 {0} 处" -f @($s5neg2.Evidence).Count)

# ============================================================================
# 场景 6：扫描面边界（非递归 / 只 .md）—— 把 lib 文件头写的判据钉成断言
# ============================================================================
Write-Host '场景 6：扫描面边界（子目录不扫 / 非 .md 不扫）'

$c6 = New-Case -Case 'surface' -Files @(
    (F 'pr-10-readback.md'    "正常正文`n"),
    (F 'sub/pr-11-readback.md' "子目录里含 锛 签名字`n"),
    (F 'pr-12-body.txt'        "非 md 里含 锛 签名字`n")
)
$s6 = Invoke-PrBodyScan -Root $c6
Assert-True '6a 只扫顶层：子目录里的 md 不进扫描面（夹具目录因此不会污染默认扫描面）' `
    ((@($s6.Files).Count -eq 1) -and ($s6.Files[0].Name -eq 'pr-10-readback.md')) `
    ("扫到 {0} 个：{1}" -f @($s6.Files).Count, ((@($s6.Files) | ForEach-Object { $_.Name }) -join ','))
Assert-True '6b 只扫 .md：同目录的 .txt 不进扫描面' `
    (@($s6.Signature4).Count -eq 0) ("命中 {0} 处（应为 0，那两个 锛 都在扫描面外）" -f @($s6.Signature4).Count)

# 排序：新的排前面。`_tmp/` 会沉积历次 PR 的正文，限量折叠后**最相关的那几条**
# 不该被陈年文件挤掉。这一条钉住"谁先被看见"（改回按名字排即红）。
$c6ord = New-Case -Case 'order' -Files @(
    (F 'aaa-oldest.md' "旧`n"), (F 'zzz-newest.md' "新`n")
)
# 显式拉开时间戳，不依赖写入先后（同一秒写出时次级键才是 Name）。
(Get-Item (Join-Path $c6ord 'aaa-oldest.md')).LastWriteTime = (Get-Date).AddDays(-30)
$s6ord = Invoke-PrBodyScan -Root $c6ord
Assert-True '6d 扫描面按修改时间倒序：新文件排第一（陈年文件不该挤掉本批的记录）' `
    ((@($s6ord.Files).Count -eq 2) -and ($s6ord.Files[0].Name -eq 'zzz-newest.md')) `
    ("顺序：{0}" -f ((@($s6ord.Files) | ForEach-Object { $_.Name }) -join ' → '))

$c6art = New-Case -Case 'artifact-name' -Files @(
    (F 'pr-13-readback.md' "a`n"), (F 'pr-body-slug.md' "b`n"), (F 'random-note.md' "c`n")
)
$s6art = Invoke-PrBodyScan -Root $c6art
Assert-True '6c 像不像 PR 正文/回读记录被分开计数（让「扫了 3 个但没一个是回读记录」说得出来）' `
    (($s6art.ArtifactCount -eq 2) -and (@($s6art.Files).Count -eq 3)) `
    ("Artifact={0} / Files={1}" -f $s6art.ArtifactCount, @($s6art.Files).Count)

# ============================================================================
# 场景 7：闸位 —— 观察线恒 exit 0，且输出必须自陈近似与射程
# ============================================================================
Write-Host '场景 7：闸位（有命中也恒 exit 0）+ 输出自陈'

$c7 = New-Case -Case 'gate' -Files @(
    (F 'pr-14-readback.md' "含 锛 与 <PLACEHOLDER> 与 杩欐槸浠€涔?`n📸 真机验证：待补`n")
)
$r7 = Invoke-Check -Root $c7
Assert-True '7a 四个信号全部命中时退出码**仍为 0**（观察线不阻断，判据最后一步在人手里）' `
    ($r7.ExitCode -eq 0) ("exit={0}" -f $r7.ExitCode)
Assert-True '7b 四个信号确实都响了（否则 7a 只是"没东西可报"）' `
    (($r7.Text -match 'A1 \[') -and ($r7.Text -match 'A2') -and `
     ($r7.Text -match 'B1') -and ($r7.Text -match 'B2')) ''
Assert-True '7c 有命中时打印近似声明（零命中或有意引用的样例——禁把近似说成判定）' `
    ($r7.Text -match '判据是近似') ''
Assert-True '7d **每次**打印射程行（零命中 ≠ 编码一定对；n=4 里两例本检查看不见）' `
    (($r7.Text -match '零命中 ≠ 编码一定对') -and ($r1has.Text -match '零命中 ≠ 编码一定对')) ''

# 摘录必须**含命中本身**。真实数据实测：乱码常出现在长行的中后段，从行首截 72 字
# 的摘录里一个异常字符都看不到——一个"指出问题在哪"的工具，摘录里不含问题本身
# 等于没指。这一条钉住那个修法（改回从行首截即红）。
$longPrefix = ('正常前缀内容。' * 12)
$c7long = New-Case -Case 'excerpt' -Files @((F 'pr-18-readback.md' ($longPrefix + '尾部含 锛 签名字' + "`n")))
$r7long = Invoke-Check -Root $c7long
$s7long = Invoke-PrBodyScan -Root $c7long
Assert-True '7h 长行的摘录以命中为中心，屏幕上看得见那个签名字（从行首截即红）' `
    ($r7long.Text -match '〔命中「锛」〕[^\r\n]*锛') ''
Assert-True '7i Get-PrBodyExcerpt 纯函数：短行原样返回 / 长行两端加省略号且含命中' `
    ((( Get-PrBodyExcerpt -Line 'abc' -Index 1) -eq 'abc') -and `
     ((Get-PrBodyExcerpt -Line $s7long.Signature4[0].Line -Index $s7long.Signature4[0].Index) -match '锛')) ''

$c7many = New-Case -Case 'gate-many' -Files @(
    (F 'pr-15-readback.md' ((1..8 | ForEach-Object { "第 $_ 行含 锛 签名字" }) -join "`n"))
)
$r7cap = Invoke-Check -Root $c7many -MaxList 3
$r7all = Invoke-Check -Root $c7many -MaxList 0
Assert-True '7e 条数始终全量（8 处），限量只折叠明细行' `
    ($r7cap.Text -match '命中 8 处') ''
Assert-True '7f 限量 3 ⇒ 打印折叠口径（读的人要知道自己只看到了一部分）' `
    ($r7cap.Text -match '只列前 3/8 条') ''
Assert-True '7g -MaxListPerSignal 0 = 不限量 ⇒ 无折叠口径行' `
    (-not ($r7all.Text -match '只列前')) ''

# ============================================================================
# 场景 8：接线检查（静态扫描 verify-all.ps1）
# ============================================================================
# **这一段是本文件里唯一的文本匹配型断言，故它对 mutation ②（保留字面但不执行）
# 天然脆弱**——条款库对抗验证官节实证：出处仓 14 份读源码文本做断言的守护里
# **8 份对「注释掉」形态失明**，而其中多份的 footer 还写着「已 mutation 验证」。
#
# 应对：不做文本行过滤，直接用 **PowerShell 自己的解析器**取 token 流并剔除
# Comment token。于是 `#` 行注释与块注释**两种**注释掉的形态都会让
# 8e 变红——这一档比"剥掉以 # 开头的行"强，后者对块注释仍然失明。
# 顺带白拿一条：解析器同时给出语法错误，被测两个脚本的**可解析性**因此也被钉住。
#
# **仍然剥不掉的（照直写，不假称已覆盖）**：把整段挪进一个永不执行的 `if ($false)`
# 分支——token 流里那几个字照样在，本段仍会绿。
# 真判别力在 mutation 记录（见 PR），本段只是"接线还在不在"的第一道近似。
#
# ⚠ **2026-08-02 上移时删掉了原 8b/8c/8d 三条**：它们扫的是 mousse-cli
# `verify-all.ps1` 的 `$checks` 数组 —— **那是调用方的接线，不是判据的契约**，
# 跟着判据搬到 dao 会变成一条永远找不到被扫对象的断言（而"找不到"与"扫过了没问题"
# 在文本匹配里长得一样，正是本文件通篇在防的病）。那三条留在 mousse 侧的
# `scripts/test-pr-body-scan.ps1`，那里才有 `verify-all.ps1`。
Write-Host '场景 8：静态扫描（判据库自身契约；调用方接线归调用方的测试）'

function Get-CodeOnlyText {
    <#
      用 PowerShell 解析器取「剔掉注释之后的代码 token 文本」。
      返回 `{ Text; ParseErrors }`。token 间以单空格连接：布局丢了，但本段的断言
      问的是"这几个 token 在不在、挨不挨着"，不问缩进。
    #>
    param([string]$Path)
    $tokens = $null
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    $code = @($tokens | Where-Object { $_.Kind -ne 'Comment' } | ForEach-Object { $_.Text })
    return [PSCustomObject]@{ Text = ($code -join ' '); ParseErrors = @($errors) }
}

$chk = Get-CodeOnlyText -Path $targetPs1
$lib = Get-CodeOnlyText -Path $libPs1

Assert-True '8a 两个被测脚本都能被 PowerShell 解析器解析（零语法错误）' `
    ((@($chk.ParseErrors).Count -eq 0) -and (@($lib.ParseErrors).Count -eq 0)) `
    ("check={0} lib={1}" -f @($chk.ParseErrors).Count, @($lib.ParseErrors).Count)
Assert-True '8e check-pr-body-mojibake.ps1 dot-source 了判据库（否则判据会被抄成第二份）' `
    ($chk.Text -match 'lib/pr-body-scan\.ps1') ''
# 判据库里**调用** Get-Content 会让它在读进来的那一刻制造出自己要报的乱码
# （自证式假阳性）。用 token 流判"有没有这个命令"，注释里怎么写都不影响——
# 而文件头 .NOTES 里恰恰要拿它举例，纯文本匹配在这里必然误报（首版就是这么红的）。
Assert-True '8f 判据库的**代码**里不出现 Get-Content（它正是本检查要检的那个病的成因）' `
    (-not ($lib.Text -match 'Get-Content')) ''
# 8g/8h 是本次上移**新加**的两条，防的是「搬上来之后又被人悄悄写回项目耦合」：
# canonical 一旦出现某个具体项目的目录名/仓名，它就不再是 canonical 了，
# 而那一刻**没有任何东西会变红**——正是「规则集只增不减」同族的静默腐坏。
$projectFingerprints = @('crates/mousse-app', 'src-ui', 'mousse-cli/scripts/', 'D:/frank', 'D:\frank')
$fpHitChk = @($projectFingerprints | Where-Object { $chk.Text -like ('*' + $_ + '*') })
$fpHitLib = @($projectFingerprints | Where-Object { $lib.Text -like ('*' + $_ + '*') })
Assert-True '8g canonical 的**代码** token 里不含任何具体项目指纹（注释里可以有出处）' `
    (($fpHitChk.Count -eq 0) -and ($fpHitLib.Count -eq 0)) `
    ("check命中={0} lib命中={1}" -f ($fpHitChk -join '|'), ($fpHitLib -join '|'))
Assert-True '8h 仓根指纹是参数（-RepoSignature）而不是写死的数组' `
    ($chk.Text -match '\$RepoSignature') ''

# ---- 汇总 -------------------------------------------------------------------
Write-Host ''
Write-Host '=============================================='
Write-Host '          test-pr-body-scan 汇总'
Write-Host '=============================================='
$failing = @($results | Where-Object { $_.Status -ne 'PASS' })
foreach ($r in $results) { Write-Host ("  {0,-6} {1}" -f $r.Status, $r.Name) }
Write-Host '=============================================='
if ($failing.Count -gt 0) {
    Write-Host ("test-pr-body-scan 失败：{0}/{1} 项未通过" -f $failing.Count, $results.Count)
    exit 1
}
Write-Host ("test-pr-body-scan 全部通过（{0} 项）。" -f $results.Count)
exit 0
