import { watch, type FSWatcher } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Follows the active profile of every Ulanzi device.
 *
 * Ulanzi Studio has no event API, but it saves `config/setting_source.json`
 * on every profile switch — a click in Ulanzi Studio, a Switch Profile action
 * on the device, and the automatic switch that follows the frontmost app —
 * with each device's `CurrentProfile`. The save lands within a few
 * milliseconds of the switch, so a file watch is all it takes; nothing is
 * polled.
 *
 * Ulanzi saves through a temp file and a rename (QSaveFile), which replaces
 * the inode: a watch on the file itself goes quiet after the first save, so
 * the watch is on the folder and filtered by name.
 */

const SETTINGS_FILE = 'setting_source.json'
/**
 * Only used while the config folder doesn't exist (Ulanzi Studio not
 * installed yet): there is nothing to watch until it appears.
 */
const MISSING_RETRY_MS = 60_000

/**
 * `initial` marks the profiles already active when watching began — state
 * to reflect, not a switch the user just made.
 */
export type UlanziProfileHandler = (profile: string, initial: boolean) => void

export class UlanziProfileWatcher {
  private watcher: FSWatcher | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private running = false
  private reading = false
  private readAgain = false
  private seeded = false
  /** Device id → profile last reported. */
  private profiles = new Map<string, string>()

  constructor(
    private readonly configDir: string,
    private readonly onProfile: UlanziProfileHandler
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.seeded = false
    this.profiles.clear()
    this.attach()
  }

  stop(): void {
    this.running = false
    this.detach()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private attach(): void {
    if (!this.running) return
    try {
      this.watcher = watch(this.configDir, { persistent: false }, (_event, filename) => {
        if (filename === null || filename === SETTINGS_FILE) void this.read()
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[ulanzi] could not watch the Ulanzi Studio config:', err)
      }
      this.scheduleRetry()
      return
    }
    // The folder being removed (an uninstall) ends the watch with an error;
    // start over and wait for it to come back.
    this.watcher.on('error', (err) => {
      console.warn('[ulanzi] Ulanzi Studio config watch ended:', err)
      this.detach()
      this.scheduleRetry()
    })
    console.log(`[ulanzi] watching ${this.configDir}`)
    void this.read()
  }

  private detach(): void {
    this.watcher?.close()
    this.watcher = null
  }

  private scheduleRetry(): void {
    if (!this.running || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.attach()
    }, MISSING_RETRY_MS)
    this.retryTimer.unref()
  }

  /**
   * One save raises several events (the temp file, the rename). Reads never
   * overlap; an event that arrives mid-read triggers one more read, so the
   * last read always sees the newest save.
   */
  private async read(): Promise<void> {
    if (this.reading) {
      this.readAgain = true
      return
    }
    this.reading = true
    try {
      do {
        this.readAgain = false
        const current = await readCurrentProfiles(
          path.join(this.configDir, SETTINGS_FILE)
        )
        if (!this.running) return
        if (current) this.apply(current)
      } while (this.readAgain)
    } finally {
      this.reading = false
    }
  }

  private apply(current: Map<string, string>): void {
    const initial = !this.seeded
    this.seeded = true
    for (const [device, profile] of current) {
      if (this.profiles.get(device) === profile) continue
      this.profiles.set(device, profile)
      this.onProfile(profile, initial)
    }
  }
}

/**
 * Device id → active profile, or null when the file is missing or caught
 * mid-save (the next event reads it again).
 */
async function readCurrentProfiles(file: string): Promise<Map<string, string> | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
  const devices = (parsed as { Devices?: unknown } | null)?.Devices
  if (!Array.isArray(devices)) return null

  const out = new Map<string, string>()
  devices.forEach((device: Record<string, unknown> | null, index) => {
    const profile = device?.CurrentProfile
    if (typeof profile !== 'string' || !profile) return
    const id = typeof device?.CurrentDevice === 'string' ? device.CurrentDevice : `#${index}`
    out.set(id, profile)
  })
  return out
}
