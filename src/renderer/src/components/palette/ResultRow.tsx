import type { Ref } from 'react'
import type { LucideIcon } from '@/lib/lucide-icons'
import type { PaletteItem } from '@shared/types'
import { ResultRow as BwResultRow } from '@bedware/ui'
import { lucideIconFromHint, Square } from '@/lib/lucide-icons'
import { Tooltip } from '../ui/Tooltip'

interface Props {
  item: PaletteItem
  isSelected: boolean
  /** When set, render a small `1`–`9` glyph stuck to the left window edge —
   * the number the user presses (plain or with Alt, per the
   * `quickLaunchDigitsRequireAlt` setting) to run this row directly.
   * ResultsList sets it for the first nine rows only. */
  numberHint?: number
  onClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  /** Set by ResultsList so it can scroll the selected row into view —
   * positional indexing on listRef.children breaks once we interleave
   * group headers between rows. */
  ref?: Ref<HTMLDivElement>
}

/**
 * Map a supported kebab-case iconHint (e.g. "app-window") to a lucide-react
 * icon component. Falls back to Square if the name doesn't match.
 */
function iconFromHint(hint: string | undefined): LucideIcon {
  return lucideIconFromHint(hint, Square)
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
  const BadgeIcon = item.iconBadge ? iconFromHint(item.iconBadge) : null
  return (
    <BwResultRow
      ref={ref}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={item.title}
      subtitle={item.subtitle}
      // The tooltip trigger fills the 32 px tile, so hovering anywhere on
      // the tile shows it. Image icons go through `imageSrc`, which leaves
      // no place for a trigger.
      icon={
        Icon ? (
          <Tooltip
            content={item.iconTooltip}
            className="h-full w-full items-center justify-center"
          >
            <Icon size={18} />
          </Tooltip>
        ) : undefined
      }
      imageSrc={showImage ? hint : undefined}
      corner={BadgeIcon ? <BadgeIcon size={9} /> : undefined}
      alias={
        item.alias ? (
          <span title={`Alias: ${item.alias}`}>{item.alias}</span>
        ) : undefined
      }
      note={item.badge}
      numberHint={numberHint}
      selected={isSelected}
    />
  )
}
