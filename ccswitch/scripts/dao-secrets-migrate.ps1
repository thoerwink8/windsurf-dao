#requires -Version 5.1
<#
.SYNOPSIS
    把项目工作树里的 4 处明文凭据搬进凭据根（加密），并删掉项目里的原件。
    issue #135 第二步的后半。**这个脚本由用户跑，不由 AI 跑。**

.DESCRIPTION
    先跑 dao-secrets-init.ps1 建好凭据根，再跑这个。

    搬哪四处（2026-08-05 逐处查证到行，不是猜的）：

      P1  mousse-cli\.env.local
          谁读它：crates/mousse-core/src/prompt_store/decompose.rs:877 read_env_local()，
                  向上最多找 8 层（:860）。**挂 #[cfg(debug_assertions)]，release 根本不编译。**
          主存储在哪：OS keyring（resolve_llm_key_optional 先查 vault，查不到才回落这个文件）。
          删了会怎样：**dev 模式下「模型服务」那条回落链没了。** 测试不受影响 ——
                  decompose.rs:1191 与 :1365 两个用例是写成**有/无都能过**的双态断言（已核）。
                  要恢复能力：在 app 的「设置 → 模型服务」里重填 key（进 OS keyring，
                  那才是这个项目设计的正路），或走注入器路 B。

      P2  resume-project\server\.env
          谁读它：🔴 **没有任何东西读它。** config.go:34 Load() 全程只调 os.LookupEnv(:57)；
                  server/go.mod 里没有 godotenv（实测全仓零命中）；Makefile:13 的 dev 就是
                  `go run ./cmd/api`，不注入任何东西。
                  ⇒ 文档（DEV_GUIDE.md:61 / DEPLOY.md:282 / ARCHITECTURE.md:336）叫人往这里
                  写值，而程序**从来没拿到过**。
          删了会怎样：什么都不会发生 —— 这是四处里唯一零风险的。
          🔴 **另一件更该管的事，已单独挂账**（见交付报告与 issue）：config.go:39-40 里
                  JWT_SECRET 与 ADMIN_PASSWORD **有静默的弱默认值**。`.env` 读不读得到，
                  那两个默认值都在那儿 —— 那是个真缺陷，跟搬不搬凭据是两件事。

      P3  devin-credit-claimer\.env.local   🔴 **四处里最该先搬的**
          装的是什么：一个真人 GitHub 账号的**登录口令**（键名 GITHUB_USER / GITHUB_PASSWORD）。
                  不是 token —— 不能限权、不能按仓库收窄，泄露即整个账号。
          谁读它：src/claimer.ts:66 loadEnvLocal()，消费点 :250-251（登录）与 :266-268（TOTP）。
          🔴 **那个目录压根不是 git 仓库**（实测 `git rev-parse` 报 not a git repository）
                  ⇒ 不受任何 .gitignore 保护，**整个目录复制一次就是明文口令复制一次**。
          代码已改：claimer.ts 现在默认从凭据根读，读不到才回落项目内老路径并**当场告警**。
                  改动是向后兼容的 —— 你还没跑本脚本之前，它照旧能用。

      P4  devin-byok\_tmp\windsurf-proxy-反代项目 自行扩展\.env
          🔴 **侦察报告说「未查到消费方」，这一条已订正：消费方就在同一个目录里。**
                  start-proxy.bat:7-8 用的是 `node --env-file=.env src/hybrid-server.js`
                  （Node 原生 --env-file），读的正是这个文件；handlers/completions.js:37 等处
                  消费 process.env。该目录 package.json **零依赖**，所以「没有 node_modules」
                  不代表它跑不起来。
          在不在用（证据，不是断言）：端口 3000/3001 当前**无监听**；整个目录最后改动停在
                  5 月 30 - 6 月 2；产品化的那个双胞胎 D:\frank\windsurf-proxy 读的是
                  %APPDATA%\smallyu-proxy\config.json（另一条路）。⇒ 看起来是睡着的副本。
          删了会怎样：下次谁跑 start-proxy.bat，`node --env-file` 会因文件不存在**当场报错退出**
                  —— 这是好事（响的失败好过静默跑错），恢复就是下面打印的那一行。

.NOTES
    工艺（照 ccswitch/rules/dao-powershell.md）：
    - **本脚本从不打印任何凭据的值、片段、长度或哈希。** 复核时只打印键名和「一致 / 不一致」。
    - 不用 Get-Content 读凭据文件（PS 5.1 读无 BOM UTF-8 按 ANSI 解码会当场毁内容且不报错），
      一律 [IO.File]::ReadAllText(..., UTF8)。
    - 不用 `2>&1`；判成败一律看 $LASTEXITCODE。
    - 加密走 `sops --output <目标>` 而不是 shell 重定向 —— 让 sops 自己写字节，
      密钥值一次都不经过 PowerShell 的字符串管道。

    先跑 -DryRun。
#>
[CmdletBinding()]
param(
    [string]$SecretsDir = "$env:USERPROFILE\.dao-secrets",
    [ValidateSet('All', 'P1', 'P2', 'P3', 'P4')]
    [string[]]$Item = @('All'),
    [string]$ItemsJson,
    [switch]$KeepSource,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Fail($m) { Write-Host "  [失败] $m" -ForegroundColor Red; exit 1 }
function Ok($m) { Write-Host "  [完成] $m" -ForegroundColor Green }
function Note($m) { Write-Host "  [注意] $m" -ForegroundColor Yellow }

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 只读 dotenv 成 键->值 字典。**调用方只准用键名和比对结果，不准打印值。**
function Read-DotEnvMap([string]$path) {
    $map = [ordered]@{}
    $text = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
    foreach ($raw in $text -split "`r?`n") {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $i = $line.IndexOf('=')
        if ($i -le 0) { continue }
        $k = $line.Substring(0, $i).Trim()
        $v = $line.Substring($i + 1).Trim() -replace '^["'']|["'']$', ''
        $map[$k] = $v
    }
    return $map
}

$items = @(
    [pscustomobject]@{
        Id = 'P1'; Slug = 'mousse-cli'
        Source = 'D:\frank\mousse-cli\.env.local'
        Dest = 'mousse-cli.env'
        After = '恢复 dev 模式的模型能力：app「设置 → 模型服务」里重填 key（进 OS keyring，正路），或走注入器路 B。'
    }
    [pscustomobject]@{
        Id = 'P2'; Slug = 'resume-project-server'
        Source = 'D:\frank\resume-project\server\.env'
        Dest = 'resume-project-server.env'
        After = '没有任何东西读它，删了不影响任何行为。（真正该管的是 config.go:39-40 的弱默认值，另挂账。）'
    }
    [pscustomobject]@{
        Id = 'P3'; Slug = 'devin-credit-claimer'
        Source = 'D:\frank\devin-credit-claimer\.env.local'
        Dest = 'devin-credit-claimer.env'
        After = '以后这样跑：sops exec-env "<凭据根>\devin-credit-claimer.env" "npm run claim"'
    }
    [pscustomobject]@{
        Id = 'P4'; Slug = 'devin-byok-windsurf-proxy'
        Source = 'D:\frank\devin-byok\_tmp\windsurf-proxy-反代项目 自行扩展\.env'
        Dest = 'devin-byok-windsurf-proxy.env'
        After = '要再跑起来：sops exec-env "<凭据根>\devin-byok-windsurf-proxy.env" "node src\hybrid-server.js"（在那个目录里跑）。'
    }
)

# -ItemsJson 只为**自测**存在：让回归测试拿临时 fixture 跑完整条链路，而不必碰真凭据。
# 不传时用上面那张查证过的真表。
if ($ItemsJson) {
    if (-not (Test-Path $ItemsJson)) { Fail "-ItemsJson 指的文件不存在：$ItemsJson" }
    $items = [IO.File]::ReadAllText($ItemsJson, [Text.Encoding]::UTF8) | ConvertFrom-Json
    Note "-ItemsJson：用的是自测清单（$ItemsJson），不是内置真表"
}

if ($Item -notcontains 'All') { $items = $items | Where-Object { $Item -contains $_.Id } }
if (-not $items) { Fail '没选中任何一处' }

Write-Host '=== 0. 前置检查 ===' -ForegroundColor Cyan
if (-not (Get-Command sops -ErrorAction SilentlyContinue)) { Fail '找不到 sops —— 先跑 dao-secrets-init.ps1' }
if (-not (Test-Path $SecretsDir)) { Fail "凭据根不存在：$SecretsDir —— 先跑 dao-secrets-init.ps1" }
if (-not (Test-Path (Join-Path $SecretsDir '.sops.yaml'))) { Fail "缺 .sops.yaml —— 先跑 dao-secrets-init.ps1" }
Ok "凭据根：$SecretsDir"

Write-Host ''
Write-Host '=== 1. 现状（只读，只列键名不列值）===' -ForegroundColor Cyan
$todo = @()
foreach ($it in $items) {
    if (-not (Test-Path $it.Source)) {
        Note "$($it.Id) 源文件不在（可能已搬过）：$($it.Source)"
        continue
    }
    $keys = (Read-DotEnvMap $it.Source).Keys -join ', '
    Write-Host "  $($it.Id)  $($it.Source)"
    Write-Host "        键名：$keys"
    Write-Host "        搬去：$(Join-Path $SecretsDir $it.Dest)"
    $todo += $it
}
if (-not $todo) { Write-Host ''; Ok '没有要搬的了'; exit 0 }
Write-Host ''
Write-Host "  合计 $($todo.Count) 处"

if ($DryRun) {
    Write-Host ''
    Write-Host '=== DryRun：以下写操作不执行 ===' -ForegroundColor Yellow
    Write-Host "  [将做] 明文备份到 $SecretsDir\_backup\<时间戳>\（回滚材料）"
    Write-Host '  [将做] sops encrypt 进凭据根'
    Write-Host '  [将做] 独立复核：解密回来，逐键比对（只打印键名与一致与否）'
    if (-not $KeepSource) { Write-Host '  [将做] 复核通过后**删掉项目里的原件**（加 -KeepSource 可只复制不删）' }
    else { Write-Host '  [跳过] -KeepSource：原件保留（项目里仍有明文，本 issue 的问题没解掉）' }
    Write-Host '  [将做] 打印每一处的恢复命令'
    exit 0
}

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $SecretsDir "_backup\$ts"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
if (-not (Test-Path $backupDir)) { Fail "备份目录没建成：$backupDir" }
Write-Host ''
Write-Host '=== 2. 备份（明文，不可跳过）===' -ForegroundColor Cyan
Ok "备份目录：$backupDir"
Note '这里面是**明文**。它在凭据根内（已收紧权限），但确认一切正常后建议你自己删掉它。'

$results = @()
foreach ($it in $todo) {
    Write-Host ''
    Write-Host "=== $($it.Id) · $($it.Slug) ===" -ForegroundColor Cyan
    $dest = Join-Path $SecretsDir $it.Dest
    $bak = Join-Path $backupDir "$($it.Slug).env"

    Copy-Item -LiteralPath $it.Source -Destination $bak -Force
    if (-not (Test-Path $bak)) { Fail "备份没落盘：$bak" }
    Ok "已备份：$bak"

    if (Test-Path $dest) {
        $destBak = "$dest.bak-$ts"
        Copy-Item -LiteralPath $dest -Destination $destBak -Force
        Note "目标已存在，先备份成 $destBak 再覆盖"
    }

    & sops encrypt --input-type dotenv --output-type dotenv --output $dest $it.Source
    if ($LASTEXITCODE -ne 0) { Fail "sops encrypt 退出码 $LASTEXITCODE（$($it.Id) 未动原件）" }
    if (-not (Test-Path $dest)) { Fail "加密文件没落盘：$dest" }
    Ok "已加密：$dest"

    # --- 独立复核：不信 encrypt 的沉默，解密回来逐键比 ---
    $tmpOut = Join-Path $backupDir "$($it.Slug).verify.env"
    try {
        & sops decrypt --input-type dotenv --output-type dotenv --output $tmpOut $dest
        if ($LASTEXITCODE -ne 0) { Fail "sops decrypt 退出码 $LASTEXITCODE —— 加密文件打不开，原件**不删**" }

        $src = Read-DotEnvMap $it.Source
        $got = Read-DotEnvMap $tmpOut
        # sops 的 dotenv 存储会带 sops_* 元数据键，比对时排掉
        $gotKeys = @($got.Keys | Where-Object { $_ -notlike 'sops_*' })
        $srcKeys = @($src.Keys)

        $missing = @($srcKeys | Where-Object { $gotKeys -notcontains $_ })
        $mismatch = @($srcKeys | Where-Object { $gotKeys -contains $_ -and $got[$_] -ne $src[$_] })

        if ($missing.Count) { Fail "解密回来少了这些键：$($missing -join ', ') —— 原件**不删**" }
        if ($mismatch.Count) { Fail "这些键的值对不上：$($mismatch -join ', ') —— 原件**不删**" }
        if ($srcKeys.Count -eq 0) { Fail '源文件一个键都没解析出来 —— 判为异常，原件**不删**' }
        Ok "复核通过：$($srcKeys.Count) 个键全部原样回来（键名：$($srcKeys -join ', ')）"
    } finally {
        if (Test-Path $tmpOut) { Remove-Item $tmpOut -Force -ErrorAction SilentlyContinue }
    }

    if ($KeepSource) {
        Note "-KeepSource：原件保留在 $($it.Source) —— 项目里仍有明文"
    } else {
        Remove-Item -LiteralPath $it.Source -Force
        if (Test-Path $it.Source) { Fail "原件没删掉：$($it.Source)" }
        Ok "已删除项目内原件：$($it.Source)"
    }

    $results += [pscustomobject]@{ Id = $it.Id; Source = $it.Source; Backup = $bak; Dest = $dest; After = $it.After }
}

Write-Host ''
Write-Host '=== 3. 恢复命令（每一处都能单独退回去）===' -ForegroundColor Cyan
foreach ($r in $results) {
    Write-Host ''
    Write-Host "  $($r.Id)：" -ForegroundColor Yellow
    Write-Host "    Copy-Item -LiteralPath '$($r.Backup)' -Destination '$($r.Source)' -Force"
    Write-Host "    Remove-Item -LiteralPath '$($r.Dest)' -Force   # 不想留加密副本时才跑这行"
    Write-Host "    往后：$($r.After)"
}

Write-Host ''
Write-Host '=== 4. 收尾（要你自己判断的两件）===' -ForegroundColor Cyan
Write-Host "  ① 确认各项目照常能用之后，删掉明文备份：Remove-Item -Recurse -Force '$backupDir'"
Write-Host '  ② 🔴 devin-credit-claimer 那个目录里**还有别的凭据没搬**，本脚本没碰：'
Write-Host '       data\trial-accounts.json（成批账号，含 password 字段）'
Write-Host '       data\cloud-accounts-export.txt / cloud-trial-accounts.txt'
Write-Host '       .auth\browser-profile\（浏览器登录态）'
Write-Host '     ⇒ **只搬 .env.local 并不能让那个目录变安全。** 它们形态不同（不是 key=value），'
Write-Host '       搬法要另外设计；已单独挂账，别当成本批已经解决了。'
