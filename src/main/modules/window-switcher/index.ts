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
import { fuzzyScore } from '../../fuzzy-match'
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
            titleFellBack: trimmed.length === 0
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

      // `fuzzyScore` matches on where the typed characters landed rather
      // than on edit distance, which is what the old query-length threshold
      // hack was approximating: it only admits a match anchored to a word
      // start or appearing verbatim, so "ide" still can't reach Claude /
      // Codex / ~\Desktop\runwa through their shared WindowsTerminal.exe.
      // Acronyms come out of the same rule — "jj" scores "Jenkins Jobs …"
      // on two word-start hits — so the separate `initials` key is gone.
      //
      // A window is scored on its title and its process name, best of the
      // two: the title is what the user reads, but the process name is what
      // they remember for a window whose title is a document name.
      let matches: Array<{ window: (typeof all)[number]; score: number }> = []
      for (const w of all) {
        const byTitle = fuzzyScore(trimmed, w.title)
        const byProcess = w.processName ? fuzzyScore(trimmed, w.processName) : null
        const score =
          byTitle === null
            ? byProcess
            : byProcess === null
              ? byTitle
              : Math.min(byTitle, byProcess)
        if (score !== null) matches.push({ window: w, score })
      }

      // Nothing matched character-for-character — fall back to Fuse, the
      // only pass that tolerates a typo. It runs solely on a query that
      // found no real match, so its looseness can't outrank an exact one:
      // the old 0.3 ceiling was defending against exactly that, and at 0.3
      // a transposition ("chorme", 2 edits over 6 characters) still scores
      // past it. 0.4 is the budget that actually catches one.
      if (matches.length === 0) {
        const fuse = new Fuse(all, {
          keys: [
            { name: 'title', weight: 0.7 },
            { name: 'processName', weight: 0.3 }
          ],
          includeScore: true,
          threshold: 0.4,
          ignoreLocation: true
        })
        matches = fuse
          .search(trimmed)
          .map((r) => ({ window: r.item, score: r.score ?? 1 }))
      }

      matches.sort((a, b) => a.score - b.score)
      const items = matches.map((m) => toItem(m.window, m.score))

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
