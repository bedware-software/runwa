import { useCallback, useEffect, useState } from 'react'
import { Button, IconButton, Notice, Panel, PanelRow, SectionTitle } from '@bedware/ui'
import { Keyboard, Trash2 } from '@/lib/lucide-icons'

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
      <SectionTitle
        level={2}
        flush
        title="Disabled in fullscreen"
        description="These apps get the raw keyboard while a window of theirs covers the screen — no layers, no tap-vs-hold. Windowed, they behave normally. Add one from the palette: Ctrl+K on a window, then “Disable remapping in fullscreen”."
        side={
          processes &&
          processes.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {processes.length} {processes.length === 1 ? 'app' : 'apps'}
            </span>
          )
        }
      />

      {error && (
        <Notice role="alert">{error}</Notice>
      )}

      <Panel>
        {processes === null ? (
          loadError ? (
            <Notice
              flush
              role="alert"
              side={<Button size="sm" onClick={() => void load()}>Retry</Button>}
            >
              {loadError}
            </Notice>
          ) : (
            <PanelRow className="py-5 text-xs text-muted-foreground">
              Loading…
            </PanelRow>
          )
        ) : processes.length === 0 ? (
          <PanelRow className="py-5 text-xs text-muted-foreground">
            No apps yet. Remapping stays on everywhere.
          </PanelRow>
        ) : (
          processes.map((processName) => (
            <PanelRow key={processName} className="gap-3">
              <Keyboard size={15} className="shrink-0 text-muted-foreground" />
              <code className="flex-1 min-w-0 text-xs text-foreground font-mono truncate">
                {processName}
              </code>
              <IconButton
                danger
                disabled={removing !== null}
                onClick={() => void remove(processName)}
                label={`Re-enable remapping for ${processName}`}
                title="Re-enable remapping"
                className="shrink-0"
              >
                <Trash2 size={14} />
              </IconButton>
            </PanelRow>
          ))
        )}
      </Panel>
    </div>
  )
}
