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
        // Horizontal 3 px padding — tight chip hugging the glyph,
        // matching the denser PT Command Palette look. Vertical
        // padding is asymmetric (+1 px on top, -1 px on bottom of the
        // 3 px base): monospace bold glyphs with `line-height: 1` sit
        // ~1 px above the line-box centre because the ascender is
        // taller than the descender, and `leading-none` gives the
        // font no vertical compensation. The 4/2 split pulls the
        // glyph down to the geometric centre of the chip.
        //
        // `min-w-[16px]` = chip height (4 + 10 font + 2 = 16 px) so
        // single-character chips render as squares; multi-character
        // chips ("Ctrl", "Esc") outgrow the min-width and become
        // rectangles naturally.
        'inline-flex items-center justify-center pt-[4px] pb-[2px] px-[3px] rounded-md min-w-[16px]',
        // Popover bg sits slightly above the toolbar for surface
        // contrast. Regular weight keeps the chip quiet; the 10 px
        // font is one step below the surrounding hint label so the
        // chip feels subordinate rather than shouting.
        'bg-popover text-foreground font-mono font-normal text-[10px] leading-none',
        // Visible border + a whisper of even glow (no vertical
        // offset) — the glow lifts the chip just enough to read as a
        // discrete surface without the bottom-heavy 3D-button look.
        'border border-border shrink-0 shadow-[0_0_2px_rgb(0_0_0/0.1)]',
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
