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
import { isWindowIgnored, windowIgnoreStore } from './ignore-store'
import { fullscreenBypassStore } from '../keyboard-remap/fullscreen-bypass-store'

/** The fullscreen remap bypass is implemented in the Windows hook only. */
const SUPPORTS_FULLSCREEN_BYPASS = process.platform === 'win32'

const MANIFEST: ModuleManifest = {
  id: 'window-switcher',
  name: 'Window Switcher',
  icon: 'app-window',
  kind: 'search',
  description: 'Jump to any open window on your desktop — like PowerToys Window Walker.',
  defaultEnabled: true,
  supportsDirectLaunch: true,
  defaultDirectLaunchHotkey: 'Ctrl+Alt+Super+W',
  // Re-pressing the hotkey while the switcher is open jumps to the second
  // row — the previously focused window (the list is z-ordered) — instead
  // of dismissing. Double-press = Alt+Tab-style bounce between the two most
  // recent windows, which Cmd+Tab can't do for two windows of the same app.
  directLaunchSecondPress: 'activate-second',
  configFields: [
    // The `currentDesktopOnly` flag still lives in the module's
    // config bag — it's just no longer surfaced in the settings UI.
    // It's flipped inline from the palette top bar (the "This
    // desktop / All desktops" chip + Tab key) since that's the
    // moment where the user actually cares about the filter.
    // Defaults to `true` when the value isn't present — search()
    // reads `context.config.currentDesktopOnly !== false`.
    {
      key: 'hideSystemWindows',
      type: 'checkbox',
      label: 'Hide system windows',
      description:
        'Hide suspended Windows shell surfaces (Start, Search, Notification Center, Lock Screen, TextInputHost, etc.) that report as windows but aren\'t actually visible. Turn off to see every HWND on the desktop.',
      defaultValue: true
    },
    {
      key: 'autoSelectSingleMatch',
      type: 'checkbox',
      label: 'Auto-select single match',
      description:
        'When your search narrows to exactly one window, focus it immediately instead of waiting for Enter. Only fires while you\'re typing a query — opening the switcher with a single window on the desktop never auto-focuses.',
      defaultValue: false
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

/**
 * Word-initials of a title, lowercased — e.g. "Jenkins Jobs — Work" → "jjw".
 * Lets short queries match by acronym the way PowerToys Window Walker does:
 * typing "jj" surfaces "Jenkins Jobs …" even though "jj" is nowhere in the
 * title as a substring. Any run of non-alphanumeric characters is a word
 * boundary, so spaces, em-dashes, and punctuation all split words.
 */
function computeInitials(title: string): string {
  return title
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => word[0])
    .join('')
    .toLowerCase()
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
    // Drives the Ctrl+K context menu's "Show in file explorer" action.
    // Windows exposed via the AX/CGWindow bridge without an exe path
    // (e.g. some macOS UI-element windows) leave this undefined, so the
    // menu hides the reveal row rather than pointing at nothing.
    revealPath: w.executablePath,
    // Marker for apps opted out of key remapping while fullscreen. Only
    // meaningful on Windows, where the hook implements the bypass.
    ...(SUPPORTS_FULLSCREEN_BYPASS && fullscreenBypassStore.has(w.processName)
      ? {
          iconBadge: 'keyboard-off',
          iconTooltip:
            'Key remapping is disabled while this app is fullscreen'
        }
      : {}),
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

      // Title fallback: CGWindowList (both current-Space and all-Spaces
      // paths on macOS) returns blank `title` when Screen Recording
      // permission is absent. Fall back to the process name so the list
      // isn't empty.
      //
      // Dedup is conditional: when the title fell back (was empty), we
      // collapse N same-process rows into one — the user can't tell them
      // apart anyway, so a single app-level entry is the right UI. Real
      // per-window titles always produce distinct rows, even when two
      // windows happen to share the same title (two Chrome tabs pinned
      // to the same page, two VS Code windows on the same project, etc.);
      // the HWND id stays unique, so clicking each one focuses its own
      // window.
      // User-authored ignore list (Ctrl+K → "Ignore this window", managed in
      // the module's settings pane). Matched against the same title /
      // executable strings the palette renders, so a rule created from a row
      // hides exactly that row.
      const ignoreRules = windowIgnoreStore.listForMatching()

      const seen = new Set<string>()
      const all = listWindowsCached(currentDesktopOnly, hideSystemWindows)
        .filter((w) => w.pid !== ownPid)
        .map((w) => {
          const trimmed = w.title.trim()
          const title = trimmed || w.processName
          return {
            ...w,
            title,
            titleFellBack: trimmed.length === 0,
            initials: computeInitials(title)
          }
        })
        .filter((w) => {
          if (w.title.length === 0) return false
          if (isWindowIgnored(ignoreRules, w.title, w.processName)) return false
          if (!w.titleFellBack) return true
          const key = `${w.pid}\x00${w.title}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })

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

      // Bitap admits up to `threshold * queryLength` edits, so a fixed
      // ratio is far too loose on short queries: at length 3, threshold
      // 0.4 lets a whole character through — "ide" matches "ude"/"ode"/"de",
      // surfacing Claude / Codex / ~\Desktop\runwa for an IDE search. Scale
      // the error budget so 1–4 char queries demand an exact substring and
      // only longer queries (where the ratio is actually forgiving) get
      // real typo tolerance.
      const threshold = trimmed.length <= 4 ? 0 : 0.3

      const fuse = new Fuse(all, {
        keys: [
          { name: 'title', weight: 0.7 },
          // Acronym key: with threshold 0 a short query must be a contiguous
          // substring of the title's initials, so "jj" hits "Jenkins Jobs …"
          // ("jjwn") without loosening the substring rule for real titles.
          // Fuse only folds matched keys into the score, so an initials-only
          // hit still ranks at the top.
          { name: 'initials', weight: 0.4 },
          { name: 'processName', weight: 0.3 }
        ],
        includeScore: true,
        threshold,
        ignoreLocation: true
      })

      const results = fuse.search(trimmed)
      const items = results.map((r) => toItem(r.item, r.score ?? 1))

      // Auto-select single match (opt-in, off by default): once the query
      // has narrowed the list to exactly one window, tag it `autoExecute`
      // so the renderer focuses it without an Enter press. Gated on the
      // non-empty-query branch above — opening the switcher with a single
      // desktop window must never self-fire.
      if (context.config.autoSelectSingleMatch === true && items.length === 1) {
        items[0] = { ...items[0], autoExecute: true }
      }

      return items
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
