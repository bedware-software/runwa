import type { ModuleConfigField, ModuleConfigValue } from '@shared/types'
import { cn } from '@/lib/utils'

interface Props {
  field: ModuleConfigField
  value: ModuleConfigValue | undefined
  onChange: (value: ModuleConfigValue) => void
}

/**
 * Renders a single module config field. Resolves the effective value by
 * falling back to the field's declared default when the stored value is
 * undefined — so config appears "applied" even before the user touches it.
 */
export function ConfigField({ field, value, onChange }: Props) {
  const effective = value ?? field.defaultValue

  if (field.type === 'checkbox') {
    const checked = Boolean(effective)
    return (
      <label className="flex items-start gap-3 cursor-pointer select-none">
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          onClick={() => onChange(!checked)}
          className={cn(
            'mt-0.5 h-4 w-4 rounded-[3px] border flex items-center justify-center shrink-0 transition-colors',
            checked
              ? 'bg-primary border-primary'
              : 'bg-secondary border-input hover:border-muted-foreground'
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
        <div className="flex-1 min-w-0">
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
