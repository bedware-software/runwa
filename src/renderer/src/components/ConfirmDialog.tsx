import { useEffect, useId, useRef } from 'react'
import { cn } from '@/lib/utils'
import { formatKey } from '@/lib/hotkey-display'
import { Kbd } from './ui/Kbd'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  /**
   * Driven by keys rather than by focus: no button takes focus, Enter
   * confirms, Esc cancels, and each button shows its key. For prompts
   * over a keyboard-first surface (the palette) where a focused Cancel
   * would sit between the user and the Enter they expect to work.
   */
  keyboardDriven?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Yes, I'm sure",
  cancelLabel = 'Cancel',
  destructive = false,
  keyboardDriven = false,
  onConfirm,
  onCancel
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Read through a ref so an inline `onConfirm` doesn't re-run the effect
  // (and its focus save/restore) on every parent render.
  const onConfirmRef = useRef(onConfirm)
  onConfirmRef.current = onConfirm
  const titleId = useId()
  const messageId = useId()

  useEffect(() => {
    if (!open) return
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    // Default focus stays on the safe action. Destructive confirmation takes
    // an explicit Tab/click instead of becoming the Enter-key default.
    // Keyboard-driven, focus parks on the dialog itself instead: no button
    // is highlighted, and typing can't leak into whatever sits behind it.
    const t = keyboardDriven
      ? undefined
      : setTimeout(() => cancelRef.current?.focus(), 50)
    if (keyboardDriven) dialogRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      if (keyboardDriven && e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        // A held Enter — the one that opened this prompt, still repeating —
        // must not answer it.
        if (e.repeat || e.isComposing) return
        onConfirmRef.current()
        return
      }
      if (e.key !== 'Tab') return
      if (keyboardDriven) {
        // Nothing to cycle through: the buttons are out of the tab order.
        e.preventDefault()
        return
      }
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey, true)
      // The invoking control may have been removed by the confirmed action;
      // only restore when it still exists and remains focusable.
      if (
        previouslyFocused?.isConnected &&
        !previouslyFocused.matches(':disabled')
      ) {
        previouslyFocused.focus()
      }
    }
  }, [open, onCancel, keyboardDriven])

  if (!open) return null

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        className="w-[440px] max-w-[90vw] rounded-lg border border-border bg-popover text-popover-foreground shadow-xl p-5 focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} className="text-sm font-semibold text-foreground mb-2">
          {title}
        </h3>
        <p
          id={messageId}
          className="text-xs text-muted-foreground leading-relaxed mb-5"
        >
          {message}
        </p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            tabIndex={keyboardDriven ? -1 : undefined}
            onClick={onCancel}
            className="inline-flex items-center gap-2 h-8 px-3 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent"
          >
            {cancelLabel}
            {keyboardDriven && <Kbd>{formatKey('Esc')}</Kbd>}
          </button>
          <button
            type="button"
            tabIndex={keyboardDriven ? -1 : undefined}
            onClick={onConfirm}
            className={cn(
              'inline-flex items-center gap-2 h-8 px-3 rounded-md text-xs font-medium hover:opacity-90',
              destructive
                ? 'bg-destructive text-destructive-foreground'
                : 'bg-primary text-primary-foreground'
            )}
          >
            {confirmLabel}
            {keyboardDriven && (
              // The stock chip is a popover-coloured tile, which reads as a
              // hole punched in a filled button — tint it from the button's
              // own colours instead.
              <Kbd className="bg-black/20 border-white/25 text-current shadow-none">
                {formatKey('Enter')}
              </Kbd>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
