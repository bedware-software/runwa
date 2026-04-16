import { useSettingsStore } from '@/store/settings-store'
import { DEFAULT_SETTINGS, type Theme } from '@shared/types'
import { cn } from '@/lib/utils'
import { HotkeyRecorder } from './HotkeyRecorder'

const THEMES: Array<{ value: Theme; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
]

export function GeneralPanel() {
  const theme = useSettingsStore((s) => s.settings?.theme ?? 'system')
  const setTheme = useSettingsStore((s) => s.setTheme)
  const activationHotkey = useSettingsStore(
    (s) => s.settings?.activationHotkey ?? ''
  )
  const setActivationHotkey = useSettingsStore((s) => s.setActivationHotkey)
  const openSettingsHotkey = useSettingsStore(
    (s) => s.settings?.openSettingsHotkey ?? ''
  )
  const setOpenSettingsHotkey = useSettingsStore(
    (s) => s.setOpenSettingsHotkey
  )

  return (
    <div className="flex flex-col gap-8 max-w-xl">
      <section>
        <h2 className="text-sm font-semibold text-foreground mb-1">Theme</h2>
        <p className="text-xs text-muted-foreground mb-3">
          Choose how runwa looks. System follows your OS preference.
        </p>
        <div className="flex gap-2">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => void setTheme(t.value)}
              className={cn(
                'h-8 px-3 rounded-md text-xs font-medium border transition-colors',
                theme === t.value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-secondary text-secondary-foreground border-input hover:bg-accent'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-foreground mb-1">Hotkeys</h2>
        <p className="text-xs text-muted-foreground mb-3">
          Keyboard shortcuts for opening runwa and its settings.
        </p>
        <div className="flex flex-col divide-y divide-border border border-input rounded-md bg-card overflow-hidden">
          <HotkeyRow
            title="Open runwa"
            scope="Global"
            description="Toggles the command palette from anywhere."
            value={activationHotkey}
            defaultValue={DEFAULT_SETTINGS.activationHotkey}
            onChange={(v) => void setActivationHotkey(v)}
          />
          <HotkeyRow
            title="Open Settings"
            scope="Window-local"
            description="Only works when a runwa window is focused."
            value={openSettingsHotkey}
            defaultValue={DEFAULT_SETTINGS.openSettingsHotkey}
            onChange={(v) => void setOpenSettingsHotkey(v)}
          />
        </div>
      </section>
    </div>
  )
}

interface HotkeyRowProps {
  title: string
  scope: 'Global' | 'Window-local'
  description: string
  value: string
  defaultValue?: string
  onChange: (v: string) => void
}

function HotkeyRow({ title, scope, description, value, defaultValue, onChange }: HotkeyRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{title}</span>
          <span
            className={cn(
              'text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded',
              scope === 'Global'
                ? 'bg-primary/15 text-primary'
                : 'bg-secondary text-muted-foreground'
            )}
          >
            {scope}
          </span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
      </div>
      <HotkeyRecorder value={value} defaultValue={defaultValue} onChange={onChange} />
    </div>
  )
}
