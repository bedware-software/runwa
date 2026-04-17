import Fuse from 'fuse.js'
import type { ModuleManifest, PaletteItem } from '@shared/types'
import type { PaletteModule } from '../types'
import {
  listWindowsCached,
  focusWindow as nativeFocus,
  invalidateCache,
  type NativeWindow
} from './native'
import {
  getIconDataUrlSync,
  getWindowIconDataUrl,
  warmIconCache
} from '../../icon-cache'

const MANIFEST: ModuleManifest = {
  id: 'window-switcher',
  name: 'Window Switcher',
  icon: 'app-window',
  prefix: 'win',
  description: 'Jump to any open window on your desktop — like PowerToys Window Walker.',
  defaultEnabled: true,
  supportsDirectLaunch: true,
  configFields: [
    {
      key: 'currentDesktopOnly',
      type: 'checkbox',
      label: 'Current desktop only',
      description:
        'Only list windows on the active virtual desktop (Virtual Desktop on Windows, Space on macOS). Turn off to see every open window across all desktops.',
      defaultValue: true
    },
    {
      key: 'hideSystemWindows',
      type: 'checkbox',
      label: 'Hide system windows',
      description:
        'Hide suspended Windows shell surfaces (Start, Search, Notification Center, Lock Screen, TextInputHost, etc.) that report as windows but aren\'t actually visible. Turn off to see every HWND on the desktop.',
      defaultValue: true
    }
  ]
}

interface FocusAction {
  nativeId: string
}

function isFocusAction(a: unknown): a is FocusAction {
  return (
    typeof a === 'object' &&
    a !== null &&
    'nativeId' in a &&
    typeof (a as { nativeId: unknown }).nativeId === 'string'
  )
}

export function createWindowSwitcherModule(): PaletteModule {
  const ownPid = process.pid

  const toItem = (
    w: NativeWindow,
    score: number
  ): Omit<PaletteItem, 'moduleId'> => ({
    id: `win:${w.id}`,
    title: w.title,
    subtitle: w.processName,
    // Icon precedence:
    //  1. HWND icon — the one Windows shows in the taskbar. Wins for UWP
    //     apps (all running under ApplicationFrameHost.exe), Edge PWAs
    //     (all msedge.exe), and Electron apps launched via a shared
    //     electron.exe — cases where the exe icon is a generic host glyph.
    //  2. Executable icon — `app.getFileIcon(exePath)`. Fast path for
    //     native Win32 apps whose HWND doesn't expose an icon but whose
    //     exe has a proper embedded one.
    //  3. Lucide `app-window` glyph — final fallback.
    iconHint:
      getWindowIconDataUrl(w.id) ??
      getIconDataUrlSync(w.executablePath) ??
      'app-window',
    actionKind: 'focus-window',
    action: { nativeId: w.id } satisfies FocusAction,
    score
  })

  return {
    manifest: MANIFEST,

    async search(query, signal, context) {
      if (signal.aborted) return []

      // Default to true on fresh installs where the stored values are missing.
      const currentDesktopOnly = context.config.currentDesktopOnly !== false
      const hideSystemWindows = context.config.hideSystemWindows !== false

      // When the palette just opened (empty query), refresh the cache so
      // the list reflects the current state of the desktop.
      if (query === '') invalidateCache()

      const all = listWindowsCached(currentDesktopOnly, hideSystemWindows).filter(
        (w) => w.pid !== ownPid && w.title.trim().length > 0
      )

      if (signal.aborted) return []

      // Prime the HWND icon cache for every window — the call is sync but
      // fast (~1-2 ms per window, then cache-hit). Collecting only the
      // exe paths for windows whose HWND has no icon lets us skip the
      // async `app.getFileIcon` round-trip for the majority that already
      // resolved via HWND.
      const exePathsNeedingIcon: Array<string | undefined> = []
      for (const w of all) {
        if (getWindowIconDataUrl(w.id) === null) {
          exePathsNeedingIcon.push(w.executablePath)
        }
      }
      await warmIconCache(exePathsNeedingIcon)

      if (signal.aborted) return []

      const trimmed = query.trim()
      if (trimmed === '') {
        return all.map((w, i) => toItem(w, i / 10000))
      }

      const fuse = new Fuse(all, {
        keys: [
          { name: 'title', weight: 0.7 },
          { name: 'processName', weight: 0.3 }
        ],
        includeScore: true,
        threshold: 0.4,
        ignoreLocation: true
      })

      const results = fuse.search(trimmed)
      return results.map((r) => toItem(r.item, r.score ?? 1))
    },

    async execute(item) {
      if (item.actionKind !== 'focus-window' || !isFocusAction(item.action)) {
        console.warn('[window-switcher] invalid action', item)
        return { dismissPalette: false }
      }
      try {
        const ok = nativeFocus(item.action.nativeId)
        if (!ok) {
          // Window probably disappeared between listing and focus. Invalidate
          // cache so the next search reflects the new state.
          invalidateCache()
        }
      } catch (err) {
        console.warn('[window-switcher] focus failed', err)
      }
      return { dismissPalette: true }
    }
  }
}
