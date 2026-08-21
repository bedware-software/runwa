import Store from 'electron-store'
import { setRemapFullscreenBypass } from './native'

interface PersistedShape {
  processes: string[]
}

export const MAX_BYPASS_PROCESSES = 200
export const MAX_PROCESS_NAME_LENGTH = 260

/** Case-insensitive comparison key. Windows executable names aren't
 * case-sensitive, and the same app can be reported as `Cs2.exe` or
 * `cs2.exe` depending on how it was launched. */
function key(processName: string): string {
  return processName.trim().toLowerCase()
}

/** Drop malformed hand-edited entries and collapse duplicates. */
function sanitise(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (out.length >= MAX_BYPASS_PROCESSES) break
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (!name || name.length > MAX_PROCESS_NAME_LENGTH) continue
    const k = key(name)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(name)
  }
  return out
}

/**
 * Executables that suspend keyboard remapping while they own the screen —
 * the "Disable remapping in fullscreen" toggle in the palette's Ctrl+K menu.
 *
 * Own store file rather than the module `config` bag for the same reason as
 * the window-switcher ignore list: the generic module-config schema is
 * scalar-only, and this doesn't belong in the settings payload that gets
 * rebroadcast to every renderer on any unrelated change.
 *
 * The list is mirrored into the native addon on every write. The addon owns
 * the matching because the check runs inside the low-level keyboard hook,
 * where a trip through IPC isn't an option.
 */
class FullscreenBypassStore {
  private store: Store<PersistedShape> | null = null
  private cached: string[] | null = null

  init(): void {
    this.store = new Store<PersistedShape>({
      name: 'runwa-remap-fullscreen-bypass',
      defaults: { processes: [] }
    })
    // Push at startup: the addon starts with an empty list, and the hook
    // may come up before anything else touches this store.
    this.sync()
  }

  list(): string[] {
    if (this.cached) return this.cached
    const rules = sanitise(this.store?.get('processes'))
    this.cached = rules
    return rules
  }

  has(processName: string): boolean {
    const k = key(processName)
    return !!k && this.list().some((name) => key(name) === k)
  }

  /**
   * Flip the flag for one executable. Returns the resulting state so the
   * palette can relabel its menu row without a second round trip.
   */
  toggle(processName: string): { processes: string[]; enabled: boolean } {
    const name = processName.trim()
    if (!name) {
      throw new Error('An executable name is required.')
    }
    if (name.length > MAX_PROCESS_NAME_LENGTH) {
      throw new Error(
        `Executable names can be at most ${MAX_PROCESS_NAME_LENGTH} characters.`
      )
    }
    if (this.has(name)) {
      return { processes: this.remove(name), enabled: false }
    }
    const current = this.list()
    if (current.length >= MAX_BYPASS_PROCESSES) {
      throw new Error(
        `You can mark at most ${MAX_BYPASS_PROCESSES} applications.`
      )
    }
    return { processes: this.write([...current, name]), enabled: true }
  }

  remove(processName: string): string[] {
    const k = key(processName)
    return this.write(this.list().filter((name) => key(name) !== k))
  }

  private write(processes: string[]): string[] {
    this.store?.set('processes', processes)
    this.cached = processes
    this.sync()
    return processes
  }

  /** Mirror the list into the addon. Best-effort: a missing or stale addon
   * shouldn't take the settings pane down with it. */
  private sync(): void {
    try {
      setRemapFullscreenBypass(this.list())
    } catch (err) {
      console.warn('[keyboard-remap] failed to push fullscreen bypass list', err)
    }
  }
}

export const fullscreenBypassStore = new FullscreenBypassStore()
