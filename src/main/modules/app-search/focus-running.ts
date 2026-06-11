import { shell } from 'electron'
import path from 'path'
import type { AppEntry } from './enumerator'
import {
  focusWindow,
  invalidateCache,
  listWindowsCached,
  type NativeWindow
} from '../window-switcher/native'

/**
 * macOS-style activation for App Search on Windows: if the selected app
 * already has a window open, focus that window instead of spawning a second
 * instance. macOS gets this for free — LaunchServices activates the running
 * instance when `shell.openPath` hits an already-open .app bundle — so this
 * file only ever does work on win32 and every other platform falls straight
 * through to the normal launch path.
 *
 * Matching an installed entry to a running window goes through the process
 * identity behind each side:
 *  - `.exe` entries compare their own path against the window's
 *    `executablePath` (full-path, case-insensitive — basename-only matching
 *    could focus an unrelated app that happens to share an exe name).
 *  - `.lnk` entries resolve their target via `shell.readShortcutLink` first.
 *    Squirrel-packaged apps (Discord, GitHub Desktop, …) point the shortcut
 *    at a versioned `Update.exe --processStart <App.exe>` launcher, so path
 *    equality can never hit — those match on the `--processStart` basename
 *    instead. Any other shortcut that carries arguments is treated as a
 *    launch recipe rather than an app identity and never matches (see the
 *    comment in `buildWindowMatcher`).
 *  - UWP entries prefix-match the window exe against the package's install
 *    location. Works because the native window list pivots
 *    ApplicationFrameHost frames to the hosted app's real process.
 *  - `.url` / `.appref-ms` have no resolvable process identity → no match,
 *    plain launch.
 *
 * A failed match (or failed focus) is never an error — the caller just
 * launches normally, which is exactly what the palette did before this
 * feature existed.
 */

type WindowMatcher = (w: NativeWindow) => boolean

export function tryFocusRunningInstance(entry: AppEntry): boolean {
  if (process.platform !== 'win32') return false

  const matches = buildWindowMatcher(entry)
  if (!matches) return false

  // Prefer a window on the current desktop so a Chrome here wins over a
  // Chrome parked on desktop 3. Both lists come back in Z-order (topmost
  // first), so the first hit is the most recently used window — the same
  // window macOS would raise on a Dock click. Falling back to the
  // all-desktops list and calling SetForegroundWindow on a window that
  // lives elsewhere makes Windows switch to that desktop, which is the
  // asked-for "focus it wherever it is" behavior.
  const ownPid = process.pid
  const candidate =
    listWindowsCached(true, true).find((w) => w.pid !== ownPid && matches(w)) ??
    listWindowsCached(false, true).find((w) => w.pid !== ownPid && matches(w))
  if (!candidate) return false

  try {
    const ok = focusWindow(candidate.id)
    // false = the window vanished between listing and focus (or the
    // foreground lock refused us). Drop the window cache and let the
    // caller launch a fresh instance instead.
    if (!ok) invalidateCache()
    return ok
  } catch (err) {
    console.warn('[app-search] focus running instance failed', err)
    return false
  }
}

function buildWindowMatcher(entry: AppEntry): WindowMatcher | null {
  if (entry.uwpAppId) {
    if (!entry.installLocation) return null
    const prefix = normPath(entry.installLocation) + path.sep
    return (w) =>
      !!w.executablePath && normPath(w.executablePath).startsWith(prefix)
  }

  if (!entry.filePath) return null
  const ext = path.extname(entry.filePath).toLowerCase()

  if (ext === '.exe') {
    return exePathMatcher(entry.filePath)
  }

  if (ext === '.lnk') {
    let target = ''
    let args = ''
    try {
      const link = shell.readShortcutLink(entry.filePath)
      target = link.target ?? ''
      args = link.args ?? ''
    } catch {
      // Advertised MSI shortcuts and other exotic .lnk flavors that
      // readShortcutLink can't parse — shell.openPath still launches them.
      return null
    }
    const squirrelExe = squirrelProcessStartExe(target, args)
    if (squirrelExe) {
      const name = squirrelExe.toLowerCase()
      return (w) =>
        !!w.executablePath &&
        path.basename(w.executablePath).toLowerCase() === name
    }
    // A shortcut with arguments is a launch *recipe*, not an app identity —
    // the target exe alone doesn't say what the user gets. Real Start Menu
    // examples where target-matching would focus the wrong thing instead of
    // running the recipe: `explorer.exe "<SDK folder>"` (folder shortcut →
    // would focus any File Explorer window), `cmd.exe /k vcvars64.bat` (VS
    // dev prompt → any cmd window), `vlc.exe --reset-config` (reset shortcut
    // → a running VLC). Falling through to a plain launch preserves the
    // pre-feature behavior for all of these.
    if (args.trim().length > 0) {
      return null
    }
    if (target.toLowerCase().endsWith('.exe')) {
      return exePathMatcher(target)
    }
    return null
  }

  return null
}

function exePathMatcher(exePath: string): WindowMatcher {
  const target = normPath(exePath)
  return (w) => !!w.executablePath && normPath(w.executablePath) === target
}

function normPath(p: string): string {
  return path.normalize(p).toLowerCase()
}

/**
 * Detect a Squirrel launcher shortcut: target is `Update.exe` and the
 * arguments name the real app exe via `--processStart`. Returns that exe's
 * basename, or null when the shortcut isn't Squirrel-shaped.
 */
function squirrelProcessStartExe(target: string, args: string): string | null {
  if (path.basename(target).toLowerCase() !== 'update.exe') return null
  const m = /--processStart(?:[=\s]+)"?([^"\s]+\.exe)"?/i.exec(args)
  return m?.[1] ? path.basename(m[1]) : null
}
