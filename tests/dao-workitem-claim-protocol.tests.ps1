<#
.SYNOPSIS
    `ccswitch/rules/dao-workitem.md` §六「认领协议」三个核心函数（`Get-DaoMarks` /
    `Get-EffectiveClaim` / `Test-IsMySessionClaim`）的最小回归网。退出码 0 = 全部通过。

.DESCRIPTION
    ## 为什么有这个文件（issue #198 → PR #211 → issue #215 的第三棒）
    issue #198 修法批（PR #211）合并前过了独立对抗复核，结论「不可按现状合并」：
    FAIL-5/FAIL-6「现在怎么判」的宣称给不出实现——`Get-EffectiveClaim` 不是「逐机器
    判定」也没有「被 dao-takeover: 指名排除」；`Get-DaoMarks` 解出的 `session` 传一步
    就被丢。复核指出第 13 条弱处（F13）：**本协议零回归网**，改坏这两个函数没有任何
    东西会红。本文件最初补的是这个零——先钉住已知错误行为，算法修法归 issue #215（dao
    「撤宣称不抢修」）。**本次（issue #215 本批）算法修法已落地**：场景 5 原钉住的
    G3/G4「已知会判错」已翻转为「钉住正确答案」——它们钉的从来是当前真实返回值，算法
    一变期望值就跟着换，这是当初写下时就说好的规则，不是本文件走样。

    ## 判别力：行为型，不是文本匹配型
    两个函数**逐字节**从 `ccswitch/rules/dao-workitem.md` 提取跑（括号计数法，与
    PR #211 作者验收脚本、对抗复核官独立复核脚本同一手法——三方独立实现、结果一致，
    本身即一层交叉验证）。跑真函数、看真返回值，不是拿正则读文档散文描述。

    ## 覆盖什么、不覆盖什么（照直写，别读成「协议现在全测了」）
    **覆盖**：幽灵拒绝四态（占位符/单引号/裸标记混散文/裸标记独立成行）· 3/4 字段解析 ·
    FAIL-2 场景复刻（现改为**原样喂 CRLF**，验 `Get-DaoMarks` 自身的 CRLF 容忍——issue
    #215 追加发现：合并链实拦，参考实现对带 `\r` 的行尾不健壮）· G1/G2 正例（接口改为
    Hashtable）· **F1/F2 修法验证**：G3 两机同时认领现在逐机器各自可见、可正确判定
    让位；G4 被接管死机醒来重发的 claim 不再判有效 · 三方场景（issue #215 验收标准②）·
    G9 单条-claim 边界（B3③，钉 `for` 下界 `-ge 0`，防差一退化成 `-gt 0`）· F3 canary
    翻转为"带上 session/hours/oldHost/oldRuntime" · B3①②：租期正则放松（`0h`）/
    runtime 字符集放松（`.`）两处此前零覆盖的负控 · B3④（M3 归因订正=F7 一例复现）：
    裸标记独立成行正控，与 1c（混散文，真正挡它的是"独立成行"行锚而非 `$rest` 空值
    检查）区分开 · **F3"参与比较"那半**（场景 7，四轮修法新增 `Test-IsMySessionClaim`）：
    会话一致判"是我的" / 不一致判"不是我的"（同机同宿主两个并发会话不再互认对方的认领）
    / 任一没填会话 id 时按旧行为放行（自报字段忘填的兜底）/ `$my` 为 `$null` 时判"不是我的"。
    **7g 字典序错位负控**（PR #240 返修：对抗复核 M3 实测 `-eq`→`-ge` 判等改弱时场景 7 原六条
    全绿、零判别力——7a/7b 恰好只用了 s1/s2 这对样本，"s1" -ge "s2" 也答 False，语料只夹住了
    它恰好含有的那两个取值；本条改用字典序错位的 s1/s0 补上这个方向）。

    **不覆盖**（issue #215 弱处 F5-F13，F4 CRLF 已覆盖）：`·` 分隔符脆弱性（F5，含本批
    新增 `oldHost` 解析同样依赖它）· 撤回不比宿主（F6）· F7 另两处未复核 · 代码块/注释
    幽灵未灭（F8）· `/dao-resume` 缺"是否自己前任"判据（F9）· 字典序平局零实现（F10）·
    命令④空集抛异常（F11）· mousse-cli 第三份副本未同步（F12）。**F3 现已补上"参与比较"
    那半**（`Test-IsMySessionClaim`，场景 7）——但 `Get-EffectiveClaim` 的分组键仍然刻意
    只按 `host`，不按 `host+session`：§二 line 128 写明认领单位是「机器+宿主」，新函数只
    解决"这条已确认的有效认领是不是我自己会话发的"，不改变跨机器碰撞判定的分组粒度本身。
    **本批顺带发现但未修的一格**：`Get-EffectiveClaim` 目前也不按 `runtime` 分组（只按
    `host`），同机 cc/codex 并行认领同一单会被合并进同一个桶——issue #215 原文 F1 写的是
    "按 host 分组"。**PR #240 对抗复核订正**：这不是一个悬而未决的设计问题，是已实测四种
    危险方向的错误答案（互相撤销清空对方 / 同桶后发覆盖先发 / 接管连坐除名 / 冒领续命）+
    三个同族新形态，详情见跟进单 issue #250；本文件不重复覆盖，完整描述见
    `ccswitch/rules/dao-workitem.md` 开篇的四轮修法说明。
    **F2 的"指名排除"是简化处理**——一旦被指名永久除名，不支持"合法复活"这个 issue 点名
    "值得设计评审"的边界，本批未做评审。别把「有这文件」读成「协议全测了」。

.NOTES
    独立可运行：powershell -NoProfile -File tests/dao-workitem-claim-protocol.tests.ps1
    退出码：0 全部通过；1 存在失败。不碰机器级共享状态，留在默认层（无 env 标记）。
    PS 5.1 兼容：无三元运算符、无 && 链、禁 2>&1。本文件须以 BOM UTF-8 存盘（脚本文件
    本体，与用 `[IO.File]::ReadAllText` 读的「无 BOM 数据文件」不是一回事——见
    `ccswitch/rules/dao-officer-clauses.md` 通用节「编码铁律」）。
#>

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\ccswitch\lib\console-utf8.ps1')  # pin child-stdout decode to UTF-8（issue #131）

$repoRoot = Split-Path -Parent $PSScriptRoot
$docPath  = Join-Path $repoRoot 'ccswitch/rules/dao-workitem.md'

if (-not (Test-Path $docPath)) { Write-Host "被测文档不存在：$docPath"; exit 1 }

$results = New-Object System.Collections.Generic.List[object]

function Assert-True {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    $status = 'FAIL'
    if ($Condition) { $status = 'PASS' }
    $script:results.Add([PSCustomObject]@{ Name = $Name; Status = $status; Detail = $Detail })
    Write-Host ("  [{0}] {1} {2}" -f $status, $Name, $Detail)
}

function Get-BraceBlockSource {
    <#
      从 $Text 里找 $AnchorRegex 命中的位置，从命中位置后第一个 `{` 开始做括号计数，
      配对闭合时截断——与 PR #211 作者验收脚本、对抗复核官独立复核脚本同一手法。
      不解析字符串上下文，纯字符级计数；本文件两个被测函数体内所有花括号都在正则
      量词字面量（如 `{0,62}`）里成对出现，纯计数法足够、已实测比对字节数吻合
      （行尾归一化 LF 后 Get-DaoMarks=2773 字节 / Get-EffectiveClaim=1117 字节；本机
      core.autocrlf=true 检出下的原始 CRLF 值是 2813/1143——比较前归一化以免换机
      autocrlf 差异假红，出处 PR #211 复核评论 B1。issue #215 批重写了两个函数体，
      这两个数字随之从旧版的 1365/420 更新为当前实测值，方法不变，只是数字变了）。
    #>
    param([string]$Text, [string]$AnchorRegex, [string]$Label)
    $m = [regex]::Match($Text, $AnchorRegex)
    if (-not $m.Success) { throw "提取失败：锚点未命中（$Label）：$AnchorRegex" }
    $braceStart = $Text.IndexOf('{', $m.Index)
    if ($braceStart -lt 0) { throw "提取失败：找不到起始花括号（$Label）" }
    $depth = 0
    for ($i = $braceStart; $i -lt $Text.Length; $i++) {
        $ch = $Text[$i]
        if ($ch -eq '{') { $depth++ }
        elseif ($ch -eq '}') {
            $depth--
            if ($depth -eq 0) { return $Text.Substring($m.Index, $i - $m.Index + 1) }
        }
    }
    throw "提取失败：花括号未闭合（$Label）"
}

Write-Host ''
Write-Host '== dao-workitem 认领协议（Get-DaoMarks / Get-EffectiveClaim）回归测试 =='
Write-Host ''

# ============================================================================
# 场景 0：提取本身（提取失败时后面全部场景都没有意义，先单独证明这一步没坏）
# ============================================================================
Write-Host '场景 0：从文档逐字节提取两个函数'

$docText = [System.IO.File]::ReadAllText($docPath, [System.Text.Encoding]::UTF8)
$daoMarksSrc = Get-BraceBlockSource -Text $docText -AnchorRegex 'function Get-DaoMarks \{' -Label 'Get-DaoMarks'
$effClaimSrc = Get-BraceBlockSource -Text $docText -AnchorRegex 'function Get-EffectiveClaim \{' -Label 'Get-EffectiveClaim'
$mySessionSrc = Get-BraceBlockSource -Text $docText -AnchorRegex 'function Test-IsMySessionClaim \{' -Label 'Test-IsMySessionClaim'

$daoMarksLfLen = ($daoMarksSrc -replace "`r`n", "`n").Length
$effClaimLfLen = ($effClaimSrc -replace "`r`n", "`n").Length
$mySessionLfLen = ($mySessionSrc -replace "`r`n", "`n").Length
Assert-True '0a Get-DaoMarks 提取长度（行尾归一化 LF 后 2938 字节；PR #240 返修 R2 订正 CRLF 归一化注释后的实测值，此前为 2773，CRLF/LF 工作区皆成立）' `
    ($daoMarksLfLen -eq 2938) ("实测归一化后 {0} 字节（原始 {1}）" -f $daoMarksLfLen, $daoMarksSrc.Length)
Assert-True '0b Get-EffectiveClaim 提取长度（行尾归一化 LF 后 1602 字节；issue #250 分组粒度修法后的实测值，此前为 1117（issue #215 重写），CRLF/LF 工作区皆成立）' `
    ($effClaimLfLen -eq 1602) ("实测归一化后 {0} 字节（原始 {1}）" -f $effClaimLfLen, $effClaimSrc.Length)
Assert-True '0d Test-IsMySessionClaim 提取长度（行尾归一化 LF 后 859 字节；issue #215-F3 四轮修法新增函数，首次入库即锁死字节数，与 0a/0b 同一严格度）' `
    ($mySessionLfLen -eq 859) ("实测归一化后 {0} 字节（原始 {1}）" -f $mySessionLfLen, $mySessionSrc.Length)

. ([scriptblock]::Create($daoMarksSrc))
. ([scriptblock]::Create($effClaimSrc))
. ([scriptblock]::Create($mySessionSrc))

Assert-True '0c 三个函数提取后成功定义（Get-Command 找得到）' `
    ((Get-Command Get-DaoMarks -ErrorAction SilentlyContinue) -and (Get-Command Get-EffectiveClaim -ErrorAction SilentlyContinue) -and (Get-Command Test-IsMySessionClaim -ErrorAction SilentlyContinue)) ''

# ============================================================================
# 场景 1：幽灵拒绝四态（前三态 PR #211 body 验收表已证为真；第四态 issue #215-B3④ 新增）
# ============================================================================
Write-Host '场景 1：幽灵拒绝四态'

$ghostPlaceholder = @(Get-DaoMarks -Body 'dao-claim: <HOST>/<RT>/<N>h')
Assert-True '1a 占位符幽灵（尖括号）0 命中' `
    (@($ghostPlaceholder).Count -eq 0) ("命中 {0} 条" -f @($ghostPlaceholder).Count)

$ghostQuote = @(Get-DaoMarks -Body ('dao-claim: ' + [char]39 + '/cc/4h'))
Assert-True '1b 单引号机器名幽灵 0 命中（止血复发的第三条幽灵）' `
    (@($ghostQuote).Count -eq 0) ("命中 {0} 条" -f @($ghostQuote).Count)

$ghostBare = @(Get-DaoMarks -Body ('这是一句人话，提到了裸标记 `dao-claim:` 本身，不带任何字段。'))
Assert-True '1c 裸标记混在散文里 0 命中（真正挡住它的是"独立成行"这道行锚，见 1e 的归因区分）' `
    (@($ghostBare).Count -eq 0) ("命中 {0} 条" -f @($ghostBare).Count)

$ghostTable = @(Get-DaoMarks -Body ('| 示例 | `dao-claim: <H>/<R>/<N>h` | 说明 |'))
Assert-True '1d 表格单元格里的占位符引用 0 命中（不是独立成行）' `
    (@($ghostTable).Count -eq 0) ("命中 {0} 条" -f @($ghostTable).Count)

$ghostBareLine = @(Get-DaoMarks -Body '`dao-claim:`')
Assert-True '1e [issue #215-B3④，M3 归因订正=F7 一例复现] 裸标记独立成行时才真正触地"$rest 为空"那道守卫——1c 的输入从未走到这道检查（字段计数校验对空 rest 同样会拒，是它先挡的），本例把裸标记单独放一行，两道门都会拦，是当前唯一同时覆盖这道门的正控' `
    (@($ghostBareLine).Count -eq 0) ("命中 {0} 条" -f @($ghostBareLine).Count)

# ============================================================================
# 场景 2：字段解析（3 字段 / 4 字段含会话 id）+ B3①②两处变异盲区负控
# ============================================================================
Write-Host '场景 2：字段解析 + B3①②负控'

$p3 = @(Get-DaoMarks -Body 'dao-claim: HOST1/cc/4h')
Assert-True '2a 3 字段：host/runtime/hours 解析正确、session 为 null' `
    ((@($p3).Count -eq 1) -and ($p3[0].host -eq 'HOST1') -and ($p3[0].runtime -eq 'cc') -and `
     ($p3[0].hours -eq '4h') -and ($null -eq $p3[0].session)) `
    ("host={0} runtime={1} hours={2} session={3}" -f $p3[0].host, $p3[0].runtime, $p3[0].hours, $p3[0].session)

$p4 = @(Get-DaoMarks -Body 'dao-claim: HOST1/cc/s1/4h')
Assert-True '2b 4 字段：session 解析出来（FAIL-6 判据要求的会话短 id）' `
    ((@($p4).Count -eq 1) -and ($p4[0].session -eq 's1') -and ($p4[0].hours -eq '4h')) `
    ("session={0} hours={1}" -f $p4[0].session, $p4[0].hours)

$pYield = @(Get-DaoMarks -Body 'dao-yield: HOST1/cc')
Assert-True '2c yield 只要求机器/宿主两格' `
    ((@($pYield).Count -eq 1) -and ($pYield[0].kind -eq 'yield')) ''

$badHours = @(Get-DaoMarks -Body 'dao-claim: HOST1/cc/0h')
Assert-True '2d [issue #215-B3①] 租期字段 "0h" 被拒——正则 `^[1-9][0-9]?h$` 首位不含 0，这条负控守住"租期字段正则放松零红"这个此前的变异盲区' `
    (@($badHours).Count -eq 0) ("命中 {0} 条" -f @($badHours).Count)

$badRuntime = @(Get-DaoMarks -Body 'dao-claim: HOST1/c.c/4h')
Assert-True '2e [issue #215-B3②] runtime 字段 "c.c" 被拒——字符集正则 `^[A-Za-z0-9_-]{1,20}$` 不含 `.`，这条负控守住"runtime 字符集放松零红"这个此前的变异盲区' `
    (@($badRuntime).Count -eq 0) ("命中 {0} 条" -f @($badRuntime).Count)

# ============================================================================
# 场景 3：FAIL-2 验收场景复刻 + CRLF 正控（issue #215 追加评论：合并链实拦发现）
# ============================================================================
Write-Host '场景 3：FAIL-2 验收场景（真认领与裸引用同处一条评论体，只应命中真认领）+ CRLF 原样喂入正控'

$mixedBody = @'
先说一句人话：我现在开始干这张单。

dao-claim: REALBOX/cc/4h

<details>
<summary>协议格式提醒（点开看）</summary>
认领格式是首行那个 `dao-claim:`，别写错了。
</details>
'@
# issue #215 追加评论（合并链实拦发现）：参考实现原本对 CRLF 输入不健壮，行尾带 `\r` 时
# 字段校验把真认领挡掉；旧版测试靠"测试侧先归一化"止血，掩盖了这个缺陷。`Get-DaoMarks`
# 现在自己在入口做 CRLF/裸 CR 归一化（split 前），所以这里改为**原样喂 CRLF、不做任何
# 预处理**——这是对函数自身 CRLF 容忍的正控，不是对"测试侧写得够小心"的正控。显式构造
# CRLF（先收敛已有换行到 LF，再统一展开成 CRLF）而不是依赖本文件在磁盘上的行尾约定，
# 这样换一台 autocrlf 设置不同的机器也不会让这条正控悄悄失去意义。
$mixedBodyCRLF = ($mixedBody -replace "`r`n", "`n") -replace "`n", "`r`n"
$mixed = @(Get-DaoMarks -Body $mixedBodyCRLF)
Assert-True '3a [issue #215 CRLF 容忍修法] 混合评论体（CRLF 原样喂入）只命中 1 条（真认领），裸引用被字段校验挡住' `
    (@($mixed).Count -eq 1) ("命中 {0} 条：{1}" -f @($mixed).Count, (($mixed | ForEach-Object { $_.host }) -join ','))
Assert-True '3b 命中的那一条确实是真认领（host=REALBOX）' `
    (($mixed.Count -eq 1) -and ($mixed[0].host -eq 'REALBOX')) ''

# ============================================================================
# 场景 4：「当前有效认领」正例回归（G1 合法接管 / G2 yield 后置空）——接口已改为 Hashtable
# ============================================================================
Write-Host '场景 4：Get-EffectiveClaim 正例（G1 合法接管 / G2 yield 后置空，Hashtable 接口）'

$marksG1 = @(
    [pscustomobject]@{ kind = 'claim';    host = 'DEAD'; runtime = 'cc' },
    [pscustomobject]@{ kind = 'takeover'; host = 'NEW';  runtime = 'cc'; oldHost = 'DEAD'; oldRuntime = 'cc' },
    [pscustomobject]@{ kind = 'claim';    host = 'NEW';  runtime = 'cc' }
)
$g1 = Get-EffectiveClaim -Marks $marksG1
Assert-True '4a G1：claim(DEAD)→takeover(NEW,指名 DEAD/cc)→claim(NEW) ⇒ 有效认领集合只剩 NEW/cc 一个 key（DEAD/cc 因被指名除名，F2 修法；issue #250 后 key 是「机器/宿主」不再是裸机器名）' `
    (($g1.Count -eq 1) -and $g1.ContainsKey('NEW/cc') -and ($g1['NEW/cc'].kind -eq 'claim')) ("keys={0}" -f (@($g1.Keys) -join ','))

$marksG2 = @(
    [pscustomobject]@{ kind = 'claim'; host = 'A'; runtime = 'cc' },
    [pscustomobject]@{ kind = 'yield'; host = 'A'; runtime = 'cc' }
)
$g2 = Get-EffectiveClaim -Marks $marksG2
Assert-True '4b G2：claim(A)→yield(A) ⇒ 有效认领集合为空（不活锁）' `
    ($g2.Count -eq 0) ("count={0}" -f $g2.Count)

# ============================================================================
# 场景 5：F1/F2 算法修法验证——原 G3/G4「已知缺陷锚点」翻转为正例 + G9 边界 + 三方场景
# ============================================================================
# 这三条钉住的是修好之后的**正确返回值**。它们的前身（issue #215 立项时的 5a/5b）钉住的是
# 当时的**错误返回值**，且当初就写明"算法修好后这两条会变红，那是该更新的信号"——现在正是
# 那个更新动作：期望值换成正确答案，断言的名字与出处标注保留，方便追溯这条测试的历史。
Write-Host '场景 5：F1/F2 修法验证（G3/G4 翻转为正例）+ G9 单条-claim 边界 + 三方场景'

$marksG3 = @(
    [pscustomobject]@{ kind = 'claim'; host = 'BOXA'; runtime = 'cc'; createdAt = '2026-08-09T01:00:00Z' },
    [pscustomobject]@{ kind = 'claim'; host = 'BOXB'; runtime = 'cc'; createdAt = '2026-08-09T01:00:30Z' }
)
$g3 = Get-EffectiveClaim -Marks $marksG3
Assert-True '5a [issue #215-F1 已修，原缺陷锚点翻转] G3：两机同时认领（A 早/B 晚），函数现在逐桶分别返回——两个「机器/宿主」桶都在结果集合里，各自都能看到"我自己的有效认领"' `
    (($g3.Count -eq 2) -and $g3.ContainsKey('BOXA/cc') -and $g3.ContainsKey('BOXB/cc')) ("keys={0}" -f (@($g3.Keys) -join ','))
Assert-True '5a-2 [issue #215-F1] G3 补证：调用方拿这份逐桶结果做跨机比较，能正确判定 BOXA 更早（该让位的是 BOXB，不再是"两边都留着"或"都判不出"）' `
    ($g3['BOXA/cc'].createdAt -lt $g3['BOXB/cc'].createdAt) ("BOXA/cc={0} BOXB/cc={1}" -f $g3['BOXA/cc'].createdAt, $g3['BOXB/cc'].createdAt)

$marksG4 = @(
    [pscustomobject]@{ kind = 'claim';    host = 'DEAD'; runtime = 'cc' },
    [pscustomobject]@{ kind = 'takeover'; host = 'NEW';  runtime = 'cc'; oldHost = 'DEAD'; oldRuntime = 'cc' },
    [pscustomobject]@{ kind = 'claim';    host = 'NEW';  runtime = 'cc' },
    [pscustomobject]@{ kind = 'claim';    host = 'DEAD'; runtime = 'cc' }
)
$g4 = Get-EffectiveClaim -Marks $marksG4
Assert-True '5b [issue #215-F2 已修，原缺陷锚点翻转] G4：被接管的死机醒来后又发一条 claim，函数不再把它判成有效——结果集合只剩 NEW/cc 一个 key，DEAD/cc 除名' `
    (($g4.Count -eq 1) -and $g4.ContainsKey('NEW/cc') -and (-not $g4.ContainsKey('DEAD/cc'))) ("keys={0}" -f (@($g4.Keys) -join ','))

$marksG9 = @([pscustomobject]@{ kind = 'claim'; host = 'SOLO'; runtime = 'cc' })
$g9 = Get-EffectiveClaim -Marks $marksG9
Assert-True '5c [issue #215-B3③] G9 单条-claim 边界：只有一条标记时函数仍要找到它——钉住内层 for 循环下界 `-ge 0`，防止"差一"退化成 `-gt 0`（那样单条数组的循环体会一次都不执行，此前回归网里没有任何断言能抓这个差异，唯独这个单条场景能）' `
    (($g9.Count -eq 1) -and $g9.ContainsKey('SOLO/cc') -and ($g9['SOLO/cc'].host -eq 'SOLO')) ("keys={0}" -f (@($g9.Keys) -join ','))

$marksG7 = @(
    [pscustomobject]@{ kind = 'claim'; host = 'X'; runtime = 'cc'; createdAt = '2026-08-09T01:00:00Z' },
    [pscustomobject]@{ kind = 'claim'; host = 'Y'; runtime = 'cc'; createdAt = '2026-08-09T01:00:10Z' },
    [pscustomobject]@{ kind = 'claim'; host = 'Z'; runtime = 'cc'; createdAt = '2026-08-09T01:00:20Z' }
)
$g7 = Get-EffectiveClaim -Marks $marksG7
Assert-True '5d [issue #215 验收标准②「至少补一个三方场景」] 三台机各自的有效认领同时可见，不只两台机时才成立' `
    (($g7.Count -eq 3) -and $g7.ContainsKey('X/cc') -and $g7.ContainsKey('Y/cc') -and $g7.ContainsKey('Z/cc')) ("keys={0}" -f (@($g7.Keys) -join ','))

# ============================================================================
# 场景 6：F3 源码文本 canary——`$marks +=` 组装行现在带上 session/hours/oldHost/oldRuntime
# ============================================================================
# 这不是行为测试，是**源码文本**测试：`Get-DaoMarks` 本身能解出 session（场景 2b 已证），
# 此前 §六 命令③把结果重新组装进 `$marks` 时只拼了 4 个字段，session/hours 被丢在半路
# （原缺陷）。issue #215 本批把组装行补上了 session/hours（F3），以及 F2 需要的
# oldHost/oldRuntime——这条 canary 现在钉住"这些字段都在"，是原断言的翻转版本。
# 用括号计数抽函数体在这里不适用（这行代码不在任何函数里，是 §六 命令③的内联脚本），
# 改用锚定单行的正则直接抓这一行原文，逐字核对它到底拼了哪些字段。
Write-Host '场景 6：F3 源码文本 canary（$marks 组装行现在带上 session/hours/oldHost/oldRuntime）'

$assemblyMatch = [regex]::Match($docText, '(?m)^\s*\$marks \+= \[pscustomobject\]@\{[^\r\n]*\}')
Assert-True '6a `$marks +=` 组装行在文档里找得到（找不到说明命令③的实现形态已经变了，本断言需要跟着重写）' `
    $assemblyMatch.Success ''

if ($assemblyMatch.Success) {
    $assemblyLine = $assemblyMatch.Value
    Assert-True '6b [issue #215-F3 已修，原缺陷锚点翻转] 组装行现在带上了 session 字段（解析出来的会话 id 不再半路被扔）' `
        ($assemblyLine -match 'session') ("原文：{0}" -f $assemblyLine.Trim())
    Assert-True '6c [issue #215-F3 已修] 组装行现在带上了 hours 字段（同一个缺口，租期字段一并补回）' `
        ($assemblyLine -match 'hours') ''
    Assert-True '6d 组装行确实拼了 createdAt/kind/host/runtime 四个原有字段（新增字段没有挤掉旧字段）' `
        (($assemblyLine -match 'createdAt') -and ($assemblyLine -match 'kind') -and `
         ($assemblyLine -match 'host') -and ($assemblyLine -match 'runtime')) ''
    Assert-True '6e [issue #215-F2；issue #250 已补上消费侧] 组装行带上了 oldHost/oldRuntime。~~两个字段命运不同：`oldRuntime` 全仓 0 个消费点，除名逻辑只看 oldHost~~ **issue #250 修法后两格都被读了**：除名键是 `oldHost/oldRuntime` 拼出来的桶名，缺任一格都不除名（见 8c/8d 两条行为断言）。这条 canary 仍然只证明"两个字段都拼进了组装行"，**不证明"两个字段都被下游用到"**——证那件事的是 8c/8d，别拿这条顶替' `
        (($assemblyLine -match 'oldHost') -and ($assemblyLine -match 'oldRuntime')) ''
}

# ============================================================================
# 场景 7：Test-IsMySessionClaim（issue #215-F3 四轮修法——"参与比较"那半的实现）
# ============================================================================
# F3 前三轮只做到"session/hours 数据不丢"（场景 6），dao-resume.md「先比对会话 id」依旧没有
# 代码可跑。本场景测的是补上的那半：给定 Get-EffectiveClaim 算出的某个 host 的有效认领 $my
# 与本会话自报的 $MySession，函数要答"这条有效认领是不是我自己这个会话发的"。
Write-Host '场景 7：Test-IsMySessionClaim（F3"参与比较"实现）'

$claimWithSession = [pscustomobject]@{ kind = 'claim'; host = 'HOST1'; runtime = 'cc'; session = 's1'; createdAt = '2026-08-09T01:00:00Z' }
$claimNoSession = [pscustomobject]@{ kind = 'claim'; host = 'HOST1'; runtime = 'cc'; session = $null; createdAt = '2026-08-09T01:00:00Z' }

Assert-True '7a 会话 id 一致 ⇒ 判定为"是我自己的"' `
    (Test-IsMySessionClaim -my $claimWithSession -MySession 's1') ''

Assert-True '7b 会话 id 不一致 ⇒ 判定为"另一个并发会话的"，不是我自己的（这正是 F3 要堵的洞：同机同宿主两个会话不再互相把对方的认领当自己的）' `
    (-not (Test-IsMySessionClaim -my $claimWithSession -MySession 's2')) ''

Assert-True '7c $my 没有 session（3 字段旧格式，单会话场景）⇒ 无数据可比，按旧行为放行（不拦）——这不是新洞，是把旧洞的边界从"完全没有判据"改成"有判据但要求自报配合"' `
    (Test-IsMySessionClaim -my $claimNoSession -MySession 's1') ''

Assert-True '7d 调用方没传 $MySession（空串/未填）⇒ 同样无数据可比，按旧行为放行' `
    (Test-IsMySessionClaim -my $claimWithSession -MySession '') ''

Assert-True '7e $my 为 $null（这台 host 没有有效认领，如 §六 $eff[$MyHost] 查不到）⇒ 不是"我的"，返回 $false' `
    (-not (Test-IsMySessionClaim -my $null -MySession 's1')) ''

Assert-True '7f 两边都没有会话 id（纯单会话协议场景，历史行为）⇒ 放行，不因为新函数的存在就要求所有场景都填会话 id' `
    (Test-IsMySessionClaim -my $claimNoSession -MySession '') ''

Assert-True '7g 字典序错位负控（PR #240 对抗复核 M3：判等 `-eq` 被悄悄改弱成 `-ge` 时，7a/7b 只用 s1/s2 这一对样本、恰好使 `-ge` 也答对，34/34 全绿、零判别力——存活探针实测 s1-vs-s0 时 `-ge` 答 True 而正确答案是 False，方向 fail-open：会替别的会话续命）。my.session="s1"、MySession="s0"（字典序 s0 < s1）⇒ 不相等，判定不是我的；若判等被换成 `-ge`，"s1" -ge "s0" 为真，会被误判成"是我的"，这条断言专治这个方向' `
    (-not (Test-IsMySessionClaim -my $claimWithSession -MySession 's0')) ''

# ============================================================================
# 场景 8：issue #250 —— 分组粒度从 host 扩到「机器+宿主」（双栈同机 cc/codex 并桶）
# ============================================================================
# 本仓自己声明是双栈仓（CLAUDE.md：cc 与 Codex 共存），同机两个 AI 宿主认领同一张单是真实
# 形态。§二 早就写明「认领的单位是「机器 + 宿主」」，而 `Get-EffectiveClaim` 此前只按 host
# 分组 —— **实现与它自己已经写下的判据不一致**，这是本场景的性质：不是新立一条规矩，是把
# 实现拉回已声明的单位（照做档）。
# 8a-8c 刻意**从评论正文端到端喂**（Get-DaoMarks → 组装 → Get-EffectiveClaim），不是手搭
# 对象：手搭对象绕过解析层，而 A5 的 oldHost/oldRuntime 恰恰产在解析层。
Write-Host '场景 8：issue #250 分组粒度（机器+宿主）'

function Build-MarksFromComments {
    # §六 命令③ 的组装步骤同构：一条评论可产出多个机器面标记，按 GitHub 盖的时间戳排序
    param($Comments)
    $out = @()
    foreach ($cm in $Comments) {
        foreach ($mk in (Get-DaoMarks -Body $cm.body)) {
            $out += [pscustomobject]@{ createdAt = $cm.createdAt; kind = $mk.kind; host = $mk.host; runtime = $mk.runtime; session = $mk.session; hours = $mk.hours; oldHost = $mk.oldHost; oldRuntime = $mk.oldRuntime }
        }
    }
    return @($out | Sort-Object createdAt)
}

# --- A2：同机另一个宿主的 dao-yield: 不得撤销自己的 claim ---------------------
$marksA2 = Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = "开始干这单。`n`ndao-claim: HOST1/cc/4h" },
    [pscustomobject]@{ createdAt = '2026-08-09T01:01:00Z'; body = "codex 那边的活收了。`n`ndao-yield: HOST1/codex" }
)
$a2 = Get-EffectiveClaim -Marks $marksA2
Assert-True '8a [issue #250-A2] HOST1/cc 认领后 HOST1/codex 撤回 ⇒ cc 的认领仍然有效（修法前：两个宿主并进同一个 host 桶，codex 的 yield 把 cc 的 claim 一起杀掉，有效认领集合变空 —— 方向是"认领凭空消失"，比误报更危险）' `
    (($a2.Count -eq 1) -and $a2.ContainsKey('HOST1/cc') -and ($a2['HOST1/cc'].runtime -eq 'cc')) ("keys={0}" -f (@($a2.Keys) -join ','))

# --- A3：同机两个宿主各认领一次 ⇒ 两个独立的桶，先发的那个胜 -----------------
$marksA3 = Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = 'dao-claim: HOST1/cc/4h' },
    [pscustomobject]@{ createdAt = '2026-08-09T01:03:00Z'; body = 'dao-claim: HOST1/codex/4h' }
)
$a3 = Get-EffectiveClaim -Marks $marksA3
Assert-True '8b [issue #250-A3] 同机 cc/codex 各认领一次 ⇒ 两个桶都在，谁都没被对方覆盖（修法前：并进一个 host 桶、后发的 codex 覆盖先发的 cc，cc 的租约凭空消失）' `
    (($a3.Count -eq 2) -and $a3.ContainsKey('HOST1/cc') -and $a3.ContainsKey('HOST1/codex')) ("keys={0}" -f (@($a3.Keys) -join ','))
Assert-True '8b-2 [issue #250-A3] 补证：两个桶可比较，cc 更早 ⇒ 该让位的是 codex（§四「谁该让位」在同机跨宿主这一格现在也答得出来，不再是"看不见另一半"）' `
    ($a3['HOST1/cc'].createdAt -lt $a3['HOST1/codex'].createdAt) ("cc={0} codex={1}" -f $a3['HOST1/cc'].createdAt, $a3['HOST1/codex'].createdAt)

# --- A3 后半：命令④ 的租期锚点也要按「机器+宿主」过滤 -----------------------
$myHostA3 = 'HOST1'; $myRuntimeA3 = 'cc'
$holderClaimsA3 = @($marksA3 | Where-Object { $_.kind -eq 'claim' -and $_.host -eq $myHostA3 -and $_.runtime -eq $myRuntimeA3 })
Assert-True '8b-3 [issue #250-A3 后半] 命令④ 租期锚点按「机器+宿主」过滤后取到的是 cc 自己那条（01:00），不是同机 codex 后发的那条（01:03）——只按 host 过滤时租期会从别人那条算起' `
    ((($holderClaimsA3 | Select-Object -Last 1).createdAt) -eq '2026-08-09T01:00:00Z') ("锚点={0}" -f ($holderClaimsA3 | Select-Object -Last 1).createdAt)

# --- A5：接管指名 BOXA/codex ⇒ 只除名那一个桶，BOXA/cc 不连坐 ---------------
$marksA5 = Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = 'dao-claim: BOXA/cc/4h' },
    [pscustomobject]@{ createdAt = '2026-08-09T01:01:00Z'; body = 'dao-claim: BOXA/codex/4h' },
    [pscustomobject]@{ createdAt = '2026-08-09T01:05:00Z'; body = ('dao-takeover: NEW/cc ' + [char]0x00B7 + ' 原认领 BOXA/codex 静默 9h') },
    [pscustomobject]@{ createdAt = '2026-08-09T01:06:00Z'; body = 'dao-claim: NEW/cc/4h' }
)
Assert-True '8c-0 [前提] 接管评论的 oldHost/oldRuntime 两格都从解析层拿到了（拿不到则 8c 恒绿而无判别力——除名压根没发生也会让 BOXA/cc 活着）' `
    ((@($marksA5 | Where-Object { $_.kind -eq 'takeover' })[0].oldHost -eq 'BOXA') -and (@($marksA5 | Where-Object { $_.kind -eq 'takeover' })[0].oldRuntime -eq 'codex')) ''
$a5 = Get-EffectiveClaim -Marks $marksA5
Assert-True '8c [issue #250-A5] 接管指名 BOXA/codex ⇒ 只有 BOXA/codex 被除名，BOXA/cc 保住自己的认领、NEW/cc 是新持有人（修法前：除名逻辑只读 oldHost，整台 BOXA 连坐除名，把一个合法持有人一起抹掉）' `
    (($a5.Count -eq 2) -and $a5.ContainsKey('BOXA/cc') -and $a5.ContainsKey('NEW/cc') -and (-not $a5.ContainsKey('BOXA/codex'))) ("keys={0}" -f (@($a5.Keys) -join ','))

# --- 除名的 fail-safe 方向：缺一格就不除名 -----------------------------------
$marksA5b = @(
    [pscustomobject]@{ kind = 'claim';    host = 'BOXA'; runtime = 'codex'; createdAt = '2026-08-09T01:00:00Z' },
    [pscustomobject]@{ kind = 'takeover'; host = 'NEW';  runtime = 'cc'; oldHost = 'BOXA'; oldRuntime = $null; createdAt = '2026-08-09T01:05:00Z' }
)
$a5b = Get-EffectiveClaim -Marks $marksA5b
Assert-True '8d [issue #250 除名 fail-safe] 接管只解出 oldHost、oldRuntime 缺失时**不除名**（宁可漏排除不误排除，与 §三"拿不准就当它还被持有"同向）。这条同时是 8c 的反向夹击：若把除名判据写成"只要 oldHost 命中就整台除名"，8c 会红；若写成"两格都不看、从不除名"，本条绿而 8c 红 —— 两条一起才夹得住那个 `-and`' `
    (($a5b.Count -eq 2) -and $a5b.ContainsKey('BOXA/codex') -and $a5b.ContainsKey('NEW/cc')) ("keys={0}" -f (@($a5b.Keys) -join ','))

# --- B3：跨宿主冒领 ------------------------------------------------------------
$marksB3 = Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = 'dao-claim: HOST1/codex/4h' }
)
$b3 = Get-EffectiveClaim -Marks $marksB3
$myKeyB3 = '{0}/{1}' -f 'HOST1', 'cc'
$myB3 = $b3[$myKeyB3]
Assert-True '8e [issue #250-B3] codex 用 3 字段旧格式持有该单，cc 按「机器+宿主」组合键查自己的桶 ⇒ 查不到（$null）⇒ Test-IsMySessionClaim 答"不是我的"。修法前 cc 用裸 $MyHost 查会查到 codex 那条并判 True，替别人的认领续命——F3 号称堵住的"互认"洞在跨宿主这一格原样重现' `
    ((-not $myB3) -and (-not (Test-IsMySessionClaim -my $myB3 -MySession 's1'))) ("my={0}" -f $myB3)
Assert-True '8e-2 [issue #250 残留弱处锚点，钉住的是**现状不是理想态**] Test-IsMySessionClaim 自身仍不比对 runtime：直接把 codex 那条有效认领喂给它，它照旧答 True（无 session 可比 ⇒ 按旧行为放行）。本批的修法落在**查表那一步**（组合键），不在这个函数里 —— 哪天它自己也比对 runtime 了，这条会变红，那正是该更新的信号，不是回归' `
    (Test-IsMySessionClaim -my $b3['HOST1/codex'] -MySession 's1') ''

# --- 分隔符负控：`/` 不是可有可无的装饰 ---------------------------------------
$marksSep = @(
    [pscustomobject]@{ kind = 'claim'; host = 'AB'; runtime = 'C';  createdAt = '2026-08-09T01:00:00Z' },
    [pscustomobject]@{ kind = 'claim'; host = 'A';  runtime = 'BC'; createdAt = '2026-08-09T01:01:00Z' }
)
$sep = Get-EffectiveClaim -Marks $marksSep
Assert-True '8f [issue #250 分隔符负控] 组合键必须带分隔符：`AB`+`C` 与 `A`+`BC` 裸拼都是 "ABC" ⇒ 会被并成一个桶（同 A3 的病换个马甲）。带 `/` 时是 "AB/C" 与 "A/BC" 两个桶。这条专治"把 `{0}/{1}` 悄悄改成 `{0}{1}`"这一类变异——§二 字符集把 `/` 挡在两格之外，所以 `/` 做分隔符反解唯一，这条断言正是那个前提的落地检验' `
    (($sep.Count -eq 2) -and $sep.ContainsKey('AB/C') -and $sep.ContainsKey('A/BC')) ("keys={0}" -f (@($sep.Keys) -join ','))

# --- 源码文本 canary：§六 命令③④ 的调用侧（不在函数里，抽不出函数体） --------
# 三条 canary 的行尾锚刻意写成 `[^\r\n]*` 而**不带** `$`：本仓 core.autocrlf=true，工作区是
# CRLF，而 .NET 的 `(?m)$` 只在 `\n` 之前命中、在 `\r` 之前不命中 ⇒ 带 `$` 的版本在 CRLF 检出
# 下三条全部落空（本批实测：先写成带 `$`，三条同时 FAIL 且 `原文：` 打印为空）。
# 这正是 dao `[#守-锚点行尾]` 说的那一格——落空的锚在别的写法里会静默 PASS，这里因为断言
# 同时要求 `.Success`，落空即红，故是"响了"而不是"瞎了"。
$myKeyLine = [regex]::Match($docText, '(?m)^\$MyKey = [^\r\n]*')
Assert-True '8g-1 §六 命令③ 定义了组合键 $MyKey，且它由 $MyHost 与 $MyRuntime 两格拼成（这一行不在任何函数体内，括号计数法抽不到，只能锚单行原文）' `
    ($myKeyLine.Success -and ($myKeyLine.Value -match '\$MyHost') -and ($myKeyLine.Value -match '\$MyRuntime')) ("原文：{0}" -f $myKeyLine.Value)

$lookupLine = [regex]::Match($docText, '(?m)^\$my = \$eff\[[^\r\n]*')
Assert-True '8g-2 §六 命令③ 查自己那个桶用的是 $MyKey，不是裸 $MyHost（裸 $MyHost 查表就是 B3 冒领的落点——函数改对了而调用侧没改，缺陷原样还在）' `
    ($lookupLine.Success -and ($lookupLine.Value -match '\$eff\[\$MyKey\]')) ("原文：{0}" -f $lookupLine.Value)

$holderLine = [regex]::Match($docText, '(?m)^\$holderClaims = @\(\$marks \| Where-Object \{[^\r\n]*')
Assert-True '8h §六 命令④ 的租期锚点过滤同时带 host 与 runtime 两格（8b-3 用等价表达式验了行为，这条钉住盘上那一行真的这么写——两条分工：行为断言证"这么写是对的"，canary 证"盘上就是这么写的"）' `
    ($holderLine.Success -and ($holderLine.Value -match '\$_\.host -eq \$MyHost') -and ($holderLine.Value -match '\$_\.runtime -eq \$MyRuntime')) ("原文：{0}" -f $holderLine.Value)

# --- A4 / A8：本批**不修**，钉住当前的错误返回值当退役触发器 -----------------
# issue #250 处置建议明写这两条要额外的"接管环检测"、设计面更大，与"不支持合法复活"那条
# 已知弱处一起评审。这里钉住它们**现在的错误行为**：哪天有人做了环检测，这两条会变红，
# 那正是该更新期望值的信号（同场景 5 G3/G4 的历史：先钉错值，修好后翻转）。
# 不钉的话，这两个形态在盘上没有任何触发器，只活在 issue 正文里。
$marksA4 = Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = ('dao-takeover: AAA/cc ' + [char]0x00B7 + ' 原认领 BBB/cc 静默 9h') },
    [pscustomobject]@{ createdAt = '2026-08-09T01:01:00Z'; body = ('dao-takeover: BBB/cc ' + [char]0x00B7 + ' 原认领 AAA/cc 静默 9h') }
)
$a4 = Get-EffectiveClaim -Marks $marksA4
Assert-True '8i [issue #250-A4 已知缺陷锚点，本批不修] 互相接管（A 接管 B、B 再接管 A）⇒ 两个桶互相除名，有效认领集合为空：连当下合法持有它的那台机也被抹掉，两边都以为这单没人认领。钉住的是**错误值**，修好后本条会红' `
    ($a4.Count -eq 0) ("keys={0}" -f (@($a4.Keys) -join ','))

$marksA8 = Build-MarksFromComments @(
    [pscustomobject]@{ createdAt = '2026-08-09T01:00:00Z'; body = 'dao-claim: BOXA/cc/4h' },
    [pscustomobject]@{ createdAt = '2026-08-09T01:05:00Z'; body = ('dao-takeover: BOXA/cc ' + [char]0x00B7 + ' 原认领 BOXA/cc 静默 9h') }
)
$a8 = Get-EffectiveClaim -Marks $marksA8
Assert-True '8j [issue #250-A8 已知缺陷锚点，本批不修] 自我接管（同一台机重启后接管自己的陈旧认领）⇒ 把自己除名，集合为空。这不是"旧机复活不了"（已知弱处覆盖的那种），是"现任合法持有人被抹掉"，严重度不同。钉住的是**错误值**，修好后本条会红' `
    ($a8.Count -eq 0) ("keys={0}" -f (@($a8.Keys) -join ','))

# ---- 汇总 -------------------------------------------------------------------
Write-Host ''
Write-Host '=============================================='
Write-Host '     dao-workitem-claim-protocol 汇总'
Write-Host '=============================================='
$failing = @($results | Where-Object { $_.Status -ne 'PASS' })
foreach ($r in $results) { Write-Host ("  {0,-6} {1}" -f $r.Status, $r.Name) }
Write-Host '=============================================='
if ($failing.Count -gt 0) {
    Write-Host ("dao-workitem-claim-protocol 失败：{0}/{1} 项未通过" -f $failing.Count, $results.Count)
    exit 1
}
Write-Host ("dao-workitem-claim-protocol 全部通过（{0} 项）。" -f $results.Count)
exit 0
