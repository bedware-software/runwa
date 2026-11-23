import { useEffect, useRef, useState } from 'react'
import { Button, Field, FormDialog, Label, Segmented } from '@bedware/ui'
import type { UserCommandKind } from '@shared/types'
import { IS_MAC } from '@/lib/platform'

/**
 * Inline "new user command" form, opened by the palette's
 * "Create user command for <app>" entry.
 *
 * Deliberately smaller than the Settings surface: the app scope is decided
 * by main (it's whatever the palette was opened over — shown here as a chip,
 * not as a field). What's left is exactly what can't be inferred — a name,
 * whether it's a keystroke or a shell command (keystroke first: pressing a
 * shortcut in the app behind the palette is what a per-app command usually
 * is), the action itself, and an optional alias. Main rejects an alias
 * another of this app's commands already uses.
 *
 * Keyboard handling mirrors AliasInputModal: Esc closes and Enter submits,
 * both owned by the design system's FormDialog.
 */

interface Props {
  open: boolean
  /** App the command will be scoped to, e.g. "IntelliJ IDEA". */
  appLabel: string
  /** Rejected saves surface here — main owns validation (keystroke syntax,
   * duplicate names), so the message comes back from the IPC call. */
  error: string | null
  saving: boolean
  onSubmit: (command: {
    name: string
    kind: UserCommandKind
    action: string
    alias: string
  }) => void
  onClose: () => void
}

const SHELL_PLACEHOLDER = IS_MAC
  ? 'open -a "Visual Studio Code" --args --new-window'
  : '"C:\\Program Files\\My App\\app.exe" --profile work'

const KEYSTROKE_PLACEHOLDER = IS_MAC ? 'Cmd+Alt+L' : 'Ctrl+Alt+L'

export function NewUserCommandModal({
  open,
  appLabel,
  error,
  saving,
  onSubmit,
  onClose
}: Props) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<UserCommandKind>('keystroke')
  const [action, setAction] = useState('')
  const [alias, setAlias] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  // Fresh form on every open — the palette session that follows is usually
  // about a different command entirely.
  useEffect(() => {
    if (!open) return
    setName('')
    setKind('keystroke')
    setAction('')
    setAlias('')
    setTimeout(() => {
      nameRef.current?.focus()
      nameRef.current?.select()
    }, 0)
  }, [open])

  if (!open) return null

  const canSubmit = name.trim().length > 0 && action.trim().length > 0 && !saving

  const submit = (): void => {
    if (!canSubmit) return
    onSubmit({ name: name.trim(), kind, action: action.trim(), alias: alias.trim() })
  }

  return (
    <FormDialog
      open
      width={420}
      title="New user command"
      description={`Only shown in ${appLabel}`}
      onSubmit={submit}
      onCancel={onClose}
      note={
        error ??
        (kind === 'keystroke'
          ? 'Commas separate steps: “Alt+Space, R”.'
          : 'Runs in the background, output is not shown.')
      }
      noteError={!!error}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!canSubmit}>
            {saving ? 'Saving…' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2">
        <Field
          ref={nameRef}
          label="Name"
          size="sm"
          type="text"
          value={name}
          maxLength={100}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Reformat code"
        />
        <Field
          label="Alias"
          size="sm"
          mono
          type="text"
          value={alias}
          maxLength={64}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setAlias(e.target.value)}
          placeholder="optional"
        />
      </div>

      <div>
        <Label>Type</Label>
        <Segmented
          label="Type"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'keystroke', label: 'Keystroke' },
            { value: 'shell', label: 'Shell command' }
          ]}
        />
      </div>

      <Field
        label={kind === 'keystroke' ? 'Keystroke' : 'Action'}
        size="sm"
        mono
        type="text"
        value={action}
        maxLength={4096}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setAction(e.target.value)}
        placeholder={
          kind === 'keystroke' ? KEYSTROKE_PLACEHOLDER : SHELL_PLACEHOLDER
        }
      />
    </FormDialog>
  )
}
