<#
.SYNOPSIS
    PR / issue 正文与回读记录的「乱码签名字 + 未填占位符」扫描（纯函数，无顶层
    副作用，可被 `tests/pr-body-scan.tests.ps1` 单独 dot-source 测试）。

    **canonical（2026-08-02 由 mousse-cli `scripts/lib/pr-body-scan.ps1` 上移）。**
    本文件零项目耦合：不含任何仓名/路径/技术栈假设，唯一输入是一个目录。
    上移理由见 `ccswitch/scripts/check-pr-body-mojibake.ps1` 头注「为什么住在 dao」。

.DESCRIPTION
    ## 它是哪条条款的机检半

    `ccswitch/rules/dao-officer-clauses.md` 通用节：**「PR body / comment 正文永不经过
    PowerShell 字符串，一律走 `--body-file`，发出后回读核一次」**（`n=4`）。
    该条第③步要求「发出后回读，Grep 扫 `[锛銆馃鈥]` 四个签名字，零命中才算发完」，
    而条款自己在「射程与弱处」里写着：

      > ㈠这是**槽位档不是机检档**，**没有任何程序在核你回读了没有**——
      > 「回读扫乱码」做成观察线档的 `scripts/check-*.ps1` 是可行的，但要动
      > `verify-all.ps1` 的 `$checks` 数组，2026-07-27 本批因同窗有官正在改相邻
      > 脚本而判为抢改风险大于收益，**挂账未做、是已知缺口不是疏漏**。

    本文件（+ `ccswitch/scripts/check-pr-body-mojibake.ps1`）就是那笔挂账。**它把「没有任何
    程序在核」改成「有一行输出每次都从人眼前过」，不改成「有一道闸在拦」**——理由见
    下面「闸位」。

    ## 判据（两组信号，各自的出处与射程分开写）

    ### 信号 A · 乱码签名字（主）

    A1 **四个签名字 `[锛銆馃鈥]`**——**逐字取自条款正文，不自行增删**。本机实算坐实
       它们分别是什么（`[Text.Encoding]::GetEncoding(936).GetString(UTF8.GetBytes(x))`）：

           ：(U+FF1A) → 锛(U+951B)   。(U+3002) / 、(U+3001) → 銆(U+9286)
           —(U+2014) → 鈥(U+9225)   📸(U+1F4F8) → 馃(U+9983) 摳

       四者都是极罕用字，正常中文行文里几乎不出现 ⇒ 判别力来自「罕见」，不是来自
       「一定是乱码」。

    A2 **`€` 紧贴 CJK**（扩展签名，**有出处，不是为假想敌加的**）。出处是条款正文
       自己引的那一行实测结果：`## 这是什么` 经 `Get-Content -Raw` 得
       **`## 杩欐槸浠€涔?`**。本机对这一行逐个跑过两个签名（实测，非推断）：

           A1 `[锛銆馃鈥]`  → **不命中**   ← 条款给的那四个字，在它自己引的例子上是哑的
           A2 `€`贴CJK      → 命中 `浠€`

       成因：CJK 的 UTF-8 三字节序列里 `0x80` 极常见（`什` U+4EC0 = E4 BB 80），
       而 CP936 把 `0x80` 映成 `€`。**这不是「条款写错了」**——#269 的整份 body 都是
       乱码，只要正文里任何一行有 `：`/`。`/emoji，A1 就会响，文档级判别力是够的；
       A1 哑掉的是**短正文**那一档（一两行、恰好没有那几个标点）。A2 补的正是这一档。
       ⚠ **A2 是本文件相对条款原文唯一的判据扩展**，只补这一个已被实证的漏口，
       **不宣称补全**。它自己的假阳性也是实测出来的，见下面「两向失效形态」。

    ### 信号 B · 未填占位符（附）

    B1 `<[A-Z][A-Z0-9_]{2,}>` 形态的未替换占位符。出处：#269 的 body 里
       **`<PLACEHOLDER>` 原样留在了线上**——因为字符串已成乱码后 `-replace
       '<含中文的模式>'` 一律不命中**且不报错、`$LASTEXITCODE` 照样 0**。
       那是同一起事故里**不产生任何乱码字**的那一半损害。
    B2 含 `📸` 的行上出现「待补」「TBD」「随后补」。出处：PR 真机证据三态母版
       `ccswitch/templates/pr-evidence-rule.md`（项目侧派生件同）——第三态「降级挂账」
       必须填**真实 issue 编号**，「待补」「TBD」「随后补」明文不成立。
       ⚠ **射程随派生方走**：没有采用三态约定的项目里，B2 恒零命中；那是「不适用」
       不是「通过」，与本文件反复强调的「零命中 ≠ 零存在」同一件事。
       **刻意只在 📸 行上判**：这三个词在调研笔记里是正常用词，全文件判必成噪音。

    ## 两向失效形态（近似判据的强制自陈，禁笃定措辞）

    **假阴性（零命中 ≠ 编码一定对）——这一面比假阳性大得多，照直写：**
      · A1 只覆盖那四个字；A2 只覆盖 `€` 贴 CJK。**一段既没有 `：。、—`/emoji、
        又没撞上 `0x80` 的短正文，两个签名都不会响**。
      · **本条款 `n=4` 里有两例本检查结构上看不见**：第 3 例（`node -e "…"` 经
        bash 双引号，`` `gh pr edit` `` 被当命令替换执行掉）与第 4 例（不带引号的
        heredoc 吃掉反引号内容）——它们的后果是**正文内容被静默删掉**，不是变成
        乱码字。**删掉的东西没有签名。** B1 只在被删的位置恰好留着一个占位符时
        才碰得到（#269 那半），其余一概看不见。
      · 只扫 `<ScanRoot>` 顶层的 `.md`（见 `Get-PrBodyScanFiles`），别处的正文不看。

    **假阳性（命中 ≠ 一定是乱码）：**
      · 文件**有意引用**一段乱码样例即命中——条款正文自己就记着这个实例：
        「#175 的 body 是好的，只因**引用了**一段乱码样例而命中一次」。
        ⇒ 判据是「**零命中，或命中处是你有意引用的样例**」，最后那一步是人判的。
      · A1 那四个字是真实汉字，写它们本身（如本文件的注释）就会命中。
      · **A2 有一个实测出来的假阳性形态**（本机实跑，不是设想）：

            '售价€100'      → **命中**（`价` 与 `€` 之间没有空格）
            '价格 €100 元'  → 不命中（有空格 ⇒ 判据的"相邻"不成立）

        即中文价格文本里「汉字紧贴欧元符号」会响。**不为它加收紧规则是刻意的**：
        本体系明令「新增覆盖面须先有真实事故出处，不为假想敌加判据」——这个假阳性
        目前只在我构造的字符串里出现过，`_tmp/` 的 PR 正文里一次都没有。观察线
        误报一次的代价是看一眼，而凭空加一条没人复核过的收紧规则，代价是判据
        本身变得不可信。真撞上了再收，那时它就有出处了。
      · B1 会打到真实的尖括号大写 token（文档里的 `<API_KEY>` 示例）。

    ⇒ **这就是它只能是观察线、不能是硬闸的全部理由**：判据最后一步在人手里，
    做成硬闸只会在合法引用时变红、随即被 `-Skip` 掉，顺带把它平时的作用一并废掉
    （同 `check-worktree-strays` 的闸位取舍；判据正文在
    `ccswitch/rules/dao-officer-clauses.md`「新增机检项先判闸位」）。

.NOTES
    纯函数：不写文件、不起进程、不读环境、不调 `gh`（`verify-all` 不新增网络依赖）。
    读文件一律 `[System.IO.File]::ReadAllLines(..., UTF8)`——**本文件禁用
    `Get-Content`**，那正是它要检的那个病的成因（条款：`Get-Content` 的任何形态
    读无 BOM 文件时内容已经毁了）。一个用 `Get-Content` 写成的乱码检测器，会在
    自己读进来的那一刻制造出它要报的东西。
    改这里请同步 `tests/pr-body-scan.tests.ps1`——那里的断言是本判据的可执行形态。
    本文件含中文注释，必须以 **BOM UTF-8** 存盘（PS 5.1 解析器要求）。
#>

# ── 判据字面（提成 script 级常量：同一判据被抄成多份是已实证的缺陷来源，
#    见 check-clauses-structure.ps1 的 issue #285／#286 两处头注）─────────────
# A1：条款原文那四个字，**逐字复制，不增不减**。刻意保留字面形态而不写成码点，
#     是为了让「跟条款正文一模一样」这件事肉眼可核（判据来源可验 > 判据抗损坏）。
$script:PrBodySignature4 = '[锛銆馃鈥]'
# A2：`€`(U+20AC) 与 CJK(U+4E00-U+9FFF) 相邻。**由码点拼出而非写字面**：这一条
#     不是从条款正文抄来的（是本文件补的扩展签名），没有"逐字可核"的需求，反倒
#     需要范围端点写得明确——字面的 `鿿` 谁也认不出是 U+9FFF。
$script:PrBodyEuroAdjCjk = ('[{0}-{1}]{2}|{2}[{0}-{1}]' -f [char]0x4E00, [char]0x9FFF, [char]0x20AC)
# B1：未替换占位符。`{2,}` ⇒ 至少三字符（`<AB>` 不算，避免打到 HTML 式短标签）。
$script:PrBodyPlaceholder = '<[A-Z][A-Z0-9_]{2,}>'
# B2：📸 证据行 + 三态里明文不成立的措辞（逐字取自 pr-evidence-rule.md 母版三态）。
$script:PrBodyEvidenceMark = '📸'
$script:PrBodyUnfilled = '待补|TBD|随后补'

function Test-PrArtifactName {
    <#
      文件名看着像不像「PR/issue 正文或回读记录」。**纯展示用，不参与任何判定**——
      它只让输出能区分「扫了 3 个 md 但没有一个是回读记录」与「扫了 3 个回读记录」。
      判据取自条款正文写死的两个文件名（`pr-<n>-readback.md`、`pr-body-<slug>.md`）
      再放宽一点。**近似**：官们给正文文件起名没有统一约定，两个方向都会错。
    #>
    param([string]$Name)
    return [bool]($Name -match '(?i)(readback|pr-body|^pr-\d+|^issue-\d+|comment)')
}

function Get-PrBodyScanFiles {
    <#
      挑出扫描面里的文件。返回 `{ RootExists; Files; Oversized }`。

      ## 扫描面为什么是「`<Root>` 顶层的 `.md`，**不递归**」

      三条判据，按重要性排：
        ① **条款写死的两个文件名都在 `_tmp/` 根**：`_tmp/pr-<n>-readback.md`（第③步
           回读产物）与 `_tmp/pr-body-<slug>.md`（`gh pr create` 撞 5xx 的降级路径）。
           扫描面对准判据来源，不自行发明。
        ② **递归会把 `_tmp/` 变成噪音源**：出处仓 `_tmp/` 下常驻 `verify/`（每道验证的
           日志）、`qa/`（走查截图）等子目录，各官的临时夹具目录也都落在这里。
           （原文举的第三例是 `clauses-date-test/`——那个测试 2026-08-02 随条款库
           结构闸收敛到 dao 而退役，例子失效，判据不受影响：任何一个往 `_tmp/`
           子目录写 `.md` 的测试都能复现同一个噪音。**这段订正是上移当天从被删的那份
           副本里捞回来的** —— 去重前先问「留下的那份，说得出被删那份说的每一件事吗」。）
           递归扫等于让本检查每次报几十个与 PR 正文无关的文件——
           「生下来就吵的检查一定会被静音」已有先例。
        ③ 不递归让「这次到底扫了哪几个文件」能整行打印出来，读的人不必去猜分母。

      **代价照直写**：有人把正文写成 `_tmp/pr/292.md`（子目录）或 `_tmp/body.txt`
      （非 .md）就扫不到，且**扫不到时的表现与「没有正文」完全一样**——这正是
      本检查自己要防的那种失明，它在自己身上没有解，只能靠这段文字说明。

      **零样本不是零违例**：`Files` 为空时调用方必须报「零样本」而不是报「通过」，
      判据同 `check-clauses-structure.ps1` 检查 5 的 `zero-sample` 信号。
    #>
    param(
        [Parameter(Mandatory)][string]$Root,
        [int]$MaxFileKB = 2048
    )

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return [PSCustomObject]@{ RootExists = $false; Files = @(); Oversized = @() }
    }

    $files = @()
    $oversized = @()
    # -File：只要文件不要目录；-Filter *.md 由 provider 侧过滤，比事后 Where 快且不
    # 依赖大小写（Windows 上 .MD 同样命中）。**无 -Recurse 是判据不是疏忽**，见上。
    # **按修改时间倒序**（2026-07-29 真实数据实测后改的，原先按名字排）：`_tmp/` 是
    # 草稿目录，会长期沉积历次 PR 的正文与回读记录。本检查关心的是「**本批**发出去的
    # 那份干不干净」，而按名字排会把 `clippy-hang-recon.md` 这类陈年文件排在最前，
    # 限量折叠后**最相关的那几条恰好被折进去**。倒序让本批的记录永远排第一。
    # 计数不受影响（条数始终全量），改的只是**谁先被看见**。
    # 次级键取 Name：同一秒写出的多个文件（测试夹具就是这样）否则顺序不稳 ⇒ 断言会飘。
    $items = @(Get-ChildItem -LiteralPath $Root -Filter '*.md' -File -ErrorAction SilentlyContinue)
    foreach ($it in ($items | Sort-Object -Property @{ Expression = 'LastWriteTime'; Descending = $true }, @{ Expression = 'Name'; Descending = $false })) {
        $kb = [Math]::Round($it.Length / 1KB, 1)
        $rec = [PSCustomObject]@{
            Path         = $it.FullName
            Name         = $it.Name
            SizeKB       = $kb
            IsPrArtifact = (Test-PrArtifactName -Name $it.Name)
        }
        # 体积闸：观察线绝不能成为验证流程的新故障点（读一个 200MB 的 md 会让
        # verify-all 平白多等几十秒）。超限的**照样列出来**，只是不读——
        # 静默跳过才是这道检查要防的病。
        if ($it.Length -gt ($MaxFileKB * 1KB)) { $oversized += $rec } else { $files += $rec }
    }

    return [PSCustomObject]@{ RootExists = $true; Files = @($files); Oversized = @($oversized) }
}

function Get-PrBodyLineHits {
    <#
      在一组行里找命中，返回 `{ File; LineNo; Line; Hit; Index }`。
      `Hit` 是**实际命中的那一小段字符**（`[regex]::Match().Value`），不是整行——
      报告里要能一眼看出「响的是哪个签名字」，只贴整行会让人分不清是 A1 还是 A2。
      `Index` 是命中在该行里的字符偏移，供调用方把摘录**以命中为中心**截取。
      （2026-07-29 真实数据实测加的：原先摘录一律从行首截 72 字，而乱码常出现在
      长行的中后段 ⇒ 屏幕上那一行**看不见任何异常**，读的人只能自己去开文件。
      一个"指出问题在哪"的工具，摘录里不含问题本身，等于没指。）
    #>
    param(
        # ⚠ `[AllowEmptyString()]` **不是可有可无的装饰**（2026-07-29 真实数据实测）：
        #    PowerShell 的 Mandatory 校验对集合参数是**逐元素**判「非空」的 ⇒ 只要正文
        #    里有一个空行（也就是**任何**一份真实的 PR body），整次调用就绑定失败。
        #    首版漏了它，后果不是报错退出，是**每个文件都静默跳过、末尾照报「均零命中」**
        #    ——被测那条条款要防的病，在检测器自己身上原样重演了一遍。
        #    合成夹具全都没有空行，所以 47 条断言全绿；是拿出处仓 `_tmp/` 里 16 份真实
        #    正文跑了一遍才现形（dao-officer-clauses.md：近似手段的验证语料禁只来自本轮构造的形态）。
        [Parameter(Mandatory)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Lines,
        [Parameter(Mandatory)][string]$Pattern,
        [string]$File = ''
    )
    $hits = @()
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $m = [regex]::Match($Lines[$i], $Pattern)
        if (-not $m.Success) { continue }
        $hits += [PSCustomObject]@{
            File   = $File
            LineNo = ($i + 1)
            Line   = $Lines[$i]
            Hit    = $m.Value
            Index  = $m.Index
        }
    }
    return @($hits)
}

function Get-PrBodyExcerpt {
    <#
      以命中位置为中心截一段摘录，两端有省略时加省略号。
      纯函数、无副作用，单独测得动（调用方只负责打印）。
      `$Before` 默认 28：让命中前后都留下上下文，而不是把命中顶在行首。
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Line,
        [int]$Index = 0,
        [int]$Width = 72,
        [int]$Before = 28
    )
    if ($Line.Length -le $Width) { return $Line }
    $start = [Math]::Max(0, $Index - $Before)
    $start = [Math]::Min($start, [Math]::Max(0, $Line.Length - $Width))
    $len = [Math]::Min($Width, $Line.Length - $start)
    $excerpt = $Line.Substring($start, $len)
    if ($start -gt 0) { $excerpt = '…' + $excerpt }
    if (($start + $len) -lt $Line.Length) { $excerpt = $excerpt + '…' }
    return $excerpt
}

function Get-PrBodyEvidenceHits {
    <#
      信号 B2：**只在含 `📸` 的行上**判「待补 / TBD / 随后补」。
      为什么不全文件判：这三个词在调研笔记、TODO 草稿里是正常用词，全文件判会让
      本检查在任何一份笔记上都响 —— 而它响的是与 PR 证据三态无关的东西。
      判据来源是 `ccswitch/templates/pr-evidence-rule.md`：📸 那一行三态**恰选其一**，
      第三态必须是真实 issue 编号，「待补」「TBD」「随后补」都不成立。
    #>
    param(
        # ⚠ `[AllowEmptyString()]` **不是可有可无的装饰**（2026-07-29 真实数据实测）：
        #    PowerShell 的 Mandatory 校验对集合参数是**逐元素**判「非空」的 ⇒ 只要正文
        #    里有一个空行（也就是**任何**一份真实的 PR body），整次调用就绑定失败。
        #    首版漏了它，后果不是报错退出，是**每个文件都静默跳过、末尾照报「均零命中」**
        #    ——被测那条条款要防的病，在检测器自己身上原样重演了一遍。
        #    合成夹具全都没有空行，所以 47 条断言全绿；是拿出处仓 `_tmp/` 里 16 份真实
        #    正文跑了一遍才现形（dao-officer-clauses.md：近似手段的验证语料禁只来自本轮构造的形态）。
        [Parameter(Mandatory)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Lines,
        [string]$File = ''
    )
    $hits = @()
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i].IndexOf($script:PrBodyEvidenceMark) -lt 0) { continue }
        $m = [regex]::Match($Lines[$i], $script:PrBodyUnfilled)
        if (-not $m.Success) { continue }
        $hits += [PSCustomObject]@{
            File   = $File
            LineNo = ($i + 1)
            Line   = $Lines[$i]
            Hit    = $m.Value
            Index  = $m.Index
        }
    }
    return @($hits)
}

function Invoke-PrBodyScan {
    <#
      扫一遍扫描面，返回结构化结果。**恒不抛、恒不写盘**——单个文件读失败只进
      `Unreadable` 清单，不中断整轮（观察线不该因为 `_tmp/` 里一个坏文件而停摆）。

      返回字段里最要紧的是 `ZeroSample`：**它为真时，其余所有「零命中」都是空的**。
      调用方必须把这两种状态报成不同的东西——「检测器数到 0 个违例」与「检测器
      根本没看到样本」在输出上不可区分，是 mousse-cli issue #285 已实证过的病灶形态。
    #>
    param(
        [Parameter(Mandatory)][string]$Root,
        [int]$MaxFileKB = 2048
    )

    # **函数作用域内强制 Stop**（2026-07-29 加，起因见下）：调用方是观察线，它把
    # `$ErrorActionPreference` 设成 'Continue' 以免自己变成新故障点——**而那个设置会
    # 一路继承进来**，于是这里的非终止错误（参数绑定失败、正则异常）会被逐条打到
    # 屏幕上然后**当没发生过继续跑**，末尾照常汇报「均零命中」。
    # 实测：首版就是这么坏的——16 份真实正文全部绑定失败、一个字节都没扫，
    # 退出码 0、结论「零命中」。**「扫过且干净」与「压根没扫成」再一次不可区分。**
    # 现在：错误一律变终止 → 被下面的 catch 接住 → 进 `Unreadable` → 被打印出来，
    # 且不计入 `Scanned` ⇒ 全军覆没时 `ZeroSample` 为真，报的是「零样本」不是「通过」。
    $ErrorActionPreference = 'Stop'

    $found = Get-PrBodyScanFiles -Root $Root -MaxFileKB $MaxFileKB
    $sig4 = @(); $euro = @(); $ph = @(); $ev = @(); $unreadable = @(); $scanned = @()

    foreach ($f in @($found.Files)) {
        try {
            # 禁 Get-Content（见文件头 .NOTES）：它对无 BOM 文件按系统 ANSI 代码页
            # 解码，会在读进来的那一刻**制造**本检查要报的乱码 —— 一个自证式假阳性。
            $lines = [System.IO.File]::ReadAllLines($f.Path, [System.Text.Encoding]::UTF8)
            # 读与扫**一起**放进 try：首版只把读包了起来，而真正炸的是扫那几行。
            # 「只保护自己想到的那一步」是这类 catch 的通病。
            $sig4 += @(Get-PrBodyLineHits -Lines $lines -Pattern $script:PrBodySignature4 -File $f.Name)
            $euro += @(Get-PrBodyLineHits -Lines $lines -Pattern $script:PrBodyEuroAdjCjk -File $f.Name)
            $ph   += @(Get-PrBodyLineHits -Lines $lines -Pattern $script:PrBodyPlaceholder -File $f.Name)
            $ev   += @(Get-PrBodyEvidenceHits -Lines $lines -File $f.Name)
            $scanned += $f.Name
        } catch {
            $unreadable += [PSCustomObject]@{ Name = $f.Name; Error = $_.Exception.Message }
        }
    }

    $files = @($found.Files)
    return [PSCustomObject]@{
        Root          = $Root
        RootExists    = $found.RootExists
        Files         = $files
        Scanned       = @($scanned)
        Oversized     = @($found.Oversized)
        Unreadable    = @($unreadable)
        # **判据是「成功扫完了几个」，不是「目录里有几个」**——超限跳过的、读失败的、
        # 扫到一半炸的，一律不算样本。三种「什么都没发生」于是收敛成同一个诚实的旗标，
        # 各自的原因由 Oversized / Unreadable 分别说明。
        ZeroSample    = (@($scanned).Count -eq 0)
        ArtifactCount = @($files | Where-Object { $_.IsPrArtifact }).Count
        Signature4    = @($sig4)
        EuroAdjCjk    = @($euro)
        Placeholder   = @($ph)
        Evidence      = @($ev)
    }
}
