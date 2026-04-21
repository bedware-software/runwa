import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { tokenizeHotkey } from '@/lib/hotkey-display'

/**
 * One key chip. Thin wrapper around `<kbd>` so we can centralize the look
 * (bg, font, radius) and keep every hotkey surface — palette footer,
 * HotkeyRecorder, keyboard-remap rules list — visually identical.
 *
 * Accepts either a string (single key token) or ReactNode (icons — used
 * by the palette footer's "Navigate" arrow hints).
 */
export function Kbd({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center justify-center min-w-[1.4em] h-[1.4em] px-1.5 rounded',
        'bg-secondary text-foreground font-mono text-[11px] leading-none',
        'border border-border shrink-0',
        className
      )}
    >
      {children}
    </kbd>
  )
}

/**
 * Renders a full hotkey as a row of Kbd chips — one chip per key.
 *
 * Input is a platform-neutral "+"-joined string like `Ctrl+Alt+W` or
 * `Space+Shift+1`. Tokens are formatted for the current OS via
 * `tokenizeHotkey` — so on macOS you get [⌃] [⌥] [W], and on Windows
 * [Ctrl] [Alt] [W].
 *
 * Empty / undefined input renders nothing (lets callers skip an explicit
 * conditional at the call site).
 */
export function Hotkey({
  value,
  className
}: {
  value: string | undefined | null
  className?: string
}) {
  const tokens = tokenizeHotkey(value)
  if (tokens.length === 0) return null
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {tokens.map((t, i) => (
        <Kbd key={`${t}-${i}`}>{t}</Kbd>
      ))}
    </span>
  )
}
