import {
  describeWindow,
  listWindowsCached,
  type NativeWindow
} from './modules/window-switcher/native'

/**
 * "Which app was the user in when they opened the palette?"
 *
 * The palette steals focus the moment it appears, so the answer has to be
 * captured at `show()` time — after that, the foreground app is runwa itself.
 * `palette-window` hands us the window id it already grabs for its
 * restore-focus-on-Escape path, and modules read the resolved app back out
 * during search.
 *
 * Resolution is lazy and memoised per palette session: capturing is a bare
 * string assignment on the hot show() path, and only the modules that
 * actually care (User Commands' app scoping) pay for the lookup. The
 * underlying window keeps existing while the palette is up — it's behind us,
 * not gone — so resolving late still describes the right app.
 */

export interface FocusedApp {
  /** Native window id — HWND string on Windows, `${pid}:${cgWindowId}` on macOS. */
  windowId: string
  pid?: number
  /** 'idea64.exe' on Windows, 'IntelliJ IDEA' on macOS. */
  processName: string
  /** Executable path (Windows) or `.app` bundle path (macOS), when known. */
  executablePath?: string
  bundleId?: string
  /** Title of the focused window. Blank when the OS won't tell us (macOS
   * without Screen Recording permission). */
  title: string
}

function toFocusedApp(window: NativeWindow): FocusedApp {
  return {
    windowId: window.id,
    pid: window.pid,
    processName: window.processName,
    executablePath: window.executablePath,
    bundleId: window.bundleId,
    title: window.title
  }
}

/**
 * Resolve a native window id to the app that owns it.
 *
 * Windows has a direct `describeWindow` path. macOS window ids are
 * `${pid}:${cgWindowId}` and the native addon deliberately doesn't implement
 * `describeWindow` there, so we look the id up in the (cached) current-Space
 * listing instead, falling back to any window of the same pid — different
 * window, same app, which is all app scoping needs.
 */
function resolveWindow(windowId: string): FocusedApp | null {
  try {
    const described = describeWindow(windowId)
    if (described) return toFocusedApp(described)
  } catch (err) {
    console.warn('[focus-context] describeWindow failed', err)
  }

  const pid = Number.parseInt(windowId.split(':')[0] ?? '', 10)
  try {
    const windows = listWindowsCached(true, true)
    const exact = windows.find((window) => window.id === windowId)
    if (exact) return toFocusedApp(exact)
    if (Number.isFinite(pid)) {
      const sameApp = windows.find((window) => window.pid === pid)
      if (sameApp) return toFocusedApp(sameApp)
    }
  } catch (err) {
    console.warn('[focus-context] window listing failed', err)
  }
  return null
}

class FocusContext {
  private windowId: string | null = null
  /** `undefined` = not resolved yet, `null` = resolved to "unknown app". */
  private resolved: FocusedApp | null | undefined = undefined

  /** Record the window that had focus before the palette took it. Called
   * once per palette show; `null` clears the context (nothing was focused,
   * or the native lookup failed). */
  capture(windowId: string | null): void {
    this.windowId = windowId
    this.resolved = undefined
  }

  clear(): void {
    this.windowId = null
    this.resolved = undefined
  }

  /** The app behind the palette, or null when it can't be identified. */
  get(): FocusedApp | null {
    if (this.resolved !== undefined) return this.resolved
    this.resolved = this.windowId ? resolveWindow(this.windowId) : null
    return this.resolved
  }
}

export const focusContext = new FocusContext()

/**
 * Every string a user might reasonably name an app by, given what the OS
 * told us about it. Matched against a command's `appScope` pattern:
 *
 *   Windows — 'idea64.exe', 'idea64', 'C:\...\bin\idea64.exe'
 *   macOS   — 'IntelliJ IDEA', 'IntelliJ IDEA.app', '/Applications/IntelliJ IDEA.app'
 *
 * Both the bare and extension-carrying forms are included so `idea64` and
 * `idea64.exe` are equally valid scopes, and so a macOS user can point at
 * either the app's display name or its bundle.
 */
export function appIdentityCandidates(app: FocusedApp): string[] {
  const candidates = new Set<string>()
  const add = (value: string | undefined): void => {
    const trimmed = value?.trim()
    if (trimmed) candidates.add(trimmed)
  }

  add(app.processName)
  add(stripExtension(app.processName))
  add(app.bundleId)
  add(app.executablePath)
  if (app.executablePath) {
    const base = app.executablePath.split(/[/\\]/).pop()
    add(base)
    add(stripExtension(base))
  }
  return [...candidates]
}

/** Drop a trailing `.exe` / `.app` so scopes can be written either way. */
function stripExtension(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.replace(/\.(exe|app)$/i, '')
}

/** Short, human-readable name for the focused app — used as the palette
 * group header for its commands ("IntelliJ IDEA commands"). */
export function appDisplayName(app: FocusedApp): string {
  return stripExtension(app.processName) || app.processName
}
