import { useSettingsStore } from '@/store/settings-store'
import { HotkeyRow } from './HotkeyRow'
import { ConfigField } from './ConfigField'
import { KeyboardRemapSection } from './KeyboardRemapSection'
import { PermissionSection } from './PermissionSection'

interface Props {
  moduleId: string
}

/**
 * Right-pane content for a single module. The sidebar already shows the
 * module's icon, name, description, and enabled-toggle — so the pane
 * opens directly into hotkeys / config / per-module sections. Dropping
 * the header avoids the visual duplication and lets the actionable
 * controls start at the top.
 */
export function ModulePanel({ moduleId }: Props) {
  const module = useSettingsStore((s) => s.modules.find((m) => m.id === moduleId))
  const setHotkey = useSettingsStore((s) => s.setModuleHotkey)
  const setConfig = useSettingsStore((s) => s.setModuleConfig)

  if (!module) return null

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      {module.supportsDirectLaunch && module.enabled && (
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
      )}

      {module.enabled && module.configFields && module.configFields.length > 0 && (
        <div className="flex flex-col gap-3">
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

      {module.enabled && module.id === 'keyboard-remap' && <KeyboardRemapSection />}

      {module.enabled && module.id === 'window-switcher' && (
        <PermissionSection
          heading="Permissions"
          description="macOS Screen Recording access is needed to read window titles. Relaunch runwa after granting."
          rows={[
            {
              name: 'screenRecording',
              title: 'Screen recording',
              description:
                'Required for CGWindowList to return window titles — without it, entries fall back to the process name.'
            }
          ]}
        />
      )}
    </div>
  )
}
