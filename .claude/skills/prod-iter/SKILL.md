---
name: prod-iter
description: Fast local install of Runwa for manual iteration — commit/push, build native (host arch, release), build the Electron bundle, package an unpacked .app, and reinstall it into /Applications. Skips all tests (unit and UI) by design. Trigger on "prod iter", "PROD ITER", or a request to get the current changes installed/running as fast as possible.
user-invocable: true
allowed-tools:
  - Bash
---

# PROD ITER

Fastest path from a dirty working tree to a running, locally-installed
build of Runwa. Optimized for speed, not confidence: **never run
`cargo test`, never run any UI/E2E test** as part of this skill, even if
asked to "verify" — that's a separate, slower pass the user does
deliberately, not something this skill does implicitly.

Host-arch only (no universal binary, no dmg/zip/blockmap, no
notarization) — that's what `npm run dist:mac` is for, not this.

Run every step from the repo root. Stop and report if any step fails —
don't skip ahead.

## Steps

0. **Commit and push whatever's dirty.** Check `git status --short`. If
   it's non-empty:
   - `git add -A`
   - Write a real commit message describing the actual diff (read it
     first) — don't use a placeholder.
   - `git commit -m "<message>"`
   - `git push origin "$(git rev-parse --abbrev-ref HEAD)"`

   Note: this repo's pre-commit hook auto-bumps the patch version in
   `package.json`/`package-lock.json` and stages both — that's expected,
   not something to undo or re-stage yourself.

   If `git status --short` is empty, skip straight to step 1.

1. **Stop any running dev instance.** A `electron-vite dev` /
   `electron-vite preview` process installs the same global keyboard
   hook and hotkeys as the installed app. Leaving it up causes
   duplicate remaps and "hotkey already registered" failures once the
   installed app launches.

   ```bash
   pkill -f "electron-vite preview"
   pkill -f "node_modules/electron/dist/Electron.app"
   ```

2. **Build the native addon, release profile, host arch only.**

   ```bash
   npm run build:native
   ```

   Not `npm run prepare:native:release` — that cross-builds x64 *and*
   arm64 and lipo's them into a universal binary, which the packaged
   release needs but a local loop doesn't.

3. **Build the Electron/Vite bundle.**

   ```bash
   npm run build
   ```

4. **Package an unpacked `.app` for the host architecture** — skips
   dmg/zip creation, blockmap generation, and notarization, so it's
   seconds instead of minutes. Still goes through electron-builder's
   ad-hoc sign + the `afterSign` re-stamp, so Gatekeeper/entitlements
   behave like a real build.

   ```bash
   ARCH=$(test "$(uname -m)" = arm64 && echo arm64 || echo x64)
   node --disable-warning=DEP0190 node_modules/electron-builder/cli.js --mac --$ARCH --dir
   ```

   Output: `release/mac-$ARCH/Runwa.app`

5. **Install it** — quit the currently-installed app, replace it,
   relaunch.

   ```bash
   osascript -e 'tell application "Runwa" to quit' 2>/dev/null
   pkill -f "/Applications/Runwa.app" 2>/dev/null
   rm -rf /Applications/Runwa.app
   cp -R "release/mac-$ARCH/Runwa.app" /Applications/Runwa.app
   open /Applications/Runwa.app
   ```

6. Report the installed version (`plutil -p /Applications/Runwa.app/Contents/Info.plist | grep CFBundleShortVersion`) and confirm it launched (process visible via `ps aux | grep "/Applications/Runwa.app"`).

## Explicitly out of scope

- `cargo test` (native/Rust unit tests)
- Any UI/E2E test run
- Windows/Linux builds
- The other host architecture (no universal binary)
- dmg/zip/blockmap artifacts, code-signing for distribution,
  notarization, auto-update manifest (`latest-mac.yml`)

If a change needs verifying beyond "does it run," that's a separate,
slower pass — not this one.
