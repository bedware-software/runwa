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

interface NativeAddon {
  listWindows(currentDesktopOnly: boolean, hideSystemWindows: boolean): NativeWindow[]
  focusWindow(id: string): boolean
  getForegroundWindow(): string
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

export function invalidateCache(): void {
  cache.clear()
}
