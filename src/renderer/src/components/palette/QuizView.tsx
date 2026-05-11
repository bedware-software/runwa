import { useMemo } from 'react'
import { CheckCircle2, XCircle, Circle, AlertTriangle, Hash } from 'lucide-react'
import type { FlashcardCard } from '@shared/types'
import { cn } from '@/lib/utils'
import type { QuizSession } from '@/store/palette-store'
import { QuizSummary } from './QuizSummary'

/**
 * Single-card quiz UI. Renders inside the palette window in place of
 * the search bar / results list. All keyboard handling lives in the
 * parent PaletteApp's onKeyDown — this component only paints state
 * the store already holds.
 *
 * Layout, top to bottom:
 *  - sticky header: deck name · progress chip · running score
 *  - question (multiline; preserves newlines from the .md file)
 *  - options list with digit chips (1..N), highlighting once revealed
 *  - explanation blockquote (post-reveal)
 *
 * Footer hints live in PaletteApp so the toolbar's chrome stays
 * consistent across modes — the QuizView itself ends at the
 * explanation block.
 */
export function QuizView({ quiz }: { quiz: QuizSession }) {
  // All hooks must run before any early-return so the order is stable
  // across renders even when the quiz transitions to/from `finished`.
  const cardId = quiz.quizCardIds[quiz.index]
  const card = useMemo(
    () => quiz.deck.cards.find((c) => c.id === cardId),
    [quiz.deck, cardId]
  )

  if (quiz.finished) {
    return <QuizSummary quiz={quiz} />
  }

  const total = quiz.quizCardIds.length
  const correctSoFar = countCorrect(quiz.results)
  const answeredSoFar = Object.keys(quiz.results).length
  const result = cardId ? quiz.results[cardId] : undefined
  const revealed = result !== undefined

  // Empty deck (no due cards in review mode, no cards at all in cram
  // mode) — friendly empty state instead of crashing on `card`
  // being undefined.
  if (total === 0 || !card) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-8 text-center gap-3">
        <div className="text-base font-medium">All caught up</div>
        <div className="text-sm text-muted-foreground max-w-md">
          {quiz.cram
            ? 'This deck has no well-formed cards yet. Add a "## question" with at least two `- [ ] / [x]` options to get started.'
            : 'No cards are due for review right now. Press Esc to go back, or use Shift+Enter on the deck row to cram every card regardless of schedule.'}
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
      <QuizHeader
        deckName={quiz.deck.name}
        cram={quiz.cram}
        progress={`${quiz.index + 1}/${total}`}
        scoreLabel={
          answeredSoFar > 0 ? `${correctSoFar}/${answeredSoFar}` : '—'
        }
        warnings={quiz.deck.warnings.length}
      />

      <div className="px-6 py-5 flex-1 flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          {card.topic && (
            <div className="inline-flex items-center gap-1 self-start rounded-md border border-border bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              <Hash size={11} strokeWidth={2} />
              {card.topic}
            </div>
          )}
          <div className="text-base leading-relaxed whitespace-pre-wrap">
            {card.question}
          </div>
        </div>

        <ol className="flex flex-col gap-2">
          {card.options.map((opt, idx) => (
            <OptionRow
              key={idx}
              index={idx}
              text={opt.text}
              state={optionState(idx, card, result)}
            />
          ))}
        </ol>

        {revealed && card.explanation && (
          <blockquote className="border-l-2 border-border pl-3 text-sm text-muted-foreground whitespace-pre-wrap">
            {card.explanation}
          </blockquote>
        )}
      </div>
    </div>
  )
}

function QuizHeader({
  deckName,
  cram,
  progress,
  scoreLabel,
  warnings
}: {
  deckName: string
  cram: boolean
  progress: string
  scoreLabel: string
  warnings: number
}) {
  return (
    <div className="px-4 py-2 border-b border-border bg-toolbar text-[12px] font-medium text-muted-foreground flex items-center gap-2 shrink-0">
      <span className="truncate text-foreground">{deckName}</span>
      <span className="opacity-50">·</span>
      <span>{progress}</span>
      {cram && (
        <>
          <span className="opacity-50">·</span>
          <span className="text-foreground/80">cram</span>
        </>
      )}
      {warnings > 0 && (
        <>
          <span className="opacity-50">·</span>
          <span
            className="inline-flex items-center gap-1 text-amber-500"
            title={`${warnings} parse warning${warnings === 1 ? '' : 's'} in this deck`}
          >
            <AlertTriangle size={12} strokeWidth={2} />
            {warnings}
          </span>
        </>
      )}
      <div className="ml-auto">score {scoreLabel}</div>
    </div>
  )
}

type OptionVisualState =
  | 'idle'
  | 'correct-revealed'
  | 'wrong-picked'
  | 'unpicked-revealed'

function optionState(
  index: number,
  card: FlashcardCard,
  result: { selected: number | null; outcome: string } | undefined
): OptionVisualState {
  if (!result) return 'idle'
  if (index === card.correctIndex) return 'correct-revealed'
  if (index === result.selected) return 'wrong-picked'
  return 'unpicked-revealed'
}

function OptionRow({
  index,
  text,
  state
}: {
  index: number
  text: string
  state: OptionVisualState
}) {
  // Visual treatment per state:
  //  - idle: regular chip, no border accent
  //  - correct-revealed: green border + leading check icon
  //  - wrong-picked: red border + leading X (the row the user picked)
  //  - unpicked-revealed: muted; no icon (the user didn't pick this,
  //    and it's not the right answer either)
  const isCorrect = state === 'correct-revealed'
  const isWrongPick = state === 'wrong-picked'
  return (
    <li
      className={cn(
        'flex items-center gap-3 rounded-md border px-3 py-2 transition-colors',
        state === 'idle' && 'border-border bg-popover',
        isCorrect && 'border-emerald-500/60 bg-emerald-500/10',
        isWrongPick && 'border-red-500/60 bg-red-500/10',
        state === 'unpicked-revealed' && 'border-border bg-popover opacity-60'
      )}
    >
      <kbd
        aria-hidden
        className={cn(
          'inline-flex items-center justify-center h-5 w-5 shrink-0',
          'rounded-md border font-mono font-medium text-[11px] leading-none',
          'shadow-[0_0_2px_rgb(0_0_0/0.1)]',
          isCorrect && 'border-emerald-500/60 text-emerald-600',
          isWrongPick && 'border-red-500/60 text-red-600',
          !isCorrect && !isWrongPick && 'border-border bg-popover text-foreground'
        )}
      >
        {index + 1}
      </kbd>
      <span className="flex-1 text-sm whitespace-pre-wrap">{text}</span>
      {isCorrect && <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />}
      {isWrongPick && <XCircle size={16} className="text-red-500 shrink-0" />}
      {state === 'unpicked-revealed' && (
        <Circle size={16} className="text-muted-foreground shrink-0" />
      )}
    </li>
  )
}

function countCorrect(results: QuizSession['results']): number {
  let n = 0
  for (const r of Object.values(results)) {
    if (r.outcome === 'correct') n++
  }
  return n
}
