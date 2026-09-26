import { spawn } from 'node:child_process'
import { desktopHintWindow } from '../../desktop-hint-window'

/**
 * Power-command driver behind the palette's OS group — shut down,
 * restart, sleep, hibernate — each run through the platform's stock tool
 * so it behaves like the OS's own menu entry:
 *
 * macOS: System Events `shut down` / `restart`, the graceful path the
 *   Apple menu takes minus its confirmation dialog (the palette asks
 *   instead): apps are asked to quit, and one with unsaved changes can
 *   still cancel. The dialog's "Reopen windows when logging back in"
 *   checkbox becomes PowerOptions.reopenWindows — see macSessionEndArgs.
 *   Sleep is `pmset sleepnow`. No hibernate — macOS has no per-request
 *   hibernate, only the global `hibernatemode`, which needs root and
 *   changes every later sleep too.
 *
 * Windows: `shutdown.exe` for shut down / restart / hibernate — `/s` and
 *   `/r` start clean, `/sg` and `/g` restart the registered apps after
 *   sign-in (the "Restart apps" behaviour). Sleep calls SetSuspendState
 *   through PowerShell rather than the often-quoted
 *   `rundll32 powrprof.dll,SetSuspendState`, which hibernates instead of
 *   sleeping whenever hibernation is enabled.
 *
 * Linux: `systemctl poweroff | reboot | suspend | hibernate` (logind).
 *   Session restore is the desktop environment's business, so there's no
 *   reopen-windows choice here.
 */

export type PowerCommand = 'shutdown' | 'restart' | 'sleep' | 'hibernate'

export interface PowerOptions {
  /** Shut down / Restart: bring back the apps and windows that were open
   * once the user logs back in. False is a clean start. Ignored by the
   * other commands and on Linux. */
  reopenWindows: boolean
}

const DESKTOP_HINT_SOURCE = 'command-palette-power'
const ERROR_HINT_DURATION_MS = 3000

const LABELS: Record<PowerCommand, string> = {
  shutdown: 'Shut down',
  restart: 'Restart',
  sleep: 'Sleep',
  hibernate: 'Hibernate'
}

interface Invocation {
  file: string
  args: string[]
}

/**
 * osascript arguments for a macOS shut down / restart. System Events saves
 * the session — every open app relaunched at the next login — unless given
 * `state saving preference true`, which defers to the user's own "Reopen
 * windows when logging back in" choice instead (loginwindow's
 * TALLogoutSavesState, the checkbox's remembered value). There is no
 * "never save" flag, so a clean start first writes that preference off —
 * the same thing unticking the box in the OS dialog does, which is also
 * why that dialog comes up unticked from then on.
 */
function macSessionEndArgs(
  verb: 'shut down' | 'restart',
  reopenWindows: boolean
): string[] {
  if (reopenWindows) {
    return ['-e', `tell application "System Events" to ${verb}`]
  }
  return [
    '-e',
    'do shell script "defaults write com.apple.loginwindow TALLogoutSavesState -bool false"',
    '-e',
    `tell application "System Events" to ${verb} state saving preference true`
  ]
}

function invocationFor(
  command: PowerCommand,
  { reopenWindows }: PowerOptions
): Invocation | null {
  if (process.platform === 'darwin') {
    switch (command) {
      case 'shutdown':
        return {
          file: 'osascript',
          args: macSessionEndArgs('shut down', reopenWindows)
        }
      case 'restart':
        return {
          file: 'osascript',
          args: macSessionEndArgs('restart', reopenWindows)
        }
      case 'sleep':
        return { file: 'pmset', args: ['sleepnow'] }
      case 'hibernate':
        return null
    }
  }
  if (process.platform === 'win32') {
    switch (command) {
      case 'shutdown':
        return {
          file: 'shutdown.exe',
          args: [reopenWindows ? '/sg' : '/s', '/t', '0']
        }
      case 'restart':
        return {
          file: 'shutdown.exe',
          args: [reopenWindows ? '/g' : '/r', '/t', '0']
        }
      case 'hibernate':
        return { file: 'shutdown.exe', args: ['/h'] }
      case 'sleep':
        return {
          file: 'powershell.exe',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"
          ]
        }
    }
  }
  if (process.platform === 'linux') {
    const verb: Record<PowerCommand, string> = {
      shutdown: 'poweroff',
      restart: 'reboot',
      sleep: 'suspend',
      hibernate: 'hibernate'
    }
    return { file: 'systemctl', args: [verb[command]] }
  }
  return null
}

/** Whether this platform has a way to run `command` at all. Unsupported
 * commands are left out of the palette and its settings entirely. */
export function powerCommandSupported(command: PowerCommand): boolean {
  return invocationFor(command, { reopenWindows: false }) !== null
}

/** Whether Shut down / Restart here can choose between a clean start and
 * reopening the open windows (PowerOptions.reopenWindows). */
export function reopenWindowsSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
}

/**
 * Run `command`. Fire-and-forget: a failure (Automation permission denied
 * on macOS, hibernation turned off on Windows, logind refusing on Linux)
 * is logged with the tool's stderr and reported through the Desktop Hint,
 * since the palette is already gone by the time the tool exits.
 */
export function runPowerCommand(
  command: PowerCommand,
  options: PowerOptions
): void {
  const invocation = invocationFor(command, options)
  if (!invocation) return

  const fail = (detail: unknown): void => {
    console.warn(`[command-palette] ${command} failed:`, detail)
    desktopHintWindow.show({
      source: DESKTOP_HINT_SOURCE,
      message: `${LABELS[command]} failed`,
      durationMs: ERROR_HINT_DURATION_MS
    })
  }

  try {
    const proc = spawn(invocation.file, invocation.args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    proc.stderr?.on('data', (c) => (stderr += c.toString()))
    proc.on('close', (code) => {
      if (code !== 0) fail(`exit ${code}: ${stderr.trim()}`)
    })
    proc.on('error', fail)
  } catch (err) {
    fail(err)
  }
}
