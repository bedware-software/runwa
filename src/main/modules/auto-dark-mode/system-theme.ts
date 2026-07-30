import { execFile } from 'node:child_process'
import { app } from 'electron'
import path from 'node:path'
import { isHexColor } from '@shared/auto-dark-mode'

export type SystemTheme = 'light' | 'dark'

export interface SystemThemeOperationOptions {
  signal?: AbortSignal
}

interface NativeThemeAddon {
  getSystemTheme(): string
  setSystemTheme(theme: SystemTheme): void
  setDesktopBackgroundColor(color: string): void
}

const APPLE_SCRIPT_TIMEOUT_MS = 15_000

let addon: NativeThemeAddon | null = null
let addonLoadError: Error | null = null

function loadWindowsAddon(): NativeThemeAddon {
  if (addon) return addon
  if (addonLoadError) throw addonLoadError

  const nativePath = app.isPackaged
    ? path.join(process.resourcesPath, 'native')
    : path.join(app.getAppPath(), 'native')

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require(nativePath) as Partial<NativeThemeAddon>
    if (
      typeof loaded.getSystemTheme !== 'function' ||
      typeof loaded.setSystemTheme !== 'function' ||
      typeof loaded.setDesktopBackgroundColor !== 'function'
    ) {
      throw new Error(
        'native addon is missing getSystemTheme / setSystemTheme / setDesktopBackgroundColor'
      )
    }
    addon = loaded as NativeThemeAddon
    return addon
  } catch (error) {
    addonLoadError = new Error(
      `Failed to load Windows system-theme support from ${nativePath}. ` +
        `Run \`npm run build:native\` for this platform. Original error: ${String(error)}`
    )
    throw addonLoadError
  }
}

const READ_MACOS_THEME_SCRIPT =
  'tell application "System Events" to tell appearance preferences to get dark mode'

const SET_MACOS_THEME_SCRIPT = `
on run argv
  if item 1 of argv is "dark" then
    tell application "System Events" to tell appearance preferences to set dark mode to true
  else
    tell application "System Events" to tell appearance preferences to set dark mode to false
  end if
end run
`.trim()

function runAppleScript(
  script: string,
  args: string[],
  action: string,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`Cancelled before Runwa could ${action}.`))
      return
    }

    execFile(
      '/usr/bin/osascript',
      ['-e', script, '--', ...args],
      {
        encoding: 'utf8',
        timeout: APPLE_SCRIPT_TIMEOUT_MS,
        killSignal: 'SIGTERM',
        signal
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout.trim())
          return
        }

        if (signal?.aborted || error.name === 'AbortError') {
          reject(new Error(`Cancelled while Runwa was trying to ${action}.`))
          return
        }

        const detail = stderr.trim() || error.message
        const timeoutHint =
          (error as NodeJS.ErrnoException & { killed?: boolean }).killed
            ? ` The request exceeded ${APPLE_SCRIPT_TIMEOUT_MS / 1000} seconds.`
            : ''
        const permissionHint =
          detail.includes('-1743') || /not authorized|not permitted/i.test(detail)
            ? ' Allow Runwa to control System Events in System Settings → Privacy & Security → Automation.'
            : ''
        reject(
          new Error(
            `Could not ${action} with /usr/bin/osascript: ${detail}.${timeoutHint}${permissionHint}`
          )
        )
      }
    )
  })
}

export async function getSystemTheme(
  options: SystemThemeOperationOptions = {}
): Promise<SystemTheme> {
  if (options.signal?.aborted) {
    throw new Error('System theme read was cancelled.')
  }

  if (process.platform === 'win32') {
    const theme = loadWindowsAddon().getSystemTheme()
    if (theme === 'light' || theme === 'dark') return theme
    throw new Error(`Windows system-theme support returned an invalid value: ${JSON.stringify(theme)}`)
  }

  if (process.platform === 'darwin') {
    const darkMode = (await runAppleScript(
      READ_MACOS_THEME_SCRIPT,
      [],
      'read the macOS appearance',
      options.signal
    )).toLowerCase()
    if (darkMode === 'true') return 'dark'
    if (darkMode === 'false') return 'light'
    throw new Error(`macOS returned an unexpected dark mode value: ${JSON.stringify(darkMode)}`)
  }

  throw new Error(`System theme control is unsupported on ${process.platform}`)
}

export async function setSystemTheme(
  theme: SystemTheme,
  options: SystemThemeOperationOptions = {}
): Promise<void> {
  if (theme !== 'light' && theme !== 'dark') {
    throw new Error(`Invalid system theme: ${JSON.stringify(theme)}`)
  }
  if (options.signal?.aborted) {
    throw new Error('System theme change was cancelled.')
  }

  if (process.platform === 'win32') {
    loadWindowsAddon().setSystemTheme(theme)
    return
  }

  if (process.platform === 'darwin') {
    await runAppleScript(
      SET_MACOS_THEME_SCRIPT,
      [theme],
      `set the macOS appearance to ${theme}`,
      options.signal
    )
    return
  }

  throw new Error(`System theme control is unsupported on ${process.platform}`)
}

export async function setWindowsDesktopBackgroundColor(
  color: string,
  options: SystemThemeOperationOptions = {}
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error(
      `Desktop background color control is unsupported on ${process.platform}`
    )
  }
  if (!isHexColor(color)) {
    throw new Error(
      `Invalid desktop background color: ${JSON.stringify(color)}`
    )
  }
  if (options.signal?.aborted) {
    throw new Error('Desktop background color change was cancelled.')
  }

  loadWindowsAddon().setDesktopBackgroundColor(color)
}
