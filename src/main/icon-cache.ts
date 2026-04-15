import { app } from 'electron'

/**
 * Resolves executable paths to PNG data URLs via Electron's `app.getFileIcon`
 * and caches the result in-memory for the life of the session.
 *
 * A `null` entry means resolution failed (missing file, access denied, empty
 * icon, etc.) — cached so bad paths aren't retried on every keystroke. The
 * caller (usually a module's `toItem`) decides the fallback (typically a
 * Lucide icon name).
 *
 * On Windows, size 'normal' returns a 32×32 icon — matches the 32px result
 * row container (ResultRow.tsx). Bump to 'large' (48×48) if high-DPI displays
 * start looking soft.
 */

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
