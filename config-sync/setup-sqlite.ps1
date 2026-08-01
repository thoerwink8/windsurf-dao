# setup-sqlite.ps1 — 为 config-sync 准备 sqlite3 命令行工具
#
# 用法：
#   .\setup-sqlite.ps1                 # 检查 / 下载 / 解压，设置用户级 SQLITE3_PATH
#   $env:SQLITE3_PATH = (.\setup-sqlite.ps1 -ReturnPath)
#   .\setup-sqlite.ps1 -EnsureZipOnly  # 只确保 vendor/ 下有一个校验过的 zip；不解压、不写环境变量
#                                      # （给 lib/sqlite.mjs 调用，见下面「唯一真相源」一段）
#
# 逻辑：
# 1. 优先使用现有 sqlite3（环境变量 SQLITE3_PATH / PATH / vendor/sqlite 下已解压的）。
# 2. 否则按 vendor/sqlite-tools.json 从 sqlite.org 下载官方 zip 到 vendor/，
#    **SHA256 不匹配即删除下载文件并报错拒用**（fail-closed，供应链防线），
#    校验通过再解压到 vendor/sqlite/。
# 3. 返回 sqlite3.exe 绝对路径。
#
# ── 唯一真相源 ────────────────────────────────────────────────────────────────
# URL / 文件名 / SHA256 都在 `vendor/sqlite-tools.json`，本脚本一个都不硬编码；
# `lib/sqlite.mjs` 读同一份清单，并且**通过 `-EnsureZipOnly` 复用本脚本的下载+校验实现**
# ——两边各写一套下载逻辑必然漂移，故只留这一套。换 sqlite 版本只改那个 JSON。
#
# ── zip 为什么不在 git 里 ──────────────────────────────────────────────────────
# 6.4 MB 的二进制曾直接进仓库，代价是每次 clone 都背着它。改为首次用时下载 + 哈希校验，
# 代价是**新机器首次跑需要联网**（已知并接受）。离线机器的两条路：
#   a) 把同名 zip 手工放进 vendor/（哈希一致即直接用，不会联网）；
#   b) 装好 sqlite3 后设 SQLITE3_PATH 指过去（第 1 步就命中，压根不走下载）。
#
# ⚠ 本文件必须存成 UTF-8 **带 BOM**：PS 5.1 对无 BOM 脚本按系统 ANSI 代码页解析，
#   下面那些中文提示（含哈希校验失败的拒绝理由）会整段变成乱码。

param(
    [switch]$ReturnPath,
    [switch]$EnsureZipOnly
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$vendorDir = Join-Path $here 'vendor'
$extractDir = Join-Path $vendorDir 'sqlite'
$manifestPath = Join-Path $vendorDir 'sqlite-tools.json'

function Get-SqliteManifest {
    if (-not (Test-Path $manifestPath)) {
        throw "找不到下载清单 $manifestPath。它记录 sqlite-tools 的 url / 文件名 / sha256，必须随仓库一起存在。"
    }
    # 不用 Get-Content：PS 5.1 对无 BOM 文件按系统 ANSI 代码页解码，清单里的中文注释会被读坏。
    $raw = [IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
    $manifest = $raw | ConvertFrom-Json
    foreach ($field in @('file', 'url', 'sha256')) {
        if (-not $manifest.$field) {
            throw "下载清单缺字段 '$field'：$manifestPath"
        }
    }
    return $manifest
}

function Get-Sha256Upper {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Resolve-VendorZip {
    # 返回一个「SHA256 已校验通过」的本地 zip 路径；本地没有或对不上就（重新）下载。
    $manifest = Get-SqliteManifest
    $expected = $manifest.sha256.ToUpperInvariant()
    $zipPath = Join-Path $vendorDir $manifest.file

    if (Test-Path $zipPath) {
        $cached = Get-Sha256Upper -Path $zipPath
        if ($cached -eq $expected) {
            Write-Host "vendor 已有校验通过的安装包：$($manifest.file)" -ForegroundColor DarkGray
            return $zipPath
        }
        Write-Host "vendor 缓存 $($manifest.file) 哈希不符（多半是上次下载中断），删除后重新下载。" -ForegroundColor Yellow
        Remove-Item $zipPath -Force
    }

    if (-not (Test-Path $vendorDir)) {
        New-Item -ItemType Directory -Path $vendorDir | Out-Null
    }
    # 先下到 .part，校验通过才改名——半截文件不能长得像一个可用缓存。
    $partPath = "$zipPath.part"
    if (Test-Path $partPath) { Remove-Item $partPath -Force }

    Write-Host "首次使用：从 $($manifest.url) 下载 sqlite-tools（约 6.4 MB，需联网）..." -ForegroundColor Yellow
    # PS 5.1 默认不一定开 TLS 1.2，而 sqlite.org 只收 TLS 1.2+。
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {}

    $prevProgress = $ProgressPreference
    # Invoke-WebRequest 的进度条在非交互宿主里会把下载拖慢一个数量级。
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri $manifest.url -OutFile $partPath -UseBasicParsing -TimeoutSec 300
    } finally {
        $ProgressPreference = $prevProgress
    }

    $actual = Get-Sha256Upper -Path $partPath
    if ($actual -ne $expected) {
        Remove-Item $partPath -Force
        $msg = "SHA256 校验失败，已删除下载文件并拒绝使用（供应链防线）。`n" +
               "  期望: $expected`n" +
               "  实际: $actual`n" +
               "  来源: $($manifest.url)`n" +
               "若 sqlite.org 确实发布了新版本，请更新 $manifestPath 的 version / file / url / sha256 " +
               "四个字段（sha256 用 Get-FileHash -Algorithm SHA256 对真正下到的文件实算）。"
        throw $msg
    }

    Move-Item -Path $partPath -Destination $zipPath -Force
    Write-Host "下载完成，SHA256 校验通过：$($manifest.file)" -ForegroundColor Green
    return $zipPath
}

function Find-Sqlite3 {
    # 1. 显式环境变量
    if ($env:SQLITE3_PATH -and (Test-Path $env:SQLITE3_PATH)) {
        return (Resolve-Path $env:SQLITE3_PATH).Path
    }
    # 2. PATH
    try {
        $fromPath = (Get-Command sqlite3 -ErrorAction Stop).Source
        if ($fromPath) { return $fromPath }
    } catch {}
    # 3. 本仓库 vendor 已解压
    $vendorExe = Join-Path $extractDir 'sqlite3.exe'
    if (Test-Path $vendorExe) { return (Resolve-Path $vendorExe).Path }
    return $null
}

function Install-FromVendor {
    $zipPath = Resolve-VendorZip

    if (Test-Path $extractDir) {
        Remove-Item $extractDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $extractDir | Out-Null
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    # zip 里可能套一层目录
    $nested = Get-ChildItem $extractDir -Directory | Select-Object -First 1
    if ($nested) {
        Move-Item (Join-Path $nested.FullName '*') $extractDir -Force
        Remove-Item $nested.FullName -Recurse -Force
    }

    $exe = Join-Path $extractDir 'sqlite3.exe'
    if (-not (Test-Path $exe)) {
        throw "解压后仍未找到 sqlite3.exe，请检查 zip 内容"
    }
    return (Resolve-Path $exe).Path
}

# ── 入口 ──────────────────────────────────────────────────────────────────────

if ($EnsureZipOnly) {
    # lib/sqlite.mjs 走这条路：它只要一个校验过的 zip，解压与环境变量由它自己管。
    # 刻意不碰 SQLITE3_PATH，也不动 vendor/sqlite/——避免 node 侧调用产生意外副作用。
    $zipPath = Resolve-VendorZip
    Write-Output $zipPath
    exit 0
}

$existing = Find-Sqlite3
if ($existing) {
    Write-Host "sqlite3 已可用: $existing" -ForegroundColor Green
    if ($ReturnPath) { return $existing }
    exit 0
}

Write-Host "未找到 sqlite3，准备安装包并解压..." -ForegroundColor Yellow
$exe = Install-FromVendor
$env:SQLITE3_PATH = $exe
[Environment]::SetEnvironmentVariable('SQLITE3_PATH', $exe, 'User')
Write-Host "已解压并设置用户级 SQLITE3_PATH: $exe" -ForegroundColor Green
Write-Host "提示：当前窗口已生效；新窗口会自动继承。" -ForegroundColor DarkGray

if ($ReturnPath) { return $exe }
