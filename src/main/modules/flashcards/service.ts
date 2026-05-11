import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { parseDeck, type ParsedCard, type ParsedDeck } from './parser'
import { flashcardsStore } from './store'
import { isDue, isMature } from './srs'
import { EXAMPLE_DECK, LEGACY_EXAMPLE_DECKS } from './example-deck'
import { DEFAULT_LLM_PROMPT, LEGACY_LLM_PROMPTS } from './default-prompt'
import { settingsStore } from '../../settings-store'

/**
 * Coordinator for on-disk decks. Owns the `<userData>/decks` folder,
 * caches parsed decks keyed by file mtime so a hot palette open doesn't
 * re-read every file, and exposes the two queries the IPC layer needs:
 * `listDecks()` (palette home screen) and `loadDeck(id)` (quiz UI).
 *
 * Decks are stored one file per deck. The filename without `.md` is
 * the deckId — that's what's used to key SRS state, so renaming the
 * file detaches the per-card history. We treat that as user-intent:
 * if you rename the file, you're giving the deck a new identity.
 */

export interface DeckSummary {
  id: string
  name: string
  /** Count of well-formed (single-correct-answer) cards. */
  total: number
  /** Subset of `total` that's scheduled for today or earlier. */
  due: number
  /** Subset of `total` whose SRS interval ≥ 21 days — "mature" in
   * Anki terms. The user's read on "have I actually learned this
   * deck or am I still cycling through the first reviews". */
  mature: number
  /** Subset of `total` that has NO SRS state at all — the deck has
   * never been quizzed for these cards. When this equals `total`
   * the whole deck is brand-new (distinct from "active": touched
   * but with due cards). Drives the palette's `new · ready to
   * start` row state. */
  untouched: number
  hasWarnings: boolean
  filePath: string
}

export interface FullDeck {
  id: string
  name: string
  cards: ParsedCard[]
  warnings: string[]
  filePath: string
}

interface CacheEntry {
  mtimeMs: number
  parsed: ParsedDeck
}

class FlashcardsService {
  private cache = new Map<string, CacheEntry>()

  /** Absolute path to the deck folder. Created on demand. */
  decksFolder(): string {
    return path.join(app.getPath('userData'), 'decks')
  }

  /** Absolute path to the editable LLM prompt file. Mirrors how
   * keyboard-remap exposes its rules YAML — read-only preview in
   * settings, edit in the system editor. */
  llmPromptPath(): string {
    return path.join(app.getPath('userData'), 'flashcards-llm-prompt.md')
  }

  /**
   * Make sure the LLM prompt file exists, and auto-upgrade an
   * untouched previous version to the current DEFAULT_LLM_PROMPT.
   *
   * On first run: write DEFAULT_LLM_PROMPT (carrying over any
   * customised value from the old `modules.flashcards.config.llmPrompt`
   * config key — the previous in-place editing UI).
   *
   * On subsequent runs: if the on-disk content byte-equals one of
   * `LEGACY_LLM_PROMPTS`, the user hasn't touched it since seeding,
   * so we replace it with the latest shipped version. Anything off
   * by a whitespace counts as a user edit and is left alone.
   */
  ensureLlmPromptFile(): void {
    const filePath = this.llmPromptPath()
    if (!fs.existsSync(filePath)) {
      let initial = DEFAULT_LLM_PROMPT
      try {
        const legacy = settingsStore.get().modules['flashcards']?.config?.llmPrompt
        if (typeof legacy === 'string' && legacy.length > 0) {
          initial = legacy
        }
      } catch {
        // settingsStore not ready yet — fall back to default; the
        // file will still get the shipped template, which is the
        // right thing for a fresh install.
      }
      try {
        fs.writeFileSync(filePath, initial, 'utf8')
      } catch (err) {
        console.warn('[flashcards] failed to seed LLM prompt file', err)
      }
      return
    }
    // Auto-upgrade: only fire when the on-disk content exactly
    // matches a previously-shipped version (i.e. user hasn't edited
    // it since they got it).
    let onDisk: string
    try {
      onDisk = fs.readFileSync(filePath, 'utf8')
    } catch {
      return
    }
    if (onDisk === DEFAULT_LLM_PROMPT) return // already current
    if (LEGACY_LLM_PROMPTS.includes(onDisk)) {
      try {
        fs.writeFileSync(filePath, DEFAULT_LLM_PROMPT, 'utf8')
        console.log(
          '[flashcards] upgraded untouched LLM prompt file to current version'
        )
      } catch (err) {
        console.warn('[flashcards] failed to upgrade LLM prompt file', err)
      }
    }
  }

  /**
   * Read the LLM prompt file's current content. Returns the shipped
   * default when the file is missing for any reason — the renderer
   * shouldn't have to guard against that.
   */
  readLlmPrompt(): string {
    const filePath = this.llmPromptPath()
    try {
      return fs.readFileSync(filePath, 'utf8')
    } catch {
      return DEFAULT_LLM_PROMPT
    }
  }

  /**
   * Overwrite the prompt file with the shipped DEFAULT_LLM_PROMPT,
   * regardless of current content. Destructive — caller must confirm
   * with the user first. Used by the Reset button in settings, and
   * also recovers cleanly from a corrupted / hand-mangled file.
   */
  resetLlmPromptToDefault(): void {
    const filePath = this.llmPromptPath()
    try {
      fs.writeFileSync(filePath, DEFAULT_LLM_PROMPT, 'utf8')
    } catch (err) {
      console.warn('[flashcards] failed to reset LLM prompt file', err)
    }
  }

  /**
   * Make sure the decks folder exists and seed `example.md` if the
   * folder is empty (fresh install). Also auto-upgrades a previously-
   * shipped untouched seed file to the current EXAMPLE_DECK when its
   * content byte-equals one of the LEGACY_EXAMPLE_DECKS — so users
   * who got the old example before we added topics / new keybindings
   * see the new content without having to delete the file. Files
   * that differ even by a whitespace are treated as user-edited and
   * left alone.
   */
  ensureFolder(): void {
    const dir = this.decksFolder()
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      console.warn('[flashcards] failed to mkdir decks folder', err)
      return
    }
    let entries: string[] = []
    try {
      entries = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))
    } catch {
      // ignore
    }
    const examplePath = path.join(dir, 'example.md')
    if (entries.length === 0) {
      try {
        fs.writeFileSync(examplePath, EXAMPLE_DECK, 'utf8')
      } catch (err) {
        console.warn('[flashcards] failed to seed example.md', err)
      }
      return
    }
    // Auto-upgrade an untouched legacy example. Read once, compare
    // against every known previous version. If the user customised
    // it (even slightly), all comparisons fail and we leave it alone.
    if (entries.includes('example.md')) {
      let onDisk: string
      try {
        onDisk = fs.readFileSync(examplePath, 'utf8')
      } catch {
        return
      }
      if (onDisk === EXAMPLE_DECK) return // already current
      const isUntouchedLegacy = LEGACY_EXAMPLE_DECKS.includes(onDisk)
      if (isUntouchedLegacy) {
        try {
          fs.writeFileSync(examplePath, EXAMPLE_DECK, 'utf8')
          this.cache.delete(examplePath)
          console.log('[flashcards] upgraded untouched example.md to current version')
        } catch (err) {
          console.warn('[flashcards] failed to upgrade example.md', err)
        }
      }
    }
  }

  /** Drop the parsed-deck cache so the next read hits disk. */
  reload(): void {
    this.cache.clear()
  }

  /** List every parsable deck in the folder with due-counts. Cheap to
   * call repeatedly — only re-parses files whose mtime changed. */
  listDecks(): DeckSummary[] {
    const dir = this.decksFolder()
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      // Folder might not exist yet — just return empty.
      return []
    }

    const summaries: DeckSummary[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.toLowerCase().endsWith('.md')) continue

      const filePath = path.join(dir, entry.name)
      const id = deckIdFromFilename(entry.name)
      const parsed = this.readDeck(filePath)
      if (!parsed) continue

      const state = flashcardsStore.getDeckState(id)
      const today = new Date()
      let due = 0
      let mature = 0
      let untouched = 0
      let total = 0
      for (const card of parsed.cards) {
        if (card.correctIndex < 0) continue // malformed, skip
        total++
        const s = state[card.id]
        if (s === undefined) untouched++
        if (isDue(s, today)) due++
        if (isMature(s)) mature++
      }

      summaries.push({
        id,
        name: parsed.title || id,
        total,
        due,
        mature,
        untouched,
        hasWarnings: parsed.warnings.length > 0,
        filePath
      })
    }
    summaries.sort((a, b) => a.name.localeCompare(b.name))
    return summaries
  }

  /**
   * Snapshot of the deck's learning state for the quiz summary
   * screen — used to show "was X mature → now Y mature" after a
   * session. Counts only well-formed cards (same definition as
   * `listDecks().total`). Returns zeros for unknown decks.
   */
  getDeckMastery(deckId: string): { mature: number; total: number } {
    const deck = this.loadDeck(deckId)
    if (!deck) return { mature: 0, total: 0 }
    const state = flashcardsStore.getDeckState(deckId)
    let mature = 0
    let total = 0
    for (const card of deck.cards) {
      if (card.correctIndex < 0) continue
      total++
      if (isMature(state[card.id])) mature++
    }
    return { mature, total }
  }

  /** Load a single deck for the quiz UI. Returns null when the file
   * went missing between palette listing and quiz launch. */
  loadDeck(id: string): FullDeck | null {
    const filePath = path.join(this.decksFolder(), `${id}.md`)
    const parsed = this.readDeck(filePath)
    if (!parsed) return null
    return {
      id,
      name: parsed.title || id,
      cards: parsed.cards,
      warnings: parsed.warnings,
      filePath
    }
  }

  private readDeck(filePath: string): ParsedDeck | null {
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return null
    }
    const cached = this.cache.get(filePath)
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.parsed
    }
    let raw: string
    try {
      raw = fs.readFileSync(filePath, 'utf8')
    } catch (err) {
      console.warn(`[flashcards] failed to read ${filePath}`, err)
      return null
    }
    const parsed = parseDeck(raw)
    this.cache.set(filePath, { mtimeMs: stat.mtimeMs, parsed })
    return parsed
  }
}

/**
 * `example.md` → `example`. We strip only the trailing `.md`; any
 * extra dots in the filename are preserved as-is so a deck literally
 * named `react.hooks.md` keeps `react.hooks` as its id (and SRS key).
 */
export function deckIdFromFilename(filename: string): string {
  return filename.replace(/\.md$/i, '')
}

export const flashcardsService = new FlashcardsService()
