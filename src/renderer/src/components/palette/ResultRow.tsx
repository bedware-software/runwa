import type { Ref } from 'react'
import * as Icons from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PaletteItem } from '@shared/types'
import { cn } from '@/lib/utils'

interface Props {
  item: PaletteItem
  isSelected: boolean
  /** When set, render a small `1`–`9` glyph stuck to the left window edge —
   * the number the user can press to launch this row directly. ResultsList
   * only sets it when the result count is small enough that the digit
   * shortcut is wired up at the palette level. */
  numberHint?: number
  onClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  /** Set by ResultsList so it can scroll the selected row into view —
   * positional indexing on listRef.children breaks once we interleave
   * group headers between rows. */
  ref?: Ref<HTMLDivElement>
}

/**
 * Map a kebab-case iconHint (e.g. "app-window") to a lucide-react icon
 * component. Falls back to Square if the name doesn't match.
 */
function iconFromHint(hint: string | undefined): LucideIcon {
  if (!hint) return Icons.Square
  const name = hint
    .split('-')
    .map((s) => (s[0] ?? '').toUpperCase() + s.slice(1))
    .join('')
  const lookup = Icons as unknown as Record<string, LucideIcon>
  return lookup[name] ?? Icons.Square
}

function isImageUrl(hint: string | undefined): hint is string {
  return !!hint && hint.startsWith('data:')
}

export function ResultRow({
  item,
  isSelected,
  numberHint,
  onClick,
  onContextMenu,
  ref
}: Props) {
  const hint = item.iconHint
  const showImage = isImageUrl(hint)
  const Icon = showImage ? null : iconFromHint(hint)
  return (
    <div
      ref={ref}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        'relative flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors',
        isSelected && 'bg-accent text-accent-foreground'
      )}
    >
      {numberHint !== undefined && (
        // Half-keycap: borders + rounded corners on top/right/bottom only.
        // The left edge sits flush against the palette window border so it
        // reads as the right half of a Kbd chip — enough visual weight to
        // catch the eye without spending the horizontal real estate of a
        // full-width chip. The row's `px-3` padding stays put, so the
        // icon and title don't shift to make room (the keycap nudges into
        // the otherwise-empty 12 px gutter).
        <kbd
          aria-hidden="true"
          className={cn(
            'absolute left-0 top-1/2 -translate-y-1/2',
            'inline-flex items-center justify-center',
            'h-[16px] min-w-[14px] pl-[3px] pr-[4px]',
            'rounded-l-none rounded-r-md border border-l-0',
            'font-mono font-medium text-[10px] leading-none',
            'select-none pointer-events-none',
            // Drop a soft right-leaning shadow so the half-cap reads as a
            // 3D edge rather than a flat coloured rectangle. Symmetric
            // shadow would muddy the "chopped in half" effect.
            'shadow-[1px_0_2px_rgb(0_0_0/0.08)]',
            isSelected
              ? 'border-accent-foreground/30 text-accent-foreground bg-accent-foreground/10'
              : 'border-border text-foreground bg-popover'
          )}
        >
          {numberHint}
        </kbd>
      )}
      <div
        className={cn(
          'h-8 w-8 rounded-md flex items-center justify-center shrink-0',
          // Real app icons (PNGs with their own artwork) render on a
          // transparent tile so the extracted icon isn't boxed into a
          // coloured square. Lucide glyphs keep the tinted tile so they
          // still read as framed icons.
          Icon
            ? isSelected
              ? 'bg-accent-foreground/10 text-accent-foreground'
              : 'bg-secondary text-muted-foreground'
            : ''
        )}
      >
        {Icon ? (
          <Icon size={18} />
        ) : (
          <img
            src={hint}
            alt=""
            className="h-8 w-8 object-contain"
            draggable={false}
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium truncate">{item.title}</span>
          {item.alias && (
            <kbd
              className={cn(
                // `leading-none` + inline-flex keeps the chip's box
                // height ≤ the title row's `text-sm` line-height (20px),
                // so adding/removing an alias never changes row height.
                'shrink-0 inline-flex items-center px-1.5 py-0.5 rounded font-mono text-[11px] leading-none font-medium border',
                isSelected
                  ? 'border-accent-foreground/30 text-accent-foreground bg-accent-foreground/10'
                  : 'border-border text-muted-foreground bg-secondary'
              )}
              title={`Alias: ${item.alias}`}
            >
              {item.alias}
            </kbd>
          )}
        </div>
        {item.subtitle && (
          <div
            className={cn(
              'text-xs truncate',
              isSelected ? 'text-accent-foreground/70' : 'text-muted-foreground'
            )}
          >
            {item.subtitle}
          </div>
        )}
      </div>
    </div>
  )
}
