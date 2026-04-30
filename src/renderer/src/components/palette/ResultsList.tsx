import { Fragment, useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import type { PaletteItem } from '@shared/types'
import { usePaletteStore } from '@/store/palette-store'
import { ResultRow } from './ResultRow'

interface Props {
  items: PaletteItem[]
  selectedIndex: number
  isLoading: boolean
  /**
   * Called when a row is right-clicked. Caller decides whether the click
   * opens a context menu (rows without a `revealPath` — UWP entries,
   * service-module items — typically make this a no-op).
   */
  onOpenContextMenu?: (index: number) => void
}

export function ResultsList({
  items,
  selectedIndex,
  isLoading,
  onOpenContextMenu
}: Props) {
  const setSelectedIndex = usePaletteStore((s) => s.setSelectedIndex)
  const executeSelected = usePaletteStore((s) => s.executeSelected)
  // Per-row refs so we can scroll the selected row into view without
  // depending on direct-child positional indexing — adding optional
  // group headers between rows breaks `listRef.children[selectedIndex]`.
  const rowRefs = useRef<Array<HTMLDivElement | null>>([])

  // Keep the selected row visible when navigating with the keyboard
  useEffect(() => {
    rowRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (items.length === 0) {
    // Distinguish "still enumerating" (first UWP open costs ~1-2s for
    // Get-AppxPackage) from "genuinely nothing matched". Without this
    // split users see a confusing "No results" flash on first open.
    if (isLoading) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground text-sm">
          <Loader2 size={18} className="animate-spin" />
          <span>Loading…</span>
        </div>
      )
    }
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No results
      </div>
    )
  }

  // Show 1..N digit hints only when the list is short enough that the
  // user can plausibly hit the right number — the palette intercepts
  // the matching keypress and runs the row. Above that we'd just be
  // adding visual noise nobody can use anyway.
  const showNumbers = items.length > 0 && items.length <= 4

  // Trim the refs array to the current item count so stale refs from a
  // longer previous result set don't survive a re-render.
  rowRefs.current.length = items.length

  return (
    <div className="flex-1 overflow-y-auto">
      {items.map((item, index) => {
        // Insert a group header before the first item with this group
        // value, and again whenever the group string changes between
        // adjacent items. Items with no group never trigger a header.
        const prev = items[index - 1]
        const showHeader =
          item.group !== undefined && item.group !== prev?.group
        return (
          <Fragment key={item.id}>
            {showHeader && (
              <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground select-none">
                {item.group}
              </div>
            )}
            <ResultRow
              ref={(el) => {
                rowRefs.current[index] = el
              }}
              item={item}
              isSelected={index === selectedIndex}
              numberHint={showNumbers ? index + 1 : undefined}
              onClick={() => {
                setSelectedIndex(index)
                void executeSelected()
              }}
              onContextMenu={
                onOpenContextMenu
                  ? (e) => {
                      // Suppress the default browser right-click menu —
                      // Electron shows the Chromium one in dev which
                      // just confuses users.
                      e.preventDefault()
                      onOpenContextMenu(index)
                    }
                  : undefined
              }
            />
          </Fragment>
        )
      })}
    </div>
  )
}
