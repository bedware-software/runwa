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
  focusWindowAsync(id: string): Promise<boolean>
  closeWindow(id: string): boolean
  getForegroundWindow(): string
  forceForegroundWindow(id: string): boolean
  isWindowOnCurrentDesktop(id: string): boolean
  getCurrentDesktopNumber(): number
  setDesktopChangeCallback(cb: (zeroBasedDesktop: number) => void): void
  focusTopmostOnCurrentDesktop(excludeId: string): FocusTopmostResult
  describeWindow(id: string): NativeWindow | null
  setWindowBorderColor?(id: string, color: number): void
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

/**
 * `focusWindow` off the main thread. A cross-Space focus on macOS waits out
 * the Space-switch animation inside the native call; run synchronously, that
 * freezes the main process — palette hide included — for the whole switch.
 * Windows callers stay on `focusWindow`: SetForegroundWindow's foreground
 * lock depends on the calling thread.
 */
export function focusWindowAsync(id: string): Promise<boolean> {
  return loadAddon().focusWindowAsync(id)
}

/**
 * Ask the window to close — equivalent to clicking its close button.
 * Windows posts WM_CLOSE; macOS presses the AX close button (needs
 * Accessibility). Returns true when the request was delivered — the app
 * may still show a "save changes?" prompt or refuse outright.
 */
export function closeWindow(id: string): boolean {
  return loadAddon().closeWindow(id)
}

export function getForegroundWindow(): string {
  return loadAddon().getForegroundWindow()
}

export function forceForegroundWindow(id: string): boolean {
  return loadAddon().forceForegroundWindow(id)
}

/**
 * True when `id`'s window sits on the virtual desktop / Space the user is
 * looking at right now. Windows reads real virtual-desktop membership;
 * macOS derives it from the on-screen CGWindowList, which is scoped to the
 * active Space. Answers `true` for anything it can't determine, so callers
 * treat it as "safe to touch this window" rather than a hard guarantee.
 */
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

/**
 * Subscribe to virtual-desktop changes. The native keyboard-remap hook
 * pushes the new 0-based ordinal the instant a `switch_to_workspace` /
 * `move_to_workspace` rule action fires — no polling. The callback runs on
 * the main thread (the native side marshals it through a threadsafe
 * function). Register once; a second call replaces the previous subscriber.
 * No-op on platforms without virtual desktops.
 */
export function onDesktopChanged(cb: (zeroBasedDesktop: number) => void): void {
  loadAddon().setDesktopChangeCallback(cb)
}

export function focusTopmostOnCurrentDesktop(excludeId: string): FocusTopmostResult {
  return loadAddon().focusTopmostOnCurrentDesktop(excludeId)
}

export function describeWindow(id: string): NativeWindow | null {
  return loadAddon().describeWindow(id)
}

const WM_SETTINGCHANGE = 0x001a
const WM_DWMCOLORIZATIONCOLORCHANGED = 0x0320
const DWMWA_COLOR_NONE = 0xfffffffe
/** Windows whose border we manage → the COLORREF to keep on them. */
const borderColors = new WeakMap<Electron.BrowserWindow, number>()

function applyBorder(win: Electron.BrowserWindow): void {
  if (win.isDestroyed()) return
  try {
    const id = win.getNativeWindowHandle().readBigUInt64LE(0).toString()
    loadAddon().setWindowBorderColor?.(id, borderColors.get(win) ?? DWMWA_COLOR_NONE)
  } catch (err) {
    console.warn('[native] setWindowBorderColor failed:', err)
  }
}

/** `#rrggbb` → COLORREF (0x00BBGGRR), or `null` for anything else. */
function hexToColorRef(hex: string): number | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return null
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16))
  return ((b << 16) | (g << 8) | r) >>> 0
}

/**
 * Take over the 1px border DWM paints around one of our own windows.
 * Starts as DWMWA_COLOR_NONE (no accent-colored line when "Show accent color
 * on title bars and window borders" is on); `setWindowBorderColor` then gives
 * it the window's own frame color. Windows-only; never throws — a border
 * glitch must not break window creation.
 *
 * Why a real color and not NONE for framed popups: NONE leaves the window's
 * 1px non-client strip (left, right, bottom — Chromium extends the client
 * area over the top only) showing the system's light frame grey #F3F3F3,
 * which sits beside the CSS frame as a double line. A colored DWM border
 * fills that strip; the renderer drops its own CSS frame on Windows so the
 * DWM line is the only one, with DWM's rounded corners.
 *
 * Setting it once is not enough: Electron (41) itself writes
 * DWMWA_BORDER_COLOR in `UpdateWindowAccentColor` on every activation change
 * and on WM_DWMCOLORIZATIONCOLORCHANGED / WM_SETTINGCHANGE — the system
 * accent while active, DWMWA_COLOR_DEFAULT otherwise (`accentColor: false`
 * only picks DEFAULT, which is the accent again). So we re-apply ours after
 * each of those. The JS focus/blur events fire *before* Electron's update in
 * the same native call, hence `setImmediate`.
 */
export function removeWindowBorder(win: Electron.BrowserWindow): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return
  if (borderColors.has(win)) {
    applyBorder(win)
    return
  }
  borderColors.set(win, DWMWA_COLOR_NONE)
  applyBorder(win)

  const reapply = (): void => {
    setImmediate(() => applyBorder(win))
  }
  win.on('focus', reapply)
  win.on('blur', reapply)
  win.on('show', reapply)
  win.hookWindowMessage(WM_DWMCOLORIZATIONCOLORCHANGED, reapply)
  win.hookWindowMessage(WM_SETTINGCHANGE, reapply)
}

/**
 * Give a window taken over by `removeWindowBorder` a DWM border in `hex`
 * (`#rrggbb`, the theme's frame color resolved by its renderer); anything
 * else goes back to no border. Ignored for windows not taken over.
 */
export function setWindowBorderColor(win: Electron.BrowserWindow, hex: string | null): void {
  if (process.platform !== 'win32' || win.isDestroyed() || !borderColors.has(win)) return
  borderColors.set(win, (hex ? hexToColorRef(hex) : null) ?? DWMWA_COLOR_NONE)
  applyBorder(win)
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
