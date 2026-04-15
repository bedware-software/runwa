import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { X, Keyboard } from 'lucide-react'
import { cn } from '@/lib/utils'
import { keyEventToAccelerator } from '@/lib/hotkey'

interface Props {
  value: string
  onChange: (v: string) => void
}

/**
 * Click-to-record hotkey input. On focus, listens for a key chord; saves
 * the Electron Accelerator string on first valid chord, cancels on Escape,
 * clears on Backspace/Delete.
 */
export function HotkeyRecorder({ value, onChange }: Props) {
  const [recording, setRecording] = useState(false)
  const divRef = useRef<HTMLDivElement>(null)

  const startRecording = (): void => {
    setRecording(true)
    setTimeout(() => divRef.current?.focus(), 0)
  }

  const stopRecording = (): void => setRecording(false)

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
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

  return (
    <div
      ref={divRef}
      tabIndex={0}
      onBlur={stopRecording}
      onKeyDown={onKeyDown}
      onClick={startRecording}
      className={cn(
        'w-48 h-9 px-3 rounded-md bg-secondary border border-input text-sm text-foreground cursor-pointer select-none outline-none flex items-center justify-between gap-2',
        recording && 'border-ring bg-background'
      )}
    >
      {recording ? (
        <span className="flex items-center gap-2 text-muted-foreground">
          <Keyboard size={14} /> Press keys…
        </span>
      ) : value ? (
        <>
          <code className="font-mono text-xs">{value}</code>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onChange('')
            }}
            className="text-muted-foreground hover:text-foreground"
          >
            <X size={14} />
          </button>
        </>
      ) : (
        <span className="flex items-center gap-2 text-muted-foreground">
          <Keyboard size={14} /> Click to record
        </span>
      )}
    </div>
  )
}
