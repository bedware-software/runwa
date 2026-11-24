# Ship Runwa from a normal (non-elevated) session: start the "Runwa prod-iter" scheduled task,
# wait for it and print how it went.
#
#   scripts\prod-iter-run.ps1 [-TimeoutMinutes 30] [commit message]
#
# The task (created once by scripts\install-prod-iter-task.ps1) runs
# scripts\prod-iter.ps1 -Unattended elevated; all of the release logic is in that script. This
# one only hands it the commit message, starts the task and follows release\prod-iter.log
# until its "RESULT:" line. Exit code: 0 shipped, 1 failed, 2 the task is missing or busy.

[CmdletBinding(PositionalBinding = $false)]
param(
  [int]$TimeoutMinutes = 30,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Message
)

$ErrorActionPreference = 'Stop'

$taskName = 'Runwa prod-iter'
$repo = Split-Path $PSScriptRoot -Parent
$log = Join-Path $repo 'release\prod-iter.log'
$messageFile = Join-Path $repo 'release\prod-iter-message.txt'

function Get-TaskState {
  try { "$((Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).State)" } catch { '' }
}

function Get-ResultLine {
  if (-not (Test-Path -LiteralPath $log)) { return $null }
  try {
    Get-Content -LiteralPath $log -Encoding UTF8 -ErrorAction Stop |
      Where-Object { $_ -match '^RESULT: ' } | Select-Object -Last 1
  } catch { $null }
}

$state = Get-TaskState
if (-not $state) {
  Write-Host "The scheduled task '$taskName' does not exist (or this user cannot see it)."
  Write-Host 'Create it once from an elevated PowerShell:'
  Write-Host "  powershell -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'install-prod-iter-task.ps1')`""
  exit 2
}
if ($state -eq 'Running') {
  Write-Host "The task '$taskName' is already running. Follow $log"
  exit 2
}
if ($state -eq 'Disabled') {
  Write-Host "The task '$taskName' is disabled. Enable it in Task Scheduler or reinstall it."
  exit 2
}

New-Item -ItemType Directory -Force -Path (Split-Path $log -Parent) | Out-Null
# A leftover log would be read as this run's result; a leftover message would be committed.
Remove-Item -LiteralPath $log, $messageFile -Force -ErrorAction SilentlyContinue
if ($Message) {
  Set-Content -LiteralPath $messageFile -Value ($Message -join ' ') -Encoding UTF8
}

schtasks.exe /run /tn $taskName | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "schtasks /run failed with exit code $LASTEXITCODE."
  exit 1
}
Write-Host "Started '$taskName'. Log: $log"

$started = Get-Date
$deadline = $started.AddMinutes($TimeoutMinutes)
$result = $null
$timedOut = $false
while ($true) {
  Start-Sleep -Seconds 2
  $result = Get-ResultLine
  if ($result) { break }
  # No result and the task is no longer running: it died or never started. The first seconds
  # don't count, the task can still be queued.
  if (((Get-Date) - $started).TotalSeconds -gt 20 -and (Get-TaskState) -ne 'Running') {
    Start-Sleep -Seconds 1
    $result = Get-ResultLine
    break
  }
  if ((Get-Date) -gt $deadline) { $timedOut = $true; break }
}

Write-Host ''
if (Test-Path -LiteralPath $log) {
  Write-Host "----- last lines of $log -----"
  Get-Content -LiteralPath $log -Encoding UTF8 -Tail 40 | ForEach-Object { Write-Host $_ }
  Write-Host '-----'
} else {
  Write-Host "No log at ${log}: the task did not get as far as starting the script."
}

if ($timedOut) {
  Write-Host "RESULT: FAIL wait: no result after $TimeoutMinutes minutes, the task may still be running"
  exit 1
}
if (-not $result) {
  Write-Host "RESULT: FAIL wait: the task stopped without a result (last task result code: $((Get-ScheduledTaskInfo -TaskName $taskName).LastTaskResult))"
  exit 1
}
Write-Host $result
if ($result -match '^RESULT: OK') { exit 0 }
exit 1
