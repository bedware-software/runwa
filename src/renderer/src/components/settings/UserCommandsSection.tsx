import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { UserCommand } from '@shared/types'
import { Plus, Terminal, Trash2 } from '@/lib/lucide-icons'
import { CURRENT_OS } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '../ConfirmDialog'

const MAX_NAME_LENGTH = 100
const MAX_ACTION_LENGTH = 4096

const ACTION_PLACEHOLDER =
  CURRENT_OS === 'windows'
    ? 'e.g. "C:\\Program Files\\My App\\app.exe" --profile work'
    : CURRENT_OS === 'macos'
      ? 'e.g. open -a "Visual Studio Code" --args --new-window'
      : 'e.g. /path/to/script.sh --profile work'

const SHELL_LABEL = CURRENT_OS === 'windows' ? 'cmd.exe' : '/bin/sh'

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const cleaned = message
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(/^Error: /, '')
  return cleaned || 'Something went wrong. Please try again.'
}

/**
 * Bespoke CRUD surface for User Commands. The generic module-config schema is
 * intentionally scalar-only, while this section manages an ordered list of
 * named actions through narrow, main-validated IPC methods.
 */
export function UserCommandsSection() {
  const [commands, setCommands] = useState<UserCommand[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [action, setAction] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<UserCommand | null>(null)
  const [removing, setRemoving] = useState(false)

  const loadCommands = useCallback(async (): Promise<void> => {
    setCommands(null)
    setLoadError(null)
    try {
      setCommands(await window.electronAPI.userCommandsList())
    } catch (err) {
      setLoadError(readableError(err))
    }
  }, [])

  useEffect(() => {
    void loadCommands()
  }, [loadCommands])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const trimmedName = name.trim()
    const trimmedAction = action.trim()
    if (!trimmedName || !trimmedAction || saving) return

    setSaving(true)
    setError(null)
    try {
      const next = await window.electronAPI.userCommandsAdd({
        name: trimmedName,
        action: trimmedAction
      })
      setCommands(next)
      setName('')
      setAction('')
    } catch (err) {
      setError(readableError(err))
    } finally {
      setSaving(false)
    }
  }

  const removePending = async (): Promise<void> => {
    if (!pendingRemoval || removing) return
    const commandId = pendingRemoval.id
    setPendingRemoval(null)
    setRemoving(true)
    setError(null)
    try {
      const next = await window.electronAPI.userCommandsRemove(commandId)
      setCommands(next)
    } catch (err) {
      setError(readableError(err))
    } finally {
      setRemoving(false)
    }
  }

  const canSubmit = name.trim().length > 0 && action.trim().length > 0 && !saving

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <p className="m-0 text-sm text-foreground">
          Run scripts or launch apps with arguments from Command Palette.
        </p>
        <p className="m-0 text-xs leading-relaxed text-muted-foreground">
          Actions run in the background through {SHELL_LABEL}, from your home
          folder, with Runwa&apos;s permissions. Output is not shown. Starter
          examples are included and can be removed like any other command.
        </p>
      </div>

      {commands !== null && (
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-foreground">
            Add command
          </div>
          <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)] gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">Name</span>
              <input
                type="text"
                value={name}
                maxLength={MAX_NAME_LENGTH}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Open project"
                autoComplete="off"
                className="h-9 px-3 rounded-md bg-card border border-input text-sm text-foreground outline-none focus:border-ring"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">Action</span>
              <input
                type="text"
                value={action}
                maxLength={MAX_ACTION_LENGTH}
                onChange={(event) => setAction(event.target.value)}
                placeholder={ACTION_PLACEHOLDER}
                spellCheck={false}
                autoComplete="off"
                className="h-9 px-3 rounded-md bg-card border border-input text-sm text-foreground outline-none focus:border-ring font-mono"
              />
            </label>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div
              role={error ? 'alert' : undefined}
              className={cn(
                'min-h-4 text-xs',
                error ? 'text-destructive' : 'text-muted-foreground'
              )}
            >
              {error ?? 'Use your platform’s normal shell quoting for paths and arguments.'}
            </div>
            <button
              type="submit"
              disabled={!canSubmit}
              className={cn(
                'h-8 px-3 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 shrink-0',
                'bg-primary text-primary-foreground hover:opacity-90',
                !canSubmit && 'opacity-50 cursor-not-allowed'
              )}
            >
              <Plus size={13} />
              {saving ? 'Adding…' : 'Add command'}
            </button>
          </div>
        </form>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-foreground">
            Commands
          </div>
          {commands && commands.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {commands.length} {commands.length === 1 ? 'command' : 'commands'}
            </span>
          )}
        </div>

        <div className="flex flex-col divide-y divide-border border border-input rounded-md bg-card overflow-hidden">
          {commands === null ? (
            loadError ? (
              <div
                role="alert"
                className="px-4 py-4 flex items-center justify-between gap-3 text-xs text-destructive"
              >
                <span>{loadError}</span>
                <button
                  type="button"
                  onClick={() => void loadCommands()}
                  className="h-7 px-3 rounded-md border border-input bg-secondary text-secondary-foreground hover:bg-accent shrink-0"
                >
                  Retry
                </button>
              </div>
            ) : (
              <div className="px-4 py-5 text-xs text-muted-foreground">
                Loading commands…
              </div>
            )
          ) : commands.length === 0 ? (
            <div className="px-4 py-5 text-xs text-muted-foreground">
              No user commands yet. Add one above and it will appear in Command
              Palette immediately.
            </div>
          ) : (
            commands.map((command) => (
              <div key={command.id} className="flex items-start gap-3 px-4 py-3 group">
                <Terminal
                  size={15}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">
                    {command.name}
                  </div>
                  <code className="block mt-0.5 text-xs leading-relaxed text-muted-foreground font-mono break-all">
                    {command.action}
                  </code>
                </div>
                <button
                  type="button"
                  disabled={removing}
                  onClick={() => setPendingRemoval(command)}
                  aria-label={`Remove ${command.name}`}
                  title="Remove command"
                  className={cn(
                    'h-7 w-7 rounded-md flex items-center justify-center shrink-0 transition-colors',
                    'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
                    removing && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingRemoval !== null}
        title="Remove user command?"
        message={
          pendingRemoval
            ? `“${pendingRemoval.name}” will be removed from Command Palette. This cannot be undone.`
            : ''
        }
        confirmLabel="Remove command"
        destructive
        onConfirm={() => void removePending()}
        onCancel={() => setPendingRemoval(null)}
      />
    </div>
  )
}
