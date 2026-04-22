import { app, nativeImage, shell, type ShortcutDetails } from 'electron'
import { execFile } from 'child_process'
import fsPromises from 'fs/promises'
import path from 'path'
import { promisify } from 'util'
import { getWindowIcon, getFileIcon as nativeGetFileIcon } from './modules/window-switcher/native'

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

// Raster image formats the OS hands us in "just open the file" form — mostly
// UWP `Square44x44Logo.*.png` and the occasional explicit `.lnk icon =
// foo.ico` or Assets jpg. `app.getFileIcon` returns the file-type shell icon
// for these (useless, always the same PNG glyph), so we load them directly.
const DIRECT_IMAGE_EXTENSIONS = /\.(png|jpe?g|ico)$/i

// `%VAR%\sub\path` → fully-resolved filesystem path. Windows .lnk stores
// env-var-templated paths verbatim (`%windir%\explorer.exe`), and both
// Electron's `app.getFileIcon` and Win32 `ExtractIconExW` need them
// expanded up front. `process.env` on Windows is case-insensitive in Node,
// so `%ProgramFiles%` and `%PROGRAMFILES%` both resolve.
function expandWinEnv(p: string): string {
  return p.replace(/%([^%]+)%/g, (match, name: string) => {
    const v = process.env[name]
    return typeof v === 'string' && v.length > 0 ? v : match
  })
}

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

  // Raster image paths (UWP logos, .lnk explicit icon, .ico files): load
  // directly and resize to the tile size. `app.getFileIcon` on these would
  // just return the generic file-type shell icon.
  if (DIRECT_IMAGE_EXTENSIONS.test(exePath)) {
    const img = nativeImage.createFromPath(exePath)
    if (!img.isEmpty()) {
      return img.resize({ width: 32, height: 32, quality: 'best' })
    }
    // Fall through to getFileIcon in case the path existed but the image
    // decoder choked on the file — `getFileIcon` at least returns the
    // filetype glyph in that case.
  }

  // Windows .lnk: `app.getFileIcon` on a shortcut often returns the generic
  // "shortcut" overlay or an empty image rather than the target's real icon.
  // We ask Windows for the shortcut's declared `icon`/`target` paths via
  // `shell.readShortcutLink` and try each in turn across the three icon
  // sizes Electron supports (some paths return an image at 'large' even
  // when 'normal' is empty — SHGetFileInfo's cache can be sparse).
  // Classic failure mode is an MSI-installed `.lnk` whose icon resource
  // lives under `C:\Windows\Installer\{GUID}\Foo.exe`; when that path is
  // unreadable we fall back to the real `target` under `Program Files`.
  if (process.platform === 'win32' && exePath.toLowerCase().endsWith('.lnk')) {
    const debug = /adguard/i.test(path.basename(exePath))
    const logDebug = (...args: unknown[]): void => {
      if (debug) console.log('[icon-cache][lnk-debug]', path.basename(exePath), ...args)
    }

    let info: ShortcutDetails | null = null
    try {
      info = shell.readShortcutLink(exePath)
      logDebug('readShortcutLink OK', info)
    } catch (err) {
      // PIDL-only shortcuts (Control Panel, Run, Windows Media Player
      // Legacy, some reparse-point-based items) aren't representable as
      // `IShellLinkW::GetPath`-resolvable data, so Electron's parser
      // bails. SHGetFileInfo on the .lnk path itself can still produce
      // the real icon, so we just fall through to that below.
      logDebug('readShortcutLink threw', err)
    }

    if (info) {
      // Expand `%SYSTEMROOT%`, `%PROGRAMFILES%`, etc. — Electron hands back
      // the raw `IconLocation` string as stored in the .lnk, and many
      // shell-provided shortcuts (File Explorer, Settings, Control Panel
      // applets) use unexpanded env-var paths like `%windir%\explorer.exe`.
      const iconPath = info.icon ? expandWinEnv(info.icon) : ''
      const targetPath = info.target ? expandWinEnv(info.target) : ''

      const candidates: Array<{ path: string; iconIndex: number }> = []
      if (iconPath.length > 0) {
        candidates.push({ path: iconPath, iconIndex: info.iconIndex ?? 0 })
      }
      // PIDL-based shortcuts (File Explorer, This PC, Recycle Bin) leave
      // `target` empty because the target is a shell namespace item, not a
      // filesystem path. `info.icon` carries the real icon source — nothing
      // to add as a second candidate.
      if (targetPath.length > 0 && targetPath !== iconPath) {
        candidates.push({ path: targetPath, iconIndex: 0 })
      }
      logDebug('candidates', candidates)

      for (const { path: candidate, iconIndex } of candidates) {
        if (DIRECT_IMAGE_EXTENSIONS.test(candidate)) {
          const img = nativeImage.createFromPath(candidate)
          logDebug('createFromPath', candidate, { empty: img.isEmpty() })
          if (!img.isEmpty()) return img.resize({ width: 32, height: 32, quality: 'best' })
          continue
        }
        // Native `ExtractIconExW` goes straight to the icon resource
        // at the requested index, bypassing SHGetFileInfo's shell cache
        // which is lossy / returns a generic file-type glyph for many
        // installer-shipped icons (AdGuard, AdGuard VPN, …). Try it first
        // so branded icons show up as themselves rather than as the
        // generic cog. Falls back to Electron's shell-routed variant if
        // the resource can't be extracted directly.
        const nativeImg = loadNativeFileIcon(candidate, iconIndex)
        logDebug('nativeExtract', candidate, `idx=${iconIndex}`, {
          empty: nativeImg == null || nativeImg.isEmpty(),
          size: nativeImg?.getSize()
        })
        if (nativeImg && !nativeImg.isEmpty()) return nativeImg
        const img = await tryGetFileIconMultiSize(candidate)
        logDebug('getFileIcon', candidate, {
          empty: img == null || img.isEmpty(),
          size: img?.getSize()
        })
        if (img && !img.isEmpty()) return img
      }
    }

    // Last-ditch fallbacks, also used by the PIDL-only shortcuts that
    // bypassed the block above:
    //   1. Electron's shell-routed `app.getFileIcon` on the .lnk — uses
    //      SHGetFileInfo, resolves simple shortcuts.
    //   2. `createThumbnailFromPath` — routes through IThumbnailProvider
    //      (a different Windows API). Rescues PIDL-only shortcuts that
    //      `readShortcutLink` refused to parse (Windows Media Player
    //      Legacy, some shell namespace items). IThumbnailProvider caches
    //      per-file but doesn't care whether we can read the binary —
    //      it returns whatever the shell would show in Explorer.
    //   3. Native ExtractIconExW on the .lnk — only useful if the
    //      shortcut itself has an icon resource embedded; cheap to try.
    const lnkImg = await tryGetFileIconMultiSize(exePath)
    logDebug('getFileIcon(lnk)', { empty: lnkImg == null || lnkImg.isEmpty() })
    if (lnkImg && !lnkImg.isEmpty()) return lnkImg

    try {
      const thumb = await nativeImage.createThumbnailFromPath(exePath, {
        width: 32,
        height: 32
      })
      logDebug('thumbnail(lnk)', { empty: thumb.isEmpty(), size: thumb.getSize() })
      if (!thumb.isEmpty()) return thumb
    } catch (err) {
      logDebug('thumbnail(lnk) threw', err)
    }

    const nativeLnkImg = loadNativeFileIcon(exePath, 0)
    logDebug('nativeExtract(lnk)', { empty: nativeLnkImg == null || nativeLnkImg.isEmpty() })
    if (nativeLnkImg && !nativeLnkImg.isEmpty()) return nativeLnkImg

    // Still nothing — diagnostic dump so triage can happen from terminal.
    console.warn('[icon-cache] .lnk resolved to empty icon', { lnk: exePath, info })
  }

  return app.getFileIcon(exePath, { size: 'normal' })
}

/**
 * Windows-only helper that walks the three `app.getFileIcon` sizes in
 * preference order. Some installer-shipped icons come back empty at
 * `size: 'normal'` but render at `'large'` or `'small'` — probably
 * SHGetFileInfo's per-size icon cache being sparse for freshly-installed
 * apps. Returns the first non-empty image, resized to our tile dimension
 * so the caller doesn't have to care.
 */
async function tryGetFileIconMultiSize(p: string): Promise<Electron.NativeImage | null> {
  for (const size of ['normal', 'large', 'small'] as const) {
    try {
      const img = await app.getFileIcon(p, { size })
      if (!img.isEmpty()) {
        return size === 'normal' ? img : img.resize({ width: 32, height: 32, quality: 'best' })
      }
    } catch {
      // continue to next size
    }
  }
  return null
}

/**
 * Native `ExtractIconExW`-backed extractor. Catches the case where the
 * file has a real icon resource but `app.getFileIcon`'s shell cache is
 * empty (installer-shipped MSI shortcuts like AdGuard).
 */
function loadNativeFileIcon(p: string, iconIndex: number): Electron.NativeImage | null {
  try {
    const raw = nativeGetFileIcon(p, iconIndex)
    if (!raw) return null
    const img = nativeImage.createFromBitmap(raw.bgra, {
      width: raw.width,
      height: raw.height
    })
    if (img.isEmpty()) return null
    // Resize for the 32 px tile — `hicon_to_bgra` returns whatever the
    // source HICON's cursor size was (typically 32×32, but large icons
    // can be 48×48 or higher).
    if (raw.width === 32 && raw.height === 32) return img
    return img.resize({ width: 32, height: 32, quality: 'best' })
  } catch (err) {
    console.warn(`[icon-cache] native getFileIcon(${p}) threw:`, err)
    return null
  }
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
