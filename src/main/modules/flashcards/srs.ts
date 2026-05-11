/**
 * SuperMemo-2 ("SM-2") spaced-repetition scheduling, MCQ-flavoured.
 *
 * Each card carries: ease factor (ef), current interval (days), reps
 * (consecutive successful answers), and lastReview / nextReview ISO
 * dates. Brand-new cards have no entry — the caller treats "missing"
 * as "due now".
 *
 * The caller maps a multiple-choice answer to a quality 0..5 (see
 * `qualityFromAnswer`) and feeds it to `applyAnswer` to get the next
 * state.
 */

export interface CardState {
  ef: number
  interval: number
  reps: number
  lastReview: string // ISO date (YYYY-MM-DD)
  nextReview: string // ISO date (YYYY-MM-DD)
}

export type AnswerOutcome = 'correct' | 'incorrect' | 'skipped'

export const DEFAULT_EF = 2.5
export const MIN_EF = 1.3

export function qualityFromAnswer(outcome: AnswerOutcome): number {
  // SM-2 quality scale: 0–2 = fail (resets reps), 3–5 = pass.
  // Skipped (Space pressed without selecting) → 0 (Again, hardest miss).
  // Wrong pick → 1 (Again, near-miss). Correct pick → 4 (Good).
  if (outcome === 'correct') return 4
  if (outcome === 'incorrect') return 1
  return 0
}

/** Compute next-state from current state + the user's quality rating. */
export function applyAnswer(
  prev: CardState | undefined,
  quality: number,
  today: Date = new Date()
): CardState {
  const ef = prev?.ef ?? DEFAULT_EF
  const reps = prev?.reps ?? 0

  let nextInterval: number
  let nextReps: number

  if (quality < 3) {
    nextInterval = 1
    nextReps = 0
  } else if (reps === 0) {
    nextInterval = 1
    nextReps = 1
  } else if (reps === 1) {
    nextInterval = 6
    nextReps = 2
  } else {
    nextInterval = Math.max(1, Math.round((prev?.interval ?? 1) * ef))
    nextReps = reps + 1
  }

  const nextEf = Math.max(
    MIN_EF,
    ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
  )

  return {
    ef: nextEf,
    interval: nextInterval,
    reps: nextReps,
    lastReview: toIsoDate(today),
    nextReview: toIsoDate(addDays(today, nextInterval))
  }
}

/** True if this card should be shown today (or was never shown). */
export function isDue(state: CardState | undefined, today: Date = new Date()): boolean {
  if (!state) return true
  return state.nextReview <= toIsoDate(today)
}

/**
 * Anki convention: a card is "mature" once its scheduled interval is
 * ≥ 21 days. Until then it's still in the learning phase — the
 * intervals 1d / 6d / ~15d (the first three correct reviews) are too
 * short to count as solidly learned. Used by the palette + summary
 * to show real progress instead of "session complete" alone.
 */
export const MATURE_INTERVAL_DAYS = 21

export function isMature(state: CardState | undefined): boolean {
  return state !== undefined && state.interval >= MATURE_INTERVAL_DAYS
}

/** Inclusive day offset between two ISO dates ("YYYY-MM-DD"). */
export function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00Z').getTime()
  const db = new Date(b + 'T00:00:00Z').getTime()
  return Math.round((db - da) / 86_400_000)
}

export function toIsoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime())
  out.setDate(out.getDate() + days)
  return out
}
