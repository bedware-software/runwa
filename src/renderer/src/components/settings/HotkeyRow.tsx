import { HotkeyRecorder } from './HotkeyRecorder'
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
}

export function HotkeyRow({
  title,
  scope,
  description,
  value,
  defaultValue,
  onChange
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
      </div>
      <HotkeyRecorder value={value} defaultValue={defaultValue} onChange={onChange} />
    </div>
  )
}
