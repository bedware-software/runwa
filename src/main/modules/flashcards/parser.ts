import { createHash } from 'node:crypto'

/**
 * Parse a `.md` deck file into a Deck object.
 *
 * Two flavours, auto-detected per file:
 *
 *   FLAT MODE — no `###` heading anywhere in the file.
 *     # Deck title (optional)
 *     ## Question text
 *     - [ ] / [x] options
 *     > optional explanation
 *
 *   TOPIC MODE — at least one `###` heading present.
 *     # Deck title (optional)
 *     ## Topic name (groups subsequent cards)
 *     ### Question text
 *     - [ ] / [x] options
 *     > optional explanation
 *
 *   Cards in topic mode that appear before the first `##` heading have
 *   no topic (they render with no chip). Switching from flat to topic
 *   format is non-destructive: rename `##` → `###` and add `##` topic
 *   headings, card ids stay the same (id is hashed from the question
 *   text, not the heading level).
 *
 * Cards with no correct option, fewer than 2 options, or more than 1
 * correct option are surfaced as `warnings` so the UI can flag the
 * deck without silently dropping anything. The valid cards are still
 * returned so the user can quiz on the rest.
 */

export interface ParsedCard {
  id: string
  question: string
  options: ParsedOption[]
  /** Index into `options` of the single correct answer, or -1 if the
   * card is malformed (no correct, or multiple correct). The UI skips
   * malformed cards during quiz; they still count toward `total`. */
  correctIndex: number
  explanation?: string
  /** Topic this card belongs to (from the most recent `## heading`
   * before this card in topic-mode files). Undefined in flat-mode
   * files and for cards that appear before the first `##`. */
  topic?: string
}

export interface ParsedOption {
  text: string
}

export interface ParsedDeck {
  /** From `# title` line, or filename fallback set by the caller. */
  title?: string
  cards: ParsedCard[]
  /** Per-card or per-file diagnostics — empty array on a clean parse. */
  warnings: string[]
}

const CHECKBOX_LINE = /^\s*-\s*\[([ xX])\]\s*(.*)$/
const H1_HEADING = /^\s*#\s+(.*\S)\s*$/
const H2_HEADING = /^\s*##\s+(.*\S)\s*$/
const H3_HEADING = /^\s*###\s+(.*\S)\s*$/
const BLOCKQUOTE = /^\s*>\s?(.*)$/

export function parseDeck(raw: string): ParsedDeck {
  const lines = raw.split(/\r?\n/)
  const cards: ParsedCard[] = []
  const warnings: string[] = []
  let title: string | undefined
  let currentTopic: string | undefined

  // Topic-mode is a per-file decision: if there's any `###` heading
  // anywhere in the file, `##` headings are interpreted as topics and
  // `###` as questions. Otherwise `##` is the question level (legacy
  // flat-mode files keep working with no edits).
  const topicMode = lines.some((l) => H3_HEADING.test(l))
  const questionRe = topicMode ? H3_HEADING : H2_HEADING

  let cursor = 0
  // Skip leading blank lines and (optionally) capture the title.
  while (cursor < lines.length) {
    const line = lines[cursor]
    if (line.trim() === '') {
      cursor++
      continue
    }
    const titleMatch = line.match(H1_HEADING)
    if (titleMatch) {
      title = titleMatch[1].trim()
      cursor++
    }
    break
  }

  while (cursor < lines.length) {
    const line = lines[cursor]

    // Topic switch: only meaningful in topic-mode. In flat-mode the
    // questionRe handler below would match `##` first anyway, so this
    // branch is dead code for flat files.
    if (topicMode) {
      const tMatch = line.match(H2_HEADING)
      if (tMatch) {
        currentTopic = tMatch[1].trim()
        cursor++
        continue
      }
    }

    const qMatch = line.match(questionRe)
    if (!qMatch) {
      cursor++
      continue
    }
    const cardStartLine = cursor
    cursor++

    // Question body: everything up to the first checkbox line OR the
    // next question/topic heading. Multi-line / code-fenced questions
    // are honoured verbatim. We trim outer blanks but preserve
    // interior blank lines.
    const questionLines: string[] = [qMatch[1]]
    while (cursor < lines.length) {
      const l = lines[cursor]
      if (
        CHECKBOX_LINE.test(l) ||
        questionRe.test(l) ||
        (topicMode && H2_HEADING.test(l))
      )
        break
      questionLines.push(l)
      cursor++
    }
    const question = questionLines.join('\n').replace(/\n+$/, '').trim()

    // Options: consecutive checkbox lines.
    const options: ParsedOption[] = []
    const correctIndices: number[] = []
    while (cursor < lines.length) {
      const m = lines[cursor].match(CHECKBOX_LINE)
      if (!m) break
      const isCorrect = m[1].toLowerCase() === 'x'
      options.push({ text: m[2].trim() })
      if (isCorrect) correctIndices.push(options.length - 1)
      cursor++
    }

    // Optional explanation: blockquote lines following the options
    // (skipping intervening blank lines).
    while (cursor < lines.length && lines[cursor].trim() === '') cursor++
    const explanationLines: string[] = []
    while (cursor < lines.length) {
      const m = lines[cursor].match(BLOCKQUOTE)
      if (!m) break
      explanationLines.push(m[1])
      cursor++
    }
    const explanation =
      explanationLines.length > 0
        ? explanationLines.join('\n').trim() || undefined
        : undefined

    let correctIndex = -1
    if (options.length < 2) {
      warnings.push(
        `card at line ${cardStartLine + 1} ("${truncate(question, 40)}"): needs at least 2 options`
      )
    } else if (correctIndices.length === 0) {
      warnings.push(
        `card at line ${cardStartLine + 1} ("${truncate(question, 40)}"): no correct option marked`
      )
    } else if (correctIndices.length > 1) {
      warnings.push(
        `card at line ${cardStartLine + 1} ("${truncate(question, 40)}"): multiple correct options not yet supported, skipping`
      )
    } else {
      correctIndex = correctIndices[0]
    }

    cards.push({
      id: cardId(question),
      question,
      options,
      correctIndex,
      explanation,
      topic: currentTopic
    })
  }

  return { title, cards, warnings }
}

/**
 * Stable per-card id: SHA-1 of the normalised question text, truncated
 * to 12 hex chars. Normalisation collapses whitespace runs and lower-
 * cases, so cosmetic edits (extra spaces, casing) don't reset SRS
 * progress. Material edits (wording change) DO change the id, which is
 * correct — the card is now a different question.
 */
export function cardId(question: string): string {
  const normalised = question.toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha1').update(normalised).digest('hex').slice(0, 12)
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}
