<#
.SYNOPSIS
    认领协议：两台机器 / 两个 AI 同时盯一个 issue 队列时，标出「谁在干哪张单」。

.DESCRIPTION
    要防的事：同一个人两台电脑，或者两个 AI 各当一个同事，两边都从同一个队列里领单——
    没有标注，两边会各自开工同一张单，白干一份还可能撞 PR。

    协议只有一层：一条固定格式评论——谁 / 哪台机 / 自报租期，**时间由 GitHub 盖**。
    它是唯一带过期语义的一层。（2026-08-13 issue #360 拍板 2-B：`在途` 标签整个退役，
    它此前兼任的「有人在干」信号位随之取消。不能留半个引用的理由：label 删掉之后
    `-label:在途` 在 gh 搜索里**静默不过滤**——「找不到标签」和「没人认领」在输出里
    逐字节相同，已认领的单会原样回到可领清单，撞车病回归而没有任何东西变红。）

    改这个脚本前必须知道的四条不变量：

    1. **认领的单位是「机器 + 宿主」，不是单个会话，也不是单个 agent。**
       协调者和它派出去的工人跑在同一台机上，共享同一个认领；工人交付**不**释放认领，
       释放（dao-release:）发生在协调者销账那一刻。分组键因此是 `<机器名>/<宿主>` 两格——
       只按机器名分组会产生四种危险答案（同机另一个宿主的撤回把自己的认领一起杀掉 /
       两个宿主各认领一次后发覆盖先发 / 接管指名一个宿主时另一个连坐除名 / 跨宿主冒领续命）。

    2. **时间不自己写。** 租期起算点是 GitHub 给那条评论盖的 createdAt。两台机的本地时钟不共享，
       GitHub 的时钟共享。自报时间戳会被时钟漂移和照抄模板毁掉。这一格没有让步空间。

    3. **拿不准就当它还被持有（fail-safe 方向）。** 解析不出、拿不到时间、格式看不懂 ⇒
       一律判「仍被持有」。误判「可接管」的代价是两路白干加撞 PR；误判「仍被持有」的代价
       只是这一轮少领一张单，而队列里还有别的单。代价不对称，就往便宜那一侧倒。
       同一个方向的两处落点：接管除名要求「旧机器名 + 旧宿主」两格都解析得出才生效；
       解析器只认独立成行、字段合法的标记行。

    4. **没有租期的认领，只是把撞车病换成锁死病，而锁死病更隐蔽。**
       撞车会在 PR 冲突那一刻响，锁死是一张单静静地永远没人领。所以认领必须自己会过期。

    机器面格式（独立成行、纯 ASCII、可以出现在评论正文的任意一行，前后可以有人话）：

        dao-claim:    <机器名>/<宿主>/<自报租期>h
        dao-claim:    <机器名>/<宿主>/<会话短id>/<自报租期>h   ← 同机同宿主开了多个并发会话时必填
        dao-yield:    <机器名>/<宿主> · <原因>
        dao-release:  <机器名>/<宿主> · <原因>
        dao-takeover: <新机器名>/<新宿主> · 原认领 <旧机器名>/<旧宿主> …

    机器名用 hostname 不用手填的别名：hostname 是宿主给的、两台机默认就不同；
    别名要每台机各填一次，而它填错时的失败形态恰好是「两台机自称同名」——
    那正是这套机制唯一防不住的形态。公开仓要脱敏就换成 hostname 的稳定哈希前几位。

    租期：认领方按活的大小自报 N 小时，**N 有一个协议上限**。缺省 4h、上限 8h。
    超上限的活正确形态是拆单或在租期内续租，不是报一个更大的 N。
    续租 = 当前持有人自己重发一条内容不变的 dao-claim:，createdAt 由 GitHub 重新盖。
    别人的评论、机器人评论、心跳对账评论一律**不算**续租——算了就等于把死掉的租约续上。

    过期 ≠ 可抢。过期只解锁接管流程，三步缺一步就是抢单：
      ① 先查盘上有没有活动（那台机在租期内推过东西吗）——有活动 ⇒ 它没死只是忘了续租 ⇒
         不接管，留一条续租提醒就走；
      ② 零活动 ⇒ 留一条 dao-takeover: 评论，**旧的认领评论一个字不动**（历史只增不改）；
      ③ 接管评论落地之后才发自己的 dao-claim:。
    谁可以释放认领（dao-release:）：只有当前认领的那台机（销账时）与走完三步的接管方。
    第三方「顺手代发释放」是禁止的——那恰好抹掉了唯一的撞车证据。

    冲突：先到者胜，判据是 GitHub 的 createdAt，不是本地时间也不是谁手快。
    `gh issue comment` 是追加——两条认领都会成功、都不报错，撞车在写侧完全静默，
    **只有读侧看得见**，所以认领之后必须回读一次。

    什么时候不需要这套：一台机器一个会话的项目——没有第二个认领方可撞，
    「进行到哪」看板列与树备注一眼可见，不必发认领评论。

.PARAMETER Action
    selftest  纯函数自测（不碰网络，唯一可无条件复跑的一档）
    list      领活队列：全列 open 单，被认领的标出持有人（信号只在评论租约里，无 label 位）
    readback  回读某张单，算出每个「机器/宿主」桶当前有效的认领，并判自己该不该让位
    lease     算自己这条租约已经跑了多久

.PARAMETER Issue
    issue 号（readback / lease 必填）

.PARAMETER MyHost
    本机 hostname，缺省取 $env:COMPUTERNAME

.PARAMETER MyRuntime
    本会话的 AI 宿主：cc / codex

.PARAMETER MySession
    本会话自报的短 id；同机同宿主只有一个会话时留空

.NOTES
    退出码：0 = 正常 · 1 = 参数或环境错误 · 2 = 回读发现自己该让位（readback 专用）
    「该让位」刻意不与「出错」合流——它是一个正常的协议结论，不是故障。
#>
[CmdletBinding()]
param(
    [ValidateSet('selftest', 'list', 'readback', 'lease')]
    [string]$Action = 'selftest',
    [int]$Issue,
    [string]$MyHost = $env:COMPUTERNAME,
    [string]$MyRuntime = 'cc',
    [string]$MySession = '',
    [string]$QueueLabel = '任务'
)

$ErrorActionPreference = 'Stop'

# 本脚本打中文，被 node / 别的脚本捕获时按控制台代码页解码会成乱码——把解码钉成 UTF-8。
. (Join-Path $PSScriptRoot '..\lib\console-utf8.ps1')

# 解析：只认「独立成行 + 字段合法」的标记行。
# 裸标记（只写了 dao-claim: 不带字段）、混进散文或表格单元格的引用、带尖括号的占位符示例，
# 一律不命中——这是机器判据，不靠「写的人小心」。字段的合法字符集恰好把尖括号、反引号、
# 中文都挡在外面，而真实 hostname 天然落在这个字符集里。
function Get-DaoMarks {
    param([string]$Body)

    # CRLF 归一化：行尾锚点认的是 LF 语义，`\r` 留在行尾会让整行连「独立成行」这一关都过不去。
    # ⚠ 这是删除不是转换——纯 CR 分行（老 Mac 风格）不在射程内。
    $Body = $Body -replace "`r", ''

    $out = @()
    $pattern = '(?m)^`?dao-(?<kind>claim|yield|takeover|release):(?<rest>[^\r\n`]*)`?[ \t]*$'
    foreach ($m in [regex]::Matches($Body, $pattern)) {
        $rest = $m.Groups['rest'].Value.Trim()
        if (-not $rest) { continue }

        # `·` 之后是给人读的自由文本，之前是机器面
        $head = $rest; $tail = ''
        $dot = $rest.IndexOf([char]0x00B7)
        if ($dot -ge 0) {
            $head = $rest.Substring(0, $dot).Trim()
            $tail = $rest.Substring($dot + 1)
        }

        $f = @($head -split '/' | ForEach-Object { $_.Trim() })
        if ($f.Count -lt 2) { continue }
        if ($f[0] -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$') { continue }
        if ($f[1] -notmatch '^[A-Za-z0-9_-]{1,20}$') { continue }

        $kind = $m.Groups['kind'].Value
        $ok = $false; $session = $null; $hours = $null; $oldHost = $null; $oldRuntime = $null
        switch ($kind) {
            'claim' {
                if ($f.Count -eq 3 -and $f[2] -match '^[1-9][0-9]?h$') {
                    $ok = $true; $hours = $f[2]
                } elseif ($f.Count -eq 4 -and $f[2] -match '^[A-Za-z0-9_-]{1,16}$' -and $f[3] -match '^[1-9][0-9]?h$') {
                    $ok = $true; $session = $f[2]; $hours = $f[3]
                }
            }
            'takeover' {
                if ($f.Count -eq 2) {
                    $ok = $true
                    # 「谁被排除」只在人读详情那半里说得出（机器面本身只有新持有人两格）。
                    # 抓不到就留空，除名逻辑对空值不做排除——宁可漏排除也不误排除。
                    $om = [regex]::Match($tail, '原认领[ \t]+(?<h>[A-Za-z0-9][A-Za-z0-9_-]{0,62})/(?<r>[A-Za-z0-9_-]{1,20})')
                    if ($om.Success) { $oldHost = $om.Groups['h'].Value; $oldRuntime = $om.Groups['r'].Value }
                }
            }
            default { if ($f.Count -eq 2) { $ok = $true } }
        }
        if ($ok) {
            $out += [pscustomobject]@{
                kind = $kind; host = $f[0]; runtime = $f[1]
                session = $session; hours = $hours
                oldHost = $oldHost; oldRuntime = $oldRuntime
            }
        }
    }
    return $out
}

# 每个「机器/宿主」桶各自当前有效的那一条认领。
# 返回 Hashtable：key = `<机器名>/<宿主>`，value = 该桶当前有效认领。
# 「谁该让位」是调用方拿这份逐桶结果自己比 createdAt，本函数只答「每个桶有没有、是哪一条」。
# 已知边界：被接管过的旧桶整桶除名，含它此后再发的任何认领——不支持「旧桶重新走一遍流程合法复活」。
function Get-EffectiveClaim {
    param($Marks)

    $excluded = @{}
    foreach ($mk in $Marks) {
        if ($mk.kind -eq 'takeover' -and $mk.oldHost -and $mk.oldRuntime) {
            $excluded[('{0}/{1}' -f $mk.oldHost, $mk.oldRuntime)] = $true
        }
    }

    $eff = @{}
    $keys = @($Marks | ForEach-Object { '{0}/{1}' -f $_.host, $_.runtime } | Select-Object -Unique)
    foreach ($k in $keys) {
        if ($excluded.ContainsKey($k)) { continue }
        $own = @($Marks | Where-Object { ('{0}/{1}' -f $_.host, $_.runtime) -eq $k })
        for ($i = $own.Count - 1; $i -ge 0; $i--) {
            if ($own[$i].kind -notin @('claim', 'takeover')) { continue }
            $laterRevoke = @($own | Select-Object -Skip ($i + 1) | Where-Object { $_.kind -in @('yield', 'release') })
            if ($laterRevoke.Count -eq 0) { $eff[$k] = $own[$i]; break }
        }
    }
    return $eff
}

# 这条已经确认属于「我这台机 + 我这个宿主」的有效认领，是不是我自己这个会话留下的？
# 只有接力场景（「这是不是我自己的前任」）需要问这件事——它不参与跨机器的碰撞判定。
# 任一侧没填会话 id ⇒ 无数据可比，按单会话旧行为放行。
function Test-IsMySessionClaim {
    param($Claim, [string]$MySession)
    if (-not $Claim) { return $false }
    if (-not $Claim.session -or -not $MySession) { return $true }
    return ($Claim.session -eq $MySession)
}

function Get-IssueMarks {
    param([int]$Number)
    $raw = & gh issue view $Number --json comments
    if ($LASTEXITCODE -ne 0) { throw "gh issue view $Number 失败（退出码 $LASTEXITCODE）" }
    $comments = ($raw | ConvertFrom-Json).comments
    $marks = @()
    foreach ($cm in $comments) {
        foreach ($mk in (Get-DaoMarks -Body $cm.body)) {
            $marks += [pscustomobject]@{
                createdAt = $cm.createdAt; kind = $mk.kind
                host = $mk.host; runtime = $mk.runtime
                session = $mk.session; hours = $mk.hours
                oldHost = $mk.oldHost; oldRuntime = $mk.oldRuntime
            }
        }
    }
    return @($marks | Sort-Object createdAt)
}

function Invoke-SelfTest {
    $script:pass = 0
    $script:fail = 0
    function Check([string]$name, [bool]$cond) {
        if ($cond) { $script:pass++; Write-Host "  PASS  $name" }
        else { $script:fail++; Write-Host "  FAIL  $name" }
    }

    Write-Host "`n=== 解析：只认独立成行 + 字段合法 ==="
    $body = @"
先说人话：我在干这张单。
dao-claim: BOXA/cc/4h
表格里提到 | dao-claim: FAKE/cc/9h | 这一格不算数
"@
    $m = @(Get-DaoMarks -Body $body)
    Check "人话在前、标记独立成行 ⇒ 认得出" ($m.Count -eq 1 -and $m[0].host -eq 'BOXA' -and $m[0].hours -eq '4h')
    Check "混进表格单元格 ⇒ 不命中" (@($m | Where-Object { $_.host -eq 'FAKE' }).Count -eq 0)

    Check "裸标记（不带字段）⇒ 不命中" (@(Get-DaoMarks -Body 'dao-claim:').Count -eq 0)
    Check "尖括号占位符 ⇒ 不命中" (@(Get-DaoMarks -Body 'dao-claim: <机器名>/<宿主>/4h').Count -eq 0)
    Check "CRLF 行尾 ⇒ 照样认得出" (@(Get-DaoMarks -Body "dao-claim: BOXA/cc/4h`r`n").Count -eq 1)
    Check "四字段（带会话 id）⇒ 认得出且拆得开" (
        (@(Get-DaoMarks -Body 'dao-claim: BOXA/cc/t7/4h')[0]).session -eq 't7')

    Write-Host "`n=== 有效认领：分组键是「机器 + 宿主」两格 ==="
    $marks = @(
        [pscustomobject]@{ createdAt = '2026-08-01T01:00:00Z'; kind = 'claim'; host = 'BOXA'; runtime = 'cc';    session = $null; hours = '4h'; oldHost = $null; oldRuntime = $null }
        [pscustomobject]@{ createdAt = '2026-08-01T02:00:00Z'; kind = 'claim'; host = 'BOXA'; runtime = 'codex'; session = $null; hours = '4h'; oldHost = $null; oldRuntime = $null }
        [pscustomobject]@{ createdAt = '2026-08-01T03:00:00Z'; kind = 'yield'; host = 'BOXA'; runtime = 'codex'; session = $null; hours = $null; oldHost = $null; oldRuntime = $null }
    )
    $eff = Get-EffectiveClaim -Marks $marks
    Check "同机另一个宿主撤回，不会连坐杀掉自己的认领" ($eff.ContainsKey('BOXA/cc'))
    Check "撤回过的那个桶不再有有效认领" (-not $eff.ContainsKey('BOXA/codex'))

    $marks2 = @(
        [pscustomobject]@{ createdAt = '2026-08-01T01:00:00Z'; kind = 'claim';    host = 'BOXA'; runtime = 'codex'; session = $null; hours = '4h'; oldHost = $null;  oldRuntime = $null }
        [pscustomobject]@{ createdAt = '2026-08-01T02:00:00Z'; kind = 'claim';    host = 'BOXA'; runtime = 'cc';    session = $null; hours = '4h'; oldHost = $null;  oldRuntime = $null }
        [pscustomobject]@{ createdAt = '2026-08-01T03:00:00Z'; kind = 'takeover'; host = 'BOXB'; runtime = 'cc';    session = $null; hours = $null; oldHost = 'BOXA'; oldRuntime = 'codex' }
    )
    $eff2 = Get-EffectiveClaim -Marks $marks2
    Check "接管指名一个宿主，同机另一个宿主不连坐" ($eff2.ContainsKey('BOXA/cc'))
    Check "被指名接管的那个桶除名" (-not $eff2.ContainsKey('BOXA/codex'))
    Check "接管方自己有一条有效认领" ($eff2.ContainsKey('BOXB/cc'))

    $marks3 = @(
        [pscustomobject]@{ createdAt = '2026-08-01T01:00:00Z'; kind = 'claim';    host = 'BOXA'; runtime = 'codex'; session = $null; hours = '4h'; oldHost = $null;  oldRuntime = $null }
        [pscustomobject]@{ createdAt = '2026-08-01T03:00:00Z'; kind = 'takeover'; host = 'BOXB'; runtime = 'cc';    session = $null; hours = $null; oldHost = 'BOXA'; oldRuntime = $null }
    )
    Check "接管少一格（旧宿主缺失）⇒ 不除名（宁可漏排除不误排除）" (
        (Get-EffectiveClaim -Marks $marks3).ContainsKey('BOXA/codex'))

    Write-Host "`n=== 会话归属 ==="
    $mine = [pscustomobject]@{ session = 't7' }
    Check "会话 id 一致 ⇒ 是我自己的" (Test-IsMySessionClaim -Claim $mine -MySession 't7')
    Check "会话 id 不一致 ⇒ 同机同宿主的另一个会话" (-not (Test-IsMySessionClaim -Claim $mine -MySession 't9'))
    Check "任一侧没填 ⇒ 按单会话旧行为放行" (Test-IsMySessionClaim -Claim ([pscustomobject]@{ session = $null }) -MySession 't7')
    Check "根本没有有效认领 ⇒ 谈不上是不是我的" (-not (Test-IsMySessionClaim -Claim $null -MySession 't7'))

    Write-Host "`n=== 判别力：把判据改坏，上面至少一条会红吗 ==="
    # 这一段不改代码，只把「如果字段校验没了会怎样」摆出来：占位符示例会被当成一条真认领。
    $loose = @([regex]::Matches('dao-claim: <机器名>/<宿主>/4h', '(?m)^dao-(claim):(.*)$')).Count
    Check "字段校验是唯一挡住占位符的那一关（松判据下它命中 1 条）" ($loose -eq 1)

    Write-Host ""
    if ($script:fail -eq 0) { Write-Host "认领协议自测：好的（$script:pass 条）"; return 0 }
    Write-Host "认领协议自测：不好（$script:fail 条红 / $script:pass 条绿）"
    return 1
}

switch ($Action) {
    'selftest' { exit (Invoke-SelfTest) }

    'list' {
        # 领活队列。旧过滤式 `label:任务 -label:在途` 已随 `在途` 退役（issue #360）——
        # label 删掉后 `-label:X` 静默不过滤，已认领的单会原样回到可领清单（撞车回归）。
        # 现在唯一信号源是认领评论，三步：
        #   ① 全列队列；② `dao-claim in:comments` 粗筛「评论里出现过认领痕迹」的单
        #   （只多不少：已释放/已过期的也命中，交给 ③ 精算。反方向的漏有一个已知窗口：
        #   GitHub 搜索索引有延迟，刚发的认领可能搜不到——所以认领动作之后必须 readback，
        #   list 只是初筛，不是防撞的最后一道）；③ 命中的逐单拉评论算有效认领，标出持有人。
        # ⚠ 刻意不走 jq —— PowerShell 5.1 会把传给 gh 的 jq 表达式里的双引号静默吃掉，
        #   含中文的 index("…") 到了 gh 那边少了引号，报 failed to parse。
        $raw = & gh issue list --state open --label $QueueLabel --json number,title --limit 50
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        $queue = @($raw | ConvertFrom-Json)
        if ($queue.Count -eq 0) { Write-Host "队列（label:$QueueLabel）当前为空。"; exit 0 }
        $raw2 = & gh issue list --state open --search "label:$QueueLabel dao-claim in:comments" --json number --limit 50
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        $touched = @{}
        foreach ($it in @($raw2 | ConvertFrom-Json)) { $touched[[string]$it.number] = $true }
        foreach ($it in $queue) {
            if ($touched.ContainsKey([string]$it.number)) {
                $eff = Get-EffectiveClaim -Marks (Get-IssueMarks -Number $it.number)
                if ($eff.Count -gt 0) {
                    Write-Host ("#{0}  {1}   [已认领：{2}]" -f $it.number, $it.title, (@($eff.Keys) -join ' '))
                    continue
                }
            }
            Write-Host ("#{0}  {1}" -f $it.number, $it.title)
        }
        exit 0
    }

    'readback' {
        if (-not $Issue) { Write-Error "readback 需要 -Issue <n>"; exit 1 }
        $marks = Get-IssueMarks -Number $Issue
        foreach ($mk in $marks) { Write-Host ("{0}  dao-{1}: {2}/{3}" -f $mk.createdAt, $mk.kind, $mk.host, $mk.runtime) }

        $eff = Get-EffectiveClaim -Marks $marks
        $myKey = '{0}/{1}' -f $MyHost, $MyRuntime
        $my = $eff[$myKey]
        $others = @($eff.Keys | Where-Object { $_ -ne $myKey } | ForEach-Object { $eff[$_] } | Sort-Object createdAt)

        Write-Host ""
        if (-not $my) { Write-Host "本机（$myKey）在这张单上没有有效认领。"; exit 0 }
        if ($MySession -and -not (Test-IsMySessionClaim -Claim $my -MySession $MySession)) {
            Write-Host "⚠ 这条认领属于同机同宿主的另一个并发会话（$($my.session)），不是本会话——只报不接。"
            exit 0
        }
        if ($others.Count -gt 0 -and $others[0].createdAt -lt $my.createdAt) {
            Write-Host "⚠ 有更早的认领：$($others[0].host)/$($others[0].runtime) @ $($others[0].createdAt) ⇒ 本机让位，去发 dao-yield:"
            exit 2
        }
        Write-Host "本机认领有效，无更早的竞争者。"
        exit 0
    }

    'lease' {
        if (-not $Issue) { Write-Error "lease 需要 -Issue <n>"; exit 1 }
        $marks = Get-IssueMarks -Number $Issue
        # 只认「当前持有人自己」最后一条 dao-claim:，不是最后一条评论——
        # 认了别人的评论就等于把一个已经死掉的租约续上，那正是这套协议要治的病。
        # 过滤必须带宿主：只按机器名过滤时，同机另一个宿主刚发的认领会被当成自己的续租锚点。
        $mineClaims = @($marks | Where-Object { $_.kind -eq 'claim' -and $_.host -eq $MyHost -and $_.runtime -eq $MyRuntime })
        if ($mineClaims.Count -eq 0) { Write-Host "本机在这张单上没有发过认领。"; exit 0 }
        $last = ($mineClaims | Select-Object -Last 1)
        $hours = [math]::Round(([datetimeoffset]::UtcNow - [datetimeoffset]::Parse($last.createdAt)).TotalHours, 2)
        Write-Host ("本机租约已跑 {0}h（自报 {1}），锚点 {2}" -f $hours, $last.hours, $last.createdAt)
        exit 0
    }
}
