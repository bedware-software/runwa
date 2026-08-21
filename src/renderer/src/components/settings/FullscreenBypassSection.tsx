import { useCallback, useEffect, useState } from 'react'
import { Keyboard, Trash2 } from '@/lib/lucide-icons'
import { cn } from '@/lib/utils'

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const cleaned = message
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(/^Error: /, '')
  return cleaned || 'Something went wrong. Please try again.'
}

/**
 * Applications opted out of key remapping while they own the screen.
 *
 * Entries are created from the palette (Ctrl+K on a window row → "Disable
 * remapping in fullscreen"); this pane is where they're reviewed and
 * removed — including for a game that isn't running, which the palette
 * can't reach.
 *
 * The list lives outside the settings payload (see
 * `keyboard-remap/fullscreen-bypass-store.ts`), so it's loaded over its own
 * IPC and kept current via the broadcast that fires when the palette edits
 * it.
 */
export function FullscreenBypassSection() {
  const [processes, setProcesses] = useState<string[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setProcesses(null)
    setLoadError(null)
    try {
      setProcesses(await window.electronAPI.keyboardRemapListFullscreenBypass())
    } catch (err) {
      setLoadError(readableError(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Live-update when the palette toggles an app while this pane is open.
  useEffect(() => {
    return window.electronAPI.onKeyboardRemapFullscreenBypassChanged((next) => {
      setProcesses(next)
      setLoadError(null)
    })
  }, [])

  const remove = async (processName: string): Promise<void> => {
    if (removing) return
    setRemoving(processName)
    setError(null)
    try {
      setProcesses(
        await window.electronAPI.keyboardRemapRemoveFullscreenBypass(processName)
      )
    } catch (err) {
      setError(readableError(err))
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-xs font-medium text-foreground">
          Disabled in fullscreen
        </div>
        {processes && processes.length > 0 && (
          <span className="text-[11px] text-muted-foreground">
            {processes.length} {processes.length === 1 ? 'app' : 'apps'}
          </span>
        )}
      </div>
      <div className="text-xs text-muted-foreground -mt-1">
        These apps get the raw keyboard while a window of theirs covers the
        screen — no layers, no tap-vs-hold. Windowed, they behave normally.
        Add one from the palette: Ctrl+K on a window, then “Disable remapping
        in fullscreen”.
      </div>

      {error && (
        <div role="alert" className="text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-col divide-y divide-border border border-input rounded-md bg-card overflow-hidden">
        {processes === null ? (
          loadError ? (
            <div
              role="alert"
              className="px-4 py-4 flex items-center justify-between gap-3 text-xs text-destructive"
            >
              <span>{loadError}</span>
              <button
                type="button"
                onClick={() => void load()}
                className="h-7 px-3 rounded-md border border-input bg-secondary text-secondary-foreground hover:bg-accent shrink-0"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="px-4 py-5 text-xs text-muted-foreground">
              Loading…
            </div>
          )
        ) : processes.length === 0 ? (
          <div className="px-4 py-5 text-xs text-muted-foreground">
            No apps yet. Remapping stays on everywhere.
          </div>
        ) : (
          processes.map((processName) => (
            <div key={processName} className="flex items-center gap-3 px-4 py-3">
              <Keyboard size={15} className="shrink-0 text-muted-foreground" />
              <code className="flex-1 min-w-0 text-xs text-foreground font-mono truncate">
                {processName}
              </code>
              <button
                type="button"
                disabled={removing !== null}
                onClick={() => void remove(processName)}
                aria-label={`Re-enable remapping for ${processName}`}
                title="Re-enable remapping"
                className={cn(
                  'h-7 w-7 rounded-md flex items-center justify-center shrink-0 transition-colors',
                  'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
                  removing !== null && 'opacity-50 cursor-not-allowed'
                )}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
