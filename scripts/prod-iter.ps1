# Build Runwa, reinstall it over the local prod install and relaunch it (Windows).
# macOS counterpart: scripts/prod-iter.sh.
#
#   scripts\prod-iter.ps1 [commit message]
#
# The order is deliberate. Commit first: the husky pre-commit hook bumps the patch version,
# and that number is the only way to tell the new build from the old one. Build while Runwa
# keeps running (the build only writes to out\ and release\). Stop it only for the few
# seconds the install takes.
#
# No tests and no typecheck: this is the fast dogfooding loop, verification is its own pass.
#
# Get-Process Runwa matches only the installed app: an `npm run dev` instance runs as
# electron.exe and is never touched.

param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Message
)

$ErrorActionPreference = 'Stop'

function Step($Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }

# Native commands don't throw on a non-zero exit code, so check it explicitly.
function Invoke-Checked([scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "exit code ${LASTEXITCODE}: $Command" }
}

function Get-PkgVersion { (Get-Content package.json -Raw | ConvertFrom-Json).version }

# electron-builder stamps the exe as "1.2.3" or "1.2.3.0" depending on the field.
function Get-ExeVersion($Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 'none' }
  (Get-Item -LiteralPath $Path).VersionInfo.ProductVersion -replace '^(\d+\.\d+\.\d+)\.0$', '$1'
}

function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

$repo = Split-Path $PSScriptRoot -Parent
Push-Location $repo
try {
  # Relaunch from wherever the app runs from, unless that is a build inside the repo. NSIS /S
  # reinstalls into the previous install location, so that is also where the new exe lands.
  $exe = Join-Path $env:LOCALAPPDATA 'Programs\Runwa\Runwa.exe'
  $running = Get-Process Runwa -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($running -and $running.Path -and -not $running.Path.StartsWith($repo, 'OrdinalIgnoreCase')) {
    $exe = $running.Path
  }
  $log = Join-Path $env:APPDATA 'Runwa\logs\main.log'

  # "Run as administrator" makes Runwa elevated, and a non-elevated shell can't terminate an
  # elevated process. Find that out now rather than after a commit and a multi-minute build.
  $settingsPath = Join-Path $env:APPDATA 'Runwa\runwa-settings.json'
  $runAsAdmin = (Test-Path -LiteralPath $settingsPath) -and
    ((Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).runAsAdmin -eq $true)
  if ($running -and $runAsAdmin -and -not (Test-Elevated)) {
    throw 'Runwa runs as administrator, so this shell cannot stop it. Rerun from an elevated PowerShell.'
  }

  Step '1/6 Commit'
  $oldVersion = Get-PkgVersion
  $status = git status --porcelain
  if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
  if (-not $status) {
    $installed = Get-ExeVersion $exe
    # A clean tree still has something to ship when the last commit (and its version bump)
    # never made it into the install.
    if ($installed -eq $oldVersion) {
      Write-Host "Working tree is clean and $exe is already $oldVersion."
      if ([Console]::IsInputRedirected) { return }
      $answer = Read-Host "Rebuild and reinstall $oldVersion anyway? [y/N]"
      if ($answer -notmatch '^[yY]') { return }
    } else {
      Write-Host "Working tree is clean, shipping $oldVersion over the installed $installed."
    }
    $version = $oldVersion
  } else {
    Invoke-Checked { git add -A }
    if ($Message) {
      Invoke-Checked { git commit -m ($Message -join ' ') }
    } else {
      $files = (git diff --cached --name-status) -join "`n"
      Invoke-Checked { git commit -m 'Prod iter checkpoint' -m $files }
    }
    $version = Get-PkgVersion
    if ($version -eq $oldVersion) {
      throw "the pre-commit hook did not bump the version (still $version). Is husky installed? Run npm install."
    }
    Write-Host "$oldVersion -> $version"
  }

  Step "2/6 Build $version (Runwa keeps running)"
  # dist:win rebuilds the Rust addon from scratch, so there is no separate build:native step.
  Invoke-Checked { npm run dist:win }

  Step '3/6 Check build output'
  # electron-builder.yml: artifactName ${productName}-${version}-setup.${ext}
  $installer = Join-Path $repo "release\Runwa-$version-setup.exe"
  if (-not (Test-Path -LiteralPath $installer)) { throw "$installer not found, did the build fail?" }
  Write-Host $installer

  Step '4/6 Stop Runwa'
  if (Get-Process Runwa -ErrorAction SilentlyContinue) {
    Write-Host "Stopping $exe"
    # The Chromium helpers are Runwa.exe too and die with the main process, so "process not
    # found" for some of them is expected.
    Stop-Process -Name Runwa -Force -ErrorAction SilentlyContinue
    Wait-Process -Name Runwa -Timeout 15 -ErrorAction SilentlyContinue
    if (Get-Process Runwa -ErrorAction SilentlyContinue) {
      throw 'Runwa is still running after 15s. If it runs as administrator, rerun from an elevated PowerShell.'
    }
  } else {
    Write-Host 'Runwa is not running'
  }

  Step '5/6 Install silently'
  # NSIS is oneClick: false, per-user, so /S is an unattended install into the previous
  # install location (default %LOCALAPPDATA%\Programs\Runwa). It does not launch the app.
  $setup = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($setup.ExitCode -ne 0) { throw "installer exited with code $($setup.ExitCode)" }

  Step '6/6 Relaunch'
  if (-not (Test-Path -LiteralPath $exe)) { throw "$exe not found after install" }
  $installed = Get-ExeVersion $exe
  if ($installed -ne $version) { throw "the installed app reports $installed, expected $version" }
  # Inherits this shell's token: elevated here means elevated Runwa, and a non-elevated shell
  # gets the usual UAC prompt when "Run as administrator" is on.
  Start-Process -FilePath $exe

  Write-Host "`nShipped $version to $exe (log: $log)" -ForegroundColor Green
}
finally {
  Pop-Location
}
