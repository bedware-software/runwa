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
 *
 * Everything below the tee is written on the assumption that logging must
 * never be able to hurt the process it instruments. That isn't defensive
 * style for its own sake — the first version of this file could take the
 * whole desktop down. See `logFatal`.
 */

/** Roll over at 2 MB, keeping one previous generation (`main.log.1`). */
const MAX_BYTES = 2 * 1024 * 1024

/**
 * How many suppressed repeats of an identical line before one notice says
 * the repetition is still going.
 *
 * A log storm is a real failure mode here, not a hypothetical: 4 MB of
 * identical stack traces in 1.2 seconds, rotating the file twice on the way.
 * Collapsing consecutive duplicates keeps the disk and the machine's I/O
 * budget out of it, while still leaving evidence in a log that ends abruptly
 * because the process died mid-loop.
 */
const REPEAT_NOTICE_EVERY = 500

let logPath: string | null = null
let bytesWritten = 0

/**
 * Whether the real stdout/stderr can still be written to.
 *
 * A GUI app inherits whatever handles its launcher hands it. Start Runwa from
 * a terminal, or from a script whose shell then exits, and stdout is a pipe
 * with nobody on the other end: every write fails with EPIPE from then on.
 * The first failure flips this and the tee stops touching the streams — a
 * dead pipe should cost one log line, not one exception per `console.log`
 * for the rest of the session.
 */
let stdioAlive = true

/** Captured at install time so the fatal handler can echo without going back
 * through the patched `console`. */
let originalError: ((...args: unknown[]) => void) | null = null

/** Consecutive-duplicate state for the storm collapse. */
let lastMessage: string | null = null
let suppressedRepeats = 0

/** Re-entrancy guard for the fatal handlers. See `logFatal`. */
let handlingFatal = false

function format(args: unknown[]): string {
  const parts = args.map((a) =>
    typeof a === 'string' ? a : util.inspect(a, { depth: 4, colors: false })
  )
  return parts.join(' ')
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

/** Put one line on disk. The only place that touches the file. */
function emit(level: string, message: string): void {
  if (!logPath) return
  try {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`
    const size = Buffer.byteLength(line)
    rotateIfNeeded(size)
    fs.appendFileSync(logPath, line)
    bytesWritten += size
  } catch {
    // Never let logging take down the app — a full disk or a revoked
    // permission on the logs directory must stay invisible to the user.
  }
}

function write(level: string, args: unknown[]): void {
  if (!logPath) return

  let message: string
  try {
    message = format(args)
  } catch {
    // `util.inspect` can throw on an object with a hostile getter.
    message = '[logging] unformattable arguments'
  }

  if (message === lastMessage) {
    suppressedRepeats += 1
    if (suppressedRepeats % REPEAT_NOTICE_EVERY === 0) {
      emit('warn', `[logging] previous line has now repeated ${suppressedRepeats} times`)
    }
    return
  }

  if (suppressedRepeats > 0) {
    emit('warn', `[logging] previous line repeated ${suppressedRepeats} more times`)
    suppressedRepeats = 0
  }
  lastMessage = message
  emit(level, message)
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return String(err)
  } catch {
    return 'unknown error'
  }
}

/** Stop writing to the console for the rest of the session. */
function markStdioDead(err: unknown): void {
  if (!stdioAlive) return
  stdioAlive = false
  emit('warn', `[logging] console output is gone (${errText(err)}); continuing to file only`)
}

/**
 * Echo to the real console, and survive it failing.
 *
 * `console.error` can throw synchronously: a `SyncWriteStream` — what Node
 * hands a packaged Windows build whose stdout is an inherited pipe — surfaces
 * EPIPE straight out of `write()`.
 */
function echo(original: (...args: unknown[]) => void, args: unknown[]): void {
  if (!stdioAlive) return
  try {
    original(...args)
  } catch (err) {
    markStdioDead(err)
  }
}

/**
 * Record a crash without becoming one.
 *
 * Node re-enters `uncaughtException` for anything thrown *out of* an
 * `uncaughtException` listener, so a handler that can throw is an infinite
 * loop by construction. The handler that shipped called `console.error`,
 * which once the launching pipe closed threw EPIPE on every call — a single
 * uncaught EPIPE detonated into thousands per second, each one spending a
 * `util.inspect` of a stack trace and a synchronous append, with the log file
 * rotating twice a second.
 *
 * That is not a logging problem, it's a system one. The low-level keyboard
 * and mouse hooks live in this process, and Windows dispatches every mouse
 * move through the hook thread; a process pegging a core and several MB/s of
 * synchronous I/O is a cursor that stutters and clicks that get dropped
 * across the entire desktop, until the process finally falls over.
 *
 * So: file first (that path swallows everything), console second and guarded,
 * plus a re-entrancy flag in case a future edit reintroduces a throw.
 */
function logFatal(label: string, value: unknown): void {
  if (handlingFatal) return
  handlingFatal = true
  try {
    write('error', [label, value])
    if (originalError) echo(originalError, [label, value])
  } finally {
    handlingFatal = false
  }
}

/** What the process was handed as fd 1 / fd 2. `pipe` is the interesting
 * answer: it means the launcher can take our console away mid-session. */
function stdioKind(fd: number): string {
  try {
    const stat = fs.fstatSync(fd)
    if (stat.isFIFO() || stat.isSocket()) return 'pipe'
    if (stat.isCharacterDevice()) return 'tty'
    if (stat.isFile()) return 'file'
    return 'other'
  } catch {
    return 'none'
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
    const original = console[method].bind(console) as (...args: unknown[]) => void
    if (method === 'error') originalError = original
    console[method] = (...args: unknown[]): void => {
      write(level, args)
      echo(original, args)
    }
  }

  // On a real pipe stream EPIPE arrives as an `error` event rather than a
  // throw, and an unhandled `error` event is itself an uncaught exception.
  // Claiming both listeners means a dead console can never reach `logFatal`.
  process.stdout.on('error', markStdioDead)
  process.stderr.on('error', markStdioDead)

  // Crashes are the single most valuable thing to have on disk, and Electron
  // prints them to the same discarded stderr.
  process.on('uncaughtException', (err) => logFatal('[uncaughtException]', err))
  process.on('unhandledRejection', (reason) => logFatal('[unhandledRejection]', reason))

  console.log(
    `[logging] main.log at ${logPath} (pid=${process.pid}, packaged=${app.isPackaged}, ` +
      `version=${app.getVersion()}, platform=${process.platform}, ` +
      `stdout=${stdioKind(1)}, stderr=${stdioKind(2)})`
  )
}

/** Absolute path of the active log file, or `null` when file logging failed
 * to initialise. Exposed so the UI can point the user at it. */
export function getLogFilePath(): string | null {
  return logPath
}
