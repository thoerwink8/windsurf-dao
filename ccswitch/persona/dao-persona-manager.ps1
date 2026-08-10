<#
.SYNOPSIS
  dao-persona-manager — 管理 Claude Code CLI 的系统提示词注入
  灵感来源：Fable 5 系统提示词泄露方案 (--append-system-prompt-file)

.DESCRIPTION
  两种模式可切换：
    dao    — 道德经 + 阴符经人设 (~22KB, ~4000 tokens)
    fable5 — Fable 5 泄露原文 (~122KB, ~30000 tokens)

.EXAMPLE
  .\dao-persona-manager.ps1 install
  .\dao-persona-manager.ps1 switch dao
  .\dao-persona-manager.ps1 switch fable5
  .\dao-persona-manager.ps1 switch off
  .\dao-persona-manager.ps1 status
  .\dao-persona-manager.ps1 uninstall
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet("install", "uninstall", "switch", "status", "help")]
    [string]$Action = "help",

    [Parameter(Position = 1)]
    [ValidateSet("dao", "fable5", "off")]
    [string]$Mode
)

$ErrorActionPreference = "Stop"

# --- paths ---
$PersonaHome = "$env:USERPROFILE\.claude\persona"
$ActiveLink  = "$PersonaHome\active-system-prompt.md"
$StateFile   = "$PersonaHome\.current-mode"
$ScriptDir   = $PSScriptRoot  # windsurf-dao/ccswitch/persona/

$Sources = @{
    dao    = "$ScriptDir\dao-system-prompt.md"
    fable5 = "$ScriptDir\fable5-system-prompt.md"
}

# --- profile marker ---
$ProfileMarker = "# >>> dao-persona-inject >>>"
$ProfileMarkerEnd = "# <<< dao-persona-inject <<<"

$ProfileBlock = @"
$ProfileMarker
# Auto-injected by dao-persona-manager. DO NOT edit manually.
# To remove: run dao-persona-manager.ps1 uninstall
function Invoke-DaoPersonaWrap {
    param([string]`$TargetName)
    `$personaFile = "`$env:USERPROFILE\.claude\persona\active-system-prompt.md"
    `$origCmd = Get-Command "`$TargetName.ps1" -ErrorAction SilentlyContinue
    if (-not `$origCmd) { `$origCmd = Get-Command "`$TargetName.exe" -ErrorAction SilentlyContinue }
    if (-not `$origCmd) { `$origCmd = Get-Command `$TargetName -CommandType Application -ErrorAction SilentlyContinue }
    if (-not `$origCmd) {
        Write-Host "`$TargetName not found in PATH" -ForegroundColor Red
        return
    }
    if (Test-Path `$personaFile) {
        & `$origCmd.Source --append-system-prompt-file `$personaFile @args
    } else {
        & `$origCmd.Source @args
    }
}
function Invoke-ClaudeWithPersona { Invoke-DaoPersonaWrap 'claude' @args }
function Invoke-ReclaudeWithPersona { Invoke-DaoPersonaWrap 'reclaude' @args }
Set-Alias -Name claude -Value Invoke-ClaudeWithPersona -Scope Global -Force
Set-Alias -Name reclaude -Value Invoke-ReclaudeWithPersona -Scope Global -Force
$ProfileMarkerEnd
"@

# --- helpers ---
function Get-CurrentMode {
    if (Test-Path $StateFile) {
        return (Get-Content $StateFile -Raw).Trim()
    }
    if (Test-Path $ActiveLink) { return "unknown" }
    return "off"
}

function Write-Mode([string]$mode) {
    Set-Content -Path $StateFile -Value $mode -Encoding utf8
}

function Ensure-PersonaHome {
    if (-not (Test-Path $PersonaHome)) {
        New-Item -ItemType Directory -Path $PersonaHome -Force | Out-Null
    }
}

function Install-ProfileBlock {
    $profile_path = $PROFILE.CurrentUserAllHosts
    $dir = Split-Path $profile_path -Parent
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    if (-not (Test-Path $profile_path)) {
        New-Item -ItemType File -Path $profile_path -Force | Out-Null
    }

    $content = Get-Content $profile_path -Raw -ErrorAction SilentlyContinue
    if ($content -and $content.Contains($ProfileMarker)) {
        Write-Host "  Profile block already exists, updating..." -ForegroundColor Yellow
        Remove-ProfileBlock
    }

    Add-Content -Path $profile_path -Value "`n$ProfileBlock" -Encoding utf8
    Write-Host "  Profile block added to: $profile_path" -ForegroundColor Green
}

function Remove-ProfileBlock {
    $profile_path = $PROFILE.CurrentUserAllHosts
    if (-not (Test-Path $profile_path)) { return }

    $lines = Get-Content $profile_path
    $newLines = @()
    $skipping = $false
    foreach ($line in $lines) {
        if ($line.Trim() -eq $ProfileMarker.Trim()) {
            $skipping = $true
            continue
        }
        if ($line.Trim() -eq $ProfileMarkerEnd.Trim()) {
            $skipping = $false
            continue
        }
        if (-not $skipping) {
            $newLines += $line
        }
    }

    while ($newLines.Count -gt 0 -and $newLines[-1].Trim() -eq "") {
        $newLines = $newLines[0..($newLines.Count - 2)]
    }

    Set-Content -Path $profile_path -Value ($newLines -join "`n") -Encoding utf8
}

function Do-Switch([string]$target) {
    Ensure-PersonaHome

    if ($target -eq "off") {
        if (Test-Path $ActiveLink) { Remove-Item $ActiveLink -Force }
        Write-Mode "off"
        Write-Host "[dao-persona] Switched OFF — vanilla claude" -ForegroundColor Cyan
        Write-Host "  Restart terminal or run: Remove-Item Alias:\claude -Force" -ForegroundColor Gray
        return
    }

    $src = $Sources[$target]
    if (-not (Test-Path $src)) {
        Write-Host "Source not found: $src" -ForegroundColor Red
        Write-Host "Make sure windsurf-dao is cloned and path is correct." -ForegroundColor Yellow
        return
    }

    Copy-Item -Path $src -Destination $ActiveLink -Force
    Write-Mode $target

    $size = (Get-Item $ActiveLink).Length
    $sizeKB = [math]::Round($size / 1024, 1)
    Write-Host "[dao-persona] Switched to: $target ($($sizeKB)KB)" -ForegroundColor Green
    Write-Host "  Restart terminal for effect, or run:" -ForegroundColor Gray
    Write-Host "  . `$PROFILE" -ForegroundColor Gray
}

# --- actions ---
switch ($Action) {
    "install" {
        Write-Host "`n=== dao-persona-manager install ===" -ForegroundColor Magenta

        Ensure-PersonaHome
        Write-Host "  Persona home: $PersonaHome" -ForegroundColor Gray

        $defaultMode = if ($Mode) { $Mode } else { "dao" }
        Do-Switch $defaultMode

        Install-ProfileBlock

        Write-Host "`n  DONE. Restart terminal, then 'claude' will auto-inject persona." -ForegroundColor Green
        Write-Host "  Switch modes:  dao-persona switch dao | fable5 | off" -ForegroundColor Gray
        Write-Host ""
    }

    "uninstall" {
        Write-Host "`n=== dao-persona-manager uninstall ===" -ForegroundColor Magenta

        Remove-ProfileBlock
        Write-Host "  Profile block removed" -ForegroundColor Green

        if (Test-Path $ActiveLink) { Remove-Item $ActiveLink -Force }
        if (Test-Path $StateFile) { Remove-Item $StateFile -Force }
        Write-Host "  Active prompt removed" -ForegroundColor Green

        Write-Host "`n  DONE. Vanilla claude restored. Restart terminal." -ForegroundColor Green
        Write-Host "  Persona files in windsurf-dao remain untouched." -ForegroundColor Gray
        Write-Host ""
    }

    "switch" {
        if (-not $Mode) {
            Write-Host "Usage: dao-persona-manager switch <dao|fable5|off>" -ForegroundColor Yellow
            return
        }
        Do-Switch $Mode
    }

    "status" {
        $mode = Get-CurrentMode
        $hasProfile = $false
        $profile_path = $PROFILE.CurrentUserAllHosts
        if (Test-Path $profile_path) {
            $content = Get-Content $profile_path -Raw -ErrorAction SilentlyContinue
            $hasProfile = $content -and $content.Contains($ProfileMarker)
        }
        $hasActive = Test-Path $ActiveLink

        Write-Host "`n=== dao-persona status ===" -ForegroundColor Magenta
        Write-Host "  Current mode:    $mode" -ForegroundColor $(if ($mode -eq "off") { "Gray" } else { "Green" })
        Write-Host "  Profile hook:    $(if ($hasProfile) { 'installed' } else { 'not installed' })" -ForegroundColor $(if ($hasProfile) { "Green" } else { "Yellow" })
        Write-Host "  Active file:     $(if ($hasActive) { 'present' } else { 'absent' })" -ForegroundColor $(if ($hasActive) { "Green" } else { "Gray" })

        if ($hasActive) {
            $size = (Get-Item $ActiveLink).Length
            $sizeKB = [math]::Round($size / 1024, 1)
            Write-Host "  Active size:     $($sizeKB)KB" -ForegroundColor Gray
        }

        Write-Host "  Persona home:    $PersonaHome" -ForegroundColor Gray
        Write-Host "  Source (dao):    $($Sources.dao)" -ForegroundColor Gray
        Write-Host "  Source (fable5): $($Sources.fable5)" -ForegroundColor Gray
        Write-Host ""
    }

    "help" {
        Write-Host @"

  dao-persona-manager — Claude Code CLI system prompt injection manager

  USAGE:
    .\dao-persona-manager.ps1 <action> [mode]

  ACTIONS:
    install  [dao|fable5]  Install profile hook + set initial mode (default: dao)
    uninstall              Remove profile hook, restore vanilla claude
    switch   <dao|fable5|off>  Switch active persona mode
    status                 Show current state
    help                   This message

  MODES:
    dao      道德经 + 阴符经 (~22KB, ~4000 tokens)
    fable5   Fable 5 leaked system prompt (~122KB, ~30000 tokens)
    off      No persona injection (vanilla claude)

  MECHANISM:
    Uses claude --append-system-prompt-file to inject persona into system prompt.
    A PowerShell profile function wraps 'claude' to auto-append the active file.

  CROSS-MACHINE:
    1. Clone windsurf-dao
    2. Run: .\dao-persona-manager.ps1 install
    3. Restart terminal

"@ -ForegroundColor Cyan
    }
}
