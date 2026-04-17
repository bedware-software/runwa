import { app, nativeImage } from 'electron'
import { getWindowIcon } from './modules/window-switcher/native'

/**
 * Icon resolution, two layers:
 *
 *  1. Window-scoped (HWND → PNG data URL). Sourced from the native addon
 *     via `WM_GETICON` / class icon. Wins for cases where the exe icon is
 *     meaningless:
 *       - UWP apps — all run under `ApplicationFrameHost.exe` (Windows
 *         Settings, Calculator, Mail, Store, etc.)
 *       - Edge PWAs — all run under `msedge.exe` (Inbox, Outlook,
 *         Todoist-as-PWA, …)
 *       - Electron apps launched through a shared `electron.exe`
 *     Cached per-HWND. Electron's `nativeImage.createFromBitmap` accepts the
 *     raw BGRA buffer handed back by the addon, then `toDataURL()` gives a
 *     `data:image/png;base64,…` URL.
 *
 *  2. Executable-scoped (exe path → PNG data URL). Sourced from
 *     `app.getFileIcon`, cached per-path. Fast path for native Win32 apps
 *     whose HWND exposes no icon but whose exe has a proper embedded one.
 *
 * A `null` entry in either cache means resolution failed — cached so bad
 * paths / iconless HWNDs aren't retried on every keystroke. The caller
 * (module's `toItem`) decides the final fallback (typically a Lucide name).
 *
 * Both caches live for the life of the process — icons rarely change, and
 * HWND reuse across different apps is rare enough to accept the staleness.
 */

// ─── Window-HWND icon cache ────────────────────────────────────────────────

const windowIconCache = new Map<string, string | null>()

/**
 * Resolve a window's taskbar-style icon synchronously via the native addon.
 * Returns `null` on non-Windows platforms (addon's macOS path is a stub) or
 * when the window doesn't expose an icon. Callers should then fall back to
 * the exe-based resolver.
 */
export function getWindowIconDataUrl(hwndId: string): string | null {
  if (windowIconCache.has(hwndId)) return windowIconCache.get(hwndId) ?? null
  try {
    const raw = getWindowIcon(hwndId)
    if (!raw) {
      windowIconCache.set(hwndId, null)
      return null
    }
    const img = nativeImage.createFromBitmap(raw.bgra, {
      width: raw.width,
      height: raw.height
    })
    if (img.isEmpty()) {
      windowIconCache.set(hwndId, null)
      return null
    }
    const url = img.toDataURL()
    windowIconCache.set(hwndId, url)
    return url
  } catch (err) {
    console.warn(`[icon-cache] getWindowIcon(${hwndId}) failed:`, err)
    windowIconCache.set(hwndId, null)
    return null
  }
}

// ─── Executable-path icon cache ────────────────────────────────────────────
//
// On Windows, size 'normal' returns a 32×32 icon — matches the 32 px result
// row container (ResultRow.tsx). Bump to 'large' (48×48) if high-DPI displays
// start looking soft.

const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

export async function getIconDataUrl(exePath: string | undefined): Promise<string | null> {
  if (!exePath) return null
  if (cache.has(exePath)) return cache.get(exePath) ?? null

  const existing = inflight.get(exePath)
  if (existing) return existing

  const p = (async () => {
    try {
      const img = await app.getFileIcon(exePath, { size: 'normal' })
      if (img.isEmpty()) {
        cache.set(exePath, null)
        return null
      }
      const dataUrl = img.toDataURL()
      cache.set(exePath, dataUrl)
      return dataUrl
    } catch (err) {
      console.warn(`[icon-cache] failed to resolve icon for ${exePath}:`, err)
      cache.set(exePath, null)
      return null
    } finally {
      inflight.delete(exePath)
    }
  })()
  inflight.set(exePath, p)
  return p
}

/**
 * Returns a previously-cached icon synchronously, or null if the path hasn't
 * been warmed yet. Intended for use inside hot-path `toItem` builders after a
 * prior `warmIconCache` call has resolved the batch.
 */
export function getIconDataUrlSync(exePath: string | undefined): string | null {
  if (!exePath) return null
  return cache.get(exePath) ?? null
}

/**
 * Resolves a batch of exe paths in parallel, deduping and skipping anything
 * already in the cache. Safe to call on every search — becomes a no-op once
 * all seen paths are cached.
 */
export async function warmIconCache(paths: Array<string | undefined>): Promise<void> {
  const unique = [...new Set(paths.filter((p): p is string => !!p && !cache.has(p)))]
  if (unique.length === 0) return
  await Promise.all(unique.map((p) => getIconDataUrl(p)))
}
