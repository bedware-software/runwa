import { clipboard } from 'electron'
import type {
  FlashcardsStartQuizPayload,
  ModuleManifest,
  PaletteItem
} from '@shared/types'
import type { PaletteModule } from '../types'
import { paletteWindow } from '../../palette-window'
import { flashcardsService } from './service'
import { flashcardsStore } from './store'
import { isDue } from './srs'
import { openPathAsUser } from '../../elevation'

/**
 * Flashcards — search dialog over the on-disk deck folder. Selecting a
 * deck switches the same palette window into a quiz UI (the renderer
 * branches on a `flashcards:start-quiz` IPC event from main; no
 * separate BrowserWindow).
 *
 * Decks are plain Markdown files in `<userData>/decks/*.md`; see
 * `parser.ts` for the grammar. SRS state lives in
 * `runwa-flashcards.json` keyed by deckId + cardId.
 */

const CONFIG_OPEN_FOLDER = 'openDecksFolder'
const CONFIG_RELOAD = 'reloadDecks'
// LLM-prompt actions are NOT in the manifest's configFields (the
// section renders its own UI). They're plumbed through onAction so
// the renderer can `modulesAction('flashcards', 'editLlmPrompt' / 'copyLlmPrompt')`
// without bespoke IPC channels. Mirrors how keyboard-remap exposes
// 'openRules' as an unlisted action.
const ACTION_EDIT_PROMPT = 'editLlmPrompt'
const ACTION_COPY_PROMPT = 'copyLlmPrompt'
const ACTION_RESET_PROMPT = 'resetLlmPrompt'

interface StartQuizAction {
  kind: 'start-quiz'
  deckId: string
  /** Skip the SRS due-filter and quiz the entire deck — for cramming
   * before an interview. Triggered with Ctrl+Enter on a deck row. */
  cram: boolean
}

function isStartQuizAction(a: unknown): a is StartQuizAction {
  if (typeof a !== 'object' || a === null) return false
  const x = a as { kind?: unknown; deckId?: unknown; cram?: unknown }
  return (
    x.kind === 'start-quiz' &&
    typeof x.deckId === 'string' &&
    typeof x.cram === 'boolean'
  )
}

const MANIFEST: ModuleManifest = {
  id: 'flashcards',
  name: 'Flashcards',
  icon: 'library',
  kind: 'search',
  description:
    'Quiz yourself on Markdown-defined flashcard decks. Decks live in a folder under your user data directory; one .md file per deck. SuperMemo-style spaced repetition tracks per-card progress so review-due cards bubble up.',
  defaultEnabled: true,
  supportsDirectLaunch: true,
  defaultDirectLaunchHotkey: 'Ctrl+Alt+Super+F',
  configFields: [
    {
      key: CONFIG_OPEN_FOLDER,
      type: 'action',
      label: 'Decks folder',
      description:
        'Open the folder where deck files live. Drop .md files here (one deck per file). Format: # Deck title (optional), ## Topic (optional), ### Question, - [ ]/[x] options, > optional explanation.',
      buttonLabel: 'Open in Finder / Explorer',
      icon: 'folder-open'
    },
    {
      key: CONFIG_RELOAD,
      type: 'action',
      label: 'Reload decks from disk',
      description:
        'Drops the parsed-deck cache so the next palette open re-reads every file. Files are auto-reloaded when their mtime changes, so you usually only need this if you replaced a file via a tool that preserves mtimes.',
      buttonLabel: 'Reload now',
      icon: 'refresh-cw'
    }
  ]
}

export function createFlashcardsModule(): PaletteModule {
  // Make sure the folder + example deck + LLM prompt file all exist.
  // Cheap; safe to run on every registration — each ensure-call is a
  // no-op when the target file already exists (and untouched-legacy
  // seeds upgrade themselves silently).
  flashcardsService.ensureFolder()
  flashcardsService.ensureLlmPromptFile()

  return {
    manifest: MANIFEST,

    async search(query, signal) {
      if (signal.aborted) return []
      const trimmed = query.trim().toLowerCase()
      const decks = flashcardsService.listDecks()

      const items: Array<Omit<PaletteItem, 'moduleId'>> = []
      for (const deck of decks) {
        if (trimmed && !deck.name.toLowerCase().includes(trimmed)) continue

        // Six visual states for a deck row. Each one pairs a
        // distinct icon with a label so the user can read both
        // "what should I do" and "how well do I know this" at a
        // glance, without conflating different cases.
        //
        //   empty           → no cards                        book-open
        //   new             → T new · ready to start          book (closed)
        //                     (never quizzed — no card has SRS state)
        //   active          → N due · M/T mature              book-open
        //                     (touched, with due cards)
        //   reviewed-only   → M/T mature · still learning     clock
        //                     (due=0 but mature=0 — every card
        //                      seen recently, nothing solidly
        //                      learned yet)
        //   caught-up       → M/T mature · all caught up      check-circle-2
        //                     (due=0 with real mastery progress)
        //   fully-mastered  → Mastered · T/T                  graduation-cap
        const isUntouchedDeck =
          deck.total > 0 && deck.untouched === deck.total
        let dueLabel: string
        let iconHint: string
        let iconTooltip: string
        if (deck.total === 0) {
          dueLabel = 'no cards'
          iconHint = 'book-open'
          iconTooltip =
            'Empty deck — the .md file has no well-formed cards.'
        } else if (isUntouchedDeck) {
          // Never quizzed — visually distinct from "active" so the
          // user can tell "this is a brand-new deck" from "I'm
          // already partway through this one". Closed book ↔
          // open-book of active mirrors the metaphor: you haven't
          // opened this one yet.
          dueLabel = `${deck.total} new · ready to start`
          iconHint = 'book'
          iconTooltip = `Brand-new deck — never quizzed. ${deck.total} ${deck.total === 1 ? 'card is' : 'cards are'} waiting for the first review. Hit Enter to start.`
        } else if (deck.due === 0 && deck.mature === deck.total) {
          dueLabel = `Mastered · ${deck.total}/${deck.total}`
          iconHint = 'graduation-cap'
          iconTooltip = `Mastered — every card (${deck.total}/${deck.total}) is scheduled at least 21 days out. Solidly learned.`
        } else if (deck.due === 0 && deck.mature > 0) {
          dueLabel = `${deck.mature}/${deck.total} mature · all caught up`
          iconHint = 'check-circle-2'
          iconTooltip = `All caught up — no reviews due today. ${deck.mature} of ${deck.total} cards are mature (interval ≥ 21 days); ${deck.total - deck.mature} still learning.`
        } else if (deck.due === 0) {
          // Reviewed today (or scheduled by SRS), but nothing has
          // crossed the 21-day "mature" threshold yet — keep the
          // visual neutral so the user doesn't read it as a win.
          dueLabel = `${deck.mature}/${deck.total} mature · still learning`
          iconHint = 'clock'
          iconTooltip = `Still learning — you've reviewed every card today, but none has crossed the 21-day mature mark yet. Come back tomorrow to keep growing intervals.`
        } else {
          // Active = some cards already touched (state exists) AND
          // some are due today. Distinct from `new` (nothing touched
          // yet) — the `isUntouchedDeck` early branch above peels
          // that off.
          dueLabel = `${deck.due} due · ${deck.mature}/${deck.total} mature`
          iconHint = 'book-open'
          iconTooltip = `Active deck — ${deck.due} ${deck.due === 1 ? 'card is' : 'cards are'} due for review today. ${deck.mature}/${deck.total} mature so far.`
        }
        const warningSuffix = deck.hasWarnings ? ' · ⚠ check format' : ''
        const subtitle = `${dueLabel}${warningSuffix}`

        items.push({
          id: `deck:${deck.id}`,
          title: deck.name,
          subtitle,
          iconHint,
          iconTooltip,
          revealPath: deck.filePath,
          actionKind: 'start-quiz',
          // Default action: review-only. The renderer can mutate the
          // payload to set `cram: true` on Ctrl+Enter before invoking
          // execute — see palette-store.executeSelected.
          action: {
            kind: 'start-quiz',
            deckId: deck.id,
            cram: false
          } satisfies StartQuizAction
        })
      }
      return items
    },

    async execute(item) {
      if (!isStartQuizAction(item.action)) {
        console.warn('[flashcards] invalid action payload', item)
        return { dismissPalette: false }
      }
      const deck = flashcardsService.loadDeck(item.action.deckId)
      if (!deck) {
        console.warn(
          `[flashcards] deck disappeared: ${item.action.deckId} (file deleted between listing and execute?)`
        )
        return { dismissPalette: false }
      }

      // Filter to well-formed cards only, then either:
      //  - cram mode: every card, in shuffled order
      //  - review mode: only due cards (incl. brand-new), in shuffled order
      // Shuffle is done here so the renderer doesn't need to worry about
      // SRS internals or randomness — it just walks the list it gets.
      const state = flashcardsStore.getDeckState(deck.id)
      const today = new Date()
      const eligible = deck.cards.filter((c) => c.correctIndex >= 0)
      const candidates = item.action.cram
        ? eligible
        : eligible.filter((c) => isDue(state[c.id], today))
      const shuffled = shuffle(candidates.map((c) => c.id))

      // Shuffle option order within every card. Without this, decks
      // where the author put the correct answer at the same position
      // across cards (a common LLM bias — "[x] usually lands on the
      // 2nd / 3rd line") would leak that pattern to the quizzer.
      // Each card gets its own permutation, with correctIndex
      // remapped so it still points at the right option. The shuffle
      // happens ONCE per session (not per render), so navigating
      // back to a card via ← shows the same order — re-shuffling on
      // revisit would feel like the UI is fighting the user.
      const shuffledCards = deck.cards.map(shuffleCardOptions)

      const payload: FlashcardsStartQuizPayload = {
        deck: {
          id: deck.id,
          name: deck.name,
          cards: shuffledCards,
          warnings: deck.warnings
        },
        quizCardIds: shuffled,
        cram: item.action.cram,
        initialMastery: flashcardsService.getDeckMastery(deck.id)
      }

      // Push the deck to the renderer; it switches into quiz mode in
      // the same palette window. We return `dismissPalette: false` to
      // keep the palette open — the quiz IS the palette right now.
      const win = paletteWindow.getBrowserWindow()
      if (win) {
        win.webContents.send('flashcards:start-quiz', payload)
      }
      return { dismissPalette: false }
    },

    async onAction(key) {
      if (key === CONFIG_OPEN_FOLDER) {
        flashcardsService.ensureFolder()
        try {
          await openPathAsUser(flashcardsService.decksFolder())
        } catch (err) {
          console.warn('[flashcards] failed to open decks folder', err)
        }
        return
      }
      if (key === CONFIG_RELOAD) {
        flashcardsService.reload()
        return
      }
      if (key === ACTION_EDIT_PROMPT) {
        // Make sure the file exists before handing it to the system
        // editor — opening a missing path is a silent
        // no-op on macOS.
        flashcardsService.ensureLlmPromptFile()
        try {
          await openPathAsUser(flashcardsService.llmPromptPath())
        } catch (err) {
          console.warn('[flashcards] failed to open LLM prompt file', err)
        }
        return
      }
      if (key === ACTION_COPY_PROMPT) {
        // Read fresh from disk on every copy so external edits land
        // on the clipboard immediately, even if the renderer's
        // cached preview is stale. Main-process `clipboard.writeText`
        // is reliable in Electron — `navigator.clipboard.writeText`
        // in the renderer can fail without explicit permissions.
        try {
          clipboard.writeText(flashcardsService.readLlmPrompt())
        } catch (err) {
          console.warn('[flashcards] clipboard.writeText failed', err)
        }
        return
      }
      if (key === ACTION_RESET_PROMPT) {
        // Destructive — the renderer is responsible for confirming
        // before firing this. Service overwrites the file with the
        // shipped DEFAULT_LLM_PROMPT regardless of current content,
        // so this also recovers from a hand-mangled file.
        flashcardsService.resetLlmPromptToDefault()
        return
      }
    }
  }
}

/** In-place Fisher-Yates returning the shuffled copy. Quality of
 * randomness doesn't matter (this isn't a casino) — Math.random is
 * fine and avoids pulling in a dependency. */
function shuffle<T>(input: T[]): T[] {
  const out = input.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Permute the options of a single card and remap correctIndex to
 * follow the option it used to point at. Malformed cards
 * (correctIndex < 0) are returned untouched — they're filtered out
 * before quiz anyway, and we don't want to invent a "correct"
 * answer for them.
 *
 * Permutation strategy: build an array of original indices, shuffle
 * THAT, then rebuild options from the shuffled indices. Locating
 * the new correctIndex is then just `indices.indexOf(oldCorrect)`.
 * Slightly less efficient than swapping options in-place + tracking
 * the moving "correct" position, but several times clearer to read.
 */
function shuffleCardOptions<C extends { options: unknown[]; correctIndex: number }>(
  card: C
): C {
  if (card.correctIndex < 0) return card
  if (card.options.length <= 1) return card
  const indices = card.options.map((_, i) => i)
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  return {
    ...card,
    options: indices.map((i) => card.options[i]),
    correctIndex: indices.indexOf(card.correctIndex)
  }
}

