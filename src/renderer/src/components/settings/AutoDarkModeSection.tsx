import {
  AUTO_DARK_MODE_DARK_TIME_KEY,
  AUTO_DARK_MODE_ID,
  AUTO_DARK_MODE_LIGHT_TIME_KEY,
  AUTO_DARK_MODE_MODE_KEY,
  readAutoDarkModeConfig,
  type AutoDarkModeMode
} from '@shared/auto-dark-mode'
import { AlertTriangle } from '@/lib/lucide-icons'
import { CURRENT_OS } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/store/settings-store'

const MODES: Array<{
  value: AutoDarkModeMode
  label: string
  description: string
}> = [
  {
    value: 'scheduled',
    label: 'Scheduled',
    description: 'Apply the light and dark themes automatically at the times below.'
  },
  {
    value: 'manual',
    label: 'Manual',
    description: 'Change appearance only when you run Toggle Theme.'
  }
]

/**
 * Purpose-built three-control surface for Auto Dark Mode. The generic module
 * schema intentionally remains simple; this view gives its two HH:mm values
 * native time pickers and can validate the cross-field "times differ" rule.
 */
export function AutoDarkModeSection() {
  const storedConfig = useSettingsStore(
    (s) => s.settings?.modules[AUTO_DARK_MODE_ID]?.config
  )
  const setConfig = useSettingsStore((s) => s.setModuleConfig)
  const { config, error } = readAutoDarkModeConfig(storedConfig)
  const supported = CURRENT_OS === 'windows' || CURRENT_OS === 'macos'
  const errorId = error ? 'auto-dark-mode-config-error' : undefined
  const modeError = error === 'Mode must be Scheduled or Manual.'
  const timeError = Boolean(error && !modeError)

  const patch = (values: Record<string, string>): void => {
    if (!supported) return
    void setConfig(AUTO_DARK_MODE_ID, values)
  }

  return (
    <div className="flex flex-col gap-4">
      {!supported && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-xs text-muted-foreground">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-destructive" />
          Auto Dark Mode currently supports Windows and macOS.
        </div>
      )}

      <section className={cn('flex flex-col gap-3', !supported && 'opacity-55')}>
        <div>
          <h2
            id="auto-dark-mode-mode-label"
            className="text-sm font-semibold text-foreground"
          >
            Mode
          </h2>
          <p
            id="auto-dark-mode-mode-description"
            className="mt-0.5 text-xs text-muted-foreground"
          >
            Toggle Theme always enters Manual mode so a schedule cannot
            immediately undo your choice.
          </p>
        </div>

        <div
          className="grid grid-cols-2 gap-2"
          role="radiogroup"
          aria-labelledby="auto-dark-mode-mode-label"
          aria-describedby={[
            'auto-dark-mode-mode-description',
            modeError ? errorId : undefined
          ]
            .filter(Boolean)
            .join(' ')}
          aria-invalid={modeError || undefined}
        >
          {MODES.map((item) => {
            const selected = config.mode === item.value
            return (
              <label
                key={item.value}
                className={cn(
                  'block',
                  supported ? 'cursor-pointer' : 'cursor-not-allowed'
                )}
              >
                <input
                  type="radio"
                  name="auto-dark-mode-mode"
                  value={item.value}
                  checked={selected}
                  disabled={!supported}
                  onChange={() =>
                    patch({ [AUTO_DARK_MODE_MODE_KEY]: item.value })
                  }
                  className="peer sr-only"
                />
                <span
                  className={cn(
                    'block min-h-16 rounded-lg border px-3 py-2 text-left transition-colors',
                    'peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring/40',
                    selected
                      ? 'border-primary bg-primary/10'
                      : 'border-input bg-card hover:bg-accent'
                  )}
                >
                  <span
                    className={cn(
                      'block text-xs font-semibold',
                      selected ? 'text-primary' : 'text-foreground'
                    )}
                  >
                    {item.label}
                  </span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                    {item.description}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      </section>

      <section
        className={cn(
          'rounded-lg border border-input bg-card overflow-hidden',
          !supported && 'opacity-55'
        )}
      >
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Schedule</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Uses your computer&apos;s local time. Changes take effect while Runwa
            is running and are reconciled after wake.
          </p>
        </div>
        <TimeRow
          label="Light theme starts"
          value={config.lightTime}
          disabled={!supported}
          invalid={timeError}
          describedBy={timeError ? errorId : undefined}
          onChange={(value) =>
            patch({ [AUTO_DARK_MODE_LIGHT_TIME_KEY]: value })
          }
        />
        <TimeRow
          label="Dark theme starts"
          value={config.darkTime}
          disabled={!supported}
          invalid={timeError}
          describedBy={timeError ? errorId : undefined}
          onChange={(value) =>
            patch({ [AUTO_DARK_MODE_DARK_TIME_KEY]: value })
          }
        />
        {error && (
          <div
            id={errorId}
            role="alert"
            className="flex items-center gap-2 border-t border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive"
          >
            <AlertTriangle size={13} className="shrink-0" />
            {error}
          </div>
        )}
      </section>
    </div>
  )
}

function TimeRow({
  label,
  value,
  disabled,
  invalid,
  describedBy,
  onChange
}: {
  label: string
  value: string
  disabled: boolean
  invalid: boolean
  describedBy?: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex min-h-14 items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <input
        type="time"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        step={60}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn(
          'h-8 w-28 rounded-md border border-input bg-background px-2 text-center text-sm font-medium text-foreground outline-none transition-colors',
          invalid
            ? 'border-destructive focus:border-destructive focus:ring-1 focus:ring-destructive/30'
            : 'focus:border-ring focus:ring-1 focus:ring-ring/30',
          disabled && 'cursor-not-allowed'
        )}
      />
    </label>
  )
}
