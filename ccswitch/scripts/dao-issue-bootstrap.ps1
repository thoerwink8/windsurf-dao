#requires -Version 5.1
<#
.SYNOPSIS
    issue 派单中枢一键引导：建全套标签 + 建常设总览单并置顶 + 建六列观测看板。

.DESCRIPTION
    把 dao 的「工作项三态归位」条款（issue=分配中心 / 看板=观测中心 / 文件=叙事层）
    在一个 GitHub 仓库上物化。canonical 数据全部读自 ccswitch/templates/：
      labels.json         —— 标签定义（基础集 + 项目扩展 + 三个 inbox 的措辞）
      project-board.json  —— 看板六列 + 标签→列映射 + 人工步骤清单
      inbox-issue.md      —— 蓄水池 inbox 的 body 骨架（一份服务三个 inbox）
      pinned-hub-issue.md —— 总览 hub 的 body

    **幂等**：每一步先查现状再动作。标签已存在则跳过（差异只报告，除非 -ForceUpdateLabels）；
    单据按标题匹配，存在则跳过；置顶前先查已置顶清单；看板与字段同理。
    重跑一遍应当全是「已存在，跳过」。

    **先跑 -DryRun**。DryRun 只做只读查询（gh label list / issue list / project list /
    graphql query），不发起任何写操作，把「将要做什么」逐条打印出来。

.PARAMETER Repo
    目标仓库，格式 owner/repo。

.PARAMETER ProjectOwner
    看板归属（org 名或 @me）。缺省取 Repo 的 owner 段。

.PARAMETER ProjectTitle
    看板标题。缺省 "<repo 名> 观测中心"。**已有看板时必须传实际标题**，否则会判成「不存在」。

.PARAMETER HubTitle
    总览 hub 的单标题。缺省用 canonical 措辞；已有 hub 而标题不同的仓库传实际标题。
    幂等键是标题，标题差一个字就会被判成「不存在」——这是本脚本的已知弱点，见 .NOTES。

.PARAMETER Extensions
    要建的项目扩展标签名（labels.json 的 labels.extensions）。缺省全建。
    与 -BaseLabelsOnly 互斥。

.PARAMETER BaseLabelsOnly
    只建基础集，不建任何扩展标签。

.PARAMETER ForceUpdateLabels
    已存在但与 canonical 有差异的标签，用 `gh label create --force` 覆盖其颜色与描述。
    缺省**不覆盖**——已有仓库的标签描述往往是被人调过的，静默改写别人的措辞不是幂等是破坏。

.PARAMETER ProgressFile
    项目的流水总账文件名，填进 hub body。缺省 PROGRESS.md。

.PARAMETER BoardFieldName
    看板上承载六列的单选字段名。缺省取 project-board.json 的 field.name。
    **通常不需要传**：脚本判「六列在不在」是按选项集合判的，不是按字段名——
    看板若把内建 `Status` 的选项直接改成六列，照样判为已存在、不会多建一个字段。

.PARAMETER TemplateDir
    canonical 模板目录。缺省 <脚本目录>/../templates。

.PARAMETER WorkDir
    渲染出的 body 文件落点。缺省 <windsurf-dao 根>/_tmp/dao-issue-bootstrap（已 gitignore）。
    body 一律走 `gh ... --body-file`，不经 PowerShell 字符串传给 gh——中文正文过 shell 字符串
    是本体系反复踩过的乱码源。

.PARAMETER IssueScanLimit
    按标题查重时扫描多少张单。缺省 500。仓库单数超过它且目标单很老时会误判成「不存在」。

.PARAMETER SkipLabels / SkipIssues / SkipProject
    跳过对应阶段。

.EXAMPLE
    # 先看会做什么（只读，安全）
    .\dao-issue-bootstrap.ps1 -Repo myorg/myapp -DryRun

.EXAMPLE
    # 真跑
    .\dao-issue-bootstrap.ps1 -Repo myorg/myapp

.EXAMPLE
    # 已有看板/hub 的仓库：传实际标题，否则会被判成不存在
    .\dao-issue-bootstrap.ps1 -Repo myorg/myapp -ProjectTitle "myapp 观测中心" -HubTitle "📌 总览 · ..." -DryRun

.NOTES
    退出码契约（四态）：
      0  全部动作完成或已存在（DryRun 正常走完也是 0）
      1  前置条件不成立（gh 缺失 / 未登录 / 仓库不可读 / 模板缺失或不可解析）——一步都没做
      2  跑完了但有步骤失败（部分完成，逐条见输出里的 [失败]）
      3  参数非法——一步都没做

    幂等键是**标题**，不是内容。已知弱点：目标单存在但标题差一个字 ⇒ 判成「不存在」⇒ 会建出第二张。
    没有更好的键——GitHub issue 没有稳定的外部标识位可写。缓解手段是 -HubTitle / -ProjectTitle
    两个参数 + **永远先 -DryRun 看一遍**。不为此加「模糊标题匹配」：模糊匹配的失败方向是
    把一张无关的单认成 hub 然后跳过，比多建一张更难发现。

    Projects v2 的「新 issue 自动入板」workflow **没有 API**（REST 与 GraphQL 都没有），
    本脚本不假装能做，把它打印进末尾的人工步骤清单。这一条是诚实记载不是待办。

    PowerShell 5.1 兼容：不用 && / || / 三元 / ?? / ?.；成败一律看 $LASTEXITCODE 不看输出文案；
    不用 2>&1（会把 gh 的正常 stderr 包成 NativeCommandError）。

    真相源：windsurf-dao/ccswitch/scripts/dao-issue-bootstrap.ps1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [string]$ProjectOwner,
    [string]$ProjectTitle,
    [string]$HubTitle = '📌 总览 · 从这里一眼对齐全局（看板 + 收件箱 + 在途）',
    [string[]]$Extensions,
    [switch]$BaseLabelsOnly,
    [switch]$ForceUpdateLabels,
    [string]$ProgressFile = 'PROGRESS.md',
    [string]$BoardFieldName,
    [string]$TemplateDir,
    [string]$WorkDir,
    [int]$IssueScanLimit = 500,
    [switch]$DryRun,
    [switch]$SkipLabels,
    [switch]$SkipIssues,
    [switch]$SkipProject
)

$ErrorActionPreference = 'Stop'

# ── 输出与计数 ───────────────────────────────────────────────────────────────
$script:Failures = 0
$script:Planned = 0
$script:Done = 0
$script:Skipped = 0

function Write-Head([string]$t) { Write-Host ''; Write-Host ("=== $t ===") -ForegroundColor Cyan }
function Write-Ok([string]$t) { $script:Done++; Write-Host ("  [完成] $t") -ForegroundColor Green }
function Write-Skip2([string]$t) { $script:Skipped++; Write-Host ("  [跳过] $t") -ForegroundColor DarkGray }
function Write-Plan([string]$t) { $script:Planned++; Write-Host ("  [将做] $t") -ForegroundColor Yellow }
function Write-Note([string]$t) { Write-Host ("  [注意] $t") -ForegroundColor Yellow }
function Write-Info([string]$t) { Write-Host ("         $t") -ForegroundColor DarkGray }
function Write-Fail2([string]$t) { $script:Failures++; Write-Host ("  [失败] $t") -ForegroundColor Red }

# ── gh 调用（不 2>&1；成败只看 $LASTEXITCODE）────────────────────────────────
function Invoke-Gh {
    param([string[]]$GhArgs)
    $out = & gh @GhArgs
    return [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Code = $LASTEXITCODE; Out = $out }
}

function Invoke-GhJson {
    param([string[]]$GhArgs)
    $r = Invoke-Gh -GhArgs $GhArgs
    if (-not $r.Ok) { return $null }
    $text = ($r.Out -join "`n")
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    try { return ($text | ConvertFrom-Json) } catch { return $null }
}

# ── 文件 IO（禁 Get-Content：PS 5.1 对无 BOM UTF-8 按 ANSI 读，中文必毁）─────
function Read-Utf8([string]$Path) { return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) }
function Write-Utf8([string]$Path, [string]$Text) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, $Text, $enc)
}
function Read-JsonFile([string]$Path) { return (Read-Utf8 $Path | ConvertFrom-Json) }

function Expand-Placeholder([string]$Text, [hashtable]$Map) {
    $s = $Text
    foreach ($k in $Map.Keys) {
        $v = $Map[$k]
        if ($null -eq $v) { $v = '' }
        # 字面替换，不走 -replace 正则：占位符里的 < > 与项目填的判据文本都可能带正则元字符
        $s = $s.Replace([string]$k, [string]$v)
    }
    return $s
}

function Remove-LeadingComment([string]$Text) {
    return [regex]::Replace($Text, '(?s)^\s*<!--.*?-->\s*', '')
}

# ── 参数校验 ─────────────────────────────────────────────────────────────────
Write-Head 'dao issue 派单中枢引导'
if ($DryRun) { Write-Host '  模式：DRY-RUN（只读查询，不做任何写操作）' -ForegroundColor Magenta }
else { Write-Host '  模式：实跑（会在目标仓库建标签 / 建单 / 置顶 / 建看板）' -ForegroundColor Magenta }

if ($Repo -notmatch '^[^/\s]+/[^/\s]+$') {
    Write-Fail2 "-Repo 格式应为 owner/repo，实收：$Repo"
    exit 3
}
if ($BaseLabelsOnly -and $Extensions) {
    Write-Fail2 '-BaseLabelsOnly 与 -Extensions 互斥'
    exit 3
}
$repoOwner = $Repo.Split('/')[0]
$repoName = $Repo.Split('/')[1]
if (-not $ProjectOwner) { $ProjectOwner = $repoOwner }
if (-not $ProjectTitle) { $ProjectTitle = "$repoName 观测中心" }
if (-not $TemplateDir) { $TemplateDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'templates' }
if (-not $WorkDir) { $WorkDir = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '_tmp\dao-issue-bootstrap' }

Write-Info "仓库=$Repo  看板归属=$ProjectOwner  看板标题=$ProjectTitle"
Write-Info "模板目录=$TemplateDir"

# ── 前置检查（任一不过即 exit 1，一步都不做）─────────────────────────────────
Write-Head '前置检查'

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Fail2 '找不到 gh（GitHub CLI）→ https://cli.github.com/'
    exit 1
}
Write-Ok 'gh 可用'

$auth = Invoke-Gh -GhArgs @('auth', 'status')
if (-not $auth.Ok) {
    Write-Fail2 'gh 未登录 → 运行 `gh auth login`'
    exit 1
}
Write-Ok 'gh 已登录'

$repoInfo = Invoke-GhJson -GhArgs @('repo', 'view', $Repo, '--json', 'name,owner,url')
if ($null -eq $repoInfo) {
    Write-Fail2 "读不到仓库 $Repo（不存在 / 无权限 / 网络）"
    exit 1
}
Write-Ok "仓库可读：$($repoInfo.url)"

$pathLabels = Join-Path $TemplateDir 'labels.json'
$pathBoard = Join-Path $TemplateDir 'project-board.json'
$pathInbox = Join-Path $TemplateDir 'inbox-issue.md'
$pathHub = Join-Path $TemplateDir 'pinned-hub-issue.md'
foreach ($p in @($pathLabels, $pathBoard, $pathInbox, $pathHub)) {
    if (-not (Test-Path -LiteralPath $p)) {
        Write-Fail2 "缺 canonical 模板：$p"
        exit 1
    }
}
try {
    $LABELS = Read-JsonFile $pathLabels
    $BOARD = Read-JsonFile $pathBoard
}
catch {
    Write-Fail2 ("canonical JSON 解析失败：" + $_.Exception.Message)
    exit 1
}
$TPL_INBOX = Remove-LeadingComment (Read-Utf8 $pathInbox)
$TPL_HUB = Remove-LeadingComment (Read-Utf8 $pathHub)
Write-Ok "canonical 模板 4 份已载入（标签基础集 $($LABELS.labels.base.Count) 个 / 扩展 $($LABELS.labels.extensions.Count) 个 / 看板 $($BOARD.columns.Count) 列）"

$extTargets = @()
if ($BaseLabelsOnly) {
    Write-Info '（-BaseLabelsOnly：不建任何扩展标签）'
}
elseif ($Extensions) {
    $known = @($LABELS.labels.extensions | ForEach-Object { $_.name })
    foreach ($e in $Extensions) {
        if ($known -notcontains $e) {
            Write-Fail2 "-Extensions 里的 `"$e`" 不是 labels.json 里的扩展标签（合法值：$($known -join '/')）"
            exit 3
        }
    }
    $extTargets = @($LABELS.labels.extensions | Where-Object { $Extensions -contains $_.name })
}
else {
    $extTargets = @($LABELS.labels.extensions)
}

if (-not $DryRun) {
    if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
}

# ── 阶段一：标签 ─────────────────────────────────────────────────────────────
if ($SkipLabels) {
    Write-Head '阶段一 · 标签（-SkipLabels 跳过）'
}
else {
    Write-Head '阶段一 · 标签'
    $existingLabels = Invoke-GhJson -GhArgs @('label', 'list', '--repo', $Repo, '--json', 'name,color,description', '--limit', '200')
    if ($null -eq $existingLabels) { $existingLabels = @() }

    $labelTargets = @($LABELS.labels.base) + $extTargets
    foreach ($lb in $labelTargets) {
        $cur = $existingLabels | Where-Object { $_.name -eq $lb.name } | Select-Object -First 1
        if ($null -ne $cur) {
            $diff = @()
            if ($cur.color -ne $lb.color) { $diff += "颜色 $($cur.color) → $($lb.color)" }
            if ($cur.description -ne $lb.description) { $diff += '描述不同' }
            if ($diff.Count -eq 0) {
                Write-Skip2 "标签 ``$($lb.name)`` —— 已存在且与 canonical 一致"
                continue
            }
            if (-not $ForceUpdateLabels) {
                Write-Skip2 "标签 ``$($lb.name)`` —— 已存在，跳过（与 canonical 有差异：$($diff -join '；')；要对齐加 -ForceUpdateLabels）"
                continue
            }
            if ($DryRun) { Write-Plan "更新标签 ``$($lb.name)``（$($diff -join '；')）"; continue }
            $r = Invoke-Gh -GhArgs @('label', 'create', $lb.name, '--repo', $Repo, '--color', $lb.color, '--description', $lb.description, '--force')
            if ($r.Ok) { Write-Ok "标签 ``$($lb.name)`` 已更新" } else { Write-Fail2 "标签 ``$($lb.name)`` 更新失败（gh exit $($r.Code)）" }
            continue
        }
        if ($DryRun) { Write-Plan "建标签 ``$($lb.name)``（$($lb.color)）：$($lb.description)"; continue }
        $r = Invoke-Gh -GhArgs @('label', 'create', $lb.name, '--repo', $Repo, '--color', $lb.color, '--description', $lb.description, '--force')
        if ($r.Ok) { Write-Ok "标签 ``$($lb.name)`` 已建" } else { Write-Fail2 "标签 ``$($lb.name)`` 建失败（gh exit $($r.Code)）" }
    }
}

# ── 阶段二：常设单 + 置顶 ────────────────────────────────────────────────────
$issueNumbers = @{}   # 池标签名 / '_hub' → 编号
if ($SkipIssues) {
    Write-Head '阶段二 · 常设单与置顶（-SkipIssues 跳过）'
}
else {
    Write-Head '阶段二 · 常设单（蓄水池 inbox × N + 总览 hub）'
    $existingIssues = Invoke-GhJson -GhArgs @('issue', 'list', '--repo', $Repo, '--state', 'all', '--limit', "$IssueScanLimit", '--json', 'number,title')
    if ($null -eq $existingIssues) { $existingIssues = @() }
    Write-Info "已扫描 $(@($existingIssues).Count) 张单用于标题查重（上限 $IssueScanLimit）"

    $snapshot = (Get-Date).ToString('yyyy-MM-dd')
    $pools = @($LABELS.labels.base | Where-Object { $_.pool -eq $true })

    foreach ($pl in $pools) {
        $ib = $pl.inbox
        $existing = $existingIssues | Where-Object { $_.title -eq $ib.title } | Select-Object -First 1
        if ($null -ne $existing) {
            $issueNumbers[$pl.name] = $existing.number
            Write-Skip2 "常设单「$($ib.title)」—— 已存在（#$($existing.number)），跳过"
            continue
        }

        $cols = @($ib.table_columns)
        $sep = (@(1..$cols.Count) | ForEach-Object { '---' }) -join '|'
        $pad = ''
        if ($cols.Count -gt 2) { $pad = (' |' * ($cols.Count - 2)) }
        $labelQuery = 'https://github.com/' + $Repo + '/issues?q=is%3Aopen+label%3A' + [uri]::EscapeDataString($pl.name)
        $body = Expand-Placeholder $TPL_INBOX @{
            '<INBOX_ONE_LINER>'        = $ib.one_liner
            '<INBOX_HOW_TO_USE>'       = $ib.how_to_use
            '<INBOX_EXTRA_NOTE>'       = $ib.extra_note
            '<INBOX_LABEL>'            = $pl.name
            '<INBOX_LABEL_QUERY_URL>'  = $labelQuery
            '<INBOX_TABLE_HEADER>'     = ($cols -join ' | ')
            '<INBOX_TABLE_SEP>'        = $sep
            '<INBOX_TABLE_PAD>'        = $pad
            '<SNAPSHOT_DATE>'          = $snapshot
        }

        if ($DryRun) {
            Write-Plan "建常设单「$($ib.title)」+ 打标 ``$($pl.name)``$(if ($ib.pinned) { ' + 置顶' } else { '' })"
            continue
        }
        $bodyFile = Join-Path $WorkDir ('inbox-' + $pl.name + '.md')
        Write-Utf8 $bodyFile $body
        $r = Invoke-GhJson -GhArgs @('issue', 'create', '--repo', $Repo, '--title', $ib.title, '--body-file', $bodyFile, '--label', $pl.name)
        if ($null -eq $r) {
            # gh issue create 成功时打印 URL 而非 JSON；重查一次拿编号
            $again = Invoke-GhJson -GhArgs @('issue', 'list', '--repo', $Repo, '--state', 'all', '--limit', '30', '--json', 'number,title')
            $hit = $again | Where-Object { $_.title -eq $ib.title } | Select-Object -First 1
            if ($null -ne $hit) { $issueNumbers[$pl.name] = $hit.number; Write-Ok "常设单「$($ib.title)」已建（#$($hit.number)）" }
            else { Write-Fail2 "常设单「$($ib.title)」建单结果未确认——去仓库看一眼再重跑" }
        }
    }

    # 总览 hub（最后建：body 要引用上面几张单的真实编号）
    $hubExisting = $existingIssues | Where-Object { $_.title -eq $HubTitle } | Select-Object -First 1
    if ($null -ne $hubExisting) {
        $issueNumbers['_hub'] = $hubExisting.number
        Write-Skip2 "总览 hub「$HubTitle」—— 已存在（#$($hubExisting.number)），跳过"
    }
    else {
        function Get-Ref([string]$k) {
            if ($issueNumbers.ContainsKey($k)) { return '#' + $issueNumbers[$k] }
            return '#待定'
        }
        $projUrl = "https://github.com/orgs/$ProjectOwner/projects/?query=$([uri]::EscapeDataString($ProjectTitle))"
        $hubBody = Expand-Placeholder $TPL_HUB @{
            '<PINNED_DECISION_ISSUE>' = (Get-Ref '待拍板')
            '<PINNED_USER_ISSUE>'     = (Get-Ref '需用户')
            '<CANDIDATE_HUB_ISSUE>'   = (Get-Ref '候选')
            '<PROJECT_TITLE>'         = $ProjectTitle
            '<PROJECT_URL>'           = $projUrl
            '<OWNER>'                 = $repoOwner
            '<REPO>'                  = $repoName
            '<PROGRESS_FILE>'         = $ProgressFile
        }
        if ($DryRun) {
            Write-Plan "建总览 hub「$HubTitle」+ 置顶"
            Write-Note 'DryRun 下 hub body 里的收件箱编号只能填「#待定」——它们要等上面几张单真建出来才有号；实跑时按真号填。'
        }
        else {
            $hubFile = Join-Path $WorkDir 'pinned-hub.md'
            Write-Utf8 $hubFile $hubBody
            $r = Invoke-Gh -GhArgs @('issue', 'create', '--repo', $Repo, '--title', $HubTitle, '--body-file', $hubFile)
            if ($r.Ok) {
                $again = Invoke-GhJson -GhArgs @('issue', 'list', '--repo', $Repo, '--state', 'all', '--limit', '30', '--json', 'number,title')
                $hit = $again | Where-Object { $_.title -eq $HubTitle } | Select-Object -First 1
                if ($null -ne $hit) { $issueNumbers['_hub'] = $hit.number; Write-Ok "总览 hub 已建（#$($hit.number)）" }
                else { Write-Fail2 '总览 hub 建单结果未确认' }
            }
            else { Write-Fail2 "总览 hub 建单失败（gh exit $($r.Code)）" }
        }
        Write-Note "hub body 里的看板链接是按标题拼的搜索地址；看板建好后把它换成真实 URL（重跑本脚本不会改已建的 body）。"
    }

    # 置顶：GitHub 每仓上限 3 个，按「待拍板 → 需用户 → hub」顺序
    Write-Head '阶段二.5 · 置顶（gh api graphql · pinIssue mutation）'
    $qPinned = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pinnedIssues(first:3){nodes{issue{number title}}}}}'
    $pinnedResp = Invoke-GhJson -GhArgs @('api', 'graphql', '-f', "query=$qPinned", '-f', "owner=$repoOwner", '-f', "name=$repoName")
    $pinnedNums = @()
    if ($null -ne $pinnedResp) {
        foreach ($n in $pinnedResp.data.repository.pinnedIssues.nodes) { $pinnedNums += $n.issue.number }
    }
    Write-Info ("当前已置顶：" + $(if ($pinnedNums.Count -gt 0) { ($pinnedNums | ForEach-Object { "#$_" }) -join ' ' } else { '（无）' }) + "  上限 3")

    $pinOrder = @()
    foreach ($pl in @($LABELS.labels.base | Where-Object { $_.pool -eq $true -and $_.inbox.pinned -eq $true })) {
        $pinOrder += [pscustomobject]@{ Key = $pl.name; Label = $pl.inbox.title }
    }
    $pinOrder += [pscustomobject]@{ Key = '_hub'; Label = $HubTitle }

    foreach ($p in $pinOrder) {
        if (-not $issueNumbers.ContainsKey($p.Key)) {
            if ($DryRun) { Write-Plan "置顶「$($p.Label)」（DryRun 下该单尚未建出，编号未知）" }
            else { Write-Fail2 "置顶「$($p.Label)」跳过——拿不到编号" }
            continue
        }
        $num = $issueNumbers[$p.Key]
        if ($pinnedNums -contains $num) { Write-Skip2 "#$num「$($p.Label)」—— 已置顶，跳过"; continue }
        if ($pinnedNums.Count -ge 3) {
            Write-Fail2 "#$num「$($p.Label)」置不了顶——已有 3 个置顶单（上限）。先在网页取消一个，或确认该槽位该给谁。"
            continue
        }
        if ($DryRun) { Write-Plan "置顶 #$num「$($p.Label)」"; $pinnedNums += $num; continue }
        $node = Invoke-GhJson -GhArgs @('issue', 'view', "$num", '--repo', $Repo, '--json', 'id')
        if ($null -eq $node) { Write-Fail2 "#$num 取 node id 失败，置顶跳过"; continue }
        $mPin = 'mutation($id:ID!){pinIssue(input:{issueId:$id}){issue{number}}}'
        $r = Invoke-Gh -GhArgs @('api', 'graphql', '-f', "query=$mPin", '-f', "id=$($node.id)")
        if ($r.Ok) { Write-Ok "#$num「$($p.Label)」已置顶"; $pinnedNums += $num }
        else { Write-Fail2 "#$num 置顶失败（gh exit $($r.Code)）" }
    }
}

# ── 阶段三：看板 ─────────────────────────────────────────────────────────────
if ($SkipProject) {
    Write-Head '阶段三 · 观测看板（-SkipProject 跳过）'
}
else {
    Write-Head '阶段三 · 观测看板（Projects v2）'
    $projects = Invoke-GhJson -GhArgs @('project', 'list', '--owner', $ProjectOwner, '--format', 'json', '--limit', '100')
    if ($null -eq $projects) {
        Write-Fail2 "读不到 $ProjectOwner 的 Projects —— 多半是 token 缺 project scope，跑一次：gh auth refresh -s project"
    }
    else {
        $proj = $projects.projects | Where-Object { $_.title -eq $ProjectTitle } | Select-Object -First 1
        $projNumber = $null
        if ($null -ne $proj) {
            $projNumber = $proj.number
            Write-Skip2 "看板「$ProjectTitle」—— 已存在（#$projNumber $($proj.url)），跳过"
        }
        elseif ($DryRun) {
            Write-Plan "建看板「$ProjectTitle」（owner=$ProjectOwner）"
            Write-Note "若目标仓库其实已有看板但标题不同，这里会误报「将建」——传 -ProjectTitle `"<实际标题>`" 再跑一次。"
        }
        else {
            $created = Invoke-GhJson -GhArgs @('project', 'create', '--owner', $ProjectOwner, '--title', $ProjectTitle, '--format', 'json')
            if ($null -eq $created) { Write-Fail2 '建看板失败' }
            else { $projNumber = $created.number; Write-Ok "看板已建（#$projNumber $($created.url)）" }
        }

        $fieldName = $BOARD.field.name
        if ($BoardFieldName) { $fieldName = $BoardFieldName }
        $optionList = (@($BOARD.columns | Sort-Object order | ForEach-Object { $_.name }) -join ',')

        if ($null -eq $projNumber) {
            if ($DryRun) {
                Write-Plan "在新看板上建单选字段「$fieldName」，选项：$optionList"
                Write-Plan "把看板 link 到仓库 $Repo（让它出现在仓库的 Projects 标签页）"
            }
        }
        else {
            $fields = Invoke-GhJson -GhArgs @('project', 'field-list', "$projNumber", '--owner', $ProjectOwner, '--format', 'json')
            # 幂等判据取「六列这组选项在不在」，不取「叫这个名字的字段在不在」——
            # 看板可以把内建的 Status 字段选项直接改成六列（首个实例走的正是这条路），
            # 那时按名字查会判成「不存在」而多建一个字段，板上并排两个状态字段。
            $hasField = $false
            $hitFieldName = ''
            $wantOpts = @($BOARD.columns | Sort-Object order | ForEach-Object { $_.name })
            if ($null -ne $fields) {
                foreach ($f in $fields.fields) {
                    if ($f.name -eq $fieldName) { $hasField = $true; $hitFieldName = $f.name; break }
                    if ($null -ne $f.options) {
                        $got = @($f.options | ForEach-Object { $_.name })
                        $missing = @($wantOpts | Where-Object { $got -notcontains $_ })
                        if ($missing.Count -eq 0) { $hasField = $true; $hitFieldName = $f.name; break }
                    }
                }
            }
            if ($hasField) {
                if ($hitFieldName -eq $fieldName) { Write-Skip2 "单选字段「$fieldName」—— 已存在，跳过" }
                else { Write-Skip2 "六列已存在于字段「$hitFieldName」（不叫「$fieldName」但选项齐全）—— 跳过，不再多建一个状态字段" }
            }
            elseif ($DryRun) { Write-Plan "建单选字段「$fieldName」，选项：$optionList" }
            else {
                $r = Invoke-Gh -GhArgs @('project', 'field-create', "$projNumber", '--owner', $ProjectOwner, '--name', $fieldName, '--data-type', 'SINGLE_SELECT', '--single-select-options', $optionList)
                if ($r.Ok) { Write-Ok "单选字段「$fieldName」已建（$optionList）" } else { Write-Fail2 "建字段失败（gh exit $($r.Code)）" }
            }

            if ($DryRun) { Write-Plan "把看板 #$projNumber link 到仓库 $Repo（已 link 则无副作用）" }
            else {
                $r = Invoke-Gh -GhArgs @('project', 'link', "$projNumber", '--owner', $ProjectOwner, '--repo', $Repo)
                if ($r.Ok) { Write-Ok "看板已 link 到 $Repo" } else { Write-Skip2 "link 未生效（多半是已 link；gh exit $($r.Code)）" }
            }
        }

        Write-Info '标签 → 列映射（判据可机械化 ≠ GitHub 会自动放进去，见下方人工步骤）：'
        foreach ($c in ($BOARD.columns | Sort-Object order)) {
            $how = '手动'
            if ($c.auto -eq $true) {
                if ($c.source -eq 'state') { $how = "state=$($c.match.state)" }
                elseif ($c.source -eq 'label') { $how = "label ∈ [$(@($c.match.labels_any) -join ', ')]" }
                elseif ($c.source -eq 'label-combo') { $how = "open ∧ label ∈ [$(@($c.match.labels_any) -join ', ')] ∧ 无 [$(@($c.match.labels_none) -join ', ')]" }
            }
            Write-Info ("  $($c.order). $($c.name.PadRight(4)) ← $how")
        }
    }
}

# ── 人工步骤清单（脚本做不到的，逐条列出而不是假装做了）──────────────────────
Write-Head '人工步骤清单（这些 gh CLI 做不了，需要你在网页点一次）'
$i = 0
foreach ($ms in $BOARD.manual_steps) {
    $i++
    $how = $ms.how.Replace('<OWNER>', $repoOwner).Replace('<REPO>', $repoName)
    Write-Host ("  $i) $($ms.title)（约 $($ms.minutes) 分钟）") -ForegroundColor White
    Write-Host ("     为什么：$($ms.why)") -ForegroundColor DarkGray
    Write-Host ("     怎么做：$how") -ForegroundColor DarkGray
}
$i++
Write-Host ("  $i) 派生项目侧 playbook：把 canonical ``$TemplateDir\dispatch-hub.template.md`` 复制成本项目的 ``docs/ops/DISPATCH-HUB.md``，") -ForegroundColor White
Write-Host ('     填掉所有 <大写占位符>（尤其 §二.5 那两格判据——空着等于 `真机`/`守卫类` 两个标签没生效）。') -ForegroundColor DarkGray
Write-Host ('     scaffold-manifest 的 dispatch-hub-playbook 条目按这个路径核对。') -ForegroundColor DarkGray
$i++
Write-Host ("  $i) 把上面第 1-$($i-2) 条抄进项目的 ``docs/USER-ACTIONS.md``——") -ForegroundColor White
Write-Host ('     它们是「只有你能做」的事，不落进一个会被翻回来的地方就等于没交接。') -ForegroundColor DarkGray

# ── 汇总 ─────────────────────────────────────────────────────────────────────
Write-Head '汇总'
if ($DryRun) {
    Write-Host "  DRY-RUN：将做 $script:Planned 项 / 已存在跳过 $script:Skipped 项 / 失败 $script:Failures 项" -ForegroundColor Magenta
    Write-Host '  没有任何写操作发生。去掉 -DryRun 即实跑。' -ForegroundColor Magenta
}
else {
    Write-Host "  完成 $script:Done 项 / 已存在跳过 $script:Skipped 项 / 失败 $script:Failures 项" -ForegroundColor Magenta
}
if ($script:Failures -gt 0) {
    Write-Host '  退出码 2：有步骤失败，逐条见上面的 [失败]。' -ForegroundColor Red
    exit 2
}
Write-Host '  退出码 0。' -ForegroundColor Green
exit 0
