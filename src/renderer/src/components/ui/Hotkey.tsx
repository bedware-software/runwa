import { Kbd } from '@bedware/ui'
import { cn } from '@/lib/utils'
import { tokenizeHotkey } from '@/lib/hotkey-display'

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
        <Kbd key={`${t}-${i}`} className="shrink-0">
          {t}
        </Kbd>
      ))}
    </span>
  )
}
