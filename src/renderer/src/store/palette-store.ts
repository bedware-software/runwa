import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { ModuleId, PaletteItem } from '@shared/types'

/**
 * Palette store: search query, current results, selection, debounced search.
 *
 * Search flow:
 *  1. setQuery increments an in-flight request ID and schedules a debounced
 *     main-process call (120ms). Each new keystroke cancels the previous in
 *     flight request via IPC (main registry aborts the AbortController).
 *  2. Stale results (older requestId than the one we're waiting on) are
 *     dropped on arrival — belt-and-suspenders in case a cancel message was
 *     lost.
 */

const DEBOUNCE_MS = 120

interface PaletteState {
  query: string
  items: PaletteItem[]
  resolvedModuleId?: ModuleId
  activeModuleId?: ModuleId // pre-selected via direct-launch hotkey
  selectedIndex: number
  isLoading: boolean
  requestId: number

  setQuery: (query: string) => void
  selectNext: () => void
  selectPrev: () => void
  setSelectedIndex: (index: number) => void
  executeSelected: () => Promise<void>
  reset: () => void
  onPaletteShow: (initialModuleId?: ModuleId) => void
  /** Clear the scoped-module state and return to the home-screen picker. */
  unscope: () => void
  /**
   * Re-run the current search immediately (no debounce) — used by Ctrl+R
   * in the app-search scope after the rescan IPC has invalidated the main
   * process's enumeration cache, and after editing per-item state (e.g.
   * setting an alias) where we want the row chip to update without
   * losing the user's place in the list.
   *
   * `preserveSelection: true` keeps the cursor on the same item id once
   * the new results land. If the id is gone (filtered out, renamed),
   * we fall back to index 0 like a normal refresh.
   */
  refresh: (opts?: { preserveSelection?: boolean }) => void
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let pendingReadySignal = false

export const usePaletteStore = create<PaletteState>()(
  immer((set, get) => ({
    query: '',
    items: [],
    selectedIndex: 0,
    isLoading: false,
    requestId: 0,

    setQuery: (query: string) => {
      set((state) => {
        state.query = query
        state.selectedIndex = 0
      })

      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
      }

      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void runSearch(query, get, set)
      }, DEBOUNCE_MS)
    },

    selectNext: () => {
      set((s) => {
        if (s.items.length === 0) return
        s.selectedIndex = (s.selectedIndex + 1) % s.items.length
      })
    },

    selectPrev: () => {
      set((s) => {
        if (s.items.length === 0) return
        s.selectedIndex = (s.selectedIndex - 1 + s.items.length) % s.items.length
      })
    },

    setSelectedIndex: (index: number) => {
      set((s) => {
        if (s.items.length === 0) return
        s.selectedIndex = Math.max(0, Math.min(index, s.items.length - 1))
      })
    },

    executeSelected: async () => {
      const { items, selectedIndex } = get()
      const item = items[selectedIndex]
      if (!item) return
      try {
        const result = await window.electronAPI.modulesExecute(item)
        // Scope-into-module: the registry handed back a target module id.
        // Reset state as if the palette had just opened with that module
        // pre-selected — existing direct-launch code path, minus the
        // window-show side effects.
        if (result?.scopeToModuleId) {
          if (debounceTimer !== null) {
            clearTimeout(debounceTimer)
            debounceTimer = null
          }
          set((s) => {
            s.activeModuleId = result.scopeToModuleId
            s.query = ''
            s.items = []
            s.selectedIndex = 0
            s.resolvedModuleId = undefined
            s.isLoading = true
          })
          void runSearch('', get, set)
        }
      } catch (err) {
        console.warn('[palette] execute failed', err)
      }
    },

    refresh: (opts) => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      // Capture the currently-selected id BEFORE clearing items so we
      // can re-select it once the refreshed results arrive. Item ids
      // are stable across re-enumerations (app:/path on Mac, source:
      // path on Win), so this works even when the new search reorders
      // results — e.g. an alias change in `prioritize` mode bubbles
      // the row up but the cursor follows.
      const preserveId =
        opts?.preserveSelection
          ? get().items[get().selectedIndex]?.id
          : undefined
      // Clear items so ResultsList flips to its loading state — without
      // this the stale results stay on screen until the refreshed search
      // lands, which hides the rescan's progress from the user. Mirrors
      // the onPaletteShow / unscope reset pattern.
      set((s) => {
        s.items = []
        s.selectedIndex = 0
        s.isLoading = true
      })
      void runSearch(get().query, get, set, preserveId)
    },

    unscope: () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      set((s) => {
        s.activeModuleId = undefined
        s.resolvedModuleId = undefined
        s.query = ''
        s.items = []
        s.selectedIndex = 0
        s.isLoading = true
      })
      void runSearch('', get, set)
    },

    reset: () => {
      set((s) => {
        s.query = ''
        s.items = []
        s.selectedIndex = 0
        s.resolvedModuleId = undefined
        s.activeModuleId = undefined
        s.isLoading = false
      })
    },

    onPaletteShow: (initialModuleId?: ModuleId) => {
      // Cancel any pending debounced search from a previous session.
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }

      set((s) => {
        s.items = []
        s.selectedIndex = 0
        s.resolvedModuleId = undefined
        s.activeModuleId = initialModuleId
        s.isLoading = true
        s.query = ''
      })

      // Run the initial search immediately (no debounce) and signal main
      // when results are ready so it can reveal the window.
      pendingReadySignal = true
      void runSearch('', get, set)
    }
  }))
)

type Setter = (fn: (state: PaletteState) => void) => void
type Getter = () => PaletteState

async function runSearch(
  query: string,
  get: Getter,
  set: Setter,
  preserveSelectionId?: string
): Promise<void> {
  const prev = get()
  const newId = prev.requestId + 1

  // Cancel any older in-flight request.
  try {
    await window.electronAPI.modulesCancelSearch(prev.requestId)
  } catch {
    // ignore
  }

  set((s) => {
    s.requestId = newId
    s.isLoading = true
  })

  try {
    const result = await window.electronAPI.modulesSearch({
      requestId: newId,
      query,
      scopeModuleId: get().activeModuleId
    })

    // Drop stale results.
    if (get().requestId !== newId) return

    // If the caller asked to keep the cursor on a specific item (e.g. a
    // refresh after editing an alias), find its new index in the fresh
    // result list. findIndex returns -1 when the item is gone, which
    // Math.max collapses back to 0 — a normal "fresh result" landing.
    const nextIndex = preserveSelectionId
      ? Math.max(
          0,
          result.items.findIndex((it) => it.id === preserveSelectionId)
        )
      : 0

    set((s) => {
      s.items = result.items
      s.resolvedModuleId = result.resolvedModuleId
      s.selectedIndex = nextIndex
      s.isLoading = false
    })

    if (pendingReadySignal) {
      pendingReadySignal = false
      window.electronAPI.paletteReady()
    }

    // Modules can tag an item `autoExecute: true` to signal "just run
    // this now" — used by app-search's launch-on-alias mode. Fire the
    // normal execute IPC; main dismisses the palette on success. Only
    // the first matching item is honoured to prevent surprise
    // multi-launch if several carry the flag.
    const auto = result.items.find((i) => i.autoExecute)
    if (auto) {
      void window.electronAPI.modulesExecute(auto)
    }
  } catch (err) {
    console.warn('[palette] search failed', err)
    set((s) => {
      s.isLoading = false
    })
    if (pendingReadySignal) {
      pendingReadySignal = false
      window.electronAPI.paletteReady()
    }
  }
}
