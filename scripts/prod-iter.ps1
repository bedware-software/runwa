# Build Runwa, reinstall it over the local prod install and relaunch it (Windows).
# macOS counterpart: scripts/prod-iter.sh.
#
#   scripts\prod-iter.ps1 [commit message]
#
# The order is deliberate. Commit first: the husky pre-commit hook bumps the patch version,
# which is how a new build tells itself apart from the old one. The build also carries the
# commit it was made from (scripts/build-commit.mjs), so a clean tree still rebuilds when the
# installed app shares the version but not the commit, e.g. after a rebase. Build while Runwa
# keeps running (the build only writes to out\ and release\). Stop it only for the few
# seconds the install takes. Push last, once the new build is running.
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

# The commit prod-iter stamped into the app next to $Exe, or '' for none (see build-commit.mjs).
function Get-ExeCommit($Exe) {
  $archive = Join-Path (Split-Path $Exe -Parent) 'resources\app.asar'
  $commit = node scripts/build-commit.mjs $archive
  if ($LASTEXITCODE -ne 0) { throw "reading the build commit from $archive failed" }
  "$commit".Trim()
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

  Step '1/7 Commit'
  $oldVersion = Get-PkgVersion
  $status = git status --porcelain
  if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
  if (-not $status) {
    $installed = Get-ExeVersion $exe
    $installedCommit = Get-ExeCommit $exe
    $head = (git rev-parse HEAD).Trim()
    # A clean tree still has something to ship when the last commit never made it into the
    # install: either its version bump didn't, or the commit itself didn't (a rebase onto a
    # commit that made the same bump elsewhere leaves the version as it was).
    if ($installed -eq $oldVersion -and $installedCommit -eq $head) {
      Write-Host "Working tree is clean and $exe is already $oldVersion ($($head.Substring(0, 7)))."
      if ([Console]::IsInputRedirected) { return }
      $answer = Read-Host "Rebuild and reinstall $oldVersion anyway? [y/N]"
      if ($answer -notmatch '^[yY]') { return }
    } elseif ($installed -eq $oldVersion) {
      $from = if ($installedCommit) { $installedCommit.Substring(0, 7) } else { 'an unrecorded commit' }
      Write-Host "Working tree is clean, $exe is $oldVersion but built from $from, shipping $($head.Substring(0, 7))."
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
  $commit = (git rev-parse HEAD).Trim()

  Step "2/7 Build $version (Runwa keeps running)"
  # dist:win rebuilds the Rust addon from scratch, so there is no separate build:native step.
  # electron-builder logs "signing with signtool.exe" for every exe even with no certificate
  # configured, then skips the signing silently. Those lines sit in front of the ~10 s NSIS
  # pack and read as if signing were the slow part, so drop them and say what is running.
  $signing = $env:CSC_LINK -or $env:WIN_CSC_LINK
  Invoke-Checked {
    # Quoted '--': PowerShell drops a bare one when npm resolves to the npm.ps1 shim.
    npm run dist:win '--' "-c.extraMetadata.gitCommit=$commit" 2>&1 | ForEach-Object {
      $line = "$_"
      if (-not $signing -and $line -match 'signing with signtool\.exe') { return }
      Write-Host $line
      if ($line -match 'building\s+target=nsis') {
        Write-Host '  • compressing the app into the installer (~10 s); unsigned, no certificate configured'
      }
    }
  }

  Step '3/7 Check build output'
  # electron-builder.yml: artifactName ${productName}-${version}-setup.${ext}
  $installer = Join-Path $repo "release\Runwa-$version-setup.exe"
  if (-not (Test-Path -LiteralPath $installer)) { throw "$installer not found, did the build fail?" }
  # The installer packs release\win-unpacked, so its stamp is the installer's.
  $builtCommit = Get-ExeCommit (Join-Path $repo 'release\win-unpacked\Runwa.exe')
  if ($builtCommit -ne $commit) {
    throw "the build is stamped $(if ($builtCommit) { $builtCommit } else { 'with no commit' }), expected $commit"
  }
  Write-Host "$installer ($($commit.Substring(0, 7)))"

  Step '4/7 Stop Runwa'
  if (Get-Process Runwa -ErrorAction SilentlyContinue) {
    Write-Host "Stopping $exe"
    # The Chromium helpers are Runwa.exe too and die with the main process, so "process not
    # found" for some of them is expected. Killed helpers stay in the process list for ~100ms
    # after they have exited, and Wait-Process doesn't wait for exited ones, so poll until the
    # list is actually empty. Killing again each round also catches a helper the main process
    # respawned just before it died.
    $deadline = (Get-Date).AddSeconds(15)
    while (Get-Process Runwa -ErrorAction SilentlyContinue) {
      if ((Get-Date) -gt $deadline) {
        throw 'Runwa is still running after 15s. If it runs as administrator, rerun from an elevated PowerShell.'
      }
      Stop-Process -Name Runwa -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 100
    }
  } else {
    Write-Host 'Runwa is not running'
  }

  Step '5/7 Install silently'
  # NSIS is oneClick: false, per-user, so /S is an unattended install into the previous
  # install location (default %LOCALAPPDATA%\Programs\Runwa). It does not launch the app.
  $setup = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($setup.ExitCode -ne 0) { throw "installer exited with code $($setup.ExitCode)" }

  Step '6/7 Relaunch'
  if (-not (Test-Path -LiteralPath $exe)) { throw "$exe not found after install" }
  $installed = Get-ExeVersion $exe
  if ($installed -ne $version) { throw "the installed app reports $installed, expected $version" }
  if ((Get-ExeCommit $exe) -ne $commit) { throw "the installed app is not stamped with $commit" }
  # Inherits this shell's token: elevated here means elevated Runwa, and a non-elevated shell
  # gets the usual UAC prompt when "Run as administrator" is on.
  Start-Process -FilePath $exe

  Step '7/7 Push'
  # Last on purpose: the new build is already running, so a failed push (offline, remote moved
  # on) costs nothing but a retry. -u origin HEAD also covers a branch with no upstream yet.
  git push -u origin HEAD
  if ($LASTEXITCODE -ne 0) { throw "$version is installed, but the push failed" }

  Write-Host "`nShipped $version to $exe (log: $log)" -ForegroundColor Green
}
finally {
  Pop-Location
}
