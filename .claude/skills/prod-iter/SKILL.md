---
name: prod-iter
description: Fast local install of Runwa on Windows for manual iteration — commit first (the pre-commit hook bumps the version), run dist:win while the app keeps running, then kill / silent-install / relaunch. Skips all tests by design. Trigger on "prod iter", "PROD ITER", or a request to get the current changes installed and running as fast as possible.
user-invocable: true
allowed-tools:
  - Bash
  - PowerShell
---

# PROD ITER

Fastest path from a dirty working tree to a running, locally-installed
build of Runwa on Windows. This is the "promote to prod and dogfood" loop:
ship a real packaged build to this machine and exercise it, rather than
trusting dev mode.

Optimized for speed, not confidence: **never run `cargo test`, never run a
UI/E2E pass** as part of this skill, even when asked to "verify" — that's a
separate, slower pass the user runs deliberately.

Run every step from the repo root. Stop and report if a step fails; don't
skip ahead.

## Two things that are load-bearing

**Commit before building.** The husky pre-commit hook runs
`npm version patch --no-git-tag-version`, so the commit lands a *new*
version that the build then ships. Build first and you package the version
that is already installed — the relaunched app reads identical and there's
no way to tell whether the new bits took. Committing also turns every
iteration into a restorable checkpoint, which is why work-in-progress or
possibly-broken code should still be committed: `git checkout` makes
rollback trivial, while an unversioned build is genuinely confusing.

**Kill the app as late as possible.** The user is actively using Runwa
while this runs, and dislikes it sitting dead through a long build. The
build only writes to `release\` and `out\`; the installed app lives under
`%LOCALAPPDATA%\Programs\Runwa` and holds no lock on either. So it stays up
for the whole slow build and only dies for the fast install.

## Steps

### 1. Commit everything

```bash
git status --short
```

If non-empty: read the diff, `git add -A`, and commit with a real message
describing the actual change — no placeholders. The hook's version bump and
its `git add package.json package-lock.json` are expected; don't undo them
or re-stage them yourself.

If the tree is already clean, there's still an installed version to refresh
— go straight to step 2.

Pushing is **not** part of this loop. Push only if the user asks.

### 2. Build and package — app still running

```bash
npm run dist:win
```

Long-running (minutes). Wait it out; do not kill Runwa first.

This expands to
`prepare:native:release -- win32 && electron-vite build && electron-builder --win --x64`.
The prep script removes the generated bindings, rebuilds the Rust addon
with `napi build --platform --release`, and validates that the packaged
`.node` exports what the app needs. **So there is no separate
`npm run build:native` step** — running one beforehand is wasted work, the
prep script deletes that output and rebuilds it. This holds whether or not
anything under `native/src` changed.

### 3. Find the installer

`electron-builder.yml` sets
`artifactName: ${productName}-${version}-setup.${ext}`, so the file is
`release\Runwa-<version>-setup.exe` — *not* "Runwa Setup <ver>.exe".

```powershell
$installer = Get-ChildItem release\Runwa-*-setup.exe |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 -ExpandProperty FullName
$installer
```

Cross-check against `node -p "require('./package.json').version"` — they
should agree. If they don't, the build ran against a stale version and step
1 was skipped or the hook didn't fire.

### 4. Capture the exe path, then kill it — now, not earlier

```powershell
$exe = Get-Process Runwa -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty Path
Stop-Process -Name Runwa -Force -ErrorAction SilentlyContinue
```

It may not be running — that's fine, continue. Keep `$exe` for step 6; the
install overwrites that binary in place. If nothing was running, fall back
to `"$env:LOCALAPPDATA\Programs\Runwa\Runwa.exe"`.

### 5. Install silently

```powershell
Start-Process -FilePath $installer -ArgumentList '/S' -Wait
```

NSIS is configured `oneClick: false`, `perMachine: false`, so `/S` performs
an unattended per-user install into `%LOCALAPPDATA%\Programs\Runwa`. A
silent install does **not** auto-launch the app.

### 6. Relaunch and report

```powershell
Start-Process $exe
```

Report the version just shipped and confirm the process came up. The
version readout in the app is the user's signal that the new build actually
installed, so state it explicitly.

## Explicitly out of scope

- `cargo test`, `npm run typecheck`, any UI/E2E run
- `git push`
- macOS / Linux builds — `npm run dist:mac` and `dist:linux` are separate,
  must run on that OS, and macOS additionally cross-builds both Rust
  targets into a universal addon
- Code signing for distribution, notarization, auto-update manifests

If a change needs verifying beyond "does it launch and behave", that's a
separate, slower pass — not this one.

## When it fails

Report the failing step with its output rather than silently retrying. The
common ones:

- **`cargo`/`rustc` errors from the prep script** — the addon didn't
  compile. Fix the Rust, then rerun `npm run dist:win`; there's nothing to
  salvage from a partial run.
- **"Native addon is missing release exports"** — a new `#[napi]` export
  exists in `native/src` but `validateGeneratedPackage`'s required-export
  list or the generated wrapper disagrees. Real failure, not flake.
- **Installer not found in `release\`** — electron-builder failed after the
  bundle step; scroll back for its error rather than globbing harder.
