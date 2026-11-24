import {
  AUTO_DARK_MODE_DARK_BACKGROUND_COLOR_KEY,
  AUTO_DARK_MODE_DARK_TIME_KEY,
  AUTO_DARK_MODE_ID,
  AUTO_DARK_MODE_LIGHT_BACKGROUND_COLOR_KEY,
  AUTO_DARK_MODE_LIGHT_TIME_KEY,
  AUTO_DARK_MODE_MANAGE_WINDOWS_BACKGROUND_KEY,
  AUTO_DARK_MODE_MODE_KEY,
  readAutoDarkModeConfig,
  type AutoDarkModeMode
} from '@shared/auto-dark-mode'
import { ChoiceCards, ColorField, InputField, Notice, Panel, PanelRow, SectionTitle } from '@bedware/ui'
import type { ModuleConfigValue } from '@shared/types'
import { AlertTriangle } from '@/lib/lucide-icons'
import { CURRENT_OS } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/store/settings-store'
import { Toggle } from '@/components/ui/Toggle'

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
 * Purpose-built surface for Auto Dark Mode. The generic module schema
 * intentionally remains simple; this view gives its two HH:mm values native
 * time pickers and, on Windows, native color controls for the desktop.
 */
export function AutoDarkModeSection() {
  const storedConfig = useSettingsStore(
    (s) => s.settings?.modules[AUTO_DARK_MODE_ID]?.config
  )
  const setConfig = useSettingsStore((s) => s.setModuleConfig)
  const { config, error, backgroundColorError } = readAutoDarkModeConfig(
    storedConfig,
    { validateWindowsBackground: CURRENT_OS === 'windows' }
  )
  const supported = CURRENT_OS === 'windows' || CURRENT_OS === 'macos'
  const scheduleErrorId = error ? 'auto-dark-mode-config-error' : undefined
  const backgroundErrorId = backgroundColorError
    ? 'auto-dark-mode-background-error'
    : undefined
  const modeError = error === 'Mode must be Scheduled or Manual.'
  const timeError = Boolean(error && !modeError)

  const patch = (values: Record<string, ModuleConfigValue>): void => {
    if (!supported) return
    void setConfig(AUTO_DARK_MODE_ID, values)
  }

  return (
    <div className="flex flex-col gap-4">
      {!supported && (
        <Notice icon={<AlertTriangle size={14} />}>
          Auto Dark Mode currently supports Windows and macOS.
        </Notice>
      )}

      <section>
        <SectionTitle
          title="Mode"
          description="Toggle Theme always enters Manual mode so a schedule cannot immediately undo your choice."
        />
        <ChoiceCards data-vim-item="adm:mode"
          label="Mode"
          value={config.mode}
          options={MODES.map((item) => ({
            value: item.value,
            title: item.label,
            description: item.description,
            disabled: !supported
          }))}
          onChange={(mode) => patch({ [AUTO_DARK_MODE_MODE_KEY]: mode })}
          aria-describedby={modeError ? scheduleErrorId : undefined}
          aria-invalid={modeError || undefined}
        />
      </section>

      <Panel className={cn(!supported && 'opacity-55')}>
        <PanelRow
          title="Schedule"
          description="Uses your computer's local time. Changes take effect while Runwa is running and are reconciled after wake."
        />
        <TimeRow
          label="Light theme starts"
          value={config.lightTime}
          disabled={!supported}
          invalid={timeError}
          describedBy={timeError ? scheduleErrorId : undefined}
          onChange={(value) =>
            patch({ [AUTO_DARK_MODE_LIGHT_TIME_KEY]: value })
          }
        />
        <TimeRow
          label="Dark theme starts"
          value={config.darkTime}
          disabled={!supported}
          invalid={timeError}
          describedBy={timeError ? scheduleErrorId : undefined}
          onChange={(value) =>
            patch({ [AUTO_DARK_MODE_DARK_TIME_KEY]: value })
          }
        />
        {error && (
          <Notice
            flush
            id={scheduleErrorId}
            role="alert"
            icon={<AlertTriangle size={14} />}
          >
            {error}
          </Notice>
        )}
      </Panel>

      {CURRENT_OS === 'windows' && (
        <Panel>
          <PanelRow
            title="Desktop background"
            description="Use a solid color that follows the active light or dark theme."
          >
            <Toggle vimItem="adm:background"
              checked={config.manageWindowsBackground}
              onChange={(checked) =>
                patch({
                  [AUTO_DARK_MODE_MANAGE_WINDOWS_BACKGROUND_KEY]: checked
                })
              }
              ariaLabel="Change the Windows desktop background with the theme"
              size="sm"
            />
          </PanelRow>
          <ColorRow
            label="Light theme background"
            value={config.lightBackgroundColor}
            invalid={Boolean(backgroundColorError)}
            describedBy={backgroundErrorId}
            onChange={(value) =>
              patch({ [AUTO_DARK_MODE_LIGHT_BACKGROUND_COLOR_KEY]: value })
            }
          />
          <ColorRow
            label="Dark theme background"
            value={config.darkBackgroundColor}
            invalid={Boolean(backgroundColorError)}
            describedBy={backgroundErrorId}
            onChange={(value) =>
              patch({ [AUTO_DARK_MODE_DARK_BACKGROUND_COLOR_KEY]: value })
            }
          />
          <p className="border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
            Turning this on hides the current picture or slideshow. Turning it
            off stops future changes but does not restore the previous
            wallpaper.
          </p>
          {backgroundColorError && (
            <Notice
              flush
              id={backgroundErrorId}
              role="alert"
              icon={<AlertTriangle size={14} />}
            >
              {backgroundColorError}
            </Notice>
          )}
        </Panel>
      )}
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
    <PanelRow title={label}>
      <InputField
        aria-label={label}
        data-vim-item={`adm:time:${label}`}
        type="time"
        size="sm"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        step={60}
        invalid={invalid}
        aria-describedby={describedBy}
        boxClassName="w-28 px-2"
        className="text-center text-sm font-medium"
      />
    </PanelRow>
  )
}

function ColorRow({
  label,
  value,
  invalid,
  describedBy,
  onChange
}: {
  label: string
  value: string
  invalid: boolean
  describedBy?: string
  onChange: (value: string) => void
}) {
  return (
    <PanelRow title={label}>
      <ColorField data-vim-item={`adm:color:${label}`}
        size="sm"
        aria-label={label}
        value={value}
        onChange={(next) => onChange(next.toUpperCase())}
        invalid={invalid}
        aria-describedby={describedBy}
        boxClassName="w-32"
      />
    </PanelRow>
  )
}
