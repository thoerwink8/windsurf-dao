<#
.SYNOPSIS
  Quick alias: dao-persona <action> [mode]
  Delegates to dao-persona-manager.ps1 in the same directory.
.EXAMPLE
  dao-persona install
  dao-persona switch fable5
  dao-persona switch dao
  dao-persona switch off
  dao-persona status
  dao-persona uninstall
#>
& "$PSScriptRoot\dao-persona-manager.ps1" @args
