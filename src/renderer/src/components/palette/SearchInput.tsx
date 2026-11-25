import type { ReactNode, Ref } from 'react'
import { InputField } from '@bedware/ui'
import { useWindowDrag } from '@/lib/use-window-drag'

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  /** Shown inside the field, at its right edge: the module the palette is on. */
  mode?: ReactNode
  ref?: Ref<HTMLInputElement>
}

export function SearchInput({ value, onChange, placeholder, mode, ref }: Props) {
  // Click without moving → normal focus/type. Click + drag → the window
  // follows the pointer (see lib/use-window-drag.ts for the threshold logic).
  const { onPointerDown } = useWindowDrag()

  return (
    <InputField
      ref={ref}
      size="lg"
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onPointerDown={onPointerDown}
      placeholder={placeholder}
      trailing={mode}
      autoFocus
      spellCheck={false}
      boxClassName="flex-[5] [-webkit-app-region:no-drag]"
    />
  )
}
