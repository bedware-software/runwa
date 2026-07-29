import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { WindowIgnoreRule } from '@shared/types'
import { EyeOff, Plus, Trash2 } from '@/lib/lucide-icons'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '../ConfirmDialog'

const MAX_FIELD_LENGTH = 512

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const cleaned = message
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(/^Error: /, '')
  return cleaned || 'Something went wrong. Please try again.'
}

/** Human-readable summary of what a rule hides. Mirrors the matcher in
 * `ignore-store.ts`: an empty field means "any". */
function describeRule(rule: WindowIgnoreRule): string {
  if (!rule.title) return `Every window of ${rule.processName}`
  if (!rule.processName) return `Any window titled “${rule.title}”`
  return `“${rule.title}” from ${rule.processName}`
}

/**
 * Manage the Window Switcher's ignore list. Rules are normally created from
 * the palette (Ctrl+K → "Ignore this window"); this pane is where they're
 * reviewed, removed, and — for patterns the palette can't express, like a
 * wildcard over a changing title — written by hand.
 *
 * The list lives outside the settings payload (see `ignore-store.ts`), so
 * it's loaded over its own IPC and kept current via the
 * `ignore-rules-changed` broadcast that fires when the palette edits it.
 */
export function WindowSwitcherIgnoreSection() {
  const [rules, setRules] = useState<WindowIgnoreRule[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [processName, setProcessName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<WindowIgnoreRule | null>(null)
  const [removing, setRemoving] = useState(false)

  const loadRules = useCallback(async (): Promise<void> => {
    setRules(null)
    setLoadError(null)
    try {
      setRules(await window.electronAPI.windowSwitcherListIgnoreRules())
    } catch (err) {
      setLoadError(readableError(err))
    }
  }, [])

  useEffect(() => {
    void loadRules()
  }, [loadRules])

  // Live-update when the palette adds a rule while this pane is open.
  useEffect(() => {
    return window.electronAPI.onWindowSwitcherIgnoreRulesChanged((next) => {
      setRules(next)
      setLoadError(null)
    })
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const trimmedTitle = title.trim()
    const trimmedProcess = processName.trim()
    if ((!trimmedTitle && !trimmedProcess) || saving) return

    setSaving(true)
    setError(null)
    try {
      const next = await window.electronAPI.windowSwitcherAddIgnoreRule({
        title: trimmedTitle,
        processName: trimmedProcess
      })
      setRules(next)
      setTitle('')
      setProcessName('')
    } catch (err) {
      setError(readableError(err))
    } finally {
      setSaving(false)
    }
  }

  const removePending = async (): Promise<void> => {
    if (!pendingRemoval || removing) return
    const ruleId = pendingRemoval.id
    setPendingRemoval(null)
    setRemoving(true)
    setError(null)
    try {
      setRules(await window.electronAPI.windowSwitcherRemoveIgnoreRule(ruleId))
    } catch (err) {
      setError(readableError(err))
    } finally {
      setRemoving(false)
    }
  }

  const canSubmit = (title.trim().length > 0 || processName.trim().length > 0) && !saving

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <div className="text-xs font-semibold uppercase tracking-wider text-foreground">
          Ignored windows
        </div>
        <p className="m-0 text-xs leading-relaxed text-muted-foreground">
          Windows matching any rule below are hidden from the switcher. Add them
          straight from the palette with <span className="font-mono">Ctrl+K</span>{' '}
          → “Ignore this window”, or write a rule here. Matching is
          case-insensitive; leave a field empty to match anything, and use{' '}
          <span className="font-mono">*</span> as a wildcard (e.g.{' '}
          <span className="font-mono">Telegram*</span> for a title with a
          changing unread count).
        </p>
      </div>

      {rules !== null && (
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-foreground">
            Add rule
          </div>
          <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">Window title</span>
              <input
                type="text"
                value={title}
                maxLength={MAX_FIELD_LENGTH}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="e.g. ktalk — leave empty for any"
                spellCheck={false}
                autoComplete="off"
                className="h-9 px-3 rounded-md bg-card border border-input text-sm text-foreground outline-none focus:border-ring"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">Executable</span>
              <input
                type="text"
                value={processName}
                maxLength={MAX_FIELD_LENGTH}
                onChange={(event) => setProcessName(event.target.value)}
                placeholder="e.g. ktalk.exe"
                spellCheck={false}
                autoComplete="off"
                className="h-9 px-3 rounded-md bg-card border border-input text-sm text-foreground outline-none focus:border-ring font-mono"
              />
            </label>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div
              role={error ? 'alert' : undefined}
              className={cn(
                'min-h-4 text-xs',
                error ? 'text-destructive' : 'text-muted-foreground'
              )}
            >
              {error ?? 'A rule needs at least one of the two fields.'}
            </div>
            <button
              type="submit"
              disabled={!canSubmit}
              className={cn(
                'h-8 px-3 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 shrink-0',
                'bg-primary text-primary-foreground hover:opacity-90',
                !canSubmit && 'opacity-50 cursor-not-allowed'
              )}
            >
              <Plus size={13} />
              {saving ? 'Adding…' : 'Add rule'}
            </button>
          </div>
        </form>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-foreground">
            Rules
          </div>
          {rules && rules.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {rules.length} {rules.length === 1 ? 'rule' : 'rules'}
            </span>
          )}
        </div>

        <div className="flex flex-col divide-y divide-border border border-input rounded-md bg-card overflow-hidden">
          {rules === null ? (
            loadError ? (
              <div
                role="alert"
                className="px-4 py-4 flex items-center justify-between gap-3 text-xs text-destructive"
              >
                <span>{loadError}</span>
                <button
                  type="button"
                  onClick={() => void loadRules()}
                  className="h-7 px-3 rounded-md border border-input bg-secondary text-secondary-foreground hover:bg-accent shrink-0"
                >
                  Retry
                </button>
              </div>
            ) : (
              <div className="px-4 py-5 text-xs text-muted-foreground">
                Loading ignore rules…
              </div>
            )
          ) : rules.length === 0 ? (
            <div className="px-4 py-5 text-xs text-muted-foreground">
              Nothing is ignored. Every open window shows up in the switcher.
            </div>
          ) : (
            rules.map((rule) => (
              <div key={rule.id} className="flex items-start gap-3 px-4 py-3">
                <EyeOff size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">
                    {describeRule(rule)}
                  </div>
                  <code className="block mt-0.5 text-xs leading-relaxed text-muted-foreground font-mono break-all">
                    title: {rule.title || '*'} · exe: {rule.processName || '*'}
                  </code>
                </div>
                <button
                  type="button"
                  disabled={removing}
                  onClick={() => setPendingRemoval(rule)}
                  aria-label={`Stop ignoring ${describeRule(rule)}`}
                  title="Remove rule"
                  className={cn(
                    'h-7 w-7 rounded-md flex items-center justify-center shrink-0 transition-colors',
                    'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
                    removing && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingRemoval !== null}
        title="Remove ignore rule?"
        message={
          pendingRemoval
            ? `${describeRule(pendingRemoval)} will show up in the Window Switcher again.`
            : ''
        }
        confirmLabel="Remove rule"
        onConfirm={() => void removePending()}
        onCancel={() => setPendingRemoval(null)}
      />
    </div>
  )
}
