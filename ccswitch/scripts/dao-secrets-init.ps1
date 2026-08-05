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

    做完这个脚本之后，凭据根长这样（-KeyLocation Portable，默认）：

        %USERPROFILE%\.dao-secrets\
          ├── .sops.yaml          加密规则（只含 age **公钥**，公钥泄露无害）
          ├── age\keys.txt        🔴 age **私钥** —— 全套东西里唯一不可再生的
          └── <项目 slug>.env     各项目的加密凭据（键名明文可见、值加密）

    键名命名空间：**用「一个项目一个文件」而不是「一个大文件 + `项目 :: 字段` 前缀」。**
    差别是实的不是风格：一个项目一个文件时，**文件名就是命名空间**，各项目的键名
    （`GITHUB_USER` 之类）**一个字都不用改** ⇒ 消费方代码零改动，`sops exec-env` 也能
    直接把它们喂进子进程环境。合成一个大文件才需要 `::` 前缀，而那个前缀反过来要求
    每个消费方都改读法。dao 自己的 `config-sync/common-secrets.json` 用 `::` 是因为它
    只有一个文件、且它是**恢复端**不是读取端。

.PARAMETER KeyLocation
    Portable（默认）—— 私钥放 <SecretsDir>\age\keys.txt，**整个文件夹拷走即完成换机**。
    Separate      —— 私钥放 sops 在 Windows 上的默认位置 %AppData%\sops\age\keys.txt，
                     加密文件仍在 SecretsDir。

    🔴 **两者的差别必须说清楚，别只看「哪个方便」**：
    Portable 把私钥和密文放在同一个文件夹里 ⇒ **谁整包拷走这个文件夹，谁就同时拿到了
    密文和解密它的钥匙，加密对「整包拷走」这个动作等于不设防。**
    它防住的是**另一件事**：密钥不再随项目目录被复制 / 提交 / 分享出去 —— 而那正是
    issue #135 的 4 个目标里的第 2 个，也是 P3 那个明文 GitHub 口令的实际风险面
    （那个目录压根不是 git 仓库，不受任何 .gitignore 保护）。
    Separate 换来「整包拷走也没用」，代价是换机要搬两个地方、且容易只搬一个。

    选 Portable 是**用户 2026-08-05 拍板「能带走优先」的直接后果**，不是本脚本的判断。
    改主意就传 -KeyLocation Separate 重跑。

.NOTES
    工艺（照 ccswitch/rules/dao-powershell.md）：
    - 不用 `Get-Content` 读任何凭据文件 —— PS 5.1 读无 BOM UTF-8 会按 ANSI 代码页解码，
      内容当场就毁了，而且不报错。要读一律 [IO.File]::ReadAllText(..., UTF8)。
    - 不用 `2>&1` 捕获 native 命令输出 —— 会被包成 NativeCommandError 误判为终止性错误。
      判成败一律看 $LASTEXITCODE。
    - **本脚本从不把任何密钥值读进 PowerShell 变量、更不打印。** 自证用的是一次性探针值，
      与你的真实凭据无关。

    先跑 -DryRun。
#>
[CmdletBinding()]
param(
    [string]$SecretsDir = "$env:USERPROFILE\.dao-secrets",
    [ValidateSet('Portable', 'Separate')]
    [string]$KeyLocation = 'Portable',
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
# 断继承 + 只留当前用户。icacls 失败不致命（NTFS 之外的盘可能不支持），但要说出来。
& icacls $SecretsDir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { Note "icacls 退出码 $LASTEXITCODE —— 权限没收紧，文件夹仍可能被其他账户读到" }
else { Ok "权限已收成「只有 $env:USERNAME」：$SecretsDir" }

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

    & sops encrypt --input-type dotenv --output-type dotenv --output $probeEnc $probePlain
    if ($LASTEXITCODE -ne 0) { Fail "sops encrypt 退出码 $LASTEXITCODE" }
    if (-not (Test-Path $probeEnc)) { Fail '加密文件没落盘' }

    # 密文里绝不该出现明文探针值。这一条同时验了「加密真的发生了」——
    # 只验「命令退出码 0」是不够的：一个把内容原样抄过去的实现也会 exit 0。
    $encText = [IO.File]::ReadAllText($probeEnc, [Text.Encoding]::UTF8)
    if ($encText.Contains($probeVal)) { Fail '密文里能看到明文探针值 —— 加密没真的发生，停' }
    Ok '加密：密文里搜不到明文探针值'

    & sops decrypt --input-type dotenv --output-type dotenv --output $probeOut $probeEnc
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
Write-Host '  凭据根建好了，但**里面还没有你的任何凭据**。搬凭据是下一个脚本：'
Write-Host ''
Write-Host '      powershell -File ccswitch\scripts\dao-secrets-migrate.ps1 -DryRun'
Write-Host ''
Write-Host '  🔴 现在起，这个东西是不可再生的，丢了没有任何补救：' -ForegroundColor Red
Write-Host "      $keyFile"
Write-Host '     丢了 = 所有加密文件永久打不开（没有找回、没有客服、没有备用钥匙）。'
Write-Host '     建议：把它单独复制一份到密码管理器或离线介质里。'
Write-Host ''
Write-Host '  换机器怎么办：'
if ($KeyLocation -eq 'Portable') {
    Write-Host "      整个 $SecretsDir 文件夹拷过去，再在新机上设一次 SOPS_AGE_KEY_FILE。完了。"
} else {
    Write-Host "      要搬**两处**：$SecretsDir 和 $keyFile。只搬一处等于没搬。"
}
