import Store from 'electron-store'
import { applyAnswer, type CardState } from './srs'

/**
 * Persistence layer for per-card SRS state. Lives in its own
 * `runwa-flashcards.json` file (separate from the main settings file)
 * so the schema can grow without polluting `settings:get` responses
 * and so the file size doesn't bloat the settings IPC payload that
 * goes to every renderer on every change.
 *
 * Structure:
 *   { decks: { [deckId]: { [cardId]: CardState } } }
 */

interface PersistedShape {
  decks: Record<string, Record<string, CardState>>
}

const DEFAULTS: PersistedShape = { decks: {} }

class FlashcardsStore {
  private store: Store<PersistedShape> | null = null

  init(): void {
    if (this.store) return
    this.store = new Store<PersistedShape>({
      name: 'runwa-flashcards',
      defaults: DEFAULTS
    })
  }

  private ensureInit(): Store<PersistedShape> {
    if (!this.store) throw new Error('FlashcardsStore used before init()')
    return this.store
  }

  /** Get all SRS state for a single deck. Empty object if the deck has
   * never been reviewed. */
  getDeckState(deckId: string): Record<string, CardState> {
    const s = this.ensureInit()
    return s.store.decks?.[deckId] ?? {}
  }

  /** Get a single card's SRS state, or undefined for new cards. */
  getCardState(deckId: string, cardId: string): CardState | undefined {
    return this.getDeckState(deckId)[cardId]
  }

  /**
   * Apply a quality rating to a card and persist the new state.
   * Returns the freshly-computed state so the caller can show
   * "next review in X days" in the post-card UI.
   */
  recordAnswer(deckId: string, cardId: string, quality: number): CardState {
    const s = this.ensureInit()
    const prev = this.getCardState(deckId, cardId)
    const next = applyAnswer(prev, quality)

    const decks = { ...(s.store.decks ?? {}) }
    const deck = { ...(decks[deckId] ?? {}) }
    deck[cardId] = next
    decks[deckId] = deck
    s.store = { decks }
    return next
  }

  /**
   * Drop SRS state for a deck — used when the file is deleted from
   * disk and the user wants to start the deck fresh on next import.
   * Not wired to UI yet; reserved for a future "Reset progress" action.
   */
  clearDeck(deckId: string): void {
    const s = this.ensureInit()
    if (!s.store.decks?.[deckId]) return
    const decks = { ...s.store.decks }
    delete decks[deckId]
    s.store = { decks }
  }
}

export const flashcardsStore = new FlashcardsStore()
