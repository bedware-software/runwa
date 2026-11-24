import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import {
  CONSOLE_TARGET_ARGUMENTS,
  type ConsoleNotificationsTarget,
  NOTIFICATION_MAX_DURATION_MS,
  NOTIFICATION_MIN_DURATION_MS,
  NOTIFICATION_TEXT_MAX,
  NOTIFICATION_TITLE_MAX,
  NOTIFICATION_TONES,
  type NotificationTone
} from '@shared/notifications'
import type { DesktopHintPayload } from '@shared/types'

/**
 * The drop folder behind the `runwa-notify` command.
 *
 * The command writes one small JSON file per notification into
 * `<userData>/notify-inbox/`; this class watches the folder, shows each
 * request and deletes the file. A folder rather than a second-instance
 * launch, a `runwa://` link, a pipe or a port, because Runwa usually runs
 * elevated on Windows: launching Runwa.exe from a normal shell raises a UAC
 * prompt, and a normal process cannot write to an elevated one's pipe, but
 * both can use a folder in the user's profile.
 *
 * That makes the folder an input from less-privileged code, so a file is
 * data and nothing else: two strings with length limits, a clamped number
 * and two values from fixed lists. Nothing in it is run, opened or rendered
 * as markup. Size, count and rate are capped, and whatever doesn't parse is
 * deleted without a word.
 */

const DIR_NAME = 'notify-inbox'
const MAX_FILE_BYTES = 8 * 1024
/** Files handled per pass; anything beyond that in one pass is dropped. */
const MAX_FILES_PER_SCAN = 20
/** At most this many notifications per window; the rest are dropped. */
const RATE_LIMIT = 10
const RATE_WINDOW_MS = 10_000
/** A half-written temp file older than this was abandoned by its writer. */
const STALE_TEMP_MS = 60_000
const SCAN_DEBOUNCE_MS = 40
const SOURCE_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/

export type InboxRequest = Pick<
  DesktopHintPayload,
  'source' | 'message' | 'title' | 'tone' | 'durationMs'
> & {
  /** The command's `--to`; absent means "as the module is set". */
  target?: ConsoleNotificationsTarget
}

export class NotificationInbox {
  private watcher: fs.FSWatcher | null = null
  private scanTimer: NodeJS.Timeout | null = null
  private scanning = false
  private rescan = false
  private recent: number[] = []

  constructor(private readonly onRequest: (request: InboxRequest) => void) {}

  dir(): string {
    return path.join(app.getPath('userData'), DIR_NAME)
  }

  start(): void {
    if (this.watcher) return
    const dir = this.dir()
    try {
      fs.mkdirSync(dir, { recursive: true })
      if (!isPlainDirectory(dir)) {
        console.warn(`[notifications] ${dir} is not a plain folder; console notifications are off`)
        return
      }
      // Whatever is already there was written while nobody was listening:
      // showing it now would be showing old news.
      for (const name of safeReaddir(dir)) removeQuietly(path.join(dir, name))
      this.watcher = fs.watch(dir, () => this.scheduleScan())
      this.watcher.on('error', (err) => {
        console.warn('[notifications] inbox watcher failed:', err)
        this.stop()
      })
    } catch (err) {
      console.warn('[notifications] could not watch the inbox:', err)
      this.watcher = null
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.scanTimer) clearTimeout(this.scanTimer)
    this.scanTimer = null
  }

  private scheduleScan(): void {
    // fs.watch reports one write as several events (and on Windows often
    // twice); the scan is idempotent, so they are simply folded together.
    if (this.scanTimer) return
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null
      this.scan()
    }, SCAN_DEBOUNCE_MS)
  }

  private scan(): void {
    if (this.scanning) {
      this.rescan = true
      return
    }
    this.scanning = true
    try {
      const dir = this.dir()
      // Re-checked on every pass: if the folder has been swapped for a link,
      // deleting "our" files would delete someone else's.
      if (!this.watcher || !isPlainDirectory(dir)) return

      let handled = 0
      for (const name of safeReaddir(dir).sort()) {
        const file = path.join(dir, name)
        if (!name.endsWith('.json')) {
          // The command writes `<name>.tmp` and renames it; leave a fresh one
          // alone and clear out anything else.
          if (!name.endsWith('.tmp') || ageMs(file) > STALE_TEMP_MS) removeQuietly(file)
          continue
        }
        const request = handled < MAX_FILES_PER_SCAN ? readRequest(file) : null
        removeQuietly(file)
        if (!request) continue
        handled += 1
        if (!this.underRateLimit()) continue
        try {
          this.onRequest(request)
        } catch (err) {
          console.warn('[notifications] inbox request failed:', err)
        }
      }
    } finally {
      this.scanning = false
      if (this.rescan) {
        this.rescan = false
        this.scheduleScan()
      }
    }
  }

  private underRateLimit(): boolean {
    const now = Date.now()
    this.recent = this.recent.filter((at) => now - at < RATE_WINDOW_MS)
    if (this.recent.length >= RATE_LIMIT) return false
    this.recent.push(now)
    return true
  }
}

function readRequest(file: string): InboxRequest | null {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return null
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
    const record = data as Record<string, unknown>

    const message = cleanText(record.text, NOTIFICATION_TEXT_MAX)
    if (!message) return null
    const title = cleanText(record.title, NOTIFICATION_TITLE_MAX)

    // Namespaced, so a script can replace its own earlier note but can never
    // replace or take down one that belongs to a module.
    const source =
      typeof record.source === 'string' && SOURCE_PATTERN.test(record.source)
        ? `cli:${record.source}`
        : 'cli'

    const tone = (NOTIFICATION_TONES as readonly unknown[]).includes(record.tone)
      ? (record.tone as NotificationTone)
      : undefined

    const duration = Number(record.duration)
    const durationMs =
      record.duration !== undefined && Number.isFinite(duration) && duration > 0
        ? Math.min(
            NOTIFICATION_MAX_DURATION_MS,
            Math.max(NOTIFICATION_MIN_DURATION_MS, Math.round(duration))
          )
        : undefined

    const target =
      typeof record.to === 'string' && Object.hasOwn(CONSOLE_TARGET_ARGUMENTS, record.to)
        ? CONSOLE_TARGET_ARGUMENTS[record.to]
        : undefined

    return {
      source,
      message,
      ...(target ? { target } : {}),
      ...(title ? { title } : {}),
      ...(tone ? { tone } : {}),
      ...(durationMs !== undefined ? { durationMs } : {})
    }
  } catch {
    return null
  }
}

/** Plain text only: control characters become spaces, then trim and cut. */
function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function isPlainDirectory(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function ageMs(file: string): number {
  try {
    return Date.now() - fs.lstatSync(file).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function removeQuietly(file: string): void {
  try {
    // unlink removes a link itself, never what it points at; a folder
    // someone put here is left alone.
    if (!fs.lstatSync(file).isDirectory()) fs.unlinkSync(file)
  } catch {
    // Already gone (the duplicate watch event) or locked by its writer.
  }
}
