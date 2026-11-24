import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { HotkeyButton, IconButton } from '@bedware/ui'
import { RotateCcw, X } from '@/lib/lucide-icons'
import { keyEventToAccelerator } from '@/lib/hotkey'
import { tokenizeHotkey } from '@/lib/hotkey-display'

interface Props {
  value: string
  onChange: (v: string) => void
  /** When provided, a reset icon appears if the current value differs. */
  defaultValue?: string
}

/**
 * Click-to-record hotkey input. On focus, listens for a key chord; saves
 * the Electron Accelerator string on first valid chord, cancels on Escape,
 * clears on Backspace/Delete.
 */
export function HotkeyRecorder({ value, onChange, defaultValue }: Props) {
  const [recording, setRecording] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const startRecording = (): void => {
    setRecording(true)
    setTimeout(() => buttonRef.current?.focus(), 0)
  }

  const stopRecording = (): void => setRecording(false)

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()

    if (e.key === 'Escape') {
      stopRecording()
      return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      onChange('')
      stopRecording()
      return
    }

    const accel = keyEventToAccelerator(e)
    if (accel) {
      onChange(accel)
      stopRecording()
    }
  }

  const isCustom = defaultValue !== undefined && value !== defaultValue

  return (
    <div className="flex items-center gap-1.5">
      {isCustom && (
        <IconButton data-vim-item="hotkey:reset"
          label="Reset to default"
          size={20}
          onClick={() => onChange(defaultValue)}
        >
          <RotateCcw size={10} />
        </IconButton>
      )}
      <HotkeyButton data-vim-item="hotkey:record"
        ref={buttonRef}
        keys={tokenizeHotkey(value)}
        recording={recording}
        emptyLabel="Click to record"
        onBlur={stopRecording}
        onKeyDown={onKeyDown}
        onClick={startRecording}
      />
      {value && !recording && (
        <IconButton data-vim-item="hotkey:clear" label="Clear hotkey" onClick={() => onChange('')}>
          <X size={14} />
        </IconButton>
      )}
    </div>
  )
}
