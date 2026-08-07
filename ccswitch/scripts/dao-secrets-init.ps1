#requires -Version 5.1
<#
.SYNOPSIS
    建立「凭据根」：装 sops + age、生成 age 私钥、写 .sops.yaml、跑一次加解密自证。
    issue #135 第二步的前半。**这个脚本由用户跑，不由 AI 跑。**

.DESCRIPTION
    为什么是 SOPS + age 而不是 Windows 凭据管理器 / DPAPI（用户 2026-08-05 拍板）：
    那四条 Windows 方案**没有一条支持跨机迁移** —— 而「换机器不用逐个找密钥」是本 issue
    四个目标里的第 3 个。同时满足「加密存放」与「能带走」的只有 SOPS + age：
    完全本地、免费、不需账号不需联网。

    为什么要你跑而不是 AI 跑：**凭据的事交用户经手**（用户既定约束）。
    AI 出方案、写脚本、改代码；按下去那一下是你的。

    做完这个脚本之后，盘上长这样（-KeyLocation Separate，**默认**）：

        %USERPROFILE%\.dao-secrets\        ← 凭据根：**只有密文**，没有钥匙
          ├── .sops.yaml          加密规则（只含 age **公钥**，公钥泄露无害）
          └── <项目 slug>.env     各项目的加密凭据（键名明文可见、值加密）

        %AppData%\sops\age\keys.txt        ← age **私钥**，住在凭据根之外
                                             （这是 sops 在 Windows 上自己的默认位置，
                                              所以不需要 SOPS_AGE_KEY_FILE）

    传 -KeyLocation Portable 则私钥改放 <凭据根>\age\keys.txt，两样东西住一起。
    两者的取舍见下面 .PARAMETER KeyLocation。

    键名命名空间：**用「一个项目一个文件」而不是「一个大文件 + `项目 :: 字段` 前缀」。**
    差别是实的不是风格：一个项目一个文件时，**文件名就是命名空间**，各项目的键名
    （`GITHUB_USER` 之类）**一个字都不用改** ⇒ 消费方代码零改动，`sops exec-env` 也能
    直接把它们喂进子进程环境。合成一个大文件才需要 `::` 前缀，而那个前缀反过来要求
    每个消费方都改读法。dao 自己的 `config-sync/common-secrets.json` 用 `::` 是因为它
    只有一个文件、且它是**恢复端**不是读取端。

.PARAMETER KeyLocation
    Separate（**默认**）—— 私钥放 sops 在 Windows 上的默认位置 %AppData%\sops\age\keys.txt，
                          加密文件仍在 SecretsDir。因为是 sops 自己的默认位置，
                          **不需要设 SOPS_AGE_KEY_FILE**。
    Portable         —— 私钥放 <SecretsDir>\age\keys.txt，整个文件夹拷走即完成换机。

    ## 先说清楚这个开关到底在选什么（2026-08-06 重写，原文答错了问题）

    原文拿「怕不怕被整包拷走」对上「怕不怕私钥丢了」，让人以为要在两种恐惧里挑一个。
    **用户在乎的根本不是那两件**，他要的只有一件：

        🔴 **密钥不要混在程序代码里。**

    而**这一件两种模式都已经满足了** —— 凭据根默认就在 %USERPROFILE%\.dao-secrets，
    本来就在任何项目工作树之外。⇒ **这个开关不参与主诉求的成败**，它只在主诉求之上
    再加一层，所以它该按「加的这层值不值」来选，不该按「你更怕哪一种灾难」来选。

    ## 那为什么默认是 Separate

    ① **私钥丢了不要紧 —— 用户明说的**：丢了就重新 age-keygen 一把、把凭据重填一遍，
       麻烦但不致命（那些值本来也都能重新申请）。
       ⇒ Portable 唯一的卖点「一个文件夹拷走即换机」**建立在「私钥很宝贵、要小心带走」
       这个前提上，而前提不成立** ⇒ 卖点归零。
    ② **Separate 多挡一格**：有人专门拷 %USERPROFILE%\.dao-secrets 这个文件夹时，
       他拿到的是一堆打不开的密文。Portable 下他连钥匙一起拿走了。
    ⇒ 一边卖点归零、一边白得一格 ⇒ 默认 Separate。**用户 2026-08-06 拍板**（issue #72
    「最近拍板」节）。这不是本脚本的判断。

    ## 🔴 Separate 买到的那一格有多大 —— 照直写，别当成「另一个目录就安全了」

    **本机实测：%AppData% 在 %USERPROFILE% 里面**（C:\Users\<你>\AppData\Roaming
    vs C:\Users\<你>）⇒ **Separate 挡不住「整个用户目录被备份 / 同步 / 做镜像」** ——
    那种情况下私钥和密文照样一起走。它只挡「有人专门拷 .dao-secrets 这一个文件夹」。
    这是一格真的、但很窄的收益。**要挡住前者得把私钥挪出 %USERPROFILE%，本脚本没做这件事。**

    ## Portable 什么时候仍然更合适

    你确实要在多台机器之间来回搬、且嫌「搬两处」容易漏 —— 那就传 -KeyLocation Portable。
    代价是那个文件夹从此**自带钥匙**：谁拷走它谁就解得开。

.NOTES
    工艺（照 ccswitch/rules/dao-powershell.md）：
    - 不用 `Get-Content` 读任何凭据文件 —— PS 5.1 读无 BOM UTF-8 会按 ANSI 代码页解码，
      内容当场就毁了，而且不报错。要读一律 [IO.File]::ReadAllText(..., UTF8)。
    - 不用 `2>&1` 捕获 native 命令输出 —— 会被包成 NativeCommandError 误判为终止性错误。
      判成败一律看 $LASTEXITCODE。
    - **本脚本从不把任何密钥值读进 PowerShell 变量、更不打印。** 自证用的是一次性探针值，
      与你的真实凭据无关。
    - 🔴 **每一条 sops 调用都显式钉 `--config <凭据根>\.sops.yaml`。**
      理由不是风格：**sops 找 `.sops.yaml` 是从「你当前所在的目录」逐级向上找，
      跟被加密的那个文件在哪没有关系。** 不钉的话，从仓库根或用户主目录跑本脚本，
      第 6 步自证必然 `config file not found, or has no creation rules` 退出 1
      （2026-08-05 甲路对抗实跑逮到，2026-08-06 本机复现：四组对照里「文件在凭据根内、
      当前目录在凭据根外」照样失败 ⇒ 这不是路径没写对，是发现机制本身）。
      ⚠ `--config` 是**全局位**，必须放在 `encrypt` / `decrypt` **前面**，放后面 sops 直接
      `flag provided but not defined: -config` 退出 1（本机实测）。
      decrypt 其实**不需要**它（实测不钉也 exit 0 —— 解密用的是文件自带的元数据），
      照样钉是为了让「当前目录上方有没有别人的 .sops.yaml」这个变量彻底离开等式。

    ## 🔴 退出码分档（用户 2026-08-07 拍板，issue #148。形态照 mousse-cli verify-all 的四态）

        0  全成：钥匙在、.sops.yaml 在、第 6 步自证过了，**而且 ACL 也收紧了**
        2  **主体成功，但 ACL 没收紧**：上面那些都成了，只有 icacls 没成
           （非 NTFS 卷 —— U 盘 exFAT、网络盘、某些容器挂载 —— 本来就不支持 ACL）
        1  真失败：工具没装 / 私钥没生成 / 公钥取不到 / 自证没过 …… 该做的事没做成

    改这一档之前是「ACL 失败也 exit 0 + 一行红字」。为什么不够：**红字骗不到人眼，
    骗得到只读退出码的消费方** —— 而「权限没收紧」与「一切正常」在唯一的机器可读通道上
    长得一模一样，正是 mousse-cli 那个四态退出码存在要治的病。
    为什么不干脆 fail-closed（ACL 失败即非零并当失败）：那会在最能体现「能带走」的介质
    （U 盘 exFAT）上直接拦人，而「能带走优先」是用户 2026-08-05 拍的方向 ⇒ 两者直接冲突。
    分档两边都不牺牲：**不挡人，也不再谎报。**

    ⚠ 消费方三条（照 ccswitch/rules/dao-powershell.md）：
      - 判「全成」写 `-eq 0`。**别写 `-le 2`** —— 那个区间把 1（真失败）也放进来了。
      - 接受「2 也算过」时要显式写出来（`@(0,2) -contains $code`），别让它躲在 `-ne 1` 里。
      - 要拿退出码一律 `powershell -File <脚本>`，**禁 `-Command "& '<脚本>'"`** ——
        后者只按「最后一条命令成败」返回 0/1，**不透传脚本里的 exit N**，分档当场被抹平
        （dao-powershell.md 第六坑，实测 exit 3 经 -Command 拿到 1）。
    ~~-DryRun 恒 0（它一个写操作都不做，也就没有 ACL 这一格）。~~
    **订正（2026-08-07 · PR #170 对抗验证，账 issue #173）**：上面那句是笃定措辞，
    有现实可达的反例。准确的说法是 —— **-DryRun 在「过了第 0 步工具前置检查」之后恒 0**
    （它一个写操作都不做，也就没有 ACL 这一格）。
    ⚠ 那个前提不是形式：**第 0 步（sops / age-keygen 装了没）排在 -DryRun 块前面**，
      缺任何一个都直接 exit 1，`-DryRun` 拦不住它、也不该拦 —— 工具没有时连「预演」
      都无从谈起。会撞上它的是这条路：装完工具、**没开新终端**（PATH 还没重新加载）就
      跑 -DryRun。`docs/USER-ACTIONS.md` 第 1 步末尾已写着「装完开一个新终端」，
      所以那不是文档在教错，是**读者跳读时会漏掉的一行**。
    ⚠ 照直写没验的那半：**「缺工具 ⇒ -DryRun 也退 1」这一格目前没有断言**
      （场景 20 只钉住「过了工具检查之后不被 ACL 染成 2」那半）。补它要给测试的调用外壳
      开一个「不上桩 PATH」的口子，本批未做，记在 issue #173 的未尽处里。
    ⚠ **`1` 压过 `2`**：ACL 没收紧、同时主体又真失败了 ⇒ 退 `1`。`2` 的定义是「主体成功」，
      不是「失败得轻一点」—— 这一条塌了，`2` 这个值就不能再信。
    上面这三句（0/2/1 各是什么 · -DryRun 过了工具检查之后恒 0 · 1 压过 2）由回归网
    `tests/dao-secrets.tests.ps1` 钉住。**`2` 这一档有三个场景，别只看 19**：
    **19 = 两个 ACL 目标全败 · 22 = 一成一败 · 23 = Portable**（后两个 2026-08-07 补，
    issue #173 F5 —— 此前 `2` 只在「Separate + 全败」这一种形态下被验过）；
    `-DryRun` 那句在场景 20，「1 压过 2」在场景 21。
    判别力实测见该文件头注附三之三与**附三之四**。
    ⚠ 这一档信的仍然是 `icacls` 自报的退出码，**没有 ACL 读回校验**（issue #148 明写维持现状：
    icacls 输出是本地化的，解析它会换来一个新的脆弱点）⇒ **`0` 的含义是「icacls 说它成了」，
    不是「已独立核实权限确实收紧了」。**

    先跑 -DryRun。
#>
[CmdletBinding()]
param(
    [string]$SecretsDir = "$env:USERPROFILE\.dao-secrets",
    [ValidateSet('Portable', 'Separate')]
    [string]$KeyLocation = 'Separate',
    [switch]$SetUserEnvVar,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Fail($m) { Write-Host "  [失败] $m" -ForegroundColor Red; exit 1 }
function Ok($m) { Write-Host "  [完成] $m" -ForegroundColor Green }
function Note($m) { Write-Host "  [注意] $m" -ForegroundColor Yellow }

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

Write-Host '=== 0. 前置检查：sops 与 age 装了没 ===' -ForegroundColor Cyan

$sops = Get-Command sops -ErrorAction SilentlyContinue
$age = Get-Command age-keygen -ErrorAction SilentlyContinue

if (-not $sops -or -not $age) {
    Write-Host ''
    Write-Host '  两个工具都要装。用 winget（本机已实测这两个包 ID 存在）：' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '      winget install SecretsOPerationS.SOPS'
    Write-Host '      winget install FiloSottile.age'
    Write-Host ''
    Write-Host '  🔴 sops 那个包 ID 别选错：winget 里有两个。' -ForegroundColor Red
    Write-Host '     SecretsOPerationS.SOPS  = 3.13.2（当前维护中的，选这个）'
    Write-Host '     Mozilla.SOPS            = 3.7.3（项目早已从 Mozilla 迁到 getsops，这个是陈的）'
    Write-Host ''
    Write-Host '  装完**开一个新终端**再跑本脚本（PATH 要重新加载）。'
    Write-Host ''
    if (-not $sops) { Write-Host '  缺：sops' -ForegroundColor Red }
    if (-not $age) { Write-Host '  缺：age-keygen' -ForegroundColor Red }
    exit 1
}

$sopsVer = & sops --version --disable-version-check
if ($LASTEXITCODE -ne 0) { Fail "sops --version 退出码 $LASTEXITCODE" }
Ok "sops：$($sops.Source)"
Write-Host "         $sopsVer"
Ok "age-keygen：$($age.Source)"

# 私钥落点
if ($KeyLocation -eq 'Portable') {
    $keyDir = Join-Path $SecretsDir 'age'
    $needEnvVar = $true
} else {
    $keyDir = Join-Path $env:AppData 'sops\age'
    $needEnvVar = $false
}
$keyFile = Join-Path $keyDir 'keys.txt'
$sopsYaml = Join-Path $SecretsDir '.sops.yaml'

Write-Host ''
Write-Host '=== 1. 现状（只读）===' -ForegroundColor Cyan
Write-Host "  凭据根      ：$SecretsDir  $(if (Test-Path $SecretsDir) { '（已存在）' } else { '（待建）' })"
Write-Host "  私钥        ：$keyFile  $(if (Test-Path $keyFile) { '（已存在）' } else { '（待建）' })"
Write-Host "  加密规则    ：$sopsYaml  $(if (Test-Path $sopsYaml) { '（已存在）' } else { '（待建）' })"
Write-Host "  私钥落点模式：$KeyLocation$(if ($needEnvVar) { '（需要 SOPS_AGE_KEY_FILE 指过去）' } else { '（sops 默认位置，不需环境变量）' })"

$keyExists = Test-Path $keyFile

if ($DryRun) {
    Write-Host ''
    Write-Host '=== DryRun：以下写操作不执行 ===' -ForegroundColor Yellow
    Write-Host "  [将做] 建目录 $SecretsDir 与 $keyDir，并用 icacls 收成「只有你能读」"
    if ($keyExists) {
        Write-Host '  [跳过] 私钥已存在 —— **绝不覆盖**。覆盖 = 已加密的文件全部永久打不开'
    } else {
        Write-Host "  [将做] age-keygen 生成私钥到 $keyFile（私钥值不打印）"
    }
    Write-Host "  [将做] 写 $sopsYaml（只含 age 公钥）"
    if ($needEnvVar -and $SetUserEnvVar) { Write-Host '  [将做] 设用户级环境变量 SOPS_AGE_KEY_FILE' }
    elseif ($needEnvVar) { Write-Host '  [将做] 打印 SOPS_AGE_KEY_FILE 该怎么设（不自动设；要自动设加 -SetUserEnvVar）' }
    Write-Host '  [将做] 自证：拿一个一次性探针值走一遍 加密→解密→比对（与你的真实凭据无关）'
    exit 0
}

Write-Host ''
Write-Host '=== 2. 建目录 + 收紧权限 ===' -ForegroundColor Cyan
foreach ($d in @($SecretsDir, $keyDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    if (-not (Test-Path $d)) { Fail "目录没建成：$d" }
}
# 收哪几个目录：Portable 时私钥目录在凭据根**里面**，靠继承即可（对子目录再断一次继承，
# 反而会把刚从父目录传下来的那条 ACE 断掉）；Separate 时私钥在 %AppData%\sops\age，
# **在凭据根之外** —— 不单独收就完全没人管它，而它恰恰是全套里唯一不可再生的东西。
$aclTargets = @($SecretsDir)
if ($KeyLocation -eq 'Separate') { $aclTargets += $keyDir }

# 断继承 + 只留当前用户。icacls 失败**不中断**（NTFS 之外的盘可能不支持），但要说出来 ——
# 而且要在**最后一屏**再说一遍（见第 7 节）：中间这行黄字会被后面一整屏绿色盖过去。
# ⚠ 「不中断」不等于「不留痕」：本次若有目录没收紧，**脚本末尾退出码是 2 而不是 0**
# （用户 2026-08-07 拍板，issue #148；契约全文在 .NOTES「退出码分档」）。
# 屏幕归人读，退出码归机器读 —— 那一档补的正是后者此前一直在说「一切正常」。
$aclFailed = @()
foreach ($t in $aclTargets) {
    & icacls $t /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $aclFailed += $t
        Note "icacls 退出码 $LASTEXITCODE —— 这个目录权限没收紧，仍可能被其他账户读到：$t"
    } else {
        Ok "权限已收成「只有 $env:USERNAME」：$t"
    }
}

Write-Host ''
Write-Host '=== 3. age 私钥 ===' -ForegroundColor Cyan
if ($keyExists) {
    Note "私钥已存在，**不覆盖**：$keyFile"
    Write-Host '         （覆盖它 = 此前用旧公钥加密的文件全部永久打不开。要换钥匙得先解密再重加密。）'
} else {
    & age-keygen -o $keyFile
    if ($LASTEXITCODE -ne 0) { Fail "age-keygen 退出码 $LASTEXITCODE" }
    if (-not (Test-Path $keyFile)) { Fail '私钥没落盘' }
    Ok "私钥已生成：$keyFile（值不打印）"
}

# 取公钥。公钥在 keys.txt 的注释行里，形如：# public key: age1...
# 公钥泄露无害（它只能用来加密，不能解密），所以这里读它、打印它都没问题。
$keyText = [IO.File]::ReadAllText($keyFile, [Text.Encoding]::UTF8)
$m = [regex]::Match($keyText, '(?m)^#\s*public key:\s*(age1[0-9a-z]+)\s*$')
if (-not $m.Success) { Fail "从 $keyFile 里取不到公钥（找不到 '# public key: age1...' 那一行）" }
$pubKey = $m.Groups[1].Value
Ok "age 公钥：$pubKey"

Write-Host ''
Write-Host '=== 4. 写加密规则 .sops.yaml ===' -ForegroundColor Cyan
if (Test-Path $sopsYaml) {
    $bak = "$sopsYaml.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $sopsYaml $bak -Force
    if (-not (Test-Path $bak)) { Fail '.sops.yaml 备份没落盘' }
    Ok "旧 .sops.yaml 已备份：$bak"
}
$yaml = @"
# dao 凭据根的加密规则（issue #135）。由 ccswitch/scripts/dao-secrets-init.ps1 生成。
# 这里只有 **公钥**，可以随便看、随便进 git —— 它只能加密，不能解密。
# 私钥在：$keyFile
creation_rules:
  - path_regex: \.env$
    age: $pubKey
  - age: $pubKey
"@
[IO.File]::WriteAllText($sopsYaml, $yaml, $utf8NoBom)
if (-not (Test-Path $sopsYaml)) { Fail '.sops.yaml 没落盘' }
Ok "已写：$sopsYaml"

Write-Host ''
Write-Host '=== 5. SOPS_AGE_KEY_FILE ===' -ForegroundColor Cyan
if (-not $needEnvVar) {
    Ok '私钥在 sops 的 Windows 默认位置（%AppData%\sops\age\keys.txt），不需要环境变量'
} else {
    $old = [Environment]::GetEnvironmentVariable('SOPS_AGE_KEY_FILE', 'User')
    if ($SetUserEnvVar) {
        if ($old) { Write-Host "  旧值（复原用）：$old" }
        [Environment]::SetEnvironmentVariable('SOPS_AGE_KEY_FILE', $keyFile, 'User')
        $back = [Environment]::GetEnvironmentVariable('SOPS_AGE_KEY_FILE', 'User')
        if ($back -ne $keyFile) { Fail "环境变量没设上（读回来是：$back）" }
        Ok "已设用户级 SOPS_AGE_KEY_FILE = $keyFile"
        Note '新开的终端才读得到它。当前这个终端不会自己更新。'
        if ($old) { Write-Host "  复原用：[Environment]::SetEnvironmentVariable('SOPS_AGE_KEY_FILE','$old','User')" }
        else { Write-Host "  复原用：[Environment]::SetEnvironmentVariable('SOPS_AGE_KEY_FILE',`$null,'User')" }
    } else {
        Note '没自动设（要自动设就加 -SetUserEnvVar 重跑）。手动设是这一行：'
        Write-Host ''
        Write-Host "      [Environment]::SetEnvironmentVariable('SOPS_AGE_KEY_FILE','$keyFile','User')"
        Write-Host ''
        if ($old) { Write-Host "  当前已有值：$old" }
    }
    # 本进程内先设上，否则下一步自证必失败
    $env:SOPS_AGE_KEY_FILE = $keyFile
}

Write-Host ''
Write-Host '=== 6. 自证：加密→解密→比对（用一次性探针值，与你的真实凭据无关）===' -ForegroundColor Cyan
$probeDir = Join-Path $SecretsDir '_selftest'
if (-not (Test-Path $probeDir)) { New-Item -ItemType Directory -Path $probeDir -Force | Out-Null }
$probePlain = Join-Path $probeDir 'probe.env'
$probeEnc = Join-Path $probeDir 'probe.enc.env'
$probeOut = Join-Path $probeDir 'probe.out.env'
$probeVal = "dao135-selftest-$([guid]::NewGuid().ToString('N'))"
try {
    [IO.File]::WriteAllText($probePlain, "DAO_SELFTEST_PROBE=$probeVal`n", $utf8NoBom)

    # --config 必须钉、且必须在 encrypt 前面（全局位）。理由见 .NOTES：
    # sops 从**当前目录**向上找 .sops.yaml，不从被加密文件所在目录找。
    & sops --config $sopsYaml encrypt --input-type dotenv --output-type dotenv --output $probeEnc $probePlain
    if ($LASTEXITCODE -ne 0) { Fail "sops encrypt 退出码 $LASTEXITCODE" }
    if (-not (Test-Path $probeEnc)) { Fail '加密文件没落盘' }

    # 密文里绝不该出现明文探针值。这一条同时验了「加密真的发生了」——
    # 只验「命令退出码 0」是不够的：一个把内容原样抄过去的实现也会 exit 0。
    $encText = [IO.File]::ReadAllText($probeEnc, [Text.Encoding]::UTF8)
    if ($encText.Contains($probeVal)) { Fail '密文里能看到明文探针值 —— 加密没真的发生，停' }
    Ok '加密：密文里搜不到明文探针值'

    & sops --config $sopsYaml decrypt --input-type dotenv --output-type dotenv --output $probeOut $probeEnc
    if ($LASTEXITCODE -ne 0) { Fail "sops decrypt 退出码 $LASTEXITCODE（私钥找不到？检查 SOPS_AGE_KEY_FILE）" }
    $outText = [IO.File]::ReadAllText($probeOut, [Text.Encoding]::UTF8)
    if (-not $outText.Contains($probeVal)) { Fail '解密回来的内容对不上 —— 链路不通，停' }
    Ok '解密：值原样回来了'
    Write-Host '  ⇒ 加密链路整条通了（生成钥匙 → 加密 → 解密 → 值一致）'
} finally {
    foreach ($f in @($probePlain, $probeEnc, $probeOut)) {
        if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
    }
    if (Test-Path $probeDir) { Remove-Item $probeDir -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host '=== 7. 接下来 ===' -ForegroundColor Cyan

# 🔴 权限那条**再说一遍**。第 2 节说过一次，但那一行黄字后面跟着一整屏绿色 ——
# 用户读的是最后几行。「一屏绿 + 一行黄」与「一切正常」在肉眼上不可区分。
# （这里治的是**人眼**那一半；机器那一半 2026-08-07 起由末尾的 exit 2 治，见文件最后。
#  两半都要：只改退出码，用户看不懂发生了什么；只印红字，脚本的消费方照旧读到「一切正常」。）
if ($aclFailed.Count) {
    Write-Host ''
    Write-Host '  🔴 有目录的权限没收紧（第 2 节报过，这里再说一遍，因为你读的是最后几行）：' -ForegroundColor Red
    foreach ($t in $aclFailed) { Write-Host "        $t" -ForegroundColor Red }
    Write-Host '     ⇒ 这台机器上的其他账户可能读得到它。' -ForegroundColor Red
    # 后果按模式分，别混着说：Portable 下私钥也在凭据根里 ⇒ 读得到就解得开；
    # Separate 下没收紧的若是私钥目录，那就是钥匙本身裸着，比密文裸着更糟。
    if ($KeyLocation -eq 'Portable') {
        Write-Host '        Portable 模式下**私钥也在凭据根里** —— 读得到就等于解得开，' -ForegroundColor Red
        Write-Host '        加密在这种情况下几乎不起作用。' -ForegroundColor Red
    } else {
        Write-Host "        上面若含 $keyDir，那是**私钥目录** —— 钥匙裸着比密文裸着更糟。" -ForegroundColor Red
        Write-Host '        若只是凭据根没收紧，别人拿到的还只是打不开的密文。' -ForegroundColor Red
    }
    Write-Host '        换一个 NTFS 盘上的路径重跑（-SecretsDir <新路径>），或者自己把权限收好。' -ForegroundColor Red
    Write-Host '     （本脚本**不为这个退出 1**：非 NTFS 卷本来就不支持 ACL，硬失败会挡住' -ForegroundColor Red
    Write-Host '       愿意接受这个风险的人。风险是真的，判断权在你 —— 但退出码会说实话：' -ForegroundColor Red
    Write-Host '       **本次退出码 2 = 主体成功但权限未收紧**（0 全成 / 2 这一档 / 1 真失败）。）' -ForegroundColor Red
    Write-Host ''
}

# 注入器「路 B」的一个静默坑，只在你的 TEMP 含空格时才提。
$spacyTemp = @(@($env:TMP, $env:TEMP) | Where-Object { $_ -and $_.Contains(' ') } | Select-Object -Unique)
if ($spacyTemp.Count) {
    Write-Host ''
    Note "你的临时目录路径里有空格：$($spacyTemp -join ' / ')"
    Write-Host '         注入器「路 B」(sops exec-file) 把临时文件路径**纯文本替换**进 {}、不做任何转义，'
    Write-Host '         随后整串交给 cmd。路径含空格时子进程会拿到一个**不存在的路径**，'
    Write-Host '         而 sops 退出码仍然是 0（加引号也救不了，实测）。'
    Write-Host '         要用路 B 就先把 TMP/TEMP 指到一个没有空格的目录。路 A（exec-env）不受影响。'
    Write-Host ''
}

Write-Host '  凭据根建好了，但**里面还没有你的任何凭据**。搬凭据是下一个脚本：'
Write-Host ''
Write-Host '      powershell -File ccswitch\scripts\dao-secrets-migrate.ps1 -DryRun'
Write-Host ''
Write-Host '  这把钥匙在这里，没有第二份、也没有找回通道：' -ForegroundColor Yellow
Write-Host "      $keyFile"
Write-Host '     丢了 = 所有加密文件永久打不开（没有客服、没有备用钥匙）。'
Write-Host '     ⇒ 但**这不是灾难**：重新跑一次本脚本生成新钥匙、把那几个值重填一遍即可 ——'
Write-Host '       那些值本来就都能重新申请。要省掉重填的麻烦，就单独复制一份到密码管理器或离线介质。'
Write-Host '       （这句话 2026-08-06 按用户拍板改过口径：原文写成「没有任何补救」，'
Write-Host '        把「要重来一遍」说成了「完了」——量级不对，会让人为了保管它做过头的事。）'
Write-Host ''
Write-Host '  换机器怎么办：'
if ($KeyLocation -eq 'Portable') {
    Write-Host "      整个 $SecretsDir 文件夹拷过去，再在新机上设一次 SOPS_AGE_KEY_FILE。完了。"
} else {
    Write-Host "      要搬**两处**：$SecretsDir 和 $keyFile。只搬一处等于没搬。"
}

# ── 退出码分档（用户 2026-08-07 拍板，issue #148）───────────────────────────
# 为什么落在**最末尾**而不是第 2 节现场：ACL 没收紧不该中断后面那几屏「你接下来该做什么」
# —— 那些对用户仍然有用。它只需要在**离开这个进程的那一刻**如实说一次。
# 契约（0 / 2 / 1 各是什么、消费方怎么判）全文在 .NOTES「退出码分档」，此处不重述。
if ($aclFailed.Count) {
    Write-Host ''
    Write-Host '  ⇒ 本次退出码 **2**：密钥主体成功（钥匙已生成、加密链路已自证），' -ForegroundColor Red
    Write-Host "     但上面 $($aclFailed.Count) 个目录的权限没收紧。这不是失败，也不是一切正常。" -ForegroundColor Red
    exit 2
}
exit 0
