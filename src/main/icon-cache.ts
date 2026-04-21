import { app, nativeImage } from 'electron'
import { execFile } from 'child_process'
import fsPromises from 'fs/promises'
import path from 'path'
import { promisify } from 'util'
import { getWindowIcon } from './modules/window-switcher/native'

const execFileAsync = promisify(execFile)

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
// Platform split:
//  - Windows: `app.getFileIcon(exe, { size: 'normal' })` → 32×32, matches the
//    result row's 32 px tile (ResultRow.tsx).
//  - macOS: `app.getFileIcon` returns a generic placeholder for `.app`
//    bundles (same 1.6 KB PNG for every app). `nativeImage.createThumbnailFromPath`
//    routes through QuickLook and returns the real icon — we request 64×64
//    so it stays crisp on retina when rendered in the 32 px tile.

const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

async function resolveIconImage(exePath: string): Promise<Electron.NativeImage> {
  if (process.platform === 'darwin') {
    // Prefer a direct read from the bundle's Info.plist + Resources/*.icns —
    // QuickLook-backed `createThumbnailFromPath` fails silently for roughly
    // half the apps in /Applications (XPC timeouts, missing generators,
    // unsigned/quarantined bundles, etc.) and we end up falling back to the
    // generic app icon. `resolveMacBundleIcon` returns a real `nativeImage`
    // whenever the bundle declares an .icns file — which is the common case
    // for pretty much every app that isn't asset-catalog-only.
    const direct = await resolveMacBundleIcon(exePath)
    if (direct && !direct.isEmpty()) return direct
    return nativeImage.createThumbnailFromPath(exePath, { width: 64, height: 64 })
  }
  return app.getFileIcon(exePath, { size: 'normal' })
}

/**
 * macOS: resolve a .app bundle's icon from `Contents/Info.plist` +
 * `Contents/Resources/<icon>.icns`. Returns `null` when the bundle doesn't
 * declare a loadable .icns (e.g. asset-catalog-only apps introduced in
 * Xcode 12+) so the caller falls back to QuickLook.
 */
async function resolveMacBundleIcon(
  bundlePath: string
): Promise<Electron.NativeImage | null> {
  const infoPlist = path.join(bundlePath, 'Contents', 'Info.plist')
  const iconName = await readBundleIconKey(infoPlist)
  if (!iconName) return null

  // CFBundleIconFile is sometimes written with the extension, sometimes
  // without. Try the declared name first, then force `.icns`, then `.png`.
  const resources = path.join(bundlePath, 'Contents', 'Resources')
  const base = iconName.endsWith('.icns') ? iconName.slice(0, -5) : iconName
  const candidates = [
    path.join(resources, iconName),
    path.join(resources, `${base}.icns`),
    path.join(resources, `${base}.png`)
  ]

  for (const candidate of candidates) {
    try {
      await fsPromises.access(candidate)
    } catch {
      continue
    }
    const img = nativeImage.createFromPath(candidate)
    if (img.isEmpty()) continue
    // .icns images contain many resolutions; the 32-pt palette tile renders
    // at ~64px on Retina, so normalise to 64×64 to keep cached data URLs
    // from ballooning (the largest .icns rep can be 1024×1024).
    return img.resize({ width: 64, height: 64, quality: 'best' })
  }
  return null
}

/**
 * Returns the `CFBundleIconFile` value (falling back to `CFBundleIconName`)
 * from an Info.plist. Binary or XML plist formats are both handled by
 * `plutil -extract`. Spawning plutil is acceptable because each cache entry
 * is resolved once and inflight-deduped; the warm batch fans out in
 * parallel via `Promise.all`.
 */
async function readBundleIconKey(infoPlist: string): Promise<string | null> {
  for (const key of ['CFBundleIconFile', 'CFBundleIconName']) {
    try {
      const { stdout } = await execFileAsync('/usr/bin/plutil', [
        '-extract',
        key,
        'raw',
        '-o',
        '-',
        infoPlist
      ])
      const trimmed = stdout.trim()
      if (trimmed.length > 0) return trimmed
    } catch {
      // Key missing / plist unreadable — try next key, then give up.
    }
  }
  return null
}

export async function getIconDataUrl(exePath: string | undefined): Promise<string | null> {
  if (!exePath) return null
  if (cache.has(exePath)) return cache.get(exePath) ?? null

  const existing = inflight.get(exePath)
  if (existing) return existing

  const p = (async () => {
    try {
      const img = await resolveIconImage(exePath)
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
