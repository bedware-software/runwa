import * as Icons from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useSettingsStore } from '@/store/settings-store'
import { cn } from '@/lib/utils'
import { HotkeyRecorder } from './HotkeyRecorder'
import { ConfigField } from './ConfigField'

function iconFromHint(hint: string | undefined): LucideIcon {
  if (!hint) return Icons.Package
  const name = hint
    .split('-')
    .map((s) => (s[0] ?? '').toUpperCase() + s.slice(1))
    .join('')
  const lookup = Icons as unknown as Record<string, LucideIcon>
  return lookup[name] ?? Icons.Package
}

export function ModulesPanel() {
  const modules = useSettingsStore((s) => s.modules)
  const setEnabled = useSettingsStore((s) => s.setModuleEnabled)
  const setHotkey = useSettingsStore((s) => s.setModuleHotkey)
  const setConfig = useSettingsStore((s) => s.setModuleConfig)

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div>
        <h2 className="text-sm font-semibold text-foreground mb-1">Modules</h2>
        <p className="text-xs text-muted-foreground">
          Toggle modules on/off and assign a hotkey to jump straight into one.
          Each enabled module contributes results when you search the palette.
        </p>
      </div>

      {modules.length === 0 && (
        <div className="text-sm text-muted-foreground">
          No modules registered yet.
        </div>
      )}

      {modules.map((m) => {
        const Icon = iconFromHint(m.icon)
        return (
          <div
            key={m.id}
            className="bg-card text-card-foreground rounded-md border border-border p-4 flex flex-col gap-3"
          >
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-md bg-accent text-accent-foreground flex items-center justify-center shrink-0">
                <Icon size={20} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-foreground">
                    {m.name}
                  </div>
                  <Toggle
                    checked={m.enabled}
                    onChange={(v) => void setEnabled(m.id, v)}
                  />
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {m.description}
                </div>
                {m.prefix && (
                  <div className="text-xs text-muted-foreground mt-1">
                    Prefix:{' '}
                    <code className="bg-secondary text-foreground font-mono px-1 py-0.5 rounded">
                      {m.prefix}
                    </code>
                  </div>
                )}
              </div>
            </div>

            {m.enabled && m.configFields && m.configFields.length > 0 && (
              <div className="pt-3 border-t border-border flex flex-col gap-3">
                {m.configFields.map((field) => (
                  <ConfigField
                    key={field.key}
                    field={field}
                    value={m.config[field.key]}
                    onChange={(value) =>
                      void setConfig(m.id, { [field.key]: value })
                    }
                  />
                ))}
              </div>
            )}

            {m.supportsDirectLaunch && m.enabled && (
              <div className="flex items-center gap-3 pt-3 border-t border-border">
                <div className="text-xs text-muted-foreground flex-1">
                  Direct-launch hotkey
                </div>
                <HotkeyRecorder
                  value={m.directLaunchHotkey ?? ''}
                  onChange={(v) => void setHotkey(m.id, v || undefined)}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
}

function Toggle({ checked, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        'w-10 h-6 rounded-full transition-colors relative shrink-0',
        checked ? 'bg-primary' : 'bg-muted'
      )}
      aria-pressed={checked}
    >
      <div
        className={cn(
          'w-5 h-5 rounded-full bg-background absolute top-0.5 transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}
