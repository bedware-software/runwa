# Show a notification in a running Runwa (Windows).
#
#   runwa-notify --text "Finished" [--title "Build"] [--duration 4000]
#                [--tone neutral|error|success] [--source build]
#
# --text is required. --duration is in milliseconds. A later notification with
# the same --source replaces the earlier one.
#
# It only writes a small JSON file into %APPDATA%\Runwa\notify-inbox, which
# Runwa watches (the Notifications module must be on). Nothing is launched, so
# it works from a normal shell while Runwa itself runs as administrator.
# Arguments are parsed by hand to accept the same --name value form as the
# macOS script.

$ErrorActionPreference = 'Stop'

$known = @('title', 'text', 'duration', 'tone', 'source')
$values = @{}
for ($i = 0; $i -lt $args.Count; $i++) {
  $arg = [string]$args[$i]
  if ($arg -eq '--help' -or $arg -eq '-h') {
    Write-Host 'usage: runwa-notify --text "..." [--title "..."] [--duration ms] [--tone neutral|error|success] [--source name]'
    exit 0
  }
  $name = $arg -replace '^--?', ''
  if ($arg -notmatch '^--?[a-z]+$' -or $known -notcontains $name) {
    Write-Host "runwa-notify: unknown option $arg"
    exit 2
  }
  if ($i + 1 -ge $args.Count) {
    Write-Host "runwa-notify: $arg needs a value"
    exit 2
  }
  $i++
  $values[$name] = [string]$args[$i]
}

if (-not $values.ContainsKey('text') -or -not $values['text'].Trim()) {
  Write-Host 'runwa-notify: --text is required'
  exit 2
}

$request = [ordered]@{ text = $values['text'] }
if ($values.ContainsKey('title')) { $request['title'] = $values['title'] }
if ($values.ContainsKey('tone')) { $request['tone'] = $values['tone'] }
if ($values.ContainsKey('source')) { $request['source'] = $values['source'] }
if ($values.ContainsKey('duration')) {
  $duration = 0
  if (-not [int]::TryParse($values['duration'], [ref]$duration) -or $duration -le 0) {
    Write-Host 'runwa-notify: --duration is a number of milliseconds'
    exit 2
  }
  $request['duration'] = $duration
}

$inbox = Join-Path $env:APPDATA 'Runwa\notify-inbox'
if (-not (Test-Path -LiteralPath $inbox)) {
  Write-Host "runwa-notify: $inbox does not exist. Is Runwa running with the Notifications module on?"
  exit 1
}

# Written under a temporary name and renamed, so Runwa never reads half a file.
$name = '{0:yyyyMMddHHmmssfff}-{1}' -f (Get-Date), [guid]::NewGuid().ToString('N')
$temp = Join-Path $inbox "$name.tmp"
$json = $request | ConvertTo-Json -Compress
[IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding $false))
Rename-Item -LiteralPath $temp -NewName "$name.json"
