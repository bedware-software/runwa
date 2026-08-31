import { app, shell } from 'electron'
import { spawn } from 'child_process'
import path from 'path'

/**
 * Windows elevation plumbing for everything runwa starts.
 *
 * A child process inherits the launcher's token. runwa itself often runs
 * elevated — it has to, for the keyboard hook and desktop moves to out-rank
 * an elevated foreground window — but nothing it *launches* asked for
 * administrator. Handing our token down is a real defect, not a harmless
 * extra: a Chromium app's profile ends up half-written by a high-integrity
 * process, its single-instance handoff breaks (UIPI drops the window message
 * a medium-integrity launch sends to a high-integrity window, so you get a
 * second instance on the same profile instead of a focused window), and
 * screen capture misbehaves.
 *
 * So while we're elevated, launches actively drop back to the interactive
 * user. Two routes, in order of preference:
 *
 *  1. `launchAsShellUser` — create the process ourselves with a primary
 *     token borrowed from the desktop shell. Wants a real executable, and
 *     gives back a pid and a real error.
 *  2. `openPathAsUser` — hand the target to Explorer, which is already
 *     running as the user. Works for anything the shell can interpret
 *     (folders, documents, .url), at the cost of learning nothing about
 *     whether it worked.
 *
 * The addon resolution mirrors `window-switcher/native.ts` — all the loaders
 * pull the same .node binary and `require` caches it. Every export degrades
 * rather than throws when the loaded binary predates it: a runwa running
 * against an older addon keeps launching things the way it did before.
 */

interface NativeAddon {
  isProcessElevated?(): boolean
  launchAsShellUser?(exe: string, args?: string, cwd?: string): number
  launchElevated?(path: string, args?: string, cwd?: string): void
}

let addon: NativeAddon | null = null
let loadError: Error | null = null

function loadAddon(): NativeAddon {
  if (addon) return addon
  if (loadError) throw loadError

  const nativePath = app.isPackaged
    ? path.join(process.resourcesPath, 'native')
    : path.join(app.getAppPath(), 'native')

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(nativePath) as NativeAddon
    addon = mod
    return mod
  } catch (err) {
    loadError = new Error(
      `Failed to load runwa-native from ${nativePath}. Original error: ${err}`
    )
    throw loadError
  }
}

/** Cached: a token's elevation can't change under a running process. */
let elevated: boolean | null = null

/** Is runwa itself running with an elevated (administrator) token? */
export function isRunwaElevated(): boolean {
  if (elevated !== null) return elevated
  if (process.platform !== 'win32') {
    elevated = false
    return elevated
  }
  try {
    const mod = loadAddon()
    elevated =
      typeof mod.isProcessElevated === 'function' ? mod.isProcessElevated() : false
  } catch (err) {
    console.warn('[elevation] check failed, assuming not elevated:', err)
    elevated = false
  }
  return elevated
}

/**
 * Start `exe` as the plain interactive user. Returns the child's pid, or null
 * when the addon can't do it (older binary, no desktop shell to borrow a
 * token from, `CreateProcessWithToken` refused) — callers fall back to a
 * shell launch.
 */
export function launchAsShellUser(
  exe: string,
  args?: string,
  cwd?: string
): number | null {
  try {
    const mod = loadAddon()
    if (typeof mod.launchAsShellUser !== 'function') {
      console.warn(
        '[elevation] native addon predates launchAsShellUser — apps will keep ' +
          "inheriting runwa's elevation until it is rebuilt"
      )
      return null
    }
    return mod.launchAsShellUser(exe, args, cwd)
  } catch (err) {
    console.warn(`[elevation] launchAsShellUser failed for ${exe}:`, err)
    return null
  }
}

/**
 * Start `target` through the shell's `runas` verb — the per-app "run as
 * administrator" opt-in. Raises a UAC prompt when runwa isn't elevated, and
 * inherits our own elevated token when it is. Returns false when the addon
 * can't do it or the user dismissed the prompt.
 */
export function launchElevated(
  target: string,
  args?: string,
  cwd?: string
): boolean {
  try {
    const mod = loadAddon()
    if (typeof mod.launchElevated !== 'function') {
      console.warn(
        '[elevation] native addon predates launchElevated — "Run as ' +
          'administrator" will fall back to a normal launch until it is rebuilt'
      )
      return false
    }
    mod.launchElevated(target, args, cwd)
    return true
  } catch (err) {
    console.warn(`[elevation] launchElevated failed for ${target}:`, err)
    return false
  }
}

/**
 * `shell.openPath` that doesn't hand our elevation to whatever opens the
 * target. Used for folders and documents — the decks folder, the rules file
 * in the user's editor — where the point is the *handler* runwa is about to
 * start, and an editor opened as administrator is as wrong as an app is.
 *
 * A second `explorer.exe` delegates to the desktop shell already running as
 * the interactive user, which is what de-elevates the launch. Not elevated
 * ourselves, or Explorer wouldn't take it: plain `shell.openPath`, which
 * also reports failures the Explorer route can't.
 */
export async function openPathAsUser(target: string): Promise<void> {
  if (process.platform === 'win32' && isRunwaElevated() && openViaExplorer(target)) {
    return
  }
  const err = await shell.openPath(target)
  if (err) console.warn(`[elevation] openPath failed for ${target}: ${err}`)
}

/** Hand `target` to Explorer. Detached so it outlives runwa. */
export function openViaExplorer(target: string): boolean {
  try {
    const proc = spawn('explorer.exe', [target], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    proc.unref()
    return true
  } catch (err) {
    console.warn(`[elevation] explorer.exe spawn failed for ${target}:`, err)
    return false
  }
}
