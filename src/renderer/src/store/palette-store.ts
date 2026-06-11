import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type {
  FlashcardAnswerOutcome,
  FlashcardsStartQuizPayload,
  ModuleId,
  PaletteItem
} from '@shared/types'

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

/** One card's result inside the active quiz session — sparse map keyed
 * by cardId. `selected` is the option index the user picked, or null
 * for a skipped card. */
export interface QuizCardResult {
  selected: number | null
  outcome: FlashcardAnswerOutcome
  /** ISO date returned by main after recording the SRS update. Drives
   * the "next review" line on the quiz summary. */
  nextReview?: string
}

export interface QuizSession extends FlashcardsStartQuizPayload {
  /** 0-based index into `quizCardIds`. */
  index: number
  /** Keyed by cardId. Cards without an entry haven't been answered yet. */
  results: Record<string, QuizCardResult>
  /** True once the user has moved past the last card — the renderer
   * shows the summary screen instead of a card. */
  finished: boolean
}

interface PaletteState {
  query: string
  items: PaletteItem[]
  resolvedModuleId?: ModuleId
  activeModuleId?: ModuleId // pre-selected via direct-launch hotkey
  selectedIndex: number
  isLoading: boolean
  requestId: number

  /** Active quiz session, or null when the palette is in normal
   * search mode. Switched on by `flashcards:start-quiz` (sent by the
   * flashcards module's execute() in main), switched off by
   * `exitQuiz()` (Esc inside the quiz UI). */
  quiz: QuizSession | null

  setQuery: (query: string) => void
  selectNext: () => void
  selectPrev: () => void
  setSelectedIndex: (index: number) => void
  executeSelected: (overrides?: { cram?: boolean }) => Promise<void>
  /**
   * Alt+Tab-style hotkey re-press (`palette:activate-second` from main):
   * execute the second result row — for window-switcher that's the
   * previously focused window. Falls back to the only row when just one
   * matches, and to plain dismissal when the list is empty. If the search
   * is still in flight (fast double-tap of the hotkey), the request is
   * queued and fires the moment results land.
   */
  activateSecond: () => void
  /**
   * Close the OS window behind the selected window-switcher row
   * (Ctrl/Cmd+D). On success the row is removed optimistically instead of
   * refreshing — the OS-side close is async (macOS AX press, Windows
   * WM_CLOSE), so an immediate re-enumeration would resurrect the closing
   * window for a frame or two.
   */
  closeSelected: () => Promise<void>
  reset: () => void
  onPaletteShow: (initialModuleId?: ModuleId) => void
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

  /* ─── Quiz mode ─────────────────────────────────────────────────── */

  startQuiz: (payload: FlashcardsStartQuizPayload) => void
  exitQuiz: () => void
  /** Record the user's MCQ answer. Computes outcome from
   * `correctIndex` and posts to main; the new SRS state is written
   * back into results[cardId].nextReview. */
  submitAnswer: (optionIndex: number) => Promise<void>
  /** Mark the current card as skipped (Space pressed without choosing
   * an option). Equivalent to a hard fail in SM-2. */
  skipCurrent: () => Promise<void>
  /** Advance to the next card; sets `finished` past the last card. */
  nextCard: () => void
  /** Go back one card (read-only — doesn't reset the result). */
  prevCard: () => void
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let pendingReadySignal = false
/** Set when `activateSecond` fires while the search is still loading (the
 * user double-tapped the hotkey faster than the initial enumeration).
 * `runSearch` re-runs the activation once results land. Cleared whenever
 * the user shows intent to stay in the palette (typing) and on every
 * show/reset so it can't leak into the next session. */
let pendingActivateSecond = false

export const usePaletteStore = create<PaletteState>()(
  immer((set, get) => ({
    query: '',
    items: [],
    selectedIndex: 0,
    isLoading: false,
    requestId: 0,
    quiz: null,

    setQuery: (query: string) => {
      // Typing means the user is staying in the palette — drop any queued
      // double-tap activation so it can't fire on the new query's results.
      pendingActivateSecond = false
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

    executeSelected: async (overrides) => {
      const { items, selectedIndex } = get()
      const item = items[selectedIndex]
      if (!item) return
      // Ctrl+Enter on a flashcards deck row sets cram=true. We mutate
      // a shallow clone of `item.action` so the in-store version (and
      // anyone re-clicking the row) stays in default review mode.
      let payload = item
      if (overrides?.cram && item.actionKind === 'start-quiz') {
        const action = (item.action ?? {}) as Record<string, unknown>
        payload = { ...item, action: { ...action, cram: true } }
      }
      try {
        await window.electronAPI.modulesExecute(payload)
      } catch (err) {
        console.warn('[palette] execute failed', err)
      }
    },

    activateSecond: () => {
      const s = get()
      if (s.isLoading) {
        pendingActivateSecond = true
        return
      }
      // Row 2 is the previous window (the list is z-ordered with the
      // current window first). With a single row, re-focusing it is the
      // only sensible target; with none, behave like a plain dismissal.
      const target = Math.min(1, s.items.length - 1)
      if (target < 0) {
        void window.electronAPI.paletteHide()
        return
      }
      set((st) => {
        st.selectedIndex = target
      })
      void get().executeSelected()
    },

    closeSelected: async () => {
      const { items, selectedIndex } = get()
      const item = items[selectedIndex]
      if (!item || item.moduleId !== 'window-switcher') return
      let delivered = false
      try {
        delivered = await window.electronAPI.windowSwitcherCloseWindow(item)
      } catch (err) {
        console.warn('[window-switcher] close failed', err)
        return
      }
      if (!delivered) return
      // Look the row up by id — the list may have shifted during the await.
      set((s) => {
        const idx = s.items.findIndex((i) => i.id === item.id)
        if (idx !== -1) s.items.splice(idx, 1)
        if (s.selectedIndex >= s.items.length) {
          s.selectedIndex = Math.max(0, s.items.length - 1)
        }
      })
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
      // the onPaletteShow reset pattern.
      set((s) => {
        s.items = []
        s.selectedIndex = 0
        s.isLoading = true
      })
      void runSearch(get().query, get, set, preserveId)
    },

    reset: () => {
      pendingActivateSecond = false
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
      pendingActivateSecond = false

      set((s) => {
        s.items = []
        s.selectedIndex = 0
        s.resolvedModuleId = undefined
        s.activeModuleId = initialModuleId
        s.isLoading = true
        s.query = ''
        // A new palette session always lands in search mode, even if a
        // quiz was abandoned mid-card by the user closing the window.
        s.quiz = null
      })

      // Run the initial search immediately (no debounce) and signal main
      // when results are ready so it can reveal the window.
      pendingReadySignal = true
      void runSearch('', get, set)
    },

    /* ─── Quiz mode ─────────────────────────────────────────────── */

    startQuiz: (payload) => {
      set((s) => {
        s.quiz = {
          ...payload,
          index: 0,
          results: {},
          finished: payload.quizCardIds.length === 0
        }
        // Quiz takes over the whole window — clear the search state so
        // returning to the deck list (Esc) lands clean.
        s.items = []
        s.isLoading = false
      })
    },

    exitQuiz: () => {
      set((s) => {
        s.quiz = null
        // Reset to a fresh search so the deck-list view comes back
        // showing the loading state while the refresh below lands.
        s.items = []
        s.selectedIndex = 0
        s.isLoading = true
        s.query = ''
      })
      // Re-fetch the deck list so due-counts reflect any answers we
      // just recorded.
      void runSearch('', get, set)
    },

    submitAnswer: async (optionIndex) => {
      const quiz = get().quiz
      if (!quiz || quiz.finished) return
      const cardId = quiz.quizCardIds[quiz.index]
      if (!cardId) return
      // Guard against double-submit: once a card has a result, the next
      // 1-4 keystroke is a no-op (renderer's onKeyDown should also
      // gate on `result` to avoid even reaching here).
      if (quiz.results[cardId]) return

      const card = quiz.deck.cards.find((c) => c.id === cardId)
      if (!card) return
      const outcome: FlashcardAnswerOutcome =
        optionIndex === card.correctIndex ? 'correct' : 'incorrect'

      set((s) => {
        if (!s.quiz) return
        s.quiz.results[cardId] = { selected: optionIndex, outcome }
      })

      try {
        const newState = await window.electronAPI.flashcardsAnswer({
          deckId: quiz.deck.id,
          cardId,
          outcome
        })
        set((s) => {
          if (!s.quiz) return
          const r = s.quiz.results[cardId]
          if (r) r.nextReview = newState.nextReview
        })
      } catch (err) {
        console.warn('[flashcards] answer record failed', err)
      }
    },

    skipCurrent: async () => {
      const quiz = get().quiz
      if (!quiz || quiz.finished) return
      const cardId = quiz.quizCardIds[quiz.index]
      if (!cardId) return
      if (quiz.results[cardId]) return
      set((s) => {
        if (!s.quiz) return
        s.quiz.results[cardId] = { selected: null, outcome: 'skipped' }
      })
      try {
        const newState = await window.electronAPI.flashcardsAnswer({
          deckId: quiz.deck.id,
          cardId,
          outcome: 'skipped'
        })
        set((s) => {
          if (!s.quiz) return
          const r = s.quiz.results[cardId]
          if (r) r.nextReview = newState.nextReview
        })
      } catch (err) {
        console.warn('[flashcards] skip record failed', err)
      }
    },

    nextCard: () => {
      set((s) => {
        if (!s.quiz) return
        if (s.quiz.index >= s.quiz.quizCardIds.length - 1) {
          s.quiz.finished = true
          return
        }
        s.quiz.index++
      })
    },

    prevCard: () => {
      set((s) => {
        if (!s.quiz) return
        if (s.quiz.finished) {
          // Pressing ← from the summary jumps back to the last card so
          // the user can re-read the explanation without re-answering.
          s.quiz.finished = false
          return
        }
        if (s.quiz.index === 0) return
        s.quiz.index--
      })
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

    // A hotkey double-tap raced the initial enumeration — re-run the
    // Alt+Tab-style activation now that the rows exist. isLoading is
    // false at this point, so the re-entry executes instead of re-queuing.
    if (pendingActivateSecond) {
      pendingActivateSecond = false
      get().activateSecond()
      return
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
    pendingActivateSecond = false
    set((s) => {
      s.isLoading = false
    })
    if (pendingReadySignal) {
      pendingReadySignal = false
      window.electronAPI.paletteReady()
    }
  }
}
