import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent
} from 'react'
import { Button, ConfirmDialog, Field, InputField, Kbd, Panel, PanelRow, Select } from '@bedware/ui'
import type {
  RunningAppSummary,
  UserCommand,
  UserCommandKind
} from '@shared/types'
import {
  AppWindow,
  Globe,
  Keyboard,
  Pencil,
  Plus,
  Terminal,
  Trash2,
  X
} from '@/lib/lucide-icons'
import { CURRENT_OS } from '@/lib/platform'
import { cn } from '@/lib/utils'

const MAX_NAME_LENGTH = 100
const MAX_ACTION_LENGTH = 4096
const MAX_SCOPE_LENGTH = 512
const MAX_ALIAS_LENGTH = 64

const SHELL_PLACEHOLDER =
  CURRENT_OS === 'windows'
    ? 'e.g. "C:\\Program Files\\My App\\app.exe" --profile work'
    : CURRENT_OS === 'macos'
      ? 'e.g. open -a "Visual Studio Code" --args --new-window'
      : 'e.g. /path/to/script.sh --profile work'

const KEYSTROKE_PLACEHOLDER =
  CURRENT_OS === 'macos' ? 'e.g. Cmd+Alt+L' : 'e.g. Ctrl+Alt+L'

const SCOPE_PLACEHOLDER =
  CURRENT_OS === 'windows' ? 'e.g. idea64.exe' : 'e.g. IntelliJ IDEA'

const SHELL_LABEL = CURRENT_OS === 'windows' ? 'cmd.exe' : '/bin/sh'

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const cleaned = message
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(/^Error: /, '')
  return cleaned || 'Something went wrong. Please try again.'
}

interface Draft {
  name: string
  kind: UserCommandKind
  action: string
  appScope: string
  alias: string
}

// Keystroke first: pressing a shortcut in the app you came from is what most
// commands are, especially the app-scoped ones.
const EMPTY_DRAFT: Draft = {
  name: '',
  kind: 'keystroke',
  action: '',
  appScope: '',
  alias: ''
}

interface CommandGroup {
  /** Lowercased scope — the same key main uses for name/alias uniqueness. */
  key: string
  /** Scope as written, or '' for the global group. */
  scope: string
  commands: UserCommand[]
}

/** Commands bucketed by app scope: global first, then apps alphabetically,
 * each keeping the stored order. Scopes differing only in case are one app,
 * matching how main checks names and aliases. */
function groupByApp(commands: UserCommand[]): CommandGroup[] {
  const groups = new Map<string, CommandGroup>()
  for (const command of commands) {
    const key = command.appScope.toLowerCase()
    const group = groups.get(key)
    if (group) group.commands.push(command)
    else groups.set(key, { key, scope: command.appScope, commands: [command] })
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.key) return -1
    if (!b.key) return 1
    return a.scope.localeCompare(b.scope, undefined, { sensitivity: 'base' })
  })
}

/**
 * Bespoke CRUD surface for User Commands. The generic module-config schema is
 * intentionally scalar-only, while this section manages an ordered list of
 * named actions through narrow, main-validated IPC methods.
 *
 * Each command carries three things beyond its name: what it does (a shell
 * command line or a keystroke to press) and where it applies (everywhere, or
 * only while one app is focused), plus an optional alias. The alias can
 * also be set from the palette's Ctrl+K menu; main keeps it unique among one
 * app's commands either way.
 *
 * The list is grouped by app, and the JSON file behind it can be opened
 * directly with Edit — the list re-reads it whenever this window regains
 * focus, so hand edits show up on the way back.
 */
export function UserCommandsSection() {
  const [commands, setCommands] = useState<UserCommand[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  /** Command being edited, or null while the form is in "add" mode. */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [runningApps, setRunningApps] = useState<RunningAppSummary[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<UserCommand | null>(null)
  const [removing, setRemoving] = useState(false)
  const [filePath, setFilePath] = useState('')

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

  // Pick up edits made in the JSON file: coming back to this window is the
  // moment they matter. Silent — no loading state, a failure keeps the list.
  useEffect(() => {
    const onFocus = (): void => {
      void window.electronAPI
        .userCommandsList()
        .then(setCommands)
        .catch(() => undefined)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    void window.electronAPI
      .userCommandsFilePath()
      .then(setFilePath)
      .catch(() => setFilePath(''))
  }, [])

  const groups = useMemo(() => (commands ? groupByApp(commands) : []), [commands])

  // Running apps feed the scope field's suggestion list. Best-effort: an
  // empty list just means the user types the app name themselves.
  useEffect(() => {
    void window.electronAPI
      .userCommandsListRunningApps()
      .then(setRunningApps)
      .catch(() => setRunningApps([]))
  }, [])

  const patchDraft = (patch: Partial<Draft>): void =>
    setDraft((current) => ({ ...current, ...patch }))

  const startEditing = (command: UserCommand): void => {
    setEditingId(command.id)
    setDraft({
      name: command.name,
      kind: command.kind,
      action: command.action,
      appScope: command.appScope,
      alias: command.alias ?? ''
    })
    setError(null)
  }

  const cancelEditing = (): void => {
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
    setError(null)
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const payload = {
      name: draft.name.trim(),
      kind: draft.kind,
      action: draft.action.trim(),
      appScope: draft.appScope.trim(),
      alias: draft.alias.trim()
    }
    if (!payload.name || !payload.action || saving) return

    setSaving(true)
    setError(null)
    try {
      const next = editingId
        ? await window.electronAPI.userCommandsUpdate(editingId, payload)
        : await window.electronAPI.userCommandsAdd(payload)
      setCommands(next)
      if (editingId) {
        setEditingId(null)
        setDraft(EMPTY_DRAFT)
      } else {
        // Keep the app scope and type: adding several commands for the same
        // app in a row is the common case.
        patchDraft({ name: '', action: '', alias: '' })
      }
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
      if (editingId === commandId) cancelEditing()
    } catch (err) {
      setError(readableError(err))
    } finally {
      setRemoving(false)
    }
  }

  const canSubmit =
    draft.name.trim().length > 0 && draft.action.trim().length > 0 && !saving

  const hint =
    draft.kind === 'keystroke'
      ? 'Chords are separated by commas for multi-step shortcuts — “Alt+Space, R”.'
      : 'Use your platform’s normal shell quoting for paths and arguments.'

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <p className="m-0 text-sm text-foreground">
          Run scripts, launch apps, or press a shortcut from Command Palette.
        </p>
        <p className="m-0 text-xs leading-relaxed text-muted-foreground">
          Shell actions run in the background through {SHELL_LABEL}, from your
          home folder, with Runwa&apos;s permissions. Output is not shown.
          Keystroke actions are sent to the window you were in before opening
          the palette. Starter examples are included and can be removed like any
          other command.
        </p>
      </div>

      {commands !== null && (
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-foreground">
              {editingId ? 'Edit command' : 'Add command'}
            </div>
            {editingId && (
              <Button
                variant="ghost"
                onClick={cancelEditing}
                icon={<X size={11} />}
                className="h-6 px-2"
              >
                Cancel
              </Button>
            )}
          </div>

          <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)] gap-3">
            <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
              <Field
                label="Name"
                type="text"
                value={draft.name}
                maxLength={MAX_NAME_LENGTH}
                onChange={(event) => patchDraft({ name: event.target.value })}
                placeholder="e.g. Open project"
                autoComplete="off"
              />
              <Field
                label="Alias"
                type="text"
                mono
                value={draft.alias}
                maxLength={MAX_ALIAS_LENGTH}
                onChange={(event) => patchDraft({ alias: event.target.value })}
                placeholder="optional"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <Field
              label={draft.kind === 'keystroke' ? 'Keystroke' : 'Action'}
              type="text"
              mono
              value={draft.action}
              maxLength={MAX_ACTION_LENGTH}
              onChange={(event) => patchDraft({ action: event.target.value })}
              placeholder={
                draft.kind === 'keystroke'
                  ? KEYSTROKE_PLACEHOLDER
                  : SHELL_PLACEHOLDER
              }
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)] gap-3">
            <div>
              <span className="bw-label">Type</span>
              <Select<UserCommandKind>
                label="Type"
                value={draft.kind}
                onChange={(kind) => patchDraft({ kind })}
                options={[
                  { value: 'keystroke', label: 'Keystroke' },
                  { value: 'shell', label: 'Shell command' }
                ]}
                className="w-full h-9"
              />
            </div>

            <div>
              <Field
                label="Applies to"
                type="text"
                list="user-command-running-apps"
                value={draft.appScope}
                maxLength={MAX_SCOPE_LENGTH}
                onChange={(event) => patchDraft({ appScope: event.target.value })}
                placeholder={`All apps — ${SCOPE_PLACEHOLDER}`}
                spellCheck={false}
                autoComplete="off"
              />
              <datalist id="user-command-running-apps">
                {runningApps.map((app) => (
                  <option key={app.name} value={app.name} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div
              role={error ? 'alert' : undefined}
              className={cn(
                'min-h-4 text-xs',
                error ? 'text-destructive' : 'text-muted-foreground'
              )}
            >
              {error ?? hint}
            </div>
            <Button
              type="submit"
              variant="primary"
              disabled={!canSubmit}
              icon={editingId ? <Pencil size={13} /> : <Plus size={13} />}
              className="shrink-0"
            >
              {saving
                ? editingId
                  ? 'Saving…'
                  : 'Adding…'
                : editingId
                  ? 'Save changes'
                  : 'Add command'}
            </Button>
          </div>

          <p className="m-0 text-xs leading-relaxed text-muted-foreground">
            Leave <span className="font-medium text-foreground">Applies to</span>{' '}
            empty for a command that is always available. Naming an app — its
            process name, or <code className="font-mono">*</code> wildcards such
            as <code className="font-mono">*idea*</code> — lists the command only
            while that app is the one you came from. Typing a command&apos;s{' '}
            <span className="font-medium text-foreground">Alias</span> in the
            palette runs it; it can also be set with{' '}
            <span className="font-medium text-foreground">Ctrl+K</span> on the
            row. Aliases must be unique within one app, but different apps can
            reuse the same one.
          </p>
        </form>
      )}

      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium text-foreground">Commands file</div>
        <div className="text-xs text-muted-foreground -mt-1">
          JSON the commands are stored in. Click Edit to open it in your system
          editor; changes show up here when you come back to this window.
          Malformed entries are skipped.
        </div>
        <div className="flex items-center gap-2">
          <InputField
            type="text"
            size="sm"
            mono
            readOnly
            value={filePath}
            onFocus={(event) => event.currentTarget.select()}
            boxClassName="flex-1"
            className="text-xs truncate"
          />
          <Button
            onClick={() => void window.electronAPI.userCommandsOpenFile()}
            icon={<Pencil size={12} />}
            className="shrink-0"
          >
            Edit
          </Button>
        </div>
      </div>

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

        <Panel>
          {commands === null ? (
            loadError ? (
              <PanelRow role="alert" className="py-4 gap-3 text-xs text-destructive">
                <span>{loadError}</span>
                <Button onClick={() => void loadCommands()} className="shrink-0">
                  Retry
                </Button>
              </PanelRow>
            ) : (
              <PanelRow className="py-5 text-xs text-muted-foreground">
                Loading commands…
              </PanelRow>
            )
          ) : commands.length === 0 ? (
            <PanelRow className="py-5 text-xs text-muted-foreground">
              No user commands yet. Add one above and it will appear in Command
              Palette immediately.
            </PanelRow>
          ) : (
            groups.map((group) => (
              <Fragment key={group.key}>
                <PanelRow className="justify-start gap-1.5 py-1.5 bg-secondary/50 text-[11px] font-medium text-muted-foreground">
                  {group.scope ? (
                    <AppWindow size={11} className="shrink-0" />
                  ) : (
                    <Globe size={11} className="shrink-0" />
                  )}
                  <span className="truncate text-foreground">
                    {group.scope || 'All apps'}
                  </span>
                  <span className="shrink-0">· {group.commands.length}</span>
                </PanelRow>
                {group.commands.map((command) => {
              const Icon = command.kind === 'keystroke' ? Keyboard : Terminal
              const alias = command.alias
              const isEditing = editingId === command.id
              return (
                <PanelRow
                  key={command.id}
                  className={cn(
                    'items-start gap-3 group',
                    isEditing && 'bg-accent/40'
                  )}
                >
                  <Icon
                    size={15}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                    aria-label={command.kind === 'keystroke' ? 'Keystroke' : 'Shell command'}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-foreground truncate">
                        {command.name}
                      </span>
                      {alias && (
                        <Kbd
                          title="Palette alias — type it in the palette to run the command"
                          className="shrink-0"
                        >
                          {alias}
                        </Kbd>
                      )}
                    </div>
                    <code className="block mt-0.5 text-xs leading-relaxed text-muted-foreground font-mono break-all">
                      {command.action}
                    </code>
                  </div>
                  <button
                    type="button"
                    onClick={() => (isEditing ? cancelEditing() : startEditing(command))}
                    aria-label={`Edit ${command.name}`}
                    title="Edit command"
                    className={cn(
                      'h-7 w-7 rounded-md flex items-center justify-center shrink-0 transition-colors',
                      'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      isEditing && 'bg-accent text-accent-foreground'
                    )}
                  >
                    <Pencil size={14} />
                  </button>
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
                </PanelRow>
              )
                })}
              </Fragment>
            ))
          )}
        </Panel>
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
        initialFocus="cancel"
        onConfirm={() => void removePending()}
        onCancel={() => setPendingRemoval(null)}
      />
    </div>
  )
}
