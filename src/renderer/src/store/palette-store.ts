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

async function runSearch(query: string, get: Getter, set: Setter): Promise<void> {
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

    set((s) => {
      s.items = result.items
      s.resolvedModuleId = result.resolvedModuleId
      s.selectedIndex = 0
      s.isLoading = false
    })

    if (pendingReadySignal) {
      pendingReadySignal = false
      window.electronAPI.paletteReady()
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
