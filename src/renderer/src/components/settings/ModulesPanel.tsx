import * as Icons from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useSettingsStore } from '@/store/settings-store'
import { cn } from '@/lib/utils'
import { HotkeyRow } from './HotkeyRow'
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

interface Props {
  moduleId: string
}

export function ModulePanel({ moduleId }: Props) {
  const module = useSettingsStore((s) => s.modules.find((m) => m.id === moduleId))
  const setEnabled = useSettingsStore((s) => s.setModuleEnabled)
  const setHotkey = useSettingsStore((s) => s.setModuleHotkey)
  const setConfig = useSettingsStore((s) => s.setModuleConfig)

  if (!module) return null

  const Icon = iconFromHint(module.icon)

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-md bg-accent text-accent-foreground flex items-center justify-center shrink-0">
          <Icon size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">
              {module.name}
            </h2>
            <Toggle
              checked={module.enabled}
              onChange={(v) => void setEnabled(module.id, v)}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {module.description}
          </p>
          {module.prefix && (
            <div className="text-xs text-muted-foreground mt-1">
              Prefix:{' '}
              <code className="bg-secondary text-foreground font-mono px-1 py-0.5 rounded">
                {module.prefix}
              </code>
            </div>
          )}
        </div>
      </div>

      {/*
        Hotkey first (right after the header + toggle + description),
        config fields second. Hotkeys are what the user reaches for most
        often, and keeping them pinned directly under the toggle makes
        the layout stable across modules — config is secondary detail.
      */}
      {module.supportsDirectLaunch && module.enabled && (
        <div className="pt-3 border-t border-border">
          <div className="flex flex-col divide-y divide-border border border-input rounded-md bg-card overflow-hidden">
            <HotkeyRow
              title="Direct-launch hotkey"
              scope="Global"
              description={`Triggers ${module.name} from anywhere.`}
              value={module.directLaunchHotkey ?? ''}
              defaultValue={module.defaultDirectLaunchHotkey}
              onChange={(v) => void setHotkey(module.id, v || undefined)}
            />
          </div>
        </div>
      )}

      {module.enabled && module.configFields && module.configFields.length > 0 && (
        <div className="pt-3 border-t border-border flex flex-col gap-3">
          {module.configFields.map((field) => (
            <ConfigField
              key={field.key}
              field={field}
              value={module.config[field.key]}
              onChange={(value) =>
                void setConfig(module.id, { [field.key]: value })
              }
              onAction={(key) =>
                void window.electronAPI.modulesAction(module.id, key)
              }
            />
          ))}
        </div>
      )}
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
