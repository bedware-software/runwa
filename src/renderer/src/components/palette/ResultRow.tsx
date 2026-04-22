import * as Icons from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PaletteItem } from '@shared/types'
import { cn } from '@/lib/utils'

interface Props {
  item: PaletteItem
  isSelected: boolean
  onMouseEnter?: () => void
  onClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
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

export function ResultRow({ item, isSelected, onMouseEnter, onClick, onContextMenu }: Props) {
  const hint = item.iconHint
  const showImage = isImageUrl(hint)
  const Icon = showImage ? null : iconFromHint(hint)
  return (
    <div
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        'flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors',
        isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
      )}
    >
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
                'shrink-0 px-1.5 py-0.5 rounded font-mono text-[11px] font-medium border',
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
