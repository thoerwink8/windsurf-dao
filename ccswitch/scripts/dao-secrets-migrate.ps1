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
                  那才是这个项目设计的正路）。
                  🔴 **注入器两条路对它都不成立**（2026-08-05 甲路对抗查出、2026-08-06 复核）：
                  路 A 不成立是因为 key 没有环境变量入口；路 B 不成立是因为 `exec-file` 的接口
                  是「把一个随机临时目录里的文件**路径**通过 {} 交给你的命令」，而
                  find_env_local()（:857-872）从**当前目录**向上找一个名字固定叫 `.env.local`
                  的文件，**没有任何参数能把路径喂给它**。判据与那条弯路见
                  ccswitch/rules/dao-secrets.md「各消费方的形态」表下面那段。

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
    工艺（照 ccswitch/rules/dao-shell.md）：
    - **本脚本从不打印任何凭据的值、片段、长度或哈希。** 复核时只打印键名和「一致 / 不一致」。
    - 不用 Get-Content 读凭据文件（PS 5.1 读无 BOM UTF-8 按 ANSI 解码会当场毁内容且不报错），
      一律 [IO.File]::ReadAllText(..., UTF8)。
    - 不用 `2>&1`；判成败一律看 $LASTEXITCODE。
    - 加密走 `sops --output <目标>` 而不是 shell 重定向 —— 让 sops 自己写字节，
      密钥值一次都不经过 PowerShell 的字符串管道。
    - 🔴 **每一条 sops 调用都显式钉 `--config <凭据根>\.sops.yaml`（全局位，必须在子命令前面）。**
      sops 找 `.sops.yaml` 是从**当前目录**逐级向上找，跟被加密文件在哪没有关系 ——
      不钉的话，从仓库根或用户主目录跑本脚本，加密必然 `config file not found` 退出 1。
      判据全文见 dao-secrets-init.ps1 的 .NOTES。

    🔴 **动作次序刻意是「加密 → 复核 → 备份 → 删原件」，不是「备份 → 加密」。**
    先备份的版本有一个静默代价：**任何一次失败的迁移都会在磁盘上多留一份明文**
    （2026-08-05 甲路对抗实跑撞出来的连带后果 —— 用户看到的只是一行红字，
    不会意识到 _backup 里刚多了一份口令）。现在的次序保证：**没搬成功 ⇒ 一个字节都没多写。**
    备份仍然做，只是挪到「确定这份加密文件解得开、值也对得上」之后、删原件之前 ——
    它本来就只是**删除动作的回滚材料**，在删之前根本用不上它。

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
# 字典刻意用 **Ordinal** 比较器，不用 `[ordered]@{}`：后者大小写不敏感，
# 同一份文件里 `Key` 与 `KEY` 会被**静默合并成一个**（实测 count=1）。凭据里 base64
# token 大小写敏感是常态，一个宣称在做完整性比对的东西不该在键名上先丢一半。
function Read-DotEnvMap([string]$path) {
    $map = New-Object System.Collections.Specialized.OrderedDictionary -ArgumentList ([System.StringComparer]::Ordinal)
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

# 只出布尔、不出值：源文件里有没有「引号包裹的值」或「首尾空白」。
# 为什么要报：**迁移之后推荐的取值路是 `sops exec-env`，而它把值原样注入环境 ——
# 引号和尾随空格都会跟着进去。** 而搬走之前，消费方读的是自己那个 trim + 去引号的解析器
# （claimer.ts 的 parseEnvInto、本脚本的 Read-DotEnvMap 都是），两边语义不同。
# 也就是说：**本脚本的复核比不出这个差别（源和解密结果都过同一个解析器，两边被同样规整掉），
# 而它在运行时是真的会咬人的** —— 真值若带引号，迁移后登录失败，且失败长得像「密码错了」。
# sops 本身一个字节都不改（甲路实测加解密逐字节相同），差别全在消费方那一侧。
function Get-DotEnvQuirks([string]$path) {
    $text = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
    $quoted = 0; $padded = 0
    foreach ($raw in $text -split "`r?`n") {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $i = $line.IndexOf('=')
        if ($i -le 0) { continue }
        $v = $line.Substring($i + 1)
        if ($v -match '^\s*(".*"|''.*'')\s*$') { $quoted++ }
        elseif ($v -ne $v.Trim()) { $padded++ }
    }
    return [pscustomobject]@{ Quoted = $quoted; Padded = $padded }
}

$items = @(
    [pscustomobject]@{
        Id = 'P1'; Slug = 'mousse-cli'
        Source = 'D:\frank\mousse-cli\.env.local'
        Dest = 'mousse-cli.env'
        After = '恢复 dev 模式的模型能力：app「设置 → 模型服务」里重填 key（进 OS keyring）。注入器两条路对它都不成立（key 无环境变量入口 ⇒ 非 A；取值链不接受路径 ⇒ 非 B），OS keyring 就是正路。'
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
        After = '以后这样跑：sops exec-env "<凭据根>\devin-credit-claimer.env" "npm run claim"（PowerShell 与 cmd 都可，实跑过）'
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
$sopsYaml = Join-Path $SecretsDir '.sops.yaml'
if (-not (Test-Path $sopsYaml)) { Fail "缺 .sops.yaml —— 先跑 dao-secrets-init.ps1" }
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
    $q = Get-DotEnvQuirks $it.Source
    if ($q.Quoted -or $q.Padded) {
        Note "$($it.Id) 里有 $($q.Quoted) 个**引号包起来的值**、$($q.Padded) 个**带首尾空格的值**（只报个数，不报是哪个键、更不报值）"
        Write-Host '        搬完之后走 sops exec-env 时，引号和空格会**原样进到环境变量里** ——'
        Write-Host '        而搬走之前，消费方自己那个解析器会把它们去掉。两边不等价。'
        Write-Host '        ⇒ 建议先把源文件里的引号去掉（值不要用引号包起来），再跑迁移。'
        Write-Host '        本脚本的复核**查不出这个差别**（源和解密结果过的是同一个解析器）。'
    }
    $todo += $it
}
if (-not $todo) { Write-Host ''; Ok '没有要搬的了'; exit 0 }
Write-Host ''
Write-Host "  合计 $($todo.Count) 处"

if ($DryRun) {
    Write-Host ''
    Write-Host '=== DryRun：以下写操作不执行 ===' -ForegroundColor Yellow
    Write-Host '  [将做] sops encrypt 进凭据根'
    Write-Host '  [将做] 独立复核：解密回来，逐键比对（只打印键名与一致与否）'
    Write-Host "  [将做] 复核通过后才明文备份到 $SecretsDir\_backup\<时间戳>\（删原件的回滚材料）"
    Write-Host '         ⇒ 次序是「加密 → 复核 → 备份 → 删」：**搬不成功就一个字节都不多写**，'
    Write-Host '           失败的迁移不会在磁盘上留下多余的明文。'
    if (-not $KeepSource) { Write-Host '  [将做] 备份落盘后**删掉项目里的原件**（加 -KeepSource 可只复制不删）' }
    else { Write-Host '  [跳过] -KeepSource：原件保留（项目里仍有明文，本 issue 的问题没解掉）' }
    Write-Host '  [将做] 打印每一处的恢复命令'
    exit 0
}

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $SecretsDir "_backup\$ts"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
if (-not (Test-Path $backupDir)) { Fail "备份目录没建成：$backupDir" }
Write-Host ''
Write-Host '=== 2. 逐处搬运（加密 → 复核 → 备份 → 删原件）===' -ForegroundColor Cyan
Write-Host "  备份目录（复核通过后才往里写）：$backupDir"
Note '备份里面是**明文**（删原件的回滚材料）。它在凭据根内（已收紧权限），确认一切正常后建议你自己删掉。'

$results = @()
foreach ($it in $todo) {
    Write-Host ''
    Write-Host "=== $($it.Id) · $($it.Slug) ===" -ForegroundColor Cyan
    $dest = Join-Path $SecretsDir $it.Dest
    $bak = Join-Path $backupDir "$($it.Slug).env"

    if (Test-Path $dest) {
        $destBak = "$dest.bak-$ts"
        Copy-Item -LiteralPath $dest -Destination $destBak -Force
        Note "目标已存在，先备份成 $destBak 再覆盖"
    }

    # --config 钉死，且在 encrypt 前面（全局位）。不钉的话「你此刻在哪个目录」会决定成败。
    & sops --config $sopsYaml encrypt --input-type dotenv --output-type dotenv --output $dest $it.Source
    if ($LASTEXITCODE -ne 0) { Fail "sops encrypt 退出码 $LASTEXITCODE（$($it.Id) 未动原件、也没留下多余明文）" }
    if (-not (Test-Path $dest)) { Fail "加密文件没落盘：$dest" }
    Ok "已加密：$dest"

    # --- 独立复核：不信 encrypt 的沉默，解密回来逐键比 ---
    # 比对刻意用**大小写敏感**的 -cne / -cnotcontains：PowerShell 的 -ne / -notcontains 默认
    # 忽略大小写（'AbC' -ne 'abc' 得 False ⇒ 只差大小写会被判成「一致」），而凭据里
    # base64 token 大小写敏感是常态。真 sops 不会改大小写，所以这一格是纵深防御，
    # 不是在修一个已发生的故障 —— 但一个宣称在做完整性比对的东西不该有这个洞。
    $tmpOut = Join-Path $backupDir "$($it.Slug).verify.env"
    try {
        & sops --config $sopsYaml decrypt --input-type dotenv --output-type dotenv --output $tmpOut $dest
        if ($LASTEXITCODE -ne 0) { Fail "sops decrypt 退出码 $LASTEXITCODE —— 加密文件打不开，原件**不删**" }

        $src = Read-DotEnvMap $it.Source
        $got = Read-DotEnvMap $tmpOut
        # sops 的 dotenv 存储会带 sops_* 元数据键，比对时排掉
        $gotKeys = @($got.Keys | Where-Object { $_ -notlike 'sops_*' })
        $srcKeys = @($src.Keys)

        $missing = @($srcKeys | Where-Object { $gotKeys -cnotcontains $_ })
        $mismatch = @($srcKeys | Where-Object { $gotKeys -ccontains $_ -and $got[$_] -cne $src[$_] })

        if ($missing.Count) { Fail "解密回来少了这些键：$($missing -join ', ') —— 原件**不删**" }
        if ($mismatch.Count) { Fail "这些键的值对不上：$($mismatch -join ', ') —— 原件**不删**" }
        if ($srcKeys.Count -eq 0) { Fail '源文件一个键都没解析出来 —— 判为异常，原件**不删**' }
        Ok "复核通过：$($srcKeys.Count) 个键全部原样回来（键名：$($srcKeys -join ', ')）"
    } finally {
        if (Test-Path $tmpOut) { Remove-Item $tmpOut -Force -ErrorAction SilentlyContinue }
    }

    # 备份排在复核**之后**：它是删原件的回滚材料，删之前用不上它。
    # 排在前面的代价是静默的 —— 任何一次失败的迁移都会在磁盘上多留一份明文口令。
    Copy-Item -LiteralPath $it.Source -Destination $bak -Force
    if (-not (Test-Path $bak)) { Fail "备份没落盘：$bak —— 原件**不删**" }
    Ok "已备份（回滚材料，明文）：$bak"

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
    # <凭据根> 换成真路径 —— 印出来的命令要能直接复制粘贴，不能让用户自己去替换占位符。
    # 用 .Replace() 不用 -replace：后者是正则，替换串里的 $ 会被当成引用。
    Write-Host "    往后：$($r.After.Replace('<凭据根>', $SecretsDir))"
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
