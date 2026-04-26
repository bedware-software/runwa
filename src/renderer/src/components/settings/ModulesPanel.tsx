import type { ModuleConfigField, ModuleConfigValue } from '@shared/types'
import { useSettingsStore } from '@/store/settings-store'
import { CURRENT_OS } from '@/lib/platform'
import { cn } from '@/lib/utils'
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

      {module.enabled && module.configFields && (() => {
        // Drop fields gated to other operating systems — e.g. App
        // Search's "Store / UWP apps" and "Desktop shortcuts" are
        // Windows-only enumeration sources and would just confuse a mac
        // user with toggles that do nothing.
        const visible = module.configFields.filter(
          (f) => !f.os || f.os === CURRENT_OS
        )
        if (visible.length === 0) return null
        // Walk the visible list in declaration order, peeling off
        // contiguous runs of fields that share the same `group` value.
        // Anything without a group renders as a standalone row. Order is
        // preserved so module authors get predictable layout from the
        // schema — no surprise re-sorts when they add a grouped field.
        const blocks: Array<
          | { kind: 'single'; field: ModuleConfigField }
          | { kind: 'group'; label: string; fields: ModuleConfigField[] }
        > = []
        for (const f of visible) {
          if (!f.group) {
            blocks.push({ kind: 'single', field: f })
            continue
          }
          const last = blocks[blocks.length - 1]
          if (last && last.kind === 'group' && last.label === f.group) {
            last.fields.push(f)
          } else {
            blocks.push({ kind: 'group', label: f.group, fields: [f] })
          }
        }
        return (
          <div className="flex flex-col gap-3">
            {blocks.map((block, i) =>
              block.kind === 'single' ? (
                <ConfigField
                  key={block.field.key}
                  field={block.field}
                  value={module.config[block.field.key]}
                  onChange={(value) =>
                    void setConfig(module.id, { [block.field.key]: value })
                  }
                  onAction={(key) =>
                    void window.electronAPI.modulesAction(module.id, key)
                  }
                />
              ) : (
                <ConfigGroup
                  key={`group:${block.label}:${i}`}
                  label={block.label}
                  fields={block.fields}
                  values={module.config}
                  onPatch={(patch) => void setConfig(module.id, patch)}
                  onAction={(key) =>
                    void window.electronAPI.modulesAction(module.id, key)
                  }
                />
              )
            )}
          </div>
        )
      })()}

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

/**
 * Renders a labeled cluster of related fields with a master "toggle all"
 * checkbox in the header. The master is:
 *   - checked  → every checkbox in the group is on
 *   - unchecked → every checkbox in the group is off
 *   - mixed (rendered as a dash) → some on, some off
 * Clicking the master in any state flips the whole group on (when all
 * are off OR mixed) or off (when all are on). One IPC round-trip
 * regardless of how many fields are in the group — the patch object
 * batches them.
 *
 * Non-checkbox fields inside a group are still rendered and edited
 * individually; the master only governs checkboxes (the only field
 * type where "all on / all off" has a meaning today).
 */
interface ConfigGroupProps {
  label: string
  fields: ModuleConfigField[]
  values: Record<string, ModuleConfigValue>
  onPatch: (patch: Record<string, ModuleConfigValue>) => void
  onAction: (key: string) => void
}

function ConfigGroup({ label, fields, values, onPatch, onAction }: ConfigGroupProps) {
  const checkboxFields = fields.filter(
    (f): f is Extract<ModuleConfigField, { type: 'checkbox' }> =>
      f.type === 'checkbox'
  )
  const checkedFlags = checkboxFields.map((f) => {
    const v = values[f.key]
    return typeof v === 'boolean' ? v : f.defaultValue
  })
  const allOn = checkedFlags.length > 0 && checkedFlags.every(Boolean)
  const noneOn = checkedFlags.every((v) => !v)
  const mixed = !allOn && !noneOn
  // Mixed and all-off both flip to all-on; only all-on flips to all-off.
  // Matches the "click to fully enable, click again to fully disable"
  // intuition users have from system Settings panes.
  const toggleAll = (): void => {
    const next = !allOn
    const patch: Record<string, ModuleConfigValue> = {}
    for (const f of checkboxFields) patch[f.key] = next
    onPatch(patch)
  }

  return (
    <div className="flex flex-col gap-3 border border-border rounded-md p-3 bg-card/40">
      <label className="flex items-center gap-3 cursor-pointer select-none">
        <button
          type="button"
          role="checkbox"
          aria-checked={mixed ? 'mixed' : allOn}
          onClick={toggleAll}
          className={cn(
            'h-4 w-4 rounded-[3px] border flex items-center justify-center shrink-0 transition-colors',
            allOn || mixed
              ? 'bg-primary border-primary'
              : 'bg-secondary border-input hover:border-muted-foreground'
          )}
        >
          {allOn && (
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
          {mixed && (
            <svg
              viewBox="0 0 16 16"
              className="h-3 w-3 text-primary-foreground"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
            >
              <line x1="4" y1="8" x2="12" y2="8" />
            </svg>
          )}
        </button>
        <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
          {label}
        </span>
      </label>
      <div className="flex flex-col gap-3 pl-7">
        {fields.map((field) => (
          <ConfigField
            key={field.key}
            field={field}
            value={values[field.key]}
            onChange={(value) => onPatch({ [field.key]: value })}
            onAction={onAction}
          />
        ))}
      </div>
    </div>
  )
}
