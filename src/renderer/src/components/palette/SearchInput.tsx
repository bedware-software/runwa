import type { Ref } from 'react'
import { InputField } from '@bedware/ui'
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
    <InputField
      ref={ref}
      size="lg"
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onPointerDown={onPointerDown}
      placeholder={placeholder}
      autoFocus
      spellCheck={false}
      boxClassName="flex-[5] [-webkit-app-region:no-drag]"
    />
  )
}
