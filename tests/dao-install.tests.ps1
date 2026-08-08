# @dao-test-tier: env   # 沙盒本身已随机化（2026-08-08 · 对抗官 FAIL-3，照 issue #187 模板），
                        # 不再因「并行必互踩」而标 env；仍标 env 的理由换了：`install.ps1` 第 1/2 步
                        # 在 node/claude 缺失时会真的 `winget install`/`npm install -g` ——
                        # 这是「跑了会真的改这台机器」而不是「沙盒会互踩」，随机化治不了这一格
                        # （对抗官复核 ④，本仓两者已开的机器上是 no-op，换台机器/CI 会动真格）。
<#
.SYNOPSIS
    `scripts/dao-install.ps1` 第 6 步（hooks 注册）+ `scripts/dao-pack.ps1` 新增的
    hooks-template 派生逻辑的行为级回归网（issue #65）。退出码 0 = 全部通过。

.DESCRIPTION
    issue #65 的病：`dao-install.ps1` 第 6 步此前手工维护一份 hooks 注册 JSON 字面量，
    与 `ccswitch/hooks/` 目录各自独立、无人对账 —— 数到落后 5 个才被发现（本单考古复测：
    已落后到 9 个）。修法不是把清单补全，而是让 `dao-install.ps1` 不再持有第二份清单：
    `dao-pack.ps1` 从本仓唯一真相源（`config-sync/common/settings.json` 的
    `common_config_claude.hooks`）派生出 `dao/hooks-template.json` 打进安装包，
    `dao-install.ps1` 只做「读模板 → 替换安装目标路径」。

    本文件验证的是**整条链真的接得上**，不是各自独立的单元：
      场景 1：`dao-pack.ps1` 真打一个包，解压后 `hooks-template.json` 存在、
              含 issue 原文点名的 5 个 hook（外加两个原有的作对照），
              且 `${PROJECT_ROOT}` 占位符已被替换、无残留。
      场景 2：`install.ps1` 用这份包真装到一个隔离目录，最终 `settings.json` 的
              `hooks` 字段里那 5 个 hook 的命令都指向**这次安装的真实目标路径**
              （不是 `__HOOKS_DIR__`、也不是 dao 仓自己的 `${PROJECT_ROOT}`）。
      场景 3：模板缺失时的降级路径——`install.ps1` 必须**报警告、不崩、不静默**，
              且不把一份旧清单悄悄垫上去（那正是本单要治的病本身）。

.NOTES
    独立可运行：powershell -NoProfile -ExecutionPolicy Bypass -File tests/dao-install.tests.ps1
    退出码：0 = 全部通过；1 = 存在失败。
    夹具落 `%TEMP%/windsurf-dao-dao-install-test-<Get-Random>/`（随机化，2026-08-08 · 对抗官
    FAIL-3 照 `tests/dao-pr-merge.tests.ps1`/issue #187 模板改），收尾在 `finally` 里删掉，
    不再落仓内固定 `_tmp/` 路径——原写法「开跑即 `Remove-Item -Recurse -Force`」与
    `dao-pr-merge.tests.ps1` 改之前是同一个反模式：两个实例并行时后者会把前者的夹具整棵删掉。
    PS 5.1 兼容：无三元运算符、无 && 链、禁 2>&1。本文件须以 BOM UTF-8 存盘。
    真跑 `dao-pack.ps1`（产出真实 zip，~500KB）+ 真跑 `install.ps1`（真复制 skills/
    commands/agents/hooks 文件到隔离目录）——仍标 env 层，但理由已从「沙盒会互踩」换成
    「`install.ps1` 第 1/2 步在 node/claude 缺失时会真的改这台机器」（见文件头注）。
#>

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\ccswitch\lib\console-utf8.ps1')  # 子进程 stdout 解码钉 UTF-8（issue #131 同型坑）

$repoRoot   = Split-Path -Parent $PSScriptRoot
$packPs1    = Join-Path $repoRoot 'scripts\dao-pack.ps1'
$installPs1 = Join-Path $repoRoot 'scripts\dao-install.ps1'
$psExe      = (Get-Command powershell.exe).Source
$workRoot   = Join-Path ([System.IO.Path]::GetTempPath()) "windsurf-dao-dao-install-test-$(Get-Random)"
$utf8NoBom  = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $packPs1))    { Write-Host "被测脚本不存在：$packPs1"; exit 1 }
if (-not (Test-Path $installPs1)) { Write-Host "被测脚本不存在：$installPs1"; exit 1 }

# 沙盒随机化之后**开跑不再先删**（2026-08-08 · 对抗官 FAIL-3，照 issue #187 模板）：原先那句
# `if (Test-Path $workRoot) { Remove-Item -Recurse -Force }` 本意是「清上次的残渣」，
# 而它同时就是并行互踩的凶器——后开跑的实例把先开跑那个的整棵沙盒删掉。随机路径每次
# 唯一 ⇒ 没有残渣可清；收尾清理挪到本文件末尾的 `finally`（`exit` 在 `try` 里照样会跑
# `finally` 且退出码原样保留，PS 5.1 本机实测过）。
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

try {

$results = New-Object System.Collections.Generic.List[object]
function Assert-True {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    $status = 'FAIL'
    if ($Condition) { $status = 'PASS' }
    $script:results.Add([PSCustomObject]@{ Name = $Name; Status = $status; Detail = $Detail })
    Write-Host ("  [{0}] {1} {2}" -f $status, $Name, $Detail)
}

# issue #65 原文点名的 5 个「落后」hook，外加两个原有的（对照：改动前就注册过的不能被
# 这次改动弄丢）。这 5 个名字直接抄自 issue 正文，不是本测试自己起的名。
$issueNamedHooks = @('dao-hard-gates.js', 'dao-rule-echo.js', 'dao-config-guard.js', 'dao-codegraph-ensure.js', 'dao-compact-log.js')
$preexistingHooks = @('dao-tool-nudge.js', 'dao-glob-gate.js')

Write-Host ''
Write-Host '== dao-install 回归测试（issue #65）=='
Write-Host ''

# ============================================================================
# 场景 1：dao-pack.ps1 真打包，hooks-template.json 派生正确
# ============================================================================
Write-Host '场景 1：dao-pack.ps1 真打包 —— hooks-template.json 含 issue 点名的 5 个 hook'

$packOut = Join-Path $workRoot 'pack-out'
New-Item -ItemType Directory -Force -Path $packOut | Out-Null
$packArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $packPs1, '-OutputRoot', $packOut)
$packText = & $psExe @packArgs
$packCode = $LASTEXITCODE

Assert-True '1a dao-pack.ps1 真跑退出码 0' ($packCode -eq 0) ("exit={0}" -f $packCode)

$zipCandidates = @(Get-ChildItem -Path $packOut -Filter '*.zip' -File -ErrorAction SilentlyContinue)
Assert-True '1b 产出了一个 zip' ($zipCandidates.Count -eq 1) ("count={0}" -f $zipCandidates.Count)

$extractDir = Join-Path $workRoot 'pack-extracted'
if ($zipCandidates.Count -ge 1) {
    Expand-Archive -Path $zipCandidates[0].FullName -DestinationPath $extractDir -Force
}

$templatePath = Join-Path $extractDir '_setup\dao\hooks-template.json'
Assert-True '1c 包里含 dao/hooks-template.json' (Test-Path $templatePath) ''

$templateRaw = ''
if (Test-Path $templatePath) {
    $templateRaw = [System.IO.File]::ReadAllText($templatePath, [System.Text.Encoding]::UTF8)
}

Assert-True '1d 模板是合法 JSON（不只是文本存在）' `
    ($(try { $null = $templateRaw | ConvertFrom-Json; $true } catch { $false })) ''

foreach ($h in $issueNamedHooks) {
    Assert-True ("1e-{0} 模板含 issue 点名的 {0}" -f $h) ($templateRaw.IndexOf($h) -ge 0) ''
}
foreach ($h in $preexistingHooks) {
    Assert-True ("1f-{0} 模板仍含改动前就有的 {0}（没被顺手弄丢）" -f $h) ($templateRaw.IndexOf($h) -ge 0) ''
}

Assert-True '1g 占位符 __HOOKS_DIR__ 存在（等着 install.ps1 替换）' `
    ($templateRaw.IndexOf('__HOOKS_DIR__') -ge 0) ''
Assert-True '1h dao 仓自己的 ${PROJECT_ROOT} 已被替换、无残留（残留会让下一步替换后仍指错路径）' `
    ($templateRaw.IndexOf('PROJECT_ROOT') -lt 0) ''

# ============================================================================
# 场景 2：install.ps1 用这份包真装到隔离目录，settings.json 的 hooks 指向真实路径
# ============================================================================
Write-Host ''
Write-Host '场景 2：install.ps1 真装 —— settings.json 的 hooks 命令指向本次安装目标'

$installTarget = Join-Path $workRoot 'install-target'
New-Item -ItemType Directory -Force -Path $installTarget | Out-Null
$packagedInstallPs1 = Join-Path $extractDir '_setup\install.ps1'

$installCode = -1
$installText = ''
if (Test-Path $packagedInstallPs1) {
    $installArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $packagedInstallPs1, '-TargetDir', $installTarget)
    $installText = (& $psExe @installArgs) -join "`n"
    $installCode = $LASTEXITCODE
}

Assert-True '2a install.ps1 真跑退出码 0' ($installCode -eq 0) ("exit={0}" -f $installCode)
Assert-True '2b 屏幕上报了「hooks 已注册」（不是被跳过）' `
    ($installText -match 'hooks 已注册到 settings\.json') ''

$settingsPath = Join-Path $installTarget 'settings.json'
Assert-True '2c settings.json 已生成' (Test-Path $settingsPath) ''

if (Test-Path $settingsPath) {
    $settingsRaw = [System.IO.File]::ReadAllText($settingsPath, [System.Text.Encoding]::UTF8)
    $settingsObj = $settingsRaw | ConvertFrom-Json

    Assert-True '2d settings.json 含 hooks 字段' ($null -ne $settingsObj.hooks) ''
    Assert-True '2e 无 __HOOKS_DIR__ 残留（占位符必须被替换掉，不是原样落盘）' `
        ($settingsRaw.IndexOf('__HOOKS_DIR__') -lt 0) ''
    Assert-True '2f 无 PROJECT_ROOT 残留（不能把 dao 仓自己那份路径抄给别的机器）' `
        ($settingsRaw.IndexOf('PROJECT_ROOT') -lt 0) ''

    $expectedHooksFrag = ($installTarget.Replace('\', '/') + '/hooks/')
    foreach ($h in ($issueNamedHooks + $preexistingHooks)) {
        $needle = $expectedHooksFrag + $h
        Assert-True ("2g-{0} settings.json 里 {0} 的命令指向本次安装的真实路径" -f $h) `
            ($settingsRaw.IndexOf($needle) -ge 0) ("期望片段：{0}" -f $needle)
    }

    # 事件类型也要对得上——不是随便塞一份东西进去就算数
    $eventNames = @($settingsObj.hooks.PSObject.Properties.Name)
    foreach ($ev in @('PreToolUse', 'PostToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit', 'SubagentStart', 'StopFailure', 'PostCompact')) {
        Assert-True ("2h-{0} settings.json 的 hooks 含事件类型 {0}" -f $ev) ($eventNames -contains $ev) ''
    }
}

# ============================================================================
# 场景 3：模板缺失时的降级路径——报警告、不崩、不静默垫一份旧清单
# ============================================================================
Write-Host ''
Write-Host '场景 3：hooks-template.json 缺失 ⇒ install.ps1 报警告，不崩、不静默注册'

$bareDaoSrc = Join-Path $workRoot 'bare\dao'
New-Item -ItemType Directory -Force -Path $bareDaoSrc | Out-Null
[System.IO.File]::WriteAllText((Join-Path $bareDaoSrc 'dao.md'), "seed dao.md`n", $utf8NoBom)
# 有意不写 hooks-template.json —— 模拟旧版打包产物 / install.ps1 被单独拷出来跑的场景

$bareTarget = Join-Path $workRoot 'bare-target'
New-Item -ItemType Directory -Force -Path $bareTarget | Out-Null

# `dao-install.ps1` 用 `$PSScriptRoot` 定位同目录下的 `dao/`，所以被测脚本本体也要拷进
# 与 `bareDaoSrc` 同级的位置，不能直接跑仓库里那份（那份旁边的 dao/ 是真的、会掩盖本场景）。
$bareInstallPs1 = Join-Path $workRoot 'bare\install.ps1'
Copy-Item $installPs1 $bareInstallPs1 -Force

$bareArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $bareInstallPs1, '-TargetDir', $bareTarget)
$bareText = (& $psExe @bareArgs) -join "`n"
$bareCode = $LASTEXITCODE

Assert-True '3a 模板缺失时仍然干净退出（不因为少一个文件就崩溃）' ($bareCode -eq 0) ("exit={0}" -f $bareCode)
Assert-True '3b 明确报「hooks-template.json 不存在」（不是含糊的失败信息）' `
    ($bareText -match 'hooks-template\.json 不存在') ''
Assert-True '3c 没有谎称「hooks 已注册」' (-not ($bareText -match 'hooks 已注册到 settings\.json')) ''

$bareSettingsPath = Join-Path $bareTarget 'settings.json'
if (Test-Path $bareSettingsPath) {
    $bareSettingsRaw = [System.IO.File]::ReadAllText($bareSettingsPath, [System.Text.Encoding]::UTF8)
    $bareSettingsObj = $bareSettingsRaw | ConvertFrom-Json
    Assert-True '3d 模板缺失时 settings.json 没有被塞进任何 hooks 字段（宁可没有，不要旧清单）' `
        ($null -eq $bareSettingsObj.hooks) ''
} else {
    Assert-True '3d settings.json 干脆没生成（CLAUDE.md 步骤之外没有别的写入，同样满足"不静默垫旧清单"）' $true ''
}

# ============================================================================
# 场景 4：两个被测脚本零语法错误
# ============================================================================
Write-Host ''
Write-Host '场景 4：被测脚本零语法错误'

foreach ($target in @($packPs1, $installPs1)) {
    $tokens = $null
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($target, [ref]$tokens, [ref]$errors)
    Assert-True ("4-{0} 能被 PowerShell 解析器解析（零语法错误）" -f (Split-Path $target -Leaf)) `
        (@($errors).Count -eq 0) ("ParseErrors={0}" -f @($errors).Count)
}

# ---- 汇总 -------------------------------------------------------------------
Write-Host ''
Write-Host '=============================================='
Write-Host '          dao-install 汇总'
Write-Host '=============================================='
$failing = @($results | Where-Object { $_.Status -ne 'PASS' })
foreach ($r in $results) { Write-Host ("  {0,-6} {1}" -f $r.Status, $r.Name) }
Write-Host '=============================================='
Write-Host ("=== 汇总: PASS={0} FAIL={1} ===" -f ($results.Count - $failing.Count), $failing.Count)
if ($failing.Count -gt 0) {
    Write-Host ("dao-install 失败：{0}/{1} 项未通过" -f $failing.Count, $results.Count)
    exit 1
}
Write-Host ("dao-install 全部通过（{0} 项）。" -f $results.Count)
exit 0

} finally {
    # 随机沙盒的收尾（2026-08-08 · 对抗官 FAIL-3，照 issue #187 模板）。
    # `-ErrorAction SilentlyContinue`：清理失败不该把一次通过的回归网翻成红——
    # 清不掉最坏结果是 %TEMP% 里多一个目录（含一份解压出来的安装包），而把绿改成红
    # 会训练人无视这道闸。
    Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}
