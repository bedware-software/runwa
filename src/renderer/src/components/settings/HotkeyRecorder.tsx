import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { X, Keyboard, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { keyEventToAccelerator } from '@/lib/hotkey'
import { Hotkey } from '../ui/Kbd'

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

  const isCustom = defaultValue !== undefined && value !== defaultValue

  return (
    <div className="flex items-center gap-1.5">
      {isCustom && (
        <button
          type="button"
          onClick={() => onChange(defaultValue)}
          className="h-5 w-5 flex items-center justify-center rounded hover:bg-muted text-muted-foreground"
          title="Reset to default"
        >
          <RotateCcw size={10} />
        </button>
      )}
      <div
        ref={divRef}
        tabIndex={0}
        onBlur={stopRecording}
        onKeyDown={onKeyDown}
        onClick={startRecording}
        className={cn(
          'w-48 h-9 px-3 rounded-md bg-card border border-input text-sm text-foreground cursor-pointer select-none outline-none flex items-center justify-between gap-2',
          recording && 'border-ring bg-background'
        )}
      >
        {recording ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Keyboard size={14} /> Press keys…
          </span>
        ) : value ? (
          <>
            <Hotkey value={value} />
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
    </div>
  )
}
