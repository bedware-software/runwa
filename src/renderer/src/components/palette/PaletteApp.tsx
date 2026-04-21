import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ArrowUpDown, CornerDownLeft, Settings as SettingsIcon } from 'lucide-react'
import { usePaletteStore } from '@/store/palette-store'
import { useSettingsStore } from '@/store/settings-store'
import { keyEventToAccelerator } from '@/lib/hotkey'
import { SearchInput } from './SearchInput'
import { ResultsList } from './ResultsList'
import { ModeBadge } from './ModeBadge'

export function PaletteApp() {
  const query = usePaletteStore((s) => s.query)
  const items = usePaletteStore((s) => s.items)
  const selectedIndex = usePaletteStore((s) => s.selectedIndex)
  const resolvedModuleId = usePaletteStore((s) => s.resolvedModuleId)
  const activeModuleId = usePaletteStore((s) => s.activeModuleId)
  const setQuery = usePaletteStore((s) => s.setQuery)
  const selectNext = usePaletteStore((s) => s.selectNext)
  const selectPrev = usePaletteStore((s) => s.selectPrev)
  const executeSelected = usePaletteStore((s) => s.executeSelected)
  const onPaletteShow = usePaletteStore((s) => s.onPaletteShow)
  const unscope = usePaletteStore((s) => s.unscope)

  const hydrate = useSettingsStore((s) => s.hydrate)
  const applyServerSettings = useSettingsStore((s) => s.applyServerSettings)
  const modules = useSettingsStore((s) => s.modules)
  const theme = useSettingsStore((s) => s.settings?.theme ?? 'system')
  const openSettingsHotkey = useSettingsStore(
    (s) => s.settings?.openSettingsHotkey ?? ''
  )
  const isHydrated = useSettingsStore((s) => s.isHydrated)

  const inputRef = useRef<HTMLInputElement>(null)

  // Initial hydration
  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // Theme → data-theme attribute
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // palette:show event from main (activation or direct-launch hotkey)
  useEffect(() => {
    const unsub = window.electronAPI.onPaletteShow((payload) => {
      onPaletteShow(payload.initialModuleId)
      // Re-focus the input — the window loses focus on hide
      setTimeout(() => inputRef.current?.focus(), 0)
    })
    return unsub
  }, [onPaletteShow])

  // Settings change broadcasts
  useEffect(() => {
    const unsub = window.electronAPI.onSettingsChanged((settings) => {
      applyServerSettings(settings)
    })
    return unsub
  }, [applyServerSettings])

  // Once hydrated, populate the initial (empty query) result list.
  useEffect(() => {
    if (isHydrated) {
      setQuery('')
    }
  }, [isHydrated, setQuery])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      // Escape inside a scoped module returns to the home-screen picker
      // instead of dismissing — matches Alfred / Raycast convention. A
      // second Escape (now unscoped) dismisses the palette.
      if (activeModuleId) {
        unscope()
      } else {
        void window.electronAPI.paletteHide()
      }
      return
    }
    if (e.key === 'Backspace' && query === '' && activeModuleId) {
      // Backspace on an empty query while scoped also returns to the picker.
      e.preventDefault()
      unscope()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectNext()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectPrev()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      void executeSelected()
      return
    }

    // Window-local shortcut: Open Settings (default Ctrl+,). Only fires while
    // the palette has focus — intentionally not a globalShortcut so the chord
    // stays available to IDEs when runwa isn't active.
    if (openSettingsHotkey) {
      const accel = keyEventToAccelerator(e)
      if (accel && accel === openSettingsHotkey) {
        e.preventDefault()
        void window.electronAPI.openSettings()
      }
    }
  }

  const activeId = activeModuleId ?? resolvedModuleId
  const activeMod = activeId ? modules.find((m) => m.id === activeId) : undefined

  return (
    <div
      className="h-full bg-popover text-popover-foreground flex flex-col rounded-md border border-border overflow-hidden"
      onKeyDown={onKeyDown}
    >
      <div className="px-3 py-2 border-b border-border flex items-center gap-2 [-webkit-app-region:drag]">
        <SearchInput
          ref={inputRef}
          value={query}
          onChange={setQuery}
          placeholder={
            activeMod
              ? `Search ${activeMod.name.toLowerCase()}…`
              : 'Type a command or search…'
          }
        />
        {activeMod && <ModeBadge name={activeMod.name} />}
      </div>

      <ResultsList items={items} selectedIndex={selectedIndex} />

      <div className="h-10 px-3 flex items-center justify-between border-t border-border bg-toolbar text-[11px] font-medium text-muted-foreground shrink-0">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            Navigate <kbd><ArrowUpDown size={11} strokeWidth={2.5} /></kbd>
          </span>
          <span className="flex items-center gap-1">
            Select <kbd><CornerDownLeft size={11} strokeWidth={2.5} /></kbd>
          </span>
          <span className="flex items-center gap-1">
            {activeModuleId ? 'Back' : 'Dismiss'} <kbd>Esc</kbd>
          </span>
        </div>
        <button
          type="button"
          className="flex items-center gap-1 hover:text-foreground transition-colors"
          onClick={() => void window.electronAPI.openSettings()}
        >
          <SettingsIcon size={11} />
          Settings
          {openSettingsHotkey &&
            openSettingsHotkey.split('+').map((key) => (
              <kbd key={key}>{key}</kbd>
            ))}
        </button>
      </div>
    </div>
  )
}
