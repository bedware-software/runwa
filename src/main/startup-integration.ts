import { app } from 'electron'
import { spawnSync } from 'child_process'

/**
 * "Start at login" + "Run as administrator" toggles in the General
 * settings panel. Both only take effect for packaged installs — in dev
 * we'd be registering `node_modules/electron/dist/electron.exe` with the
 * OS, which would also affect every other Electron-based tool on the
 * machine. The settings UI disables both toggles when `app.isPackaged`
 * is false; this module double-checks the same flag before applying so
 * a hand-edited settings.json can't leak dev paths into the registry.
 */

const RUN_AS_ADMIN_REG_PATH =
  'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'
const RUN_AS_ADMIN_VALUE = '~ RUNASADMIN'

/**
 * Toggle OS login-item registration. Electron handles the platform
 * split internally: Windows writes `HKCU\...\Run`, macOS writes a
 * LoginItem entry. Linux is a no-op (Electron doesn't ship a generic
 * Linux autostart writer).
 */
export function applyStartAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      // Start hidden — runwa is a tray-only launcher. No point
      // surfacing a window the user didn't ask for on boot.
      openAsHidden: enabled
    })
  } catch (err) {
    console.warn('[startup] setLoginItemSettings failed:', err)
  }
}

/**
 * Toggle the Windows AppCompat `RUNASADMIN` flag on our executable's
 * path. Persists in the current user's registry hive — no elevation
 * required to write. Takes effect the next time the user launches
 * runwa (from Start Menu / tray / auto-start): Windows sees the flag,
 * raises the UAC prompt, and the relaunched process comes up elevated.
 *
 * No-op on non-Windows platforms (macOS / Linux have no equivalent
 * concept) and in unpackaged dev runs (we'd be elevating the system's
 * dev-mode electron.exe — wrong scope).
 */
export function applyRunAsAdmin(enabled: boolean): void {
  if (process.platform !== 'win32') return
  if (!app.isPackaged) return
  const exe = process.execPath
  const args = enabled
    ? [
        'add',
        RUN_AS_ADMIN_REG_PATH,
        '/v',
        exe,
        '/t',
        'REG_SZ',
        '/d',
        RUN_AS_ADMIN_VALUE,
        '/f'
      ]
    : ['delete', RUN_AS_ADMIN_REG_PATH, '/v', exe, '/f']
  try {
    const result = spawnSync('reg.exe', args, {
      windowsHide: true,
      timeout: 5000
    })
    if (result.error) {
      console.warn('[startup] reg.exe spawn failed:', result.error.message)
      return
    }
    // `reg delete` returns exit code 1 when the value was already
    // absent — that's the desired end state for us, so swallow it.
    if (result.status !== 0 && !(enabled === false && result.status === 1)) {
      console.warn(
        `[startup] reg.exe exited ${result.status}: ${result.stderr.toString().trim()}`
      )
    }
  } catch (err) {
    console.warn('[startup] applyRunAsAdmin threw:', err)
  }
}

/** Apply both toggles from the current Settings snapshot. */
export function syncStartupIntegrations(settings: {
  startAtLogin: boolean
  runAsAdmin: boolean
}): void {
  applyStartAtLogin(settings.startAtLogin)
  applyRunAsAdmin(settings.runAsAdmin)
}
