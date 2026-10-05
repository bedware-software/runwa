import { useEffect, useRef, useState } from 'react'

/**
 * Modal overlay for assigning an alias to the currently-selected palette
 * row. Opens from the Ctrl+K context menu's "Set alias…" action; closes
 * on Escape, click-outside, or after Save.
 *
 * Semantics:
 *  - Empty submission REMOVES the alias (standard "clear to none" UX).
 *  - Non-empty is trimmed + lowercased server-side — we don't repeat the
 *    normalisation here so the input stays WYSIWYG while the user types.
 *  - Main may reject the alias (a user command's alias must be unique among
 *    its app's commands). The modal stays open with main's message so the
 *    user can pick another one.
 */

interface Props {
  open: boolean
  itemTitle: string
  initialValue: string
  /** Resolves once saved; a rejection keeps the modal open with its message. */
  onSave: (alias: string) => Promise<void>
  onClose: () => void
}

function readableError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return (
    message
      .replace(/^Error invoking remote method '[^']+': Error: /, '')
      .replace(/^Error: /, '') || 'The alias could not be saved.'
  )
}

export function AliasInputModal({
  open,
  itemTitle,
  initialValue,
  onSave,
  onClose
}: Props) {
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setValue(initialValue)
    setError(null)
    setSaving(false)
    // Microtask so the input exists in the DOM before we focus.
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }, [open, initialValue])

  // Document-level capture keeps us ahead of the palette's onKeyDown so
  // Esc closes the modal without also triggering back / dismiss, and
  // Enter commits without double-firing the row's execute path.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose])

  if (!open) return null

  const submit = (): void => {
    if (saving) return
    setSaving(true)
    setError(null)
    onSave(value).then(
      () => setSaving(false),
      (err: unknown) => {
        setSaving(false)
        setError(readableError(err))
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    )
  }

  return (
    <>
      <div className="absolute inset-0 bg-background/60 backdrop-blur-[1px]" />
      <div
        ref={rootRef}
        role="dialog"
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20 w-[360px] bg-popover text-popover-foreground border border-border rounded-md shadow-lg overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Alias for
          </div>
          <div className="text-sm font-medium truncate">{itemTitle}</div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="p-3 flex flex-col gap-3"
        >
          <input
            ref={inputRef}
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
            placeholder="e.g. chr"
            className="h-8 px-2 rounded-md border border-input bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex items-center justify-between gap-2">
            <span
              role={error ? 'alert' : undefined}
              title={error ?? undefined}
              className={
                error
                  ? 'text-[11px] text-destructive min-w-0 truncate'
                  : 'text-[11px] text-muted-foreground'
              }
            >
              {error ?? 'Leave empty to clear.'}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onClose}
                className="h-7 px-3 rounded-md text-xs text-muted-foreground hover:bg-accent/50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="h-7 px-3 rounded-md text-xs bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </form>
      </div>
    </>
  )
}
