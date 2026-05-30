import { useCallback, useEffect, useState } from 'react'
import { Check, Clipboard, Pencil, RotateCcw } from '@/lib/lucide-icons'
import type { FlashcardsLlmPromptView } from '@shared/types'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '../ConfirmDialog'

const MODULE_ID = 'flashcards'
const ACTION_EDIT = 'editLlmPrompt'
const ACTION_COPY = 'copyLlmPrompt'
const ACTION_RESET = 'resetLlmPrompt'

/**
 * Settings section for the LLM prompt file. Same shape as
 * KeyboardRemapSection: read-only path input + action buttons; the
 * actual content lives in the user's editor of choice. Copy goes
 * through main so the read-from-disk-then-write-to-clipboard cycle
 * always sees the freshest version of the file (no renderer cache);
 * Edit hands the file to the system editor for `.md`.
 */
export function FlashcardsLlmPromptSection() {
  const [view, setView] = useState<FlashcardsLlmPromptView | null>(null)
  const [copied, setCopied] = useState(false)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)

  // Initial fetch is just for the path display; copy/edit don't need
  // it (they go through main directly). We still fetch on every
  // window focus so a path change (e.g. user switched between Dev and
  // packaged installs) is reflected.
  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      void window.electronAPI.flashcardsGetLlmPrompt().then((next) => {
        if (!cancelled) setView(next)
      })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const onEdit = useCallback(() => {
    void window.electronAPI.modulesAction(MODULE_ID, ACTION_EDIT)
  }, [])

  const onCopy = useCallback(async () => {
    try {
      // Main re-reads the file from disk on every copy, so an edit
      // saved in the system editor a moment ago lands on the
      // clipboard immediately — no renderer-side cache to invalidate.
      await window.electronAPI.modulesAction(MODULE_ID, ACTION_COPY)
      // The "Copied" state turns on when the IPC actually resolves
      // (real action completion) and stays until the user finishes
      // their interaction with the button — see the
      // pointerleave / blur handlers below. No arbitrary setTimeout:
      // the feedback lifetime tracks the user's actual gesture.
      setCopied(true)
    } catch (err) {
      console.warn('[flashcards] copy action failed', err)
    }
  }, [])

  const onResetConfirmed = useCallback(async () => {
    setResetConfirmOpen(false)
    try {
      await window.electronAPI.modulesAction(MODULE_ID, ACTION_RESET)
      // Re-fetch so the path stays in sync (it doesn't actually
      // change, but the IPC also runs ensureLlmPromptFile which is
      // a useful sanity touch after the rewrite).
      const next = await window.electronAPI.flashcardsGetLlmPrompt()
      setView(next)
    } catch (err) {
      console.warn('[flashcards] reset action failed', err)
    }
  }, [])

  return (
    <div className="pt-3 border-t border-border flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium text-foreground">
          LLM prompt for generating decks
        </div>
        <div className="text-xs text-muted-foreground -mt-1">
          Markdown file you paste into your LLM along with your source
          notes. Click Edit to open it in your default editor for{' '}
          <code>.md</code>; Copy puts the current file content on the
          clipboard (always fresh from disk).
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            readOnly
            value={view?.filePath ?? ''}
            onFocus={(e) => e.currentTarget.select()}
            className="h-8 flex-1 px-3 rounded-md bg-card border border-input text-xs text-foreground outline-none font-mono truncate"
          />
          <button
            type="button"
            onClick={() => void onCopy()}
            // Reset "Copied" → "Copy" on the natural end of the
            // interaction: pointer leaves the button, or the button
            // loses focus (covers keyboard-only users who never
            // hover). No timer — feedback lifetime is bound to the
            // user's gesture, not a clock.
            onPointerLeave={() => setCopied(false)}
            onBlur={() => setCopied(false)}
            className={cn(
              'h-8 px-3 rounded-md text-xs font-medium border shrink-0 transition-colors flex items-center gap-1.5',
              'bg-secondary text-secondary-foreground border-input hover:bg-accent'
            )}
          >
            {copied ? <Check size={12} /> : <Clipboard size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className={cn(
              'h-8 px-3 rounded-md text-xs font-medium border shrink-0 transition-colors flex items-center gap-1.5',
              'bg-secondary text-secondary-foreground border-input hover:bg-accent'
            )}
          >
            <Pencil size={12} />
            Edit
          </button>
          <button
            type="button"
            onClick={() => setResetConfirmOpen(true)}
            title="Overwrite the file with the shipped default prompt."
            className={cn(
              'h-8 px-3 rounded-md text-xs font-medium border shrink-0 transition-colors flex items-center gap-1.5',
              'bg-secondary text-secondary-foreground border-input hover:bg-accent'
            )}
          >
            <RotateCcw size={12} />
            Reset
          </button>
        </div>
      </div>

      <HowReviewWorksSection />

      <ConfirmDialog
        open={resetConfirmOpen}
        title="Reset prompt to default?"
        message="The current prompt file will be overwritten with the shipped default. Any edits you made will be lost — this can't be undone."
        confirmLabel="Reset to default"
        destructive
        onConfirm={() => void onResetConfirmed()}
        onCancel={() => setResetConfirmOpen(false)}
      />
    </div>
  )
}

/**
 * Static reference section explaining the SRS schedule, deck file
 * format, and the handful of behaviours that aren't otherwise
 * obvious from the UI (card identity, due-detection, topic vs flat
 * mode autodetect).
 */
function HowReviewWorksSection() {
  return (
    <div className="pt-4 mt-2 border-t border-border flex flex-col gap-3">
      <div className="text-xs font-medium text-foreground">How review works</div>

      <Subsection title="Spaced repetition (SM-2)">
        Each card carries an interval (days until next review) and an
        ease factor (≥ 1.3, starts at 2.5). When you answer:
        <ul className="list-disc pl-5 mt-1.5 space-y-1">
          <li>
            <strong>Correct</strong> — interval grows by the ease factor;
            ease nudges up. After the first three correct answers in a
            row the schedule is roughly: 1 day → 6 days → ~15 days,
            and so on exponentially.
          </li>
          <li>
            <strong>Wrong pick</strong> — interval resets to 1 day;
            ease drops a notch. The card comes back tomorrow.
          </li>
          <li>
            <strong>Enter (give up)</strong> — same as wrong; ease
            drops harder. Use Enter deliberately when you don't know
            the answer at all so the schedule reflects that.
          </li>
        </ul>
      </Subsection>

      <Subsection title="Card life cycle (new → mature)">
        A card starts <strong>new</strong> (no SRS state, always due).
        Each correct review grows its interval; each wrong answer
        (or Enter) resets it to 1 day. When the scheduled interval
        crosses 21 days the card is <strong>mature</strong>.
        Typical path for a card you keep getting right:
        <pre className="mt-1.5 px-2 py-1.5 rounded bg-card border border-input/60 text-[11px] leading-5 font-mono whitespace-pre overflow-x-auto">
{`new          → 1st correct → 1 day  (still learning)
1 day      → 2nd correct → 6 days (still learning)
6 days     → 3rd correct → ~15 days × ease (still learning)
~15 days   → 4th correct → ~38 days × ease (MATURE — passes 21d)
38 days    → 5th correct → ~95 days × ease (mature)
…and so on, exponentially`}
        </pre>
        Wrong / skipped at any point: interval → 1 day, ease drops a
        notch, and if the card was mature it stops being mature
        until you climb the ladder again.
      </Subsection>

      <Subsection title="Deck row states in the palette">
        Each deck row pairs an icon with a single-line status so you
        can tell what to do AND how far you've gotten at a glance.
        Hover the icon for an in-context explanation; the full table:
        <table className="mt-1.5 w-full text-[11px] leading-5">
          <thead>
            <tr className="text-left text-foreground/80">
              <th className="font-semibold pr-3 pb-1">Icon</th>
              <th className="font-semibold pr-3 pb-1">Subtitle</th>
              <th className="font-semibold pb-1">Meaning</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground align-top">
            <tr>
              <td className="pr-3 py-0.5 font-mono">book</td>
              <td className="pr-3 py-0.5 font-mono whitespace-nowrap">no cards</td>
              <td>The file parses but has no well-formed cards.</td>
            </tr>
            <tr>
              <td className="pr-3 py-0.5 font-mono">book (closed)</td>
              <td className="pr-3 py-0.5 font-mono whitespace-nowrap">T new · ready to start</td>
              <td>Brand-new deck — never quizzed. No card has any SRS state yet. Hit Enter to start.</td>
            </tr>
            <tr>
              <td className="pr-3 py-0.5 font-mono">book (open)</td>
              <td className="pr-3 py-0.5 font-mono whitespace-nowrap">N due · M/T mature</td>
              <td>Active deck — you've started reviewing, and N cards are scheduled for today.</td>
            </tr>
            <tr>
              <td className="pr-3 py-0.5 font-mono">clock</td>
              <td className="pr-3 py-0.5 font-mono whitespace-nowrap">0/T mature · still learning</td>
              <td>You've reviewed today, nothing's due, but no card has reached 21 days yet. Come back tomorrow to keep growing intervals.</td>
            </tr>
            <tr>
              <td className="pr-3 py-0.5 font-mono">check</td>
              <td className="pr-3 py-0.5 font-mono whitespace-nowrap">M/T mature · all caught up</td>
              <td>No reviews due, and some cards are already past the 21-day mark — real progress.</td>
            </tr>
            <tr>
              <td className="pr-3 py-0.5 font-mono">cap</td>
              <td className="pr-3 py-0.5 font-mono whitespace-nowrap">Mastered · T/T</td>
              <td>Every card has crossed 21 days. Deck is solidly learned.</td>
            </tr>
          </tbody>
        </table>
        Ctrl+Enter on any deck row crams every well-formed card
        regardless of schedule — useful for a refresher before an
        interview.
      </Subsection>

      <Subsection title="Reset a deck">
        Select a deck row, press <code>Ctrl+K</code> (or right-click),
        choose <strong>Reset deck data…</strong>. Every card in that
        deck reverts to <em>new</em> and the next session starts from
        scratch. The <code>.md</code> file is not touched — only the
        per-card history in <code>runwa-flashcards.json</code>.
        There's no undo.
      </Subsection>

      <Subsection title="Deck files">
        One <code>.md</code> file per deck under the deck folder
        (Settings → Flashcards → Decks folder). The filename without{' '}
        <code>.md</code> is the deck id and is what SRS state is keyed
        against — renaming the file detaches its history.
        <pre className="mt-1.5 px-2 py-1.5 rounded bg-card border border-input/60 text-[11px] leading-5 font-mono whitespace-pre overflow-x-auto">
{`# Deck title (optional)

## Topic name              # optional grouping

### Question text
- [ ] wrong option
- [x] correct option
- [ ] wrong option

> Optional explanation paragraph.`}
        </pre>
      </Subsection>

      <Subsection title="Topic-mode auto-detect">
        If the file contains <strong>any</strong> <code>###</code>{' '}
        heading, the parser treats <code>##</code> as topics and{' '}
        <code>###</code> as questions. Otherwise (legacy / flat
        files) <code>##</code> is the question level. Decks can be
        upgraded by adding <code>##</code> topics and renaming{' '}
        <code>##</code> questions to <code>###</code> — card ids are
        derived from the question text, not the heading level, so SRS
        history survives the conversion.
      </Subsection>

      <Subsection title="Card identity">
        A card's id is a SHA-1 of its question text (whitespace
        normalised, lowercased). Cosmetic edits — extra spaces, casing
        — don't reset progress. A real wording change creates a
        <em> new</em> card with fresh SRS state, which is correct: the
        question is now semantically different.
      </Subsection>

      <Subsection title="Live reload">
        Deck files are re-parsed automatically when their mtime
        changes — edit a deck in any editor and the next palette open
        sees the new version. The Reload action under Decks is for
        the rare case of a tool that preserves mtimes (rsync, some
        sync clients).
      </Subsection>
    </div>
  )
}

function Subsection({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="text-xs font-semibold text-foreground/90 mb-1">{title}</div>
      <div className="text-xs text-muted-foreground leading-5">{children}</div>
    </div>
  )
}
