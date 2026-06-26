import { app } from 'electron'
import { spawn, spawnSync } from 'child_process'

/**
 * "Start at login" + "Run as administrator" toggles in the General
 * settings panel. Both only take effect for packaged installs — in dev
 * we'd be registering `node_modules/electron/dist/electron.exe` with the
 * OS, which would also affect every other Electron-based tool on the
 * machine. The settings UI disables both toggles when `app.isPackaged`
 * is false; this module double-checks the same flag before applying so
 * a hand-edited settings.json can't leak dev paths into the registry.
 *
 * Why this is a matrix and not two independent switches: on Windows the
 * HKCU `Run` key and an elevation requirement are mutually exclusive.
 * Windows runs `Run`-key entries under the logon shell's *filtered*
 * (non-elevated) token and will not raise a UAC consent prompt during
 * the silent logon sequence, so a `Run` entry that points at a
 * RUNASADMIN-flagged exe is simply dropped — "start at login" appears to
 * do nothing the instant "run as admin" is also on. The supported way to
 * auto-start an elevated process at logon *without* a prompt is a
 * scheduled task with "highest privileges"; that's what the both-on case
 * uses in place of the `Run` key.
 */

const RUN_AS_ADMIN_REG_PATH =
  'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'
const RUN_AS_ADMIN_VALUE = '~ RUNASADMIN'

/** Name of the scheduled task that auto-starts runwa elevated at logon. */
const STARTUP_TASK_NAME = 'Runwa-Startup'

export interface StartupSettings {
  startAtLogin: boolean
  runAsAdmin: boolean
}

interface DesiredState {
  /** HKCU\...\Run entry — non-elevated autostart. */
  runKey: boolean
  /** RUNASADMIN AppCompat flag — elevate (with prompt) on manual launch. */
  runAsAdminFlag: boolean
  /** Elevated logon scheduled task — silent elevated autostart. */
  scheduledTask: boolean
}

/**
 * Map the two user-facing toggles onto the three OS mechanisms.
 *
 *   startAtLogin · runAsAdmin → mechanism(s)
 *   ─────────────────────────────────────────────────────────────
 *   off · off  →  (nothing)
 *   on  · off  →  Run key
 *   off · on   →  RUNASADMIN flag (UAC prompt on every manual launch)
 *   on  · on   →  RUNASADMIN flag  +  scheduled task, and NOT the Run
 *                 key (a Run entry to an elevated exe is dropped at logon)
 */
function computeDesiredState(s: StartupSettings): DesiredState {
  return {
    runKey: s.startAtLogin && !s.runAsAdmin,
    runAsAdminFlag: s.runAsAdmin,
    scheduledTask: s.startAtLogin && s.runAsAdmin
  }
}

/**
 * Toggle OS login-item registration. Electron handles the platform
 * split internally: Windows writes `HKCU\...\Run`, macOS writes a
 * LoginItem entry. Linux is a no-op (Electron doesn't ship a generic
 * Linux autostart writer).
 */
function applyRunKey(enabled: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      // Start hidden — runwa is a tray-only launcher. No point
      // surfacing a window the user didn't ask for on boot. (macOS-only
      // flag; on Windows runwa already comes up tray-only.)
      openAsHidden: enabled
    })
  } catch (err) {
    console.warn('[startup] setLoginItemSettings failed:', err)
  }
}

/**
 * Toggle the Windows AppCompat `RUNASADMIN` flag on our executable's
 * path. Persists in the current user's registry hive — no elevation
 * required to write. Takes effect the next time the user launches runwa
 * *manually* (Start menu / tray): Windows sees the flag, raises the UAC
 * prompt, and the relaunched process comes up elevated. The scheduled
 * task (when present) already launches elevated, so the flag is a no-op
 * on that path — no double prompt.
 *
 * No-op on non-Windows platforms (macOS / Linux have no equivalent).
 */
function applyRunAsAdminFlag(enabled: boolean): void {
  if (process.platform !== 'win32') return
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
    console.warn('[startup] applyRunAsAdminFlag threw:', err)
  }
}

/**
 * Does our logon scheduled task already exist? `schtasks /Query` needs
 * no elevation (the task lives in the root folder, readable by the
 * Users group), so this is a cheap reconciliation check we can run on
 * every settings change without prompting.
 */
function scheduledTaskExists(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const result = spawnSync(
      'schtasks.exe',
      ['/Query', '/TN', STARTUP_TASK_NAME],
      { windowsHide: true, timeout: 5000 }
    )
    return result.status === 0
  } catch {
    return false
  }
}

/** Wrap a value as a single-quoted PowerShell string literal, doubling
 *  any embedded single quotes (e.g. a path under `C:\Users\O'Brien`). */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** The `DOMAIN\User` (or `MACHINE\User`) of the current interactive
 *  account, used for both the logon trigger and the task principal. */
function currentAccount(): string {
  const domain = process.env.USERDOMAIN || process.env.COMPUTERNAME || ''
  return `${domain}\\${process.env.USERNAME ?? ''}`
}

/**
 * Run a PowerShell snippet elevated. We base64-encode the inner script
 * (`-EncodedCommand`) so it survives the two process hops — Node →
 * launcher PowerShell → elevated PowerShell — without any quoting hazard
 * from paths with spaces. The launcher shell uses
 * `Start-Process -Verb RunAs`, which raises exactly one UAC prompt (or
 * none, if runwa is already elevated). Resolves with the elevated
 * process's exit code; never rejects.
 */
function runElevatedPowerShell(innerScript: string): Promise<number> {
  const encoded = Buffer.from(innerScript, 'utf16le').toString('base64')
  const launcher = `$p = Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-EncodedCommand','${encoded}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`
  return new Promise((resolve) => {
    try {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          launcher
        ],
        { windowsHide: true }
      )
      child.on('error', (err) => {
        console.warn('[startup] elevated powershell spawn failed:', err.message)
        resolve(-1)
      })
      child.on('exit', (code) => resolve(code ?? -1))
    } catch (err) {
      console.warn('[startup] runElevatedPowerShell threw:', err)
      resolve(-1)
    }
  })
}

/**
 * Register (or overwrite) the elevated logon task. Needs one UAC OK.
 *
 * Built with the `New-ScheduledTask*` cmdlets rather than raw task XML —
 * the cmdlets construct valid CIM objects, sidestepping the strict
 * element-ordering and schema-version rules that make hand-written task
 * XML brittle. A logon trigger + principal scoped to the current
 * interactive user, run with the *highest available* token (elevated for
 * admin accounts) in the user's desktop session; `Interactive` logon
 * type means no stored password is needed.
 */
async function registerScheduledTask(): Promise<void> {
  const exe = psLiteral(process.execPath)
  const account = psLiteral(currentAccount())
  const inner = `$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute ${exe}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ${account}
$principal = New-ScheduledTaskPrincipal -UserId ${account} -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '${STARTUP_TASK_NAME}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`
  const code = await runElevatedPowerShell(inner)
  if (code !== 0) {
    console.warn(
      `[startup] scheduled-task registration exited ${code} (user may have declined UAC)`
    )
  }
}

/** Remove the elevated logon task. Needs one UAC OK. */
async function removeScheduledTask(): Promise<void> {
  const inner = `$ErrorActionPreference = 'SilentlyContinue'
Unregister-ScheduledTask -TaskName '${STARTUP_TASK_NAME}' -Confirm:$false`
  const code = await runElevatedPowerShell(inner)
  if (code !== 0) {
    console.warn(`[startup] scheduled-task removal exited ${code}`)
  }
}

/** Tracks the last applied startup state so unrelated settings changes
 *  (theme, hotkeys, …) don't re-run the schtasks reconcile. */
let lastApplied: StartupSettings | null = null

/**
 * Reconcile run once on launch. Applies only the HKCU-scoped mechanisms
 * (Run key + RUNASADMIN flag) — both write the current user's hive with
 * no elevation and no prompt. The elevated scheduled task is left
 * untouched here on purpose: re-creating it needs a UAC prompt, and
 * prompting on every login would be hostile. We assume the task is
 * already in whatever state the user last chose via the toggle.
 */
export function reconcileStartupOnLaunch(settings: StartupSettings): void {
  if (!app.isPackaged) return
  const desired = computeDesiredState(settings)
  applyRunKey(desired.runKey)
  applyRunAsAdminFlag(desired.runAsAdminFlag)
  lastApplied = { ...settings }
}

/**
 * Full reconcile in response to a user-initiated settings change. Does
 * the same HKCU writes as the launch path, then brings the elevated
 * scheduled task into line — which may raise a single UAC prompt
 * (expected: the user just flipped a toggle). Idempotent: bails when
 * neither startup toggle changed, and only touches the task when its
 * presence actually differs from desired, so flipping the theme never
 * spawns a prompt.
 */
export async function applyStartupChange(
  settings: StartupSettings
): Promise<void> {
  if (!app.isPackaged) return
  if (
    lastApplied &&
    lastApplied.startAtLogin === settings.startAtLogin &&
    lastApplied.runAsAdmin === settings.runAsAdmin
  ) {
    return
  }
  lastApplied = { ...settings }

  const desired = computeDesiredState(settings)
  applyRunKey(desired.runKey)
  applyRunAsAdminFlag(desired.runAsAdminFlag)

  if (process.platform !== 'win32') return
  const exists = scheduledTaskExists()
  if (desired.scheduledTask && !exists) {
    await registerScheduledTask()
  } else if (!desired.scheduledTask && exists) {
    await removeScheduledTask()
  }
}
