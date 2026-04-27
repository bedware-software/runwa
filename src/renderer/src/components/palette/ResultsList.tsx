import { useEffect, useRef } from 'react'
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
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the selected row visible when navigating with the keyboard
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
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

  return (
    <div ref={listRef} className="flex-1 overflow-y-auto">
      {items.map((item, index) => (
        <ResultRow
          key={item.id}
          item={item}
          isSelected={index === selectedIndex}
          onClick={() => {
            setSelectedIndex(index)
            void executeSelected()
          }}
          onContextMenu={
            onOpenContextMenu
              ? (e) => {
                  // Suppress the default browser right-click menu — Electron
                  // shows the Chromium one in dev which just confuses users.
                  e.preventDefault()
                  onOpenContextMenu(index)
                }
              : undefined
          }
        />
      ))}
    </div>
  )
}
