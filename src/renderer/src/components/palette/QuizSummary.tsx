import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, XCircle, Clock, GraduationCap } from 'lucide-react'
import type { FlashcardsDeckMastery } from '@shared/types'
import type { QuizSession } from '@/store/palette-store'

/**
 * Final screen rendered after the user advances past the last card in
 * a quiz session. Summarises score, the next-review distribution, and
 * surfaces a hint that Esc returns to the deck list.
 */
export function QuizSummary({ quiz }: { quiz: QuizSession }) {
  const total = quiz.quizCardIds.length
  const correct = countOutcome(quiz, 'correct')
  const incorrect = countOutcome(quiz, 'incorrect')
  const skipped = countOutcome(quiz, 'skipped')
  const accuracy =
    total > 0 ? Math.round((correct / total) * 100) : 0

  const nextReviewBuckets = useMemo(() => buildBuckets(quiz), [quiz])

  // Post-session mastery snapshot. Fetched once on mount — by the
  // time the summary renders, every answer has already been
  // committed to the SRS store, so the new mature count is final.
  const [finalMastery, setFinalMastery] = useState<FlashcardsDeckMastery | null>(
    null
  )
  useEffect(() => {
    let cancelled = false
    void window.electronAPI
      .flashcardsGetDeckMastery(quiz.deck.id)
      .then((m) => {
        if (!cancelled) setFinalMastery(m)
      })
    return () => {
      cancelled = true
    }
  }, [quiz.deck.id])

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8 py-6 gap-5 text-center">
      <div className="text-sm text-muted-foreground uppercase tracking-wide">
        {quiz.deck.name} · session complete
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-4xl font-semibold tabular-nums">{correct}</span>
        <span className="text-2xl text-muted-foreground">/ {total}</span>
        <span className="ml-2 text-sm text-muted-foreground">
          ({accuracy}%)
        </span>
      </div>

      <div className="flex items-center gap-4 text-sm">
        <span className="flex items-center gap-1.5 text-emerald-600">
          <CheckCircle2 size={14} /> {correct}
        </span>
        <span className="flex items-center gap-1.5 text-red-600">
          <XCircle size={14} /> {incorrect}
        </span>
        {skipped > 0 && (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Clock size={14} /> {skipped} skipped
          </span>
        )}
      </div>

      {nextReviewBuckets.length > 0 && (
        <div className="text-sm text-muted-foreground max-w-md">
          Next reviews:&nbsp;
          {nextReviewBuckets.map((b, i) => (
            <span key={b.label}>
              {i > 0 && ' · '}
              <span className="text-foreground">{b.count}</span> {b.label}
            </span>
          ))}
        </div>
      )}

      {finalMastery && finalMastery.total > 0 && (
        <MasteryRow
          before={quiz.initialMastery}
          after={finalMastery}
        />
      )}

      <div className="text-xs text-muted-foreground pt-1">
        Esc to return to decks · ← to revisit the last card
      </div>
    </div>
  )
}

/**
 * Compact "you actually learned X new cards this session" row.
 * Renders nothing flashy when before == after (no progress to
 * report) so the user isn't lied to about a session that was just
 * keeping mature cards mature.
 */
function MasteryRow({
  before,
  after
}: {
  before: FlashcardsDeckMastery
  after: FlashcardsDeckMastery
}) {
  const gained = after.mature - before.mature
  const pctAfter =
    after.total > 0 ? Math.round((after.mature / after.total) * 100) : 0
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <GraduationCap size={14} className="text-foreground/70" />
      <span>
        Deck mastery:&nbsp;
        <span className="text-foreground">
          {before.mature} → {after.mature}
        </span>{' '}
        mature of {after.total}
        {gained > 0 && (
          <span className="ml-1 text-emerald-600">
            (+{gained})
          </span>
        )}
        {gained < 0 && (
          <span className="ml-1 text-red-600">({gained})</span>
        )}
        <span className="ml-2 text-xs text-muted-foreground/80">
          {pctAfter}%
        </span>
      </span>
    </div>
  )
}

function countOutcome(quiz: QuizSession, outcome: string): number {
  let n = 0
  for (const r of Object.values(quiz.results)) {
    if (r.outcome === outcome) n++
  }
  return n
}

interface Bucket {
  label: string
  count: number
}

/**
 * Group the post-quiz next-review dates into human buckets. Anything
 * within today/tomorrow is called out exactly; further out we coarsen
 * to "in N days" / "in N weeks" so the summary line stays scannable.
 */
function buildBuckets(quiz: QuizSession): Bucket[] {
  const today = isoToday()
  const buckets: Record<string, number> = {}
  for (const r of Object.values(quiz.results)) {
    if (!r.nextReview) continue
    const days = daysFromToday(today, r.nextReview)
    const label =
      days <= 0
        ? 'today'
        : days === 1
          ? 'tomorrow'
          : days < 7
            ? `in ${days}d`
            : days < 30
              ? `in ${Math.round(days / 7)}w`
              : `in ${Math.round(days / 30)}mo`
    buckets[label] = (buckets[label] ?? 0) + 1
  }
  // Maintain a roughly chronological order in the rendered line.
  const ORDER = ['today', 'tomorrow', 'in 2d', 'in 3d', 'in 4d', 'in 5d', 'in 6d']
  const known = ORDER.filter((k) => k in buckets).map((label) => ({
    label,
    count: buckets[label]
  }))
  const others = Object.entries(buckets)
    .filter(([k]) => !ORDER.includes(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, count]) => ({ label, count }))
  return [...known, ...others]
}

function isoToday(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function daysFromToday(todayIso: string, targetIso: string): number {
  const today = new Date(todayIso + 'T00:00:00Z').getTime()
  const target = new Date(targetIso + 'T00:00:00Z').getTime()
  return Math.round((target - today) / 86_400_000)
}
