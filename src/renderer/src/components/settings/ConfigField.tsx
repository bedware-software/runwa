import { useEffect, useState } from 'react'
import { Button, Checkbox, InputField, Label, Segmented, Textarea } from '@bedware/ui'
import type { ModuleConfigField, ModuleConfigValue } from '@shared/types'
import { cn } from '@/lib/utils'
import { optionalLucideIconFromHint } from '@/lib/lucide-icons'

interface Props {
  field: ModuleConfigField
  value: ModuleConfigValue | undefined
  onChange: (value: ModuleConfigValue) => void
  onAction?: (key: string) => void
}

/**
 * Renders a single module config field. Resolves the effective value by
 * falling back to the field's declared default when the stored value is
 * undefined — so config appears "applied" even before the user touches it.
 */
export function ConfigField({ field, value, onChange, onAction }: Props) {
  if (field.type === 'action') {
    const ActionIcon = optionalLucideIconFromHint(field.icon)
    return (
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <Label description={field.description}>{field.label}</Label>
        </div>
        <Button
          onClick={() => onAction?.(field.key)}
          icon={ActionIcon && <ActionIcon size={12} strokeWidth={2} />}
          className="shrink-0"
        >
          {field.buttonLabel}
        </Button>
      </div>
    )
  }

  const effective = value ?? field.defaultValue

  if (field.type === 'checkbox') {
    // Read-only checkboxes are pinned on the default value (true for the
    // built-ins that ship locked) and render with a disabled cursor +
    // dimmed control. Clicks are no-ops; the row otherwise looks the
    // same so the user can still see the field exists in settings.
    const isReadOnly = field.readOnly === true
    const checked = isReadOnly ? Boolean(field.defaultValue) : Boolean(effective)
    return (
      <Checkbox
        checked={checked}
        disabled={isReadOnly}
        onChange={(next) => onChange(next)}
        label={field.label}
        description={field.description}
        title={isReadOnly ? 'Built-in — always on.' : undefined}
      />
    )
  }

  if (field.type === 'text') {
    const currentText = typeof effective === 'string' ? effective : field.defaultValue
    return (
      <TextConfigField field={field} value={currentText} onChange={onChange} />
    )
  }

  // field.type === 'radio'
  const current = typeof effective === 'string' ? effective : field.defaultValue
  return (
    <div>
      <Label description={field.description}>{field.label}</Label>
      <Segmented
        label={field.label}
        value={current}
        options={field.options}
        onChange={(next) => onChange(next)}
        wrap
      />
    </div>
  )
}

interface TextFieldProps {
  field: Extract<ModuleConfigField, { type: 'text' }>
  value: string
  onChange: (value: ModuleConfigValue) => void
}

// Debounced locally so every keystroke doesn't round-trip through IPC +
// trigger a settings-changed broadcast — which, for secret fields, could
// also cause the hotkey manager to unregister/re-register on each keypress.
function TextConfigField({ field, value, onChange }: TextFieldProps) {
  const [draft, setDraft] = useState(value)
  const [revealed, setRevealed] = useState(false)

  // Adopt server updates when they don't match the in-flight draft — covers
  // external changes (another window, file edit) without clobbering typing.
  useEffect(() => {
    setDraft(value)
  }, [value])

  const commit = (next: string): void => {
    if (next !== value) onChange(next)
  }

  const inputType = field.secret && !revealed ? 'password' : 'text'

  return (
    <div>
      <Label description={field.description}>{field.label}</Label>
      <div className={cn('flex gap-2', field.multiline ? 'items-start' : 'items-center')}>
        {field.multiline ? (
          <Textarea
            mono
            value={draft}
            placeholder={field.placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commit(draft)}
            spellCheck={false}
            autoComplete="off"
            className="flex-1"
          />
        ) : (
          <InputField
            type={inputType}
            size="sm"
            mono
            value={draft}
            placeholder={field.placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commit(draft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit(draft)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            spellCheck={false}
            autoComplete="off"
            boxClassName="flex-1"
          />
        )}
        {field.secret && (
          <Button onClick={() => setRevealed((v) => !v)}>
            {revealed ? 'Hide' : 'Show'}
          </Button>
        )}
      </div>
    </div>
  )
}
