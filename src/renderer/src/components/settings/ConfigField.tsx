import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as Icons from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ModuleConfigField, ModuleConfigValue } from '@shared/types'
import { cn } from '@/lib/utils'

function lucideIconFromHint(hint: string | undefined): LucideIcon | null {
  if (!hint) return null
  const name = hint
    .split('-')
    .map((s) => (s[0] ?? '').toUpperCase() + s.slice(1))
    .join('')
  const lookup = Icons as unknown as Record<string, LucideIcon>
  return lookup[name] ?? null
}

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
    const ActionIcon = lucideIconFromHint(field.icon)
    return (
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-foreground">{field.label}</div>
          {field.description && (
            <div className="text-xs text-muted-foreground mt-0.5">
              {field.description}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => onAction?.(field.key)}
          className={cn(
            'h-7 px-3 rounded-md text-xs font-medium border transition-colors shrink-0',
            'bg-secondary text-secondary-foreground border-input hover:bg-accent',
            ActionIcon && 'flex items-center gap-1.5'
          )}
        >
          {ActionIcon && <ActionIcon size={12} strokeWidth={2} />}
          {field.buttonLabel}
        </button>
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
      <label
        className={cn(
          'flex items-start gap-3 select-none',
          isReadOnly ? 'cursor-not-allowed' : 'cursor-pointer'
        )}
        title={isReadOnly ? 'Built-in — always on.' : undefined}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-disabled={isReadOnly || undefined}
          disabled={isReadOnly}
          onClick={() => {
            if (isReadOnly) return
            onChange(!checked)
          }}
          className={cn(
            'mt-0.5 h-4 w-4 rounded-[3px] border flex items-center justify-center shrink-0 transition-colors',
            checked
              ? 'bg-primary border-primary'
              : 'bg-secondary border-input hover:border-muted-foreground',
            isReadOnly && 'opacity-60 cursor-not-allowed'
          )}
        >
          {checked && (
            <svg
              viewBox="0 0 16 16"
              className="h-3 w-3 text-primary-foreground"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="3 8.5 6.5 12 13 4.5" />
            </svg>
          )}
        </button>
        <div className={cn('flex-1 min-w-0', isReadOnly && 'opacity-80')}>
          <div className="text-xs font-medium text-foreground">{field.label}</div>
          {field.description && (
            <div className="text-xs text-muted-foreground mt-0.5">
              {field.description}
            </div>
          )}
        </div>
      </label>
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
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-foreground">{field.label}</div>
      {field.description && (
        <div className="text-xs text-muted-foreground -mt-1">
          {field.description}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {field.options.map((opt) => {
          const selected = current === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={cn(
                'h-7 px-3 rounded-md text-xs font-medium border transition-colors',
                selected
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-secondary text-secondary-foreground border-input hover:bg-accent'
              )}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Adopt server updates when they don't match the in-flight draft — covers
  // external changes (another window, file edit) without clobbering typing.
  useEffect(() => {
    setDraft(value)
  }, [value])

  // Auto-grow the textarea to its content so the whole prompt stays visible
  // without an internal scrollbar. Runs synchronously before paint to avoid
  // a one-frame flash of the wrong height on first mount / draft changes.
  useLayoutEffect(() => {
    if (!field.multiline) return
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [draft, field.multiline])

  const commit = (next: string): void => {
    if (next !== value) onChange(next)
  }

  const inputType = field.secret && !revealed ? 'password' : 'text'

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-foreground">{field.label}</div>
      {field.description && (
        <div className="text-xs text-muted-foreground -mt-1">
          {field.description}
        </div>
      )}
      <div className={cn('flex gap-2', field.multiline ? 'items-start' : 'items-center')}>
        {field.multiline ? (
          <textarea
            ref={textareaRef}
            value={draft}
            placeholder={field.placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commit(draft)}
            spellCheck={false}
            autoComplete="off"
            rows={3}
            className="flex-1 min-h-[4.5rem] px-3 py-2 rounded-md bg-card border border-input text-sm text-foreground outline-none focus:border-ring font-mono resize-none overflow-hidden whitespace-pre-wrap break-words leading-5"
          />
        ) : (
          <input
            type={inputType}
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
            className="h-8 flex-1 px-3 rounded-md bg-card border border-input text-sm text-foreground outline-none focus:border-ring font-mono"
          />
        )}
        {field.secret && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="h-8 px-2 rounded-md text-xs font-medium border bg-secondary text-secondary-foreground border-input hover:bg-accent"
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
    </div>
  )
}
