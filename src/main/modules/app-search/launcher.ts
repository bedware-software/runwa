import { shell } from 'electron'
import { spawn } from 'child_process'
import type { AppEntry } from './enumerator'

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
 */
export async function launchApp(entry: AppEntry): Promise<boolean> {
  try {
    if (entry.uwpAppId) {
      return launchUwp(entry.uwpAppId)
    }
    if (!entry.filePath) return false
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
