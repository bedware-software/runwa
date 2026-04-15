import { SlidersHorizontal, Blocks } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export type SettingsTab = 'general' | 'modules'

interface Props {
  current: SettingsTab
  onChange: (tab: SettingsTab) => void
}

const TABS: Array<{ id: SettingsTab; label: string; icon: LucideIcon }> = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'modules', label: 'Modules', icon: Blocks }
]

export function Sidebar({ current, onChange }: Props) {
  return (
    <aside className="w-56 bg-card border-r border-border p-3 flex flex-col shrink-0">
      <nav className="flex flex-col gap-1">
        {TABS.map((t) => {
          const Icon = t.icon
          const active = current === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              className={cn(
                'flex items-center gap-2 h-8 px-2 rounded-md text-sm text-left transition-colors',
                active
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              )}
            >
              <Icon size={16} />
              {t.label}
            </button>
          )
        })}
      </nav>
    </aside>
  )
}
