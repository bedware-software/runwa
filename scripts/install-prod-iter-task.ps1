# Create (or recreate) the "Runwa prod-iter" scheduled task. Run once, from an elevated
# PowerShell, as the user who works on Runwa:
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-prod-iter-task.ps1
#
# Why: Runwa runs as administrator, so scripts\prod-iter.ps1 cannot stop and reinstall it from
# a normal shell. The task runs that one script "with highest privileges", and its owner can
# start it without a UAC prompt: scripts\prod-iter-run.ps1 does that from a normal session.
#
# The task has no trigger (it only runs on demand), runs as the current user and only while
# that user is logged on, so the relaunched Runwa lands in their desktop session, elevated.
#
# Know what this is: the task runs whatever scripts\prod-iter.ps1 says, elevated, and that file
# (like the rest of the repo it builds) is writable without elevation. Anything that can edit
# it as this user can get administrator rights by starting the task. Remove the task with
#   Unregister-ScheduledTask -TaskName 'Runwa prod-iter' -Confirm:$false

$ErrorActionPreference = 'Stop'

$taskName = 'Runwa prod-iter'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $elevated) {
  Write-Host 'This script creates a task that runs with highest privileges, so it has to be' -ForegroundColor Red
  Write-Host 'run from an elevated PowerShell (Run as administrator). Nothing was changed.' -ForegroundColor Red
  exit 1
}

$repo = Split-Path $PSScriptRoot -Parent
$script = Join-Path $PSScriptRoot 'prod-iter.ps1'
if (-not (Test-Path -LiteralPath $script)) { throw "$script not found" }

# Windows PowerShell by full path: always there, and prod-iter.ps1 is written for it. The
# task's PATH is the user's registry PATH, which the Store's pwsh alias is not reliably on.
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Unattended' -f $script

$action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $repo
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest
# Priority 4: tasks default to 7 (below normal), and both the build and the Runwa that the
# script relaunches would inherit that. One hour is a ceiling for a hung build, not a schedule.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew -Priority 4

Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings `
  -Description 'Builds, reinstalls and relaunches Runwa (scripts\prod-iter.ps1 -Unattended). On demand only.' `
  -Force | Out-Null

Write-Host "Task '$taskName' is ready: runs as $($identity.Name), highest privileges, on demand."
Write-Host "Action: $shell $arguments"
Write-Host 'Ship from a normal session with: powershell -ExecutionPolicy Bypass -File scripts\prod-iter-run.ps1'
