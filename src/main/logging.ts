import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import util from 'util'

/**
 * File logging for the main process.
 *
 * A packaged build is launched by launchd / Finder / Explorer with stdout and
 * stderr wired to `/dev/null`, so every `console.log` the main process emits
 * is discarded the moment it's written. That made "check the prod logs"
 * unanswerable — the diagnostics the palette already prints (which window was
 * focused, which desktop it thought it was on) only ever existed in a dev
 * terminal, which is precisely where the interesting bugs don't reproduce.
 *
 * This tees the console methods to a rotating file under Electron's `logs`
 * path — `~/Library/Logs/Runwa` on macOS, `%APPDATA%\Runwa\logs` on Windows
 * — while leaving the original console behaviour intact so `npm run dev`
 * still prints to the terminal.
 *
 * Writes are synchronous on purpose. The lines worth having are the ones
 * emitted immediately before a crash or a hang, and a buffered stream drops
 * exactly those. Volume is a handful of lines per palette invocation, so the
 * cost is noise-level.
 */

/** Roll over at 2 MB, keeping one previous generation (`main.log.1`). */
const MAX_BYTES = 2 * 1024 * 1024

let logPath: string | null = null
let bytesWritten = 0

function format(level: string, args: unknown[]): string {
  const parts = args.map((a) =>
    typeof a === 'string' ? a : util.inspect(a, { depth: 4, colors: false })
  )
  return `${new Date().toISOString()} [${level}] ${parts.join(' ')}\n`
}

/** Rotate before the file crosses MAX_BYTES so a long-running session can't
 * fill the disk. One generation is enough: the failure modes we chase show
 * up within a session, not across weeks. */
function rotateIfNeeded(incoming: number): void {
  if (!logPath || bytesWritten + incoming <= MAX_BYTES) return
  try {
    fs.renameSync(logPath, `${logPath}.1`)
  } catch {
    // Previous generation locked / gone — truncating is still better than
    // growing without bound.
  }
  bytesWritten = 0
}

function write(level: string, args: unknown[]): void {
  if (!logPath) return
  try {
    const line = format(level, args)
    const size = Buffer.byteLength(line)
    rotateIfNeeded(size)
    fs.appendFileSync(logPath, line)
    bytesWritten += size
  } catch {
    // Never let logging take down the app — a full disk or a revoked
    // permission on the logs directory must stay invisible to the user.
  }
}

/**
 * Install the console tee. Safe to call once, early — `app.getPath` works
 * before `whenReady`. Must run *after* any `app.setName` call, since the
 * logs directory is derived from the app name (dev builds get their own
 * `Runwa Dev` folder, same as their userData sandbox).
 */
export function initLogging(): void {
  if (logPath) return
  try {
    const dir = app.getPath('logs')
    fs.mkdirSync(dir, { recursive: true })
    logPath = path.join(dir, 'main.log')
    bytesWritten = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0
  } catch (err) {
    // Without a writable log directory we simply stay console-only.
    // eslint-disable-next-line no-console
    console.warn('[logging] file logging unavailable:', err)
    return
  }

  const levels: Array<['log' | 'warn' | 'error' | 'info', string]> = [
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error']
  ]
  for (const [method, level] of levels) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]): void => {
      original(...args)
      write(level, args)
    }
  }

  // Crashes are the single most valuable thing to have on disk, and Electron
  // prints them to the same discarded stderr.
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason)
  })

  console.log(
    `[logging] main.log at ${logPath} (pid=${process.pid}, packaged=${app.isPackaged}, ` +
      `version=${app.getVersion()}, platform=${process.platform})`
  )
}

/** Absolute path of the active log file, or `null` when file logging failed
 * to initialise. Exposed so the UI can point the user at it. */
export function getLogFilePath(): string | null {
  return logPath
}
