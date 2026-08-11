# install-health-check.ps1 — 注册「dao 体检定时刷新」计划任务（2026-08-11 重设计，用户拍板修正②）
#
# 背景：SessionStart 体检已离线化——会话开始只读 ~/.claude/dao-state/health-report.json 的
# 一行摘要，报告由本脚本注册的计划任务**每天**跑 `--write-report` 刷新（无人工也定期跑）。
# 「只落盘无人刷新」是被用户明确否决的形态，本脚本就是那条刷新链。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-health-check.ps1
#   -Uninstall  摘除任务
# 幂等：重复跑 = 重建同名任务。不需要管理员（当前用户的计划任务）。
[CmdletBinding()]
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$taskName = 'dao-health-report'
$repoRoot = Split-Path -Parent $PSScriptRoot
$hook = Join-Path $repoRoot 'ccswitch\hooks\dao-scaffold-check.js'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host '找不到 node —— 没法注册'; exit 2 }
if (-not (Test-Path -LiteralPath $hook)) { Write-Host "hook 不在：$hook"; exit 2 }

if ($Uninstall) {
    schtasks /Delete /TN $taskName /F 2>$null | Out-Null
    Write-Host "已摘除计划任务 $taskName（若它存在）"
    exit 0
}

# 每天 09:00 跑一次 + 登录时再跑一次（错过开机日的兜底）。/F = 覆盖同名任务。
$cmd = "`"$node`" `"$hook`" --write-report"
schtasks /Create /TN $taskName /F /SC DAILY /ST 09:00 /TR $cmd | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "schtasks 注册失败（exit $LASTEXITCODE）"; exit 1 }

Write-Host "已注册计划任务 $taskName：每天 09:00 跑体检并落盘报告。"
Write-Host "立即现刷一次：node ccswitch/hooks/dao-scaffold-check.js --write-report"
Write-Host "核验：schtasks /Query /TN $taskName"
exit 0
