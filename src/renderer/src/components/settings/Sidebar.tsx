import { SlidersHorizontal } from 'lucide-react'
import * as Icons from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/store/settings-store'

export type SettingsTab = 'general' | `module:${string}`

interface Props {
  current: SettingsTab
  onChange: (tab: SettingsTab) => void
}

function iconFromHint(hint: string | undefined): LucideIcon {
  if (!hint) return Icons.Package
  const name = hint
    .split('-')
    .map((s) => (s[0] ?? '').toUpperCase() + s.slice(1))
    .join('')
  const lookup = Icons as unknown as Record<string, LucideIcon>
  return lookup[name] ?? Icons.Package
}

export function Sidebar({ current, onChange }: Props) {
  const modules = useSettingsStore((s) => s.modules)
  const setEnabled = useSettingsStore((s) => s.setModuleEnabled)

  return (
    <aside className="w-56 bg-card border-r border-border p-3 flex flex-col shrink-0">
      <nav className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => onChange('general')}
          className={cn(
            'flex items-center gap-2 h-8 px-2 rounded-md text-sm text-left transition-colors',
            current === 'general'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
          )}
        >
          <SlidersHorizontal size={16} />
          General
        </button>
      </nav>

      {modules.length > 0 && (
        <div className="border-t border-border mt-3 pt-3">
          <div className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider px-2 mb-2">
            Modules
          </div>
          <div className="flex flex-col gap-0.5">
            {modules.map((m) => {
              const Icon = iconFromHint(m.icon)
              const active = current === `module:${m.id}`
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onChange(`module:${m.id}`)}
                  className={cn(
                    'flex items-center gap-2 h-8 px-2 rounded-md transition-colors',
                    active
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50'
                  )}
                >
                  <Icon
                    size={14}
                    className={cn(
                      'shrink-0 transition-colors',
                      active
                        ? 'text-accent-foreground'
                        : m.enabled
                          ? 'text-muted-foreground'
                          : 'text-muted-foreground/40'
                    )}
                  />
                  <span
                    className={cn(
                      'flex-1 text-left text-sm truncate transition-colors',
                      active
                        ? 'text-accent-foreground'
                        : m.enabled
                          ? 'text-muted-foreground'
                          : 'text-muted-foreground/40'
                    )}
                  >
                    {m.name}
                  </span>
                  <SidebarToggle
                    checked={m.enabled}
                    onChange={(v) => void setEnabled(m.id, v)}
                  />
                </button>
              )
            })}
          </div>
        </div>
      )}
    </aside>
  )
}

function SidebarToggle({
  checked,
  onChange
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={cn(
        'w-7 h-4 rounded-full transition-colors relative shrink-0',
        checked ? 'bg-primary' : 'bg-muted'
      )}
      aria-pressed={checked}
    >
      <div
        className={cn(
          'w-3 h-3 rounded-full bg-background absolute top-0.5 transition-transform',
          checked ? 'translate-x-[14px]' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}
