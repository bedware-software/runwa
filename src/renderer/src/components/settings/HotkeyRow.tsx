import { useState } from 'react'
import { Badge, PanelRow } from '@bedware/ui'
import { HotkeyRecorder } from './HotkeyRecorder'
import { Hotkey } from '../ui/Hotkey'

/**
 * Reusable row for a single hotkey binding. Drives the per-module
 * direct-launch hotkeys in ModulePanel — every module that opts into
 * `supportsDirectLaunch` renders one row of this shape.
 *
 *   - Title + scope badge
 *   - Short description
 *   - HotkeyRecorder with a reset-to-default affordance whenever the
 *     current value diverges from the recommended one
 */
export type HotkeyScope = 'Global'

interface Props {
  title: string
  scope: HotkeyScope
  description: string
  value: string
  defaultValue?: string
  onChange: (v: string) => void
  /** Module id, shown as the name to use in a keyboard-remap
   *  `open_module:` rule. Click copies the ready-to-paste YAML. */
  moduleId?: string
  /** Keyboard-remap chords (e.g. "Space+W") whose `open_module` rule opens
   *  this module. Shown as an "overridden by remapper" note so the user
   *  knows the module has a trigger that lives outside this recorder. */
  remapTriggers?: string[]
}

export function HotkeyRow({
  title,
  scope,
  description,
  value,
  defaultValue,
  onChange,
  moduleId,
  remapTriggers
}: Props) {
  return (
    <PanelRow>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{title}</span>
          <Badge tone={scope === 'Global' ? 'accent' : 'neutral'}>{scope}</Badge>
          {moduleId && <ModuleIdBadge moduleId={moduleId} />}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
        {remapTriggers && remapTriggers.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1.5 mt-1.5 text-xs"
            title="An open_module rule in keyboard-rules.yaml opens this module. The hotkey on the right keeps working too."
          >
            <Badge tone="warning">Overridden by remapper</Badge>
            {remapTriggers.map((t) => {
              // "Left Shift (tap)" → chip the key, keep "(tap)" as text.
              const tap = t.endsWith(' (tap)')
              const keys = tap ? t.slice(0, -' (tap)'.length) : t
              return (
                <span key={t} className="flex items-center gap-1">
                  <Hotkey value={keys} />
                  {tap && <span className="text-muted-foreground">tap</span>}
                </span>
              )
            })}
          </div>
        )}
      </div>
      <HotkeyRecorder value={value} defaultValue={defaultValue} onChange={onChange} />
    </PanelRow>
  )
}

/**
 * The module's id as written in keyboard-rules.yaml (`open_module: <id>`).
 * Click copies the whole `open_module: <id>` so it pastes straight into a
 * rule.
 */
function ModuleIdBadge({ moduleId }: { moduleId: string }) {
  const [copied, setCopied] = useState(false)
  const snippet = `open_module: ${moduleId}`
  const copy = (): void => {
    void navigator.clipboard
      .writeText(snippet)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }
  return (
    <button
      type="button"
      onClick={copy}
      title={`Use in keyboard-rules.yaml as \`${snippet}\` — click to copy`}
      className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? 'copied' : snippet}
    </button>
  )
}
