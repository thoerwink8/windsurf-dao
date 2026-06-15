# setup-sqlite.ps1 — 为 config-sync 准备 sqlite3 命令行工具
#
# 用法：
#   .\setup-sqlite.ps1                # 检查/解压，返回可用路径
#   $env:SQLITE3_PATH = (.\setup-sqlite.ps1 -ReturnPath)
#
# 逻辑：
# 1. 优先使用现有 sqlite3（环境变量 SQLITE3_PATH / PATH）。
# 2. 否则从本目录 vendor/ 下的 sqlite-tools zip 解压到 vendor/sqlite/。
# 3. 返回 sqlite3.exe 绝对路径。

param(
    [switch]$ReturnPath
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$vendorDir = Join-Path $here 'vendor'
$extractDir = Join-Path $vendorDir 'sqlite'

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
    $zip = Get-ChildItem $vendorDir -Filter 'sqlite-tools-win-x64-*.zip' | Select-Object -First 1
    if (-not $zip) {
        throw "找不到 vendor/sqlite-tools-win-x64-*.zip。请先把 sqlite3 工具包放进 $vendorDir"
    }

    if (Test-Path $extractDir) {
        Remove-Item $extractDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $extractDir | Out-Null
    Expand-Archive -Path $zip.FullName -DestinationPath $extractDir -Force

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

$existing = Find-Sqlite3
if ($existing) {
    Write-Host "sqlite3 已可用: $existing" -ForegroundColor Green
    if ($ReturnPath) { return $existing }
    exit 0
}

Write-Host "未找到 sqlite3，从 vendor 解压..." -ForegroundColor Yellow
$exe = Install-FromVendor
$env:SQLITE3_PATH = $exe
[Environment]::SetEnvironmentVariable('SQLITE3_PATH', $exe, 'User')
Write-Host "已解压并设置用户级 SQLITE3_PATH: $exe" -ForegroundColor Green
Write-Host "提示：当前窗口已生效；新窗口会自动继承。" -ForegroundColor DarkGray

if ($ReturnPath) { return $exe }
