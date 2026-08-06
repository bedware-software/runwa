import { useEffect, useRef, useState } from 'react'
import type { UserCommandKind } from '@shared/types'
import { IS_MAC } from '@/lib/platform'
import { cn } from '@/lib/utils'

/**
 * Inline "new user command" form, opened by the palette's
 * "Create user command for <app>" entry.
 *
 * Deliberately smaller than the Settings surface: the app scope is decided
 * by main (it's whatever the palette was opened over — shown here as a chip,
 * not as a field), and there's no alias input, because an alias is set on the
 * finished row with Ctrl+K like any other. What's left is exactly what can't
 * be inferred — a name, whether it's a shell command or a keystroke, and the
 * action itself.
 *
 * Keyboard handling mirrors AliasInputModal: Esc closes, Enter submits, and
 * both are captured at the document level so the palette behind doesn't also
 * act on them.
 */

interface Props {
  open: boolean
  /** App the command will be scoped to, e.g. "IntelliJ IDEA". */
  appLabel: string
  /** Rejected saves surface here — main owns validation (keystroke syntax,
   * duplicate names), so the message comes back from the IPC call. */
  error: string | null
  saving: boolean
  onSubmit: (command: {
    name: string
    kind: UserCommandKind
    action: string
  }) => void
  onClose: () => void
}

const SHELL_PLACEHOLDER = IS_MAC
  ? 'open -a "Visual Studio Code" --args --new-window'
  : '"C:\\Program Files\\My App\\app.exe" --profile work'

const KEYSTROKE_PLACEHOLDER = IS_MAC ? 'Cmd+Alt+L' : 'Ctrl+Alt+L'

export function NewUserCommandModal({
  open,
  appLabel,
  error,
  saving,
  onSubmit,
  onClose
}: Props) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<UserCommandKind>('shell')
  const [action, setAction] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Fresh form on every open — the palette session that follows is usually
  // about a different command entirely.
  useEffect(() => {
    if (!open) return
    setName('')
    setKind('shell')
    setAction('')
    setTimeout(() => {
      nameRef.current?.focus()
      nameRef.current?.select()
    }, 0)
  }, [open])

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

  const canSubmit = name.trim().length > 0 && action.trim().length > 0 && !saving

  const submit = (): void => {
    if (!canSubmit) return
    onSubmit({ name: name.trim(), kind, action: action.trim() })
  }

  const inputClass =
    'h-8 px-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring'

  return (
    <>
      <div className="absolute inset-0 bg-background/60 backdrop-blur-[1px]" />
      <div
        ref={rootRef}
        role="dialog"
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20 w-[420px] bg-popover text-popover-foreground border border-border rounded-md shadow-lg overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              New user command
            </div>
            <div className="text-sm font-medium truncate">
              Only shown in this app
            </div>
          </div>
          <span className="shrink-0 max-w-[45%] truncate px-2 py-0.5 rounded-md border border-border text-[11px] leading-none text-muted-foreground">
            {appLabel}
          </span>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="p-3 flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Name</span>
            <input
              ref={nameRef}
              type="text"
              value={name}
              maxLength={100}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Reformat code"
              className={inputClass}
            />
          </label>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Type</span>
            <div className="flex gap-1">
              {(['shell', 'keystroke'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setKind(option)}
                  className={cn(
                    'h-8 px-3 rounded-md border text-xs transition-colors',
                    kind === option
                      ? 'border-ring bg-accent text-accent-foreground'
                      : 'border-input text-muted-foreground hover:bg-accent/50'
                  )}
                >
                  {option === 'shell' ? 'Shell command' : 'Keystroke'}
                </button>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">
              {kind === 'keystroke' ? 'Keystroke' : 'Action'}
            </span>
            <input
              type="text"
              value={action}
              maxLength={4096}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setAction(e.target.value)}
              placeholder={
                kind === 'keystroke' ? KEYSTROKE_PLACEHOLDER : SHELL_PLACEHOLDER
              }
              className={cn(inputClass, 'font-mono')}
            />
          </label>

          <div className="flex items-center justify-between gap-2">
            <span
              role={error ? 'alert' : undefined}
              className={cn(
                'text-[11px] min-w-0 truncate',
                error ? 'text-destructive' : 'text-muted-foreground'
              )}
              title={error ?? undefined}
            >
              {error ??
                (kind === 'keystroke'
                  ? 'Commas separate steps: “Alt+Space, R”.'
                  : 'Runs in the background, output is not shown.')}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="h-7 px-3 rounded-md text-xs text-muted-foreground hover:bg-accent/50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className={cn(
                  'h-7 px-3 rounded-md text-xs bg-primary text-primary-foreground hover:bg-primary/90 transition-colors',
                  !canSubmit && 'opacity-50 cursor-not-allowed'
                )}
              >
                {saving ? 'Saving…' : 'Create'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </>
  )
}
