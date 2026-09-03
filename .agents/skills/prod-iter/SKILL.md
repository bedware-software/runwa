---
name: prod-iter
description: >-
  Package and locally install the current Runwa changes for fast manual
  iteration: commit first so the version bumps, build while the installed app
  keeps running, then stop, replace, and relaunch it. Use when the user says
  "prod iter" / "PROD ITER" or explicitly asks to get the current changes
  installed and running as fast as possible. Skips tests by design.
metadata:
  short-description: Build, install, and relaunch Runwa fast
---

# PROD ITER

Use the fastest path from the current Runwa working tree to a running,
locally installed production build on this machine. This is the
"promote to prod and dogfood" loop: ship a real packaged build and exercise
it instead of relying on dev mode.

Optimize for speed, not confidence. Do not run `cargo test`, `npm run
typecheck`, or a UI/E2E pass as part of this skill, even when asked to
"verify". Treat broader verification as a separate, deliberately requested
pass.

Run every step from the repository root. Stop and report the failing step and
its output if anything fails; do not skip ahead or silently retry.

## Choose the host recipe

The native addon can only be built for the current OS;
`prepare-native-release.mjs` rejects cross-OS requests.

| Host | Build | Installed app |
| --- | --- | --- |
| Windows | `npm run dist:win` | `%LOCALAPPDATA%\Programs\Runwa` |
| macOS | `npm run dist:mac -- --<arch> --dir` | `/Applications/Runwa.app` |

On macOS, obtain the host architecture with `uname -m` and pass `--arm64` or
`--x64` together with `--dir`. Without these flags, electron-builder creates
DMG and ZIP artifacts for both architectures. This loop needs only the signed
`.app`. `prepare:native:release -- darwin` still cross-builds both Rust targets
into one universal addon; that slow step is intentional and cannot be skipped.

## Invariants

### Commit before building

The Husky pre-commit hook runs `npm version patch --no-git-tag-version`, so the
commit produces the new version that the following build must package. Building
first can package the same version that is already installed, making it unclear
whether the new bits took effect.

Committing also makes every iteration a restorable checkpoint. Work-in-progress
or possibly broken code may still be committed for this workflow because the
user explicitly chose fast dogfooding.

### Stop Runwa only after the build succeeds

The user may be actively using Runwa. The build writes to `release/` and `out/`
and does not require stopping the installed app, so keep it running throughout
the slow build. Stop it only for the short install step.

## Workflow

### 1. Commit all current changes

```bash
git status --short
```

If the tree is dirty, inspect the diff, stage everything with `git add -A`, and
commit with a specific message describing the actual change. The hook's version
bump and its staging of `package.json` and `package-lock.json` are expected; do
not undo or manually re-stage them.

If the tree is clean, continue directly to the build. Do not push unless the
user explicitly asks.

### 2. Build while Runwa remains open

Windows:

```powershell
npm run dist:win
```

macOS, substituting the architecture returned by `uname -m`:

```bash
npm run dist:mac -- --arm64 --dir
```

The build can take several minutes; wait for it to finish. Do not run a separate
`npm run build:native` first. The release preparation removes generated
bindings, rebuilds the Rust addon, and validates the packaged native exports, so
a separate native build is wasted work even when `native/src` changed.

### 3. Identify and validate the artifact

Read the version that should have been built:

```bash
node -p "require('./package.json').version"
```

Windows uses the artifact pattern `release\Runwa-<version>-setup.exe`:

```powershell
$installer = Get-ChildItem release\Runwa-*-setup.exe |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 -ExpandProperty FullName
$installer
```

macOS `--dir` leaves the bundle at `release/mac-arm64/Runwa.app` for arm64 or
`release/mac/Runwa.app` for x64. Confirm the bundle version before installation:

```bash
built=release/mac-arm64/Runwa.app
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$built/Contents/Info.plist"
```

Stop if the package version and artifact version differ; the build used stale
version metadata.

### 4. Stop the installed app

Windows: capture its executable path before installation, then stop it. If no
process is running, use the standard per-user install path.

```powershell
$exe = Get-Process Runwa -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty Path
Stop-Process -Name Runwa -Force -ErrorAction SilentlyContinue
if (-not $exe) { $exe = "$env:LOCALAPPDATA\Programs\Runwa\Runwa.exe" }
```

macOS:

```bash
pkill -f '/Applications/Runwa.app' || true
```

It is acceptable for Runwa not to be running.

### 5. Install the artifact

Windows uses the NSIS per-user silent install. It does not relaunch Runwa:

```powershell
Start-Process -FilePath $installer -ArgumentList '/S' -Wait
```

On macOS, replace the exact installed bundle wholesale. Use `ditto` so code
signatures and extended attributes are preserved; a partial copy can leave a
bundle that Gatekeeper rejects.

```bash
rm -rf /Applications/Runwa.app
ditto release/mac-arm64/Runwa.app /Applications/Runwa.app
```

Use `release/mac/Runwa.app` instead on x64.

### 6. Relaunch and report

Windows:

```powershell
Start-Process $exe
```

macOS:

```bash
open -a /Applications/Runwa.app
```

Confirm that the process started. Report the exact installed version so the
user can distinguish the new build from the previous one.

On macOS, replacing the bundle should normally preserve the user's TCC grants.
`scripts/mac-after-sign.mjs` signs with an identifier-based designated
requirement (`designated => identifier "dev.dmitr.runwa"`). If keyboard remap,
palette hotkeys, or the window walker are dead after installation, inspect the
installed requirement:

```bash
codesign -d -r- /Applications/Runwa.app
```

A cdhash-bound designated requirement means the signing hook did not run; fix
the signing step instead of asking the user to re-enable Accessibility or Input
Monitoring.

## Out of scope

- Tests, typechecking, and UI/E2E verification
- `git push`
- Cross-OS builds
- Full macOS DMG/ZIP release artifacts for both architectures
- Distribution signing, notarization, and auto-update manifests

## Failure guide

- `cargo` or `rustc` failure during release preparation: fix the Rust error and
  rerun the platform `dist:` command. A partial artifact is not reusable.
- `Native addon is missing release exports`: reconcile the new `#[napi]` export,
  the required-export list in `validateGeneratedPackage`, and the generated
  wrapper.
- `Cannot build win32 native code on darwin` or the inverse: the wrong host
  recipe was selected.
- No expected file under `release/`: electron-builder failed. Inspect its first
  error rather than broadening the artifact glob.
