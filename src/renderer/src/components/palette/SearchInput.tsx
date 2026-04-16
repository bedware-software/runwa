import type { Ref } from 'react'
import { useWindowDrag } from '@/lib/use-window-drag'

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  ref?: Ref<HTMLInputElement>
}

export function SearchInput({ value, onChange, placeholder, ref }: Props) {
  // Click without moving → normal focus/type. Click + drag → the window
  // follows the pointer (see lib/use-window-drag.ts for the threshold logic).
  const { onPointerDown } = useWindowDrag()

  return (
    <div className="flex-[5] min-w-0 flex items-center h-8 [-webkit-app-region:no-drag]">
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPointerDown={onPointerDown}
        placeholder={placeholder}
        autoFocus
        spellCheck={false}
        className="flex-1 h-full bg-transparent border-none text-sm text-foreground outline-none"
      />
    </div>
  )
}
