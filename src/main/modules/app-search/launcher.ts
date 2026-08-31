import { shell } from 'electron'
import { spawn } from 'child_process'
import path from 'path'
import type { AppEntry } from './enumerator'
import {
  isRunwaElevated,
  launchAsShellUser,
  launchElevated,
  openViaExplorer
} from '../../elevation'

/**
 * Launch an installed app and detach. Returns true on success. All paths:
 *
 *  - Windows, filePath (.lnk, .exe, .url, .appref-ms): shell.openPath —
 *    Electron hands off to the shell, which resolves .lnk to the real
 *    target + working dir, honors runas verbs, etc.
 *  - Windows, uwpAppId (AUMID): shell out to `explorer.exe shell:AppsFolder\<AUMID>`.
 *    This is the documented way to launch a UWP/AppX app by identifier
 *    (Get-StartApps hands us exactly the AppIDs explorer.exe expects).
 *  - macOS, filePath (.app bundle): shell.openPath — LaunchServices handles
 *    the bundle launch and all the usual macOS niceties (Gatekeeper,
 *    document restoration, etc.).
 *
 * ── Elevation ──────────────────────────────────────────────────────────────
 * A child inherits the launcher's token, so while runwa runs elevated (which
 * it must, for its hooks to out-rank an elevated foreground window) every app
 * started through `shell.openPath` would come up as administrator. That's not
 * a harmless extra: a Chromium app's profile ends up half-written by a
 * high-integrity process, its single-instance handoff breaks because UIPI
 * drops the window message a medium-IL launch sends, and screen sharing
 * misbehaves. So on Windows the normal path actively drops back to the
 * interactive user, and `asAdmin` is the explicit opt-in for the handful of
 * apps that genuinely want the elevated token.
 */
export async function launchApp(
  entry: AppEntry,
  options: { asAdmin?: boolean } = {}
): Promise<boolean> {
  try {
    if (entry.uwpAppId) {
      // UWP packages always run as the interactive user — there is no
      // elevated flavour of an AppX activation, and explorer.exe hands the
      // request to the shell either way, so `asAdmin` has nothing to act on.
      return launchUwp(entry.uwpAppId)
    }
    if (!entry.filePath) return false

    if (process.platform === 'win32') {
      if (options.asAdmin) return launchWindowsElevated(entry.filePath)
      if (isRunwaElevated() && launchWindowsAsUser(entry.filePath)) return true
    }

    const err = await shell.openPath(entry.filePath)
    if (err) {
      console.warn(`[app-search] shell.openPath failed for ${entry.filePath}: ${err}`)
      return false
    }
    return true
  } catch (err) {
    console.warn(`[app-search] launch failed`, err)
    return false
  }
}

function launchUwp(aumid: string): boolean {
  try {
    // detached + unref so our process isn't the parent of the spawned app —
    // if runwa quits, the app keeps running. stdio ignored for the same
    // reason (no lingering pipes).
    const proc = spawn('explorer.exe', [`shell:AppsFolder\\${aumid}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    proc.unref()
    return true
  } catch (err) {
    console.warn(`[app-search] explorer.exe spawn failed for ${aumid}:`, err)
    return false
  }
}

/**
 * Windows, elevated runwa, normal launch: create the process with a token
 * borrowed from the desktop shell so the app comes up as the plain user.
 *
 * `CreateProcessWithToken` takes an executable, not a shell target, so a
 * `.lnk` is resolved first — that also recovers the arguments and working
 * directory the shortcut carries, which the shell would otherwise have
 * applied for us. Anything that isn't ultimately an .exe (`.url`,
 * `.appref-ms`, an advertised MSI shortcut, a shortcut aimed at a document)
 * needs the shell to interpret it, so those hand off to Explorer instead —
 * still de-elevated, since the desktop Explorer that ends up doing the work
 * runs as the user.
 *
 * Returns false when neither route worked; the caller then falls back to
 * `shell.openPath`, which launches the app elevated. That's the pre-existing
 * behaviour, and launching the app beats not launching it.
 */
function launchWindowsAsUser(filePath: string): boolean {
  const resolved = resolveExecutable(filePath)
  if (resolved) {
    const pid = launchAsShellUser(resolved.exe, resolved.args, resolved.cwd)
    if (pid !== null) return true
  }
  // Explorer already runs as the user, so handing it the target de-elevates
  // too — at the cost of learning nothing about whether the app started.
  // That's why it's the fallback rather than the main road.
  return openViaExplorer(filePath)
}

/** Windows: "Run as administrator" for an app the user opted in for. */
function launchWindowsElevated(filePath: string): boolean {
  // The `runas` verb only means something for an executable target; for
  // everything else there is nothing to elevate, so those fall through to
  // the caller's plain shell launch.
  const ext = path.extname(filePath).toLowerCase()
  if (ext !== '.exe' && ext !== '.lnk') return false
  return launchElevated(filePath)
}

/**
 * Resolve a launch target to the executable behind it. `.lnk` shortcuts go
 * through `shell.readShortcutLink` — the same call `focus-running.ts` uses to
 * identify an entry — and keep their arguments and working directory.
 */
function resolveExecutable(
  filePath: string
): { exe: string; args?: string; cwd?: string } | null {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.exe') return { exe: filePath, cwd: path.dirname(filePath) }
  if (ext !== '.lnk') return null

  try {
    const link = shell.readShortcutLink(filePath)
    const target = link.target ?? ''
    if (!target.toLowerCase().endsWith('.exe')) return null
    return {
      exe: target,
      args: link.args,
      // Shortcuts often leave "Start in" empty; the target's own folder is
      // what Explorer falls back to, and some apps depend on it.
      cwd: link.cwd || path.dirname(target)
    }
  } catch {
    // Advertised MSI shortcuts and other exotic .lnk flavors that
    // readShortcutLink can't parse — Explorer still launches them.
    return null
  }
}
