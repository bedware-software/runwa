import { useEffect, useRef, useState } from 'react'
import { Button, FormDialog, InputField } from '@bedware/ui'

/**
 * Modal overlay for assigning an alias to the currently-selected palette
 * row. Opens from the Ctrl+K context menu's "Set alias…" action; closes
 * on Escape, click-outside, or after Save (the design system's FormDialog
 * owns Escape, click-outside and the focus trap).
 *
 * Semantics:
 *  - Empty submission REMOVES the alias (standard "clear to none" UX).
 *  - Non-empty is trimmed + lowercased server-side — we don't repeat the
 *    normalisation here so the input stays WYSIWYG while the user types.
 *  - Main may reject the alias (a user command's alias must be unique among
 *    its app's commands). The modal stays open with main's message so the
 *    user can pick another one.
 */

interface Props {
  open: boolean
  itemTitle: string
  initialValue: string
  /** Resolves once saved; a rejection keeps the modal open with its message. */
  onSave: (alias: string) => Promise<void>
  onClose: () => void
}

function readableError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return (
    message
      .replace(/^Error invoking remote method '[^']+': Error: /, '')
      .replace(/^Error: /, '') || 'The alias could not be saved.'
  )
}

export function AliasInputModal({
  open,
  itemTitle,
  initialValue,
  onSave,
  onClose
}: Props) {
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setValue(initialValue)
    setError(null)
    setSaving(false)
    // Microtask so the input exists in the DOM before we focus.
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }, [open, initialValue])

  if (!open) return null

  const submit = (): void => {
    if (saving) return
    setSaving(true)
    setError(null)
    onSave(value).then(
      () => setSaving(false),
      (err: unknown) => {
        setSaving(false)
        setError(readableError(err))
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    )
  }

  return (
    <FormDialog
      open
      width={360}
      title="Alias"
      description={itemTitle}
      mark="@"
      onSubmit={submit}
      onCancel={onClose}
      note={error ?? 'Leave empty to clear.'}
      noteError={!!error}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Save
          </Button>
        </>
      }
    >
      <InputField
        ref={inputRef}
        size="sm"
        mono
        invalid={!!error}
        type="text"
        aria-label="Alias"
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        placeholder="e.g. chr"
      />
    </FormDialog>
  )
}
