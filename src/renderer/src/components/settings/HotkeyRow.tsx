import { HotkeyRecorder } from './HotkeyRecorder'
import { Hotkey } from '../ui/Kbd'
import { cn } from '@/lib/utils'

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
  remapTriggers
}: Props) {
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
        {remapTriggers && remapTriggers.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1.5 mt-1.5 text-xs"
            title="An open_module rule in keyboard-rules.yaml opens this module. The hotkey on the right keeps working too."
          >
            <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
              Overridden by remapper
            </span>
            {remapTriggers.map((t) => (
              <Hotkey key={t} value={t} />
            ))}
          </div>
        )}
      </div>
      <HotkeyRecorder value={value} defaultValue={defaultValue} onChange={onChange} />
    </div>
  )
}
