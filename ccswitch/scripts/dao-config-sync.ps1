# dao-config-sync.ps1 — CC Switch ↔ settings.json 双向同步
#
# up (写DB) 可在 Claude Code 运行时安全执行。
# down (写settings.json) 必须在 Claude Code 未运行时执行！否则触发 401 登出。
#
# 用法:
#   dao-config-sync.ps1              # 默认: DB → settings.json (CC Switch 为主)
#   dao-config-sync.ps1 -Direction up   # settings.json → DB (本地为主, 可在会话内)
#   dao-config-sync.ps1 -Direction down # DB → settings.json (CC Switch 为主, 须会话外)
#   dao-config-sync.ps1 -DryRun        # 只报告差异，不写入

param(
    [ValidateSet('up', 'down')]
    [string]$Direction = 'down',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$DB = Join-Path $env:USERPROFILE '.cc-switch\cc-switch.db'
$SETTINGS = Join-Path $env:USERPROFILE '.claude\settings.json'

# Safety: only block when writing settings.json (down direction)
if ($Direction -eq 'down' -and -not $DryRun) {
    $ccProcs = Get-Process -Name 'claude' -ErrorAction SilentlyContinue
    if ($ccProcs) {
        Write-Host '[BLOCKED] Claude Code is running (PID: ' -NoNewline -ForegroundColor Red
        Write-Host ($ccProcs.Id -join ', ') -NoNewline -ForegroundColor Yellow
        Write-Host '). down sync writes settings.json — exit Claude Code first to avoid 401 logout.' -ForegroundColor Red
        Write-Host 'Tip: up sync (settings.json -> DB) is safe during a session.' -ForegroundColor DarkGray
        exit 1
    }
}

if (-not (Test-Path $DB)) {
    Write-Host "[ERROR] CC Switch DB not found: $DB" -ForegroundColor Red
    exit 1
}

# Read DB common_config_claude
$dbRaw = & sqlite3 $DB "SELECT value FROM settings WHERE key='common_config_claude'" 2>$null
if (-not $dbRaw) {
    Write-Host '[ERROR] common_config_claude not found in DB' -ForegroundColor Red
    exit 1
}
$dbJson = $dbRaw | ConvertFrom-Json
$fileJson = Get-Content $SETTINGS -Raw -Encoding utf8 | ConvertFrom-Json

if ($Direction -eq 'up') {
    # settings.json → DB
    $source = 'settings.json'
    $target = 'CC Switch DB'
    $value = Get-Content $SETTINGS -Raw -Encoding utf8

    if ($DryRun) {
        Write-Host "[DRY RUN] Would sync $source -> $target" -ForegroundColor Cyan
        Write-Host "Keys in settings.json: $( ($fileJson.PSObject.Properties.Name | Sort-Object) -join ', ' )"
        exit 0
    }

    # Backup DB
    $backup = "$DB.before-dao-sync-$(Get-Date -Format 'yyyyMMdd_HHmmss').bak"
    Copy-Item $DB $backup
    Write-Host "DB backup: $backup" -ForegroundColor DarkGray

    # Write to DB
    $escapedValue = $value.Trim().Replace("'", "''")
    & sqlite3 $DB "UPDATE settings SET value='$escapedValue' WHERE key='common_config_claude'"

    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] $source -> $target synced" -ForegroundColor Green
    } else {
        Write-Host "[ERROR] sqlite3 update failed" -ForegroundColor Red
        exit 1
    }

} else {
    # DB → settings.json
    $source = 'CC Switch DB'
    $target = 'settings.json'

    if ($DryRun) {
        Write-Host "[DRY RUN] Would sync $source -> $target" -ForegroundColor Cyan
        Write-Host "Keys in DB config: $( ($dbJson.PSObject.Properties.Name | Sort-Object) -join ', ' )"
        Write-Host "Keys in settings.json: $( ($fileJson.PSObject.Properties.Name | Sort-Object) -join ', ' )"
        $dbKeys = $dbJson.PSObject.Properties.Name
        $fileKeys = $fileJson.PSObject.Properties.Name
        $onlyInDb = $dbKeys | Where-Object { $_ -notin $fileKeys }
        $onlyInFile = $fileKeys | Where-Object { $_ -notin $dbKeys }
        if ($onlyInDb) { Write-Host "Only in DB: $($onlyInDb -join ', ')" -ForegroundColor Yellow }
        if ($onlyInFile) { Write-Host "Only in settings.json: $($onlyInFile -join ', ')" -ForegroundColor Yellow }
        exit 0
    }

    # Backup settings.json
    $backup = "$SETTINGS.before-dao-sync-$(Get-Date -Format 'yyyyMMdd_HHmmss').bak"
    Copy-Item $SETTINGS $backup
    Write-Host "Settings backup: $backup" -ForegroundColor DarkGray

    # Write DB content to settings.json
    $dbRaw | Out-File -FilePath $SETTINGS -Encoding utf8 -Force

    Write-Host "[OK] $source -> $target synced" -ForegroundColor Green
}

Write-Host 'Done.' -ForegroundColor Green
