---
name: prod-iter
description: >-
  Fast local install of Runwa for manual iteration — commit first (the
  pre-commit hook bumps the version), build while the app keeps running,
  then kill / install / relaunch. Windows and macOS. Skips all tests by
  design. Trigger on "prod iter", "PROD ITER", or a request to get the
  current changes installed and running as fast as possible.
---

# PROD ITER

Fastest path from a dirty working tree to a running, locally-installed
build of Runwa on **this** machine. This is the "promote to prod and
dogfood" loop: ship a real packaged build and exercise it, rather than
trusting dev mode.

Optimized for speed, not confidence: **never run `cargo test`, never run a
UI/E2E pass** as part of this skill, even when asked to "verify" — that's a
separate, slower pass the user runs deliberately.

Run every step from the repo root. Stop and report if a step fails; don't
skip ahead.

## Pick the platform first

The native addon can only be built for the OS you are on —
`prepare-native-release.mjs` throws on a cross-OS request — so the host
decides the whole recipe:

| Host      | Build                                  | Installed app lives at             |
| --------- | -------------------------------------- | ---------------------------------- |
| Windows   | `npm run dist:win`                     | `%LOCALAPPDATA%\Programs\Runwa`    |
| macOS     | `npm run dist:mac -- --<arch> --dir`   | `/Applications/Runwa.app`          |

On macOS pass the host's own arch (`uname -m` → `arm64` or `x64`) and
`--dir`. Without them electron-builder packages dmg **and** zip for
**both** architectures — four artifacts you are about to throw away.
`--dir` stops after the signed `.app`, which is the only thing this loop
installs. (`prepare:native:release -- darwin` still cross-builds both Rust
targets into one universal addon; that part isn't skippable and is the
slowest step.)

Everything below is shared unless a step says otherwise.

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
build only writes to `release/` and `out/`; the installed app holds no lock
on either. So it stays up for the whole slow build and only dies for the
fast install.

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

### 2. Build — app still running

Windows:

```bash
npm run dist:win
```

macOS (substitute the arch from `uname -m`):

```bash
npm run dist:mac -- --arm64 --dir
```

Long-running (minutes). Wait it out; do not kill Runwa first.

Both expand to `prepare:native:release -- <platform> && electron-vite build
&& electron-builder …`. The prep script removes the generated bindings,
rebuilds the Rust addon with `napi build --platform --release`, and
validates that the packaged `.node` exports what the app needs. **So there
is no separate `npm run build:native` step** — running one beforehand is
wasted work, the prep script deletes that output and rebuilds it. This
holds whether or not anything under `native/src` changed.

### 3. Find what you just built

Cross-check the version against
`node -p "require('./package.json').version"`. If they disagree, the build
ran against a stale version and step 1 was skipped or the hook didn't fire.

**Windows** — `electron-builder.yml` sets
`artifactName: ${productName}-${version}-setup.${ext}`, so the file is
`release\Runwa-<version>-setup.exe`, *not* "Runwa Setup <ver>.exe".

```powershell
$installer = Get-ChildItem release\Runwa-*-setup.exe |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 -ExpandProperty FullName
$installer
```

**macOS** — `--dir` leaves the bundle at `release/mac-<arch>/Runwa.app`
(`release/mac/Runwa.app` for x64). There is no installer to glob for.

```bash
built=release/mac-arm64/Runwa.app
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$built/Contents/Info.plist"
```

### 4. Kill it — now, not earlier

**Windows** — capture the exe path first; the install overwrites that
binary in place.

```powershell
$exe = Get-Process Runwa -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty Path
Stop-Process -Name Runwa -Force -ErrorAction SilentlyContinue
```

If nothing was running, fall back to
`"$env:LOCALAPPDATA\Programs\Runwa\Runwa.exe"`.

**macOS**:

```bash
pkill -f '/Applications/Runwa.app' || true
```

It may not be running — that's fine, continue.

### 5. Install

**Windows** — NSIS is configured `oneClick: false`, `perMachine: false`, so
`/S` performs an unattended per-user install into
`%LOCALAPPDATA%\Programs\Runwa`. A silent install does **not** auto-launch
the app.

```powershell
Start-Process -FilePath $installer -ArgumentList '/S' -Wait
```

**macOS** — replace the bundle wholesale. `ditto` (not `cp`) preserves the
code signature and extended attributes; a partially-overwritten bundle
fails Gatekeeper in ways that read as random crashes.

```bash
rm -rf /Applications/Runwa.app && ditto release/mac-arm64/Runwa.app /Applications/Runwa.app
```

### 6. Relaunch and report

```powershell
Start-Process $exe
```

```bash
open -a /Applications/Runwa.app
```

Report the version just shipped and confirm the process came up. The
version readout in the app is the user's signal that the new build actually
installed, so state it explicitly.

**macOS only:** replacing the bundle normally keeps the user's TCC grants.
`scripts/mac-after-sign.mjs` re-signs with an identifier-based designated
requirement (`designated => identifier "dev.dmitr.runwa"`), so macOS still
recognises the new build as the same app even though ad-hoc signing gives
it a fresh cdhash. Confirm with `codesign -d -r- /Applications/Runwa.app`
if the keyboard remap, palette hotkey or window walker come up dead — a
cdhash-bound DR there means the hook didn't run, and the fix is the hook,
not re-ticking Runwa under System Settings → Privacy & Security → Input
Monitoring / Accessibility.

## Explicitly out of scope

- `cargo test`, `npm run typecheck`, any UI/E2E run
- `git push`
- Cross-OS builds — each platform's `dist:` script must run on that OS
- Full macOS release artifacts (dmg/zip, both arches) — that's `npm run
  dist:mac` with no flags, for shipping, not for this loop
- Code signing for distribution, notarization, auto-update manifests

If a change needs verifying beyond "does it launch and behave", that's a
separate, slower pass — not this one.

## When it fails

Report the failing step with its output rather than silently retrying. The
common ones:

- **`cargo`/`rustc` errors from the prep script** — the addon didn't
  compile. Fix the Rust, then rerun the `dist:` script; there's nothing to
  salvage from a partial run.
- **"Native addon is missing release exports"** — a new `#[napi]` export
  exists in `native/src` but `validateGeneratedPackage`'s required-export
  list or the generated wrapper disagrees. Real failure, not flake.
- **"Cannot build win32 native code on darwin"** (or the reverse) — you
  picked the wrong `dist:` script for the host. See the table above.
- **Nothing in `release/`** — electron-builder failed after the bundle
  step; scroll back for its error rather than globbing harder.
