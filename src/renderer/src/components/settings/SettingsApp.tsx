import { useEffect, useState } from 'react'
import {
  VimFormContext,
  VimFormHintBar,
  VimFormKeysHelp,
  VimFormLabels,
  useVimFormKeys,
  vimFormKeymap
} from '@bedware/ui/vim-form'
import { useSettingsStore } from '@/store/settings-store'
import { applyTheme } from '@/lib/theme'
import { syncWindowBorder } from '@/lib/window-border'
import { Sidebar, settingsTabOrder, type SettingsTab } from './Sidebar'
import { SettingsTitleBar } from './SettingsTitleBar'
import { GeneralPanel } from './GeneralPanel'
import { AboutPanel } from './AboutPanel'
import { ModulePanel } from './ModulesPanel'

/**
 * The design system's form keys, minus what Settings has no use for: there is
 * no search over the settings and no row with something to copy.
 */
const KEYMAP = vimFormKeymap({ omit: ['filter', 'row-copy'] })

/**
 * Hash form is `#settings` or `#settings?tab=<id>` — the latter is how
 * main deep-links a freshly-opened window to a specific pane (e.g. the
 * tray's "About" / "Check for updates" entries). We parse it at mount
 * time so the first render already shows the right tab without a flash
 * of "General".
 */
function initialTabFromHash(): SettingsTab {
  const hash = window.location.hash.replace(/^#/, '')
  const q = hash.indexOf('?')
  if (q === -1) return 'general'
  const params = new URLSearchParams(hash.slice(q + 1))
  const tab = params.get('tab')
  if (tab === 'about' || tab === 'general') return tab
  if (tab && tab.startsWith('module:')) return tab as SettingsTab
  return 'general'
}

export function SettingsApp() {
  const [tab, setTab] = useState<SettingsTab>(() => initialTabFromHash())
  const hydrate = useSettingsStore((s) => s.hydrate)
  const applyServerSettings = useSettingsStore((s) => s.applyServerSettings)
  const theme = useSettingsStore((s) => s.settings?.theme ?? 'system')
  const lightBackground = useSettingsStore((s) => s.settings?.lightBackground ?? 'white')
  const isHydrated = useSettingsStore((s) => s.isHydrated)
  const modules = useSettingsStore((s) => s.modules)
  // The form's root holds the sidebar and the page; the page is what scrolls.
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    applyTheme(theme, lightBackground)
  }, [theme, lightBackground])

  // Windows: DWM's window border in the theme's frame color (no CSS frame
  // here — the window edge is the frame).
  useEffect(() => syncWindowBorder('border border-border bg-card'), [])

  useEffect(() => {
    const unsub = window.electronAPI.onSettingsChanged((settings) => {
      applyServerSettings(settings)
    })
    return unsub
  }, [applyServerSettings])

  // Main can deep-link us to a specific tab — the tray's "About" /
  // "Check for updates" entries both route here via `settings:open-tab`.
  useEffect(() => {
    const unsub = window.electronAPI.onOpenSettingsTab((next) => {
      setTab(next)
    })
    return unsub
  }, [])

  // Vim keys, as in Vimperium's Settings (the mechanism is the design
  // system's `@bedware/ui/vim-form`): a cursor walks the controls with j / k,
  // J / K change section, every control wears a letter label, a text field is
  // INSERT mode and everything else COMMAND.
  //
  // Esc closes the window; from a text field the first Esc only leaves the
  // field (`escapeLeavesField`). An open dialog and a shortcut being
  // recorded keep every key — the package sees them in the document.

  const vim = useVimFormKeys({
    keymap: KEYMAP,
    root,
    scrollRoot: scroller,
    resetKey: tab,
    onCommand: (command) => {
      if (command !== 'section-next' && command !== 'section-prev') return false
      const order = settingsTabOrder(modules)
      const at = order.indexOf(tab)
      const step = command === 'section-next' ? 1 : order.length - 1
      setTab(order[(Math.max(0, at) + step) % order.length])
      return true
    },
    onEscape: () => window.close(),
    escapeLeavesField: true
  })

  if (!isHydrated) {
    return (
      <div className="h-full bg-card text-muted-foreground flex flex-col">
        <SettingsTitleBar />
        <div className="flex-1 flex items-center justify-center text-sm">Loading…</div>
      </div>
    )
  }

  return (
    <VimFormContext.Provider value={vim.form}>
      <div data-vim-form="" className="relative h-full flex flex-col bg-card text-foreground">
        <SettingsTitleBar />
        <div ref={setRoot} className="flex-1 min-h-0 flex overflow-hidden">
          <Sidebar current={tab} onChange={setTab} />
          {/* `relative`: the labels of the page's controls are drawn inside
              it, so they scroll with them. */}
          <main ref={setScroller} className="relative flex-1 p-6 overflow-y-auto">
            {tab === 'general' && <GeneralPanel />}
            {tab === 'about' && <AboutPanel />}
            {tab.startsWith('module:') && (
              <ModulePanel moduleId={tab.slice(7)} />
            )}
          </main>
        </div>
        <VimFormHintBar
          form={vim.form}
          keymap={vim.keymap}
          mode={vim.mode}
          firstLabel={vim.labels[0]}
          escapeLeavesField
        />
        {vim.helpOpen && (
          <VimFormKeysHelp
            keymap={vim.keymap}
            firstLabel={vim.labels[0]}
            onClose={() => vim.setHelpOpen(false)}
          />
        )}
        <VimFormLabels
          form={vim.form}
          labels={vim.labels}
          mode={vim.mode}
          pending={vim.pending}
        />
      </div>
    </VimFormContext.Provider>
  )
}
