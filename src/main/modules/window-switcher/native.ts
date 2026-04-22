import { app } from 'electron'
import path from 'path'

/**
 * TypeScript wrapper around the Rust napi-rs addon in `native/`.
 *
 * Loads the addon lazily at first use, resolving its location based on whether
 * we're in dev (project root) or packaged (extraResources dir). A 100ms TTL
 * cache per (currentDesktopOnly flag) avoids re-enumerating on every keystroke
 * but still returns fresh data when the palette is re-opened.
 *
 * This file is the only place that knows about the native addon. Swapping
 * backends (different native impl, shell-out fallback, etc.) is a
 * single-file change.
 */

export interface NativeWindow {
  id: string
  pid: number
  title: string
  processName: string
  executablePath?: string
  bundleId?: string
}

export interface FocusTopmostResult {
  ok: boolean
  pickedHwnd?: string
  log: string[]
}

/** Raw window icon pixels as handed back by the native addon. `bgra` is a
 * Node `Buffer` of `width * height * 4` bytes, BGRA-ordered — the format
 * Electron's `nativeImage.createFromBitmap` expects. */
export interface NativeWindowIcon {
  width: number
  height: number
  bgra: Buffer
}

interface NativeAddon {
  listWindows(currentDesktopOnly: boolean, hideSystemWindows: boolean): NativeWindow[]
  focusWindow(id: string): boolean
  getForegroundWindow(): string
  forceForegroundWindow(id: string): boolean
  isWindowOnCurrentDesktop(id: string): boolean
  getCurrentDesktopNumber(): number
  focusTopmostOnCurrentDesktop(excludeId: string): FocusTopmostResult
  describeWindow(id: string): NativeWindow | null
  getWindowIcon(id: string): NativeWindowIcon | null
  getFileIcon(path: string, iconIndex?: number): NativeWindowIcon | null
  isAccessibilityTrusted(): boolean
  requestAccessibilityPermission(): boolean
  isScreenRecordingGranted(): boolean
  requestScreenRecordingPermission(): boolean
}

let addon: NativeAddon | null = null
let loadError: Error | null = null

function loadAddon(): NativeAddon {
  if (addon) return addon
  if (loadError) throw loadError

  const nativePath = app.isPackaged
    ? path.join(process.resourcesPath, 'native')
    : path.join(app.getAppPath(), 'native')

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(nativePath) as NativeAddon
    if (typeof mod.listWindows !== 'function' || typeof mod.focusWindow !== 'function') {
      throw new Error('native addon does not export listWindows/focusWindow')
    }
    addon = mod
    return mod
  } catch (err) {
    loadError = new Error(
      `Failed to load runwa-native from ${nativePath}. ` +
        `Run \`npm run build:native\` to build the Rust addon for your platform. ` +
        `Original error: ${err}`
    )
    throw loadError
  }
}

const CACHE_TTL_MS = 100

interface CacheEntry {
  t: number
  windows: NativeWindow[]
}

// Keyed by "${currentDesktopOnly}:${hideSystemWindows}" so the different
// listing modes don't poison each other when the user toggles settings.
const cache = new Map<string, CacheEntry>()

export function listWindowsCached(
  currentDesktopOnly: boolean,
  hideSystemWindows: boolean
): NativeWindow[] {
  const now = Date.now()
  const key = `${currentDesktopOnly}:${hideSystemWindows}`
  const entry = cache.get(key)
  if (entry && now - entry.t < CACHE_TTL_MS) {
    return entry.windows
  }
  const windows = loadAddon().listWindows(currentDesktopOnly, hideSystemWindows)
  cache.set(key, { t: now, windows })
  return windows
}

export function focusWindow(id: string): boolean {
  return loadAddon().focusWindow(id)
}

export function getForegroundWindow(): string {
  return loadAddon().getForegroundWindow()
}

export function forceForegroundWindow(id: string): boolean {
  return loadAddon().forceForegroundWindow(id)
}

export function isWindowOnCurrentDesktop(id: string): boolean {
  return loadAddon().isWindowOnCurrentDesktop(id)
}

/**
 * Zero-based index of the currently active virtual desktop. Windows-only;
 * other platforms return 0. Callers that display a 1-based number (tray
 * icon, UI) should add 1 themselves.
 */
export function getCurrentDesktopNumber(): number {
  return loadAddon().getCurrentDesktopNumber()
}

export function focusTopmostOnCurrentDesktop(excludeId: string): FocusTopmostResult {
  return loadAddon().focusTopmostOnCurrentDesktop(excludeId)
}

export function describeWindow(id: string): NativeWindow | null {
  return loadAddon().describeWindow(id)
}

/**
 * Fetch the window's own icon (from WM_GETICON / class icon), not the icon
 * of its executable. Returns `null` on non-Windows platforms or when the
 * window doesn't expose an icon — callers should fall back to the exe-based
 * icon resolver.
 */
export function getWindowIcon(id: string): NativeWindowIcon | null {
  return loadAddon().getWindowIcon(id)
}

/**
 * Extract an icon resource directly from a file on disk (.exe / .dll /
 * .ico / .lnk). Windows-only; returns `null` on other platforms or when
 * the path has no icon at the given index. Used as a last-resort when
 * Electron's `app.getFileIcon` returns empty (sparse SHGetFileInfo cache
 * for installer-shipped shortcuts).
 */
export function getFileIcon(filePath: string, iconIndex = 0): NativeWindowIcon | null {
  return loadAddon().getFileIcon(filePath, iconIndex)
}

/**
 * macOS-only check. True on every other platform (no equivalent gate).
 * Used by the UI to surface a one-time prompt before the first all-Spaces
 * listing — AX calls silently return empty results when permission is
 * missing, which would otherwise look like "nothing is open".
 */
export function isAccessibilityTrusted(): boolean {
  return loadAddon().isAccessibilityTrusted()
}

/**
 * macOS-only. Shows the system Accessibility prompt (if the user hasn't
 * already denied it outside our process) and returns the current trusted
 * state. AX caches the trust bit at process start — after the user toggles
 * the switch in System Settings, runwa must be restarted.
 */
export function requestAccessibilityPermission(): boolean {
  return loadAddon().requestAccessibilityPermission()
}

/** macOS-only. True once `CGPreflightScreenCaptureAccess` reports the grant
 * has propagated. Required for `CGWindowList` to return window titles. */
export function isScreenRecordingGranted(): boolean {
  return loadAddon().isScreenRecordingGranted()
}

/** macOS-only. Triggers the Screen Recording permission prompt and
 * registers the app with TCC under its codesign identifier. Must be called
 * at least once per process on Sequoia+ — otherwise manually adding the
 * app under System Settings → Screen Recording often doesn't actually
 * propagate the grant. Fire-and-forget; the user still needs to relaunch
 * after granting before CGWindowList starts returning titles. */
export function requestScreenRecordingPermission(): boolean {
  return loadAddon().requestScreenRecordingPermission()
}

export function invalidateCache(): void {
  cache.clear()
}
