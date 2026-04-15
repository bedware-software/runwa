import { useEffect, useRef } from 'react'
import type { PaletteItem } from '@shared/types'
import { usePaletteStore } from '@/store/palette-store'
import { ResultRow } from './ResultRow'

interface Props {
  items: PaletteItem[]
  selectedIndex: number
}

export function ResultsList({ items, selectedIndex }: Props) {
  const setSelectedIndex = usePaletteStore((s) => s.setSelectedIndex)
  const executeSelected = usePaletteStore((s) => s.executeSelected)
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the selected row visible when navigating with the keyboard
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (items.length === 0) {
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
          onMouseEnter={() => setSelectedIndex(index)}
          onClick={() => {
            setSelectedIndex(index)
            void executeSelected()
          }}
        />
      ))}
    </div>
  )
}
