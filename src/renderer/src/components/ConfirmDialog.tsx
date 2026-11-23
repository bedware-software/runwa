import { useEffect, useId, useRef } from 'react'
import { Button, Hint, HintBar } from '@bedware/ui'
import { formatKey } from '@/lib/hotkey-display'

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
    <div role="presentation" className="bw-overlay" onClick={onCancel}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        className="bw-dialog focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bw-dialog__body">
          <h3 id={titleId} className="bw-dialog__title">
            {title}
          </h3>
          <p id={messageId} className="bw-dialog__message">
            {message}
          </p>
          <div className="bw-dialog__actions">
            <Button
              ref={cancelRef}
              variant="ghost"
              tabIndex={keyboardDriven ? -1 : undefined}
              onClick={onCancel}
            >
              {cancelLabel}
            </Button>
            <Button
              variant={destructive ? 'danger' : 'primary'}
              tabIndex={keyboardDriven ? -1 : undefined}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
        {/* Only the keys that really work here: Enter confirms only when
            keyboard-driven (otherwise it presses whichever button has focus). */}
        <HintBar>
          {keyboardDriven && <Hint label={confirmLabel} keys={[formatKey('Enter')]} />}
          <Hint label={cancelLabel} keys={[formatKey('Esc')]} />
        </HintBar>
      </div>
    </div>
  )
}
